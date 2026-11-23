const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * Validate a bridge connection configuration.
 * Returns `null` when disconnected/incomplete, or throws on invalid/unsafe gateway URLs.
 */
export function validateConfig(config) {
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
  if (!config.models.some(entry => entry && entry.id === config.model)) {
    throw new Error('Selected model missing from catalogue');
  }
  const seenIds = new Set();
  for (const entry of config.models) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || seenIds.has(entry.id)) {
      throw new Error('Invalid or duplicate model id');
    }
    seenIds.add(entry.id);
  }
  return config;
}

/**
 * Query the local Magpie gateway `/models` endpoint and return a refreshed validated config.
 */
export async function fetchGatewayModels(config) {
  validateConfig(config);
  const endpoint = `${config.gateway.replace(/\/$/, '')}/models`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${config.key}`,
      'User-Agent': 'cursor-magpie-bridge/0.3.0',
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
  const existing = new Map(config.models.map(entry => [entry.id, entry]));
  const models = body.data.map(entry => {
    const prior = existing.get(entry.id);
    return {
      id: entry.id,
      name: prior?.name || entry.name || entry.id,
      context: prior?.context || entry.context_window || null,
    };
  });
  return validateConfig({ ...config, models });
}
