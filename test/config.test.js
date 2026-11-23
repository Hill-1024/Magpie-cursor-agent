import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchGatewayModels, validateConfig } from '../lib/config.js';

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
