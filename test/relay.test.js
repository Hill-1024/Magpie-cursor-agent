import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createTcpRelay, listenWithFallback } from '../lib/relay.js';

function sendMessage(port, payload) {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => client.end(payload));
    const chunks = [];
    client.on('data', chunk => chunks.push(chunk));
    client.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    client.on('error', reject);
  });
}

test('relay preserves stable port across upstream restarts', async testCtx => {
  const echo1 = net.createServer({ allowHalfOpen: true }, sock => sock.on('data', d => sock.end(`s1:${d}`)));
  const echo2 = net.createServer({ allowHalfOpen: true }, sock => sock.on('data', d => sock.end(`s2:${d}`)));
  await new Promise(resolve => echo1.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => echo2.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => {
    echo1.close();
    echo2.close();
  });

  let targetPort = echo1.address().port;
  const { relay, port } = await listenWithFallback(() => targetPort, 0);
  testCtx.after(() => relay.close());

  assert.equal(await sendMessage(port, 'ping'), 's1:ping');
  targetPort = echo2.address().port;
  assert.equal(await sendMessage(port, 'pong'), 's2:pong');

  const conflict = createTcpRelay(() => targetPort, { port });
  await assert.rejects(() => conflict.listen());
});
