#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { atomicWrite, applyProxy, restoreProxy, clearStaleProxy } from './lib/settings.js';
import { loadMergedRoles, validateConfig, fetchGatewayModels } from './lib/config.js';
import { claimLock, isLockHeld, releaseLock } from './lib/lock.js';
import { readMagpieWired, nextMagpieGate } from './lib/magpie.js';
import { shouldRevive } from './lib/watch.js';
import { isPortAvailable, listenWithFallback } from './lib/relay.js';

const rawRelayPort = process.env.CURSOR_BRIDGE_RELAY_PORT;
const parsedRelayPort = rawRelayPort !== undefined && rawRelayPort !== '' ? Number(rawRelayPort) : 52407;
const relayPort = Number.isInteger(parsedRelayPort) && parsedRelayPort >= 0 ? parsedRelayPort : 52407;
const packageDir = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
const root =
  process.env.CURSOR_BRIDGE_ROOT || path.join(os.homedir(), '.config', 'magpie-cursor-bridge');
const defaultSettings =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'settings.json')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'settings.json')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'settings.json');
const settingsPath = process.env.CURSOR_BRIDGE_SETTINGS || defaultSettings;
const engineScript = path.join(packageDir, 'engine.js');
const stateFile = name => path.join(root, name);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let lastStatusSignature = '';
let lastStatusWriteAt = 0;

function publishStatus(state, extra = {}, { force = false } = {}) {
  const now = Date.now();
  const signature = JSON.stringify({ version, state, ...extra });
  if (!force && signature === lastStatusSignature && now - lastStatusWriteAt < 10000) {
    return;
  }
  atomicWrite(
    stateFile('status.json'),
    JSON.stringify({ version, state, ...extra, updated: new Date(now).toISOString(), heartbeat: now }, null, 2),
    { mode: 0o600 }
  );
  lastStatusSignature = signature;
  lastStatusWriteAt = now;
}

