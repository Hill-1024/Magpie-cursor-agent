import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agent, connect } from '../agent.js';
import { activate, label, paths, plistText, stage, verifyPackage } from '../lib/install.js';
import {
  createConfigService,
  publishCatalogAsset,
  readSafeState,
  startManagedConfigService,
  writeRolesFile,
} from '../lib/service.js';

const sourceDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));

function makeTemp(testCtx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-install-'));
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('agent.js is pure moejs-safe and returns Magpie connection metadata with effort support', () => {
  const source = fs.readFileSync(path.join(sourceDir, 'agent.js'), 'utf8');
  const topImports = source.split('\n').filter(line => /^\s*import\s/.test(line));
  assert.deepEqual(topImports, []);
  assert.equal(/node:|import\s*\(|\bprocess\b/.test(source), false);
  assert.equal(agent.id, 'cursor-bridge');
  assert.equal(agent.effort, true);
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
  assert.ok(fs.existsSync(path.join(releaseOne, 'plugin.js')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'panel.html')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'catalog.js')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'service.html')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'shared.js')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'style.css')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'icon.svg')));
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

  fs.writeFileSync(
    path.join(tempRoot, 'roles.json'),
    JSON.stringify({ bugbot: 'group/bugbot-live', subagent: 'group/sub-live' })
  );
  let updatedRoles = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(tempRoot, 'status.json'), 'utf8'));
      if (parsed.roles?.bugbot === 'group/bugbot-live') {
        updatedRoles = parsed.roles;
        break;
      }
    } catch {
      // Wait for status.json role reload.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(updatedRoles?.bugbot, 'group/bugbot-live');
  assert.equal(updatedRoles?.subagent, 'group/sub-live');

  bridgeProcess.kill('SIGTERM');
  await new Promise(resolve => bridgeProcess.once('exit', resolve));
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), originalSettings);
  const stoppedStatus = JSON.parse(fs.readFileSync(path.join(tempRoot, 'status.json'), 'utf8'));
  assert.equal(stoppedStatus.state, 'stopped');
});

