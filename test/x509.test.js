import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  generateLocalCa,
  initializeBridgeCa,
  issueLeafCertificate,
  validateCaPair,
} from '../lib/x509.js';

test('generateLocalCa and issueLeafCertificate produce valid X509 certificates verified by Node TLS', async testCtx => {
  const ca = generateLocalCa();
  assert.equal(validateCaPair(ca.certPem, ca.keyPem), true);

  const caX509 = new crypto.X509Certificate(ca.certPem);
  assert.equal(caX509.ca, true);

  const leaf = issueLeafCertificate({
    hostname: 'api2.cursor.sh',
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
  });
  const leafX509 = new crypto.X509Certificate(leaf.certPem);
  assert.equal(leafX509.ca, false);
  assert.equal(leafX509.verify(caX509.publicKey), true);
  assert.equal(leafX509.checkHost('api2.cursor.sh'), 'api2.cursor.sh');
  assert.equal(leafX509.checkHost('api3.cursor.sh'), 'api3.cursor.sh');

  const server = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, socket => {
    socket.end('tls-ok');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  testCtx.after(() => server.close());

  const reply = await new Promise((resolve, reject) => {
    const client = tls.connect(
      {
        port: server.address().port,
        host: '127.0.0.1',
        servername: 'api2.cursor.sh',
        ca: ca.certPem,
      },
      () => {
        let text = '';
        client.on('data', chunk => {
          text += chunk.toString('utf8');
        });
        client.on('end', () => resolve(text));
      }
    );
    client.on('error', reject);
  });
  assert.equal(reply, 'tls-ok');
});

test('initializeBridgeCa generates unique per-machine keys with restrictive modes and idempotency', testCtx => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-ca-'));
  testCtx.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dirOne = path.join(root, 'one');
  const dirTwo = path.join(root, 'two');
  const resOne = initializeBridgeCa(dirOne);
  const resTwo = initializeBridgeCa(dirTwo);

  assert.equal(resOne.ca, 'untrusted');
  assert.equal(resTwo.ca, 'untrusted');
  assert.notEqual(resOne.fingerprint, resTwo.fingerprint);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dirOne, 'ca')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dirOne, 'ca', 'ca.key')).mode & 0o777, 0o600);
  }

  const resRepeat = initializeBridgeCa(dirOne);
  assert.equal(resRepeat.fingerprint, resOne.fingerprint);

  fs.unlinkSync(path.join(dirOne, 'ca', 'ca.crt'));
  assert.throws(() => initializeBridgeCa(dirOne), /incomplete or invalid/);
});