async function runSupervise() {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (typeof process.umask === 'function') {
    try {
      process.umask(0o077);
    } catch {
      // Ignore unsupported umask changes.
    }
  }
  const lockDir = stateFile('supervisor.lock');
  const owner = claimLock(lockDir);

  let watchSpawnedAt = 0;
  let engineChild = null;
  let readyInfo = null;
  let ending = false;
  let lastConfigRaw = '';
  let lastRolesSignature = '';
  let nextRefreshAt = 0;
  let paused = false;
  let lastModelCount = 0;
  let pausedRetries = 0;
  let magpieGate = null;
  let engineProxyUrl = null;
  let relayHandle = null;
  let lastEffective = null;
  let cursorRestarted = false;

  const pauseLimit = 30;

  const defaultRoot = path.join(os.homedir(), '.config', 'magpie-cursor-bridge');
  const allowPluginsJson =
    Boolean(process.env.CURSOR_BRIDGE_PLUGINS_JSON) ||
    path.resolve(root) === path.resolve(defaultRoot);
  const readCurrentRoles = configRoles =>
    loadMergedRoles({
      rootDir: root,
      configRoles,
      includeMagpiePlugins: allowPluginsJson,
      pluginsJsonPath: process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
    });

  function watchAlive() {
    return isLockHeld(stateFile('watchdog.lock/owner.json'));
  }

  function ensureWatch() {
    if (process.env.CURSOR_BRIDGE_NO_WATCHDOG === '1') return;
    if (watchAlive()) return;
    if (Date.now() - watchSpawnedAt < 15000) return;
    watchSpawnedAt = Date.now();
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, CURSOR_BRIDGE_ROOT: root, CURSOR_BRIDGE_SETTINGS: settingsPath },
      });
      child.unref();
    } catch {
      // Next loop pass retries.
    }
  }

  function reloadCursor() {
    if (process.env.CURSOR_BRIDGE_RESTART_CURSOR !== '1') return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/F', '/T', '/IM', 'Cursor.exe'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on?.('error', () => {});
      } else if (process.platform === 'darwin') {
        const killer = spawn('pkill', ['-x', 'Cursor'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on?.('error', () => {});
      }
    } catch {
      // Cursor may not be running.
    }
  }

  function ensureCursorReadsNewProxy(changed) {
    if (!changed || cursorRestarted) return;
    cursorRestarted = true;
    reloadCursor();
  }

  function allowCursorRestart() {
    cursorRestarted = false;
  }

  function publicProxyUrl() {
    return relayHandle ? `http://127.0.0.1:${relayHandle.port}` : readyInfo.proxy;
  }

  async function publishProxy(proxyUrl) {
    engineProxyUrl = proxyUrl;
    const upstreamPort = Number(new URL(proxyUrl).port);
    if (relayHandle) {
      if (relayPort > 0 && relayHandle.port !== relayPort && (await isPortAvailable(relayPort))) {
        const migrated = await listenWithFallback(
          () => (engineProxyUrl ? Number(new URL(engineProxyUrl).port) : upstreamPort),
          relayPort,
          { attempts: 1, delayMs: 0 }
        );
        if (migrated.fixed) {
          const oldRelay = relayHandle;
          relayHandle = { server: migrated.relay, port: migrated.port };
          try {
            await oldRelay.server.close();
          } catch {
            // Ignore old relay close errors.
          }
        } else {
          try {
            await migrated.relay.close();
          } catch {
            // Ignore unused fallback relay close errors.
          }
        }
      }
      return applyProxy(settingsPath, stateFile('settings-journal.json'), `http://127.0.0.1:${relayHandle.port}`);
    }
    const { relay, port, fixed } = await listenWithFallback(
      () => (engineProxyUrl ? Number(new URL(engineProxyUrl).port) : upstreamPort),
      relayPort
    );
    relayHandle = { server: relay, port };
    if (!fixed) {
      publishStatus(
        'starting',
        { reason: `端口 ${relayPort} 暂不可用，本次使用 ${port}；端口释放后会恢复` },
        { force: true }
      );
    }
    return applyProxy(settingsPath, stateFile('settings-journal.json'), `http://127.0.0.1:${port}`);
  }

  async function closeRelay() {
    const oldRelay = relayHandle;
    relayHandle = null;
    if (oldRelay) {
      try {
        await oldRelay.server.close();
      } catch {
        // Ignore relay close errors.
      }
    }
  }

  async function stopEngine() {
    const oldChild = engineChild;
    engineChild = null;
    readyInfo = null;
    try {
      const journalFile = stateFile('settings-journal.json');
      if (fs.existsSync(journalFile)) {
        const removed = restoreProxy(journalFile);
        ensureCursorReadsNewProxy(true);
        return removed;
      }
      const cleared = clearStaleProxy(settingsPath);
      if (cleared.length > 0) ensureCursorReadsNewProxy(true);
      return cleared;
    } finally {
      if (oldChild && oldChild.exitCode === null && oldChild.signalCode === null) {
        if (process.platform === 'win32') {
          try {
            const killer = spawn('taskkill', ['/F', '/T', '/PID', String(oldChild.pid)], {
              stdio: 'ignore',
              windowsHide: true,
            });
            killer.on?.('error', () => {
              try {
                oldChild.kill();
              } catch {
                // Ignore exit races.
              }
            });
            let killTimer = null;
            await Promise.race([
              new Promise(resolve => oldChild.once('exit', resolve)),
              new Promise(resolve => killer.once?.('exit', resolve)),
              new Promise(resolve => {
                killTimer = setTimeout(resolve, 5000);
                killTimer.unref?.();
              }),
            ]);
            if (killTimer) clearTimeout(killTimer);
          } catch {
            try {
              oldChild.kill();
            } catch {
              // Ignore exit races.
            }
          }
        } else {
          oldChild.kill('SIGTERM');
          let killTimer = null;
          await Promise.race([
            new Promise(resolve => oldChild.once('exit', resolve)),
            new Promise(resolve => {
              killTimer = setTimeout(resolve, 12000);
              killTimer.unref?.();
            }),
          ]);
          if (killTimer) clearTimeout(killTimer);
          if (oldChild.exitCode === null && oldChild.signalCode === null) {
            oldChild.kill('SIGKILL');
            await new Promise(resolve => oldChild.once('exit', resolve));
          }
        }
      }
    }
  }

  async function startEngine(config) {
    atomicWrite(stateFile('effective.json'), JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, [engineScript, stateFile('effective.json')], {
      env: { ...process.env, CURSOR_BYOK_DATA_DIR: stateFile('data') },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    engineChild = child;
    child.stderr.resume();

    readyInfo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge startup timed out')), 30000);
      const lines = createInterface({ input: child.stdout });
      const finish = fn => {
        clearTimeout(timer);
        lines.close();
        fn();
      };
      lines.on('line', line => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'ready') {
            finish(() => resolve(msg));
          }
        } catch {
          // Ignore non-JSON lines.
        }
      });
      child.once('error', () => {
        finish(() => reject(new Error('cannot start bridge engine')));
      });
      child.once('exit', (code, signal) => {
        finish(() => reject(new Error(`bridge engine exited before ready (${signal || code})`)));
      });
    });

    await publishProxy(readyInfo.proxy);
    allowCursorRestart();
    ensureCursorReadsNewProxy(true);
  }

  ensureWatch();

  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, () => {
      ending = true;
    });
  }

  const panicRestore = () => {
    try {
      const journalFile = stateFile('settings-journal.json');
      if (fs.existsSync(journalFile)) restoreProxy(journalFile);
      else clearStaleProxy(settingsPath);
    } catch {
      // Best-effort cleanup on abrupt exit.
    }
  };
  process.on('exit', panicRestore);
  process.on('uncaughtException', error => {
    panicRestore();
    publishStatus('error', { reason: error?.message || String(error) }, { force: true });
    process.exit(1);
  });
  process.on('unhandledRejection', () => {});

  try {
    restoreProxy(stateFile('settings-journal.json'));
    publishStatus('starting', { reason: '正在启动后台桥接' }, { force: true });

    while (!ending) {
      ensureWatch();
      try {
        const gate = nextMagpieGate(magpieGate, readMagpieWired());
        magpieGate = gate.next;
        if (gate.hold) {
          await stopEngine();
          publishStatus('disconnected', { reason: '已在 Magpie 中关闭接入' }, { force: true });
          paused = false;
          lastConfigRaw = '';
          lastModelCount = 0;
          if (!ending) await delay(600);
          continue;
        }

        const raw = fs.existsSync(stateFile('connection.json'))
          ? fs.readFileSync(stateFile('connection.json'), 'utf8')
          : '{}';
        const config = validateConfig(JSON.parse(raw));

        if (!config) {
          await stopEngine();
          publishStatus('disconnected', {}, { force: true });
          paused = false;
          lastConfigRaw = '';
          lastRolesSignature = '';
        } else if (paused && raw === lastConfigRaw) {
          pausedRetries += 1;
          if (pausedRetries >= pauseLimit) {
            try {
              fs.rmSync(stateFile('settings-journal.json'), { force: true });
            } catch {
              // Ignore cleanup error.
            }
            paused = false;
            pausedRetries = 0;
            lastConfigRaw = '';
          } else {
            publishStatus('paused', { reason: 'Cursor 代理设置被其他程序改动，正在重试接管…' });
          }
        } else {
          const changed = raw !== lastConfigRaw;
          const mergedRoles = readCurrentRoles(config.roles || config);
          const rolesSignature = JSON.stringify(mergedRoles);
          const rolesChanged = rolesSignature !== lastRolesSignature;
          const childDead =
            !engineChild || engineChild.exitCode !== null || engineChild.signalCode !== null;
          if (changed || rolesChanged || Date.now() >= nextRefreshAt || childDead) {
            let refreshed;
            try {
              refreshed = await fetchGatewayModels(config);
            } catch {
              refreshed = !changed && lastEffective ? lastEffective : config;
            }
            const effective = { ...refreshed, roles: mergedRoles };
            lastEffective = effective;
            nextRefreshAt = Date.now() + 4000;
            if (childDead) {
              await stopEngine();
              await startEngine(effective);
            } else {
              atomicWrite(stateFile('effective.json'), JSON.stringify(effective), { mode: 0o600 });
            }
            lastConfigRaw = raw;
            lastRolesSignature = rolesSignature;
            paused = false;
            lastModelCount = effective.models.length;
            pausedRetries = 0;
            publishStatus(
              'connected',
              {
                model: config.model,
                models: lastModelCount,
                roles: mergedRoles,
                proxy: publicProxyUrl(),
                backend: readyInfo.backend,
                pid: engineChild.pid,
              },
              { force: true }
            );
          } else {
            if (relayPort > 0 && relayHandle && relayHandle.port !== relayPort && engineProxyUrl) {
              await publishProxy(engineProxyUrl);
            }
            publishStatus('connected', {
              model: config.model,
              models: lastModelCount,
              roles: mergedRoles,
              proxy: publicProxyUrl(),
              backend: readyInfo.backend,
              pid: engineChild.pid,
            });
          }
          try {
            ensureCursorReadsNewProxy(
              applyProxy(settingsPath, stateFile('settings-journal.json'), publicProxyUrl())
            );
          } catch (error) {
            await stopEngine();
            paused = true;
            lastConfigRaw = raw;
            throw error;
          }
        }
      } catch (error) {
        try {
          await stopEngine();
        } catch {
          // Keep journal intact for recovery if settings.json is malformed.
        }
        publishStatus('error', { reason: error.message }, { force: true });
      }

      if (!ending) await delay(600);
    }
  } finally {
    await stopEngine();
    await closeRelay();
    publishStatus('stopped', {}, { force: true });
    releaseLock(lockDir, owner);
  }
}

