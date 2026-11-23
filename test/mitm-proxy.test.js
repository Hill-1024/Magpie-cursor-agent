import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { CursorBridgeEngine } from '../lib/cursor-engine.js';
import {
  CONNECT_END_STREAM_FLAG,
  decodeConnectFrames,
  decodeCursor,
  encodeConnectFrame,
  encodeCursor,
} from '../lib/cursor-schemas.js';
import { isCursorHost, startMitmProxy } from '../lib/mitm-proxy.js';
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

async function h1PostOverProxy(
  proxyPort,
  caCertPem,
  pathName,
  bodyBuf,
  contentType = 'application/proto',
  extraHeaders = {}
) {
  const tunnel = await openConnectTunnel(proxyPort, 'api2.cursor.sh:443');
  return new Promise((resolve, reject) => {
    const tlsSock = tls.connect(
      { socket: tunnel, servername: 'api2.cursor.sh', ca: caCertPem, ALPNProtocols: ['http/1.1'] },
      () => {
        const headerLines = Object.entries(extraHeaders)
          .map(([headerName, headerVal]) => `${headerName}: ${headerVal}\r\n`)
          .join('');
        const reqHeader =
          `POST ${pathName} HTTP/1.1\r\n` +
          `Host: api2.cursor.sh\r\n` +
          `Content-Type: ${contentType}\r\n` +
          `Content-Length: ${bodyBuf.length}\r\n` +
          headerLines +
          `Connection: close\r\n\r\n`;
        tlsSock.write(Buffer.concat([Buffer.from(reqHeader), bodyBuf]));
      }
    );
    const chunks = [];
    tlsSock.on('data', chunk => chunks.push(chunk));
    tlsSock.on('end', () => {
      const full = Buffer.concat(chunks);
      const sep = full.indexOf('\r\n\r\n');
      const head = full.subarray(0, sep).toString('latin1');
      const body = full.subarray(sep + 4);
      const status = Number(head.split('\r\n')[0].split(' ')[1]);
      resolve({ status, head, body });
    });
    tlsSock.on('error', reject);
  });
}

async function h1StreamOverProxy(proxyPort, caCertPem, pathName, bodyBuf) {
  const tunnel = await openConnectTunnel(proxyPort, 'api2.cursor.sh:443');
  const tlsSock = tls.connect({
    socket: tunnel,
    servername: 'api2.cursor.sh',
    ca: caCertPem,
    ALPNProtocols: ['http/1.1'],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: 'api2.cursor.sh',
        method: 'POST',
        path: pathName,
        headers: {
          'Content-Type': 'application/connect+proto',
          'Content-Length': bodyBuf.length,
        },
        createConnection: () => tlsSock,
      },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(bodyBuf);
  });
}

test('isCursorHost restricts MITM strictly to Cursor domains', () => {
  assert.equal(isCursorHost('api2.cursor.sh'), true);
  assert.equal(isCursorHost('api3.cursor.sh.'), true);
  assert.equal(isCursorHost('sub.cursor.sh'), true);
  assert.equal(isCursorHost('cursor.sh.evil.example'), false);
  assert.equal(isCursorHost('api.openai.com'), false);
});

