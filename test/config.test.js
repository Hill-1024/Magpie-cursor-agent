import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  fetchGatewayModels,
  hasExplicitRoleFields,
  loadMergedRoles,
  normalizeRoleConfig,
  parseModelRef,
  resolveAutoRouterConfig,
  resolveRoleModel,
  validateConfig,
} from '../lib/config.js';

const baseConfig = {
  enabled: true,
  gateway: 'http://127.0.0.1:3425/v1',
  key: 'test-key',
  model: 'provider/model-a',
  models: [{ id: 'provider/model-a', name: 'Model A', context: 128000 }],
};

test('validateConfig accepts loopback HTTP and rejects remote/credential/duplicate configs', () => {
  assert.equal(validateConfig({}), null);
  assert.equal(validateConfig({ ...baseConfig, enabled: false }), null);
  assert.equal(validateConfig(baseConfig).model, 'provider/model-a');

  for (const badUrl of [
    'https://evil.example/v1',
    'http://127.0.0.1.evil.example/v1',
    'http://secret@127.0.0.1:3425/v1',
    'http://127.0.0.1:3425/v1?x=1',
    'file:///tmp/gateway',
  ]) {
    assert.throws(() => validateConfig({ ...baseConfig, gateway: badUrl }));
  }

  assert.throws(() => validateConfig({ ...baseConfig, model: 'missing' }));
  assert.throws(() =>
    validateConfig({ ...baseConfig, models: [...baseConfig.models, ...baseConfig.models] })
  );
  assert.equal(validateConfig({ ...baseConfig, bugbotModel: 'provider/reviewer' }).roles.bugbot, 'provider/reviewer');
});

test('fetchGatewayModels refreshes live catalogue from local gateway', async testCtx => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer test-key');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'provider/model-a', context_window: 200000 },
          { id: 'group/auto', name: 'Auto Group', context_window: 256000 },
        ],
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => server.close());

  const refreshed = await fetchGatewayModels({
    ...baseConfig,
    gateway: `http://127.0.0.1:${server.address().port}/v1`,
  });
  assert.equal(refreshed.models.length, 2);
  assert.equal(refreshed.models[0].name, 'Model A');
  assert.equal(refreshed.models[1].name, 'Auto Group');
});

test('normalizeRoleConfig, parseModelRef, and resolveRoleModel handle aliases, subtypes, and reasoning', () => {
  const parsed = parseModelRef('magpie/claude-sonnet[reasoning=high]');
  assert.deepEqual(parsed, { modelId: 'magpie/claude-sonnet', effort: 'high' });

  const normalized = normalizeRoleConfig({
    autoRouterModel: 'magpie/router-fast[reasoning=low]',
    subagentModel: 'magpie/haiku',
    subagentTypeModels: { Explore: 'magpie/flash[reasoning=low]', empty: 'inherit' },
    bugbotModel: 'magpie/sonnet[reasoning=xhigh]',
    securitybotModel: 'magpie/opus',
    titleModel: 'magpie/mini',
    summarizeModel: 'magpie/compact',
    memoryModel: 'magpie/mem',
    commitModel: 'none',
  });
  assert.equal(normalized.autoRouter, 'magpie/router-fast[reasoning=low]');
  assert.equal(normalized.subagent, 'magpie/haiku');
  assert.deepEqual(normalized.subagentTypes, { Explore: 'magpie/flash[reasoning=low]' });
  assert.equal(normalized.bugbot, 'magpie/sonnet[reasoning=xhigh]');
  assert.equal(normalized.securitybot, 'magpie/opus');
  assert.equal(normalized.title, 'magpie/mini');
  assert.equal(normalized.summarize, 'magpie/compact');
  assert.equal(normalized.memory, 'magpie/mem');
  assert.equal(normalized.commit, '');

  const config = { model: 'provider/model-a', roles: normalized };
  assert.deepEqual(resolveRoleModel(config, 'subagent', { subagentType: 'explore' }), {
    modelId: 'magpie/flash',
    effort: 'low',
    role: 'subagent',
  });
  assert.deepEqual(resolveRoleModel(config, 'subagent', { subagentType: 'shell' }), {
    modelId: 'magpie/haiku',
    effort: null,
    role: 'subagent',
  });
  assert.deepEqual(resolveRoleModel(config, 'bugbot'), {
    modelId: 'magpie/sonnet',
    effort: 'xhigh',
    role: 'bugbot',
  });
  assert.deepEqual(resolveRoleModel(config, 'commit'), {
    modelId: 'provider/model-a',
    effort: null,
    role: 'default',
  });
});

