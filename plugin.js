import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMergedRoles, normalizeRoleConfig, readMagpiePluginOptions } from './lib/config.js';
import { isLockHeld, isProcessAlive } from './lib/lock.js';
import { atomicWrite } from './lib/settings.js';

const PLUGIN_GUARD = Symbol.for('magpie.cursor-bridge.plugin.v1');
const DEFAULT_SERVICE_PORT = 19381;
const MAX_BODY_BYTES = 65536;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const STATIC_ROUTES = {
  '/': { file: 'service.html', type: 'text/html; charset=utf-8' },
  '/service.html': { file: 'service.html', type: 'text/html; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/shared.js': { file: 'shared.js', type: 'application/javascript; charset=utf-8' },
  '/service.js': { file: 'service.js', type: 'application/javascript; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml; charset=utf-8' },
};

function resolveSourceDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveDefaultRoot(homeDir = os.homedir()) {
  return process.env.CURSOR_BRIDGE_ROOT || path.join(homeDir, '.config', 'magpie-cursor-bridge');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readManifestVersion(sourceDir) {
  const manifest = readJsonSafe(path.join(sourceDir, 'package.json'));
  return typeof manifest?.version === 'string' ? manifest.version : null;
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

function needsVersionUpgrade(sourceDir, rootDir) {
  const current = readManifestVersion(sourceDir);
  if (!current) return false;
  const status = readJsonSafe(path.join(rootDir, 'status.json'));
  const active = typeof status?.version === 'string' ? status.version : null;
  return Boolean(active && active !== current);
}

function findStagedRelease(sourceDir, rootDir) {
  const record = readJsonSafe(path.join(rootDir, 'installation.json'));
  const releaseDir = record?.release;
  if (!releaseDir) return null;
  if (!fs.existsSync(path.join(releaseDir, 'bridge.js'))) return null;
  if (!fs.existsSync(path.join(releaseDir, 'engine.js'))) return null;
  const current = readManifestVersion(sourceDir);
  if (current && record.version !== current) return null;
  return releaseDir;
}

function pickRuntime(releaseDir) {
  const runtimeName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
  const bundled = path.join(releaseDir, 'bin', runtimeName);
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

function findMagpieBun(homeDir = os.homedir()) {
  const bases = [
    path.join(homeDir, 'Desktop', 'data', 'cache', 'bun'),
    path.join(homeDir, '.cache', 'magpie', 'bun'),
    path.join(process.env.LOCALAPPDATA || '', 'magpie', 'bun'),
  ];
  for (const base of bases) {
    let versions = [];
    try {
      versions = fs.readdirSync(base).sort().reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const name of ['magpie-bun.exe', 'magpie-bun']) {
        const candidate = path.join(base, version, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function runInitialSetup(sourceDir, rootDir, homeDir) {
  const installer = path.join(sourceDir, 'install.js');
  if (!fs.existsSync(installer)) return Promise.resolve();
  const runtime = findMagpieBun(homeDir) || process.execPath;
  return new Promise(resolve => {
    const env = { ...process.env };
    if (process.env.CURSOR_BRIDGE_ROOT) env.CURSOR_BRIDGE_ROOT = rootDir;
    else delete env.CURSOR_BRIDGE_ROOT;
    const child = spawn(runtime, [installer, 'setup'], {
      cwd: sourceDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.on('error', error => {
      recordFailure(rootDir, error);
      resolve();
    });
    child.on('exit', () => resolve());
    child.unref();
    const timer = setTimeout(resolve, 60000);
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
    if (isSupervisorRunning(rootDir) && !needsVersionUpgrade(sourceDir, rootDir)) {
      return { action: 'running' };
    }
    const releaseDir = findStagedRelease(sourceDir, rootDir);
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
    onLog?.('info', 'cursor-bridge: launching initial setup');
    await runInitialSetup(sourceDir, rootDir, homeDir);
    return { action: 'setup' };
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
  const connection = readJsonSafe(path.join(rootDir, 'connection.json'));
  const status = readJsonSafe(path.join(rootDir, 'status.json'));
  const rolesFile = readJsonSafe(path.join(rootDir, 'roles.json'));
  const pluginEntry =
    includeMagpiePlugins || pluginsJsonPath ? readMagpiePluginOptions(homeDir, pluginsJsonPath) : null;

  const models = Array.isArray(connection?.models)
    ? connection.models
        .filter(entry => entry && typeof entry.id === 'string' && entry.id.trim())
        .map(entry => ({
          id: entry.id,
          name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
          context: entry.context ?? null,
        }))
    : [];

  const roles = loadMergedRoles({
    rootDir,
    homeDir,
    configRoles: connection?.roles || null,
    includeMagpiePlugins,
    pluginsJsonPath,
  });

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
          detail: status.detail || '',
          port: status.port || null,
          model: status.model || null,
          cursorAuth: status.cursorAuth || 'unknown',
          heartbeat: status.heartbeat || null,
          roles: status.roles || null,
        }
      : null,
  };
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

function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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

function serveStaticAsset(uiDir, assetSpec, res) {
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
      headers['Content-Security-Policy'] =
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'asset_missing' });
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

/** Start the loopback-only HTTP service serving `/`, `/api/state`, and `/api/roles`. */
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
  const server = http.createServer(async (req, res) => {
    if (!isAllowedLoopbackRequest(req)) {
      sendJson(res, 403, { error: 'forbidden_host_or_origin' });
      return;
    }
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && STATIC_ROUTES[pathname]) {
      serveStaticAsset(uiDir, STATIC_ROUTES[pathname], res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/state') {
      sendJson(
        res,
        200,
        readSafeState({ rootDir, homeDir, includeMagpiePlugins, pluginsJsonPath })
      );
      return;
    }
    if (req.method === 'POST' && pathname === '/api/roles') {
      try {
        const payload = await readJsonBody(req);
        const saved = writeRolesFile(rootDir, payload);
        sendJson(res, 200, { ok: true, roles: saved });
      } catch (error) {
        sendJson(res, error?.statusCode || 400, { error: error?.message || 'invalid_roles' });
      }
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  });

  let boundPort;
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
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function parseRequestedPort(options) {
  const candidate = Number(options?.servicePort);
  if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
    return candidate;
  }
  return DEFAULT_SERVICE_PORT;
}

/** Magpie Bun Host plugin entry point. */
export default async function magpieCursorBridgePlugin(input, options = {}) {
  if (globalThis[PLUGIN_GUARD]) return {};
  globalThis[PLUGIN_GUARD] = true;

  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: 'cursor-bridge', level, message } })?.catch?.(() => {});
    } catch {
      // Logging errors must never disrupt Magpie plugin host startup.
    }
  };

  const rootDir = resolveDefaultRoot();
  const sourceDir = resolveSourceDir();
  const port = parseRequestedPort(options);

  try {
    const service = await createConfigService({
      rootDir,
      uiDir: path.join(sourceDir, 'ui'),
      port,
      onLog: log,
    });
    service.server.unref?.();
    globalThis[PLUGIN_GUARD] = { service };
    log('info', `cursor-bridge: config service listening on http://127.0.0.1:${service.port}`);
  } catch (error) {
    log('warn', `cursor-bridge: config service failed (${error?.message || error})`);
  }

  ensureBridgeStarted({ rootDir, sourceDir, onLog: log }).catch(() => {});
  return {};
}
