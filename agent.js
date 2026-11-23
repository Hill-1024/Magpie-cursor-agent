export const agent = {
  id: 'cursor-bridge',
  name: 'Cursor · Magpie Bridge',
  icon: 'data:image/png;base64,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',
  bin: 'cursor',
  dir: '~/.cursor',
  config: '~/.config/magpie-cursor-bridge/connection.json',
  format: 'json',
  model: 'model',
  ua: ['cursor-magpie-bridge'],
  notice:
    '打开开关即可接管 Cursor，无需重启。首次会自动安装后台桥接（约几十秒）；若弹出证书确认，选“是”。就绪后在 Cursor 里打开对话面板或点一下模型下拉框，Magpie 的模型就会出现在列表里。',
};

export function connect({ gateway, models }) {
  start();
  return {
    enabled: true,
    gateway: gateway.v1,
    key: gateway.key,
    models: models.map(entry => ({
      id: entry.id,
      name: entry.name || entry.id,
      context: entry.context || null,
    })),
  };
}

function start() {
  Promise.resolve()
    .then(async () => {
      if (process.env.MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART) return;
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const { spawn, execFileSync } = await import('node:child_process');
      const root =
        process.env.CURSOR_BRIDGE_ROOT || path.join(os.homedir(), '.config', 'magpie-cursor-bridge');

      if (isSupervisorAlive(fs, path, execFileSync, root) && mismatchedVersion(fs, path, root) === null) {
        pollUntilSettled(fs, path, root, Date.now());
        return;
      }

      const releaseDir = findStagedRelease(fs, path, root);
      const launchedAt = Date.now();
      if (releaseDir) {
        launchSupervisor(fs, path, spawn, pickRuntime(fs, path, releaseDir), releaseDir, root);
        pollUntilSettled(fs, path, root, launchedAt);
        return;
      }

      await runInitialSetup(fs, path, spawn, root);
      pollUntilSettled(fs, path, root, launchedAt);
    })
    .catch(error => {
      recordFailure(error);
    });
}

function pollUntilSettled(fs, path, root, sinceMs) {
  const statusFile = path.join(root, 'status.json');
  const checkSettled = () => {
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      if (!(Number(status.heartbeat) >= sinceMs)) return null;
      return ['connected', 'error', 'paused'].includes(status.state) ? status.state : null;
    } catch {
      return null;
    }
  };
  let attempts = 0;
  const tick = () => {
    if (checkSettled() || ++attempts > 60) return;
    setTimeout(tick, 1000).unref?.();
  };
  setTimeout(tick, 1000).unref?.();
}

function recordFailure(error, fs, path, root) {
  try {
    const appendLog = (fsMod, pathMod, rootDir) => {
      fsMod.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
      fsMod.writeFileSync(
        pathMod.join(rootDir, 'autostart.log'),
        `${new Date().toISOString()} ${error?.message || error}\n`,
        { flag: 'a' }
      );
    };
    if (fs && path && root) {
      appendLog(fs, path, root);
      return;
    }
    import('node:fs')
      .then(async fsMod => {
        const osMod = await import('node:os');
        const pathMod = await import('node:path');
        appendLog(
          fsMod,
          pathMod,
          process.env.CURSOR_BRIDGE_ROOT ||
            pathMod.join(osMod.homedir(), '.config', 'magpie-cursor-bridge')
        );
      })
      .catch(() => {});
  } catch {
    // Never break Magpie's connect() return path on logging error.
  }
}

function isSupervisorAlive(fs, path, execFileSync, root) {
  const lockDir = path.join(root, 'supervisor.lock');
  let pid = 0;
  let start = null;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    pid = Number(owner.pid);
    start = owner.start || null;
  } catch {
    try {
      pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'));
    } catch {
      return false;
    }
  }
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!start) return true;
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'powershell' : 'ps',
      process.platform === 'win32'
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName+'|'+$p.StartTime.ToUniversalTime().ToString('o')`,
          ]
        : ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim() === start;
  } catch {
    return true;
  }
}

function mismatchedVersion(fs, path, root) {
  const current = readManifestVersion(fs, path);
  if (!current) return null;
  let status;
  try {
    status = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
  const active = typeof status.version === 'string' ? status.version : null;
  if (!active || active === current) return null;
  return active;
}

function findStagedRelease(fs, path, root) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, 'installation.json'), 'utf8'));
    const releaseDir = record.release;
    if (!releaseDir) return null;
    if (!fs.existsSync(path.join(releaseDir, 'bridge.js'))) return null;
    if (!fs.existsSync(path.join(releaseDir, 'engine.js'))) return null;
    const current = readManifestVersion(fs, path);
    if (current && record.version !== current) return null;
    return releaseDir;
  } catch {
    return null;
  }
}

function readManifestVersion(fs, path) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(sourceDirectory(path), 'package.json'), 'utf8')
    );
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function pickRuntime(fs, path, releaseDir) {
  const runtimeName = process.platform === 'win32' ? 'runtime.exe' : 'runtime';
  const bundled = path.join(releaseDir, 'bin', runtimeName);
  return fs.existsSync(bundled) ? bundled : process.execPath;
}

async function runInitialSetup(fs, path, spawn, root) {
  const here = sourceDirectory(path);
  const installer = path.join(here, 'install.js');
  if (!fs.existsSync(installer)) return;
  const runtime = findMagpieBun(fs, path) || process.execPath;
  await new Promise(resolve => {
    const env = { ...process.env };
    if (process.env.CURSOR_BRIDGE_ROOT) env.CURSOR_BRIDGE_ROOT = root;
    else delete env.CURSOR_BRIDGE_ROOT;
    const child = spawn(runtime, [installer, 'setup'], {
      cwd: here,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.on?.('error', resolve);
    child.on?.('exit', resolve);
    child.unref?.();
    const timer = setTimeout(resolve, 60000);
    timer.unref?.();
  });
}

function launchSupervisor(fs, path, spawn, runtime, releaseDir, root) {
  const child = spawn(runtime, [path.join(releaseDir, 'bridge.js'), 'supervise'], {
    cwd: releaseDir,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CURSOR_BRIDGE_ROOT: root },
  });
  child.on?.('error', error => recordFailure(error, fs, path, root));
  child.unref?.();
}

function sourceDirectory(path) {
  const url = new URL(import.meta.url);
  const filePath = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
  return path.dirname(filePath);
}

function findMagpieBun(fs, path) {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
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
