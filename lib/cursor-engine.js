import crypto from 'node:crypto';
import { isCursorAutoModelId, parseModelRef, resolveAutoRouterConfig, resolveRoleModel } from './config.js';
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
  compactText,
  computeEditedContent,
  executeGetMcpTools,
  formatExecResult,
  normalizeToolName,
  renderToolCard,
  resolveCallMcpTool,
} from './cursor-tools.js';
import { completeOpenAiText, streamOpenAiChat } from './openai-stream.js';
import { InferenceSession, isRunInferenceClientMessageBytes } from './inference-loop.js';
import { buildGetTeamsData, buildGetTeamsJson } from './private-inference.js';

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
const AUTO_ROUTER_TIMEOUT_MS = 25_000;
const MAX_SKILL_DESC_CHARS = 360;
const MAX_REQUESTABLE_RULE_DESC_CHARS = 360;
const MAX_SINGLE_RULE_CHARS = 16_000;
const MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 24_000;
const MAX_SYSTEM_PROMPT_CHARS = 48_000;
const MAX_SELECTED_ITEM_CHARS = 16_000;
const MAX_SELECTED_CONTEXT_CHARS = 40_000;
const UNATTACHED_SESSION_TTL_MS = 60_000;
const NATIVE_AUTO_EFFORTS = new Map([
  ['default', null],
  ['auto', null],
  ['auto-low', 'low'],
  ['auto-medium', 'medium'],
  ['auto-high', 'high'],
]);

const AUTO_ROUTER_SYSTEM_PROMPT = [
  'You are the model router for Magpie Cursor Bridge.',
  'Select the single best model ID from the provided Magpie model catalogue for the user request.',
  'Do NOT answer the user request, do NOT invoke tools, and do NOT output commentary.',
  'Balance reasoning depth, coding accuracy, context capacity, and latency for the task complexity.',
  'When cursor/auto appears in the catalogue, prefer a specific named model when clearly suitable; only pick cursor/auto if delegating to Cursor upstream auto-routing is best.',
  'Reply strictly with one JSON object: {"model":"<exact_catalogue_id>"}',
].join('\n');

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
  const maxTokens = Number(customTokens);
  const hasMax = Number.isFinite(maxTokens) && maxTokens > 0;
  const choices = CONTEXT_OPTIONS.filter(
    ([value]) => !hasMax || parseTokenString(value) <= maxTokens
  );
  if (hasMax) {
    const closeEnough = choices.some(([value]) => {
      const tokens = parseTokenString(value);
      return tokens > 0 && Math.abs(tokens - maxTokens) / maxTokens <= 0.05;
    });
    if (!closeEnough) {
      choices.push([String(maxTokens), formatTokenLabel(maxTokens)]);
    }
  }
  if (choices.length === 0) {
    const fallback = hasMax ? maxTokens : 200000;
    choices.push([String(fallback), formatTokenLabel(fallback)]);
  }
  return choices.sort((left, right) => parseTokenString(left[0]) - parseTokenString(right[0]));
}

function normalizeEfforts(efforts) {
  const seen = new Set(
    (Array.isArray(efforts) ? efforts : [])
      .map(value => String(value || '').toLowerCase())
      .filter(value => value && value !== 'none' && value !== 'default')
  );
  const known = EFFORT_OPTIONS.map(([value]) => value).filter(value => seen.has(value));
  for (const value of seen) {
    if (!known.includes(value)) known.push(value);
  }
  return known;
}

function buildParameterDefinitions(contexts, efforts, fastSupported) {
  const effortValues = efforts.length > 0 ? efforts : ['default'];
  const definitions = [
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
          values: effortValues.map(value => {
            const label = EFFORT_OPTIONS.find(([effort]) => effort === value);
            return {
              value,
              displayName: label ? label[1] : value === 'default' ? 'Default' : value,
            };
          }),
        },
      },
      isCycleableByHotkey: true,
    },
  ];
  if (fastSupported) {
    definitions.push({
      id: 'fast',
      name: 'Fast',
      markdownTooltip: 'Priority service tier, for models that offer it.',
      parameterType: {
        booleanParameter: {
          values: [
            { value: 'false' },
            { value: 'true', displayName: 'Fast', increasesModelCost: true },
          ],
        },
      },
      isCycleableByHotkey: false,
    });
  }
  return definitions;
}

function buildModelVariants(id, displayName, tooltip, contexts, efforts, fastSupported) {
  const effortValues = efforts.length > 0 ? efforts : ['default'];
  const defaultContext = contexts.some(([value]) => value === DEFAULT_CONTEXT)
    ? DEFAULT_CONTEXT
    : contexts[contexts.length - 1][0];
  const defaultEffort = effortValues.includes('high')
    ? 'high'
    : effortValues[effortValues.length - 1];
  const variants = [];
  for (const [contextVal, contextLabel] of contexts) {
    for (const effortVal of effortValues) {
      for (const fast of fastSupported ? [false, true] : [false]) {
        const suffixParts = [];
        if (contextVal !== DEFAULT_CONTEXT) suffixParts.push(contextLabel);
        if (effortVal !== 'default') {
          const effortLabel = EFFORT_OPTIONS.find(([value]) => value === effortVal)?.[1] || effortVal;
          suffixParts.push(effortLabel);
        }
        if (fast) suffixParts.push('Fast');
        const suffix = suffixParts.join(' ');
        const formattedName = suffix
          ? `${displayName} <span style="color: var(--cursor-text-tertiary);">${suffix}</span>`
          : displayName;
        const isDefault = contextVal === defaultContext && effortVal === defaultEffort && !fast;
        const parameterValues = [
          { id: 'context', value: contextVal },
          { id: 'reasoning', value: effortVal },
        ];
        if (fastSupported) parameterValues.push({ id: 'fast', value: String(fast) });
        const fastSuffix = fastSupported ? `,fast=${fast}` : '';
        variants.push({
          parameterValues,
          displayName: formattedName,
          isMaxMode: false,
          isDefaultMaxConfig: isDefault ? true : undefined,
          isDefaultNonMaxConfig: isDefault ? true : undefined,
          tooltipData: tooltip,
          displayNameOutsidePicker: formattedName,
          variantStringRepresentation: `${id}[context=${contextVal},reasoning=${effortVal}${fastSuffix}]`,
          legacySlug: `${id}-${contextVal}-${effortVal}${fast ? '-fast' : ''}`,
        });
      }
    }
  }
  return variants;
}

