import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from './settings.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const KNOWN_MODELS_LIMIT = 500;
const STANDARD_TIER_IDS = new Set(['default', 'standard', 'usual', 'off', 'none', 'inherit']);
const FAST_TIER_IDS = new Set(['priority', 'ultrafast', 'fast']);

function defaultTierDisplayName(tierId) {
  const lower = String(tierId || '').toLowerCase();
  if (lower === 'priority' || lower === 'fast') return 'Fast';
  if (lower === 'ultrafast') return 'Ultrafast';
  if (lower === 'flex') return 'Flex';
  return tierId;
}

/** Parse a service-tier / fast parameter string into `'off'`, a tier id (`'priority'`, `'ultrafast'`, ...), or `null`. */
export function parseServiceTierParam(rawValue, { isFastFlag = false } = {}) {
  if (typeof rawValue === 'boolean') {
    return isFastFlag ? (rawValue ? 'priority' : 'off') : null;
  }
  if (typeof rawValue !== 'string') return null;
  const clean = rawValue.replace(/[\r\n\0]/g, '').trim().toLowerCase();
  if (!clean || clean === 'none' || clean === 'default' || clean === 'inherit') return null;
  if (clean === 'off' || clean === 'false' || clean === '0' || clean === 'standard' || clean === 'usual') {
    return 'off';
  }
  if (clean === 'true' || clean === '1') return 'priority';
  return clean.slice(0, 48);
}

/** Normalize model `service_tiers` entries while preserving legacy `fast` compatibility. */
export function normalizeServiceTiers(rawTiers, fallbackFast = false) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(rawTiers)) {
    for (const item of rawTiers) {
      const rawId = typeof item === 'string' ? item : item?.id;
      const cleanId = typeof rawId === 'string' ? rawId.replace(/[\r\n\0]/g, '').trim().toLowerCase() : '';
      if (!cleanId || STANDARD_TIER_IDS.has(cleanId) || seen.has(cleanId)) continue;
      seen.add(cleanId);
      const rawName = typeof item === 'object' && item && typeof item.name === 'string' ? item.name.trim() : '';
      const rawDesc =
        typeof item === 'object' && item && typeof item.description === 'string' ? item.description.trim() : '';
      const entry = {
        id: cleanId,
        name: rawName || defaultTierDisplayName(cleanId),
      };
      if (rawDesc) entry.description = rawDesc;
      out.push(entry);
    }
    return out;
  }
  if (fallbackFast) {
    return [{ id: 'priority', name: 'Fast' }];
  }
  return out;
}

/** Return `true` when any normalized service tier represents a fast acceleration tier. */
export function hasFastTier(serviceTiers = []) {
  return (
    Array.isArray(serviceTiers) &&
    serviceTiers.some(tier => {
      const id = String(tier?.id || '').toLowerCase();
      const name = String(tier?.name || '').toLowerCase();
      return (
        FAST_TIER_IDS.has(id) ||
        name === 'fast' ||
        name.includes('priority') ||
        name.includes('ultrafast')
      );
    })
  );
}

/**
 * Resolve the effective `service_tier` string for a target model ID given an explicit tier
 * and/or an inherited parent request tier. Returns `null` when standard speed should be used.
 */
export function resolveEffectiveServiceTier(
  modelId,
  config,
  requestedTier,
  { inheritTier = null, allowUnknownExplicit = false } = {}
) {
  if (requestedTier === 'off') return null;
  const candidate = requestedTier || inheritTier;
  if (!candidate || candidate === 'off') return null;

  const cleanId = parseModelRef(modelId).modelId;
  const allModels = [...(config?.models || []), ...(config?.hiddenModels || [])];
  const entry = allModels.find(model => model && model.id === cleanId) || null;
  const candidateLower = String(candidate).trim().toLowerCase();
  if (!entry) {
    return allowUnknownExplicit && requestedTier ? candidateLower : null;
  }
  const tiers = normalizeServiceTiers(entry.serviceTiers ?? entry.service_tiers, Boolean(entry.fast));
  if (tiers.length === 0) return null;

  const exact = tiers.find(tier => tier.id === candidateLower);
  if (exact) return exact.id;
  if (candidateLower === 'priority') {
    const fastAlias = tiers.find(tier => tier.id === 'fast');
    if (fastAlias) return fastAlias.id;
  }
  if (candidateLower === 'fast') {
    const priorityAlias = tiers.find(tier => tier.id === 'priority');
    if (priorityAlias) return priorityAlias.id;
  }
  if (candidateLower === 'ultrafast') {
    const fastFallback = tiers.find(tier => tier.id === 'priority' || tier.id === 'fast');
    if (fastFallback) return fastFallback.id;
  }
  return null;
}