test('MITM proxy handles Cursor HTTP/1.1 & HTTP/2 locally while tunneling non-Cursor TCP untouched', async testCtx => {
  const ca = generateLocalCa();
  const mockGateway = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"feat: clean shadow bridge"}}]}\n\n');
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const rawTarget = net.createServer(sock => {
    sock.once('data', chunk => sock.end(`RAW_PASSTHROUGH:${chunk.toString('utf8')}`));
  });
  await new Promise(resolve => rawTarget.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => rawTarget.close());

  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'secret-gateway-key',
    model: 'deepseek/deepseek-chat',
    models: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', context: 128000 },
      { id: 'group/auto', name: 'Auto Route', context: 256000 },
    ],
  });

  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  testCtx.after(() => proxy.close());

  // 1. Non-Cursor CONNECT passes raw TCP through without MITM
  const rawTunnel = await openConnectTunnel(proxy.port, `127.0.0.1:${rawTarget.address().port}`);
  const rawEcho = await new Promise((resolve, reject) => {
    let out = '';
    rawTunnel.on('data', d => {
      out += d.toString('utf8');
    });
    rawTunnel.on('end', () => resolve(out));
    rawTunnel.on('error', reject);
    rawTunnel.write('hello-tcp');
  });
  assert.equal(rawEcho, 'RAW_PASSTHROUGH:hello-tcp');

  // 2. AvailableModels returns local catalogue with native Auto enabled and no upstream polling
  const availResp = await h1PostOverProxy(proxy.port, ca.certPem, '/aiserver.v1.AiService/AvailableModels', Buffer.alloc(0));
  assert.equal(availResp.status, 200);
  const decodedAvail = decodeCursor('AvailableModelsAddition', availResp.body);
  assert.deepEqual(decodedAvail.modelNames, ['deepseek/deepseek-chat', 'group/auto']);
  assert.notEqual(decodedAvail.displayConfiguration.routedModelViewConfig.hideRoutedModelView, true);
  assert.equal(
    decodedAvail.displayConfiguration.routedModelViewConfig.routedModelViewToNamedViewToggle.titleMarkdown,
    'Auto'
  );
  assert.equal(
    decodedAvail.displayConfiguration.namedModelsViewConfig.namedViewToRoutedModelViewToggle.markdown,
    'Auto'
  );

  // 3. GetUsableModels uses synthetic local credentials and never exposes Magpie's real gateway key
  const usableResp = await h1PostOverProxy(proxy.port, ca.certPem, '/agent.v1.AgentService/GetUsableModels', Buffer.alloc(0));
  const decodedUsable = decodeCursor('UsableModelsAddition', usableResp.body);
  assert.equal(decodedUsable.models[0].apiKeyCredentials.apiKey, 'cursor-magpie-local');
  assert.notEqual(decodedUsable.models[0].apiKeyCredentials.apiKey, 'secret-gateway-key');
  assert.ok(decodedUsable.models.some(entry => entry.modelId === 'default' && entry.displayModelId === 'auto'));

  // 4. WriteGitCommitMessage routes through local Magpie gateway
  const commitReq = encodeCursor('WriteGitCommitMessageRequest', { diffs: ['+ console.log("hi");'] });
  const commitResp = await h1PostOverProxy(proxy.port, ca.certPem, '/aiserver.v1.AiService/WriteGitCommitMessage', commitReq);
  assert.equal(decodeCursor('WriteGitCommitMessageResponse', commitResp.body).commitMessage, 'feat: clean shadow bridge');

  // 4b. Gzip-compressed Connect request bodies are decompressed transparently
  const gzCommitReq = zlib.gzipSync(commitReq);
  const gzCommitResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/WriteGitCommitMessage',
    gzCommitReq,
    'application/proto',
    { 'Content-Encoding': 'gzip' }
  );
  assert.equal(gzCommitResp.status, 200);
  assert.equal(
    decodeCursor('WriteGitCommitMessageResponse', gzCommitResp.body).commitMessage,
    'feat: clean shadow bridge'
  );

  // 5. HTTP/2 over CONNECT works cleanly as well
  const h2Tunnel = await openConnectTunnel(proxy.port, 'api2.cursor.sh:443');
  const h2Body = await new Promise((resolve, reject) => {
    const client = http2.connect('https://api2.cursor.sh', {
      createConnection: () =>
        tls.connect({ socket: h2Tunnel, servername: 'api2.cursor.sh', ca: ca.certPem, ALPNProtocols: ['h2'] }),
    });
    client.on('error', reject);
    const req = client.request({ ':method': 'POST', ':path': '/aiserver.v1.AiService/GetServerConfig' });
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      client.close();
      resolve(Buffer.concat(chunks));
    });
    req.end();
  });
  const serverCfg = decodeCursor('ServerConfigResponse', h2Body);
  assert.equal(serverCfg.http2Config, 1);
});

