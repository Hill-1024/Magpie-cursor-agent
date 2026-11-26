import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { atomicWrite, restoreProxy } from './settings.js';
import { processStartTime } from './lock.js';
import { stageRuntimeBinary } from './runtime.js';
import { magpiePluginsCandidates } from './config.js';

export const label = 'local.magpie.cursor-bridge';

export const payload = [
  'agent.js',
  'plugin.js',
  'bridge.js',
  'engine.js',
  'install.js',
  'setup.command',
  'setup.ps1',
  'setup.cmd',
  'package.json',
  'integrity.json',
  'lib',
  'ui',
  'icon.svg',
  'icon.png',
  'README.md',
  'LICENSE',
];

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0 && !options.optional) {
    const detail = result.stderr || result.stdout || result.error?.message || '';
    throw new Error(`${path.basename(command)} failed: ${detail.slice(0, 1000)}`);
  }
  return result;
}

function isRealProfile(homeDir) {
  return path.resolve(homeDir) === path.resolve(os.homedir());
}

export function paths(homeDir) {
  const isWin = process.platform === 'win32';
  const appData = isRealProfile(homeDir)
    ? process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    : path.join(homeDir, 'AppData', 'Roaming');
  return {
    home: homeDir,
    root: path.join(homeDir, '.config', 'magpie-cursor-bridge'),
    target: path.join(homeDir, '.local', 'share', 'magpie-cursor-bridge'),
    plist: path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`),
    startupScript: isWin
      ? path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${label}.vbs`)
      : null,
  };
}

export function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Verify package structure, manifest version, source file SHA-256 digests, and engine version. */
export function verifyPackage(sourceDir, exec = runCommand, runtime = process.execPath) {
  for (const name of payload) {
    fs.accessSync(path.join(sourceDir, name), fs.constants.R_OK);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('无效的发布版本');
  }
  const checksums = JSON.parse(fs.readFileSync(path.join(sourceDir, 'integrity.json'), 'utf8'));
  if (checksums.version && checksums.version !== manifest.version) {
    throw new Error(`版本清单不匹配：期望 ${manifest.version}，实际 ${checksums.version}`);
  }
  if (checksums.files && typeof checksums.files === 'object') {
    for (const [relPath, expectedDigest] of Object.entries(checksums.files)) {
      const fullPath = path.join(sourceDir, relPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`缺少校验文件: ${relPath}`);
      }
      const actualDigest = sha256File(fullPath);
      if (actualDigest !== expectedDigest) {
        throw new Error(`文件校验失败 (${relPath})，请检查安装包完整性`);
      }
    }
  }
  const engineScript = path.join(sourceDir, 'engine.js');
  const reported = exec(runtime, [engineScript, '--version']).stdout.trim();
  if (reported !== manifest.version) {
    throw new Error(`后台程序版本与安装包不符：期望 ${manifest.version}，实际 ${reported}`);
  }
  return manifest;
}