export const ROLE_KEYS = [
  'autoRouter',
  'subagent',
  'bugbot',
  'securitybot',
  'title',
  'summarize',
  'memory',
  'commit',
];

const ROLE_ALIASES = {
  autoRouter: ['autoRouter', 'autoRouterModel', 'auto', 'autoModel', 'router', 'routerModel'],
  subagent: ['subagent', 'subagentModel', 'subagents'],
  bugbot: ['bugbot', 'bugbotModel'],
  securitybot: ['securitybot', 'securitybotModel', 'security'],
  title: ['title', 'titleModel', 'naming', 'namingModel'],
  summarize: ['summarize', 'summarizeModel', 'summary', 'summaryModel', 'compaction', 'compactionModel'],
  memory: ['memory', 'memoryModel', 'memories', 'memoriesModel'],
  commit: ['commit', 'commitModel'],
};

/** Sanitize a single model identifier (or clear when empty / default / inherit). */
export function sanitizeModelRef(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/[\r\n\0]/g, '').trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'default' || lower === 'inherit' || lower === 'none') return '';
  return trimmed.slice(0, 256);
}

/** Normalize a raw role configuration or plugin options object into canonical role shape. */
export function normalizeRoleConfig(raw) {
  const empty = {
    autoRouter: '',
    subagent: '',
    subagentTypes: {},
    bugbot: '',
    securitybot: '',
    title: '',
    summarize: '',
    memory: '',
    commit: '',
  };
  if (!raw || typeof raw !== 'object') return empty;

  const source = raw.roles && typeof raw.roles === 'object' ? { ...raw, ...raw.roles } : raw;
  const result = { ...empty, subagentTypes: {} };

  for (const roleKey of ROLE_KEYS) {
    for (const alias of ROLE_ALIASES[roleKey]) {
      const normalized = sanitizeModelRef(source[alias]);
      if (normalized) {
        result[roleKey] = normalized;
        break;
      }
    }
  }

  const rawTypes = source.subagentTypes || source.subagentTypeModels;
  if (rawTypes && typeof rawTypes === 'object' && !Array.isArray(rawTypes)) {
    for (const [typeName, modelValue] of Object.entries(rawTypes)) {
      const cleanType = String(typeName || '').replace(/[\r\n\0]/g, '').trim();
      const cleanModel = sanitizeModelRef(modelValue);
      if (cleanType && cleanModel) {
        result.subagentTypes[cleanType] = cleanModel;
      }
    }
  }
  return result;
}

/** Return `true` when `raw` explicitly carries any role configuration field. */
export function hasExplicitRoleFields(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.roles && typeof raw.roles === 'object') return true;
  for (const aliases of Object.values(ROLE_ALIASES)) {
    if (aliases.some(alias => alias in raw)) return true;
  }
  return 'subagentTypes' in raw || 'subagentTypeModels' in raw;
}

/** Parse optional `[effort=...,reasoning=...,service_tier=...,fast=...]` suffix from a configured model reference. */
export function parseModelRef(rawModelId) {
  const clean = sanitizeModelRef(rawModelId);
  if (!clean) return { modelId: '', effort: null };
  const bracketMatch = /^(.+?)\[([^\]]+)\]$/.exec(clean);
  if (!bracketMatch) {
    return { modelId: clean, effort: null };
  }
  let effort = null;
  let explicitTier = null;
  let fastTier = null;
  for (const pair of bracketMatch[2].split(',')) {
    const [rawKey, rawVal] = pair.split('=');
    const paramKey = String(rawKey || '').trim().toLowerCase();
    const paramVal = typeof rawVal === 'string' ? rawVal.trim() : '';
    if ((paramKey === 'effort' || paramKey === 'reasoning') && paramVal && paramVal !== 'none') {
      effort = paramVal.trim();
    } else if (paramKey === 'service_tier' || paramKey === 'tier' || paramKey === 'speed') {
      const parsedTier = parseServiceTierParam(paramVal);
      if (parsedTier) explicitTier = parsedTier;
    } else if (paramKey === 'fast') {
      const parsedFast = parseServiceTierParam(paramVal, { isFastFlag: true });
      if (parsedFast) fastTier = parsedFast;
    }
  }
  const serviceTier = explicitTier || fastTier;
  const out = { modelId: bracketMatch[1].trim(), effort };
  if (serviceTier) out.serviceTier = serviceTier;
  return out;
}

