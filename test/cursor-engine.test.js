import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CursorBridgeEngine } from '../lib/cursor-engine.js';
import { isCursorNativeAuto, parseRoutedModelReply } from '../lib/cursor-engine.js';
import {
  CONNECT_END_STREAM_FLAG,
  decodeConnectFrames,
  decodeCursor,
  encodeCursor,
} from '../lib/cursor-schemas.js';
import { startMitmProxy } from '../lib/mitm-proxy.js';
import { generateLocalCa } from '../lib/x509.js';

function openConnectTls(proxyPort, caCertPem) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write('CONNECT api2.cursor.sh:443 HTTP/1.1\r\nHost: api2.cursor.sh:443\r\n\r\n');
    });
    let head = '';
    const onData = chunk => {
      head += chunk.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        const tlsSock = tls.connect(
          { socket, servername: 'api2.cursor.sh', ca: caCertPem, ALPNProtocols: ['http/1.1'] },
          () => resolve(tlsSock)
        );
        tlsSock.on('error', reject);
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

async function bidiAppend(proxyPort, caCertPem, requestId, seqno, clientMessage, extraHeaders = {}) {
  const bytes = encodeCursor('AgentClientMessage', clientMessage);
  const body = encodeCursor('BidiAppendRequest', {
    data: bytes.toString('hex'),
    requestId: { requestId },
    appendSeqno: seqno,
  });
  const tlsSock = await openConnectTls(proxyPort, caCertPem);
  return new Promise((resolve, reject) => {
    const extraLines = Object.entries(extraHeaders)
      .map(([headerName, headerVal]) => `${headerName}: ${headerVal}\r\n`)
      .join('');
    const header =
      `POST /aiserver.v1.BidiService/BidiAppend HTTP/1.1\r\n` +
      `Host: api2.cursor.sh\r\n` +
      `Content-Type: application/proto\r\n` +
      `Content-Length: ${body.length}\r\n` +
      extraLines +
      `Connection: close\r\n\r\n`;
    tlsSock.write(Buffer.concat([Buffer.from(header), body]));
    const chunks = [];
    tlsSock.on('data', chunk => chunks.push(chunk));
    tlsSock.on('end', () => {
      const raw = Buffer.concat(chunks).toString('latin1');
      assert.match(raw, /^HTTP\/1\.1 200 /);
      resolve();
    });
    tlsSock.on('error', reject);
  });
}

test('end-to-end RunSSE + BidiAppend executes thinking, text, and StrReplace + Shell tools', async testCtx => {
  const ca = generateLocalCa();
  let gatewayRound = 0;
  const receivedPayloads = [];
  let targetFileContent = 'const value = 1;\n';

  const mockGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      receivedPayloads.push(payload);
      gatewayRound += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (gatewayRound === 1) {
        // Emit thinking delta + StrReplace tool call
        res.write('data: {"choices":[{"delta":{"reasoning_content":"Inspecting file..."}}]}\n\n');
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_edit_1',
                      function: {
                        name: 'StrReplace',
                        arguments: JSON.stringify({
                          path: 'demo.js',
                          old_string: 'const value = 1;',
                          new_string: 'const value = 42;',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`
        );
        res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
        res.end('data: [DONE]\n\n');
      } else if (gatewayRound === 2) {
        // Emit Shell tool call
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_shell_1',
                      function: {
                        name: 'Shell',
                        arguments: JSON.stringify({ command: 'echo ok' }),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`
        );
        res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
        res.end('data: [DONE]\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"content":"DONE_SHADOW_BRIDGE"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n');
        res.end('data: [DONE]\n\n');
      }
    });
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'bridge-key',
    model: 'group/auto',
    models: [{ id: 'group/auto', name: 'Auto', context: 200000 }],
  });
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  testCtx.after(() => proxy.close());

  const requestId = 'req-e2e-1';
  let seqno = 0;

  // Open RunSSE stream via Node https.request over our CONNECT tunnel
  const runBody = encodeCursor('BidiRequestId', { requestId });
  const sseTlsSock = await openConnectTls(proxy.port, ca.certPem);
  const observed = { thinking: '', text: '', shellDelta: '', turnEnded: null, endJson: null };
  let buf = Buffer.alloc(0);

  await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'api2.cursor.sh',
        path: '/agent.v1.AgentService/RunSSE',
        method: 'POST',
        createConnection: () => sseTlsSock,
        headers: {
          'Content-Type': 'application/proto',
          'Content-Length': runBody.length,
        },
      },
      res => {
        assert.equal(res.statusCode, 200);
        res.on('data', async chunk => {
          buf = Buffer.concat([buf, chunk]);
          const { frames, remaining } = decodeConnectFrames(buf);
          buf = remaining;
          for (const frame of frames) {
            if (frame.flags & CONNECT_END_STREAM_FLAG) {
              observed.endJson = JSON.parse(frame.payload.toString('utf8'));
              resolve();
              return;
            }
            const srv = decodeCursor('AgentServerMessage', frame.payload);
            if (srv.interactionUpdate?.thinkingDelta) {
              observed.thinking += srv.interactionUpdate.thinkingDelta.text;
            } else if (srv.interactionUpdate?.textDelta) {
              observed.text += srv.interactionUpdate.textDelta.text;
            } else if (srv.interactionUpdate?.toolCallDelta?.toolCallDelta?.shellToolCallDelta?.stdout) {
              observed.shellDelta +=
                srv.interactionUpdate.toolCallDelta.toolCallDelta.shellToolCallDelta.stdout.content;
            } else if (srv.interactionUpdate?.turnEnded) {
              observed.turnEnded = srv.interactionUpdate.turnEnded;
            } else if (srv.execServerMessage) {
              const exec = srv.execServerMessage;
              if (exec.readArgs) {
                await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
                  execClientMessage: {
                    id: exec.id,
                    execId: exec.execId,
                    readResult: {
                      success: {
                        path: exec.readArgs.path,
                        content: targetFileContent,
                        totalLines: 1,
                        fileSize: targetFileContent.length,
                        truncated: false,
                      },
                    },
                  },
                });
              } else if (exec.writeArgs) {
                targetFileContent = exec.writeArgs.fileText;
                await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
                  execClientMessage: {
                    id: exec.id,
                    execId: exec.execId,
                    writeResult: {
                      success: {
                        path: exec.writeArgs.path,
                        linesCreated: 1,
                        fileSize: targetFileContent.length,
                        fileContentAfterWrite: targetFileContent,
                      },
                    },
                  },
                });
              } else if (exec.shellStreamArgs) {
                await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
                  execClientMessage: {
                    id: exec.id,
                    execId: exec.execId,
                    shellStream: { stdout: { data: 'ok\n' } },
                  },
                });
                await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
                  execClientMessage: {
                    id: exec.id,
                    execId: exec.execId,
                    shellStream: { exit: { code: 0, cwd: '/tmp/ws', aborted: false } },
                  },
                });
              }
            }
          }
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(runBody);

    bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
      runRequest: {
        conversationId: 'conv-e2e',
        runId: requestId,
        requestedModel: { modelId: 'group/auto[context=200k,reasoning=high,fast=false]' },
        action: {
          userMessageAction: {
            userMessage: { text: 'Update demo.js and run echo', messageId: 'u-1', mode: 1 },
            requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
          },
        },
      },
    }).catch(reject);
  });

  assert.equal(observed.thinking, 'Inspecting file...');
  assert.equal(observed.shellDelta, 'ok\n');
  assert.equal(observed.text, 'DONE_SHADOW_BRIDGE');
  assert.equal(targetFileContent, 'const value = 42;\n');
  assert.equal(observed.turnEnded.inputTokens, 12);
  assert.equal(observed.turnEnded.outputTokens, 4);
  assert.deepEqual(observed.endJson, {});
  assert.equal(receivedPayloads[0].model, 'group/auto');
  assert.equal(receivedPayloads[0].reasoning_effort, 'high');
});