function toAvailableModel(model, { defaultOn = true } = {}) {
  const displayName = model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id;
  const tooltip = { markdownContent: `Magpie / ${model.id}` };
  const contexts = buildContextChoices(model.context);
  const efforts = normalizeEfforts(model.efforts);
  const fastSupported = Boolean(model.fast);
  const variants = buildModelVariants(
    model.id,
    displayName,
    tooltip,
    contexts,
    efforts,
    fastSupported
  );
  return {
    name: model.id,
    defaultOn: Boolean(defaultOn),
    supportsAgent: true,
    degradationStatus: 0,
    tooltipData: tooltip,
    supportsThinking: efforts.length > 0,
    supportsImages: true,
    supportsMaxMode: fastSupported,
    clientDisplayName: displayName,
    serverModelName: model.id,
    supportsNonMaxMode: true,
    tooltipDataForMaxMode: tooltip,
    isRecommendedForBackgroundComposer: false,
    supportsPlanMode: true,
    inputboxShortModelName: displayName,
    supportsSandboxing: true,
    supportsCmdK: false,
    parameterDefinitions: buildParameterDefinitions(contexts, efforts, fastSupported),
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

function sortedHiddenModels(config) {
  const exposedIds = new Set((config?.models || []).map(item => item.id));
  return (Array.isArray(config?.hiddenModels) ? config.hiddenModels : []).filter(
    entry => entry && typeof entry.id === 'string' && !exposedIds.has(entry.id)
  );
}

function computeCatalogSignature(config) {
  const payload = {
    model: config?.model || '',
    models: (config?.models || []).map(item => ({
      id: item.id,
      name: item.name,
      context: item.context || null,
      efforts: item.efforts || [],
      fast: Boolean(item.fast),
    })),
    hidden: sortedHiddenModels(config).map(item => item.id),
    roles: config?.roles || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function matchCatalogModel(rawId, config) {
  const parsed = parseModelRef(rawId);
  const baseId = parsed.modelId || config.model;
  const allModels = [...config.models, ...sortedHiddenModels(config)];
  const exact = allModels.find(entry => entry.id === baseId);
  if (exact) return { modelId: exact.id, effort: parsed.effort };
  const byLengthDesc = [...allModels].sort((left, right) => right.id.length - left.id.length);
  const legacyMatch = byLengthDesc.find(entry => baseId.startsWith(`${entry.id}-`));
  if (legacyMatch) return { modelId: legacyMatch.id, effort: parsed.effort };
  return { modelId: parsed.modelId || config.model, effort: parsed.effort, matchedCatalog: false };
}

function classifyAgentRunRole(runRequest, headers = {}) {
  const subagentType = String(runRequest.subagentTypeName || '').trim().toLowerCase();
  const harness = String(runRequest.harness || '').trim().toLowerCase();
  const promptText = String(runRequest.customSystemPrompt || '').toLowerCase();
  const combined = `${subagentType} ${harness}`;

  if (
    combined.includes('securitybot') ||
    combined.includes('security_reviewer') ||
    combined.includes('vulnerability_scanner') ||
    combined.includes('secbot') ||
    subagentType === 'security' ||
    promptText.includes('__securitybot_metadata__') ||
    promptText.includes('security_reviewer')
  ) {
    return 'securitybot';
  }

  if (
    combined.includes('bugbot') ||
    combined.includes('bug-bot') ||
    combined.includes('diff_review') ||
    promptText.includes('bug_detection_guidelines') ||
    promptText.includes('local bugbot')
  ) {
    return 'bugbot';
  }

  if (
    combined.includes('memory') ||
    combined.includes('memories') ||
    promptText.includes('<memory_generation>') ||
    promptText.includes('potentiallygeneratememory')
  ) {
    return 'memory';
  }

  if (runRequest.action?.summarizeAction) {
    return 'summarize';
  }

  if (
    Boolean(subagentType) ||
    Boolean(headers['x-parent-request-id']) ||
    Boolean(headers['x-parent-agent-tool-call-id']) ||
    Boolean(headers['x-root-parent-request-id'])
  ) {
    return 'subagent';
  }

  return 'default';
}

/** Extract raw model identifier and optional effort parameters without erasing `default`. */
function parseClientRequestedModel(runRequest) {
  const rawId = String(runRequest.requestedModel?.modelId || runRequest.modelDetails?.modelId || '').trim();
  let baseId = rawId;
  let effort = null;
  let fast = false;
  const bracketMatch = /^(.+?)\[([^\]]+)\]$/.exec(rawId);
  if (bracketMatch) {
    baseId = bracketMatch[1].trim();
    for (const pair of bracketMatch[2].split(',')) {
      const [paramKey, paramVal] = pair.split('=');
      if (paramKey === 'fast') {
        fast = paramVal === 'true' || paramVal === '1';
      }
      if (
        (paramKey === 'effort' || paramKey === 'reasoning') &&
        paramVal &&
        paramVal !== 'none' &&
        paramVal !== 'default'
      ) {
        effort = paramVal.trim();
      }
    }
  }
  for (const param of runRequest.requestedModel?.parameters || []) {
    if (param.id === 'fast') {
      fast = param.value === 'true' || param.value === true;
    }
    if (
      (param.id === 'effort' || param.id === 'reasoning') &&
      param.value &&
      param.value !== 'none' &&
      param.value !== 'default'
    ) {
      effort = param.value.trim();
    }
  }
  return { rawId, baseId, effort, fast };
}

/** Return `true` only for Cursor native Auto sentinels (`default`, `auto`, `auto-*`) not shadowed by an exact catalog ID. */
export function isCursorNativeAuto(baseId, config) {
  const clean = String(baseId || '').trim().toLowerCase();
  if (!clean || !NATIVE_AUTO_EFFORTS.has(clean)) return false;
  const models = Array.isArray(config?.models) ? config.models : [];
  return !models.some(entry => typeof entry?.id === 'string' && entry.id.trim().toLowerCase() === clean);
}

function createScopedAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timer = null;
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason || new Error('Cancelled'));
  };
  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Auto routing timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

function matchCandidateModel(candidateText, candidateModels) {
  if (typeof candidateText !== 'string') return null;
  const cleaned = candidateText
    .replace(/[\r\n\0`"'<>]/g, '')
    .replace(/\[[^\]]*\]$/, '')
    .trim();
  if (!cleaned) return null;
  const exact = candidateModels.find(entry => entry.id === cleaned);
  if (exact) return exact.id;
  const lower = cleaned.toLowerCase();
  const caseInsensitive = candidateModels.find(entry => entry.id.toLowerCase() === lower);
  if (caseInsensitive) return caseInsensitive.id;
  const nameMatches = candidateModels.filter(
    entry => typeof entry.name === 'string' && entry.name.trim().toLowerCase() === lower
  );
  return nameMatches.length === 1 ? nameMatches[0].id : null;
}

/** Parse a router completion reply (JSON or plain text) into a validated catalogue model ID. */
export function parseRoutedModelReply(replyText, candidateModels = []) {
  const models = Array.isArray(candidateModels) ? candidateModels.filter(entry => entry && entry.id) : [];
  if (models.length === 0) return null;
  const stripped = String(replyText || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!stripped) return null;

  const jsonCandidates = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(stripped)) !== null) {
    jsonCandidates.push(fenceMatch[1].trim());
  }
  const braceMatches = stripped.match(/\{[\s\S]*?\}/g) || [];
  jsonCandidates.push(stripped, ...braceMatches);

  for (const snippet of jsonCandidates) {
    if (!snippet.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(snippet);
      if (!parsed || typeof parsed !== 'object') continue;
      for (const fieldName of ['model', 'modelId', 'model_id', 'selectedModel', 'selected_model', 'id']) {
        const matched = matchCandidateModel(parsed[fieldName], models);
        if (matched) return matched;
      }
    } catch {
      // Continue to plain-text fallback matching.
    }
  }

  const byLengthDesc = [...models].sort((left, right) => right.id.length - left.id.length);
  for (const entry of byLengthDesc) {
    const escaped = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryPattern = new RegExp(`(^|[\\s"'\`:,(\\[{])${escaped}($|[\\s"'\`.,)\\]};!?])`, 'i');
    if (boundaryPattern.test(stripped)) {
      return entry.id;
    }
  }
  return null;
}

function truncateMiddle(text, maxLen) {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.42);
  const tailLen = maxLen - headLen - 24;
  return `${text.slice(0, headLen)}\n... [truncated] ...\n${text.slice(-tailLen)}`;
}

function summarizeTaskForAutoRouter(runRequest, messages, tools) {
  const nonSystem = (messages || []).filter(msg => msg && msg.role !== 'system');
  const recent = nonSystem.slice(-4);
  const snippets = recent.map((msg, idx) => {
    const maxLen = idx === recent.length - 1 ? 3500 : 600;
    const text = typeof msg.content === 'string' ? msg.content.trim() : '';
    return text ? `[${msg.role}] ${truncateMiddle(text, maxLen)}` : '';
  });
  const totalChars = nonSystem.reduce(
    (sum, msg) => sum + (typeof msg.content === 'string' ? msg.content.length : 0),
    0
  );
  const hints = [];
  if (runRequest.subagentTypeName) hints.push(`subagent=${runRequest.subagentTypeName}`);
  if (runRequest.action?.executePlanAction) hints.push('action=execute_plan');
  if (Array.isArray(tools) && tools.length > 0) hints.push(`tools=${tools.length}`);
  hints.push(`messages=${nonSystem.length}`);
  hints.push(`approx_chars=${totalChars}`);
  return {
    meta: hints.join(', '),
    excerpt: snippets.filter(Boolean).join('\n\n'),
  };
}

async function selectModelViaAutoRouter({
  config,
  routerModelId,
  routerEffort,
  fallbackModelId,
  fallbackEffort,
  runRequest,
  messages,
  tools,
  signal,
}) {
  const taskSummary = summarizeTaskForAutoRouter(runRequest, messages, tools);
  if (!taskSummary.excerpt) return null;

  const catalogueLines = config.models.map(entry => {
    const parts = [`- ${entry.id}`];
    if (entry.name && entry.name !== entry.id) parts.push(`name: ${entry.name}`);
    if (entry.context) parts.push(`context: ${entry.context}`);
    if (isCursorAutoModelId(entry.id)) parts.push('note: Cursor upstream auto router');
    return parts.join(' | ');
  });

  const routerPrompt = [
    'Available Magpie models:',
    ...catalogueLines,
    '',
    `Task metadata: ${taskSummary.meta}`,
    'Recent request:',
    taskSummary.excerpt,
  ].join('\n');

  const candidates = [{ modelId: routerModelId, effort: routerEffort }];
  if (fallbackModelId && fallbackModelId !== routerModelId) {
    candidates.push({ modelId: fallbackModelId, effort: fallbackEffort });
  }
  for (const candidate of candidates) {
    const scoped = createScopedAbortSignal(signal, AUTO_ROUTER_TIMEOUT_MS);
    try {
      const reply = await completeOpenAiText({
        config,
        modelId: candidate.modelId,
        messages: [
          { role: 'system', content: AUTO_ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: routerPrompt },
        ],
        reasoningEffort: candidate.effort,
        signal: scoped.signal,
      });
      const routedId = parseRoutedModelReply(reply, config.models);
      if (routedId) return routedId;
    } catch (err) {
      if (signal?.aborted) throw err;
    } finally {
      scoped.cleanup();
    }
  }
  return null;
}

/** Resolve final execution model and effort, enforcing single-hop Auto routing and cursor/auto isolation. */
function serviceTierFor(modelId, config, fastRequested) {
  if (!fastRequested) return null;
  const entry = (config.models || []).find(model => model.id === modelId);
  return entry?.fast ? 'priority' : null;
}

async function resolveExecutionModel({ runRequest, messages, tools, config, headers = {}, signal }) {
  const clientReq = parseClientRequestedModel(runRequest);
  const impliedAutoEffort = NATIVE_AUTO_EFFORTS.get(clientReq.baseId.toLowerCase()) || null;
  const effectiveEffort = clientReq.effort || impliedAutoEffort;
  const role = classifyAgentRunRole(runRequest, headers);

  if (role !== 'default') {
    const resolvedRole = resolveRoleModel(config, role, {
      subagentType: runRequest.subagentTypeName || '',
      fallbackModel: config.model,
    });
    if (resolvedRole.role !== 'default' && resolvedRole.modelId) {
      const catalogHit = matchCatalogModel(resolvedRole.modelId, config);
      const finalId = catalogHit.matchedCatalog === false ? resolvedRole.modelId : catalogHit.modelId;
      return {
        modelId: finalId,
        effort: resolvedRole.effort || effectiveEffort,
        routedByAuto: false,
        serviceTier: serviceTierFor(finalId, config, clientReq.fast),
      };
    }
  }

  if (role !== 'summarize' && isCursorNativeAuto(clientReq.baseId, config)) {
    const routerCfg = resolveAutoRouterConfig(config);
    if (routerCfg.modelId && config.models.length > 1) {
      const routedId = await selectModelViaAutoRouter({
        config,
        routerModelId: routerCfg.modelId,
        routerEffort: routerCfg.effort,
        fallbackModelId: routerCfg.fallbackModelId,
        fallbackEffort: routerCfg.fallbackEffort,
        runRequest,
        messages,
        tools,
        signal,
      });
      if (routedId) {
        return {
          modelId: routedId,
          effort: effectiveEffort,
          routedByAuto: true,
          serviceTier: serviceTierFor(routedId, config, clientReq.fast),
        };
      }
    }
    const fallbackId = config.models.length === 1 ? config.models[0].id : config.model;
    return {
      modelId: fallbackId,
      effort: effectiveEffort,
      routedByAuto: true,
      serviceTier: serviceTierFor(fallbackId, config, clientReq.fast),
    };
  }

  const catalogMatch = matchCatalogModel(clientReq.rawId, config);
  if (catalogMatch.matchedCatalog !== false) {
    return {
      modelId: catalogMatch.modelId,
      effort: effectiveEffort,
      routedByAuto: false,
      serviceTier: serviceTierFor(catalogMatch.modelId, config, clientReq.fast),
    };
  }
  return {
    modelId: config.model,
    effort: effectiveEffort,
    routedByAuto: false,
    serviceTier: serviceTierFor(config.model, config, clientReq.fast),
  };
}

function buildSubagentModelConfigs(config) {
  const roles = config?.roles;
  if (!roles) return undefined;
  const configs = {};
  if (roles.subagent) {
    const defaultSub = parseModelRef(roles.subagent).modelId;
    if (defaultSub) {
      for (const defaultKey of ['explore', 'generalPurpose', 'shell']) {
        configs[defaultKey] = { defaultModel: defaultSub, fallbackModels: [], bestOfNDefaultModels: [] };
      }
    }
  }
  for (const [typeName, modelRef] of Object.entries(roles.subagentTypes || {})) {
    const cleanId = parseModelRef(modelRef).modelId;
    if (cleanId) {
      configs[typeName] = { defaultModel: cleanId, fallbackModels: [], bestOfNDefaultModels: [] };
    }
  }
  return Object.keys(configs).length > 0 ? configs : undefined;
}

function formatConversationMessages(conversation = [], limit = 24) {
  return (conversation || [])
    .slice(-limit)
    .map(item => {
      const roleLabel = item.type === 2 ? 'Assistant' : 'User';
      const text = String(item.text || '').trim();
      return text ? `${roleLabel}: ${text.slice(0, 4000)}` : '';
    })
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 36000);
}

function formatGitDiffPrompt(gitDiff, contextFiles = []) {
  const diffBlocks = (gitDiff?.diffs || []).slice(0, 12).map(fileDiff => {
    const filePath = fileDiff.to || fileDiff.from || 'unknown';
    const chunksText = (fileDiff.chunks || [])
      .slice(0, 8)
      .map(chunk => chunk.content || (chunk.lines || []).join('\n'))
      .join('\n');
    return `File: ${filePath}\n${chunksText}`.slice(0, 6000);
  });
  const ctxBlocks = (contextFiles || [])
    .slice(0, 6)
    .map(block => `Context ${block.relativeWorkspacePath}:\n${(block.contents || block.fileContents || '').slice(0, 3000)}`);
  return [...diffBlocks, ...ctxBlocks].join('\n\n---\n\n').slice(0, 42000);
}

function blobKey(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function normalizeContextPath(filePath) {
  return String(filePath || '').trim().replace(/\\/g, '/');
}

function isSkillRulePath(filePath) {
  const normalized = normalizeContextPath(filePath);
  return /(?:^|\/)SKILL\.md$/i.test(normalized);
}

function isSkillOrPluginPath(filePath) {
  const normalized = normalizeContextPath(filePath);
  return (
    isSkillRulePath(normalized) ||
    /(?:^|\/)\.(?:cursor|agents|claude|codex|grok)\/skills(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.cursor\/skills-cursor(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.claude\/plugins(?:\/|$)/i.test(normalized) ||
    /(?:^|\/)\.cursor\/plugins\/cache\/.*\/skills(?:\/|$)/i.test(normalized)
  );
}

function isEnvironmentEnabled(item) {
  if (!item) return false;
  const disabled = Array.isArray(item.disabledEnvironments) ? item.disabledEnvironments : [];
  if (disabled.includes('local')) return false;
  const envs = Array.isArray(item.environments) ? item.environments : [];
  if (envs.length > 0 && !envs.includes('local')) return false;
  return true;
}

function parseFrontmatter(content) {
  if (typeof content !== 'string' || !content) return '';
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  return fmMatch ? fmMatch[1] : '';
}

function hasDisableModelInvocation(skill) {
  if (!skill) return true;
  if (skill.disableModelInvocation) return true;
  const fm = skill.frontmatter || parseFrontmatter(skill.content);
  return Boolean(fm && /^disable-model-invocation:\s*(true|yes)\s*$/im.test(fm));
}

function extractSkillDescription(skill) {
  if (skill?.description && String(skill.description).trim()) {
    return compactText(skill.description, MAX_SKILL_DESC_CHARS);
  }
  const fm = skill?.frontmatter || parseFrontmatter(skill?.content);
  if (fm) {
    const descMatch = /^description:\s*["']?([^\r\n]+?)["']?\s*$/m.exec(fm);
    if (descMatch && !['|', '>', '|-', '>-'].includes(descMatch[1].trim())) {
      return compactText(descMatch[1], MAX_SKILL_DESC_CHARS);
    }
  }
  return '';
}

function rulePackageRoot(filePath) {
  const norm = normalizeContextPath(filePath).replace(/\/+$/, '');
  const lastSlash = norm.lastIndexOf('/');
  const dir = lastSlash > 0 ? norm.slice(0, lastSlash) : lastSlash === 0 ? '/' : '';
  if (!dir) return '';
  const parts = dir.split('/');
  for (let idx = parts.length - 2; idx >= 0; idx -= 1) {
    if (parts[idx] === '.cursor' && parts[idx + 1] === 'rules') {
      const prefix = parts.slice(0, idx).join('/');
      return prefix || (dir.startsWith('/') ? '/' : '');
    }
  }
  return dir;
}

function isNestedWorkspaceRule(filePath, workspacePaths = []) {
  const pkgRoot = rulePackageRoot(filePath);
  if (!pkgRoot || !Array.isArray(workspacePaths) || workspacePaths.length === 0) return false;
  for (const ws of workspacePaths) {
    const wsNorm = normalizeContextPath(ws).replace(/\/+$/, '');
    if (!wsNorm) continue;
    if (pkgRoot === wsNorm) return false;
    if (pkgRoot.startsWith(`${wsNorm}/`)) return true;
  }
  return false;
}

function boundSectionText(text, maxChars, suffix = '… [truncated]') {
  const str = String(text || '');
  if (str.length <= maxChars) return str;
  const keep = Math.max(64, maxChars - suffix.length - 2);
  return `${str.slice(0, keep)}\n${suffix}`;
}

function foldSkillPathRoots(entries) {
  if (entries.length < 4) return { roots: [], items: entries };
  const bucketMap = new Map();
  for (const entry of entries) {
    const norm = normalizeContextPath(entry.fullPath);
    const parts = norm.split('/').filter(Boolean);
    const isSkillMd = parts[parts.length - 1]?.toLowerCase() === 'skill.md';
    const dropCount = isSkillMd ? 2 : 1;
    if (parts.length <= dropCount + 1) continue;
    const rootDir = (norm.startsWith('/') ? '/' : '') + parts.slice(0, parts.length - dropCount).join('/');
    const list = bucketMap.get(rootDir) || [];
    list.push(entry);
    bucketMap.set(rootDir, list);
  }
  const roots = [];
  const aliasByEntry = new Map();
  for (const [rootDir, group] of bucketMap.entries()) {
    if (group.length < 2) continue;
    const alias = `$${roots.length}`;
    const savings = group.length * (rootDir.length - alias.length) - `${alias} = ${rootDir}\n`.length;
    if (savings > 100) {
      roots.push(`${alias} = ${rootDir}`);
      for (const item of group) {
        const norm = normalizeContextPath(item.fullPath);
        aliasByEntry.set(item, `${alias}${norm.slice(rootDir.length)}`);
      }
    }
  }
  if (roots.length === 0) return { roots: [], items: entries };
  return {
    roots,
    items: entries.map(item => ({
      ...item,
      displayPath: aliasByEntry.get(item) || item.fullPath,
    })),
  };
}

function formatBoundedCatalog(lines, { header, omittedNoun, maxChars }) {
  if (lines.length === 0) return '';
  const kept = [];
  let usedChars = header.length + 1;
  for (const line of lines) {
    const addition = line.length + 1;
    if (kept.length > 0 && usedChars + addition > maxChars) {
      break;
    }
    kept.push(line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line);
    usedChars += addition;
  }
  const omittedCount = lines.length - kept.length;
  const parts = [header, ...kept];
  if (omittedCount > 0) {
    parts.push(`... (${omittedCount} additional ${omittedNoun} omitted for brevity)`);
  }
  return parts.join('\n');
}

function extractRequestableHint(rule) {
  if (rule.type?.agentFetched?.description) {
    return compactText(rule.type.agentFetched.description, MAX_REQUESTABLE_RULE_DESC_CHARS);
  }
  const desc = extractSkillDescription(rule);
  if (rule.type?.fileGlobbed) {
    const globsText = `globs: ${(rule.type.fileGlobbed.globs || []).join(', ')}`;
    return desc ? `${desc} (${globsText})` : globsText;
  }
  if (rule.type?.global) {
    const scopeRoot = rulePackageRoot(rule.fullPath);
    const scopeText = scopeRoot ? `applicable for files within ${scopeRoot}` : '';
    if (desc && scopeText) return `${desc} (${scopeText})`;
    return desc || scopeText;
  }
  if (desc) return desc;
  const scopeRoot = rulePackageRoot(rule.fullPath);
  return scopeRoot ? `applicable for files within ${scopeRoot}` : '';
}

function resolveContextBudgets(contextTokens = 200_000) {
  const tokens = Math.max(16_000, Number(contextTokens) || 200_000);
  return {
    skillCatalogChars: Math.max(2_000, Math.min(16_000, Math.floor(tokens * 0.02 * 3.5))),
    requestableRulesChars: Math.max(2_000, Math.min(12_000, Math.floor(tokens * 0.015 * 3.5))),
    alwaysRulesChars: Math.max(4_000, Math.min(24_000, Math.floor(tokens * 0.035 * 3.5))),
    userRulesChars: Math.max(1_500, Math.min(8_000, Math.floor(tokens * 0.01 * 3.5))),
    mcpInstructionsChars: 4_000,
  };
}

function appendBoundedRuleEntries(systemParts, entries, maxChars, prefixLabel = 'Rule') {
  if (!entries.length) return [];
  const includedBodies = [];
  let usedChars = 0;
  let omittedCount = 0;
  for (const entry of entries) {
    const body = boundSectionText(entry.content, MAX_SINGLE_RULE_CHARS);
    const block = `[${prefixLabel}: ${entry.fullPath || 'inline'}]\n${body}`;
    if (includedBodies.length > 0 && usedChars + block.length + 2 > maxChars) {
      omittedCount += 1;
      continue;
    }
    const boundedBlock = block.length > maxChars ? boundSectionText(block, maxChars) : block;
    systemParts.push(boundedBlock);
    includedBodies.push(String(entry.content || '').trim());
    usedChars += boundedBlock.length + 2;
  }
  if (omittedCount > 0) {
    systemParts.push(`... (${omittedCount} additional ${prefixLabel.toLowerCase()} entries omitted to preserve context budget)`);
  }
  return includedBodies;
}

function appendContextSections(
  systemParts,
  requestContext,
  { contextTokens = 200_000, mcpCatalogPrompt = '', excludeWorkspaceContext = false } = {}
) {
  const budgets = resolveContextBudgets(contextTokens);
  const workspacePaths = requestContext.env?.workspacePaths || [];
  const gitRepoPaths = (requestContext.gitRepos || []).map(repo => repo?.path).filter(Boolean);
  const rootPaths = [...new Set([...workspacePaths, ...gitRepoPaths])];
  const disabledTeamRules = new Set(
    (requestContext.disabledTeamRules || []).map(item => normalizeContextPath(item))
  );

  const seenRulePaths = new Set();
  const requestableRuleLines = [];
  const alwaysAppliedEntries = [];
  const userRuleEntries = [];
  const extraSkillCandidates = [];

  for (const rule of [...(requestContext.rules || []), ...(requestContext.nonFileRules || [])]) {
    if (!rule || !isEnvironmentEnabled(rule)) continue;
    const normPath = normalizeContextPath(rule.fullPath);
    if (normPath) {
      if (disabledTeamRules.has(normPath)) continue;
      if (seenRulePaths.has(normPath)) continue;
      seenRulePaths.add(normPath);
    }
    if (rule.type?.manuallyAttached) continue;

    if (isSkillOrPluginPath(rule.fullPath)) {
      if (rule.type?.global && !isNestedWorkspaceRule(rule.fullPath, rootPaths)) {
        if (!rule.bodyOmitted && rule.content) {
          alwaysAppliedEntries.push(rule);
        }
      } else if (isSkillRulePath(rule.fullPath)) {
        extraSkillCandidates.push({
          fullPath: rule.fullPath,
          description: rule.type?.agentFetched?.description || '',
          content: rule.content,
          frontmatter: rule.frontmatter,
          environments: rule.environments,
          disabledEnvironments: rule.disabledEnvironments,
        });
      } else if (rule.type?.agentFetched || rule.type?.fileGlobbed) {
        const hint = extractRequestableHint(rule);
        requestableRuleLines.push(`- ${rule.fullPath}${hint ? `: ${hint}` : ''}`);
      }
      continue;
    }

    if (rule.source === 1) {
      if (!rule.bodyOmitted && rule.content) userRuleEntries.push(rule);
      continue;
    }

    if (rule.source === 2) {
      if (rule.type?.fileGlobbed) {
        const hint = extractRequestableHint(rule);
        requestableRuleLines.push(`- ${rule.fullPath}${hint ? `: ${hint}` : ''}`);
      } else if (!rule.bodyOmitted && rule.content) {
        alwaysAppliedEntries.push(rule);
      }
      continue;
    }

    if ((rule.type?.agentFetched || rule.type?.fileGlobbed) && rule.source !== 2) {
      const hint = extractRequestableHint(rule);
      requestableRuleLines.push(`- ${rule.fullPath}${hint ? `: ${hint}` : ''}`);
      continue;
    }

    if (isNestedWorkspaceRule(rule.fullPath, rootPaths)) {
      const hint = extractRequestableHint(rule);
      requestableRuleLines.push(`- ${rule.fullPath}${hint ? `: ${hint}` : ''}`);
      continue;
    }

    if (!rule.bodyOmitted && rule.content) {
      alwaysAppliedEntries.push(rule);
    }
  }

  const includedAlways = excludeWorkspaceContext
    ? []
    : appendBoundedRuleEntries(systemParts, alwaysAppliedEntries, budgets.alwaysRulesChars, 'Rule');
  appendBoundedRuleEntries(systemParts, userRuleEntries, budgets.userRulesChars, 'User rule');

  if (requestContext.cloudRule && !excludeWorkspaceContext) {
    const trimmedCloud = String(requestContext.cloudRule).trim();
    let cloudToInclude = trimmedCloud;
    if (includedAlways.some(body => body === trimmedCloud)) {
      cloudToInclude = '';
    } else {
      for (const body of includedAlways) {
        if (body && trimmedCloud.startsWith(body)) {
          const tail = trimmedCloud.slice(body.length).trimStart();
          if (tail.startsWith('## Cursor Cloud specific instructions')) {
            cloudToInclude = tail;
            break;
          }
        }
      }
    }
    if (cloudToInclude) {
      systemParts.push(boundSectionText(cloudToInclude, MAX_SINGLE_RULE_CHARS));
    }
  }

  const rulesCatalog = formatBoundedCatalog(requestableRuleLines, {
    header: 'Available workspace rules (use the Read tool on fullPath when relevant):',
    omittedNoun: 'rules',
    maxChars: budgets.requestableRulesChars,
  });
  if (rulesCatalog) systemParts.push(rulesCatalog);

  const seenSkillPaths = new Set();
  const skillItems = [];
  const descriptorSkills = (requestContext.skillOptions?.skillDescriptors || [])
    .filter(desc => desc && desc.enabled !== false && !desc.parseError)
    .map(desc => ({
      fullPath: desc.readmeFilePath || desc.folderPath || desc.name,
      description: desc.description || '',
      disableModelInvocation: false,
    }));

  for (const skill of [
    ...(requestContext.agentSkills || []),
    ...descriptorSkills,
    ...extraSkillCandidates,
  ]) {
    if (!skill || !isEnvironmentEnabled(skill) || hasDisableModelInvocation(skill)) continue;
    const rawPath = skill.fullPath || 'unknown-skill';
    const normPath = normalizeContextPath(rawPath);
    if (normPath) {
      if (seenSkillPaths.has(normPath)) continue;
      seenSkillPaths.add(normPath);
    }
    skillItems.push({
      fullPath: rawPath,
      displayPath: rawPath,
      description: extractSkillDescription(skill),
    });
  }

  const rawSkillLines = skillItems.map(
    item => `- ${item.displayPath}${item.description ? `: ${item.description}` : ''}`
  );
  const rawEstimatedChars = rawSkillLines.reduce((acc, line) => acc + line.length + 1, 120);
  const folded =
    skillItems.length > 25 || rawEstimatedChars > budgets.skillCatalogChars
      ? foldSkillPathRoots(skillItems)
      : { roots: [], items: skillItems };
  const skillLines = folded.items.map(
    item => `- ${item.displayPath}${item.description ? `: ${item.description}` : ''}`
  );
  const skillHeader = [
    'Available skills (metadata only — use the Read tool on fullPath when relevant to read full instructions):',
    ...(folded.roots.length > 0 ? [`Path prefixes:\n${folded.roots.join('\n')}`] : []),
  ].join('\n');

  const skillsCatalog = formatBoundedCatalog(skillLines, {
    header: skillHeader,
    omittedNoun: 'skills',
    maxChars: budgets.skillCatalogChars,
  });
  if (skillsCatalog) systemParts.push(skillsCatalog);

  if (mcpCatalogPrompt) {
    systemParts.push(mcpCatalogPrompt);
  } else if (requestContext.mcpInstructions?.length) {
    const instLines = [];
    let usedInstChars = 0;
    for (const inst of requestContext.mcpInstructions) {
      const text = String(inst?.instructions || '').trim();
      if (!text) continue;
      const entry = `[MCP Server: ${inst.serverName || inst.serverIdentifier || 'mcp'}]\n${boundSectionText(text, 1200)}`;
      if (instLines.length > 0 && usedInstChars + entry.length + 2 > budgets.mcpInstructionsChars) break;
      instLines.push(entry);
      usedInstChars += entry.length + 2;
    }
    if (instLines.length > 0) systemParts.push(instLines.join('\n\n'));
  }

  if (requestContext.hooksAdditionalContext) {
    systemParts.push(boundSectionText(requestContext.hooksAdditionalContext, 4_000));
  }
  if (requestContext.userIntentSummary) {
    systemParts.push(`User profile/preferences:\n${boundSectionText(requestContext.userIntentSummary, 2_000)}`);
  }
}

function formatUserMessageContent(userMessage, blobs = null) {
  if (!userMessage) return '';
  const ctxChunks = [];
  let usedCtxChars = 0;
  const pushCtx = chunk => {
    if (!chunk || usedCtxChars >= MAX_SELECTED_CONTEXT_CHARS) return;
    const remaining = MAX_SELECTED_CONTEXT_CHARS - usedCtxChars;
    const bounded = chunk.length > remaining ? boundSectionText(chunk, remaining) : chunk;
    ctxChunks.push(bounded);
    usedCtxChars += bounded.length + 2;
  };

  for (const selRule of userMessage.selectedContext?.cursorRules || []) {
    const rule = selRule?.rule;
    if (rule?.content) {
      pushCtx(`[Attached Rule: ${rule.fullPath || 'rule'}]\n${boundSectionText(rule.content, 8_000)}`);
    }
  }
  for (const file of userMessage.selectedContext?.files || []) {
    const body = boundSectionText(file.content || '', MAX_SELECTED_ITEM_CHARS, '… [truncated; use Read tool for full file]');
    pushCtx(`File ${file.relativePath || file.path}:\n\`\`\`\n${body}\n\`\`\``);
  }
  for (const sel of userMessage.selectedContext?.codeSelections || []) {
    const body = boundSectionText(sel.content || '', MAX_SELECTED_ITEM_CHARS);
    pushCtx(`Selection ${sel.relativePath || sel.path}:\n\`\`\`\n${body}\n\`\`\``);
  }
  for (const extra of userMessage.selectedContext?.extraContext || []) {
    pushCtx(boundSectionText(extra, MAX_SELECTED_ITEM_CHARS));
  }
  for (const entry of userMessage.selectedContext?.extraContextEntries || []) {
    if (entry?.data) {
      pushCtx(boundSectionText(entry.data, MAX_SELECTED_ITEM_CHARS));
    } else if (entry?.blobId?.length && blobs) {
      const raw = blobs.get(blobKey(entry.blobId));
      if (raw) pushCtx(boundSectionText(Buffer.from(raw).toString('utf8'), MAX_SELECTED_ITEM_CHARS));
    }
  }

  let mainText = userMessage.text || '';
  if (!mainText && userMessage.textBlobId?.length && blobs) {
    const raw = blobs.get(blobKey(userMessage.textBlobId));
    if (raw) mainText = Buffer.from(raw).toString('utf8');
  }
  return [...ctxChunks, mainText].filter(Boolean).join('\n\n');
}

function estimateMessageChars(msg) {
  if (!msg) return 0;
  let chars = typeof msg.content === 'string' ? msg.content.length : 0;
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      chars += (tc.function?.name?.length || 0) + (tc.function?.arguments?.length || 0) + 32;
    }
  }
  return chars + 16;
}

function groupConversationUnits(nonSystemMessages) {
  const units = [];
  let index = 0;
  while (index < nonSystemMessages.length) {
    const msg = nonSystemMessages[index];
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const unit = [msg];
      index += 1;
      while (index < nonSystemMessages.length && nonSystemMessages[index].role === 'tool') {
        unit.push(nonSystemMessages[index]);
        index += 1;
      }
      units.push(unit);
    } else {
      units.push([msg]);
      index += 1;
    }
  }
  return units;
}

function fitMessagesToContextBudget(messages, tools = [], contextTokens = 200_000) {
  const tokens = Math.max(8_000, Number(contextTokens) || 200_000);
  const reserveOutputTokens = Math.min(16_384, Math.max(2_048, Math.floor(tokens * 0.15)));
  const toolsChars = Array.isArray(tools) && tools.length > 0 ? JSON.stringify(tools).length : 0;
  const totalBudgetChars = Math.max(12_000, Math.floor((tokens - reserveOutputTokens) * 3));
  const maxMessagesChars = Math.max(8_000, totalBudgetChars - toolsChars);

  const measure = list => list.reduce((sum, item) => sum + estimateMessageChars(item), 0);
  if (measure(messages) <= maxMessagesChars) return messages;

  const hasSystem = messages[0]?.role === 'system';
  const working = messages.map(msg => ({ ...msg }));
  const nonSystemStart = hasSystem ? 1 : 0;
  const units = groupConversationUnits(working.slice(nonSystemStart));
  if (units.length === 0) {
    if (hasSystem && working[0].content) {
      working[0].content = boundSectionText(working[0].content, maxMessagesChars);
    }
    return working;
  }

  // Pass 1: Compact oversized older tool outputs and attachments while keeping the latest unit intact.
  for (let u = 0; u < units.length - 1; u += 1) {
    for (const item of units[u]) {
      if (item.role === 'tool' && typeof item.content === 'string' && item.content.length > 1_500) {
        item.content = boundSectionText(item.content, 1_500, '… [older tool output compacted]');
      } else if (item.role === 'user' && typeof item.content === 'string' && item.content.length > 4_000) {
        item.content = boundSectionText(item.content, 4_000, '… [older message compacted]');
      }
    }
  }

  const rebuild = keptUnits => (hasSystem ? [working[0], ...keptUnits.flat()] : keptUnits.flat());
  let current = rebuild(units);
  if (measure(current) <= maxMessagesChars) return current;

  // Pass 2: Drop oldest conversation units until we fit within budget, always keeping the latest unit.
  let dropCount = 0;
  const kept = [...units];
  while (kept.length > 1 && measure(rebuild(kept)) > maxMessagesChars) {
    kept.shift();
    dropCount += 1;
  }
  if (dropCount > 0) {
    const marker = {
      role: 'user',
      content: `[${dropCount} earlier conversation turn(s) omitted to fit context budget]`,
    };
    const withMarker = hasSystem ? [working[0], marker, ...kept.flat()] : [marker, ...kept.flat()];
    current = measure(withMarker) <= maxMessagesChars ? withMarker : rebuild(kept);
  } else {
    current = rebuild(kept);
  }

  // Pass 3: If system + latest unit still exceeds budget, bound system message and older parts of latest unit.
  if (measure(current) > maxMessagesChars && hasSystem && typeof current[0].content === 'string') {
    const nonSysChars = measure(current.slice(1));
    const allowedSysChars = Math.max(2_000, maxMessagesChars - nonSysChars);
    if (current[0].content.length > allowedSysChars) {
      current[0].content = boundSectionText(current[0].content, allowedSysChars);
    }
  }
  return current;
}

/**
 * Clean-room stateful Cursor RPC & bidirectional Agent runtime.
 * All state (blobs, sessions, active runs) is strictly ephemeral in memory.
 */
export class CursorBridgeEngine {
  constructor(initialConfig) {
    this.config = initialConfig;
    this.sessions = new Map();
    this.inferenceSessions = new Map();
    this.catalogVersionTimestamp = Number(initialConfig?.catalogUpdatedAt) || Date.now();
    this.catalogRevisionHash = computeCatalogSignature(initialConfig);
  }

  updateConfig(nextConfig) {
    const nextHash = computeCatalogSignature(nextConfig);
    if (nextHash !== this.catalogRevisionHash) {
      this.catalogRevisionHash = nextHash;
      this.catalogVersionTimestamp = Math.max(
        Date.now(),
        Number(nextConfig?.catalogUpdatedAt) || 0,
        this.catalogVersionTimestamp + 1
      );
    }
    this.config = nextConfig;
  }

  buildAvailableModelsResponse(framed = false) {
    const exposed = sortedModels(this.config);
    const hidden = sortedHiddenModels(this.config);
    const hiddenIds = new Set(hidden.map(item => item.id));
    const list = [...exposed, ...hidden];
    const subagentModelConfigs = buildSubagentModelConfigs(this.config);
    const payload = encodeCursor('AvailableModelsAddition', {
      modelNames: list.map(item => item.id),
      models: list.map(item => toAvailableModel(item, { defaultOn: !hiddenIds.has(item.id) })),
      ...(subagentModelConfigs ? { subagentModelConfigs } : {}),
      displayConfiguration: {
        routedModelViewConfig: {
          routedModelViewToNamedViewToggle: {
            titleMarkdown: 'Auto',
            subtitle: 'Balanced quality and speed, recommended for most tasks',
            setToLastNamedModel: true,
          },
          hideSearchBar: false,
        },
        namedModelsViewConfig: {
          namedViewToRoutedModelViewToggle: {
            markdown: 'Auto',
          },
        },
      },
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildUsableModelsResponse(framed = false) {
    const list = sortedModels(this.config);
    const models = list.map(toModelDetails);
    const hasNativeAuto = models.some(
      item => item.modelId === 'default' || item.modelId === 'auto' || item.displayModelId === 'auto'
    );
    if (!hasNativeAuto) {
      models.push({
        modelId: 'default',
        displayModelId: 'auto',
        displayName: 'Auto',
        displayNameShort: 'Auto',
        thinkingDetails: {},
      });
    }
    const payload = encodeCursor('UsableModelsAddition', { models });
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
    const exposedIds = sortedModels(this.config).map(item => item.id);
    const hidden = sortedHiddenModels(this.config);
    const payload = encodeCursor('DefaultModelNudgeDataResponse', {
      nudgeDate: hidden.length > 0 ? String(this.catalogVersionTimestamp) : '0',
      shouldDefaultSwitchOnNewChat: true,
      modelsWithNoDefaultSwitch: ['default', ...exposedIds],
      conversionModelOverride: '',
    });
    return framed ? encodeConnectFrame(payload) : payload;
  }

  buildServerConfigResponse() {
    return encodeCursor('ServerConfigResponse', {
      chatConfig: {
        clientStatsigPollIntervalMs: 30_000,
      },
      configVersion: 'magpie_cursor_bridge_v1',
      http2Config: 1,
      cliSandboxDefaultEnabled: true,
    });
  }

  buildStatsigBootstrapResponse(headers = {}) {
    const generatedAtMs = Date.now();
    const enabledGate = name => ({
      name,
      value: true,
      rule_id: 'local_bridge',
      secondary_exposures: [],
    });
    let userId = 'local_bridge';
    const authHeader = String(headers?.authorization || '');
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (bearerMatch) {
      const parts = bearerMatch[1].trim().split('.');
      if (parts.length >= 2) {
        try {
          const jwtPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (typeof jwtPayload?.sub === 'string' && jwtPayload.sub.trim()) {
            userId = jwtPayload.sub.trim();
          }
        } catch {
          // Fallback to local_bridge when Authorization is not a JWT.
        }
      }
    }
    const configJson = JSON.stringify({
      feature_gates: {
        cursor_agent_host: enabledGate('cursor_agent_host'),
        agent_host_local_loop: enabledGate('agent_host_local_loop'),
        meta_mcp_tool: enabledGate('meta_mcp_tool'),
        mcp_meta_tool_slim_descriptors: {
          name: 'mcp_meta_tool_slim_descriptors',
          value: false,
          rule_id: 'local_bridge',
          secondary_exposures: [],
        },
      },
      dynamic_configs: {
        magpie_catalog: {
          name: 'magpie_catalog',
          value: { rev: this.catalogRevisionHash },
          rule_id: 'local_bridge',
          secondary_exposures: [],
        },
      },
      layer_configs: {},
      user: { userID: userId, customIDs: { localUserID: 'local_bridge' } },
      has_updates: true,
      hash_used: 'none',
      sdkParams: { stableID: userId, disableDiagnosticsLogging: true },
      time: generatedAtMs,
    });
    return encodeCursor('BootstrapStatsigResponse', { config: configJson, generatedAtMs });
  }

  buildGetTeamsResponse({ isJson = false, enabled = false } = {}) {
    if (isJson) {
      return buildGetTeamsJson({ enabled });
    }
    return encodeCursor('GetTeamsResponse', buildGetTeamsData({ enabled }));
  }

  handleStartRunInferenceImagePrecaption() {
    return encodeCursor('StartRunInferenceImagePrecaptionResponse', {
      outcome: 4,
      contentSha256: '',
    });
  }

  async runAuxCompletion(roleName, systemPrompt, userPrompt, timeoutMs = 90_000) {
    const selected = resolveRoleModel(this.config, roleName);
    return completeOpenAiText({
      config: this.config,
      modelId: selected.modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      reasoningEffort: selected.effort,
      signal: AbortSignal.timeout(timeoutMs),
    });
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

    const text = await this.runAuxCompletion(
      'commit',
      'You write concise git commit messages. Return only the commit message text without markdown fences.',
      promptParts.join('\n'),
      120_000
    );
    const cleaned = text.replace(/^```[^\n]*\n?|\n?```$/g, '').trim();
    return encodeCursor('WriteGitCommitMessageResponse', { commitMessage: cleaned });
  }

  async handleWriteGitBranchName(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('WriteGitBranchNameRequest', payload);
    const promptParts = [`Suggest a short kebab-case git branch name (no spaces or markdown):\n\n${String(req.diffs || '').slice(0, 24000)}`];
    if (req.context) promptParts.push(`\nContext:\n${req.context.slice(0, 4000)}`);
    const text = await this.runAuxCompletion(
      'title',
      'Generate one short kebab-case git branch name only. Return plain text without quotes or markdown.',
      promptParts.join('\n')
    );
    const cleaned = text.replace(/[`'"\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'feat/update';
    return encodeCursor('WriteGitBranchNameResponse', { branchName: cleaned });
  }

  async handleNameAgent(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('NameAgentRequest', payload);
    const userMessage = String(req.userMessage || '').trim().slice(0, 6000);
    if (!userMessage) {
      return encodeCursor('NameAgentResponse', { name: 'New Chat' });
    }
    const text = await this.runAuxCompletion(
      'title',
      'Create a concise 3-6 word title for this coding task. Return only the plain title without quotes or markdown.',
      userMessage
    );
    const cleaned = text.replace(/^["'`#*\s]+|["'`\s]+$/g, '').split('\n')[0].slice(0, 80) || 'Coding Task';
    return encodeCursor('NameAgentResponse', { name: cleaned });
  }

  async handleGetChatTitle(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('GetChatTitleRequest', payload);
    const transcript = formatConversationMessages(req.conversation, 8);
    if (!transcript) {
      return encodeCursor('GetChatTitleResponse', { title: 'New Chat' });
    }
    const text = await this.runAuxCompletion(
      'title',
      'Create a concise 3-6 word chat title summarizing the conversation. Return only the title text without quotes.',
      transcript
    );
    const cleaned = text.replace(/^["'`#*\s]+|["'`\s]+$/g, '').split('\n')[0].slice(0, 80) || 'Chat';
    return encodeCursor('GetChatTitleResponse', { title: cleaned });
  }

  async handleCreateTranscriptOverview(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('CreateTranscriptOverviewRequest', payload);
    const textInput = String(req.formattedConversation || '').trim().slice(0, 36000);
    if (!textInput) {
      return encodeCursor('CreateTranscriptOverviewResponse', { overview: '' });
    }
    const text = await this.runAuxCompletion(
      'summarize',
      'Summarize this coding transcript concisely in plain Markdown.',
      textInput
    );
    return encodeCursor('CreateTranscriptOverviewResponse', { overview: text.trim() });
  }

  async handleGetConversationSummary(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('StreamUnifiedChatRequestLite', payload);
    const transcript = formatConversationMessages(req.conversation, 24);
    if (!transcript) {
      return encodeCursor('ConversationSummary', { summary: '' });
    }
    const text = await this.runAuxCompletion(
      'summarize',
      'Summarize the conversation accurately, preserving key files, decisions, and open tasks.',
      transcript
    );
    return encodeCursor('ConversationSummary', { summary: text.trim() });
  }

  async handlePotentiallyGenerateMemory(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('PotentiallyGenerateMemoryRequest', payload);
    const transcript = formatConversationMessages(req.conversation, 16);
    if (!transcript) {
      return encodeCursor('PotentiallyGenerateMemoryResponse', {});
    }
    const reply = await this.runAuxCompletion(
      'memory',
      'Extract one durable, reusable project or user preference memory from this conversation if clearly warranted. Respond strictly as JSON {"save":boolean,"title":string,"memory":string}.',
      transcript
    );
    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(reply);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : reply);
      if (parsed?.save && parsed.memory) {
        return encodeCursor('PotentiallyGenerateMemoryResponse', {
          savedMemory: String(parsed.memory),
          title: parsed.title ? String(parsed.title) : 'Workspace Memory',
          knowledgeId: crypto.randomUUID(),
        });
      }
    } catch {
      // Ignore non-JSON reply and save no speculative memory.
    }
    return encodeCursor('PotentiallyGenerateMemoryResponse', {});
  }

  async inspectDiffBugs(gitDiff, contextFiles = [], instructions = '', guidelines = '') {
    const diffContent = formatGitDiffPrompt(gitDiff, contextFiles);
    if (!diffContent.trim()) {
      return { bugs: [], summary: 'No diff content provided.' };
    }
    const prompt = [
      instructions ? `Instructions:\n${instructions.slice(0, 4000)}` : '',
      guidelines ? `Guidelines:\n${guidelines.slice(0, 4000)}` : '',
      `Diff and context:\n${diffContent}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const reply = await this.runAuxCompletion(
      'bugbot',
      'Review the diff for concrete bugs, regressions, or security flaws. Reply strictly as JSON {"summary":string,"bugs":[{"file":string,"startLine":number,"endLine":number,"title":string,"description":string,"severity":"low"|"medium"|"high","category":string,"confidence":number,"rationale":string}]}.',
      prompt,
      120_000
    );
    try {
      const jsonMatch = /\{[\s\S]*\}/.exec(reply);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : reply);
      const bugs = Array.isArray(parsed?.bugs)
        ? parsed.bugs.map(bug => ({
            id: crypto.randomUUID(),
            title: String(bug.title || 'Potential issue'),
            description: String(bug.description || bug.title || ''),
            severity: String(bug.severity || 'medium'),
            category: String(bug.category || 'bug'),
            rationale: bug.rationale ? String(bug.rationale) : undefined,
            confidence: Number.isFinite(Number(bug.confidence)) ? Number(bug.confidence) : 0.8,
            modelConfidence: Number.isFinite(Number(bug.confidence)) ? Number(bug.confidence) : 0.8,
            locations: bug.file
              ? [
                  {
                    file: String(bug.file),
                    startLine: Number(bug.startLine) || 1,
                    endLine: Number(bug.endLine) || Number(bug.startLine) || 1,
                    codeLines: [],
                  },
                ]
              : [],
          }))
        : [];
      return { bugs, summary: String(parsed?.summary || '') };
    } catch {
      return { bugs: [], summary: reply.trim().slice(0, 2000) };
    }
  }

  async handleStreamBugBot(rawBody, res) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('StreamBugBotRequest', payload);
    res.write(
      encodeConnectFrame(
        encodeCursor('StreamBugBotResponse', {
          status: { status: 1, message: 'Analyzing diff locally…', iterationsCompleted: 0, totalIterations: 1 },
        })
      )
    );
    try {
      const { bugs, summary } = await this.inspectDiffBugs(
        req.gitDiff,
        req.contextFiles,
        req.userInstructions || '',
        req.bugDetectionGuidelines || ''
      );
      res.write(
        encodeConnectFrame(
          encodeCursor('StreamBugBotResponse', {
            bugReports: { bugReports: bugs },
            status: { status: 3, message: 'Done', iterationsCompleted: 1, totalIterations: 1 },
            summary,
            numTurns: 1,
          })
        )
      );
      res.write(encodeConnectEndStream(null));
      res.end();
    } catch (error) {
      res.write(encodeConnectEndStream({ code: 'internal', message: error?.message || String(error) }));
      res.end();
    }
  }

  async handleStreamBugBotLinter(rawBody) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('StreamBugBotLinterRequest', payload);
    const { bugs } = await this.inspectDiffBugs(
      req.gitDiff,
      [],
      `Focus on ${req.activeFile || 'current file'} around line ${req.cursorLineNumberOneIndexed || 1}`
    );
    return encodeCursor('StreamBugBotLinterResponse', { bugs });
  }

  async handleStreamDiffReview(rawBody, res) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('GetDiffReviewRequest', payload);
    const formatted = (req.diffs || [])
      .slice(0, 12)
      .map(item => {
        const chunksText = (item.chunks || [])
          .map(chunk => [...(chunk.oldLines || []).map(line => `- ${line}`), ...(chunk.newLines || []).map(line => `+ ${line}`)].join('\n'))
          .join('\n');
        return `File: ${item.relativeWorkspacePath}\n${chunksText}`;
      })
      .join('\n\n')
      .slice(0, 36000);
    try {
      const review = formatted.trim()
        ? await this.runAuxCompletion(
            'bugbot',
            'Provide a concise code review highlighting potential bugs and risks in this diff.',
            formatted
          )
        : '';
      if (review) {
        res.write(encodeConnectFrame(encodeCursor('StreamDiffReviewResponse', { text: review })));
      }
      res.write(encodeConnectEndStream(null));
      res.end();
    } catch (error) {
      res.write(encodeConnectEndStream({ code: 'internal', message: error?.message || String(error) }));
      res.end();
    }
  }

  getOrCreateSession(requestId) {
    let session = this.sessions.get(requestId);
    if (!session) {
      session = new AgentSession(requestId, () => this.config, () => this.sessions.delete(requestId));
      this.sessions.set(requestId, session);
    }
    return session;
  }

  getOrCreateInferenceSession(requestId) {
    let session = this.inferenceSessions.get(requestId);
    if (!session) {
      session = new InferenceSession(
        requestId,
        () => this.config,
        () => this.inferenceSessions.delete(requestId)
      );
      this.inferenceSessions.set(requestId, session);
    }
    return session;
  }

  handleRunInferenceStream(req, res, headers = {}) {
    const requestId =
      String(headers['x-request-id'] || headers['x-original-request-id'] || '').trim() ||
      crypto.randomUUID();
    const session = this.getOrCreateInferenceSession(requestId);
    session.attachBidiStreams(req, res);
  }

  handleRunInferenceSse(rawBody, streamResponse) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('BidiRequestId', payload);
    if (!req.requestId) {
      throw new Error('RunInferenceSSE missing request_id');
    }
    const session = this.getOrCreateInferenceSession(req.requestId);
    session.attachStream(streamResponse);
  }

  async handleBidiAppend(rawBody, headers = {}) {
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
    const isInference =
      this.inferenceSessions.has(requestId) ||
      (!this.sessions.has(requestId) && isRunInferenceClientMessageBytes(clientBytes));
    if (isInference) {
      const session = this.getOrCreateInferenceSession(requestId);
      session.acceptAppend(Number(appendReq.appendSeqno || 0), decodeCursor('RunInferenceClientMessage', clientBytes));
      return Buffer.alloc(0);
    }
    const clientMessage = decodeCursor('AgentClientMessage', clientBytes);
    const session = this.getOrCreateSession(requestId);
    session.noteHeaders(headers);
    session.acceptAppend(Number(appendReq.appendSeqno || 0), clientMessage);
    return Buffer.alloc(0);
  }

  handleRunSse(rawBody, streamResponse, headers = {}) {
    const { payload } = decodeUnaryPayload(rawBody);
    const req = decodeCursor('BidiRequestId', payload);
    if (!req.requestId) {
      throw new Error('RunSSE missing request_id');
    }
    const session = this.getOrCreateSession(req.requestId);
    session.noteHeaders(headers);
    session.attachStream(streamResponse);
  }
}

class AgentSession {
  constructor(requestId, getConfig, onDispose) {
    this.requestId = requestId;
    this.getConfig = getConfig;
    this.onDispose = onDispose;
    this.nextSeqno = 0;
    this.headers = {};
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
    this.unattachedTimer = setTimeout(() => {
      if (!this.stream && !this.closed && !this.running) {
        this.closed = true;
        this.abortController.abort();
        this.failAllPending('Unattached session expired');
        this.onDispose();
      }
    }, UNATTACHED_SESSION_TTL_MS);
    this.unattachedTimer.unref?.();
  }

  emit(serverMessage) {
    if (this.closed) return;
    const frame = encodeConnectFrame(encodeCursor('AgentServerMessage', serverMessage));
    if (this.stream) {
      if (!this.stream.destroyed && !this.stream.writableEnded) {
        this.stream.write(frame);
      }
    } else {
      this.outQueue.push(frame);
    }
  }

  noteHeaders(headers = {}) {
    for (const headerName of ['x-parent-request-id', 'x-parent-agent-tool-call-id', 'x-root-parent-request-id']) {
      const headerVal = headers[headerName];
      if (typeof headerVal === 'string' && headerVal.trim()) {
        this.headers[headerName] = headerVal.trim();
      }
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
    this.abortController.abort();
    this.failAllPending('Agent stream ended');
    setTimeout(() => this.onDispose(), 5000).unref?.();
  }

  attachStream(res) {
    this.stream = res;
    clearTimeout(this.unattachedTimer);
    const onTeardown = () => {
      if (!this.closed) {
        this.closed = true;
        clearInterval(this.heartbeatTimer);
        this.abortController.abort();
        this.failAllPending('Client closed RunSSE stream');
        this.onDispose();
      }
    };
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
    const timeoutMs = Number(process.env.CURSOR_BRIDGE_REQUEST_CONTEXT_TIMEOUT_MS) || 3500;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingExec.delete(id);
        this.emit({ execServerControlMessage: { abort: { id } } });
        reject(new Error('RequestContext timed out'));
      }, timeoutMs);
      timer.unref?.();
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
          requestContextArgs: { notesSessionId: conversationId, useCached: true },
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

  resolveTargetContextLimit(runRequest, config, modelId = null) {
    const activeId = modelId || config?.model;
    const catalogEntry = (config?.models || []).find(entry => entry.id === activeId);
    if (catalogEntry?.context) {
      const parsed = parseTokenString(String(catalogEntry.context));
      if (parsed > 0) return parsed;
    }
    const ctxParam = runRequest?.requestedModel?.parameters?.find(p => p.id === 'context')?.value;
    if (ctxParam) {
      const parsed = parseTokenString(ctxParam);
      if (parsed > 0) return parsed;
    }
    return 200_000;
  }

  async hydrateMessages(runRequest, requestContext, { contextTokens = 200_000, mcpCatalogPrompt = '' } = {}) {
    this.loadPreFetchedBlobs(runRequest);

    const messages = [];
    const systemParts = [];
    const promptOverride = requestContext.systemPromptOverride || runRequest.systemPromptSpec;
    if (promptOverride?.replace) {
      systemParts.push(boundSectionText(promptOverride.replace, MAX_CUSTOM_SYSTEM_PROMPT_CHARS));
    } else if (runRequest.customSystemPrompt) {
      systemParts.push(boundSectionText(runRequest.customSystemPrompt, MAX_CUSTOM_SYSTEM_PROMPT_CHARS));
    }
    if (promptOverride?.append) {
      systemParts.push(boundSectionText(promptOverride.append, 8_000));
    }
    appendContextSections(systemParts, requestContext, {
      contextTokens,
      mcpCatalogPrompt,
      excludeWorkspaceContext: Boolean(runRequest.excludeWorkspaceContext),
    });
    if (!runRequest.excludeWorkspaceContext && requestContext.env?.workspacePaths?.length) {
      systemParts.push(`Workspace paths: ${requestContext.env.workspacePaths.join(', ')}`);
    }
    if (systemParts.length > 0) {
      messages.push({ role: 'system', content: boundSectionText(systemParts.join('\n\n'), MAX_SYSTEM_PROMPT_CHARS) });
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
      const turns = runRequest.conversationState.turns;
      const maxHistoryChars = Math.max(16_000, Math.floor(contextTokens * 2.2));
      const hydratedReversed = [];
      let historyChars = 0;
      for (let idx = turns.length - 1; idx >= 0; idx -= 1) {
        const turnBlobId = turns[idx];
        try {
          const turnData = await this.requestKvBlob(turnBlobId);
          if (!turnData) continue;
          const turn = decodeCursor('ConversationTurnStructure', turnData);
          const agentTurn = turn.agentConversationTurn;
          if (!agentTurn) continue;
          const turnMsgs = [];
          if (agentTurn.userMessage?.length) {
            const userBlob = await this.requestKvBlob(agentTurn.userMessage);
            if (userBlob) {
              const uMsg = decodeCursor('UserMessage', userBlob);
              const text = formatUserMessageContent(uMsg, this.blobs);
              if (text) turnMsgs.push({ role: 'user', content: text });
            }
          }
          const stepTexts = [];
          for (const stepBlobId of agentTurn.steps || []) {
            const stepBlob = await this.requestKvBlob(stepBlobId);
            if (!stepBlob) continue;
            const step = decodeCursor('ConversationStep', stepBlob);
            if (step.assistantMessage?.text) stepTexts.push(step.assistantMessage.text);
          }
          if (stepTexts.length) turnMsgs.push({ role: 'assistant', content: stepTexts.join('') });
          if (turnMsgs.length > 0) {
            const turnChars = turnMsgs.reduce((sum, item) => sum + estimateMessageChars(item), 0);
            if (hydratedReversed.length > 0 && historyChars + turnChars > maxHistoryChars) {
              break;
            }
            hydratedReversed.push(turnMsgs);
            historyChars += turnChars;
          }
        } catch {
          // Skip unreachable historical turn blobs gracefully.
        }
      }
      for (let idx = hydratedReversed.length - 1; idx >= 0; idx -= 1) {
        messages.push(...hydratedReversed[idx]);
      }
    }

    for (const prepended of userAction?.prependUserMessages || []) {
      const combinedPrepended = formatUserMessageContent(prepended, this.blobs);
      if (combinedPrepended) {
        messages.push({ role: 'user', content: combinedPrepended });
      }
    }

    const userMessage = userAction?.userMessage;
    if (userMessage) {
      const combined = formatUserMessageContent(userMessage, this.blobs);
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

  loadPreFetchedBlobs(runRequest) {
    for (const blob of runRequest.preFetchedBlobs || []) {
      if (blob.id && blob.value) {
        this.blobs.set(blobKey(blob.id), blob.value);
      }
    }
  }

  async resolveRequestContextParts(parts, requestContext) {
    if (!parts) return requestContext;
    const merged = { ...requestContext };
    const readPart = async (blobId, byteLength, schemaName) => {
      if (!blobId || blobId.length === 0 || byteLength === 0) return null;
      try {
        const raw = await this.requestKvBlob(blobId);
        return raw ? decodeCursor(schemaName, raw) : null;
      } catch {
        return null;
      }
    };
    if (!merged.rules?.length && !merged.nonFileRules?.length && parts.rulesBlobId?.length) {
      const rulesPart = await readPart(parts.rulesBlobId, parts.rulesByteLength, 'RequestContextRulesPart');
      if (rulesPart) {
        merged.rules = rulesPart.rules || [];
        merged.nonFileRules = rulesPart.nonFileRules || [];
        if (!merged.cloudRule && rulesPart.cloudRule) merged.cloudRule = rulesPart.cloudRule;
      }
    }
    if (!merged.agentSkills?.length && parts.skillsBlobId?.length) {
      const skillsPart = await readPart(parts.skillsBlobId, parts.skillsByteLength, 'RequestContextSkillsPart');
      if (skillsPart) {
        merged.agentSkills = skillsPart.agentSkills || [];
        if (!merged.skillOptions && skillsPart.skillOptions) merged.skillOptions = skillsPart.skillOptions;
      }
    }
    if (!merged.tools?.length && parts.mcpsBlobId?.length) {
      const mcpsPart = await readPart(parts.mcpsBlobId, parts.mcpsByteLength, 'RequestContextMcpsPart');
      if (mcpsPart) {
        merged.tools = mcpsPart.tools || [];
        if (!merged.mcpInstructions?.length && mcpsPart.mcpInstructions?.length) {
          merged.mcpInstructions = mcpsPart.mcpInstructions;
        }
        if (!merged.mcpFileSystemOptions && mcpsPart.mcpFileSystemOptions) {
          merged.mcpFileSystemOptions = mcpsPart.mcpFileSystemOptions;
        }
        if (!merged.mcpMetaToolOptions && mcpsPart.mcpMetaToolOptions) {
          merged.mcpMetaToolOptions = mcpsPart.mcpMetaToolOptions;
        }
      }
    }
    return merged;
  }

  async executeToolCall({ tc, parsedArgs, mcpMap, mcpCatalog, conversationId, workspaceDir, modelCallId }) {
    const norm = normalizeToolName(tc.name);
    if (norm === 'getmcptools') {
      const res = executeGetMcpTools(parsedArgs, mcpCatalog);
      return {
        mcpDef: null,
        formattedResult: {
          text: res.text,
          isError: res.isError,
          cardResult: res.isError ? { error: { error: res.text } } : { success: { content: res.text } },
        },
      };
    }
    if (norm === 'callmcptool') {
      const { mcpDef, toolArgs } = resolveCallMcpTool(parsedArgs, mcpCatalog);
      const execReply = await this.runExec(execIdNum =>
        buildExecRequest({
          execIdNum,
          callId: tc.id,
          name: mcpDef.name,
          args: toolArgs,
          mcpDef,
          conversationId,
          workspaceDir,
        })
      );
      return { mcpDef, formattedResult: formatExecResult(mcpDef.name, toolArgs, execReply) };
    }

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
      return { mcpDef: null, formattedResult: formatExecResult(tc.name, parsedArgs, writeReply, editCtx) };
    }

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
    return { mcpDef, formattedResult: formatExecResult(tc.name, parsedArgs, execReply) };
  }

  async executeRun(runRequest) {
    this.loadPreFetchedBlobs(runRequest);
    const config = this.getConfig();
    const conversationId = runRequest.conversationId || this.requestId;
    const parts = runRequest.action?.requestContextParts;
    let requestContext =
      runRequest.action?.userMessageAction?.requestContext ||
      runRequest.action?.executePlanAction?.requestContext ||
      runRequest.action?.resumeAction?.requestContext ||
      parts?.dynamicContext ||
      {};

    if (parts) {
      requestContext = await this.resolveRequestContextParts(parts, requestContext);
    }

    if (
      !requestContext.env &&
      !requestContext.tools?.length &&
      !requestContext.mcpMetaToolOptions &&
      !requestContext.mcpFileSystemOptions &&
      !runRequest.action?.summarizeAction
    ) {
      try {
        const loaded = await this.requestContextFromClient(conversationId);
        requestContext = { ...loaded, ...requestContext };
      } catch {
        // Proceed cleanly when client has no RequestContext handler (e.g. headless smoke client).
      }
    }

    if (!requestContext.skillOptions && runRequest.skillOptions) {
      requestContext = { ...requestContext, skillOptions: runRequest.skillOptions };
    }
    if (!requestContext.mcpFileSystemOptions && runRequest.mcpFileSystemOptions) {
      requestContext = { ...requestContext, mcpFileSystemOptions: runRequest.mcpFileSystemOptions };
    }

    const workspaceDir = requestContext.env?.workspacePaths?.[0] || requestContext.env?.processWorkingDirectory || '';
    const mcpDefinitions = [
      ...(runRequest.mcpTools?.mcpTools || []),
      ...(requestContext.tools || []),
    ];
    const { tools, mcpMap, mcpCatalog, useMetaTools, mcpCatalogPrompt } = buildOpenAiTools(mcpDefinitions, {
      mcpMetaToolOptions: requestContext.mcpMetaToolOptions,
      mcpFileSystemOptions: requestContext.mcpFileSystemOptions,
      mcpInstructions: requestContext.mcpInstructions,
    });
    const initialContextTokens = this.resolveTargetContextLimit(runRequest, config);
    const rawMessages = await this.hydrateMessages(runRequest, requestContext, {
      contextTokens: initialContextTokens,
      mcpCatalogPrompt,
    });

    const { modelId, effort, routedByAuto, serviceTier } = await resolveExecutionModel({
      runRequest,
      messages: rawMessages,
      tools,
      config,
      headers: this.headers,
      signal: this.abortController.signal,
    });
    const targetContextTokens = this.resolveTargetContextLimit(runRequest, config, modelId);
    let messages = fitMessagesToContextBudget(rawMessages, tools, targetContextTokens);
    if (process.env.CURSOR_BRIDGE_LOG_CONTEXT === '1') {
      const sysChars = messages[0]?.role === 'system' ? String(messages[0].content || '').length : 0;
      const totalChars = messages.reduce((sum, item) => sum + estimateMessageChars(item), 0);
      const toolsChars = JSON.stringify(tools).length;
      console.error(
        `[cursor-bridge:context] model=${modelId} ctx=${targetContextTokens} mcpMode=${useMetaTools ? 'progressive' : mcpCatalog.tools.length ? 'direct' : 'none'} mcpTools=${mcpCatalog.tools.length} openaiTools=${tools.length} sysChars=${sysChars} msgChars=${totalChars} toolChars=${toolsChars}`
      );
    }

    if (!this.abortController.signal.aborted && routedByAuto && modelId) {
      const chosenEntry = config.models.find(entry => entry.id === modelId);
      const displayName =
        chosenEntry?.name && chosenEntry.name !== chosenEntry.id
          ? `${chosenEntry.name} · ${chosenEntry.id}`
          : modelId;
      this.emit({ interactionUpdate: { routedModel: { displayName } } });
    }

    let finalUsage = null;
    const maxToolRounds = 64;
    for (let round = 0; round < maxToolRounds; round += 1) {
      if (this.abortController.signal.aborted) break;
      messages = fitMessagesToContextBudget(messages, tools, targetContextTokens);
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
        serviceTier,
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
        const prevOut = finalUsage?.outputTokens ?? 0;
        const prevReason = finalUsage?.reasoningTokens ?? 0;
        const nextOut = streamResult.usage.outputTokens;
        const nextReason = streamResult.usage.reasoningTokens;
        finalUsage = {
          inputTokens: streamResult.usage.inputTokens ?? finalUsage?.inputTokens ?? null,
          outputTokens: typeof nextOut === 'number' ? prevOut + nextOut : finalUsage?.outputTokens ?? null,
          cacheReadTokens: streamResult.usage.cacheReadTokens ?? finalUsage?.cacheReadTokens ?? null,
          reasoningTokens:
            typeof nextReason === 'number'
              ? prevReason + nextReason
              : finalUsage?.reasoningTokens ?? null,
        };
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

        const normTool = normalizeToolName(tc.name);
        let startedMcpDef = mcpMap.get(tc.name) || null;
        if (!startedMcpDef && normTool === 'callmcptool' && !argParseError) {
          try {
            startedMcpDef = resolveCallMcpTool(parsedArgs, mcpCatalog).mcpDef;
          } catch {
            startedMcpDef = null;
          }
        }

        this.emit({
          interactionUpdate: {
            toolCallStarted: {
              callId: tc.id,
              modelCallId,
              toolCall: renderToolCard({
                callId: tc.id,
                name: tc.name,
                args: parsedArgs,
                mcpDef: startedMcpDef,
              }),
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
                toolCall: renderToolCard({
                  callId: tc.id,
                  name: tc.name,
                  args: parsedArgs,
                  result:
                    normTool === 'getmcptools'
                      ? { error: { error: errText } }
                      : startedMcpDef
                        ? { error: { error: errText } }
                        : null,
                  mcpDef: startedMcpDef,
                }),
              },
            },
          });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: errText });
          continue;
        }

        let formattedResult;
        let resolvedMcpDef = null;
        try {
          const outcome = await this.executeToolCall({
            tc,
            parsedArgs,
            mcpMap,
            mcpCatalog,
            conversationId,
            workspaceDir,
            modelCallId,
          });
          resolvedMcpDef = outcome.mcpDef;
          formattedResult = outcome.formattedResult;
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
                mcpDef: resolvedMcpDef,
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
    this.emit({
      conversationCheckpointUpdate: {
        turns: [],
        rootPromptMessagesJson: [],
      },
    });
    this.endStream(null);
  }
}