test('MITM proxy blocks analytics, telemetry, Statsig, and local-token auth locally', async testCtx => {
  const ca = generateLocalCa();
  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: 'http://127.0.0.1:49999/v1',
    key: 'secret-gateway-key',
    model: 'group/auto',
    models: [{ id: 'group/auto', name: 'Auto', context: 200000 }],
  });

  // Even with allowAuthPassthrough=true, telemetry/Statsig/plugins and synthetic local auth stay strictly local
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: true,
  });
  testCtx.after(() => proxy.close());

  const statsigResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AnalyticsService/BootstrapStatsig',
    Buffer.alloc(0)
  );
  assert.equal(statsigResp.status, 200);
  const statsigDecoded = decodeCursor('BootstrapStatsigResponse', statsigResp.body);
  const statsigJson = JSON.parse(statsigDecoded.config);
  assert.equal(statsigJson.user.userID, 'local_bridge');
  assert.equal(statsigJson.sdkParams.disableDiagnosticsLogging, true);

  for (const blockedPath of [
    '/aiserver.v1.AnalyticsService/TrackEvents',
    '/aiserver.v1.TelemetryService/RecordEvent',
    '/aiserver.v1.DashboardService/GetEffectiveUserPlugins',
    '/aiserver.v1.DashboardService/GetUserPrivacyMode',
    '/aiserver.v1.NetworkService/IsConnected',
  ]) {
    const resp = await h1PostOverProxy(proxy.port, ca.certPem, blockedPath, Buffer.from([1, 2, 3]));
    assert.equal(resp.status, 200);
    assert.equal(resp.body.length, 0);
  }

  const localAuthResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AuthService/Refresh',
    Buffer.alloc(0),
    'application/proto',
    { Authorization: 'Bearer cursor-magpie-local' }
  );
  assert.equal(localAuthResp.status, 200);
  assert.equal(localAuthResp.body.length, 0);

  const exchangeResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/auth/exchange_user_api_key',
    Buffer.from('{}'),
    'application/json',
    { Authorization: 'Bearer cursor-magpie-local' }
  );
  assert.equal(exchangeResp.status, 200);
  const exchangeJson = JSON.parse(exchangeResp.body.toString('utf8'));
  assert.equal(typeof exchangeJson.accessToken, 'string');
  assert.equal(typeof exchangeJson.refreshToken, 'string');
  const jwtClaims = JSON.parse(Buffer.from(exchangeJson.accessToken.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(jwtClaims.sub, 'local|magpie_bridge');

  const jsonTelemetryResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AnalyticsService/SubmitLogs',
    Buffer.from('{}'),
    'application/json'
  );
  assert.equal(jsonTelemetryResp.status, 200);
  assert.deepEqual(JSON.parse(jsonTelemetryResp.body.toString('utf8')), {});
});

