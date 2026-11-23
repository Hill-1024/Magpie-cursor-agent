import crypto from 'node:crypto';
import {
  decodeCursor,
  decodeUnaryPayload,
  encodeConnectEndStream,
  encodeConnectFrame,
  encodeCursor,
} from './cursor-schemas.js';
import {
  buildExecRequest,
  buildOpenAiTools,
  computeEditedContent,
  formatExecResult,
  normalizeToolName,
  renderToolCard,
} from './cursor-tools.js';
import { completeOpenAiText, streamOpenAiChat } from './openai-stream.js';

const CONTEXT_OPTIONS = [
  ['200k', '200K'],
  ['356k', '356K'],
  ['500k', '500K'],
  ['800k', '800K'],
  ['1m', '1M'],
];
const EFFORT_OPTIONS = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra High'],
  ['max', 'Max'],
];
const DEFAULT_CONTEXT = '200k';
const LOCAL_ROUTING_CREDENTIAL = 'cursor-magpie-local';

function formatTokenLabel(tokens) {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

function parseTokenString(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (clean.endsWith('m')) return Number(clean.slice(0, -1)) * 1_000_000;
  if (clean.endsWith('k')) return Number(clean.slice(0, -1)) * 1_000;
  return Number(clean);
}

function buildContextChoices(customTokens) {
  const choices = CONTEXT_OPTIONS.map(([value, label]) => [value, label]);
  if (Number.isFinite(customTokens) && customTokens > 0) {
    const duplicate = choices.some(([existing]) => parseTokenString(existing) === customTokens);
    if (!duplicate) {
      choices.push([String(customTokens), `${formatTokenLabel(customTokens)} (Custom)`]);
    }
  }
  return choices;
}

function buildParameterDefinitions(contexts) {
  return [
    {
      id: 'context',
      name: 'Context',
      markdownTooltip: 'Context window size used for compaction.',
      parameterType: {
        enumParameter: {
          values: contexts.map(([value, displayName]) => ({ value, displayName })),
        },
      },
      isCycleableByHotkey: false,
    },
    {
      id: 'reasoning',
      name: 'Effort',
      markdownTooltip: 'Reasoning effort hint forwarded to Magpie.',
      parameterType: {
        enumParameter: {
          values: EFFORT_OPTIONS.map(([value, displayName]) => ({ value, displayName })),
        },
      },
      isCycleableByHotkey: true,
    },
    {
      id: 'fast',
      name: 'Fast',
      markdownTooltip: 'Standard / Fast variant display flag.',
      parameterType: {
        booleanParameter: {
          values: [
            { value: 'false' },
            { value: 'true', displayName: 'Fast', increasesModelCost: true },
          ],
        },
      },
      isCycleableByHotkey: false,
    },
  ];
}

function buildModelVariants(id, displayName, tooltip, contexts) {
  const variants = [];
  for (const [contextVal, contextLabel] of contexts) {
    for (const [effortVal, effortLabel] of EFFORT_OPTIONS) {
      for (const fast of [false, true]) {
        const suffixParts = [];
        if (contextVal !== DEFAULT_CONTEXT) suffixParts.push(contextLabel);
        suffixParts.push(effortLabel);
        if (fast) suffixParts.push('Fast');
        const suffix = suffixParts.join(' ');
        const formattedName = `${displayName} <span style="color: var(--cursor-text-tertiary);">${suffix}</span>`;
        const isDefault = contextVal === DEFAULT_CONTEXT && effortVal === 'high' && !fast;
        variants.push({
          parameterValues: [
            { id: 'context', value: contextVal },
            { id: 'reasoning', value: effortVal },
            { id: 'fast', value: String(fast) },
          ],
          displayName: formattedName,
          isMaxMode: false,
          isDefaultMaxConfig: isDefault ? true : undefined,
          isDefaultNonMaxConfig: isDefault ? true : undefined,
          tooltipData: tooltip,
          displayNameOutsidePicker: formattedName,
          variantStringRepresentation: `${id}[context=${contextVal},reasoning=${effortVal},fast=${fast}]`,
          legacySlug: `${id}-${contextVal}-${effortVal}${fast ? '-fast' : ''}`,
        });
      }
    }
  }
  return variants;
}

function toAvailableModel(model) {
  const displayName = model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
  const tooltip = { markdownContent: `Magpie / ${model.id}` };
  const contexts = buildContextChoices(model.context);
  const variants = buildModelVariants(model.id, displayName, tooltip, contexts);
  return {
    name: model.id,
    defaultOn: true,
    supportsAgent: true,
    degradationStatus: 0,
    tooltipData: tooltip,
    supportsThinking: true,
    supportsImages: true,
    supportsMaxMode: true,
    clientDisplayName: displayName,
    serverModelName: model.id,
    supportsNonMaxMode: true,
    tooltipDataForMaxMode: tooltip,
    isRecommendedForBackgroundComposer: false,
    supportsPlanMode: true,
    inputboxShortModelName: displayName,
    supportsSandboxing: true,
    supportsCmdK: false,
    parameterDefinitions: buildParameterDefinitions(contexts),
    variants,
    legacySlugs: variants.map(variant => variant.legacySlug).filter(Boolean),
    namedModelSectionIndex: 1,
    vendorName: 'cursor',
    vendor: { id: 6, displayName: 'Cursor' },
    modelPickerBadges: [{ label: 'Magpie', variant: 1, dismissOnSelection: false }],
  };
}

function toModelDetails(model) {
  const displayName = model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
  return {
    modelId: model.id,
    displayModelId: model.id,
    displayName,
    displayNameShort: displayName,
    thinkingDetails: {},
    apiKeyCredentials: { apiKey: LOCAL_ROUTING_CREDENTIAL },
  };
}

function sortedModels(config) {
  const list = [...config.models];
  list.sort((left, right) => {
    if (left.id === config.model && right.id !== config.model) return -1;
    if (right.id === config.model && left.id !== config.model) return 1;
    return 0;
  });
  return list;
}

function resolveModelSelection(runRequest, config) {
  const rawId = runRequest.requestedModel?.modelId || runRequest.modelDetails?.modelId || config.model;
  let baseId = rawId;
  let effort = null;

  const bracketMatch = /^(.+?)\[([^\]]+)\]$/.exec(rawId);
  if (bracketMatch) {
    baseId = bracketMatch[1];
    for (const pair of bracketMatch[2].split(',')) {
      const [paramKey, paramVal] = pair.split('=');
      if ((paramKey === 'effort' || paramKey === 'reasoning') && paramVal && paramVal !== 'none') {
        effort = paramVal.trim();
      }
    }
  }
  for (const param of runRequest.requestedModel?.parameters || []) {
    if ((param.id === 'effort' || param.id === 'reasoning') && param.value && param.value !== 'none') {
      effort = param.value.trim();
    }
  }

  const exact = config.models.find(entry => entry.id === baseId);
  if (exact) return { modelId: exact.id, effort };
  const legacyMatch = config.models.find(entry => baseId.startsWith(`${entry.id}-`));
  if (legacyMatch) return { modelId: legacyMatch.id, effort };
  return { modelId: config.model, effort };
}

