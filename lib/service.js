import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  hasFastTier,
  loadMergedRoles,
  normalizeRoleConfig,
  normalizeServiceTiers,
  readMagpiePluginOptions,
} from './config.js';
import { isLockHeld, isProcessAlive } from './lock.js';
import { atomicWrite } from './settings.js';
import {
  compareSemver,
  findMagpieBun,
  findMagpieBuns,
  inspectRuntime,
  isVersionHttp2Capable,
  selectPreferredRuntime,
} from './runtime.js';

const DEFAULT_SERVICE_PORT = 19381;
const MAX_BODY_BYTES = 65536;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const RECLAIM_INTERVAL_MS = 1000;
const CATALOG_ASSET = 'catalog.runtime.js';
const CATALOG_INTERVAL_MS = 3000;
const SSE_POLL_INTERVAL_MS = 400;
const SSE_PING_INTERVAL_MS = 20000;
const activeInitialSetups = new Map();

const STATIC_ROUTES = {
  '/': { file: 'service.html', type: 'text/html; charset=utf-8' },
  '/service.html': { file: 'service.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/shared.js': { file: 'shared.js', type: 'application/javascript; charset=utf-8' },
  '/magpie-bridge.js': { file: 'magpie-bridge.js', type: 'application/javascript; charset=utf-8' },
  '/service.js': { file: 'service.js', type: 'application/javascript; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml; charset=utf-8' },
  '/favicon.ico': { file: 'icon.svg', type: 'image/svg+xml; charset=utf-8' },
};

/** Resolve the package root directory containing `plugin.js` and `ui/`. */
export function resolveSourceDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

/** Resolve the bridge runtime state root directory (`~/.config/magpie-cursor-bridge` by default). */
export function resolveDefaultRoot(homeDir = os.homedir()) {
  return process.env.CURSOR_BRIDGE_ROOT || path.join(homeDir, '.config', 'magpie-cursor-bridge');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonWithMtime(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { data: JSON.parse(fs.readFileSync(filePath, 'utf8')), mtimeMs: stat.mtimeMs };
  } catch {
    return { data: null, mtimeMs: 0 };
  }
}

function readManifestVersion(sourceDir) {
  const manifest = readJsonSafe(path.join(sourceDir, 'package.json'));
  return typeof manifest?.version === 'string' ? manifest.version : null;
}

function readIntegritySignature(dirPath) {
  if (!dirPath) return null;
  try {
    const raw = fs.readFileSync(path.join(dirPath, 'integrity.json'), 'utf8');
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

function recordFailure(rootDir, error) {
  try {
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(rootDir, 'autostart.log'),
      `${new Date().toISOString()} ${error?.message || error}\n`,
      { flag: 'a' }
    );
  } catch {
    // Never fail plugin initialization if autostart logging cannot write.
  }
}

function isSupervisorRunning(rootDir) {
  const lockDir = path.join(rootDir, 'supervisor.lock');
  if (isLockHeld(path.join(lockDir, 'owner.json'))) return true;
  try {
    const legacyPid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim());
    return isProcessAlive(legacyPid);
  } catch {
    return false;
  }
}

function hasAvailableRuntimeUpgrade(record, homeDir) {
  const runtime = record?.runtime;
  if (!runtime || typeof runtime !== 'object') return false;
  if (process.env.MAGPIE_BUN) return false;
  const buns = findMagpieBuns({ homeDir });
  const topBun = buns[0] || null;
  const topBunCandidate = Boolean(topBun && isVersionHttp2Capable('bun', topBun.version));

  if (runtime.kind === 'node' && topBunCandidate && inspectRuntime(topBun.path)?.http2) {
    return true;
  }
  if (runtime.kind === 'bun' && topBunCandidate && runtime.version) {
    if (compareSemver(topBun.version, runtime.version) > 0 && inspectRuntime(topBun.path)?.http2) {
      return true;
    }
  }
  if (runtime.http2 === false) {
    if (topBunCandidate && inspectRuntime(topBun.path)?.http2) return true;
    const preferred = selectPreferredRuntime({ homeDir });
    if (preferred?.http2) return true;
  }
  return false;
}

function needsVersionUpgrade(sourceDir, rootDir, homeDir = os.homedir()) {
  const current = readManifestVersion(sourceDir);
  if (!current) return false;
  const status = readJsonSafe(path.join(rootDir, 'status.json'));
  const active = typeof status?.version === 'string' ? status.version : null;
  if (active && active !== current) return true;

  const record = readJsonSafe(path.join(rootDir, 'installation.json'));
  if (hasAvailableRuntimeUpgrade(record, homeDir)) return true;

  const sourceIntegrity = readIntegritySignature(sourceDir);
  if (!sourceIntegrity) return false;
  if (!record?.release) return false;
  return readIntegritySignature(record.release) !== sourceIntegrity;
}

function findStagedRelease(sourceDir, rootDir, homeDir = os.homedir()) {
  const record = readJsonSafe(path.join(rootDir, 'installation.json'));
  const releaseDir = record?.release;
  if (!releaseDir) return null;
  if (!fs.existsSync(path.join(releaseDir, 'bridge.js'))) return null;
  if (!fs.existsSync(path.join(releaseDir, 'engine.js'))) return null;
  if (record.runtime) {
    const runtimeName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
    if (!fs.existsSync(path.join(releaseDir, 'bin', runtimeName))) return null;
    if (hasAvailableRuntimeUpgrade(record, homeDir)) return null;
  }
  const current = readManifestVersion(sourceDir);
  if (current && record.version !== current) return null;
  const sourceIntegrity = readIntegritySignature(sourceDir);
  if (sourceIntegrity && readIntegritySignature(releaseDir) !== sourceIntegrity) {
    return null;
  }
  return releaseDir;
}

function pickRuntime(releaseDir) {
  const runtimeName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
  const bundled = path.join(releaseDir, 'bin', runtimeName);
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function readLastLogLine(logPath, ignoredPrefix = '') {
  try {
    const lines = fs
      .readFileSync(logPath, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (ignoredPrefix && lines[index].includes(ignoredPrefix)) continue;
      return lines[index];
    }
  } catch {
    // Log file may be missing or unreadable.
  }
  return '';
}

function writeAutostartErrorStatus(rootDir, version, reason) {
  try {
    if (isSupervisorRunning(rootDir)) return;
    const statusPath = path.join(rootDir, 'status.json');
    const existing = readJsonSafe(statusPath);
    if (existing?.state === 'connected') return;
    atomicWrite(
      statusPath,
      JSON.stringify(
        {
          version: version || existing?.version || null,
          state: 'error',
          reason: String(reason || '初始化失败，请查看 autostart.log'),
          updated: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  } catch {
    // Never fail plugin initialization if status.json cannot write.
  }
}

function runInitialSetup(sourceDir, rootDir, homeDir, onLog = null) {
  const installer = path.join(sourceDir, 'install.js');
  if (!fs.existsSync(installer)) return Promise.resolve({ ok: true, skipped: true });
  const preferred = selectPreferredRuntime({ homeDir, currentExecPath: process.execPath });
  const runtime = preferred?.path || findMagpieBun(homeDir) || process.execPath;
  const version = readManifestVersion(sourceDir);

  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(rootDir, 'autostart.log');
  const header = `${new Date().toISOString()} setup starting (runtime=${runtime})`;
  let logFd = null;
  try {
    fs.writeFileSync(logPath, `${header}\n`, { flag: 'a', mode: 0o600 });
    logFd = fs.openSync(logPath, 'a', 0o600);
  } catch {
    logFd = null;
  }

  return new Promise(resolve => {
    const env = { ...process.env };
    const defaultRoot = path.join(homeDir, '.config', 'magpie-cursor-bridge');
    if (process.env.CURSOR_BRIDGE_ROOT || path.resolve(rootDir) !== path.resolve(defaultRoot)) {
      env.CURSOR_BRIDGE_ROOT = rootDir;
    } else {
      delete env.CURSOR_BRIDGE_ROOT;
    }

    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(runtime, [installer, 'setup'], {
      cwd: sourceDir,
      detached: true,
      stdio: logFd !== null ? ['ignore', logFd, logFd] : 'ignore',
      windowsHide: true,
      env,
    });
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // Parent no longer needs the descriptor once child inherits it.
      }
    }

    child.on('error', error => {
      recordFailure(rootDir, error);
      writeAutostartErrorStatus(rootDir, version, error?.message || error);
      onLog?.('warn', `cursor-bridge: initial setup spawn failed (${error?.message || error})`);
      finish({ ok: false, error: error?.message || String(error) });
    });
    child.on('exit', (code, signal) => {
      if (code === 0 && !signal) {
        finish({ ok: true });
        return;
      }
      const detail = readLastLogLine(logPath, 'setup starting (runtime=') || `setup exited (${signal || code})`;
      recordFailure(rootDir, `setup failed (code=${code}, signal=${signal || 'none'}): ${detail}`);
      writeAutostartErrorStatus(rootDir, version, detail);
      onLog?.('warn', `cursor-bridge: initial setup failed (${detail})`);
      finish({ ok: false, error: detail, code, signal });
    });
    child.unref();
    const timer = setTimeout(() => finish({ ok: true, pending: true }), 60000);
    timer.unref?.();
  });
}

/** Ensure the background Cursor bridge supervisor is running at the current plugin version. */
export async function ensureBridgeStarted({
  rootDir = resolveDefaultRoot(),
  sourceDir = resolveSourceDir(),
  homeDir = os.homedir(),
  noAutostart = Boolean(process.env.MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART),
  onLog = null,
} = {}) {
  if (noAutostart) return { action: 'disabled' };
  try {
    const running = isSupervisorRunning(rootDir);
    const upgradeNeeded = needsVersionUpgrade(sourceDir, rootDir, homeDir);
    if (running && !upgradeNeeded) {
      return { action: 'running' };
    }
    if (!running && !upgradeNeeded) {
      const releaseDir = findStagedRelease(sourceDir, rootDir, homeDir);
      if (releaseDir) {
        const child = spawn(pickRuntime(releaseDir), [path.join(releaseDir, 'bridge.js'), 'supervise'], {
          cwd: releaseDir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, CURSOR_BRIDGE_ROOT: rootDir },
        });
        child.on('error', error => recordFailure(rootDir, error));
        child.unref();
        onLog?.('info', 'cursor-bridge: started background supervisor');
        return { action: 'launched', releaseDir };
      }
    }

    const rootKey = path.resolve(rootDir);
    if (isLockHeld(path.join(rootDir, 'installer.lock', 'owner.json'))) {
      onLog?.('info', 'cursor-bridge: initial setup already in progress');
      return { action: 'setup-pending' };
    }
    if (activeInitialSetups.has(rootKey)) {
      return await activeInitialSetups.get(rootKey);
    }

    onLog?.('info', 'cursor-bridge: launching initial setup');
    const setupPromise = runInitialSetup(sourceDir, rootDir, homeDir, onLog).then(result => {
      if (result && result.ok === false) {
        return { action: 'error', error: result.error };
      }
      return { action: 'setup' };
    });
    activeInitialSetups.set(rootKey, setupPromise);
    try {
      return await setupPromise;
    } finally {
      activeInitialSetups.delete(rootKey);
    }
  } catch (error) {
    recordFailure(rootDir, error);
    onLog?.('warn', `cursor-bridge: autostart failed (${error?.message || error})`);
    return { action: 'error', error: error?.message || String(error) };
  }
}

/** Read public diagnostic status, catalog models (never secrets), and merged role assignments. */
export function readSafeState({
  rootDir = resolveDefaultRoot(),
  homeDir = os.homedir(),
  includeMagpiePlugins = !process.env.CURSOR_BRIDGE_ROOT,
  pluginsJsonPath = process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
} = {}) {
  const { data: connection, mtimeMs: connectionMtimeMs } = readJsonWithMtime(path.join(rootDir, 'connection.json'));
  const { data: effective, mtimeMs: effectiveMtimeMs } = readJsonWithMtime(path.join(rootDir, 'effective.json'));
  const status = readJsonSafe(path.join(rootDir, 'status.json'));
  const rolesFile = readJsonSafe(path.join(rootDir, 'roles.json'));
  const pluginEntry =
    includeMagpiePlugins || pluginsJsonPath ? readMagpiePluginOptions(homeDir, pluginsJsonPath) : null;

  const useEffectiveModels =
    connection?.enabled === true &&
    Array.isArray(effective?.models) &&
    effective.models.length > 0 &&
    (effectiveMtimeMs >= connectionMtimeMs || effective.model === connection.model);
  const rawModels = useEffectiveModels ? effective.models : connection?.models;

  const models = Array.isArray(rawModels)
    ? rawModels
        .filter(entry => entry && typeof entry.id === 'string' && entry.id.trim())
        .map(entry => {
          const serviceTiers = normalizeServiceTiers(
            entry.serviceTiers ?? entry.service_tiers,
            Boolean(entry.fast)
          );
          return {
            id: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            context: entry.context ?? null,
            efforts: Array.isArray(entry.efforts)
              ? entry.efforts.filter(value => typeof value === 'string' && value.trim())
              : [],
            fast: Boolean(entry.fast) || hasFastTier(serviceTiers),
            serviceTiers,
          };
        })
    : [];

  const roles = loadMergedRoles({
    rootDir,
    homeDir,
    configRoles: connection?.roles || null,
    includeMagpiePlugins,
    pluginsJsonPath,
  });

  const proxyPort = extractProxyPort(status?.proxy);
  return {
    enabled: Boolean(connection?.enabled),
    defaultModel: typeof connection?.model === 'string' ? connection.model : '',
    models,
    roles,
    sources: {
      hasRolesFile: Boolean(rolesFile && typeof rolesFile === 'object'),
      rolesUpdatedAt: typeof rolesFile?.updatedAt === 'string' ? rolesFile.updatedAt : null,
      hasPluginOptions: Boolean(pluginEntry),
    },
    status: status
      ? {
          version: status.version || null,
          state: status.state || 'unknown',
          detail: status.detail || status.reason || '',
          port: status.port || proxyPort || null,
          model: status.model || null,
          modelsCount: typeof status.models === 'number' ? status.models : models.length,
          cursorAuth: status.cursorAuth || 'unknown',
          heartbeat: status.heartbeat || null,
          roles: status.roles || null,
        }
      : null,
  };
}

function extractProxyPort(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  try {
    const parsed = Number(new URL(rawUrl).port);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Persist explicit role assignments atomically into `<rootDir>/roles.json`. */
export function writeRolesFile(rootDir, rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error('Role configuration must be a JSON object');
  }
  const normalized = normalizeRoleConfig(rawPayload);
  const record = {
    autoRouter: normalized.autoRouter,
    subagent: normalized.subagent,
    subagentTypes: normalized.subagentTypes,
    bugbot: normalized.bugbot,
    securitybot: normalized.securitybot,
    autoReview: normalized.autoReview,
    title: normalized.title,
    summarize: normalized.summarize,
    memory: normalized.memory,
    commit: normalized.commit,
    updatedAt: new Date().toISOString(),
  };
  atomicWrite(path.join(rootDir, 'roles.json'), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return record;
}

/**
 * Write the model catalogue and effective role map for the sandboxed Agents-page
 * panel. Magpie's plugin pages cannot reach loopback HTTP (`connect-src 'none'`),
 * so the host publishes this small JS asset beside the panel instead.
 */
export function publishCatalogAsset({
  uiDir = path.join(resolveSourceDir(), 'ui'),
  rootDir = resolveDefaultRoot(),
  homeDir = os.homedir(),
  includeMagpiePlugins = !process.env.CURSOR_BRIDGE_ROOT,
  pluginsJsonPath = process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
} = {}) {
  if (!uiDir) return { ok: false, error: 'missing_ui_dir' };
  const state = readSafeState({ rootDir, homeDir, includeMagpiePlugins, pluginsJsonPath });
  const status = state.status ? { ...state.status } : null;
  if (status) delete status.heartbeat;
  const payload = {
    enabled: state.enabled,
    defaultModel: state.defaultModel,
    models: state.models,
    roles: state.roles,
    sources: state.sources,
    status,
  };
  const content = `globalThis.CursorBridgeCatalog = ${JSON.stringify(payload)};\n`;
  const filePath = path.join(uiDir, CATALOG_ASSET);
  try {
    let previous = '';
    try {
      previous = fs.readFileSync(filePath, 'utf8');
    } catch {
      // First publish: no previous asset.
    }
    if (previous !== content) {
      fs.mkdirSync(uiDir, { recursive: true, mode: 0o700 });
      atomicWrite(filePath, content, { mode: 0o600 });
    }
    return { ok: true, file: filePath, changed: previous !== content };
  } catch (error) {
    return { ok: false, file: filePath, error: error?.message || String(error) };
  }
}

/** Keep the Agents-page panel's catalogue asset in step with connection.json. */
export function startCatalogPublisher({
  uiDir = path.join(resolveSourceDir(), 'ui'),
  rootDir = resolveDefaultRoot(),
  homeDir = os.homedir(),
  includeMagpiePlugins = !process.env.CURSOR_BRIDGE_ROOT,
  pluginsJsonPath = process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
  intervalMs = CATALOG_INTERVAL_MS,
  onLog = null,
} = {}) {
  let stopped = false;
  let warned = false;
  const publish = () => {
    if (stopped) return;
    const result = publishCatalogAsset({ uiDir, rootDir, homeDir, includeMagpiePlugins, pluginsJsonPath });
    if (!result.ok && !warned) {
      warned = true;
      onLog?.('warn', `cursor-bridge: cannot publish model catalogue (${result.error})`);
    }
    return result;
  };
  publish();
  const timer = setInterval(publish, intervalMs);
  timer.unref?.();
  return {
    refresh: publish,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function extractHostName(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const closingIndex = trimmed.indexOf(']');
    return closingIndex > 0 ? trimmed.slice(0, closingIndex + 1) : '';
  }
  const colonIndex = trimmed.indexOf(':');
  return colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

function isAllowedLoopbackRequest(req) {
  const hostName = extractHostName(req.headers.host);
  if (hostName && !LOOPBACK_HOSTS.has(hostName)) return false;
  const originHeader = req.headers.origin;
  if (originHeader === undefined || originHeader === 'null') return true;
  try {
    const originUrl = new URL(originHeader);
    return LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function buildCorsHeaders(req) {
  const headers = { Vary: 'Origin' };
  const originHeader = req.headers.origin;
  if (originHeader === undefined) return headers;
  if (originHeader === 'null') {
    headers['Access-Control-Allow-Origin'] = 'null';
  } else {
    try {
      const parsed = new URL(originHeader);
      if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
        headers['Access-Control-Allow-Origin'] = parsed.origin;
      }
    } catch {
      return headers;
    }
  }
  headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  headers['Access-Control-Max-Age'] = '600';
  return headers;
}

function resolveLocalRequestOrigin(req, fallbackHost, boundPort) {
  const rawHost = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  if (rawHost && LOOPBACK_HOSTS.has(extractHostName(rawHost))) {
    const validated = parseValidatedUiOrigin(`http://${rawHost}`);
    if (validated) return validated;
  }
  const cleanHost = fallbackHost.includes(':') && !fallbackHost.startsWith('[') ? `[${fallbackHost}]` : fallbackHost;
  return parseValidatedUiOrigin(`http://${cleanHost}:${boundPort}`) || `http://127.0.0.1:${boundPort}`;
}

function parseValidatedUiOrigin(rawOrigin) {
  if (!rawOrigin || typeof rawOrigin !== 'string') return '';
  try {
    const parsed = new URL(rawOrigin);
    if (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.hostname.includes('*') &&
      parsed.origin === rawOrigin
    ) {
      return parsed.origin;
    }
  } catch {
    // Ignore invalid uiOrigin query parameter.
  }
  return '';
}

function buildHtmlCsp(uiOrigin) {
  const list = Array.isArray(uiOrigin) ? uiOrigin.filter(Boolean) : [uiOrigin].filter(Boolean);
  const unique = [...new Set(list)];
  const extra = unique.length ? ` ${unique.join(' ')}` : '';
  return [
    `default-src 'none'`,
    `script-src 'self'${extra}`,
    `style-src 'self'${extra} 'unsafe-inline'`,
    `connect-src 'self'${extra}`,
    `img-src 'self'${extra} data:`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

function sendJson(res, statusCode, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        const tooLarge = new Error('Request body exceeds 64KB limit');
        tooLarge.statusCode = 413;
        req.destroy();
        fail(tooLarge);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const badJson = new Error('Invalid JSON payload');
        badJson.statusCode = 400;
        fail(badJson);
      }
    });
    req.on('error', fail);
  });
}

function serveStaticAsset(uiDir, assetSpec, res, { cspOrigins = [], headOnly = false, corsHeaders = {} } = {}) {
  const filePath = path.join(uiDir, assetSpec.file);
  try {
    const content = fs.readFileSync(filePath);
    const headers = {
      'Content-Type': assetSpec.type,
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    };
    if (assetSpec.type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = buildHtmlCsp(cspOrigins);
    } else {
      headers['Access-Control-Allow-Origin'] = '*';
    }
    res.writeHead(200, headers);
    res.end(headOnly ? undefined : content);
  } catch {
    sendJson(res, 404, { error: 'asset_missing' }, corsHeaders);
  }
}

function listenOnPort(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function probeExistingBridgeService(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.ok === true && body?.app === 'magpie-cursor-agent') {
      return body;
    }
  } catch {
    // Not listening or not our bridge service.
  }
  return null;
}

function buildEventSignature(state) {
  const status = state?.status ? { ...state.status } : null;
  if (status) delete status.heartbeat;
  return JSON.stringify({
    enabled: state?.enabled,
    defaultModel: state?.defaultModel,
    models: state?.models,
    roles: state?.roles,
    sources: state?.sources,
    status,
  });
}

/** Start the loopback-only HTTP service serving `/`, `/api/health`, `/api/state`, `/api/events`, and `/api/roles`. */
export async function createConfigService({
  rootDir = resolveDefaultRoot(),
  homeDir = os.homedir(),
  uiDir = path.join(resolveSourceDir(), 'ui'),
  port = DEFAULT_SERVICE_PORT,
  host = '127.0.0.1',
  includeMagpiePlugins = !process.env.CURSOR_BRIDGE_ROOT,
  pluginsJsonPath = process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
  allowPortFallback = true,
  onLog = null,
} = {}) {
  const version = readManifestVersion(resolveSourceDir());
  let boundPort = port;
  const sseClients = new Set();
  let sseTimer = null;
  let lastEventSignature = '';
  let lastPingAt = 0;

  const currentSafeState = () =>
    readSafeState({ rootDir, homeDir, includeMagpiePlugins, pluginsJsonPath });

  const writeSseChunk = (res, chunk) => {
    if (res.writableEnded || res.destroyed) {
      sseClients.delete(res);
      return;
    }
    try {
      res.write(chunk);
    } catch {
      sseClients.delete(res);
    }
  };

  const broadcastState = ({ force = false } = {}) => {
    if (sseClients.size === 0) return;
    const state = currentSafeState();
    const signature = buildEventSignature(state);
    if (!force && signature === lastEventSignature) return;
    lastEventSignature = signature;
    const chunk = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of [...sseClients]) {
      writeSseChunk(client, chunk);
    }
  };

  const stopSseLoop = () => {
    if (sseTimer) {
      clearInterval(sseTimer);
      sseTimer = null;
    }
  };

  const ensureSseLoop = () => {
    if (sseTimer || sseClients.size === 0) return;
    lastPingAt = Date.now();
    sseTimer = setInterval(() => {
      if (sseClients.size === 0) {
        stopSseLoop();
        return;
      }
      broadcastState();
      const now = Date.now();
      if (now - lastPingAt >= SSE_PING_INTERVAL_MS) {
        lastPingAt = now;
        for (const client of [...sseClients]) {
          writeSseChunk(client, ': ping\n\n');
        }
      }
    }, SSE_POLL_INTERVAL_MS);
    sseTimer.unref?.();
  };

  const dropSseClient = client => {
    sseClients.delete(client);
    if (sseClients.size === 0) stopSseLoop();
  };

  const server = http.createServer(async (req, res) => {
    const corsHeaders = buildCorsHeaders(req);
    if (!isAllowedLoopbackRequest(req)) {
      sendJson(res, 403, { error: 'forbidden_host_or_origin' }, { Vary: 'Origin' });
      return;
    }
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      res.writeHead(204, {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders,
      });
      res.end();
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && STATIC_ROUTES[pathname]) {
      const uiOrigin = parseValidatedUiOrigin(urlObj.searchParams.get('uiOrigin') || '');
      const localOrigin = resolveLocalRequestOrigin(req, host, boundPort);
      serveStaticAsset(uiDir, STATIC_ROUTES[pathname], res, {
        cspOrigins: [localOrigin, uiOrigin],
        headOnly: req.method === 'HEAD',
        corsHeaders,
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(
        res,
        200,
        {
          ok: true,
          app: 'magpie-cursor-agent',
          version,
        },
        corsHeaders
      );
      return;
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(
        res,
        200,
        currentSafeState(),
        corsHeaders
      );
      return;
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders,
      });
      if (sseClients.size >= 16) {
        const oldest = sseClients.values().next().value;
        if (oldest) {
          dropSseClient(oldest);
          try {
            oldest.end();
          } catch {
            // Ignore closed stream.
          }
        }
      }
      const initialState = currentSafeState();
      lastEventSignature = buildEventSignature(initialState);
      sseClients.add(res);
      writeSseChunk(res, `event: state\ndata: ${JSON.stringify(initialState)}\n\n`);
      ensureSseLoop();
      req.on('close', () => dropSseClient(res));
      res.on('close', () => dropSseClient(res));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/roles') {
      try {
        const payload = await readJsonBody(req);
        const saved = writeRolesFile(rootDir, payload);
        broadcastState({ force: true });
        sendJson(res, 200, { ok: true, roles: saved }, corsHeaders);
      } catch (error) {
        sendJson(res, error?.statusCode || 400, { error: error?.message || 'invalid_roles' }, corsHeaders);
      }
      return;
    }
    sendJson(res, 404, { error: 'not_found' }, corsHeaders);
  });

  try {
    boundPort = await listenOnPort(server, host, port);
  } catch (error) {
    if (error?.code === 'EADDRINUSE' && allowPortFallback && port !== 0) {
      onLog?.('warn', `cursor-bridge: port ${port} already in use, falling back to ephemeral port`);
      boundPort = await listenOnPort(server, host, 0);
    } else {
      throw error;
    }
  }

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise(resolve => {
        stopSseLoop();
        for (const client of [...sseClients]) {
          try {
            client.end();
          } catch {
            // Ignore already-closed stream.
          }
        }
        sseClients.clear();
        server.close(() => resolve());
      }),
  };
}

