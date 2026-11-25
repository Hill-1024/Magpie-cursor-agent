import zlib from 'node:zlib';
import {
  isCursorAutoModelId,
  parseModelRef,
  parseServiceTierParam,
  resolveAutoRouterConfig,
  resolveEffectiveServiceTier,
  resolveRoleModel,
} from './config.js';
import {
  decodeConnectFrames,
  decodeCursor,
  encodeConnectEndStream,
  encodeConnectFrame,
  encodeCursor,
} from './cursor-schemas.js';
import { streamOpenAiChat } from './openai-stream.js';
import { buildPromptModelMetadata } from './private-inference.js';
import { fromProtoValue } from './proto-wire.js';

const UNATTACHED_SESSION_TTL_MS = 60_000;
const ROLE_SYSTEM = 4;
const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;
const ROLE_TOOL = 3;
const PURPOSE_CONTEXT_SUMMARIZATION = 1;
const PURPOSE_THINKING_NOTE = 2;
const PURPOSE_PROMPT_CACHE_REFILL = 3;

function decodeStructToPlain(pbStruct) {
  if (!pbStruct || typeof pbStruct !== 'object') return {};
  const fields = pbStruct.fields;
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(fields)) {
    out[key] = fromProtoValue(val);
  }
  return out;
}

function decompressConnectPayload(buffer, flags) {
  if ((flags & 0x01) === 0) return buffer;
  return zlib.gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 });
}

function decodeInvokeRequestPayload(invokeMsg) {
  if (invokeMsg?.request) return invokeMsg.request;
  const compressed = invokeMsg?.compressedRequest;
  if (!compressed || !compressed.data || compressed.data.length === 0) {
    return null;
  }
  let inflated;
  if (compressed.encoding === 1 && typeof zlib.zstdDecompressSync === 'function') {
    inflated = zlib.zstdDecompressSync(compressed.data, { maxOutputLength: 64 * 1024 * 1024 });
  } else if (compressed.encoding === 2) {
    inflated = zlib.gunzipSync(compressed.data, { maxOutputLength: 64 * 1024 * 1024 });
  } else {
    inflated = compressed.data;
  }
  return decodeCursor('InferenceStreamRequest', inflated);
}

function lookupCatalogEntry(config, modelId) {
  if (!modelId) return null;
  const clean = parseModelRef(modelId).modelId;
  const all = [...(config?.models || []), ...(config?.hiddenModels || [])];
  return all.find(item => item?.id === clean) || null;
}

function extractModelParameters(requestedModel) {
  const params = Array.isArray(requestedModel?.parameters) ? requestedModel.parameters : [];
  let effort = null;
  let explicitTier = null;
  let fastTier = null;
  for (const param of params) {
    if (!param) continue;
    const paramId = String(param.id || '').trim().toLowerCase();
    if ((paramId === 'reasoning' || paramId === 'reasoning_effort') && param.value && param.value !== 'default' && param.value !== 'none') {
      effort = String(param.value).trim();
    } else if (paramId === 'service_tier' || paramId === 'tier' || paramId === 'speed') {
      const parsedTier = parseServiceTierParam(param.value);
      if (parsedTier) explicitTier = parsedTier;
    } else if (paramId === 'fast') {
      const parsedFast = parseServiceTierParam(param.value, { isFastFlag: true });
      if (parsedFast) fastTier = parsedFast;
    }
  }
  const serviceTier = explicitTier || fastTier || (requestedModel?.maxMode ? 'priority' : null);
  return { effort, serviceTier };
}

function matchKnownOrExposedModel(rawId, config) {
  const parsed = parseModelRef(rawId);
  const baseId = parsed.modelId || '';
  if (!baseId) return { modelId: config.model, effort: parsed.effort };
  const all = [...(config.models || []), ...(config.hiddenModels || [])];
  const exact = all.find(entry => entry.id === baseId);
  if (exact) return { modelId: exact.id, effort: parsed.effort };
  const byLengthDesc = [...all].sort((left, right) => right.id.length - left.id.length);
  const legacyMatch = byLengthDesc.find(entry => baseId.startsWith(`${entry.id}-`));
  if (legacyMatch) return { modelId: legacyMatch.id, effort: parsed.effort };
  return { modelId: baseId, effort: parsed.effort };
}