async function runWatch() {
  if (process.env.CURSOR_BRIDGE_NO_WATCHDOG === '1') process.exit(0);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let watchOwner;
  try {
    watchOwner = claimLock(stateFile('watchdog.lock'));
  } catch {
    process.exit(0);
  }

  let ending = false;
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGTERM', 'SIGINT'];
  for (const signal of signals) {
    process.on(signal, () => {
      ending = true;
    });
  }
  const scriptPath = fileURLToPath(import.meta.url);
  while (!ending) {
    let revive = false;
    try {
      if (!isLockHeld(stateFile('supervisor.lock/owner.json'))) {
        let recorded = null;
        try {
          recorded = JSON.parse(fs.readFileSync(stateFile('status.json'), 'utf8'));
        } catch {
          recorded = null;
        }
        revive = shouldRevive(recorded);
      }
    } catch {
      revive = false;
    }

    if (revive) {
      try {
        const child = spawn(process.execPath, [scriptPath, 'supervise'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, CURSOR_BRIDGE_ROOT: root, CURSOR_BRIDGE_SETTINGS: settingsPath },
        });
        child.unref();
        fs.appendFileSync(stateFile('watchdog.log'), `${new Date().toISOString()} relaunch\n`, {
          mode: 0o600,
        });
      } catch {
        // Retry on next cycle.
      }
      await delay(15000);
    } else {
      await delay(5000);
    }
  }
  releaseLock(stateFile('watchdog.lock'), watchOwner);
}

const command = process.argv[2] || 'status';
if (command === 'status') {
  console.log(
    fs.existsSync(stateFile('status.json'))
      ? fs.readFileSync(stateFile('status.json'), 'utf8')
      : '未安装或尚未运行'
  );
} else if (command === 'restore') {
  console.log(JSON.stringify({ preservedExternalChanges: restoreProxy(stateFile('settings-journal.json')) }));
} else if (command === 'supervise') {
  await runSupervise();
} else if (command === 'watch') {
  await runWatch();
} else {
  throw new Error('usage: node bridge.js status|supervise|restore|watch');
}
