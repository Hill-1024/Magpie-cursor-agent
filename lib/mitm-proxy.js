import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { decodeUnaryPayload, encodeConnectFrame } from './cursor-schemas.js';
import { issueLeafCertificate } from './x509.js';

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const PASSTHROUGH_AUTH_PREFIXES = [
  '/auth/',
  '/aiserver.v1.AuthService/',
];

/** Return `true` only for official Cursor API hostnames eligible for local protocol bridging. */
export function isCursorHost(host) {
  const normalized = String(host || '')
    .trim()
    .replace(/\.+$/, '')
    .toLowerCase();
  if (!normalized) return false;
  return (
    normalized === 'api2.cursor.sh' ||
    normalized === 'api3.cursor.sh' ||
    normalized.endsWith('.cursor.sh')
  );
}

function parseConnectAuthority(authority) {
  const text = String(authority || '').trim();
  if (text.startsWith('[')) {
    const closing = text.indexOf(']');
    if (closing === -1) return null;
    const host = text.slice(1, closing);
    const portStr = text.slice(closing + 2);
    const port = Number(portStr || 443);
    return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const lastColon = text.lastIndexOf(':');
  if (lastColon === -1) {
    return text ? { host: text, port: 443 } : null;
  }
  const host = text.slice(0, lastColon);
  const port = Number(text.slice(lastColon + 1));
  return host && Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

function decompressBody(buffer, contentEncoding, maxBytes) {
  const encodings = String(contentEncoding || '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  if (encodings.length === 0 || buffer.length === 0) {
    return buffer;
  }
  let current = buffer;
  for (let i = encodings.length - 1; i >= 0; i -= 1) {
    const encoding = encodings[i];
    if (encoding === 'identity') continue;
    if (encoding === 'gzip' || encoding === 'x-gzip') {
      current = zlib.gunzipSync(current, { maxOutputLength: maxBytes });
    } else if (encoding === 'deflate') {
      current = zlib.inflateSync(current, { maxOutputLength: maxBytes });
    } else if (encoding === 'br') {
      current = zlib.brotliDecompressSync(current, { maxOutputLength: maxBytes });
    } else {
      const err = new Error(`Unsupported Content-Encoding: ${encoding}`);
      err.statusCode = 415;
      throw err;
    }
  }
  return current;
}

function readRequestBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error('Request body exceeds limit');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(decompressBody(Buffer.concat(chunks), req.headers['content-encoding'], maxBytes));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendProto(req, res, rawBody, payloadBytes) {
  const reqContentType = String(req.headers['content-type'] || '');
  let isFramed = reqContentType.includes('application/connect+');
  if (!isFramed && rawBody && rawBody.length >= 5) {
    try {
      isFramed = decodeUnaryPayload(rawBody).framed;
    } catch {
      isFramed = false;
    }
  }
  const body = isFramed ? encodeConnectFrame(payloadBytes) : Buffer.from(payloadBytes);
  const contentType = isFramed ? 'application/connect+proto' : 'application/proto';
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { code: 'internal', message });
}

function isSyntheticLocalAuth(headers) {
  const authHeader = String(headers.authorization || '');
  return authHeader.includes('cursor-magpie-local') || authHeader.includes('cursor-byok-local');
}

function buildSyntheticJwt() {
  const nowSec = Math.floor(Date.now() / 1000);
  const encodeSeg = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return [
    encodeSeg({ alg: 'HS256', typ: 'JWT' }),
    encodeSeg({ sub: 'local|magpie_bridge', exp: nowSec + 86400 }),
    'local',
  ].join('.');
}

function isAuthPassthroughAllowed(pathname, headers, allowAuthPassthrough) {
  if (!allowAuthPassthrough) return false;
  if (isSyntheticLocalAuth(headers)) {
    return false;
  }
  return PASSTHROUGH_AUTH_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

async function forwardAuthUpstream(req, res, host, pathname, rawBody) {
  const targetHost = isCursorHost(host) ? host : 'api2.cursor.sh';
  const forwardHeaders = {};
  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    const lower = headerName.toLowerCase();
    if (
      lower.startsWith(':') ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower === 'content-encoding' ||
      lower === 'content-length'
    ) {
      continue;
    }
    if (typeof headerValue === 'string') forwardHeaders[lower] = headerValue;
    else if (Array.isArray(headerValue)) forwardHeaders[lower] = headerValue.join(', ');
  }
  const upstreamResp = await fetch(`https://${targetHost}${req.url || pathname}`, {
    method: req.method,
    headers: forwardHeaders,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : rawBody,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  const respHeaders = {};
  upstreamResp.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== 'content-encoding' && lower !== 'content-length') {
      respHeaders[lower] = value;
    }
  });
  const buf = Buffer.from(await upstreamResp.arrayBuffer());
  respHeaders['content-length'] = String(buf.length);
  res.writeHead(upstreamResp.status, respHeaders);
  res.end(buf);
}