/** Resolve which Magpie target model, effort, and service tier handle a local-loop request. */
export function resolveInferenceModel(config, runRequest = {}, streamRequest = null, purpose = 0) {
  const reqModel = streamRequest?.requestedModel || runRequest?.requestedModel || null;
  const rawId = String(streamRequest?.modelId || reqModel?.modelId || '').trim();
  const { effort: paramEffort, serviceTier: paramServiceTier } = extractModelParameters(reqModel);
  const cleanLower = rawId.toLowerCase();
  const isAutoAlias =
    !rawId ||
    cleanLower === 'default' ||
    cleanLower === 'auto' ||
    cleanLower.startsWith('auto-') ||
    isCursorAutoModelId(rawId);

  let baseModelId = config.model;
  let baseEffort = paramEffort;
  let baseTier = paramServiceTier;
  if (isAutoAlias) {
    const routed = resolveAutoRouterConfig(config);
    if (routed.modelId) {
      baseModelId = routed.modelId;
      if (!baseEffort && routed.effort) baseEffort = routed.effort;
      if (!baseTier && routed.serviceTier) baseTier = routed.serviceTier;
    } else {
      baseModelId = config.model;
    }
    if (!baseEffort) {
      if (cleanLower === 'auto-low') baseEffort = 'low';
      else if (cleanLower === 'auto-medium') baseEffort = 'medium';
      else if (cleanLower === 'auto-high') baseEffort = 'high';
    }
  } else {
    const matched = matchKnownOrExposedModel(rawId, config);
    baseModelId = matched.modelId;
    if (!baseEffort && matched.effort) baseEffort = matched.effort;
    if (!baseTier) {
      const parsedRaw = parseModelRef(rawId);
      if (parsedRaw.serviceTier) baseTier = parsedRaw.serviceTier;
    }
  }

  let resolvedModelId = baseModelId;
  let resolvedEffort = baseEffort;
  let roleServiceTier = null;
  let fromExplicitRole = false;

  if (purpose === PURPOSE_CONTEXT_SUMMARIZATION || runRequest?.isSummarizeAction) {
    const roleModel = resolveRoleModel(config, 'summarize', { fallbackModel: baseModelId });
    resolvedModelId = roleModel.modelId;
    resolvedEffort = roleModel.effort ?? baseEffort;
    roleServiceTier = roleModel.serviceTier || null;
    fromExplicitRole = roleModel.role !== 'default';
  } else if (streamRequest?.subagentType || runRequest?.subagentTypeName) {
    const subType = String(streamRequest?.subagentType || runRequest?.subagentTypeName || '').trim();
    const roleModel = resolveRoleModel(config, 'subagent', {
      subagentType: subType,
      fallbackModel: baseModelId,
    });
    resolvedModelId = roleModel.modelId;
    resolvedEffort = roleModel.effort ?? baseEffort;
    roleServiceTier = roleModel.serviceTier || null;
    fromExplicitRole = roleModel.role !== 'default';
  } else if (purpose === PURPOSE_THINKING_NOTE || purpose === PURPOSE_PROMPT_CACHE_REFILL) {
    resolvedModelId = baseModelId;
  }

  const catalogEntry = lookupCatalogEntry(config, resolvedModelId);
  const serviceTier = fromExplicitRole
    ? resolveEffectiveServiceTier(resolvedModelId, config, roleServiceTier, {
        inheritTier: baseTier,
        allowUnknownExplicit: true,
      })
    : resolveEffectiveServiceTier(resolvedModelId, config, baseTier);
  return {
    modelId: resolvedModelId || config.model,
    reasoningEffort: resolvedEffort || null,
    serviceTier,
    catalogEntry,
  };
}