/** Parse `servicePort` option with fallback to default port 19381. */
export function parseRequestedPort(options) {
  const candidate = Number(options?.servicePort);
  if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
    return candidate;
  }
  return DEFAULT_SERVICE_PORT;
}

/**
 * Start or hand off the config service on `port`.
 * When an outgoing plugin-host still holds `port` during a Magpie recycle, stay attached
 * and reclaim `port` as soon as it closes instead of abandoning it for a random port.
 */
export async function startManagedConfigService({
  rootDir = resolveDefaultRoot(),
  homeDir = os.homedir(),
  uiDir = path.join(resolveSourceDir(), 'ui'),
  port = DEFAULT_SERVICE_PORT,
  host = '127.0.0.1',
  includeMagpiePlugins = !process.env.CURSOR_BRIDGE_ROOT,
  pluginsJsonPath = process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
  reclaimIntervalMs = RECLAIM_INTERVAL_MS,
  onLog = null,
} = {}) {
  let activeService = null;
  let closed = false;
  let timer = null;
  let reclaiming = false;

  const clearReclaimTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tryBindExact = async () => {
    const service = await createConfigService({
      rootDir,
      homeDir,
      uiDir,
      port,
      host,
      includeMagpiePlugins,
      pluginsJsonPath,
      allowPortFallback: false,
      onLog,
    });
    if (closed) {
      await service.close();
      return null;
    }
    service.server.unref?.();
    activeService = service;
    clearReclaimTimer();
    onLog?.('info', `cursor-bridge: config service listening on http://${host}:${service.port}`);
    return service;
  };

  try {
    await tryBindExact();
    return {
      get port() {
        return activeService?.port ?? port;
      },
      get role() {
        return activeService ? 'owner' : 'attached';
      },
      close: async () => {
        closed = true;
        clearReclaimTimer();
        await activeService?.close();
        activeService = null;
      },
    };
  } catch (error) {
    if (error?.code !== 'EADDRINUSE' || port === 0) {
      throw error;
    }
  }

  const peerHealth = await probeExistingBridgeService(host, port);
  if (!peerHealth) {
    const fallback = await createConfigService({
      rootDir,
      homeDir,
      uiDir,
      port,
      host,
      includeMagpiePlugins,
      pluginsJsonPath,
      allowPortFallback: true,
      onLog,
    });
    fallback.server.unref?.();
    onLog?.('info', `cursor-bridge: config service listening on http://${host}:${fallback.port}`);
    return {
      get port() {
        return fallback.port;
      },
      get role() {
        return 'fallback';
      },
      close: async () => {
        await fallback.close();
      },
    };
  }

  onLog?.('info', `cursor-bridge: port ${port} held by previous host, waiting to reclaim`);
  timer = setInterval(async () => {
    if (closed || activeService || reclaiming) return;
    reclaiming = true;
    try {
      await tryBindExact();
    } catch {
      // Previous host is still draining; retry on next tick.
    } finally {
      reclaiming = false;
    }
  }, reclaimIntervalMs);
  timer.unref?.();

  return {
    get port() {
      return activeService?.port ?? port;
    },
    get role() {
      return activeService ? 'owner' : 'attached';
    },
    close: async () => {
      closed = true;
      clearReclaimTimer();
      await activeService?.close();
      activeService = null;
    },
  };
}