/** Resolve which model ID (and optional reasoning effort) handles a Cursor role. */
export function resolveRoleModel(config, roleName, { subagentType = '', fallbackModel = '' } = {}) {
  const roles = normalizeRoleConfig(config?.roles || config);
  let selected = '';
  if (roleName === 'subagent' && subagentType) {
    const targetLower = subagentType.trim().toLowerCase();
    for (const [keyName, modelValue] of Object.entries(roles.subagentTypes)) {
      if (keyName.toLowerCase() === targetLower && modelValue) {
        selected = modelValue;
        break;
      }
    }
  }
  if (!selected && roleName && roles[roleName]) {
    selected = roles[roleName];
  }
  if (!selected) {
    const parsedFallback = parseModelRef(fallbackModel || config?.model || '');
    const result = {
      modelId: parsedFallback.modelId || config?.model || '',
      effort: parsedFallback.effort,
      role: 'default',
    };
    if (parsedFallback.serviceTier) result.serviceTier = parsedFallback.serviceTier;
    return result;
  }
  const parsed = parseModelRef(selected);
  const result = {
    modelId: parsed.modelId || config?.model || '',
    effort: parsed.effort,
    role: roleName,
  };
  if (parsed.serviceTier) result.serviceTier = parsed.serviceTier;
  return result;
}

/** Return `true` when `modelId` identifies Cursor's upstream Auto provider model (`cursor/auto` or `cursor/auto-*`). */
export function isCursorAutoModelId(modelId) {
  const clean = String(modelId || '').trim().toLowerCase();
  return clean === 'cursor/auto' || clean.startsWith('cursor/auto-');
}

function findCursorAutoCatalogEntry(models = []) {
  const list = Array.isArray(models) ? models : [];
  const exact = list.find(
    entry => typeof entry?.id === 'string' && entry.id.trim().toLowerCase() === 'cursor/auto'
  );
  if (exact) return exact;
  const prefixed = list.find(
    entry => typeof entry?.id === 'string' && entry.id.trim().toLowerCase().startsWith('cursor/auto-')
  );
  if (prefixed) return prefixed;
  return (
    list.find(
      entry =>
        typeof entry?.id === 'string' &&
        entry.id.trim().toLowerCase().startsWith('cursor/') &&
        typeof entry?.name === 'string' &&
        /^auto(\b|\s*·)/i.test(entry.name.trim())
    ) || null
  );
}

/**
 * Resolve the routing control model for Cursor's native Auto mode.
 * Uses explicit `autoRouter` when set; otherwise defaults to Cursor's native
 * `cursor/auto`, with the catalogue's `cursor/auto-*` entry as a retry.
 */
export function resolveAutoRouterConfig(config) {
  const roles = normalizeRoleConfig(config?.roles || config);
  const models = Array.isArray(config?.models) ? config.models : [];
  if (roles.autoRouter) {
    const parsed = parseModelRef(roles.autoRouter);
    if (parsed.modelId) {
      const result = {
        // Explicit is explicit: Cursor accepts cursor/auto even when its own
        // catalogue lists only cursor/auto-smart.
        modelId: parsed.modelId,
        effort: parsed.effort,
        source: 'configured',
      };
      if (parsed.serviceTier) result.serviceTier = parsed.serviceTier;
      return result;
    }
  }
  if (!models.some(entry => typeof entry?.id === 'string' && entry.id.startsWith('cursor/'))) {
    return {
      modelId: '',
      effort: null,
      source: 'fallback-main',
    };
  }
  const cursorAuto = findCursorAutoCatalogEntry(models);
  const result = {
    modelId: 'cursor/auto',
    effort: null,
    source: 'default-cursor-auto',
  };
  if (cursorAuto && cursorAuto.id !== 'cursor/auto') {
    result.fallbackModelId = cursorAuto.id;
  }
  return result;
}

/** Locate candidate `plugins.json` files managed by Magpie. */
export function magpiePluginsCandidates(homeDir = os.homedir()) {
  const candidates = [];
  if (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)) {
    candidates.push(path.join(process.env.XDG_CONFIG_HOME, 'magpie', 'plugins.json'));
  }
  candidates.push(path.join(homeDir, '.config', 'magpie', 'plugins.json'));
  candidates.push(path.join(homeDir, 'Desktop', 'data', 'plugins.json'));
  return [...new Set(candidates)];
}

