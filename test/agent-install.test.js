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
import {
  activate,
  copyPayload,
  findMagpieBinary,
  isRegisteredInMagpie,
  label,
  paths,
  plistText,
  stage,
  verifyPackage,
} from '../lib/install.js';
import {
  compareSemver,
  findMagpieBuns,
  selectPreferredRuntime,
  stageRuntimeBinary,
} from '../lib/runtime.js';
import { claimLock, releaseLock } from '../lib/lock.js';
import {
  createConfigService,
  ensureBridgeStarted,
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
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'page.html')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'service.html')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'magpie-bridge.js')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'shared.js')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'style.css')));
  assert.ok(fs.existsSync(path.join(releaseOne, 'ui', 'icon.svg')));
  assert.equal(fs.existsSync(path.join(releaseOne, 'node_modules')), false);
  const run = spawnSync(process.execPath, [path.join(releaseOne, 'engine.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), manifest.version);

  const stagedRuntime = path.join(releaseOne, 'bin', process.platform === 'win32' ? 'runtime.exe' : 'runtime');
  assert.ok(fs.existsSync(stagedRuntime));
  const stagedRun = spawnSync(stagedRuntime, [path.join(releaseOne, 'engine.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.equal(stagedRun.status, 0);
  assert.equal(stagedRun.stdout.trim(), manifest.version);
});

test('plistText escapes XML entities and activate rolls back failed bootstrap', async testCtx => {
  const home = makeTemp(testCtx);
  const targetPaths = paths(home);
  const xml = plistText(targetPaths, '/tmp/A & B/runtime', '/tmp/A < B/release');
  assert.match(xml, /A &amp; B/);
  assert.match(xml, /A &lt; B/);
  const quotedXml = plistText(targetPaths, '/tmp/"A"/runtime', "/tmp/'B'/release");
  assert.match(quotedXml, /&quot;A&quot;/);
  assert.match(quotedXml, /&apos;B&apos;/);

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
        { id: 'magpie/main', name: 'Main Model', context: 200000, efforts: ['low', 'high', 'ultra'], fast: true },
        { id: 'magpie/fast', name: 'Fast Model', context: 128000, efforts: ['low', 'high'], fast: false },
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
  assert.deepEqual(safeBefore.models[0].efforts, ['low', 'high', 'ultra']);
  assert.equal(safeBefore.models[0].fast, true);
  assert.deepEqual(safeBefore.models[0].serviceTiers, [{ id: 'priority', name: 'Fast' }]);
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
  assert.match(await htmlResp.text(), /Cursor (角色模型|Bridge)/);
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
      autoReviewModel: 'magpie/fast[reasoning=low]',
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
  assert.equal(savedJson.roles.autoReview, 'magpie/fast[reasoning=low]');

  const diskRoles = JSON.parse(fs.readFileSync(path.join(rootDir, 'roles.json'), 'utf8'));
  assert.equal(diskRoles.autoRouter, 'cursor/auto');
  assert.equal(diskRoles.autoReview, 'magpie/fast[reasoning=low]');
  assert.equal(diskRoles.title, 'magpie/fast');
  assert.deepEqual(diskRoles.subagentTypes, { explore: 'magpie/fast' });

  const directWrite = writeRolesFile(rootDir, { commitModel: 'magpie/fast' });
  assert.equal(directWrite.commit, 'magpie/fast');

  const iconResp = await fetch(`http://127.0.0.1:${service.port}/favicon.ico`);
  assert.equal(iconResp.status, 200);

  const sseController = new AbortController();
  const sseResp = await fetch(`http://127.0.0.1:${service.port}/api/events`, {
    signal: sseController.signal,
  });
  assert.equal(sseResp.status, 200);
  assert.match(sseResp.headers.get('content-type') || '', /text\/event-stream/);
  const reader = sseResp.body.getReader();
  const decoder = new TextDecoder();
  let sseText = '';
  while (!sseText.includes('\n\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += decoder.decode(value, { stream: true });
  }
  assert.match(sseText, /event: state/);
  assert.equal(sseText.includes('top-secret-gateway-key'), false);
  assert.match(sseText, /"commit":"magpie\/fast"/);

  sseText = '';
  const pushPromise = fetch(`http://127.0.0.1:${service.port}/api/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commitModel: 'magpie/main[reasoning=ultra]' }),
  });
  while (!sseText.includes('magpie/main[reasoning=ultra]')) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += decoder.decode(value, { stream: true });
  }
  assert.equal((await pushPromise).status, 200);
  sseController.abort();
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

test('ensureBridgeStarted routes version upgrade through setup instead of spawning duplicate supervisor', async testCtx => {
  const rootDir = makeTemp(testCtx);
  const fakeSource = makeTemp(testCtx);
  fs.writeFileSync(path.join(fakeSource, 'package.json'), JSON.stringify({ version: '9.9.9' }));

  const staged = path.join(makeTemp(testCtx), 'staged');
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'bridge.js'), '// should not be spawned directly\n');
  fs.writeFileSync(path.join(staged, 'engine.js'), '// engine\n');

  fs.writeFileSync(
    path.join(rootDir, 'installation.json'),
    JSON.stringify({ version: '9.9.9', release: staged })
  );
  fs.writeFileSync(path.join(rootDir, 'status.json'), JSON.stringify({ version: '9.9.8', state: 'connected' }));

  const lockDir = path.join(rootDir, 'supervisor.lock');
  const owner = claimLock(lockDir);
  testCtx.after(() => releaseLock(lockDir, owner));

  const res = await ensureBridgeStarted({ rootDir, sourceDir: fakeSource, noAutostart: false });
  assert.equal(res.action, 'setup');
});

test('ensureBridgeStarted triggers setup when integrity.json changes within the same version', async testCtx => {
  const rootDir = makeTemp(testCtx);
  const fakeSource = makeTemp(testCtx);
  fs.writeFileSync(path.join(fakeSource, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(
    path.join(fakeSource, 'integrity.json'),
    JSON.stringify({ version: '9.9.9', files: { 'lib/cursor-engine.js': 'new-hash' } })
  );

  const staged = path.join(makeTemp(testCtx), 'staged');
  fs.mkdirSync(staged, { recursive: true });
  fs.writeFileSync(path.join(staged, 'bridge.js'), '// bridge\n');
  fs.writeFileSync(path.join(staged, 'engine.js'), '// engine\n');
  fs.writeFileSync(
    path.join(staged, 'integrity.json'),
    JSON.stringify({ version: '9.9.9', files: { 'lib/cursor-engine.js': 'old-hash' } })
  );

  fs.writeFileSync(
    path.join(rootDir, 'installation.json'),
    JSON.stringify({ version: '9.9.9', release: staged })
  );
  fs.writeFileSync(path.join(rootDir, 'status.json'), JSON.stringify({ version: '9.9.9', state: 'connected' }));

  const lockDir = path.join(rootDir, 'supervisor.lock');
  const owner = claimLock(lockDir);
  testCtx.after(() => releaseLock(lockDir, owner));

  const res = await ensureBridgeStarted({ rootDir, sourceDir: fakeSource, noAutostart: false });
  assert.equal(res.action, 'setup');
});

test('runtime helpers rank semver, prefer HTTP/2-capable runtimes, and wrap dynamic binaries safely', testCtx => {
  assert.ok(compareSemver('1.10.0', '1.4.5') > 0);
  assert.ok(compareSemver('1.4.5', '1.4.2') > 0);
  assert.equal(compareSemver('v26.13.0', '26.13.0'), 0);

  const home = makeTemp(testCtx);
  const xdgCache = makeTemp(testCtx);
  const bunName = process.platform === 'win32' ? 'magpie-bun.exe' : 'magpie-bun';
  const oldBun = path.join(home, '.cache', 'magpie', 'bun', '1.4.2', bunName);
  const midBun = path.join(xdgCache, 'magpie', 'bun', '1.4.5', bunName);
  const newBun = path.join(home, 'Desktop', 'data', 'cache', 'bun', '1.10.0', bunName);
  for (const filePath of [oldBun, midBun, newBun]) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'stub', { mode: 0o755 });
  }

  const found = findMagpieBuns({ homeDir: home, env: { XDG_CACHE_HOME: xdgCache } });
  assert.deepEqual(
    found.map(item => item.version),
    ['1.10.0', '1.4.5', '1.4.2']
  );

  const nodeBin = path.join(makeTemp(testCtx), process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(nodeBin, 'stub', { mode: 0o755 });

  const pickedWithOldBun = selectPreferredRuntime({
    homeDir: makeTemp(testCtx),
    env: { PATH: path.dirname(nodeBin) },
    currentExecPath: nodeBin,
    exec: cmd => {
      if (cmd === oldBun) return { status: 0, stdout: '{"bun":"1.4.2","node":null}' };
      if (cmd === nodeBin) return { status: 0, stdout: '{"bun":null,"node":"22.11.0"}' };
      if (cmd === '/bin/sh') return { status: 0, stdout: `${nodeBin}\n` };
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(pickedWithOldBun.kind, 'node');
  assert.equal(pickedWithOldBun.http2, true);

  const fakeOldHome = makeTemp(testCtx);
  const fakeOldBun = path.join(fakeOldHome, '.cache', 'magpie', 'bun', '1.4.2', bunName);
  fs.mkdirSync(path.dirname(fakeOldBun), { recursive: true });
  fs.writeFileSync(fakeOldBun, 'stub', { mode: 0o755 });
  const preferredNodeOver142 = selectPreferredRuntime({
    homeDir: fakeOldHome,
    env: { PATH: path.dirname(nodeBin) },
    currentExecPath: nodeBin,
    exec: cmd => {
      if (cmd === fakeOldBun) return { status: 0, stdout: '{"bun":"1.4.2","node":null}' };
      if (cmd === nodeBin) return { status: 0, stdout: '{"bun":null,"node":"22.11.0"}' };
      if (cmd === '/bin/sh') return { status: 0, stdout: `${nodeBin}\n` };
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(preferredNodeOver142.kind, 'node');
  assert.equal(preferredNodeOver142.path, nodeBin);

  const preferred145OverNode = selectPreferredRuntime({
    homeDir: home,
    env: { XDG_CACHE_HOME: xdgCache, PATH: path.dirname(nodeBin) },
    currentExecPath: nodeBin,
    exec: cmd => {
      if (cmd === newBun) return { status: 0, stdout: '{"bun":"1.10.0","node":null}' };
      if (cmd === nodeBin) return { status: 0, stdout: '{"bun":null,"node":"22.11.0"}' };
      return { status: 1, stdout: '' };
    },
  });
  assert.equal(preferred145OverNode.kind, 'bun');
  assert.equal(preferred145OverNode.path, newBun);

  if (process.platform !== 'win32') {
    const wrapperDir = makeTemp(testCtx);
    const shimRuntime = path.join(wrapperDir, 'shim-node');
    fs.writeFileSync(shimRuntime, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, {
      mode: 0o755,
    });
    const destBin = path.join(wrapperDir, 'runtime');
    const verifyScript = path.join(wrapperDir, 'engine.js');
    fs.writeFileSync(verifyScript, `console.log('${manifest.version}');\n`);
    const staged = stageRuntimeBinary(shimRuntime, destBin, verifyScript, manifest.version);
    assert.equal(staged.mode, 'wrapper');
    const check = spawnSync(destBin, [verifyScript, '--version'], { encoding: 'utf8' });
    assert.equal(check.status, 0);
    assert.equal(check.stdout.trim(), manifest.version);
  }
});

test('isRegisteredInMagpie detects node_modules and local plugins.json specs, and copyPayload skips catalog cache', testCtx => {
  const home = makeTemp(testCtx);
  const localRepo = path.join(makeTemp(testCtx), 'repo');
  const copiedTarget = path.join(makeTemp(testCtx), 'target');
  copyPayload(sourceDir, localRepo);
  assert.ok(fs.existsSync(path.join(localRepo, 'plugin.js')));
  assert.ok(fs.existsSync(path.join(localRepo, 'ui', 'page.html')));
  assert.equal(fs.existsSync(path.join(localRepo, 'ui', 'catalog.runtime.js')), false);
  assert.equal(isRegisteredInMagpie(localRepo, manifest.name, home, { env: {} }), false);

  const pluginsFile = path.join(home, '.config', 'magpie', 'plugins.json');
  fs.mkdirSync(path.dirname(pluginsFile), { recursive: true });
  fs.writeFileSync(
    pluginsFile,
    JSON.stringify({
      plugins: [
        { spec: 'https://github.com/Hill-1024/Magpie-cursor-agent' },
        { spec: localRepo },
      ],
    })
  );
  assert.equal(isRegisteredInMagpie(localRepo, manifest.name, home, { env: {} }), true);

  fs.mkdirSync(copiedTarget, { recursive: true });
  const fakeBin = path.join(makeTemp(testCtx), 'magpie');
  fs.writeFileSync(fakeBin, 'stub', { mode: 0o755 });
  assert.equal(findMagpieBinary({ homeDir: home, env: { MAGPIE_PATH: fakeBin } }), fakeBin);
});

test('ensureBridgeStarted avoids duplicate setup lock contention, logs setup failures, and upgrades stale Bun 1.4.2 runtimes', async testCtx => {
  const rootDir = makeTemp(testCtx);
  const fakeSource = makeTemp(testCtx);
  fs.writeFileSync(path.join(fakeSource, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  fs.writeFileSync(
    path.join(fakeSource, 'install.js'),
    'console.error("simulated cert failure"); process.exit(1);\n'
  );

  const lockDir = path.join(rootDir, 'installer.lock');
  const owner = claimLock(lockDir);
  const pendingRes = await ensureBridgeStarted({ rootDir, sourceDir: fakeSource, noAutostart: false });
  assert.equal(pendingRes.action, 'setup-pending');
  releaseLock(lockDir, owner);

  const prevMagpieBun = process.env.MAGPIE_BUN;
  process.env.MAGPIE_BUN = process.execPath;
  let errRes;
  try {
    errRes = await ensureBridgeStarted({ rootDir, sourceDir: fakeSource, noAutostart: false });
  } finally {
    if (prevMagpieBun === undefined) delete process.env.MAGPIE_BUN;
    else process.env.MAGPIE_BUN = prevMagpieBun;
  }
  assert.equal(errRes.action, 'error');
  assert.match(errRes.error, /simulated cert failure/);
  const statusJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'status.json'), 'utf8'));
  assert.equal(statusJson.state, 'error');
  assert.match(statusJson.reason, /simulated cert failure/);
  const logText = fs.readFileSync(path.join(rootDir, 'autostart.log'), 'utf8');
  assert.match(logText, /simulated cert failure/);

  if (process.platform !== 'win32') {
    const upgradeRoot = makeTemp(testCtx);
    const upgradeHome = makeTemp(testCtx);
    const upgradeSource = makeTemp(testCtx);
    fs.writeFileSync(path.join(upgradeSource, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const staged = path.join(makeTemp(testCtx), 'staged');
    fs.mkdirSync(path.join(staged, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(staged, 'bridge.js'), '// bridge\n');
    fs.writeFileSync(path.join(staged, 'engine.js'), '// engine\n');
    fs.writeFileSync(path.join(staged, 'bin', 'runtime'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(upgradeRoot, 'installation.json'),
      JSON.stringify({
        version: '9.9.9',
        release: staged,
        runtime: { kind: 'bun', version: '1.4.2', http2: false },
      })
    );
    fs.writeFileSync(
      path.join(upgradeRoot, 'status.json'),
      JSON.stringify({ version: '9.9.9', state: 'connected' })
    );
    const fakeBun145 = path.join(upgradeHome, '.cache', 'magpie', 'bun', '1.4.5', 'magpie-bun');
    fs.mkdirSync(path.dirname(fakeBun145), { recursive: true });
    fs.writeFileSync(
      fakeBun145,
      '#!/bin/sh\necho \'{"bun":"1.4.5","node":null}\'\n',
      { mode: 0o755 }
    );
    const supLock = path.join(upgradeRoot, 'supervisor.lock');
    const supOwner = claimLock(supLock);
    testCtx.after(() => releaseLock(supLock, supOwner));
    const upgradeRes = await ensureBridgeStarted({
      rootDir: upgradeRoot,
      sourceDir: upgradeSource,
      homeDir: upgradeHome,
      noAutostart: false,
    });
    assert.equal(upgradeRes.action, 'setup');
  }
});
