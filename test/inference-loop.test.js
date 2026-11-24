import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { syncKnownModels } from '../lib/config.js';
import { CursorBridgeEngine } from '../lib/cursor-engine.js';
import {
  decodeConnectFrames,
  decodeCursor,
  encodeConnectFrame,
  encodeCursor,
} from '../lib/cursor-schemas.js';
import { startMitmProxy } from '../lib/mitm-proxy.js';
import {
  PRIVATE_INFERENCE_ENV_VAR,
  buildGetTeamsData,
  clearPrivateInferenceConfig,
  privateInferenceConfigPath,
} from '../lib/private-inference.js';
import { toProtoValue } from '../lib/proto-wire.js';
import { generateLocalCa } from '../lib/x509.js';

function openConnectTunnel(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let headerBuf = '';
    const onData = chunk => {
      headerBuf += chunk.toString('latin1');
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx !== -1) {
        socket.removeListener('data', onData);
        const statusLine = headerBuf.slice(0, idx).split('\r\n')[0];
        if (!statusLine.includes('200')) {
          reject(new Error(`CONNECT failed: ${statusLine}`));
          return;
        }
        resolve(socket);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

async function h1PostOverProxy(proxyPort, caCertPem, pathName, bodyBuf, contentType = 'application/proto') {
  const tunnel = await openConnectTunnel(proxyPort, 'api2.cursor.sh:443');
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect(
      { socket: tunnel, servername: 'api2.cursor.sh', ca: caCertPem, ALPNProtocols: ['http/1.1'] },
      () => {
        const reqHeader =
          `POST ${pathName} HTTP/1.1\r\n` +
          'Host: api2.cursor.sh\r\n' +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${bodyBuf.length}\r\n` +
          'Connection: close\r\n\r\n';
        tlsSock.write(Buffer.concat([Buffer.from(reqHeader, 'latin1'), bodyBuf]));
      }
    );
    const chunks = [];
    tlsSock.on('data', chunk => chunks.push(chunk));
    tlsSock.on('end', () => {
      const full = Buffer.concat(chunks);
      const sep = full.indexOf('\r\n\r\n');
      const head = full.subarray(0, sep).toString('latin1');
      const statusMatch = /^HTTP\/1\.1 (\d+)/.exec(head);
      resolve({ status: Number(statusMatch?.[1] || 0), body: full.subarray(sep + 4) });
    });
    tlsSock.on('error', reject);
  });
}

function streamRunInferenceSse({ proxyPort, caCertPem, requestId, onFrame }) {
  return new Promise((resolve, reject) => {
    openConnectTunnel(proxyPort, 'api2.cursor.sh:443')
      .then(tunnel => {
        const tlsSock = tls.connect(
          { socket: tunnel, servername: 'api2.cursor.sh', ca: caCertPem, ALPNProtocols: ['http/1.1'] },
          () => {
            const reqBody = encodeCursor('BidiRequestId', { requestId });
            const reqHeader =
              'POST /aiserver.v1.InferenceService/RunInferenceSSE HTTP/1.1\r\n' +
              'Host: api2.cursor.sh\r\n' +
              'Content-Type: application/proto\r\n' +
              `Content-Length: ${reqBody.length}\r\n` +
              'Connection: close\r\n\r\n';
            tlsSock.write(Buffer.concat([Buffer.from(reqHeader, 'latin1'), reqBody]));
          }
        );
        let headersDone = false;
        let pending = Buffer.alloc(0);
        let endJson = null;
        tlsSock.on('data', chunk => {
          pending = Buffer.concat([pending, chunk]);
          if (!headersDone) {
            const sep = pending.indexOf('\r\n\r\n');
            if (sep === -1) return;
            headersDone = true;
            pending = pending.subarray(sep + 4);
          }
          let body = Buffer.alloc(0);
          while (pending.length > 0) {
            const crlf = pending.indexOf('\r\n');
            if (crlf === -1) break;
            const size = parseInt(pending.subarray(0, crlf).toString('ascii'), 16);
            if (Number.isNaN(size)) {
              body = pending;
              pending = Buffer.alloc(0);
              break;
            }
            if (size === 0) {
              pending = Buffer.alloc(0);
              break;
            }
            if (pending.length < crlf + 2 + size + 2) break;
            body = Buffer.concat([body, pending.subarray(crlf + 2, crlf + 2 + size)]);
            pending = pending.subarray(crlf + 2 + size + 2);
          }
          if (body.length > 0) {
            const { frames, remaining } = decodeConnectFrames(body);
            pending = Buffer.concat([remaining, pending]);
            for (const frame of frames) {
              if (frame.flags === 0x02) {
                endJson = JSON.parse(frame.payload.toString('utf8'));
              } else {
                onFrame?.(decodeCursor('RunInferenceServerMessage', frame.payload));
              }
            }
          }
        });
        tlsSock.on('end', () => resolve(endJson));
        tlsSock.on('error', reject);
      })
      .catch(reject);
  });
}

async function inferenceBidiAppend(proxyPort, caCertPem, requestId, seqno, clientMessage) {
  const clientBytes = encodeCursor('RunInferenceClientMessage', clientMessage);
  const appendBytes = encodeCursor('BidiAppendRequest', {
    requestId: { requestId },
    appendSeqno: seqno,
    dataBinary: clientBytes,
  });
  const resp = await h1PostOverProxy(
    proxyPort,
    caCertPem,
    '/aiserver.v1.BidiService/BidiAppend',
    appendBytes
  );
  assert.equal(resp.status, 200);
}

test('GetTeams disables Private Inference and clearPrivateInferenceConfig removes stale artifacts', () => {
  const teams = decodeCursor(
    'GetTeamsResponse',
    encodeCursor('GetTeamsResponse', buildGetTeamsData())
  );
  assert.equal(teams.teams[0].privateInferenceEnablement, 2);
  assert.equal(teams.teams[0].privateInferenceAvailable, false);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-clear-pi-'));
  try {
    const tomlFile = privateInferenceConfigPath(tempRoot);
    fs.writeFileSync(tomlFile, 'default = "magpie-live"\n');
    const calls = [];
    const res = clearPrivateInferenceConfig({
      rootDir: tempRoot,
      syncEnv: true,
      platform: 'darwin',
      exec: (cmd, args) => calls.push([cmd, args]),
    });
    assert.equal(res.removed, true);
    assert.equal(fs.existsSync(tomlFile), false);
    assert.deepEqual(calls, [['/bin/launchctl', ['unsetenv', PRIVATE_INFERENCE_ENV_VAR]]]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Local-loop catalog hot-reloads via Statsig rev and hides removed models only for new chats', testCtx => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-hot-catalog-'));
  testCtx.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const modelA = { id: 'openai/gpt-6', name: 'GPT-6', context: 200000, efforts: ['high'], fast: false };
  const modelB = { id: 'anthropic/claude-opus', name: 'Opus', context: 200000, efforts: ['xhigh'], fast: false };

  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: 'http://127.0.0.1:49999/v1',
    key: 'secret-key',
    model: modelA.id,
    models: [modelA, modelB],
  });
  syncKnownModels(tempRoot, [modelA, modelB]);

  const statsigBefore = JSON.parse(decodeCursor('BootstrapStatsigResponse', engine.buildStatsigBootstrapResponse()).config);
  assert.equal(statsigBefore.feature_gates.cursor_agent_host.value, true);
  assert.equal(statsigBefore.feature_gates.agent_host_local_loop.value, true);
  assert.equal(statsigBefore.user.userID, 'local_bridge');

  const encodeSeg = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const fakeJwt = `${encodeSeg({ alg: 'none', typ: 'JWT' })}.${encodeSeg({ sub: 'auth0|test_user_42' })}.sig`;
  const statsigAuthed = JSON.parse(
    decodeCursor('BootstrapStatsigResponse', engine.buildStatsigBootstrapResponse({ authorization: `Bearer ${fakeJwt}` })).config
  );
  assert.equal(statsigAuthed.user.userID, 'auth0|test_user_42');
  const serverCfg = decodeCursor('ServerConfigResponse', engine.buildServerConfigResponse());
  assert.equal(serverCfg.chatConfig.clientStatsigPollIntervalMs, 30000);

  const { hiddenModels } = syncKnownModels(tempRoot, [modelA]);
  engine.updateConfig({
    enabled: true,
    gateway: 'http://127.0.0.1:49999/v1',
    key: 'secret-key',
    model: modelA.id,
    models: [modelA],
    hiddenModels,
  });

  const statsigAfter = JSON.parse(decodeCursor('BootstrapStatsigResponse', engine.buildStatsigBootstrapResponse()).config);
  assert.notEqual(
    statsigAfter.dynamic_configs.magpie_catalog.value.rev,
    statsigBefore.dynamic_configs.magpie_catalog.value.rev
  );

  const avail = decodeCursor('AvailableModelsAddition', engine.buildAvailableModelsResponse(false));
  const entryA = avail.models.find(m => m.name === modelA.id);
  const entryB = avail.models.find(m => m.name === modelB.id);
  assert.equal(entryA.defaultOn, true);
  assert.equal(entryB.defaultOn, false);

  const usable = decodeCursor('UsableModelsAddition', engine.buildUsableModelsResponse(false));
  assert.ok(usable.models.some(m => m.modelId === modelA.id));
  assert.ok(!usable.models.some(m => m.modelId === modelB.id));
  assert.equal(usable.models[0].apiKeyCredentials, undefined);

  const nudge = decodeCursor('DefaultModelNudgeDataResponse', engine.buildDefaultModelNudgeResponse(false));
  assert.equal(nudge.shouldDefaultSwitchOnNewChat, true);
  assert.notEqual(nudge.nudgeDate, '0');
  assert.deepEqual(nudge.modelsWithNoDefaultSwitch, ['default', modelA.id]);
});

test('InferenceService RunInference handles HTTP/2 BiDi streaming, hidden old-session models, and tools', async testCtx => {
  const seenRequests = [];
  const mockGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenRequests.push(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning":"pondering"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Using tool..."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"Read","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n');
      res.write('data: {"usage":{"prompt_tokens":120,"completion_tokens":30},"choices":[{"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const ca = generateLocalCa();
  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'gw-secret',
    model: 'openai/gpt-6',
    models: [{ id: 'openai/gpt-6', name: 'GPT-6', context: 200000, efforts: ['high'] }],
    hiddenModels: [{ id: 'anthropic/old-hidden', name: 'Old Hidden', context: 200000, efforts: ['medium'] }],
    roles: { summarize: 'openai/gpt-mini[reasoning=low]' },
  });
  const proxy = await startMitmProxy({ engine, caCertPem: ca.certPem, caKeyPem: ca.keyPem, allowAuthPassthrough: false });
  testCtx.after(() => proxy.close());

  const h2Tunnel = await openConnectTunnel(proxy.port, 'api2.cursor.sh:443');
  const client = http2.connect('https://api2.cursor.sh', {
    createConnection: () => tls.connect({ socket: h2Tunnel, servername: 'api2.cursor.sh', ca: ca.certPem, ALPNProtocols: ['h2'] }),
  });
  testCtx.after(() => client.close());

  const req = client.request({
    ':method': 'POST',
    ':path': '/aiserver.v1.InferenceService/RunInference',
    'content-type': 'application/connect+proto',
    'x-request-id': 'h2-inf-1',
  });

  const serverMsgs = [];
  let endStream = null;
  let pending = Buffer.alloc(0);
  const done = new Promise(resolve => {
    req.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, remaining } = decodeConnectFrames(pending);
      pending = remaining;
      for (const frame of frames) {
        if (frame.flags === 0x02) {
          endStream = JSON.parse(frame.payload.toString('utf8'));
        } else {
          const decoded = decodeCursor('RunInferenceServerMessage', frame.payload);
          serverMsgs.push(decoded);
          if (decoded.runReady) {
            req.write(
              encodeConnectFrame(
                encodeCursor('RunInferenceClientMessage', {
                  invokeModel: {
                    invocationId: 'inv-1',
                    purpose: 0,
                    request: {
                      requestedModel: {
                        modelId: 'anthropic/old-hidden',
                        maxMode: false,
                        parameters: [{ id: 'reasoning', value: 'high' }],
                        builtInModel: false,
                      },
                      messages: [
                        { role: 4, text: 'Native Cursor system prompt' },
                        { role: 1, text: 'Read README' },
                      ],
                      tools: [
                        {
                          name: 'Read',
                          description: 'Read a file',
                          parameters: {
                            fields: {
                              type: toProtoValue('object'),
                              properties: toProtoValue({ path: { type: 'string' } }),
                            },
                          },
                        },
                      ],
                    },
                  },
                })
              )
            );
          } else if (decoded.invocationEnd?.invocationId === 'inv-1') {
            req.write(
              encodeConnectFrame(
                encodeCursor('RunInferenceClientMessage', {
                  finishRun: { aborted: false, turnCompleted: true },
                })
              )
            );
            req.end();
          }
        }
      }
    });
    req.on('end', resolve);
  });

  req.write(
    encodeConnectFrame(
      encodeCursor('RunInferenceClientMessage', {
        runRequest: {
          conversationId: 'conv-old-hidden',
          requestedModel: { modelId: 'anthropic/old-hidden', maxMode: false, parameters: [], builtInModel: false },
        },
      })
    )
  );
  await done;

  assert.deepEqual(endStream, {});
  const ready = serverMsgs.find(m => m.runReady)?.runReady;
  assert.equal(ready.resolvedModel.modelId, 'anthropic/old-hidden');
  assert.equal(ready.summarization.model.modelId, 'openai/gpt-mini');
  assert.equal(seenRequests[0].model, 'anthropic/old-hidden');
  assert.equal(seenRequests[0].reasoning_effort, 'high');
  assert.equal(seenRequests[0].tools[0].function.name, 'Read');

  const parts = serverMsgs.filter(m => m.invocationResponse).map(m => m.invocationResponse.response);
  assert.ok(parts.some(p => p.thinkingPart?.text === 'pondering'));
  assert.ok(parts.some(p => p.textPart?.text === 'Using tool...'));
  assert.ok(parts.some(p => p.toolCallPart?.isComplete && p.toolCallPart?.toolName === 'Read'));
  assert.ok(parts.some(p => p.usage?.promptTokens === 120));
});

test('RunInferenceSSE + BidiAppend handles racing appends, summarization role, and cancellation', async testCtx => {
  const seenRequests = [];
  let abortedCount = 0;
  const mockGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenRequests.push(parsed);
      if (parsed.messages.some(m => m.content === 'hang')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
        req.on('close', () => {
          abortedCount += 1;
        });
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"SUMMARIZED"}}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const ca = generateLocalCa();
  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'gw-secret',
    model: 'openai/gpt-6',
    models: [{ id: 'openai/gpt-6', name: 'GPT-6', context: 200000 }],
    roles: { summarize: 'openai/gpt-mini[reasoning=low]' },
  });
  const proxy = await startMitmProxy({ engine, caCertPem: ca.certPem, caKeyPem: ca.keyPem, allowAuthPassthrough: false });
  testCtx.after(() => proxy.close());

  const requestId = 'sse-inf-1';
  // Intentionally send seqno 0 BEFORE attaching RunInferenceSSE to verify race-free routing!
  await inferenceBidiAppend(proxy.port, ca.certPem, requestId, 0, {
    runRequest: {
      conversationId: 'conv-sse-1',
      requestedModel: { modelId: 'openai/gpt-6', maxMode: false, parameters: [], builtInModel: false },
    },
  });

  const frames = [];
  let cancelResolve;
  const gotPartial = new Promise(resolve => {
    cancelResolve = resolve;
  });
  const sseDone = streamRunInferenceSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: msg => {
      frames.push(msg);
      if (msg.invocationResponse?.response?.textPart?.text === 'partial') {
        cancelResolve();
      }
    },
  });

  await inferenceBidiAppend(proxy.port, ca.certPem, requestId, 1, {
    invokeModel: {
      invocationId: 'inv-sum',
      purpose: 1,
      request: {
        messages: [{ role: 1, text: 'summarize me' }],
      },
    },
  });
  await inferenceBidiAppend(proxy.port, ca.certPem, requestId, 2, {
    invokeModel: {
      invocationId: 'inv-cancel',
      purpose: 0,
      request: {
        messages: [{ role: 1, text: 'hang' }],
      },
    },
  });
  await gotPartial;
  await inferenceBidiAppend(proxy.port, ca.certPem, requestId, 3, {
    cancelInvocation: { invocationId: 'inv-cancel' },
  });
  await inferenceBidiAppend(proxy.port, ca.certPem, requestId, 4, {
    finishRun: { aborted: false, turnCompleted: false },
  });

  const endJson = await sseDone;
  assert.deepEqual(endJson, {});
  assert.equal(seenRequests[0].model, 'openai/gpt-mini');
  assert.equal(seenRequests[0].reasoning_effort, 'low');
  assert.ok(frames.some(m => m.invocationResponse?.response?.textPart?.text === 'SUMMARIZED'));
  assert.ok(abortedCount >= 1);
});