function formatImageUrl(imagePart) {
  const data = String(imagePart?.data || '').trim();
  if (!data) return '';
  if (data.startsWith('data:') || data.startsWith('http://') || data.startsWith('https://')) {
    return data;
  }
  const mime = String(imagePart?.mimeType || '').trim() || 'image/png';
  return `data:${mime};base64,${data}`;
}

/** Convert Cursor `InferenceCoreMessage[]` into standard OpenAI chat messages. */
export function inferenceMessagesToOpenAi(messages = []) {
  const out = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;
    if (msg.role === ROLE_SYSTEM) {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (text) out.push({ role: 'system', content: text });
      continue;
    }

    if (msg.role === ROLE_USER) {
      if (msg.parts && Array.isArray(msg.parts.parts) && msg.parts.parts.length > 0) {
        const openAiParts = [];
        let hasNonText = false;
        for (const part of msg.parts.parts) {
          if (part.text) {
            openAiParts.push({ type: 'text', text: part.text.text || '' });
          } else if (part.image) {
            const url = formatImageUrl(part.image);
            if (url) {
              hasNonText = true;
              openAiParts.push({ type: 'image_url', image_url: { url } });
            }
          } else if (part.file) {
            const fileLabel = part.file.filename ? `[File: ${part.file.filename}]` : '[File]';
            openAiParts.push({ type: 'text', text: part.file.data || fileLabel });
          }
        }
        if (openAiParts.length > 0) {
          out.push({
            role: 'user',
            content: hasNonText ? openAiParts : openAiParts.map(item => item.text).join(''),
          });
        }
      } else {
        out.push({ role: 'user', content: msg.text || '' });
      }
      continue;
    }

    if (msg.role === ROLE_ASSISTANT) {
      const entry = { role: 'assistant' };
      const text =
        typeof msg.text === 'string' && msg.text.length > 0
          ? msg.text
          : Array.isArray(msg.assistantTextParts) && msg.assistantTextParts.length > 0
            ? msg.assistantTextParts.join('')
            : null;
      if (text !== null) {
        entry.content = text;
      } else if (!Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) {
        entry.content = '';
      } else {
        entry.content = null;
      }

      if (Array.isArray(msg.reasoningParts) && msg.reasoningParts.length > 0) {
        const reasoning = msg.reasoningParts
          .filter(part => part && !part.isRedacted && typeof part.text === 'string' && part.text.length > 0)
          .map(part => part.text)
          .join('\n');
        if (reasoning) {
          entry.reasoning_content = reasoning;
        }
      }

      if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.toolCallId || '',
          type: 'function',
          function: {
            name: tc.toolName || '',
            arguments:
              typeof tc.rawToolCallArgs === 'string' && tc.rawToolCallArgs.length > 0
                ? tc.rawToolCallArgs
                : JSON.stringify(tc.args ? decodeStructToPlain(tc.args) : {}),
          },
        }));
      }
      out.push(entry);
      continue;
    }

    if (msg.role === ROLE_TOOL) {
      const parts = Array.isArray(msg.toolContent?.parts) ? msg.toolContent.parts : [];
      const trailingImages = [];
      for (const part of parts) {
        const rawVal = part.result ? fromProtoValue(part.result) : '';
        let textVal =
          typeof rawVal === 'string'
            ? rawVal
            : rawVal === null || rawVal === undefined
              ? ''
              : JSON.stringify(rawVal);
        if (Array.isArray(part.experimentalContent)) {
          const extraText = [];
          for (const exp of part.experimentalContent) {
            if (exp.text?.text) {
              extraText.push(exp.text.text);
            } else if (exp.image) {
              const url = formatImageUrl(exp.image);
              if (url) trailingImages.push({ type: 'image_url', image_url: { url } });
            }
          }
          if (extraText.length > 0) {
            textVal = [textVal, ...extraText].filter(Boolean).join('\n');
          }
        }
        out.push({
          role: 'tool',
          tool_call_id: part.toolCallId || '',
          content: textVal || (part.isError ? 'Tool call failed' : ''),
        });
      }
      if (trailingImages.length > 0) {
        out.push({
          role: 'user',
          content: [{ type: 'text', text: '[Tool output images]' }, ...trailingImages],
        });
      }
    }
  }
  return out;
}