function isCursorBridgePluginSpec(spec) {
  const lower = String(spec || '').toLowerCase();
  return (
    lower.includes('magpie-cursor-agent') ||
    lower.includes('magpie-agent-cursor-bridge') ||
    lower.includes('cursor-bridge')
  );
}

/** Read options stored by Magpie for the Cursor bridge plugin in `plugins.json`, if present. */
export function readMagpiePluginOptions(homeDir = os.homedir(), pluginsJsonPath = '') {
  const candidates = pluginsJsonPath ? [pluginsJsonPath] : magpiePluginsCandidates(homeDir);
  for (const filePath of candidates) {
    try {
      const stat = fs.statSync(filePath);
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      const match = plugins.find(entry => entry && !entry.off && isCursorBridgePluginSpec(entry.spec));
      if (match) {
        return {
          path: filePath,
          mtimeMs: stat.mtimeMs,
          options: match.options && typeof match.options === 'object' ? match.options : {},
        };
      }
    } catch {
      // Ignore absent or malformed plugins.json candidates.
    }
  }
  return null;
}

/**
 * Merge role overrides from `connection.json` (`configRoles`), Magpie `plugins.json` options,
 * and standalone `<rootDir>/roles.json` (preferring whichever explicit external config is newer).
 */
export function loadMergedRoles({
  rootDir,
  homeDir = os.homedir(),
  configRoles = null,
  includeMagpiePlugins = true,
  pluginsJsonPath = '',
} = {}) {
  const base = normalizeRoleConfig(configRoles);
  const sources = [];

  const pluginEntry =
    includeMagpiePlugins || pluginsJsonPath
      ? readMagpiePluginOptions(homeDir, pluginsJsonPath)
      : null;
  if (pluginEntry && hasExplicitRoleFields(pluginEntry.options)) {
    sources.push({
      source: 'plugins.json',
      mtimeMs: pluginEntry.mtimeMs,
      roles: normalizeRoleConfig(pluginEntry.options),
    });
  }

  if (rootDir) {
    const rolesPath = path.join(rootDir, 'roles.json');
    try {
      const stat = fs.statSync(rolesPath);
      const parsed = JSON.parse(fs.readFileSync(rolesPath, 'utf8'));
      if (hasExplicitRoleFields(parsed)) {
        const updatedAtMs = typeof parsed.updatedAt === 'string' ? Date.parse(parsed.updatedAt) : NaN;
        sources.push({
          source: 'roles.json',
          mtimeMs: stat.mtimeMs,
          priority: 1,
          updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : stat.mtimeMs,
          roles: normalizeRoleConfig(parsed),
        });
      }
    } catch {
      // Absent or invalid roles.json is ignored cleanly.
    }
  }

  if (sources.length === 0) {
    return base;
  }
  sources.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    const rightUpdated = right.updatedAtMs ?? right.mtimeMs;
    const leftUpdated = left.updatedAtMs ?? left.mtimeMs;
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
    return (right.priority ?? 0) - (left.priority ?? 0);
  });
  return sources[0].roles;
}

/**
 * Validate a bridge connection configuration.
 * Returns `null` when disconnected/incomplete, or throws on invalid/unsafe gateway URLs.
 */
export function validateConfig(config, { fallbackMissingModel = false } = {}) {
  if (!config || config.enabled !== true || !config.model || !config.key) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(String(config.gateway));
  } catch {
    throw new Error('Magpie gateway must be a valid local HTTP URL');
  }
  if (
    parsed.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Magpie gateway must be a local loopback HTTP address without credentials');
  }
  if (!Array.isArray(config.models) || config.models.length === 0) {
    throw new Error('Model catalogue must be a non-empty array');
  }
  const seenIds = new Set();
  for (const entry of config.models) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || seenIds.has(entry.id)) {
      throw new Error('Invalid or duplicate model id');
    }
    seenIds.add(entry.id);
  }
  let activeModel = config.model;
  if (!seenIds.has(activeModel)) {
    if (!fallbackMissingModel) {
      throw new Error('Selected model missing from catalogue');
    }
    activeModel = config.models[0].id;
  }
  const hiddenModels = normalizeKnownModelsList(config.hiddenModels, seenIds);
  const normalized = { ...config, model: activeModel };
  if (hiddenModels.length > 0) {
    normalized.hiddenModels = hiddenModels;
  } else {
    delete normalized.hiddenModels;
  }
  if (hasExplicitRoleFields(normalized)) {
    return { ...normalized, roles: normalizeRoleConfig(normalized.roles || normalized) };
  }
  return normalized;
}

