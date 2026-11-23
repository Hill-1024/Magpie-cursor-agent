import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CursorBridgeEngine } from '../lib/cursor-engine.js';
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

async function bidiAppend(proxyPort, caCertPem, requestId, seqno, clientMessage) {
  const bytes = encodeCursor('AgentClientMessage', clientMessage);
  const body = encodeCursor('BidiAppendRequest', {
    data: bytes.toString('hex'),
    requestId: { requestId },
    appendSeqno: seqno,
  });
  const tlsSock = await openConnectTls(proxyPort, caCertPem);
  return new Promise((resolve, reject) => {
    const header =
      `POST /aiserver.v1.BidiService/BidiAppend HTTP/1.1\r\n` +
      `Host: api2.cursor.sh\r\n` +
      `Content-Type: application/proto\r\n` +
      `Content-Length: ${body.length}\r\n` +
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

async function startRunSseProxy({ onGatewayRequest }) {
  const ca = generateLocalCa();
  const mockGateway = http.createServer(onGatewayRequest);
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'test-key',
    model: 'group/auto',
    models: [{ id: 'group/auto', name: 'Auto', context: 200000 }],
  });
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  return { ca, mockGateway, proxy };
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