async function startRunSseProxy({ onGatewayRequest, roles = null, models = null }) {
  const ca = generateLocalCa();
  const mockGateway = http.createServer(onGatewayRequest);
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  const catalogue = models || [{ id: 'group/auto', name: 'Auto', context: 200000 }];
  const config = {
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'test-key',
    model: 'group/auto',
    models: catalogue,
  };
  if (roles) {
    config.roles = roles;
  }
  const engine = new CursorBridgeEngine(config);
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  return { ca, engine, mockGateway, proxy };
}

async function streamRunSse({ proxyPort, caCertPem, requestId, onFrame }) {
  const runBody = encodeCursor('BidiRequestId', { requestId });
  const sseTlsSock = await openConnectTls(proxyPort, caCertPem);
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value);
    };
    const req = https.request(
      {
        host: 'api2.cursor.sh',
        method: 'POST',
        path: '/agent.v1.AgentService/RunSSE',
        headers: {
          'Content-Type': 'application/proto',
          'Content-Length': runBody.length,
        },
        createConnection: () => sseTlsSock,
      },
      res => {
        let buffer = Buffer.alloc(0);
        let chain = Promise.resolve();
        res.on('data', chunk => {
          chain = chain
            .then(async () => {
              buffer = Buffer.concat([buffer, chunk]);
              const { frames, remaining } = decodeConnectFrames(buffer);
              buffer = remaining;
              for (const frame of frames) {
                if (frame.flags & CONNECT_END_STREAM_FLAG) {
                  settle(null, JSON.parse(frame.payload.toString('utf8')));
                  return;
                }
                const serverMessage = decodeCursor('AgentServerMessage', frame.payload);
                await onFrame(serverMessage);
              }
            })
            .catch(err => settle(err));
        });
        res.on('end', () => {
          chain.then(() => {
            if (!settled) settle(new Error('RunSSE ended without terminal Connect frame'));
          });
        });
        res.on('error', err => settle(err));
      }
    );
    req.on('error', err => settle(err));
    req.end(runBody);
  });
}

test('BidiAppend buffers out-of-order seqnos and hydrates historical turns via KvServerMessage GetBlobArgs', async testCtx => {
  const capturedMessages = [];
  const { ca, mockGateway, proxy } = await startRunSseProxy({
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        capturedMessages.push(payload.messages);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"HYDRATED_OK"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const userBlobId = Buffer.from('user-blob-1', 'utf8');
  const stepBlobId = Buffer.from('step-blob-1', 'utf8');
  const turnBlobId = Buffer.from('turn-blob-1', 'utf8');
  const blobStore = new Map([
    [
      userBlobId.toString('hex'),
      encodeCursor('UserMessage', { text: 'Previous user turn', messageId: 'hist-u1', mode: 1 }),
    ],
    [
      stepBlobId.toString('hex'),
      encodeCursor('ConversationStep', { assistantMessage: { text: 'Previous assistant turn' } }),
    ],
    [
      turnBlobId.toString('hex'),
      encodeCursor('ConversationTurnStructure', {
        agentConversationTurn: {
          userMessage: userBlobId,
          steps: [stepBlobId],
          requestId: 'hist-req-1',
        },
      }),
    ],
  ]);

  const requestId = 'req-ooo-kv';
  let nextSeqno = 2;
  let assistantText = '';
  const requestedBlobHexIds = [];

  const runDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: async serverMessage => {
      if (serverMessage.interactionUpdate?.textDelta) {
        assistantText += serverMessage.interactionUpdate.textDelta.text;
      } else if (serverMessage.kvServerMessage?.getBlobArgs) {
        const kvMsg = serverMessage.kvServerMessage;
        const hexId = Buffer.from(kvMsg.getBlobArgs.blobId).toString('hex');
        requestedBlobHexIds.push(hexId);
        await bidiAppend(proxy.port, ca.certPem, requestId, nextSeqno++, {
          kvClientMessage: {
            id: kvMsg.id,
            getBlobResult: { blobData: blobStore.get(hexId) },
          },
        });
      }
    },
  });

  // Deliver seqno=1 (RequestContext reply) BEFORE seqno=0 (RunRequest) and verify duplicate seqno=1 is ignored
  await bidiAppend(proxy.port, ca.certPem, requestId, 1, {
    execClientMessage: {
      id: 0,
      execId: `ctx-${requestId}`,
      requestContextResult: {
        success: {
          requestContext: {
            env: { workspacePaths: ['/tmp/ooo-ws'] },
          },
        },
      },
    },
  });
  await bidiAppend(proxy.port, ca.certPem, requestId, 1, {
    clientHeartbeat: {},
  });
  await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
    runRequest: {
      conversationId: 'conv-kv',
      runId: requestId,
      conversationState: { turns: [turnBlobId] },
      action: {
        userMessageAction: {
          userMessage: { text: 'Current question', messageId: 'u-2', mode: 1 },
        },
      },
    },
  });

  const endJson = await runDone;
  assert.deepEqual(endJson, {});
  assert.equal(assistantText, 'HYDRATED_OK');
  assert.deepEqual(requestedBlobHexIds, [
    turnBlobId.toString('hex'),
    userBlobId.toString('hex'),
    stepBlobId.toString('hex'),
  ]);
  assert.deepEqual(capturedMessages[0], [
    { role: 'system', content: 'Workspace paths: /tmp/ooo-ws' },
    { role: 'user', content: 'Previous user turn' },
    { role: 'assistant', content: 'Previous assistant turn' },
    { role: 'user', content: 'Current question' },
  ]);
});

test('CancelAction aborts active OpenAI SSE stream cleanly with canceled status', async testCtx => {
  let resolveGatewayClosed;
  const gatewayClosed = new Promise(resolve => {
    resolveGatewayClosed = resolve;
  });
  let activeGatewayRes = null;

  const { ca, mockGateway, proxy } = await startRunSseProxy({
    onGatewayRequest: (req, res) => {
      activeGatewayRes = res;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
      req.on('close', () => resolveGatewayClosed());
      res.on('close', () => resolveGatewayClosed());
    },
  });
  testCtx.after(() => activeGatewayRes?.destroy());
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const requestId = 'req-cancel';
  let receivedPartial = '';
  let resolveFirstDelta;
  const firstDeltaSeen = new Promise(resolve => {
    resolveFirstDelta = resolve;
  });

  const runDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: async serverMessage => {
      if (serverMessage.interactionUpdate?.textDelta) {
        receivedPartial += serverMessage.interactionUpdate.textDelta.text;
        resolveFirstDelta();
      }
    },
  });

  await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
    runRequest: {
      conversationId: 'conv-cancel',
      runId: requestId,
      action: {
        userMessageAction: {
          userMessage: { text: 'Stream forever', messageId: 'u-cancel', mode: 1 },
          requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
        },
      },
    },
  });

  await firstDeltaSeen;
  assert.equal(receivedPartial, 'partial ');

  await bidiAppend(proxy.port, ca.certPem, requestId, 1, {
    conversationAction: {
      cancelAction: { reason: 'user_aborted_turn' },
    },
  });

  const endJson = await runDone;
  await gatewayClosed;
  assert.equal(endJson.error?.code, 'canceled');
});