test('role-specific unary and streaming auxiliary RPCs route to configured role models', async testCtx => {
  const ca = generateLocalCa();
  const seenCalls = [];

  const mockGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenCalls.push({ model: payload.model, effort: payload.reasoning_effort || null });
      const systemContent = String(payload.messages?.[0]?.content || '');
      let replyText = 'ok';
      if (systemContent.includes('Extract one durable')) {
        replyText = JSON.stringify({ save: true, title: 'Prefers concise PRs', memory: 'Keep diffs small' });
      } else if (systemContent.includes('Review the diff')) {
        replyText = JSON.stringify({
          summary: '1 issue',
          bugs: [{ file: 'app.js', startLine: 3, endLine: 4, title: 'Leak', description: 'Unclosed handle', severity: 'high' }],
        });
      } else if (systemContent.includes('git branch name')) {
        replyText = 'fix/role-routing';
      } else if (systemContent.includes('git commit')) {
        replyText = 'feat: add role routing';
      } else if (systemContent.includes('concise 3-6 word')) {
        replyText = 'Role Routing Setup';
      } else {
        replyText = 'Summary complete';
      }
      assert.equal(payload.stream, true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: replyText } }] })}\n\n`);
      res.write('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => mockGateway.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => mockGateway.close());

  const engine = new CursorBridgeEngine({
    enabled: true,
    gateway: `http://127.0.0.1:${mockGateway.address().port}/v1`,
    key: 'secret-gateway-key',
    model: 'main/default',
    models: [{ id: 'main/default', name: 'Main', context: 128000 }],
    roles: {
      title: 'role/title-fast',
      summarize: 'role/summary-mid',
      memory: 'role/memory-llm',
      bugbot: 'role/bugbot-strong[reasoning=high]',
      commit: 'role/commit-fast',
    },
  });
  const proxy = await startMitmProxy({
    engine,
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    allowAuthPassthrough: false,
  });
  testCtx.after(() => proxy.close());

  const nameResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/agent.v1.AgentService/NameAgent',
    encodeCursor('NameAgentRequest', { userMessage: 'Configure role routing' })
  );
  assert.equal(decodeCursor('NameAgentResponse', nameResp.body).name, 'Role Routing Setup');

  const chatTitleResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/GetChatTitle',
    encodeCursor('GetChatTitleRequest', { conversation: [{ text: 'Add bugbot routing', type: 1 }] })
  );
  assert.equal(decodeCursor('GetChatTitleResponse', chatTitleResp.body).title, 'Role Routing Setup');

  const branchResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/WriteGitBranchName',
    encodeCursor('WriteGitBranchNameRequest', { diffs: '+ role router' })
  );
  assert.equal(decodeCursor('WriteGitBranchNameResponse', branchResp.body).branchName, 'fix/role-routing');

  const overviewResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/agent.v1.AgentService/CreateTranscriptOverview',
    encodeCursor('CreateTranscriptOverviewRequest', { formattedConversation: 'User: hi\nAssistant: done' })
  );
  assert.equal(decodeCursor('CreateTranscriptOverviewResponse', overviewResp.body).overview, 'Summary complete');

  const summaryResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.ChatService/GetConversationSummary',
    encodeCursor('StreamUnifiedChatRequestLite', { conversation: [{ text: 'hello', type: 1 }] })
  );
  assert.equal(decodeCursor('ConversationSummary', summaryResp.body).summary, 'Summary complete');

  const memoryResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/PotentiallyGenerateMemory',
    encodeCursor('PotentiallyGenerateMemoryRequest', {
      requestId: 'mem-1',
      conversation: [{ text: 'Always keep diffs small', type: 1 }],
      composerId: 'comp-1',
    })
  );
  const memoryDecoded = decodeCursor('PotentiallyGenerateMemoryResponse', memoryResp.body);
  assert.equal(memoryDecoded.savedMemory, 'Keep diffs small');
  assert.equal(memoryDecoded.title, 'Prefers concise PRs');

  const commitResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/WriteGitCommitMessage',
    encodeCursor('WriteGitCommitMessageRequest', { diffs: ['+ feat'] })
  );
  assert.equal(decodeCursor('WriteGitCommitMessageResponse', commitResp.body).commitMessage, 'feat: add role routing');

  const linterResp = await h1PostOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.ReviewService/StreamBugBotLinter',
    encodeCursor('StreamBugBotLinterRequest', {
      gitDiff: { diffs: [{ from: 'app.js', to: 'app.js', chunks: [{ content: '+ handle()', lines: [] }] }] },
      activeFile: 'app.js',
      cursorLineNumberOneIndexed: 3,
    })
  );
  const linterDecoded = decodeCursor('StreamBugBotLinterResponse', linterResp.body);
  assert.equal(linterDecoded.bugs[0].title, 'Leak');

  const streamBugResp = await h1StreamOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/StreamBugBot',
    encodeConnectFrame(encodeCursor('StreamBugBotRequest', {
      gitDiff: { diffs: [{ from: 'app.js', to: 'app.js', chunks: [{ content: '+ handle()', lines: [] }] }] },
    }))
  );
  assert.equal(streamBugResp.status, 200);
  const bugFrames = decodeConnectFrames(streamBugResp.body).frames;
  const reportFrame = bugFrames.find(frame => !(frame.flags & CONNECT_END_STREAM_FLAG) && decodeCursor('StreamBugBotResponse', frame.payload).bugReports);
  assert.ok(reportFrame);
  assert.equal(decodeCursor('StreamBugBotResponse', reportFrame.payload).bugReports.bugReports[0].title, 'Leak');

  const diffReviewResp = await h1StreamOverProxy(
    proxy.port,
    ca.certPem,
    '/aiserver.v1.AiService/StreamDiffReview',
    encodeConnectFrame(encodeCursor('GetDiffReviewRequest', {
      diffs: [{ relativeWorkspacePath: 'app.js', chunks: [{ oldLines: ['old'], newLines: ['new'] }] }],
    }))
  );
  assert.equal(diffReviewResp.status, 200);
  const reviewFrames = decodeConnectFrames(diffReviewResp.body).frames;
  const reviewPayload = decodeCursor('StreamDiffReviewResponse', reviewFrames[0].payload);
  assert.equal(reviewPayload.text, 'Summary complete');

  assert.deepEqual(seenCalls, [
    { model: 'role/title-fast', effort: null },
    { model: 'role/title-fast', effort: null },
    { model: 'role/title-fast', effort: null },
    { model: 'role/summary-mid', effort: null },
    { model: 'role/summary-mid', effort: null },
    { model: 'role/memory-llm', effort: null },
    { model: 'role/commit-fast', effort: null },
    { model: 'role/bugbot-strong', effort: 'high' },
    { model: 'role/bugbot-strong', effort: 'high' },
    { model: 'role/bugbot-strong', effort: 'high' },
  ]);
});