function normalizeKnownModelsList(list, excludeIds = null) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!id || id === 'magpie-live' || seen.has(id)) continue;
    if (excludeIds?.has(id)) continue;
    seen.add(id);
    const serviceTiers = normalizeServiceTiers(
      entry.serviceTiers ?? entry.service_tiers,
      Boolean(entry.fast)
    );
    const fast = Boolean(entry.fast) || hasFastTier(serviceTiers);
    out.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      context: Number.isFinite(Number(entry.context)) && Number(entry.context) > 0 ? Number(entry.context) : null,
      efforts: Array.isArray(entry.efforts)
        ? entry.efforts.map(val => String(val || '').trim()).filter(Boolean)
        : [],
      fast,
      serviceTiers,
    });
    if (out.length >= KNOWN_MODELS_LIMIT) break;
  }
  return out;
}

/** Read historically seen Magpie models persisted under `<rootDir>/known-models.json`. */
export function readKnownModels(rootDir) {
  if (!rootDir) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(rootDir, 'known-models.json'), 'utf8'));
    return normalizeKnownModelsList(parsed?.models || parsed);
  } catch {
    return [];
  }
}

/**
 * Merge currently exposed models with historical known models and persist `known-models.json`.
 * Returns `{ knownModels, hiddenModels }` where `hiddenModels` are known IDs currently omitted.
 */
export function syncKnownModels(rootDir, exposedModels = [], seedModels = []) {
  const existing = readKnownModels(rootDir);
  const merged = normalizeKnownModelsList([...exposedModels, ...seedModels, ...existing]);
  const exposedIds = new Set(normalizeKnownModelsList(exposedModels).map(entry => entry.id));
  const hiddenModels = merged.filter(entry => !exposedIds.has(entry.id));
  if (rootDir) {
    try {
      const filePath = path.join(rootDir, 'known-models.json');
      const prev = existing;
      if (JSON.stringify(prev) !== JSON.stringify(merged)) {
        atomicWrite(filePath, JSON.stringify({ models: merged }, null, 2), { mode: 0o600 });
      }
    } catch {
      // Non-fatal in read-only or temporary test directories.
    }
  }
  return { knownModels: merged, hiddenModels };
}

/**
 * Query the local Magpie gateway `/models` endpoint and return a refreshed validated config.
 */
export async function fetchGatewayModels(config, { knownModels = [] } = {}) {
  validateConfig(config, { fallbackMissingModel: true });
  const endpoint = `${config.gateway.replace(/\/$/, '')}/models`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${config.key}`,
        'User-Agent': 'cursor-magpie-bridge/0.4.0',
    },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`Magpie gateway HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body || !Array.isArray(body.data)) {
    throw new Error('Invalid Magpie /models response');
  }
  const existing = new Map([
    ...(Array.isArray(knownModels) ? knownModels : []).map(entry => [entry.id, entry]),
    ...config.models.map(entry => [entry.id, entry]),
  ]);
  const seenIds = new Set();
  const models = [];
  for (const entry of body.data) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    const prior = existing.get(entry.id);
    const levels = Array.isArray(entry.reasoning_levels) && entry.reasoning_levels.length
      ? entry.reasoning_levels
      : Array.isArray(entry.supported_reasoning_levels)
        ? entry.supported_reasoning_levels.map(level => level?.effort).filter(Boolean)
        : [];
    const serviceTiers = Array.isArray(entry.service_tiers)
      ? normalizeServiceTiers(entry.service_tiers)
      : normalizeServiceTiers(prior?.serviceTiers ?? prior?.service_tiers, Boolean(prior?.fast));
    const fast = Array.isArray(entry.service_tiers)
      ? hasFastTier(serviceTiers)
      : Boolean(prior?.fast) || hasFastTier(serviceTiers);
    models.push({
      id: entry.id,
      name: prior?.name || entry.display_name || entry.name || entry.id,
      context: entry.context_window || entry.context_length || prior?.context || null,
      efforts: prior?.efforts?.length ? prior.efforts : levels,
      fast,
      serviceTiers,
    });
  }
  return validateConfig({ ...config, models }, { fallbackMissingModel: true });
}