/** Initialize local CA via `engine.js --init-ca` and ensure OS trust when requested. */
export function initializeCertificate(
  engineScript,
  pathsObj,
  exec = runCommand,
  { trust = true, runtime = process.execPath } = {}
) {
  const inspect = () => {
    const output = exec(runtime, [engineScript, '--init-ca'], {
      env: { ...process.env, CURSOR_BYOK_DATA_DIR: path.join(pathsObj.root, 'data') },
    });
    return JSON.parse(output.stdout);
  };

  const state = inspect();
  const certPath = path.join(pathsObj.root, 'data', 'ca', 'ca.crt');

  if (process.platform === 'win32') {
    if (state.ca === 'ready') return state;
    if (!trust) throw new Error('本机证书尚未受信任，请运行初始化并完成证书授权');
    console.log('正在将本地桥接根证书导入受信任根证书库（需要确认管理员提示）...');
    const trustResult = exec(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Start-Process certutil -ArgumentList @("-addstore", "-f", "Root", (\'"{0}"\' -f $env:CURSOR_BRIDGE_CA_CERT)) -Verb RunAs -Wait',
      ],
      { optional: true, env: { ...process.env, CURSOR_BRIDGE_CA_CERT: certPath } }
    );
    const updated = inspect();
    if (updated.ca !== 'ready') {
      const detail = (trustResult?.stderr || trustResult?.stdout || '').trim();
      const suffix = detail ? `（${detail.slice(0, 200)}）` : '';
      throw new Error(`证书导入未完成或被取消${suffix}；请重新运行初始化并在弹窗中选择“是”`);
    }
    return updated;
  }

  const isTrusted = () =>
    exec('/usr/bin/security', ['verify-cert', '-c', certPath, '-p', 'ssl'], { optional: true }).status === 0;

  if (!isTrusted()) {
    if (!trust) throw new Error('本机证书尚未受信任，请在终端运行初始化并完成 macOS 授权');
    console.log('正在信任本机生成的桥接证书；macOS 可能要求确认或密码。私钥只保存在本机。');
    const keychainDb = path.join(pathsObj.home, 'Library', 'Keychains', 'login.keychain-db');
    const keychainLegacy = path.join(pathsObj.home, 'Library', 'Keychains', 'login.keychain');
    const keychainPath =
      fs.existsSync(keychainDb) || !fs.existsSync(keychainLegacy) ? keychainDb : keychainLegacy;
    const interactive = Boolean(process.stdout?.isTTY);
    const trustResult = exec(
      '/usr/bin/security',
      [
        'add-trusted-cert',
        '-r',
        'trustRoot',
        '-p',
        'ssl',
        '-k',
        keychainPath,
        certPath,
      ],
      { optional: true, ...(interactive ? { stdio: 'inherit' } : {}) }
    );
    if (!isTrusted()) {
      const detail = (trustResult?.stderr || trustResult?.stdout || '').trim();
      const suffix = detail ? `（${detail.slice(0, 200)}）` : '';
      throw new Error(
        `证书信任未完成${suffix}；后台服务尚未安装，请允许系统证书授权或在终端运行 bash setup.command 重试`
      );
    }
  }
  return { ...state, ca: 'ready' };
}

export function plistText(pathsObj, runtimePath, releaseDir) {
  const escapeXml = text =>
    String(text)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  const programArgs = [runtimePath, path.join(releaseDir, 'bridge.js'), 'supervise']
    .map(arg => `<string>${escapeXml(arg)}</string>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">` +
    `<plist version="1.0"><dict>` +
    `<key>Label</key><string>${label}</string>` +
    `<key>ProgramArguments</key><array>${programArgs}</array>` +
    `<key>RunAtLoad</key><true/>` +
    `<key>KeepAlive</key><true/>` +
    `<key>ThrottleInterval</key><integer>5</integer>` +
    `<key>ExitTimeOut</key><integer>20</integer>` +
    `<key>Umask</key><integer>63</integer>` +
    `<key>StandardOutPath</key><string>${escapeXml(path.join(pathsObj.root, 'supervisor.log'))}</string>` +
    `<key>StandardErrorPath</key><string>${escapeXml(path.join(pathsObj.root, 'supervisor-error.log'))}</string>` +
    `</dict></plist>`
  );
}

export async function stopJob(pathsObj, domain, exec = runCommand) {
  if (process.platform === 'win32') {
    for (const lockName of ['watchdog.lock', 'supervisor.lock']) {
      try {
        const owner = JSON.parse(
          fs.readFileSync(path.join(pathsObj.root, lockName, 'owner.json'), 'utf8')
        );
        const pid = Number(owner.pid);
        if (pid > 0 && processStartTime(pid) === owner.start) {
          exec('taskkill', ['/F', '/PID', String(pid)], { optional: true });
        }
      } catch {
        // Lock absent or unreadable.
      }
      try {
        fs.rmSync(path.join(pathsObj.root, lockName), { recursive: true, force: true });
      } catch {
        // Best effort cleanup.
      }
    }
    if (pathsObj.startupScript && fs.existsSync(pathsObj.startupScript)) {
      try {
        fs.unlinkSync(pathsObj.startupScript);
      } catch {
        // Ignore missing startup entry.
      }
    }
    return;
  }

  exec('/bin/launchctl', ['bootout', `${domain}/${label}`], { optional: true });
  try {
    const owner = JSON.parse(
      fs.readFileSync(path.join(pathsObj.root, 'watchdog.lock', 'owner.json'), 'utf8')
    );
    const pid = Number(owner.pid);
    if (pid > 0 && (!owner.start || processStartTime(pid) === owner.start)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Process already exited.
      }
    }
  } catch {
    // Watchdog lock absent.
  }
  try {
    fs.rmSync(path.join(pathsObj.root, 'watchdog.lock'), { recursive: true, force: true });
  } catch {
    // Ignore cleanup error.
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const registered = exec('/bin/launchctl', ['print', `${domain}/${label}`], { optional: true }).status === 0;
    let stillAlive = false;
    try {
      const pid = Number(fs.readFileSync(path.join(pathsObj.root, 'supervisor.lock', 'pid'), 'utf8'));
      if (pid > 0) {
        process.kill(pid, 0);
        stillAlive = true;
      }
    } catch {
      stillAlive = false;
    }
    if (!registered && !stillAlive) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('旧桥接尚未停止，请稍后重试安装');
}

export async function bootstrapLaunchAgent(pathsObj, domain, exec = runCommand, retryDelayMs = 1000) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (exec('/bin/launchctl', ['bootstrap', domain, pathsObj.plist], { optional: true }).status === 0) {
      return;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
  }
  throw new Error('macOS 未能启动后台桥接');
}