/** Convert Cursor `InferenceAgentTool[]` into OpenAI function tool descriptors. */
export function inferenceToolsToOpenAi(tools = []) {
  const out = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || !tool.name) continue;
    const rawParams = tool.parameters ? decodeStructToPlain(tool.parameters) : null;
    const parameters =
      rawParams && typeof rawParams === 'object' && Object.keys(rawParams).length > 0
        ? rawParams
        : { type: 'object', properties: {} };
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters,
      },
    });
  }
  return out;
}

function safeNormalizeArgsJson(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return '{}';
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return JSON.stringify({ _raw: text });
  }
}

/** Detect whether raw client bytes represent a `RunInferenceClientMessage` rather than `AgentClientMessage`. */
export function isRunInferenceClientMessageBytes(clientBytes) {
  try {
    const decoded = decodeCursor('RunInferenceClientMessage', clientBytes);
    if (decoded.invokeModel || decoded.cancelInvocation || decoded.finishRun || decoded.resolveSubagentModels || decoded.deltaBaseSeed || decoded.clientFirstCallTimings) {
      return true;
    }
    if (decoded.runRequest) {
      const convId = decoded.runRequest.conversationId;
      if (typeof convId === 'string' && /^[\x20-\x7e]{1,256}$/.test(convId)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  try {
    const agentDecoded = decodeCursor('AgentClientMessage', clientBytes);
    if (agentDecoded.runRequest?.action || agentDecoded.runRequest?.conversationState || agentDecoded.execClientMessage || agentDecoded.kvClientMessage) {
      return false;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Stateful Connect session backing `aiserver.v1.InferenceService/RunInference` (HTTP/2 BiDi)
 * and `RunInferenceSSE` + `BidiAppend` (HTTP/1 SSE) for Cursor's native local agent loop.
 */
export class InferenceSession {
  constructor(requestId, getConfig, onDispose) {
    this.requestId = requestId;
    this.getConfig = getConfig;
    this.onDispose = onDispose;
    this.nextSeqno = 0;
    this.bufferedAppends = new Map();
    this.activeInvocations = new Map();
    this.outQueue = [];
    this.stream = null;
    this.reqStream = null;
    this.runRequest = null;
    this.inputEnded = false;
    this.closed = false;
    this.heartbeatTimer = null;
    this.abortController = new AbortController();
    this.unattachedTimer = setTimeout(() => {
      if (!this.stream && !this.reqStream && !this.closed && this.activeInvocations.size === 0) {
        this.dispose('Unattached inference session expired');
      }
    }, UNATTACHED_SESSION_TTL_MS);
    this.unattachedTimer.unref?.();
  }

  emit(serverMessage) {
    if (this.closed) return;
    const frame = encodeConnectFrame(encodeCursor('RunInferenceServerMessage', serverMessage));
    if (this.stream) {
      if (!this.stream.destroyed && !this.stream.writableEnded) {
        this.stream.write(frame);
      }
    } else {
      this.outQueue.push(frame);
    }
  }

  endStream(errorObj = null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.unattachedTimer);
    const frame = encodeConnectEndStream(errorObj);
    if (this.stream) {
      if (!this.stream.destroyed && !this.stream.writableEnded) {
        this.stream.write(frame);
        this.stream.end();
      }
    } else {
      this.outQueue.push(frame);
    }
    this.abortAll('Inference stream ended');
    setTimeout(() => this.onDispose(), 5000).unref?.();
  }

  abortAll(reason) {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error(reason));
    }
    for (const controller of this.activeInvocations.values()) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
      }
    }
    this.activeInvocations.clear();
  }

  dispose(reason = 'Client closed inference stream') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.unattachedTimer);
    this.abortAll(reason);
    this.onDispose();
  }

  attachStream(res) {
    this.stream = res;
    clearTimeout(this.unattachedTimer);
    const onTeardown = () => this.dispose('Client closed inference response stream');
    res.on('close', onTeardown);
    res.on('error', onTeardown);
    for (const frame of this.outQueue) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(frame);
      }
    }
    this.outQueue = [];
    if (this.closed) {
      if (!res.destroyed && !res.writableEnded) res.end();
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      this.emit({
        heartbeat: {
          acceptsSpeculativeInvocations: false,
          acceptsCompressedSpeculativeInvocations: false,
        },
      });
    }, 15_000);
    this.heartbeatTimer.unref?.();
  }

  attachBidiStreams(req, res) {
    this.reqStream = req;
    this.attachStream(res);
    let buffer = Buffer.alloc(0);
    req.on('data', chunk => {
      if (this.closed) return;
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      const { frames, remaining } = decodeConnectFrames(buffer);
      buffer = remaining;
      for (const frame of frames) {
        if ((frame.flags & 0x02) !== 0) continue;
        try {
          const payload = decompressConnectPayload(frame.payload, frame.flags);
          const msg = decodeCursor('RunInferenceClientMessage', payload);
          this.handleClientMessage(msg);
        } catch (err) {
          this.endStream({ code: 'invalid_argument', message: err?.message || 'Malformed RunInference frame' });
          return;
        }
      }
    });
    req.on('end', () => {
      this.inputEnded = true;
      if (!this.closed && this.activeInvocations.size === 0) {
        this.endStream(null);
      }
    });
    req.on('error', () => this.dispose('Client bidi stream error'));
  }

  acceptAppend(seqno, clientMessage) {
    if (this.closed) return;
    if (seqno < this.nextSeqno) return;
    this.bufferedAppends.set(seqno, clientMessage);
    while (this.bufferedAppends.has(this.nextSeqno)) {
      const nextMsg = this.bufferedAppends.get(this.nextSeqno);
      this.bufferedAppends.delete(this.nextSeqno);
      this.nextSeqno += 1;
      this.handleClientMessage(nextMsg);
    }
  }

  handleClientMessage(msg) {
    if (this.closed || !msg) return;
    if (msg.runRequest) {
      this.handleRunRequest(msg.runRequest);
    } else if (msg.invokeModel) {
      void this.handleInvokeModel(msg.invokeModel);
    } else if (msg.cancelInvocation) {
      const invId = msg.cancelInvocation.invocationId;
      const controller = this.activeInvocations.get(invId);
      if (controller) {
        controller.abort(new Error('Invocation canceled'));
        this.activeInvocations.delete(invId);
      }
    } else if (msg.resolveSubagentModels) {
      this.handleResolveSubagentModels(msg.resolveSubagentModels);
    } else if (msg.finishRun) {
      this.endStream(null);
    }
  }

  handleRunRequest(runReq) {
    this.runRequest = runReq;
    const config = this.getConfig();
    const resolved = resolveInferenceModel(config, runReq, null, 0);
    const sumRole = resolveRoleModel(config, 'summarize', { fallbackModel: resolved.modelId });
    const sumCatalog = lookupCatalogEntry(config, sumRole.modelId);
    const contextWindow = Number(resolved.catalogEntry?.context || 200_000);
    const displayName = resolved.catalogEntry?.name
      ? `${resolved.catalogEntry.name} · ${resolved.modelId}`
      : resolved.modelId;

    const resolvedParams = resolved.reasoningEffort
      ? [{ id: 'reasoning', value: resolved.reasoningEffort }]
      : [];
    if (resolved.serviceTier) {
      resolvedParams.push({ id: 'service_tier', value: resolved.serviceTier });
    }
    const sumParams = sumRole.effort ? [{ id: 'reasoning', value: sumRole.effort }] : [];
    const sumServiceTier = resolveEffectiveServiceTier(
      sumRole.modelId,
      config,
      sumRole.serviceTier,
      { inheritTier: resolved.serviceTier, allowUnknownExplicit: true }
    );
    if (sumServiceTier) {
      sumParams.push({ id: 'service_tier', value: sumServiceTier });
    }

    this.emit({
      runReady: {
        resolvedModel: {
          modelId: resolved.modelId,
          maxMode: Boolean(runReq.requestedModel?.maxMode),
          parameters: resolvedParams,
          builtInModel: false,
        },
        supportsSelfSummary: true,
        routedModelDisplayName: displayName,
        promptModelMetadata: buildPromptModelMetadata(resolved.modelId, {
          reasoningEffort: resolved.reasoningEffort || '',
          contextWindow: Number.isSafeInteger(contextWindow) && contextWindow > 0 ? contextWindow : 200_000,
        }),
        summarization: {
          model: {
            modelId: sumRole.modelId,
            maxMode: false,
            parameters: sumParams,
            builtInModel: false,
          },
          isFallbackToMainModel: sumRole.role === 'default',
          maxPromptChars: Number(sumCatalog?.context || contextWindow) * 3,
        },
        acceptsClientHeartbeat: true,
        acceptsAgentEvents: true,
        kvBlobTelemetryEnabled: false,
        agentRunRequestLogRequested: false,
        metricLabels: { modelFamily: 'magpie' },
        acceptsAbortedFinish: true,
        acceptsSubagentModelResolution: true,
        acceptsToolCallEvents: true,
        acceptsClientFirstCallTimings: false,
        acceptsDeltaInvocations: false,
        acceptsDeltaBaseSeeds: false,
      },
    });
  }

  handleResolveSubagentModels(req) {
    const config = this.getConfig();
    const resolvedSubagent = resolveRoleModel(config, 'subagent', { fallbackModel: config.model });
    const fallbackSlug = resolvedSubagent.modelId || config.model;
    const models = (Array.isArray(req.requestedModels) ? req.requestedModels : []).map(requested => {
      const clean = String(requested || '').trim();
      const slug = !clean || clean === 'default' || clean === 'auto' ? fallbackSlug : clean;
      return {
        requested: clean,
        resolvedSlug: slug,
        policy: {
          slug,
          advertised: true,
          valid: true,
          blocked: false,
          requiresMaxMode: false,
          representativeCostDollars: 0,
          legacyAliases: [],
          turnedOffByUser: false,
        },
      };
    });
    this.emit({
      subagentModelsResolved: {
        resolutionId: req.resolutionId || '',
        models,
      },
    });
  }

  async handleInvokeModel(invokeMsg) {
    const invocationId = invokeMsg.invocationId || `inv_${Date.now()}`;
    const invAbort = new AbortController();
    const onSessionAbort = () => {
      if (!invAbort.signal.aborted) {
        invAbort.abort(this.abortController.signal.reason);
      }
    };
    if (this.abortController.signal.aborted) {
      onSessionAbort();
    } else {
      this.abortController.signal.addEventListener('abort', onSessionAbort, { once: true });
    }
    this.activeInvocations.set(invocationId, invAbort);

    let hasThinking = false;
    try {
      const streamReq = decodeInvokeRequestPayload(invokeMsg);
      if (!streamReq) {
        throw new Error('invokeModel missing InferenceStreamRequest');
      }
      const config = this.getConfig();
      const target = resolveInferenceModel(
        config,
        this.runRequest || {},
        streamReq,
        Number(invokeMsg.purpose || 0)
      );
      const messages = inferenceMessagesToOpenAi(streamReq.messages);
      const tools = inferenceToolsToOpenAi(streamReq.tools);

      const emitThinkingDone = () => {
        if (!hasThinking) return;
        hasThinking = false;
        this.emit({
          invocationResponse: {
            invocationId,
            response: {
              thinkingPart: { text: '', isFinal: true, modelName: target.modelId },
            },
          },
        });
      };

      this.emit({
        invocationResponse: {
          invocationId,
          response: { invocationId: { invocationId } },
        },
      });

      const result = await streamOpenAiChat({
        config,
        modelId: target.modelId,
        messages,
        tools,
        reasoningEffort: target.reasoningEffort,
        serviceTier: target.serviceTier,
        signal: invAbort.signal,
        onEvent: async event => {
          if (invAbort.signal.aborted || this.closed) return;
          if (event.type === 'thinking_delta') {
            hasThinking = true;
            this.emit({
              invocationResponse: {
                invocationId,
                response: {
                  thinkingPart: {
                    text: event.text,
                    isFinal: false,
                    modelName: target.modelId,
                  },
                },
              },
            });
          } else if (event.type === 'text_delta') {
            emitThinkingDone();
            this.emit({
              invocationResponse: {
                invocationId,
                response: {
                  textPart: { text: event.text, isFinal: false },
                },
              },
            });
          } else if (event.type === 'tool_call_start') {
            emitThinkingDone();
            this.emit({
              invocationResponse: {
                invocationId,
                response: {
                  toolCallPart: {
                    toolCallId: event.id,
                    toolName: event.name,
                    args: '',
                    isComplete: false,
                    toolIndex: event.index,
                  },
                },
              },
            });
          } else if (event.type === 'tool_call_delta') {
            this.emit({
              invocationResponse: {
                invocationId,
                response: {
                  toolCallPart: {
                    toolCallId: event.id,
                    toolName: '',
                    args: event.argsDelta,
                    isComplete: false,
                    toolIndex: event.index,
                  },
                },
              },
            });
          }
        },
      });

      if (invAbort.signal.aborted || this.closed) {
        this.emit({
          invocationEnd: {
            invocationId,
            error: { code: 1, message: 'Invocation canceled' },
          },
        });
        return;
      }

      emitThinkingDone();

      for (const tc of result.toolCalls || []) {
        this.emit({
          invocationResponse: {
            invocationId,
            response: {
              toolCallPart: {
                toolCallId: tc.id,
                toolName: tc.name,
                args: safeNormalizeArgsJson(tc.argumentsText),
                isComplete: true,
                toolIndex: tc.index,
              },
            },
          },
        });
      }

      if (result.usage) {
        const inputTokens = Math.max(0, Math.round(result.usage.inputTokens || 0));
        const outputTokens = Math.max(0, Math.round(result.usage.outputTokens || 0));
        const cacheReadTokens = Math.max(0, Math.round(result.usage.cacheReadTokens || 0));
        const reasoningTokens = Math.max(0, Math.round(result.usage.reasoningTokens || 0));
        const maxTokens = Number(target.catalogEntry?.context || 200_000);
        this.emit({
          invocationResponse: {
            invocationId,
            response: {
              usage: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens,
              },
            },
          },
        });
        this.emit({
          invocationResponse: {
            invocationId,
            response: {
              extendedUsage: {
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens: 0,
                maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : 200_000,
                reasoningTokens,
                contextInputTokens: inputTokens,
              },
            },
          },
        });
      }

      this.emit({
        invocationResponse: {
          invocationId,
          response: {
            responseInfo: {
              id: invocationId,
              model: target.modelId,
              createdAt: BigInt(Date.now()),
              messages: [],
              supportsSelfSummary: true,
            },
          },
        },
      });

      this.emit({
        invocationResponse: {
          invocationId,
          response: {
            textPart: { text: '', isFinal: true },
          },
        },
      });

      this.emit({ invocationEnd: { invocationId } });
    } catch (error) {
      if (this.closed) return;
      const canceled = invAbort.signal.aborted;
      this.emit({
        invocationEnd: {
          invocationId,
          error: {
            code: canceled ? 1 : 13,
            message: error?.message || (canceled ? 'Invocation canceled' : 'Magpie inference error'),
          },
        },
      });
    } finally {
      this.abortController.signal.removeEventListener('abort', onSessionAbort);
      this.activeInvocations.delete(invocationId);
      if (this.inputEnded && this.activeInvocations.size === 0 && !this.closed) {
        this.endStream(null);
      }
    }
  }
}
