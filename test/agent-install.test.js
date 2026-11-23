import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agent, connect } from '../agent.js';
import { activate, label, paths, plistText, stage, verifyPackage } from '../lib/install.js';

const sourceDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));

function makeTemp(testCtx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-install-'));
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('agent.js has zero top-level imports and returns Magpie connection metadata', () => {
  const source = fs.readFileSync(path.join(sourceDir, 'agent.js'), 'utf8');
  const topImports = source.split('\n').filter(line => /^\s*import\s/.test(line));
  assert.deepEqual(topImports, []);
  assert.equal(agent.id, 'cursor-bridge');
  assert.equal(agent.config, '~/.config/magpie-cursor-bridge/connection.json');
  assert.equal(agent.format, 'json');

  process.env.MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART = '1';
  try {
    const result = connect({
      gateway: { v1: 'http://127.0.0.1:3425/v1', key: 'test-key' },
      model: 'group/auto',
      models: [{ id: 'group/auto', name: 'Auto', context: 200000 }],
    });
    assert.equal(result.enabled, true);
    assert.equal(result.gateway, 'http://127.0.0.1:3425/v1');
    assert.equal(result.key, 'test-key');
    assert.equal(result.models[0].id, 'group/auto');
  } finally {
    delete process.env.MAGPIE_CURSOR_BRIDGE_NO_AUTOSTART;
  }
});

test('verifyPackage validates source file SHA-256 digests and detects tampering', testCtx => {
  assert.equal(verifyPackage(sourceDir).version, manifest.version);

  const tempCopy = path.join(makeTemp(testCtx), 'tampered');
  fs.cpSync(sourceDir, tempCopy, { recursive: true });
  fs.appendFileSync(path.join(tempCopy, 'lib', 'config.js'), '\n// tampered\n');
  assert.throws(() => verifyPackage(tempCopy), /文件校验失败/);
});

test('stage creates isolated immutable releases without node_modules or opaque binaries', testCtx => {
  const home = makeTemp(testCtx);
  const targetPaths = paths(home);
  const releaseOne = stage(sourceDir, targetPaths, manifest.version, process.execPath);
  const releaseTwo = stage(sourceDir, targetPaths, manifest.version, process.execPath);
  assert.notEqual(releaseOne, releaseTwo);
  assert.ok(fs.existsSync(path.join(releaseOne, 'engine.js')));
  assert.equal(fs.existsSync(path.join(releaseOne, 'node_modules')), false);
  const run = spawnSync(process.execPath, [path.join(releaseOne, 'engine.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), manifest.version);
});

test('plistText escapes XML entities and activate rolls back failed bootstrap', async testCtx => {
  const home = makeTemp(testCtx);
  const targetPaths = paths(home);
  const xml = plistText(targetPaths, '/tmp/A & B/runtime', '/tmp/A < B/release');
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /A &lt; B/);

  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(targetPaths.plist), { recursive: true });
    fs.writeFileSync(targetPaths.plist, 'previous-plist');
    let bootstrapCount = 0;
    const mockExec = (cmd, args) => {
      if (args[0] === 'bootstrap') {
        bootstrapCount += 1;
        return { status: bootstrapCount <= 5 ? 1 : 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    };
    await assert.rejects(
      () => activate(targetPaths, '/new/release', 'gui/999', mockExec, 10),
      /未能启动/
    );
    assert.equal(fs.readFileSync(targetPaths.plist, 'utf8'), 'previous-plist');
    assert.equal(bootstrapCount, 6);
  } else {
    targetPaths.startupScript = path.join(home, 'Startup', `${label}.vbs`);
    const release = stage(sourceDir, targetPaths, manifest.version, process.execPath);
    let started = false;
    await activate(targetPaths, release, '', cmd => {
      if (cmd === 'wscript.exe') started = true;
      return { status: 0, stdout: '', stderr: '' };
    });
    assert.equal(started, true);
  }
});

test('bridge.js supervise starts engine, updates Cursor settings, and restores cleanly on SIGTERM', async testCtx => {
  const tempRoot = makeTemp(testCtx);
  const settingsFile = path.join(tempRoot, 'settings.json');
  const originalSettings = '{\n  // user comment\n  "editor.fontSize": 17\n}\n';
  fs.writeFileSync(settingsFile, originalSettings);

  const mockGateway = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'group/auto', name: 'Auto', context_window: 200000 }] }));
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const gatewayUrl = `http://127.0.0.1:${mockGateway.address().port}/v1`;
  fs.writeFileSync(
    path.join(tempRoot, 'connection.json'),
    JSON.stringify({
      enabled: true,
      gateway: gatewayUrl,
      key: 'test-key',
      model: 'group/auto',
      models: [{ id: 'group/auto', name: 'Auto', context: 200000 }],
    })
  );

  const bridgeProcess = spawn(process.execPath, [path.join(sourceDir, 'bridge.js'), 'supervise'], {
    env: {
      ...process.env,
      CURSOR_BRIDGE_ROOT: tempRoot,
      CURSOR_BRIDGE_SETTINGS: settingsFile,
      CURSOR_BRIDGE_RELAY_PORT: '0',
      CURSOR_BRIDGE_NO_WATCHDOG: '1',
      CURSOR_BRIDGE_ALLOW_UNTRUSTED_CA: '1',
      CURSOR_BRIDGE_STRICT_OFFLINE: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrText = '';
  bridgeProcess.stderr.on('data', d => {
    stderrText += d.toString('utf8');
  });
  testCtx.after(() => {
    if (bridgeProcess.exitCode === null) bridgeProcess.kill('SIGKILL');
  });

  let connectedStatus = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(tempRoot, 'status.json'), 'utf8'));
      if (parsed.state === 'connected') {
        connectedStatus = parsed;
        break;
      }
    } catch {
      // Wait for status.json creation.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(connectedStatus, `supervisor did not connect; stderr=${stderrText}`);
  assert.match(connectedStatus.proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(fs.readFileSync(settingsFile, 'utf8'), originalSettings);

  bridgeProcess.kill('SIGTERM');
  await new Promise(resolve => bridgeProcess.once('exit', resolve));
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings);
  const stoppedStatus = JSON.parse(fs.readFileSync(path.join(tempRoot, 'status.json'), 'utf8'));
  assert.equal(stoppedStatus.state, 'stopped');
});