function blobKey(bytes) {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Clean-room stateful Cursor RPC & bidirectional Agent runtime.
 * All state (blobs, sessions, active runs) is strictly ephemeral in memory.
 */
export class CursorBridgeEngine {
  constructor(initialConfig) {
    this.config = initialConfig;
    this.sessions = new Map();
  }

  updateConfig(nextConfig) {
    this.config = nextConfig;
  }

  buildAvailableModelsResponse(framed = false) {
    const list = sortedModels(this.config);
    const payload = encodeCursor('AvailableModelsAddition', {
      modelNames: list.map(item => item.id),
      models: list.map(toAvailableModel),
      displayConfiguration: {
        routedModelViewConfig: { hideRoutedModelView: true },
        namedModelsViewConfig: { namedViewToRoutedModelViewNoButton: {} },
      },
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildUsableModelsResponse(framed = false) {
    const list = sortedModels(this.config);
    const payload = encodeCursor('UsableModelsAddition', {
      models: list.map(toModelDetails),
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildDefaultModelForCliResponse(framed = false) {
    const first = sortedModels(this.config)[0];
    const payload = encodeCursor('GetDefaultModelForCliResponse', {
      model: first ? toModelDetails(first) : undefined,
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildDefaultModelResponse(framed = false) {
    const first = sortedModels(this.config)[0];
    const modelId = first ? first.id : '';
    const payload = encodeCursor('DefaultModelResponse', {
      model: modelId,
      thinkingModel: modelId,
      maxMode: false,
      nextDefaultSetDate: '',
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildDefaultModelNudgeResponse(framed = false) {
    const payload = encodeCursor('DefaultModelNudgeDataResponse', {
      nudgeDate: '0',
      shouldDefaultSwitchOnNewChat: false,
      modelsWithNoDefaultSwitch: sortedModels(this.config).map(item => item.id),
      conversionModelOverride: '',
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildServerConfigResponse() {
    return encodeCursor('ServerConfigResponse', {
      configVersion: 'magpie_cursor_bridge_v1',
      http2Config: 1,
      cliSandboxDefaultEnabled: true,
    });
  }

  buildStatsigBootstrapResponse() {
    const generatedAtMs = Date.now();
    const configJson = JSON.stringify({
      feature_gates: {},
      dynamic_configs: {},
      layer_configs: {},
      user: { userID: 'local_bridge', customIDs: { localUserID: 'local_bridge' } },
      has_updates: true,
      hash_used: 'none',
      sdkParams: { stableID: 'local_bridge', disableDiagnosticsLogging: true },
      time: generatedAtMs,
    });
    return encodeCursor('BootstrapStatsigResponse', { config: configJson, generatedAtMs });
  }

  async handleCommitMessage(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('WriteGitCommitMessageRequest', payload);
    const diffs = (req.diffs || []).slice(0, 12).map(diff => diff.slice(0, 16000)).join('\n---\n').slice(0, 40000);
    if (!diffs.trim()) {
      throw new Error('Diffs are required to generate a commit message');
    }
    const prev = (req.previousCommitMessages || []).slice(0, 10).join('\n');
    const promptParts = [`Generate a concise, accurate git commit message for these diffs:\n\n${diffs}`];
    if (prev) promptParts.push(`\nRecent commit messages for style:\n${prev}`);
    if (req.explicitContext?.context) promptParts.push(`\nContext:\n${req.explicitContext.context.slice(0, 8000)}`);

    const text = await completeOpenAiText({
      config: this.config,
      modelId: this.config.model,
      messages: [
        {
          role: 'system',
          content: 'You write concise git commit messages. Return only the commit message text without markdown fences.',
        },
        { role: 'user', content: promptParts.join('\n') },
      ],
      signal: AbortSignal.timeout(120_000),
    });
    const cleaned = text.replace(/^```[^\n]*\n?|\n?```$/g, '').trim();
    return encodeCursor('WriteGitCommitMessageResponse', { commitMessage: cleaned });
  }

  getOrCreateSession(requestId) {
    let session = this.sessions.get(requestId);
    if (!session) {
      session = new AgentSession(requestId, () => this.config, () => this.sessions.delete(requestId));
      this.sessions.set(requestId, session);
    }
    return session;
  }

  async handleBidiAppend(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const appendReq = decodeCursor('BidiAppendRequest', payload);
    const requestId = appendReq.requestId?.requestId;
    if (!requestId) {
      throw new Error('BidiAppend missing request_id');
    }
    const clientBytes =
      appendReq.dataBinary && appendReq.dataBinary.length > 0
        ? appendReq.dataBinary
        : Buffer.from(appendReq.data || '', 'hex');
    const clientMessage = decodeCursor('AgentClientMessage', clientBytes);
    const session = this.getOrCreateSession(requestId);
    session.acceptAppend(Number(appendReq.appendSeqno || 0), clientMessage);
    return Buffer.alloc(0);
  }

  handleRunSse(rawBody, streamResponse) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('BidiRequestId', payload);
    if (!req.requestId) {
      throw new Error('RunSSE missing request_id');
    }
    const session = this.getOrCreateSession(req.requestId);
    session.attachStream(streamResponse);
  }
}

class AgentSession {
  constructor(requestId, getConfig, onDispose) {
    this.requestId = requestId;
    this.getConfig = getConfig;
    this.onDispose = onDispose;
    this.nextSeqno = 0;
    this.bufferedAppends = new Map();
    this.blobs = new Map();
    this.pendingKv = new Map();
    this.pendingExec = new Map();
    this.nextExecId = 1;
    this.nextKvId = 1;
    this.outQueue = [];
    this.stream = null;
    this.abortController = new AbortController();
    this.running = false;
    this.closed = false;
    this.heartbeatTimer = null;
  }

  emit(serverMessage) {
    if (this.closed) return;
    const frame = encodeConnectFrame(encodeCursor('AgentServerMessage', serverMessage));
    if (this.stream) {
      this.stream.write(frame);
    } else {
      this.outQueue.push(frame);
    }
  }

  endStream(errorObj = null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    const frame = encodeConnectEndStream(errorObj);
    if (this.stream) {
      this.stream.write(frame);
      this.stream.end();
    } else {
      this.outQueue.push(frame);
    }
    this.abortController.abort();
    this.failAllPending('Agent stream ended');
    setTimeout(() => this.onDispose(), 5000).unref?.();
  }

  attachStream(res) {
    this.stream = res;
    res.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        clearInterval(this.heartbeatTimer);
        this.abortController.abort();
        this.failAllPending('Client closed RunSSE stream');
        this.onDispose();
      }
    });
    for (const frame of this.outQueue) {
      res.write(frame);
    }
    this.outQueue = [];
    if (this.closed) {
      res.end();
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.emit({ interactionUpdate: { heartbeat: {} } });
    }, 15_000);
    this.heartbeatTimer.unref?.();
  }

  failAllPending(reason) {
    for (const pending of this.pendingKv.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingKv.clear();
    for (const pending of this.pendingExec.values()) {
      pending.reject(new Error(reason));
    }
    this.pendingExec.clear();
  }

  acceptAppend(seqno, message) {
    if (seqno < this.nextSeqno || this.bufferedAppends.has(seqno)) return;
    this.bufferedAppends.set(seqno, message);
    while (this.bufferedAppends.has(this.nextSeqno)) {
      const nextMsg = this.bufferedAppends.get(this.nextSeqno);
      this.bufferedAppends.delete(this.nextSeqno);
      this.nextSeqno += 1;
      this.dispatchClientMessage(nextMsg);
    }
  }

  dispatchClientMessage(msg) {
    if (msg.kvClientMessage) {
      const kv = msg.kvClientMessage;
      const pending = this.pendingKv.get(kv.id);
      if (pending) {
        this.pendingKv.delete(kv.id);
        pending.resolve(kv);
      }
      return;
    }
    if (msg.execClientControlMessage) {
      const ctrl = msg.execClientControlMessage;
      if (ctrl.throw) {
        const pending = this.pendingExec.get(ctrl.throw.id);
        if (pending) {
          this.pendingExec.delete(ctrl.throw.id);
          pending.reject(new Error(ctrl.throw.message || 'Client threw exec error'));
        }
      }
      return;
    }
    if (msg.execClientMessage) {
      const execMsg = msg.execClientMessage;
      const pending = this.pendingExec.get(execMsg.id);
      if (!pending) return;
      if (execMsg.shellStream) {
        pending.onShellStream?.(execMsg);
        return;
      }
      this.pendingExec.delete(execMsg.id);
      pending.resolve(execMsg);
      return;
    }
    const cancelAction = msg.conversationAction?.cancelAction || msg.runRequest?.action?.cancelAction;
    if (cancelAction) {
      const reason = cancelAction.reason || 'Cancelled';
      this.abortController.abort(new Error(reason));
      this.failAllPending(reason);
      return;
    }
    if (msg.runRequest && !this.running) {
      this.running = true;
      this.executeRun(msg.runRequest).catch(error => {
        if (!this.closed) {
          this.endStream({
            code: this.abortController.signal.aborted ? 'canceled' : 'internal',
            message: error?.message || String(error),
          });
        }
      });
    }
  }

  requestKvBlob(blobIdBytes) {
    const key = blobKey(blobIdBytes);
    if (this.blobs.has(key)) return Promise.resolve(this.blobs.get(key));
    const id = this.nextKvId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingKv.delete(id);
        reject(new Error('KV GetBlob timed out'));
      }, 30_000);
      this.pendingKv.set(id, {
        resolve: kv => {
          clearTimeout(timer);
          if (kv.getBlobResult?.blobData) {
            this.blobs.set(key, kv.getBlobResult.blobData);
            resolve(kv.getBlobResult.blobData);
          } else {
            resolve(null);
          }
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.emit({ kvServerMessage: { id, getBlobArgs: { blobId: blobIdBytes } } });
    });
  }

  requestContextFromClient(conversationId) {
    const id = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExec.delete(id);
        reject(new Error('RequestContext timed out'));
      }, 30_000);
      this.pendingExec.set(id, {
        resolve: execMsg => {
          clearTimeout(timer);
          resolve(execMsg.requestContextResult?.success?.requestContext || {});
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.emit({
        execServerMessage: {
          id,
          execId: `ctx-${this.requestId}`,
          requestContextArgs: { notesSessionId: conversationId },
        },
      });
    });
  }

  runExec(execMsgBuilder, { onShellDelta } = {}) {
    const id = this.nextExecId++;
    const message = execMsgBuilder(id);
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        this.pendingExec.delete(id);
        reject(new Error(`Tool execution ${id} timed out`));
      }, 300_000);

      this.pendingExec.set(id, {
        onShellStream: execClientMsg => {
          const stream = execClientMsg.shellStream;
          if (stream.stdout?.data) {
            stdout += stream.stdout.data;
            onShellDelta?.(true, stream.stdout.data);
          } else if (stream.stderr?.data) {
            stderr += stream.stderr.data;
            onShellDelta?.(false, stream.stderr.data);
          } else if (stream.exit) {
            clearTimeout(timer);
            this.pendingExec.delete(id);
            const ok = stream.exit.code === 0 && !stream.exit.aborted;
            resolve({
              shellResult: ok
                ? { success: { stdout, stderr, exitCode: stream.exit.code, workingDirectory: stream.exit.cwd } }
                : { failure: { stdout, stderr, exitCode: stream.exit.code, aborted: stream.exit.aborted } },
            });
          } else if (stream.backgrounded) {
            clearTimeout(timer);
            this.pendingExec.delete(id);
            resolve({
              shellResult: {
                isBackground: true,
                pid: stream.backgrounded.pid,
                success: {
                  stdout,
                  stderr,
                  shellId: stream.backgrounded.shellId,
                  pid: stream.backgrounded.pid,
                },
              },
            });
          } else if (stream.rejected) {
            clearTimeout(timer);
            this.pendingExec.delete(id);
            resolve({ shellResult: { rejected: stream.rejected } });
          } else if (stream.permissionDenied) {
            clearTimeout(timer);
            this.pendingExec.delete(id);
            resolve({ shellResult: { permissionDenied: stream.permissionDenied } });
          } else if (stream.sandboxUnsupported) {
            clearTimeout(timer);
            this.pendingExec.delete(id);
            resolve({ shellResult: { spawnError: { error: stream.sandboxUnsupported.reason || 'sandbox unsupported' } } });
          }
        },
        resolve: execClientMsg => {
          clearTimeout(timer);
          resolve(execClientMsg);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.emit({ execServerMessage: message });
    });
  }

  async hydrateMessages(runRequest, requestContext) {
    for (const blob of runRequest.preFetchedBlobs || []) {
      if (blob.id && blob.value) {
        this.blobs.set(blobKey(blob.id), blob.value);
      }
    }

    const messages = [];
    const systemParts = [];
    if (runRequest.customSystemPrompt) systemParts.push(runRequest.customSystemPrompt);
    if (requestContext.cloudRule) systemParts.push(requestContext.cloudRule);
    for (const rule of [...(requestContext.rules || []), ...(requestContext.nonFileRules || [])]) {
      if (rule.content) systemParts.push(`[Rule: ${rule.fullPath}]\n${rule.content}`);
    }
    for (const skill of requestContext.agentSkills || []) {
      if (!skill.disableModelInvocation && skill.content) {
        systemParts.push(`[Skill: ${skill.fullPath}]\n${skill.content}`);
      }
    }
    if (requestContext.env?.workspacePaths?.length) {
      systemParts.push(`Workspace paths: ${requestContext.env.workspacePaths.join(', ')}`);
    }
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    }

    // Prefer explicit conversationHistory when supplied, else hydrate from ConversationState turns.
    const userAction = runRequest.action?.userMessageAction;
    if (userAction?.conversationHistory?.messages?.length) {
      for (const histMsg of userAction.conversationHistory.messages) {
        if (histMsg.user) {
          const text = (histMsg.user.content || []).map(part => part.text?.text || '').filter(Boolean).join('\n');
          if (text) messages.push({ role: 'user', content: text });
        } else if (histMsg.assistant) {
          const text = (histMsg.assistant.content || []).map(part => part.text?.text || '').filter(Boolean).join('\n');
          const toolCalls = (histMsg.assistant.content || [])
            .filter(part => part.toolCall)
            .map(part => ({
              id: part.toolCall.toolCallId,
              type: 'function',
              function: { name: part.toolCall.toolName, arguments: part.toolCall.argsJson || '{}' },
            }));
          if (text || toolCalls.length) {
            messages.push({
              role: 'assistant',
              content: text || null,
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });
          }
        } else if (histMsg.tool) {
          const text = (histMsg.tool.content || []).map(part => part.text?.text || '').filter(Boolean).join('\n');
          messages.push({ role: 'tool', tool_call_id: histMsg.tool.toolCallId, content: text || 'ok' });
        }
      }
    } else if (runRequest.conversationState?.turns?.length) {
      for (const turnBlobId of runRequest.conversationState.turns) {
        try {
          const turnData = await this.requestKvBlob(turnBlobId);
          if (!turnData) continue;
          const turn = decodeCursor('ConversationTurnStructure', turnData);
          const agentTurn = turn.agentConversationTurn;
          if (!agentTurn) continue;
          if (agentTurn.userMessage?.length) {
            const userBlob = await this.requestKvBlob(agentTurn.userMessage);
            if (userBlob) {
              const uMsg = decodeCursor('UserMessage', userBlob);
              if (uMsg.text) messages.push({ role: 'user', content: uMsg.text });
            }
          }
          const stepTexts = [];
          for (const stepBlobId of agentTurn.steps || []) {
            const stepBlob = await this.requestKvBlob(stepBlobId);
            if (!stepBlob) continue;
            const step = decodeCursor('ConversationStep', stepBlob);
            if (step.assistantMessage?.text) stepTexts.push(step.assistantMessage.text);
          }
          if (stepTexts.length) messages.push({ role: 'assistant', content: stepTexts.join('') });
        } catch {
          // Skip unreachable historical turn blobs gracefully.
        }
      }
    }

    const userMessage = userAction?.userMessage;
    if (userMessage) {
      const ctxChunks = [];
      for (const file of userMessage.selectedContext?.files || []) {
        ctxChunks.push(`File ${file.relativePath || file.path}:\n\`\`\`\n${file.content}\n\`\`\``);
      }
      for (const sel of userMessage.selectedContext?.codeSelections || []) {
        ctxChunks.push(`Selection ${sel.relativePath || sel.path}:\n\`\`\`\n${sel.content}\n\`\`\``);
      }
      for (const extra of userMessage.selectedContext?.extraContext || []) {
        ctxChunks.push(extra);
      }
      const combined = [...ctxChunks, userMessage.text].filter(Boolean).join('\n\n');
      if (combined) {
        messages.push({ role: 'user', content: combined });
      }
    } else if (runRequest.action?.executePlanAction) {
      const planAction = runRequest.action.executePlanAction;
      messages.push({
        role: 'user',
        content: `Execute plan ${planAction.planFileUri || planAction.planFilePath || ''}:\n${planAction.planFileContent || ''}`,
      });
    } else if (runRequest.action?.summarizeAction) {
      messages.push({ role: 'user', content: 'Summarize the conversation concisely so far.' });
    }

    return messages;
  }

  async executeRun(runRequest) {
    const config = this.getConfig();
    const conversationId = runRequest.conversationId || this.requestId;
    const { modelId, effort } = resolveModelSelection(runRequest, config);

    let requestContext =
      runRequest.action?.userMessageAction?.requestContext ||
      runRequest.action?.executePlanAction?.requestContext ||
      runRequest.action?.requestContextParts?.dynamicContext ||
      {};

    if (!requestContext.env && !requestContext.tools?.length) {
      try {
        const loaded = await this.requestContextFromClient(conversationId);
        requestContext = { ...loaded, ...requestContext };
      } catch {
        // Proceed cleanly when client has no RequestContext handler (e.g. headless smoke client).
      }
    }

    const workspaceDir = requestContext.env?.workspacePaths?.[0] || requestContext.env?.processWorkingDirectory || '';
    const mcpDefinitions = [
      ...(runRequest.mcpTools?.mcpTools || []),
      ...(requestContext.tools || []),
    ];
    const { tools, mcpMap } = buildOpenAiTools(mcpDefinitions);
    const messages = await this.hydrateMessages(runRequest, requestContext);

    let finalUsage = null;
    const maxToolRounds = 24;
    for (let round = 0; round < maxToolRounds; round += 1) {
      if (this.abortController.signal.aborted) break;
      const modelCallId = crypto.randomUUID();
      let thinkingStartedAt = null;
      let roundText = '';
      let roundThinking = '';

      const streamResult = await streamOpenAiChat({
        config,
        modelId,
        messages,
        tools,
        reasoningEffort: effort,
        signal: this.abortController.signal,
        onEvent: event => {
          if (event.type === 'thinking_delta') {
            if (!thinkingStartedAt) thinkingStartedAt = Date.now();
            roundThinking += event.text;
            this.emit({ interactionUpdate: { thinkingDelta: { text: event.text } } });
          } else if (event.type === 'text_delta') {
            if (thinkingStartedAt) {
              const elapsedMs = Math.max(1, Date.now() - thinkingStartedAt);
              thinkingStartedAt = null;
              this.emit({ interactionUpdate: { thinkingCompleted: { thinkingDurationMs: elapsedMs } } });
            }
            roundText += event.text;
            this.emit({ interactionUpdate: { textDelta: { text: event.text, isServerNotice: false } } });
          }
        },
      });

      if (thinkingStartedAt) {
        const elapsedMs = Math.max(1, Date.now() - thinkingStartedAt);
        this.emit({ interactionUpdate: { thinkingCompleted: { thinkingDurationMs: elapsedMs } } });
      }
      if (streamResult.usage) {
        finalUsage = streamResult.usage;
      }

      const toolCalls = streamResult.toolCalls || [];
      if (toolCalls.length === 0) {
        break;
      }

      messages.push({
        role: 'assistant',
        content: roundText || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argumentsText || '{}' },
        })),
      });

      for (const tc of toolCalls) {
        let parsedArgs = {};
        let argParseError = null;
        try {
          parsedArgs = tc.argumentsText ? JSON.parse(tc.argumentsText) : {};
        } catch (err) {
          argParseError = err.message;
        }

        this.emit({
          interactionUpdate: {
            toolCallStarted: {
              callId: tc.id,
              modelCallId,
              toolCall: renderToolCard({ callId: tc.id, name: tc.name, args: parsedArgs }),
            },
          },
        });

        if (argParseError) {
          const errText = `Invalid JSON tool arguments: ${argParseError}`;
          this.emit({
            interactionUpdate: {
              toolCallCompleted: {
                callId: tc.id,
                modelCallId,
                toolCall: renderToolCard({ callId: tc.id, name: tc.name, args: parsedArgs }),
              },
            },
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: errText });
          continue;
        }

        let formattedResult;
        try {
          const norm = normalizeToolName(tc.name);
          const mcpDef = mcpMap.get(tc.name) || null;
          if (!mcpDef && (norm === 'write' || norm === 'strreplace')) {
            const readReply = await this.runExec(execIdNum =>
              buildExecRequest({
                execIdNum,
                callId: tc.id,
                name: tc.name,
                args: parsedArgs,
                mcpDef: null,
                conversationId,
                workspaceDir,
              })
            );
            const editCtx = computeEditedContent(tc.name, parsedArgs, readReply.readResult || readReply.redactedReadResult);
            const targetPath = parsedArgs.path || parsedArgs.file_path || parsedArgs.filePath;
            const writeReply = await this.runExec(execIdNum => ({
              id: execIdNum,
              execId: tc.id,
              acceptHookAdditionalContexts: true,
              writeArgs: {
                path: targetPath,
                fileText: editCtx.after,
                toolCallId: tc.id,
                returnFileContentAfterWrite: false,
                fileBytes: Buffer.alloc(0),
              },
            }));
            formattedResult = formatExecResult(tc.name, parsedArgs, writeReply, editCtx);
          } else {
            const execReply = await this.runExec(
              execIdNum =>
                buildExecRequest({
                  execIdNum,
                  callId: tc.id,
                  name: tc.name,
                  args: parsedArgs,
                  mcpDef,
                  conversationId,
                  workspaceDir,
                }),
              {
                onShellDelta: (isStdout, chunk) => {
                  this.emit({
                    interactionUpdate: {
                      toolCallDelta: {
                        callId: tc.id,
                        modelCallId,
                        toolCallDelta: {
                          shellToolCallDelta: isStdout
                            ? { stdout: { content: chunk } }
                            : { stderr: { content: chunk } },
                        },
                      },
                    },
                  });
                },
              }
            );
            formattedResult = formatExecResult(tc.name, parsedArgs, execReply);
          }
        } catch (err) {
          formattedResult = { text: err?.message || String(err), isError: true, cardResult: null };
        }

        this.emit({
          interactionUpdate: {
            toolCallCompleted: {
              callId: tc.id,
              modelCallId,
              toolCall: renderToolCard({
                callId: tc.id,
                name: tc.name,
                args: parsedArgs,
                result: formattedResult.cardResult,
              }),
            },
          },
        });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: formattedResult.text });
      }
    }

    if (this.abortController.signal.aborted) {
      const reason = this.abortController.signal.reason;
      this.endStream({
        code: 'canceled',
        message: reason instanceof Error ? reason.message : String(reason || 'Cancelled'),
      });
      return;
    }

    this.emit({
      interactionUpdate: {
        turnEnded: {
          inputTokens: finalUsage?.inputTokens ?? undefined,
          outputTokens: finalUsage?.outputTokens ?? undefined,
          cacheReadTokens: finalUsage?.cacheReadTokens ?? undefined,
          reasoningTokens: finalUsage?.reasoningTokens ?? undefined,
        },
      },
    });
    this.endStream(null);
  }
}