/** Copy all payload files into `destDir`, omitting ephemeral runtime catalog caches. */
export function copyPayload(sourceDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  for (const item of payload) {
    const srcPath = path.join(sourceDir, item);
    if (!fs.existsSync(srcPath)) continue;
    fs.cpSync(srcPath, path.join(destDir, item), {
      recursive: true,
      dereference: true,
      filter: candidate => path.basename(candidate) !== 'catalog.runtime.js',
    });
  }
}

/** Stage an immutable versioned copy of the plugin and runtime binary before switching service. */
export function stage(sourceDir, pathsObj, version, runtimePath) {
  const releasesRoot = path.join(pathsObj.target, 'releases');
  fs.mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  const releaseDir = fs.mkdtempSync(path.join(releasesRoot, `${version}-`));
  const isWin = process.platform === 'win32';
  try {
    copyPayload(sourceDir, releaseDir);
    const binDir = path.join(releaseDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
    const runtimeDest = path.join(binDir, isWin ? 'runtime.exe' : 'runtime');
    if (!isWin) {
      fs.chmodSync(path.join(releaseDir, 'bridge.js'), 0o755);
      fs.chmodSync(path.join(releaseDir, 'engine.js'), 0o755);
    }
    stageRuntimeBinary(runtimePath, runtimeDest, path.join(releaseDir, 'engine.js'), version);
    return releaseDir;
  } catch (error) {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  }
}

/** Stop previous release cleanly, register OS startup, and launch the new supervisor. */
export async function activate(pathsObj, releaseDir, domain, exec = runCommand, retryDelayMs = 1000) {
  const isWin = process.platform === 'win32';
  await stopJob(pathsObj, domain, exec);
  restoreProxy(path.join(pathsObj.root, 'settings-journal.json'));

  if (isWin) {
    const runtimePath = path.join(releaseDir, 'bin', 'runtime.exe');
    const bridgeScript = path.join(releaseDir, 'bridge.js');
    const vbs = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run """${runtimePath}"" ""${bridgeScript}"" supervise", 0, False`,
      '',
    ].join('\r\n');
    atomicWrite(pathsObj.startupScript, vbs, { mode: 0o644 });
    const written = fs.existsSync(pathsObj.startupScript)
      ? fs.readFileSync(pathsObj.startupScript, 'utf8')
      : '';
    if (!written.includes(releaseDir)) {
      throw new Error(`启动项未指向本次发布：${pathsObj.startupScript}`);
    }
    exec('wscript.exe', [pathsObj.startupScript]);
    console.log('Windows 后台桥接服务已启动并在后台持续运行。');
    return;
  }

  const previousPlist = fs.existsSync(pathsObj.plist) ? fs.readFileSync(pathsObj.plist, 'utf8') : null;
  atomicWrite(pathsObj.plist, plistText(pathsObj, path.join(releaseDir, 'bin', 'runtime'), releaseDir), {
    mode: 0o644,
  });
  try {
    await bootstrapLaunchAgent(pathsObj, domain, exec, retryDelayMs);
  } catch (error) {
    await stopJob(pathsObj, domain, exec);
    if (previousPlist !== null) {
      atomicWrite(pathsObj.plist, previousPlist, { mode: 0o644 });
      await bootstrapLaunchAgent(pathsObj, domain, exec, retryDelayMs);
    } else if (fs.existsSync(pathsObj.plist)) {
      fs.unlinkSync(pathsObj.plist);
    }
    throw error;
  }
}

/** Locate the Magpie CLI binary across explicit overrides, standard install paths, and PATH. */
export function findMagpieBinary({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  exec = runCommand,
} = {}) {
  if (env.MAGPIE_PATH && fs.existsSync(env.MAGPIE_PATH)) {
    return env.MAGPIE_PATH;
  }
  if (platform === 'win32') {
    const candidates = [
      path.join(homeDir, 'Desktop', 'magpie-windows-amd64.exe'),
      path.join(env.LOCALAPPDATA || '', 'Programs', 'magpie', 'magpie.exe'),
      path.join(homeDir, 'Desktop', 'magpie.exe'),
    ];
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) return candidate;
    }
    const probe = exec('where', ['magpie.exe'], { optional: true });
    if (probe.status === 0 && probe.stdout?.trim()) {
      for (const line of probe.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (candidate && fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  }
  const macBinary = '/Applications/magpie.app/Contents/MacOS/magpie';
  if (fs.existsSync(macBinary)) return macBinary;
  const probe = exec('/bin/sh', ['-c', 'command -v magpie 2>/dev/null || true'], { optional: true, env });
  const resolved = (probe.stdout || '').trim();
  return resolved && fs.existsSync(resolved) ? resolved : null;
}

/** Return `true` when `sourceDir` is already registered in Magpie's plugins directory or `plugins.json`. */
export function isRegisteredInMagpie(
  sourceDir,
  packageName,
  homeDir = os.homedir(),
  { env = process.env, platform = process.platform } = {}
) {
  let realSource;
  try {
    realSource = fs.realpathSync(sourceDir);
  } catch {
    return false;
  }

  const configHome =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(homeDir, '.config');
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const roamingAppData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  const nodeModuleCandidates = [
    path.join(configHome, 'magpie', 'plugins', 'node_modules', packageName),
    path.join(homeDir, '.config', 'magpie', 'plugins', 'node_modules', packageName),
    path.join(homeDir, 'Desktop', 'data', 'plugins', 'node_modules', packageName),
  ];
  if (platform === 'win32') {
    nodeModuleCandidates.push(
      path.join(roamingAppData, 'magpie', 'plugins', 'node_modules', packageName),
      path.join(localAppData, 'magpie', 'plugins', 'node_modules', packageName)
    );
  }

  for (const candidate of new Set(nodeModuleCandidates)) {
    try {
      if (fs.existsSync(candidate) && fs.realpathSync(candidate) === realSource) {
        return true;
      }
    } catch {
      // Ignore broken symlink candidates.
    }
  }

  for (const pluginsFile of magpiePluginsCandidates(homeDir, env)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'));
      const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      for (const entry of entries) {
        const spec = typeof entry === 'string' ? entry : entry?.spec;
        if (typeof spec !== 'string' || !spec.trim()) continue;
        if (/^(https?:|git\+|github:|npm:)/i.test(spec.trim())) continue;
        const resolved = path.isAbsolute(spec) ? spec : path.resolve(path.dirname(pluginsFile), spec);
        if (fs.existsSync(resolved) && fs.realpathSync(resolved) === realSource) {
          return true;
        }
      }
    } catch {
      // Missing or malformed plugins.json should not break detection.
    }
  }
  return false;
}