test('service.js config service hides gateway secrets, validates loopback headers, and persists roles.json', async testCtx => {
  const rootDir = makeTemp(testCtx);
  fs.writeFileSync(
    path.join(rootDir, 'connection.json'),
    JSON.stringify({
      enabled: true,
      gateway: 'http://127.0.0.1:3425/v1',
      key: 'top-secret-gateway-key',
      model: 'magpie/main',
      models: [
        { id: 'magpie/main', name: 'Main Model', context: 200000 },
        { id: 'magpie/fast', name: 'Fast Model', context: 128000 },
      ],
    })
  );
  fs.writeFileSync(
    path.join(rootDir, 'status.json'),
    JSON.stringify({
      version: manifest.version,
      state: 'connected',
      reason: 'Bridge active',
      proxy: 'http://127.0.0.1:52407',
      models: 2,
    })
  );

  const safeBefore = readSafeState({ rootDir, includeMagpiePlugins: false });
  assert.equal(JSON.stringify(safeBefore).includes('top-secret-gateway-key'), false);
  assert.equal(safeBefore.models.length, 2);
  assert.equal(safeBefore.status?.port, 52407);
  assert.equal(safeBefore.status?.detail, 'Bridge active');
  assert.equal(safeBefore.status?.modelsCount, 2);

  const service = await createConfigService({
    rootDir,
    uiDir: path.join(sourceDir, 'ui'),
    port: 0,
    includeMagpiePlugins: false,
  });
  testCtx.after(() => service.close());

  const htmlResp = await fetch(
    `http://127.0.0.1:${service.port}/?uiOrigin=${encodeURIComponent(`http://127.0.0.1:${service.port}`)}`
  );
  assert.equal(htmlResp.status, 200);
  assert.match(await htmlResp.text(), /Cursor Bridge/);
  assert.match(
    htmlResp.headers.get('content-security-policy') || '',
    new RegExp(`script-src 'self' http://127\\.0\\.0\\.1:${service.port}`)
  );

  const directHtmlResp = await fetch(`http://127.0.0.1:${service.port}/`);
  assert.equal(directHtmlResp.status, 200);
  assert.match(
    directHtmlResp.headers.get('content-security-policy') || '',
    new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${service.port}`)
  );

  const stateResp = await fetch(`http://127.0.0.1:${service.port}/api/state`, {
    headers: { Origin: 'null' },
  });
  assert.equal(stateResp.status, 200);
  assert.equal(stateResp.headers.get('access-control-allow-origin'), 'null');
  const stateText = await stateResp.text();
  assert.equal(stateText.includes('top-secret-gateway-key'), false);

  const preflightResp = await fetch(`http://127.0.0.1:${service.port}/api/roles`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflightResp.status, 204);
  assert.equal(preflightResp.headers.get('access-control-allow-origin'), 'null');
  assert.match(preflightResp.headers.get('access-control-allow-headers') || '', /Content-Type/i);

  const evilResp = await fetch(`http://127.0.0.1:${service.port}/api/state`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(evilResp.status, 403);

  const saveResp = await fetch(`http://127.0.0.1:${service.port}/api/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({
      autoRouterModel: 'cursor/auto',
      subagentModel: 'magpie/fast[reasoning=low]',
      bugbotModel: 'magpie/main',
      securitybotModel: 'magpie/main[reasoning=high]',
      titleModel: 'magpie/fast',
      summarizeModel: 'magpie/fast',
      memoryModel: 'magpie/fast',
      subagentTypeModels: { explore: 'magpie/fast' },
    }),
  });
  assert.equal(saveResp.status, 200);
  assert.equal(saveResp.headers.get('access-control-allow-origin'), 'null');
  const savedJson = await saveResp.json();
  assert.equal(savedJson.roles.autoRouter, 'cursor/auto');
  assert.equal(savedJson.roles.subagent, 'magpie/fast[reasoning=low]');
  assert.equal(savedJson.roles.securitybot, 'magpie/main[reasoning=high]');

  const diskRoles = JSON.parse(fs.readFileSync(path.join(rootDir, 'roles.json'), 'utf8'));
  assert.equal(diskRoles.autoRouter, 'cursor/auto');
  assert.equal(diskRoles.title, 'magpie/fast');
  assert.deepEqual(diskRoles.subagentTypes, { explore: 'magpie/fast' });

  const directWrite = writeRolesFile(rootDir, { commitModel: 'magpie/fast' });
  assert.equal(directWrite.commit, 'magpie/fast');
});

test('publishCatalogAsset writes the Agents-page catalogue without gateway secrets', async testCtx => {
  const rootDir = makeTemp(testCtx);
  const uiDir = path.join(makeTemp(testCtx), 'ui');
  fs.writeFileSync(
    path.join(rootDir, 'connection.json'),
    JSON.stringify({
      enabled: true,
      gateway: 'http://127.0.0.1:3425/v1',
      key: 'catalog-secret-key',
      model: 'cursor/auto-smart',
      models: [
        { id: 'cursor/auto-smart', name: 'Cursor Auto', context: 200000 },
        { id: 'magpie/fast', name: 'Fast Model', context: 128000 },
      ],
    })
  );
  fs.writeFileSync(
    path.join(rootDir, 'status.json'),
    JSON.stringify({ state: 'connected', proxy: 'http://127.0.0.1:52407', models: 2 })
  );
  fs.writeFileSync(path.join(rootDir, 'roles.json'), JSON.stringify({ autoRouter: 'cursor/auto-smart' }));

  const result = publishCatalogAsset({ uiDir, rootDir, includeMagpiePlugins: false });
  assert.equal(result.ok, true);
  const source = fs.readFileSync(result.file, 'utf8');
  assert.equal(source.includes('catalog-secret-key'), false);
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'catalog.runtime.js' });
  assert.equal(sandbox.CursorBridgeCatalog.models.length, 2);
  assert.equal(sandbox.CursorBridgeCatalog.defaultModel, 'cursor/auto-smart');
  assert.equal(sandbox.CursorBridgeCatalog.roles.autoRouter, 'cursor/auto-smart');
  assert.equal(sandbox.CursorBridgeCatalog.status.port, 52407);

  const unchanged = publishCatalogAsset({ uiDir, rootDir, includeMagpiePlugins: false });
  assert.equal(unchanged.changed, false);
});

test('plugin.js exports only default entry and startManagedConfigService reclaims port across host recycle', async testCtx => {
  const pluginMod = await import('../plugin.js');
  assert.deepEqual(Object.keys(pluginMod), ['default']);
  assert.equal(typeof pluginMod.default, 'function');

  const rootDir = makeTemp(testCtx);
  const oldService = await createConfigService({
    rootDir,
    uiDir: path.join(sourceDir, 'ui'),
    port: 0,
    includeMagpiePlugins: false,
  });
  let oldClosed = false;
  testCtx.after(async () => {
    if (!oldClosed) await oldService.close();
  });

  const managed = await startManagedConfigService({
    rootDir,
    uiDir: path.join(sourceDir, 'ui'),
    port: oldService.port,
    reclaimIntervalMs: 50,
  });
  testCtx.after(() => managed.close());
  assert.equal(managed.role, 'attached');
  assert.equal(managed.port, oldService.port);

  await oldService.close();
  oldClosed = true;
  for (let i = 0; i < 30 && managed.role !== 'owner'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.equal(managed.role, 'owner');
});
