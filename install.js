#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, restoreProxy } from './lib/settings.js';
import {
  activate,
  initializeCertificate,
  label,
  paths,
  runCommand,
  stage,
  stopJob,
  verifyPackage,
} from './lib/install.js';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
const command = process.argv[2] || 'setup';
const rooted = process.env.CURSOR_BRIDGE_ROOT;

function resolvePaths(base) {
  if (!rooted) return base;
  return {
    ...base,
    root: rooted,
    target: rooted,
    startupScript:
      process.platform === 'win32' ? path.join(rooted, 'Startup', `${label}.vbs`) : base.startupScript,
  };
}

function findMagpieBinary() {
  if (process.env.MAGPIE_PATH && fs.existsSync(process.env.MAGPIE_PATH)) {
    return process.env.MAGPIE_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      path.join(os.homedir(), 'Desktop', 'magpie-windows-amd64.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'magpie', 'magpie.exe'),
      path.join(os.homedir(), 'Desktop', 'magpie.exe'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    const probe = runCommand('where', ['magpie.exe'], { optional: true });
    if (probe.status === 0 && probe.stdout.trim()) {
      return probe.stdout.trim().split(/\r?\n/)[0];
    }
    return null;
  }
  const macBinary = '/Applications/magpie.app/Contents/MacOS/magpie';
  return fs.existsSync(macBinary) ? macBinary : null;
}

async function main() {
  if (command === '--help' || command === '-h') {
    console.log(
      'Usage: node install.js [setup|status|uninstall|--version]\nsetup: install/update the paired plugin and service.'
    );
    return;
  }
  if (command === '--version') {
    console.log(manifest.version);
    return;
  }

  const targetPaths = resolvePaths(paths(os.homedir()));
  if (command === 'status') {
    const statusFile = path.join(targetPaths.root, 'status.json');
    console.log(fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : '未安装或尚未运行');
    return;
  }

  if (command !== 'setup' && command !== 'uninstall') {
    throw new Error('未知命令；使用 --help 查看用法');
  }

  const supported =
    (process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')) ||
    (process.platform === 'win32' && (process.arch === 'x64' || process.arch === 'arm64'));
  if (!supported) {
    throw new Error('此版本支持 macOS 与 Windows');
  }

  const domain = process.platform === 'darwin' && process.getuid ? `gui/${process.getuid()}` : '';
  const magpieBinary = findMagpieBinary();
  fs.mkdirSync(targetPaths.root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetPaths.root, 0o700);
    } catch {
      // Ignore permission change errors on non-owned dirs.
    }
  }

  const lockDir = path.join(targetPaths.root, 'installer.lock');
  try {
    fs.mkdirSync(lockDir);
  } catch {
    throw new Error('另一个安装程序正在运行；若上次被强制终止，请检查后移除 installer.lock 再重试');
  }

  try {
    if (command === 'uninstall') {
      if (magpieBinary) runCommand(magpieBinary, ['cursor-bridge', 'default'], { optional: true });
      await stopJob(targetPaths, domain);
      restoreProxy(path.join(targetPaths.root, 'settings-journal.json'));
      if (magpieBinary) runCommand(magpieBinary, ['plugin', 'rm', targetPaths.target], { optional: true });
      if (targetPaths.plist && fs.existsSync(targetPaths.plist)) fs.unlinkSync(targetPaths.plist);
      if (targetPaths.startupScript && fs.existsSync(targetPaths.startupScript)) {
        fs.unlinkSync(targetPaths.startupScript);
      }
      console.log('后台已卸载，Cursor 代理已还原。若从 Magpie 插件页安装，请同时移除该插件。证书、数据及恢复记录保留。');
      return;
    }

    verifyPackage(sourceDir);
    const engineScript = path.join(sourceDir, 'engine.js');
    initializeCertificate(engineScript, targetPaths);
    const releaseDir = stage(sourceDir, targetPaths, manifest.version, process.execPath);

    const configHome = process.env.XDG_CONFIG_HOME || path.join(targetPaths.home, '.config');
    const pluginNodeModules = [
      path.join(configHome, 'magpie', 'plugins', 'node_modules', manifest.name),
      path.join(targetPaths.home, 'Desktop', 'data', 'plugins', 'node_modules', manifest.name),
    ];
    let registeredInMagpie = false;
    for (const candidate of pluginNodeModules) {
      try {
        if (fs.existsSync(candidate) && fs.realpathSync(candidate) === fs.realpathSync(sourceDir)) {
          registeredInMagpie = true;
          break;
        }
      } catch {
        // Ignore broken symlink candidates.
      }
    }

    if (registeredInMagpie) {
      if (magpieBinary) runCommand(magpieBinary, ['plugin', 'rm', targetPaths.target], { optional: true });
    } else {
      atomicWrite(path.join(targetPaths.target, 'agent.js'), fs.readFileSync(path.join(sourceDir, 'agent.js'), 'utf8'), {
        mode: 0o644,
      });
      atomicWrite(
        path.join(targetPaths.target, 'package.json'),
        JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', magpie: manifest.magpie }, null, 2),
        { mode: 0o644 }
      );
    }

    await activate(targetPaths, releaseDir, domain);
    atomicWrite(
      path.join(targetPaths.root, 'installation.json'),
      JSON.stringify({ version: manifest.version, release: releaseDir, source: sourceDir, installed: new Date().toISOString() }, null, 2),
      { mode: 0o600 }
    );
    console.log(`已成功安装并启动 v${manifest.version}。在 Magpie → Agents 选择 Cursor · Magpie Bridge 和模型即可开始使用。`);
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Ignore lock cleanup failure.
    }
  }
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