test('AvailableModels populates subagentModelConfigs and RunSSE routes role models', async testCtx => {
  const gatewayRequests = [];
  const roles = {
    subagent: 'magpie/sub-default',
    subagentTypes: { explore: 'magpie/explore-fast[reasoning=low]' },
    bugbot: 'magpie/bug-sonnet',
    securitybot: 'magpie/sec-opus[reasoning=xhigh]',
    summarize: 'magpie/compact-llm',
    memory: 'magpie/mem-llm',
  };
  const models = [
    { id: 'group/auto', name: 'Auto', context: 200000 },
    { id: 'magpie/sub-default', name: 'Sub Default', context: 128000 },
    { id: 'magpie/explore-fast', name: 'Explore Fast', context: 128000 },
    { id: 'magpie/bug-sonnet', name: 'Bug Sonnet', context: 200000 },
    { id: 'magpie/sec-opus', name: 'Sec Opus', context: 200000 },
    { id: 'magpie/compact-llm', name: 'Compact LLM', context: 200000 },
    { id: 'magpie/mem-llm', name: 'Memory LLM', context: 128000 },
  ];
  const { ca, engine, mockGateway, proxy } = await startRunSseProxy({
    roles,
    models,
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        gatewayRequests.push({ model: payload.model, effort: payload.reasoning_effort || null });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ROLE_OK"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const availBytes = engine.buildAvailableModelsResponse(false);
  const availDecoded = decodeCursor('AvailableModelsAddition', availBytes);
  assert.equal(availDecoded.subagentModelConfigs.explore.defaultModel, 'magpie/explore-fast');
  assert.equal(availDecoded.subagentModelConfigs.shell.defaultModel, 'magpie/sub-default');
  assert.equal(availDecoded.subagentModelConfigs.generalPurpose.defaultModel, 'magpie/sub-default');

  const runScenario = async (requestId, runRequest, headers = {}) => {
    const runDone = streamRunSse({
      proxyPort: proxy.port,
      caCertPem: ca.certPem,
      requestId,
      onFrame: async () => {},
    });
    await bidiAppend(proxy.port, ca.certPem, requestId, 0, { runRequest }, headers);
    const endJson = await runDone;
    assert.deepEqual(endJson, {});
  };

  await runScenario(
    'req-role-sub-parent',
    {
      conversationId: 'conv-sub',
      runId: 'req-role-sub-parent',
      action: {
        userMessageAction: {
          userMessage: { text: 'Inspect files', messageId: 'm1', mode: 1 },
          requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
        },
      },
    },
    { 'x-parent-request-id': 'root-req-1' }
  );

  await runScenario('req-role-explore', {
    conversationId: 'conv-explore',
    runId: 'req-role-explore',
    subagentTypeName: 'explore',
    action: {
      userMessageAction: {
        userMessage: { text: 'Find handlers', messageId: 'm2', mode: 1 },
        requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
      },
    },
  });

  await runScenario('req-role-sec', {
    conversationId: 'conv-sec',
    runId: 'req-role-sec',
    subagentTypeName: 'securitybot',
    action: {
      userMessageAction: {
        userMessage: { text: 'Audit auth', messageId: 'm3', mode: 1 },
        requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
      },
    },
  });

  await runScenario('req-role-bugbot', {
    conversationId: 'conv-bug',
    runId: 'req-role-bugbot',
    harness: 'bugbot',
    action: {
      userMessageAction: {
        userMessage: { text: 'Review diff', messageId: 'm4', mode: 1 },
        requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
      },
    },
  });

  await runScenario('req-role-summarize', {
    conversationId: 'conv-sum',
    runId: 'req-role-summarize',
    action: {
      summarizeAction: {
        requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
      },
    },
  });

  await runScenario('req-role-memory', {
    conversationId: 'conv-mem',
    runId: 'req-role-memory',
    customSystemPrompt: '<memory_generation>Consolidate memories</memory_generation>',
    action: {
      userMessageAction: {
        userMessage: { text: 'Extract facts', messageId: 'm5', mode: 1 },
        requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
      },
    },
  });

  assert.deepEqual(gatewayRequests, [
    { model: 'magpie/sub-default', effort: null },
    { model: 'magpie/explore-fast', effort: 'low' },
    { model: 'magpie/sec-opus', effort: 'xhigh' },
    { model: 'magpie/bug-sonnet', effort: null },
    { model: 'magpie/compact-llm', effort: null },
    { model: 'magpie/mem-llm', effort: null },
  ]);
});

test('isCursorNativeAuto and parseRoutedModelReply isolate cursor/auto and parse router replies safely', () => {
  const catalogue = [
    { id: 'cursor/auto', name: 'Cursor Auto', context: 200000 },
    { id: 'openai/gpt-5', name: 'GPT-5', context: 200000 },
    { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', context: 200000 },
    { id: 'anthropic/claude-opus', name: 'Claude Opus', context: 200000 },
  ];
  assert.equal(isCursorNativeAuto('default', { models: catalogue }), true);
  assert.equal(isCursorNativeAuto('auto', { models: catalogue }), true);
  assert.equal(isCursorNativeAuto('auto-low', { models: catalogue }), true);
  assert.equal(isCursorNativeAuto('cursor/auto', { models: catalogue }), false);
  assert.equal(isCursorNativeAuto('group/auto', { models: catalogue }), false);
  assert.equal(isCursorNativeAuto('', { models: catalogue }), false);

  assert.equal(
    parseRoutedModelReply('<think>compare models</think>\n```json\n{"model":"anthropic/claude-opus"}\n```', catalogue),
    'anthropic/claude-opus'
  );
  assert.equal(
    parseRoutedModelReply('Select openai/gpt-5-mini for this small task.', catalogue),
    'openai/gpt-5-mini'
  );
  assert.equal(parseRoutedModelReply('{"model":"cursor/auto"}', catalogue), 'cursor/auto');
  assert.equal(parseRoutedModelReply('unknown-model-xyz', catalogue), null);
});

test('Auto routing supports Links 1, 2, 3, and 4 with strict single-hop anti-loop guarantees', async testCtx => {
  const recordedCalls = [];
  let routerReplyText = '{"model":"magpie/coder-opus"}';
  const catalogue = [
    { id: 'cursor/auto', name: 'Cursor Auto', context: 200000 },
    { id: 'role/router-fast', name: 'Router Fast', context: 128000 },
    { id: 'magpie/coder-opus', name: 'Coder Opus', context: 200000 },
    { id: 'magpie/main-fallback', name: 'Main Fallback', context: 200000 },
  ];

  const ca = generateLocalCa();
  const mockGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const isRouterCall =
        Array.isArray(payload.messages) &&
        payload.messages[0]?.role === 'system' &&
        String(payload.messages[0].content || '').includes('model router for Magpie Cursor Bridge');
      recordedCalls.push({
        model: payload.model,
        effort: payload.reasoning_effort || null,
        isRouterCall,
        toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const replyText = isRouterCall ? routerReplyText : `EXEC_WITH_${payload.model}`;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`);
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const config = {
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'test-key',
    model: 'magpie/main-fallback',
    models: catalogue,
    roles: { autoRouter: 'role/router-fast[reasoning=low]' },
  };
  const engine = new CursorBridgeEngine(config);
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  testCtx.after(() => proxy.close());

  const runPrompt = async (requestId, requestedModel) => {
    let text = '';
    const routedLabels = [];
    const runDone = streamRunSse({
      proxyPort: proxy.port,
      caCertPem: ca.certPem,
      requestId,
      onFrame: async serverMessage => {
        if (serverMessage.interactionUpdate?.textDelta) {
          text += serverMessage.interactionUpdate.textDelta.text;
        } else if (serverMessage.interactionUpdate?.routedModel) {
          routedLabels.push(serverMessage.interactionUpdate.routedModel.displayName);
        }
      },
    });
    await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
      runRequest: {
        conversationId: `conv-${requestId}`,
        runId: requestId,
        requestedModel,
        action: {
          userMessageAction: {
            userMessage: { text: 'Refactor auth module cleanly', messageId: `m-${requestId}`, mode: 1 },
            requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
          },
        },
      },
    });
    const endJson = await runDone;
    assert.deepEqual(endJson, {});
    return { text, routedLabels };
  };

  // Link 1a: Cursor native Auto + configured autoRouter picks Magpie model
  routerReplyText = '{"model":"magpie/coder-opus"}';
  const link1a = await runPrompt('req-link-1a', {
    modelId: 'default',
    parameters: [{ id: 'reasoning', value: 'high' }],
  });
  assert.equal(link1a.text, 'EXEC_WITH_magpie/coder-opus');
  assert.deepEqual(link1a.routedLabels, ['Coder Opus · magpie/coder-opus']);

  // Link 1b: Configured autoRouter picks cursor/auto -> executes cursor/auto once without looping
  routerReplyText = '{"model":"cursor/auto"}';
  const link1b = await runPrompt('req-link-1b', { modelId: 'default' });
  assert.equal(link1b.text, 'EXEC_WITH_cursor/auto');
  assert.deepEqual(link1b.routedLabels, ['Cursor Auto · cursor/auto']);

  // Link 3: User manually selects cursor/auto -> bypasses autoRouter completely
  const link3 = await runPrompt('req-link-3', {
    modelId: 'cursor/auto[context=200k,reasoning=medium,fast=false]',
  });
  assert.equal(link3.text, 'EXEC_WITH_cursor/auto');
  assert.deepEqual(link3.routedLabels, []);

  // Link 4 (default router = cursor/auto when autoRouter is empty & cursor/auto exists) + Link 2
  engine.updateConfig({ ...config, roles: { autoRouter: '' } });
  routerReplyText = '{"model":"magpie/coder-opus"}';
  const link4 = await runPrompt('req-link-4', { modelId: 'default' });
  assert.equal(link4.text, 'EXEC_WITH_magpie/coder-opus');

  // Link 2 self-selection: cursor/auto as router returning cursor/auto still executes single-hop
  engine.updateConfig({ ...config, roles: { autoRouter: 'cursor/auto' } });
  routerReplyText = '{"model":"cursor/auto"}';
  const link2Self = await runPrompt('req-link-2-self', { modelId: 'default' });
  assert.equal(link2Self.text, 'EXEC_WITH_cursor/auto');

  // Link 4 fallback: without autoRouter and without cursor/auto in catalogue, falls back directly to config.model
  engine.updateConfig({
    ...config,
    models: catalogue.filter(entry => entry.id !== 'cursor/auto'),
    roles: { autoRouter: '' },
  });
  const link4Fallback = await runPrompt('req-link-4-fallback', { modelId: 'default' });
  assert.equal(link4Fallback.text, 'EXEC_WITH_magpie/main-fallback');

  assert.deepEqual(recordedCalls, [
    { model: 'role/router-fast', effort: 'low', isRouterCall: true, toolCount: 0 },
    { model: 'magpie/coder-opus', effort: 'high', isRouterCall: false, toolCount: 9 },
    { model: 'role/router-fast', effort: 'low', isRouterCall: true, toolCount: 0 },
    { model: 'cursor/auto', effort: null, isRouterCall: false, toolCount: 9 },
    { model: 'cursor/auto', effort: 'medium', isRouterCall: false, toolCount: 9 },
    { model: 'cursor/auto', effort: null, isRouterCall: true, toolCount: 0 },
    { model: 'magpie/coder-opus', effort: null, isRouterCall: false, toolCount: 9 },
    { model: 'cursor/auto', effort: null, isRouterCall: true, toolCount: 0 },
    { model: 'cursor/auto', effort: null, isRouterCall: false, toolCount: 9 },
    { model: 'magpie/main-fallback', effort: null, isRouterCall: false, toolCount: 9 },
  ]);
});

test('Auto routing falls back on router errors and aborts cleanly on CancelAction during routing', async testCtx => {
  const seenModels = [];
  let routerMode = 'error';
  let resolveRouterStarted;
  const routerStarted = new Promise(resolve => {
    resolveRouterStarted = resolve;
  });
  let activeRouterRes = null;

  const { ca, mockGateway, proxy } = await startRunSseProxy({
    roles: { autoRouter: 'cursor/auto' },
    models: [
      { id: 'group/auto', name: 'Auto', context: 200000 },
      { id: 'cursor/auto', name: 'Cursor Auto', context: 200000 },
    ],
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        seenModels.push(payload.model);
        if (payload.model === 'cursor/auto') {
          if (routerMode === 'error') {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'router unavailable' } }));
            return;
          }
          activeRouterRes = res;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          resolveRouterStarted();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"FALLBACK_OK"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => activeRouterRes?.destroy());
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  let fallbackText = '';
  const fallbackDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId: 'req-router-err',
    onFrame: async msg => {
      if (msg.interactionUpdate?.textDelta) fallbackText += msg.interactionUpdate.textDelta.text;
    },
  });
  await bidiAppend(proxy.port, ca.certPem, 'req-router-err', 0, {
    runRequest: {
      conversationId: 'conv-router-err',
      runId: 'req-router-err',
      requestedModel: { modelId: 'default' },
      action: {
        userMessageAction: {
          userMessage: { text: 'Explain event loop', messageId: 'm-err', mode: 1 },
          requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
        },
      },
    },
  });
  assert.deepEqual(await fallbackDone, {});
  assert.equal(fallbackText, 'FALLBACK_OK');

  routerMode = 'hang';
  const cancelDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId: 'req-router-cancel',
    onFrame: async () => {},
  });
  await bidiAppend(proxy.port, ca.certPem, 'req-router-cancel', 0, {
    runRequest: {
      conversationId: 'conv-router-cancel',
      runId: 'req-router-cancel',
      requestedModel: { modelId: 'default' },
      action: {
        userMessageAction: {
          userMessage: { text: 'Cancel during route', messageId: 'm-cancel', mode: 1 },
          requestContext: { env: { workspacePaths: ['/tmp/ws'] } },
        },
      },
    },
  });
  await routerStarted;
  await bidiAppend(proxy.port, ca.certPem, 'req-router-cancel', 1, {
    conversationAction: { cancelAction: { reason: 'user_aborted_route' } },
  });
  const cancelEnd = await cancelDone;
  assert.equal(cancelEnd.error?.code, 'canceled');
  assert.deepEqual(seenModels, ['cursor/auto', 'group/auto', 'cursor/auto']);
});

test('RequestContext timeout aborts pending exec cleanly and normal turn emits terminal checkpoint after turnEnded', async testCtx => {
  const prevTimeout = process.env.CURSOR_BRIDGE_REQUEST_CONTEXT_TIMEOUT_MS;
  process.env.CURSOR_BRIDGE_REQUEST_CONTEXT_TIMEOUT_MS = '80';
  testCtx.after(() => {
    if (prevTimeout === undefined) delete process.env.CURSOR_BRIDGE_REQUEST_CONTEXT_TIMEOUT_MS;
    else process.env.CURSOR_BRIDGE_REQUEST_CONTEXT_TIMEOUT_MS = prevTimeout;
  });

  const { ca, mockGateway, proxy } = await startRunSseProxy({
    onGatewayRequest: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"TERMINAL_OK"}}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    },
  });
  testCtx.after(async () => {
    await proxy.close();
    mockGateway.close();
  });

  const seenFrames = [];
  const done = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId: 'req-terminal-chk',
    onFrame: async msg => {
      seenFrames.push(msg);
    },
  });
  await bidiAppend(proxy.port, ca.certPem, 'req-terminal-chk', 0, {
    runRequest: {
      conversationId: 'conv-term',
      runId: 'req-terminal-chk',
      requestedModel: { modelId: 'group/auto' },
      action: {
        userMessageAction: {
          userMessage: { text: 'Say TERMINAL_OK', messageId: 'm-term', mode: 1 },
        },
      },
    },
  });

  const endJson = await done;
  assert.deepEqual(endJson, {});
  const abortIdx = seenFrames.findIndex(msg => msg.execServerControlMessage?.abort?.id === 0);
  const turnEndedIdx = seenFrames.findIndex(msg => Boolean(msg.interactionUpdate?.turnEnded));
  const checkpointIdx = seenFrames.findIndex(msg => Boolean(msg.conversationCheckpointUpdate));
  assert.ok(abortIdx >= 0, 'expected execServerControlMessage.abort for timed-out RequestContext');
  assert.ok(turnEndedIdx > abortIdx, 'expected turnEnded after RequestContext abort');
  assert.ok(checkpointIdx > turnEndedIdx, 'expected terminal conversationCheckpointUpdate after turnEnded');
});

test('AvailableModels exposes only each model context and effort capabilities', () => {
  const engine = new CursorBridgeEngine({
    model: 'cursor/grok-4.7@500k',
    models: [
      {
        id: 'cursor/grok-4.7@500k',
        name: 'Grok 4.7 @ 500k',
        context: 500000,
        efforts: ['low', 'medium', 'high', 'xhigh'],
        fast: true,
      },
      {
        id: 'auto/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        context: 1048000,
        efforts: ['low', 'high', 'max'],
        fast: false,
      },
      {
        id: 'cursor/auto-smart',
        name: 'Auto',
        context: 200000,
        efforts: [],
        fast: false,
      },
      {
        id: 'local/small',
        name: 'Small',
        context: 128000,
        efforts: [],
        fast: false,
      },
    ],
    roles: {},
  });

  const decoded = decodeCursor('AvailableModelsAddition', engine.buildAvailableModelsResponse(false));
  const byName = new Map(decoded.models.map(model => [model.name, model]));
  const values = (model, id) => {
    const parameter = model.parameterDefinitions.find(entry => entry.id === id);
    const type = parameter?.parameterType;
    return (type?.enumParameter?.values || type?.booleanParameter?.values)?.map(entry => entry.value);
  };

  const grok = byName.get('cursor/grok-4.7@500k');
  assert.deepEqual(values(grok, 'context'), ['200k', '356k', '500k']);
  assert.deepEqual(values(grok, 'reasoning'), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(values(grok, 'fast'), ['false', 'true']);
  assert.equal(grok.supportsThinking, true);
  assert.equal(grok.supportsMaxMode, true);

  const deepseek = byName.get('auto/deepseek-v4.1-flash');
  assert.deepEqual(values(deepseek, 'context'), ['200k', '356k', '500k', '800k', '1m']);
  assert.deepEqual(values(deepseek, 'reasoning'), ['low', 'high', 'max']);
  assert.equal(values(deepseek, 'fast'), undefined);
  assert.equal(deepseek.supportsMaxMode, false);

  const auto = byName.get('cursor/auto-smart');
  assert.deepEqual(values(auto, 'context'), ['200k']);
  assert.deepEqual(values(auto, 'reasoning'), ['default']);
  assert.equal(values(auto, 'fast'), undefined);
  assert.equal(auto.supportsThinking, false);
  assert.equal(auto.supportsMaxMode, false);

  const small = byName.get('local/small');
  assert.deepEqual(values(small, 'context'), ['128000']);
  assert.deepEqual(values(small, 'reasoning'), ['default']);
  assert.equal(values(small, 'fast'), undefined);
  assert.equal(small.supportsThinking, false);
});

test('fast is forwarded as priority only for models that support it', async testCtx => {
  const requests = [];
  const { ca, mockGateway, proxy } = await startRunSseProxy({
    models: [
      { id: 'group/auto', name: 'Auto', context: 200000, fast: false },
      { id: 'cursor/grok-4.7@500k', name: 'Grok 500K', context: 500000, fast: true },
      { id: 'auto/deepseek-v4.1-flash', name: 'DeepSeek', context: 1048000, fast: false },
    ],
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"FAST_OK"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const run = async (requestId, modelId) => {
    const done = streamRunSse({
      proxyPort: proxy.port,
      caCertPem: ca.certPem,
      requestId,
      onFrame: async () => {},
    });
    await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
      runRequest: {
        conversationId: `conv-${requestId}`,
        runId: requestId,
        requestedModel: {
          modelId,
          parameters: [{ id: 'fast', value: 'true' }],
        },
        action: {
          userMessageAction: {
            userMessage: { text: 'Say FAST_OK', messageId: `m-${requestId}`, mode: 1 },
          },
        },
      },
    });
    assert.deepEqual(await done, {});
  };

  await run('fast-supported', 'cursor/grok-4.7@500k');
  await run('fast-unsupported', 'auto/deepseek-v4.1-flash');

  assert.equal(requests[0].model, 'cursor/grok-4.7@500k');
  assert.equal(requests[0].service_tier, 'priority');
  assert.equal(requests[1].model, 'auto/deepseek-v4.1-flash');
  assert.equal('service_tier' in requests[1], false);
});

test('hydrateMessages strips skill bodies, filters rule types, deduplicates MCP tools, and hydrates prependUserMessages', async testCtx => {
  const capturedPayloads = [];
  const { ca, mockGateway, proxy } = await startRunSseProxy({
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        capturedPayloads.push(payload);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"TRIMMED_OK"}}]}\n\n');
        res.write(
          `data: ${JSON.stringify({
            choices: [{ finish_reason: 'stop' }],
            usage: { prompt_tokens: 420, completion_tokens: 12 },
          })}\n\n`
        );
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const hugeSkillBody = 'SECRET_SKILL_BODY_SHOULD_NOT_BE_INJECTED '.repeat(4000);
  const hugeAgentRuleBody = 'AGENT_FETCHED_RULE_BODY_SHOULD_NOT_BE_INJECTED '.repeat(2000);
  const hugeGlobRuleBody = 'GLOB_RULE_BODY_SHOULD_NOT_BE_INJECTED '.repeat(2000);
  const manualRuleBody = 'MANUAL_RULE_BODY_SHOULD_NOT_BE_INJECTED '.repeat(500);

  const agentSkills = Array.from({ length: 12 }, (_, idx) => ({
    fullPath: `/Users/demo/.agents/skills/skill-${idx}/SKILL.md`,
    description: `Skill ${idx} concise summary`,
    content: hugeSkillBody,
    disableModelInvocation: idx === 11,
  }));

  const requestId = 'req-trimmed-context';
  const runDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: async () => {},
  });

  const dupTool = {
    name: 'mcp_demo_lookup',
    description: 'Lookup item',
    inputSchemaJson: JSON.stringify({ type: 'object', properties: { q: { type: 'string' } } }),
    providerIdentifier: 'demo',
    toolName: 'lookup',
  };

  await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
    runRequest: {
      conversationId: 'conv-trimmed',
      runId: requestId,
      mcpTools: { mcpTools: [dupTool] },
      action: {
        userMessageAction: {
          prependUserMessages: [{ text: 'Prepended context note', messageId: 'p-1', mode: 1 }],
          userMessage: { text: 'Fix bug', messageId: 'u-1', mode: 1 },
          requestContext: {
            env: { workspacePaths: ['/tmp/ws'] },
            tools: [dupTool],
            agentSkills,
            rules: [
              {
                fullPath: '/tmp/ws/.cursor/rules/global.mdc',
                content: 'ALWAYS_RULE_BODY',
                type: { global: {} },
              },
              {
                fullPath: '/tmp/ws/.cursor/rules/agent-req.mdc',
                content: hugeAgentRuleBody,
                type: { agentFetched: { description: 'Use when editing auth' } },
              },
              {
                fullPath: '/tmp/ws/.cursor/rules/glob.mdc',
                content: hugeGlobRuleBody,
                type: { fileGlobbed: { globs: ['**/*.ts'] } },
              },
              {
                fullPath: '/tmp/ws/.cursor/rules/manual.mdc',
                content: manualRuleBody,
                type: { manuallyAttached: {} },
              },
              {
                fullPath: '/Users/demo/.agents/skills/skill-0/SKILL.md',
                content: hugeSkillBody,
              },
              {
                fullPath: '/tmp/ws/.cursor/rules/plain.mdc',
                content: 'PLAIN_UNTYPED_RULE',
              },
            ],
          },
        },
      },
    },
  });

  assert.deepEqual(await runDone, {});
  assert.equal(capturedPayloads.length, 1);
  const systemContent = capturedPayloads[0].messages[0].content;
  assert.equal(systemContent.includes('SECRET_SKILL_BODY_SHOULD_NOT_BE_INJECTED'), false);
  assert.equal(systemContent.includes('AGENT_FETCHED_RULE_BODY_SHOULD_NOT_BE_INJECTED'), false);
  assert.equal(systemContent.includes('GLOB_RULE_BODY_SHOULD_NOT_BE_INJECTED'), false);
  assert.equal(systemContent.includes('MANUAL_RULE_BODY_SHOULD_NOT_BE_INJECTED'), false);
  assert.equal(systemContent.includes('skill-11'), false);
  assert.ok(systemContent.includes('/Users/demo/.agents/skills/skill-0/SKILL.md: Skill 0 concise summary'));
  assert.ok(systemContent.includes('ALWAYS_RULE_BODY'));
  assert.ok(systemContent.includes('PLAIN_UNTYPED_RULE'));
  assert.ok(systemContent.includes('/tmp/ws/.cursor/rules/agent-req.mdc: Use when editing auth'));
  assert.ok(systemContent.includes('/tmp/ws/.cursor/rules/glob.mdc: globs: **/*.ts'));
  assert.ok(systemContent.length < 10_000, `expected compact system prompt, got ${systemContent.length} chars`);

  assert.deepEqual(capturedPayloads[0].messages.slice(1), [
    { role: 'user', content: 'Prepended context note' },
    { role: 'user', content: 'Fix bug' },
  ]);

  const toolNames = capturedPayloads[0].tools.map(item => item.function.name);
  assert.equal(toolNames.filter(name => name === 'mcp_demo_lookup').length, 1);
});

test('progressive MCP disclosure uses GetMcpTools + CallMcpTool and trims plugin/nested rules, cloud dupes, and long history', async testCtx => {
  const gatewayPayloads = [];
  const executedMcpArgs = [];
  const observedCards = [];
  let round = 0;

  const { ca, mockGateway, proxy } = await startRunSseProxy({
    models: [
      { id: 'group/auto', name: 'Auto', context: 200000 },
      { id: 'magpie/compact-32k', name: 'Compact 32K', context: 32000 },
    ],
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        gatewayPayloads.push(payload);
        round += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round === 1) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_get_mcp',
                        function: {
                          name: 'GetMcpTools',
                          arguments: JSON.stringify({ server: 'playwright', toolName: 'browser_navigate' }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`
          );
          res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
        } else if (round === 2) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_exec_mcp',
                        function: {
                          name: 'CallMcpTool',
                          arguments: JSON.stringify({
                            server: 'playwright',
                            toolName: 'browser_navigate',
                            arguments: { url: 'https://example.com' },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`
          );
          res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"PROGRESSIVE_MCP_OK"}}]}\n\n');
          res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const largeMcpTools = Array.from({ length: 24 }, (_, idx) => ({
    name: idx === 0 ? 'playwright-browser_navigate' : `rea-tool_${idx}`,
    providerIdentifier: idx === 0 ? 'Playwright' : 'REA',
    toolName: idx === 0 ? 'browser_navigate' : `tool_${idx}`,
    description: `Detailed tool description ${idx} ` + 'schema detail '.repeat(25),
    inputSchemaJson: JSON.stringify({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to open' },
        mode: { type: 'string', enum: ['fast', 'full'] },
      },
      required: idx === 0 ? ['url'] : [],
    }),
  }));

  const rootAgents = '# Root AGENTS\nAlways run tests before finishing.';
  const oldTurnUserBlobId = Buffer.from('old-u-1');
  const oldTurnStepBlobId = Buffer.from('old-s-1');
  const oldTurnBlobId = Buffer.from('old-t-1');
  const currentTextBlobId = Buffer.from('cur-u-text');

  const oldTurnData = encodeCursor('ConversationTurnStructure', {
    agentConversationTurn: {
      userMessage: oldTurnUserBlobId,
      steps: [oldTurnStepBlobId],
      requestId: 'old-req',
    },
  });
  const hugeOldUserData = encodeCursor('UserMessage', {
    text: 'OLD_DROPPABLE_HISTORY ' + 'x'.repeat(60_000),
    messageId: 'old-m-1',
    mode: 1,
  });
  const hugeOldStepData = encodeCursor('ConversationStep', {
    assistantMessage: { text: 'OLD_ASSISTANT ' + 'y'.repeat(60_000) },
  });

  const requestId = 'req-progressive-full';
  let seqno = 0;
  const runDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: async msg => {
      if (msg.interactionUpdate?.toolCallCompleted?.toolCall) {
        observedCards.push(msg.interactionUpdate.toolCallCompleted.toolCall);
      } else if (msg.execServerMessage?.mcpArgs) {
        const m = msg.execServerMessage.mcpArgs;
        executedMcpArgs.push({
          name: m.name,
          serverIdentifier: m.serverIdentifier,
          providerIdentifier: m.providerIdentifier,
          toolName: m.toolName,
        });
        await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
          execClientMessage: {
            id: msg.execServerMessage.id,
            execId: msg.execServerMessage.execId,
            mcpResult: {
              success: {
                content: [{ text: { text: 'NAVIGATED_EXAMPLE_COM' } }],
                isError: false,
              },
            },
          },
        });
      }
    },
  });

  await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
    runRequest: {
      conversationId: 'conv-progressive',
      runId: requestId,
      requestedModel: { modelId: 'magpie/compact-32k' },
      preFetchedBlobs: [
        { id: oldTurnBlobId, value: oldTurnData },
        { id: oldTurnUserBlobId, value: hugeOldUserData },
        { id: oldTurnStepBlobId, value: hugeOldStepData },
        { id: currentTextBlobId, value: Buffer.from('Navigate to example.com', 'utf8') },
      ],
      conversationState: { turns: [oldTurnBlobId] },
      mcpTools: { mcpTools: largeMcpTools },
      skillOptions: {
        skillDescriptors: [
          {
            name: 'option-skill',
            description: 'From SkillOptions descriptor',
            folderPath: '/Users/demo/.agents/skills/opt',
            enabled: true,
            readmeFilePath: '/Users/demo/.agents/skills/opt/SKILL.md',
          },
        ],
      },
      action: {
        userMessageAction: {
          userMessage: {
            text: '',
            textBlobId: currentTextBlobId,
            messageId: 'm-cur',
            mode: 1,
            selectedContext: {
              cursorRules: [{ rule: { fullPath: '/tmp/ws/.cursor/rules/manual.mdc', content: 'ATTACHED_MANUAL_RULE' } }],
              files: [{ path: '/tmp/ws/big.txt', content: 'BIG_FILE_CONTENT '.repeat(2500) }],
            },
          },
          requestContext: {
            env: { workspacePaths: ['/tmp/ws'] },
            cloudRule: rootAgents,
            rules: [
              { fullPath: '/tmp/ws/AGENTS.md', content: rootAgents, type: { global: {} } },
              {
                fullPath: '/tmp/ws/packages/sub/AGENTS.md',
                content: 'SUBDIR_RULE_BODY_SHOULD_NOT_BE_INLINED '.repeat(400),
                type: { global: {} },
              },
              {
                fullPath: '/Users/demo/.claude/plugins/marketplaces/huge/help.json',
                content: 'PLUGIN_NOISE_SHOULD_NOT_BE_INLINED '.repeat(500),
              },
              {
                fullPath: '/Users/demo/.codex/skills/hidden/SKILL.md',
                content: '---\ndisable-model-invocation: true\ndescription: Hidden skill\n---\nHIDDEN_SKILL_BODY',
              },
            ],
          },
        },
      },
    },
  });

  assert.deepEqual(await runDone, {});
  assert.equal(gatewayPayloads.length, 3);

  // Round 1 must expose only 9 builtins + GetMcpTools + CallMcpTool (11 tools total, no 24 raw MCP schemas)
  const round1Tools = gatewayPayloads[0].tools.map(t => t.function.name);
  assert.equal(round1Tools.length, 11);
  assert.ok(round1Tools.includes('GetMcpTools'));
  assert.ok(round1Tools.includes('CallMcpTool'));
  assert.equal(round1Tools.includes('playwright-browser_navigate'), false);

  // System prompt stays progressive & deduplicated
  const sys = gatewayPayloads[0].messages[0].content;
  assert.ok(sys.includes('<dynamic_tools>'));
  assert.ok(sys.includes('server="playwright"'));
  assert.ok(sys.includes('/tmp/ws/packages/sub/AGENTS.md'));
  assert.ok(sys.includes('/Users/demo/.agents/skills/opt/SKILL.md: From SkillOptions descriptor'));
  assert.equal(sys.includes('SUBDIR_RULE_BODY_SHOULD_NOT_BE_INLINED'), false);
  assert.equal(sys.includes('PLUGIN_NOISE_SHOULD_NOT_BE_INLINED'), false);
  assert.equal(sys.includes('HIDDEN_SKILL_BODY'), false);
  assert.equal(sys.includes('/Users/demo/.codex/skills/hidden/SKILL.md'), false);
  // Cloud rule duplicating root AGENTS.md is deduplicated
  assert.equal(sys.split('Always run tests before finishing.').length - 1, 1);

  // Old huge turn dropped by budget, current hydrated textBlobId + attached manual rule + bounded file kept
  const serializedR1 = JSON.stringify(gatewayPayloads[0].messages);
  assert.equal(serializedR1.includes('OLD_DROPPABLE_HISTORY'), false);
  assert.ok(serializedR1.includes('Navigate to example.com'));
  assert.ok(serializedR1.includes('ATTACHED_MANUAL_RULE'));
  assert.ok(serializedR1.length < 40_000, `expected compacted payload under 40k chars, got ${serializedR1.length}`);

  // Round 2 receives schema discovered by GetMcpTools
  const round2ToolsMsg = gatewayPayloads[1].messages.find(m => m.role === 'tool');
  assert.ok(round2ToolsMsg.content.includes('Target URL to open'));

  // CallMcpTool dispatches real ExecServerMessage.mcpArgs with serverIdentifier & providerIdentifier
  assert.deepEqual(executedMcpArgs, [
    {
      name: 'playwright-browser_navigate',
      serverIdentifier: 'playwright',
      providerIdentifier: 'Playwright',
      toolName: 'browser_navigate',
    },
  ]);
  assert.ok(observedCards[0].getMcpToolsToolCall);
  assert.equal(observedCards[1].mcpToolCall.args.serverIdentifier, 'playwright');
});

test('ResumeAction context and gitRepos nested-rule filtering stay compact and CallMcpTool resolves server-prefixed names', async testCtx => {
  const gatewayPayloads = [];
  const executedMcpArgs = [];
  let round = 0;

  const { ca, mockGateway, proxy } = await startRunSseProxy({
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        gatewayPayloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        round += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (round === 1) {
          res.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_prefixed_mcp',
                        function: {
                          name: 'CallMcpTool',
                          arguments: JSON.stringify({
                            server: 'playwright',
                            toolName: 'playwright-browser_click',
                            arguments: { selector: '#go' },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            })}\n\n`
          );
          res.write('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"RESUME_OK"}}]}\n\n');
          res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        }
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const requestId = 'req-resume-action';
  let seqno = 0;
  const runDone = streamRunSse({
    proxyPort: proxy.port,
    caCertPem: ca.certPem,
    requestId,
    onFrame: async msg => {
      if (msg.execServerMessage?.mcpArgs) {
        executedMcpArgs.push(msg.execServerMessage.mcpArgs);
        await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
          execClientMessage: {
            id: msg.execServerMessage.id,
            execId: msg.execServerMessage.execId,
            mcpResult: { success: { content: [{ text: { text: 'CLICKED' } }], isError: false } },
          },
        });
      }
    },
  });

  await bidiAppend(proxy.port, ca.certPem, requestId, seqno++, {
    runRequest: {
      conversationId: 'conv-resume',
      runId: requestId,
      action: {
        resumeAction: {
          requestContext: {
            gitRepos: [{ path: '/tmp/repo-root', branchName: 'main' }],
            rules: [
              {
                fullPath: '/tmp/repo-root/services/api/AGENTS.md',
                content: 'NESTED_GIT_REPO_RULE_BODY '.repeat(300),
                type: { global: {} },
              },
            ],
            mcpMetaToolOptions: {
              enabled: true,
              mcpDescriptors: [
                {
                  serverName: 'Playwright',
                  serverIdentifier: 'playwright',
                  tools: [
                    {
                      toolName: 'browser_click',
                      description: 'Click element',
                      inputSchemaJson: JSON.stringify({ type: 'object', properties: { selector: { type: 'string' } } }),
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },
  });

  assert.deepEqual(await runDone, {});
  const sys = gatewayPayloads[0].messages[0].content;
  assert.equal(sys.includes('NESTED_GIT_REPO_RULE_BODY'), false);
  assert.ok(sys.includes('/tmp/repo-root/services/api/AGENTS.md'));
  assert.equal(executedMcpArgs[0].name, 'playwright-browser_click');
  assert.equal(executedMcpArgs[0].toolName, 'browser_click');
  assert.equal(executedMcpArgs[0].serverIdentifier, 'playwright');
});

test('multi-tier service_tiers expose enum selector and role overrides support ultrafast and explicit off', async testCtx => {
  const gatewayRequests = [];
  const { ca, mockGateway, proxy, engine } = await startRunSseProxy({
    models: [
      {
        id: 'yuren/gpt-6.2-sol',
        name: 'GPT-6.2 Sol',
        context: 922000,
        efforts: ['low', 'high', 'ultra'],
        fast: true,
        serviceTiers: [
          { id: 'priority', name: 'Fast' },
          { id: 'ultrafast', name: 'Ultrafast' },
        ],
      },
      {
        id: 'cursor/grok-4.7@500k',
        name: 'Grok 500K',
        context: 500000,
        efforts: ['low', 'high'],
        fast: true,
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
      },
    ],
    roles: {
      autoRouter: 'yuren/gpt-6.2-sol[reasoning=low,service_tier=priority]',
      subagent: 'yuren/gpt-6.2-sol[reasoning=high,service_tier=ultrafast]',
      subagentTypes: {
        explore: 'cursor/grok-4.7@500k[service_tier=off]',
      },
      commit: 'yuren/gpt-6.2-sol[service_tier=ultrafast]',
    },
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        gatewayRequests.push({
          model: payload.model,
          effort: payload.reasoning_effort ?? null,
          serviceTier: payload.service_tier ?? null,
          stream: Boolean(payload.stream),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"TIER_OK"}}]}\n\n');
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const avail = decodeCursor('AvailableModelsAddition', engine.buildAvailableModelsResponse());
  const sol = avail.models.find(m => m.name === 'yuren/gpt-6.2-sol');
  const tierParam = sol.parameterDefinitions.find(p => p.id === 'service_tier');
  assert.ok(tierParam?.parameterType?.enumParameter);
  assert.deepEqual(
    tierParam.parameterType.enumParameter.values.map(v => v.value),
    ['default', 'priority', 'ultrafast']
  );
  assert.equal(sol.parameterDefinitions.some(p => p.id === 'fast'), false);

  const grok = avail.models.find(m => m.name === 'cursor/grok-4.7@500k');
  assert.ok(grok.parameterDefinitions.find(p => p.id === 'fast')?.parameterType?.booleanParameter);

  const run = async (requestId, runFields) => {
    const done = streamRunSse({
      proxyPort: proxy.port,
      caCertPem: ca.certPem,
      requestId,
      onFrame: async () => {},
    });
    await bidiAppend(proxy.port, ca.certPem, requestId, 0, {
      runRequest: {
        conversationId: `conv-${requestId}`,
        runId: requestId,
        ...runFields,
        action: {
          userMessageAction: {
            userMessage: { text: 'Test tier routing', messageId: `m-${requestId}`, mode: 1 },
          },
        },
      },
    });
    assert.deepEqual(await done, {});
  };

  await run('req-ultra', {
    requestedModel: {
      modelId: 'yuren/gpt-6.2-sol',
      parameters: [{ id: 'service_tier', value: 'ultrafast' }],
    },
  });
  await run('req-sub-ultra', {
    requestedModel: { modelId: 'cursor/grok-4.7@500k' },
    subagentTypeName: 'generalPurpose',
  });
  await run('req-explore-off', {
    requestedModel: {
      modelId: 'cursor/grok-4.7@500k',
      parameters: [{ id: 'fast', value: 'true' }],
    },
    subagentTypeName: 'explore',
  });

  const commitResp = await engine.handleCommitMessage(
    encodeCursor('WriteGitCommitMessageRequest', { diffs: ['+ fast tier support'] })
  );
  assert.equal(decodeCursor('WriteGitCommitMessageResponse', commitResp).commitMessage, 'TIER_OK');

  assert.deepEqual(gatewayRequests, [
    { model: 'yuren/gpt-6.2-sol', effort: null, serviceTier: 'ultrafast', stream: true },
    { model: 'yuren/gpt-6.2-sol', effort: 'high', serviceTier: 'ultrafast', stream: true },
    { model: 'cursor/grok-4.7@500k', effort: null, serviceTier: null, stream: true },
    { model: 'yuren/gpt-6.2-sol', effort: null, serviceTier: 'ultrafast', stream: true },
  ]);
});

test('ClassifyAgentAutoReview routes to autoReview role model and parses allow, block, and error fallback', async testCtx => {
  const gatewayRequests = [];
  let nextDecisionJson = JSON.stringify({
    decision: 'allow',
    action_description: 'Check repository status',
  });
  const { ca, proxy, mockGateway } = await startRunSseProxy({
    model: 'magpie/main',
    models: [
      { id: 'magpie/main', name: 'Main', context: 200000 },
      {
        id: 'magpie/reviewer',
        name: 'Reviewer',
        context: 128000,
        efforts: ['low', 'medium'],
        serviceTiers: [{ id: 'priority', name: 'Fast' }],
      },
    ],
    roles: {
      autoReview: 'magpie/reviewer[reasoning=low,service_tier=priority]',
    },
    onGatewayRequest: (req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        gatewayRequests.push({
          model: payload.model,
          effort: payload.reasoning_effort || null,
          serviceTier: payload.service_tier || null,
          userPrompt: payload.messages.find(m => m.role === 'user')?.content || '',
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: nextDecisionJson } }] })}\n\n`);
        res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
        res.end('data: [DONE]\n\n');
      });
    },
  });
  testCtx.after(() => proxy.close());
  testCtx.after(() => mockGateway.close());

  const postAutoReview = async reqObj => {
    const tlsSock = await openConnectTls(proxy.port, ca.certPem);
    try {
      const body = encodeCursor('ClassifyAgentAutoReviewRequest', reqObj);
      const raw = [
        'POST /aiserver.v1.AiService/ClassifyAgentAutoReview HTTP/1.1',
        'Host: api2.cursor.sh',
        'Content-Type: application/proto',
        `Content-Length: ${body.length}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      tlsSock.write(Buffer.concat([Buffer.from(raw, 'latin1'), body]));
      const chunks = [];
      await new Promise((resolve, reject) => {
        tlsSock.on('data', d => chunks.push(d));
        tlsSock.on('end', resolve);
        tlsSock.on('error', reject);
      });
      const buf = Buffer.concat(chunks);
      const sep = buf.indexOf(Buffer.from('\r\n\r\n'));
      return decodeCursor('ClassifyAgentAutoReviewResponse', buf.subarray(sep + 4));
    } finally {
      tlsSock.destroy();
    }
  };

  const allowResp = await postAutoReview({
    args: {
      toolCallId: 'tc-allow',
      target: {
        action: 'shell',
        arguments: { fields: { command: { stringValue: 'git status' } } },
      },
      conversationContext: [{ role: 'user', content: 'inspect git status' }],
    },
    attemptIndex: 0,
    mode: 'enforce',
    workspacePaths: ['/repo'],
  });
  assert.equal(allowResp.result.success.decision, 1);
  assert.equal(allowResp.result.success.actionDescription, 'Check repository status');
  assert.equal(gatewayRequests[0].model, 'magpie/reviewer');
  assert.equal(gatewayRequests[0].effort, 'low');
  assert.equal(gatewayRequests[0].serviceTier, 'priority');
  assert.match(gatewayRequests[0].userPrompt, /git status/);

  nextDecisionJson = JSON.stringify({
    decision: 'block',
    block_reason: 'Destructive recursive deletion outside temp directory',
    block_reason_category: 'destructive_shell',
    irreversible: true,
    high_stakes: true,
    proposed_allow_rule: 'rm -rf ./dist',
  });
  const blockResp = await postAutoReview({
    args: {
      toolCallId: 'tc-block',
      target: {
        action: 'shell',
        arguments: { fields: { command: { stringValue: 'rm -rf /' } } },
      },
    },
    mode: 'enforce',
    workspacePaths: ['/repo'],
  });
  assert.equal(blockResp.result.success.decision, 2);
  assert.equal(blockResp.result.success.blockReason, 'Destructive recursive deletion outside temp directory');
  assert.equal(blockResp.result.success.blockReasonCategory, 'destructive_shell');
  assert.equal(blockResp.result.success.irreversible, true);
  assert.equal(blockResp.result.success.highStakes, true);
  assert.equal(blockResp.result.success.proposedAllowRule, 'rm -rf ./dist');

  nextDecisionJson = 'not json at all';
  const badResp = await postAutoReview({
    args: { toolCallId: 'tc-bad', target: { action: 'shell' } },
    mode: 'enforce',
  });
  assert.equal(badResp.result.success, undefined);
  assert.match(badResp.result.error.error, /non-JSON/i);
});