test('resolveAutoRouterConfig honors explicit cursor/auto and defaults to it with a catalogue retry', () => {
  const modelsWithCursorAuto = [
    { id: 'anthropic/claude-sonnet', name: 'Sonnet', context: 200000 },
    { id: 'cursor/auto', name: 'Cursor Auto', context: 200000 },
  ];
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: modelsWithCursorAuto,
      roles: { autoRouter: 'openai/gpt-5-mini[reasoning=low]' },
    }),
    { modelId: 'openai/gpt-5-mini', effort: 'low', source: 'configured' }
  );
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: modelsWithCursorAuto,
      roles: { autoRouter: '' },
    }),
    { modelId: 'cursor/auto', effort: null, source: 'default-cursor-auto' }
  );
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: [
        { id: 'anthropic/claude-sonnet', name: 'Sonnet', context: 200000 },
        { id: 'cursor/auto-smart', name: 'Auto · Cursor', context: 200000 },
      ],
      roles: { autoRouter: '' },
    }),
    {
      modelId: 'cursor/auto',
      effort: null,
      source: 'default-cursor-auto',
      fallbackModelId: 'cursor/auto-smart',
    }
  );
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: [{ id: 'cursor/auto-smart', name: 'Auto · Cursor', context: 200000 }],
      roles: { autoRouter: 'cursor/auto[reasoning=low]' },
    }),
    { modelId: 'cursor/auto', effort: 'low', source: 'configured' }
  );
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: [
        { id: 'anthropic/claude-sonnet', name: 'Sonnet', context: 200000 },
        { id: 'cursor/grok-4.7', name: 'Grok 4.7 · Cursor', context: 200000 },
      ],
      roles: {},
    }),
    { modelId: 'cursor/auto', effort: null, source: 'default-cursor-auto' }
  );
  assert.deepEqual(
    resolveAutoRouterConfig({
      model: 'anthropic/claude-sonnet',
      models: [{ id: 'anthropic/claude-sonnet', name: 'Sonnet', context: 200000 }],
      roles: {},
    }),
    { modelId: '', effort: null, source: 'fallback-main' }
  );
});

test('loadMergedRoles picks the newer source between plugins.json and roles.json including clears', testCtx => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-roles-'));
  testCtx.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const rootDir = path.join(tempDir, 'bridge-root');
  fs.mkdirSync(rootDir, { recursive: true });
  const pluginsFile = path.join(tempDir, 'plugins.json');
  const rolesFile = path.join(rootDir, 'roles.json');

  fs.writeFileSync(
    pluginsFile,
    JSON.stringify({
      plugins: [
        {
          spec: 'https://github.com/Hill-1024/Magpie-cursor-agent',
          off: false,
          options: { bugbotModel: 'plugin-bugbot', titleModel: 'plugin-title' },
        },
      ],
    })
  );
  fs.writeFileSync(
    rolesFile,
    JSON.stringify({ bugbot: 'roles-bugbot', securitybot: 'roles-sec', title: '' })
  );

  const olderTime = new Date(Date.now() - 10000);
  const newerTime = new Date(Date.now());
  fs.utimesSync(pluginsFile, olderTime, olderTime);
  fs.utimesSync(rolesFile, newerTime, newerTime);

  const fromRoles = loadMergedRoles({ rootDir, pluginsJsonPath: pluginsFile });
  assert.equal(fromRoles.bugbot, 'roles-bugbot');
  assert.equal(fromRoles.securitybot, 'roles-sec');
  assert.equal(fromRoles.title, '');

  const evenNewer = new Date(Date.now() + 10000);
  fs.writeFileSync(
    pluginsFile,
    JSON.stringify({
      plugins: [{ spec: 'cursor-bridge', options: { subagentModel: '', bugbotModel: '' } }],
    })
  );
  fs.utimesSync(pluginsFile, evenNewer, evenNewer);
  assert.equal(hasExplicitRoleFields({ subagentModel: '' }), true);
  const cleared = loadMergedRoles({ rootDir, pluginsJsonPath: pluginsFile });
  assert.equal(cleared.bugbot, '');
  assert.equal(cleared.securitybot, '');
});
