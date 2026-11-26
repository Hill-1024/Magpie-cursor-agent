#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, restoreProxy } from './lib/settings.js';
import { claimLock, releaseLock } from './lib/lock.js';
import { clearPrivateInferenceConfig } from './lib/private-inference.js';
import { selectPreferredRuntime } from './lib/runtime.js';
import {
  activate,
  copyPayload,
  findMagpieBinary,
  initializeCertificate,
  isRegisteredInMagpie,
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

function writeSetupErrorStatus(rootDir, version, message) {
  try {
    const statusFile = path.join(rootDir, 'status.json');
    const prev = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null;
    if (prev && prev.state === 'connected') return;
    atomicWrite(
      statusFile,
      JSON.stringify(
        {
          version,
          state: 'error',
          reason: String(message || 'setup failed'),
          updated: new Date().toISOString(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  } catch {
    // Never mask original installer failure.
  }
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
  const magpieBinary = findMagpieBinary({ homeDir: targetPaths.home });
  fs.mkdirSync(targetPaths.root, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(targetPaths.root, 0o700);
    } catch {
      // Ignore permission change errors on non-owned dirs.
    }
  }

  const lockDir = path.join(targetPaths.root, 'installer.lock');
  const installerOwner = claimLock(lockDir, {
    busyMessage: '另一个安装程序正在运行；请等待其结束后重试',
  });

  try {
    if (command === 'uninstall') {
      const noAutostartEnv = { ...process.env, MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART: '1' };
      if (magpieBinary) {
        runCommand(magpieBinary, ['cursor-bridge', 'default'], { optional: true, env: noAutostartEnv });
      }
      await stopJob(targetPaths, domain);
      clearPrivateInferenceConfig({ rootDir: targetPaths.root });
      restoreProxy(path.join(targetPaths.root, 'settings-journal.json'));
      if (magpieBinary && fs.existsSync(path.join(targetPaths.target, 'package.json'))) {
        runCommand(magpieBinary, ['plugin', 'rm', targetPaths.target], { optional: true, env: noAutostartEnv });
      }
      if (targetPaths.plist && fs.existsSync(targetPaths.plist)) fs.unlinkSync(targetPaths.plist);
      if (targetPaths.startupScript && fs.existsSync(targetPaths.startupScript)) {
        fs.unlinkSync(targetPaths.startupScript);
      }
      console.log('后台已卸载，Cursor 代理已还原。若从 Magpie 插件页安装，请同时移除该插件。证书、数据及恢复记录保留。');
      return;
    }

    try {
      const preferredRuntime = selectPreferredRuntime({
        homeDir: targetPaths.home,
        currentExecPath: process.execPath,
      });
      verifyPackage(sourceDir, runCommand, preferredRuntime.path);
      const engineScript = path.join(sourceDir, 'engine.js');
      clearPrivateInferenceConfig({ rootDir: targetPaths.root });
      initializeCertificate(engineScript, targetPaths, runCommand, { runtime: preferredRuntime.path });
      const releaseDir = stage(sourceDir, targetPaths, manifest.version, preferredRuntime.path);

      const noAutostartEnv = { ...process.env, MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART: '1' };
      const registered = isRegisteredInMagpie(sourceDir, manifest.name, targetPaths.home);
      let pluginReady = registered;
      if (registered) {
        if (magpieBinary && fs.existsSync(path.join(targetPaths.target, 'package.json'))) {
          runCommand(magpieBinary, ['plugin', 'rm', targetPaths.target], {
            optional: true,
            env: noAutostartEnv,
          });
        }
      } else {
        let sameDir = false;
        try {
          sameDir =
            fs.existsSync(targetPaths.target) &&
            fs.realpathSync(targetPaths.target) === fs.realpathSync(sourceDir);
        } catch {
          sameDir = path.resolve(targetPaths.target) === path.resolve(sourceDir);
        }
        if (!sameDir) {
          copyPayload(sourceDir, targetPaths.target);
        }
        if (isRegisteredInMagpie(targetPaths.target, manifest.name, targetPaths.home)) {
          pluginReady = true;
        } else if (magpieBinary) {
          const added = runCommand(magpieBinary, ['plugin', 'add', targetPaths.target], {
            optional: true,
            env: noAutostartEnv,
          });
          pluginReady = added.status === 0;
          if (!pluginReady) {
            const detail = (added.stderr || added.stdout || '').trim();
            console.warn(
              `警告：未能自动将插件注册到 Magpie（${detail.slice(0, 200) || '请检查 Magpie 状态'}）。请手动执行：${magpieBinary} plugin add "${targetPaths.target}"`
            );
          }
        } else {
          console.warn(
            `警告：未找到 Magpie 可执行文件；请在安装 Magpie 后执行：magpie plugin add "${targetPaths.target}"`
          );
        }
      }

      if (!preferredRuntime.http2) {
        console.warn(
          `提示：当前托管运行时 ${preferredRuntime.kind || 'unknown'} ${preferredRuntime.version || ''} 不支持 HTTP/2 ALPN；如遇到 HTTP/2 请求异常，待 Magpie 更新 Bun (>=1.4.4) 或安装 Node.js (>=18) 后会自动切换。`
        );
      }

      await activate(targetPaths, releaseDir, domain);
      atomicWrite(
        path.join(targetPaths.root, 'installation.json'),
        JSON.stringify(
          {
            version: manifest.version,
            release: releaseDir,
            source: sourceDir,
            runtime: {
              kind: preferredRuntime.kind,
              version: preferredRuntime.version,
              http2: preferredRuntime.http2,
              source: preferredRuntime.path,
            },
            installed: new Date().toISOString(),
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      if (pluginReady) {
        console.log(`已成功安装并启动 v${manifest.version}。在 Magpie → Agents 选择 Cursor · Magpie Bridge 和模型即可开始使用。`);
      } else {
        console.log(`后台服务 v${manifest.version} 已启动，请完成上述 Magpie 插件注册后在 Magpie → Agents 选择 Cursor · Magpie Bridge。`);
      }
    } catch (error) {
      writeSetupErrorStatus(targetPaths.root, manifest.version, error?.message || String(error));
      throw error;
    }
  } finally {
    releaseLock(lockDir, installerOwner);
  }
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