/**
 * Start the local HTTP `CONNECT` proxy + dual HTTP/1.1 & HTTP/2 TLS MITM server.
 * Only `*.cursor.sh` traffic is TLS-terminated; all other domains pass through raw TCP.
 */
export async function startMitmProxy({
  engine,
  caCertPem,
  caKeyPem,
  host = '127.0.0.1',
  port = 0,
  allowAuthPassthrough = true,
}) {
  const certCache = new Map();
  const getContextForHost = hostname => {
    const keyName = (hostname || 'api2.cursor.sh').toLowerCase();
    let context = certCache.get(keyName);
    if (!context) {
      const issued = issueLeafCertificate({
        hostname: keyName,
        caCertPem,
        caKeyPem,
      });
      context = tls.createSecureContext({ key: issued.keyPem, cert: issued.certPem });
      certCache.set(keyName, context);
    }
    return context;
  };

  const defaultLeaf = issueLeafCertificate({
    hostname: 'api2.cursor.sh',
    caCertPem,
    caKeyPem,
  });
  certCache.set(
    'api2.cursor.sh',
    tls.createSecureContext({ key: defaultLeaf.keyPem, cert: defaultLeaf.certPem })
  );

  const tlsHttpServer = http2.createSecureServer(
    {
      key: defaultLeaf.keyPem,
      cert: defaultLeaf.certPem,
      allowHTTP1: true,
      SNICallback: (servername, callback) => {
        try {
          callback(null, getContextForHost(servername));
        } catch (err) {
          callback(err);
        }
      },
    },
    async (req, res) => {
      const parsedUrl = new URL(req.url || '/', 'https://api2.cursor.sh');
      const pathname = parsedUrl.pathname;
      const requestHost = String(req.headers[':authority'] || req.headers.host || 'api2.cursor.sh').split(':')[0];

      try {
        if (pathname === '/__bridge__/healthz') {
          res.writeHead(204);
          res.end();
          return;
        }

        const rawBody = await readRequestBody(req);

        if (pathname === '/agent.v1.AgentService/RunSSE') {
          res.writeHead(200, {
            'content-type': 'application/connect+proto',
            'cache-control': 'no-cache',
            'connect-protocol-version': '1',
          });
          engine.handleRunSse(rawBody, res, req.headers);
          return;
        }

        if (pathname === '/aiserver.v1.BidiService/BidiAppend') {
          const reply = await engine.handleBidiAppend(rawBody, req.headers);
          sendProto(req, res, rawBody, reply);
          return;
        }

        if (pathname === '/aiserver.v1.AiService/AvailableModels') {
          sendProto(req, res, rawBody, engine.buildAvailableModelsResponse(false));
          return;
        }

        if (
          pathname === '/agent.v1.AgentService/GetUsableModels' ||
          pathname === '/aiserver.v1.AiService/GetUsableModels'
        ) {
          sendProto(req, res, rawBody, engine.buildUsableModelsResponse(false));
          return;
        }

        if (
          pathname === '/agent.v1.AgentService/GetDefaultModelForCli' ||
          pathname === '/aiserver.v1.AiService/GetDefaultModelForCli'
        ) {
          sendProto(req, res, rawBody, engine.buildDefaultModelForCliResponse(false));
          return;
        }

        if (pathname === '/aiserver.v1.AiService/GetDefaultModel') {
          sendProto(req, res, rawBody, engine.buildDefaultModelResponse(false));
          return;
        }

        if (pathname === '/aiserver.v1.AiService/GetDefaultModelNudgeData') {
          sendProto(req, res, rawBody, engine.buildDefaultModelNudgeResponse(false));
          return;
        }

        if (
          pathname === '/aiserver.v1.AiService/GetServerConfig' ||
          pathname === '/aiserver.v1.ServerConfigService/GetServerConfig'
        ) {
          sendProto(req, res, rawBody, engine.buildServerConfigResponse());
          return;
        }

        if (pathname === '/aiserver.v1.AiService/StreamBugBot') {
          res.writeHead(200, {
            'content-type': 'application/connect+proto',
            'cache-control': 'no-cache',
            'connect-protocol-version': '1',
          });
          await engine.handleStreamBugBot(rawBody, res);
          return;
        }

        if (pathname === '/aiserver.v1.AiService/StreamDiffReview') {
          res.writeHead(200, {
            'content-type': 'application/connect+proto',
            'cache-control': 'no-cache',
            'connect-protocol-version': '1',
          });
          await engine.handleStreamDiffReview(rawBody, res);
          return;
        }

        const unaryRoleHandler = {
          '/aiserver.v1.AiService/WriteGitCommitMessage': body => engine.handleCommitMessage(body),
          '/aiserver.v1.AiService/WriteGitBranchName': body => engine.handleWriteGitBranchName(body),
          '/agent.v1.AgentService/NameAgent': body => engine.handleNameAgent(body),
          '/aiserver.v1.AiService/NameAgent': body => engine.handleNameAgent(body),
          '/aiserver.v1.AiService/GetChatTitle': body => engine.handleGetChatTitle(body),
          '/agent.v1.AgentService/CreateTranscriptOverview': body =>
            engine.handleCreateTranscriptOverview(body),
          '/aiserver.v1.ChatService/GetConversationSummary': body =>
            engine.handleGetConversationSummary(body),
          '/aiserver.v1.AiService/PotentiallyGenerateMemory': body =>
            engine.handlePotentiallyGenerateMemory(body),
          '/aiserver.v1.ReviewService/StreamBugBotLinter': body =>
            engine.handleStreamBugBotLinter(body),
        }[pathname];
        if (unaryRoleHandler) {
          const reply = await unaryRoleHandler(rawBody);
          sendProto(req, res, rawBody, reply);
          return;
        }

        if (pathname === '/aiserver.v1.AnalyticsService/BootstrapStatsig') {
          sendProto(req, res, rawBody, engine.buildStatsigBootstrapResponse());
          return;
        }

        if (
          pathname === '/aiserver.v1.NetworkService/IsConnected' ||
          pathname === '/aiserver.v1.AiService/AvailableDocs' ||
          pathname.startsWith('/aiserver.v1.DashboardService/') ||
          pathname === '/agent.v1.AgentService/UpdateConversationMetadata' ||
          pathname.startsWith('/aiserver.v1.AnalyticsService/') ||
          pathname.startsWith('/aiserver.v1.TelemetryService/')
        ) {
          if (String(req.headers['content-type'] || '').includes('json')) {
            sendJson(res, 200, {});
          } else {
            sendProto(req, res, rawBody, Buffer.alloc(0));
          }
          return;
        }

        if (isAuthPassthroughAllowed(pathname, req.headers, allowAuthPassthrough)) {
          await forwardAuthUpstream(req, res, requestHost, pathname, rawBody);
          return;
        }

        if (pathname === '/auth/exchange_user_api_key') {
          const token = buildSyntheticJwt();
          sendJson(res, 200, { accessToken: token, refreshToken: token });
          return;
        }

        sendProto(req, res, rawBody, Buffer.alloc(0));
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, err?.statusCode || 500, err?.message || 'Bridge internal error');
        } else {
          res.end();
        }
      }
    }
  );

  await new Promise((resolve, reject) => {
    tlsHttpServer.once('error', reject);
    tlsHttpServer.listen(0, '127.0.0.1', () => {
      tlsHttpServer.removeListener('error', reject);
      resolve();
    });
  });
  const tlsPort = tlsHttpServer.address().port;
  const tlsSessions = new Set();
  tlsHttpServer.on('session', session => {
    tlsSessions.add(session);
    session.on('close', () => tlsSessions.delete(session));
  });

  const connectProxy = http.createServer((req, res) => {
    if (req.url === '/__bridge__/healthz') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Use HTTP CONNECT');
  });

  const activeSockets = new Set();
  connectProxy.on('connect', (req, clientSocket, head) => {
    activeSockets.add(clientSocket);
    clientSocket.on('close', () => activeSockets.delete(clientSocket));
    clientSocket.on('error', () => {});

    const target = parseConnectAuthority(req.url);
    if (!target) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const targetPort = isCursorHost(target.host) ? tlsPort : target.port;
    const targetHost = isCursorHost(target.host) ? '127.0.0.1' : target.host;
    const upstream = net.connect(targetPort, targetHost, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setNoDelay(true);
    clientSocket.setNoDelay(true);
    upstream.on('error', () => {
      if (!clientSocket.destroyed) {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        clientSocket.destroy();
      }
    });
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  });

  await new Promise((resolve, reject) => {
    connectProxy.once('error', reject);
    connectProxy.listen(port, host, () => {
      connectProxy.removeListener('error', reject);
      resolve();
    });
  });

  const boundPort = connectProxy.address().port;
  const proxyUrl = `http://${host}:${boundPort}`;

  return {
    port: boundPort,
    tlsPort,
    proxyUrl,
    close: async () => {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      for (const session of tlsSessions) {
        try {
          session.destroy();
        } catch {
          // Ignore session teardown errors.
        }
      }
      connectProxy.closeAllConnections?.();
      tlsHttpServer.closeAllConnections?.();
      await Promise.all([
        new Promise(resolve => connectProxy.close(() => resolve())),
        new Promise(resolve => tlsHttpServer.close(() => resolve())),
      ]);
    },
  };
}
