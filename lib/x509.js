import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWrite } from './settings.js';

const OID_COMMON_NAME = [2, 5, 4, 3];
const OID_ORGANIZATION = [2, 5, 4, 10];
const OID_RSA_ENCRYPTION = [1, 2, 840, 113549, 1, 1, 1];
const OID_SHA256_WITH_RSA = [1, 2, 840, 113549, 1, 1, 11];
const OID_SUBJECT_KEY_ID = [2, 5, 29, 14];
const OID_KEY_USAGE = [2, 5, 29, 15];
const OID_SUBJECT_ALT_NAME = [2, 5, 29, 17];
const OID_BASIC_CONSTRAINTS = [2, 5, 29, 19];
const OID_AUTHORITY_KEY_ID = [2, 5, 29, 35];
const OID_EXT_KEY_USAGE = [2, 5, 29, 37];
const OID_SERVER_AUTH = [1, 3, 6, 1, 5, 5, 7, 3, 1];

function derLength(length) {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag, content) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(payload.length), payload]);
}

function derSequence(items) {
  return derTlv(0x30, items);
}

function derSet(items) {
  return derTlv(0x31, items);
}

function derInteger(value) {
  let bytes;
  if (typeof value === 'number') {
    if (value === 0) return derTlv(0x02, Buffer.from([0]));
    const list = [];
    let remaining = value;
    while (remaining > 0) {
      list.unshift(remaining & 0xff);
      remaining = Math.floor(remaining / 256);
    }
    bytes = Buffer.from(list);
  } else {
    bytes = Buffer.from(value);
  }
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) {
    offset += 1;
  }
  let slice = bytes.subarray(offset);
  if (slice.length === 0) {
    slice = Buffer.from([0]);
  } else if (slice[0] & 0x80) {
    slice = Buffer.concat([Buffer.from([0x00]), slice]);
  }
  return derTlv(0x02, slice);
}

function derBitString(bytes, unusedBits = 0) {
  return derTlv(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

function derOctetString(bytes) {
  return derTlv(0x04, bytes);
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

function derBoolean(value) {
  return Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
}

function derOid(parts) {
  const encoded = [parts[0] * 40 + parts[1]];
  for (let index = 2; index < parts.length; index += 1) {
    let component = parts[index];
    if (component === 0) {
      encoded.push(0);
      continue;
    }
    const octets = [];
    while (component > 0) {
      octets.unshift(component & 0x7f);
      component >>>= 7;
    }
    for (let pos = 0; pos < octets.length - 1; pos += 1) {
      octets[pos] |= 0x80;
    }
    encoded.push(...octets);
  }
  return derTlv(0x06, Buffer.from(encoded));
}

function derUtf8(text) {
  return derTlv(0x0c, Buffer.from(text, 'utf8'));
}

function derTime(date) {
  const pad = value => String(value).padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  if (year >= 1950 && year <= 2049) {
    const yy = pad(year % 100);
    return derTlv(0x17, Buffer.from(`${yy}${month}${day}${hours}${minutes}${seconds}Z`, 'ascii'));
  }
  return derTlv(0x18, Buffer.from(`${year}${month}${day}${hours}${minutes}${seconds}Z`, 'ascii'));
}

function derExplicit(tagNumber, content) {
  return derTlv(0xa0 | tagNumber, content);
}

function derName(entries) {
  return derSequence(
    entries.map(([oid, value]) => derSet([derSequence([derOid(oid), derUtf8(value)])]))
  );
}

function derExtension(oid, critical, valueBuffer) {
  const parts = [derOid(oid)];
  if (critical) parts.push(derBoolean(true));
  parts.push(derOctetString(valueBuffer));
  return derSequence(parts);
}

function sha256AlgorithmId() {
  return derSequence([derOid(OID_SHA256_WITH_RSA), derNull()]);
}

function spkiSubjectKeyHash(spkiDer) {
  // Extract the raw BIT STRING payload from SubjectPublicKeyInfo for SubjectKeyIdentifier.
  // Falls back to hashing full SPKI if structure differs, staying deterministic.
  let offset = 0;
  if (spkiDer[offset] === 0x30) {
    offset += 1;
    const lenByte = spkiDer[offset++];
    if (lenByte & 0x80) offset += lenByte & 0x7f;
    if (spkiDer[offset] === 0x30) {
      offset += 1;
      const algLenByte = spkiDer[offset++];
      const algLen =
        algLenByte & 0x80
          ? spkiDer.subarray(offset, offset + (algLenByte & 0x7f)).reduce((acc, byte) => (acc << 8) | byte, 0)
          : algLenByte;
      if (algLenByte & 0x80) offset += algLenByte & 0x7f;
      offset += algLen;
      if (spkiDer[offset] === 0x03) {
        offset += 1;
        const bitLenByte = spkiDer[offset++];
        const bitLen =
          bitLenByte & 0x80
            ? spkiDer.subarray(offset, offset + (bitLenByte & 0x7f)).reduce((acc, byte) => (acc << 8) | byte, 0)
            : bitLenByte;
        if (bitLenByte & 0x80) offset += bitLenByte & 0x7f;
        const rawKeyBits = spkiDer.subarray(offset + 1, offset + bitLen);
        return crypto.createHash('sha1').update(rawKeyBits).digest();
      }
    }
  }
  return crypto.createHash('sha1').update(spkiDer).digest();
}

function toPem(label, derBuffer) {
  const base64 = derBuffer.toString('base64');
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 0x01;
  return bytes;
}

function signCertificate({
  serial,
  issuerEntries,
  subjectEntries,
  notBefore,
  notAfter,
  subjectSpkiDer,
  extensions,
  signerKeyPem,
}) {
  const tbs = derSequence([
    derExplicit(0, derInteger(2)),
    derInteger(serial || randomSerial()),
    sha256AlgorithmId(),
    derName(issuerEntries),
    derSequence([derTime(notBefore), derTime(notAfter)]),
    derName(subjectEntries),
    subjectSpkiDer,
    derExplicit(3, derSequence(extensions)),
  ]);

  const signature = crypto.sign('sha256', tbs, signerKeyPem);
  const certDer = derSequence([tbs, sha256AlgorithmId(), derBitString(signature, 0)]);
  return toPem('CERTIFICATE', certDer);
}

const CA_SUBJECT = [
  [OID_ORGANIZATION, 'Magpie Cursor Bridge'],
  [OID_COMMON_NAME, 'Magpie Cursor Bridge Local CA'],
];

/** Generate a fresh per-machine RSA-2048 CA certificate and private key pair. */
export function generateLocalCa() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const ski = spkiSubjectKeyHash(publicKey);
  const now = Date.now();
  const notBefore = new Date(now - 5 * 60 * 1000);
  const notAfter = new Date(now + 3650 * 24 * 60 * 60 * 1000);

  const extensions = [
    derExtension(OID_BASIC_CONSTRAINTS, true, derSequence([derBoolean(true), derInteger(0)])),
    derExtension(OID_KEY_USAGE, true, derBitString(Buffer.from([0x86]), 1)),
    derExtension(OID_SUBJECT_KEY_ID, false, derOctetString(ski)),
  ];

  const certPem = signCertificate({
    issuerEntries: CA_SUBJECT,
    subjectEntries: CA_SUBJECT,
    notBefore,
    notAfter,
    subjectSpkiDer: publicKey,
    extensions,
    signerKeyPem: privateKey,
  });

  return { certPem, keyPem: privateKey, ski };
}

/** Mint a 365-day TLS server leaf certificate for `hostname` signed by the local CA. */
export function issueLeafCertificate({ hostname, caCertPem, caKeyPem }) {
  const caX509 = new crypto.X509Certificate(caCertPem);
  const caSpkiDer = crypto.createPublicKey(caKeyPem).export({ type: 'spki', format: 'der' });
  const caSki = spkiSubjectKeyHash(caSpkiDer);

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const leafSki = spkiSubjectKeyHash(publicKey);
  const now = Date.now();
  const notBefore = new Date(now - 5 * 60 * 1000);
  const notAfter = new Date(now + 365 * 24 * 60 * 60 * 1000);

  const dnsNames = Array.from(
    new Set([hostname, 'api2.cursor.sh', 'api3.cursor.sh', '*.cursor.sh'].filter(Boolean))
  );
  const sanDer = derSequence(dnsNames.map(name => derTlv(0x82, Buffer.from(name, 'ascii'))));
  const ekuDer = derSequence([derOid(OID_SERVER_AUTH)]);

  const extensions = [
    derExtension(OID_BASIC_CONSTRAINTS, true, derSequence([])),
    derExtension(OID_KEY_USAGE, true, derBitString(Buffer.from([0xa0]), 5)),
    derExtension(OID_EXT_KEY_USAGE, false, ekuDer),
    derExtension(OID_SUBJECT_ALT_NAME, false, sanDer),
    derExtension(OID_SUBJECT_KEY_ID, false, derOctetString(leafSki)),
    derExtension(OID_AUTHORITY_KEY_ID, false, derSequence([derTlv(0x80, caSki)])),
  ];

  const issuerEntries = extractIssuerEntries(caX509);
  const certPem = signCertificate({
    issuerEntries,
    subjectEntries: [[OID_COMMON_NAME, hostname || '*.cursor.sh']],
    notBefore,
    notAfter,
    subjectSpkiDer: publicKey,
    extensions,
    signerKeyPem: caKeyPem,
  });

  return { certPem, keyPem: privateKey };
}

function extractIssuerEntries(x509) {
  const commonName = x509.subject
    .split('\n')
    .find(line => line.startsWith('CN='))
    ?.slice(3);
  const org = x509.subject
    .split('\n')
    .find(line => line.startsWith('O='))
    ?.slice(2);
  const entries = [];
  if (org) entries.push([OID_ORGANIZATION, org]);
  entries.push([OID_COMMON_NAME, commonName || 'Magpie Cursor Bridge Local CA']);
  return entries;
}

/** Verify whether `certPem` and `keyPem` form a valid matching CA pair. */
export function validateCaPair(certPem, keyPem) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    if (!x509.ca) return false;
    const publicKey = crypto.createPublicKey(keyPem);
    return x509.checkPrivateKey(crypto.createPrivateKey(keyPem)) && x509.verify(publicKey);
  } catch {
    return false;
  }
}

/** Compute uppercase SHA-1 thumbprint (without colons) for keychain/store matching. */
export function certSha1Fingerprint(certPem) {
  const x509 = new crypto.X509Certificate(certPem);
  return x509.fingerprint.replaceAll(':', '').toUpperCase();
}

/** Check whether the CA cert is currently trusted in the OS certificate store. */
export function isCaTrustedByOs(certPath, certPem) {
  if (process.platform === 'darwin') {
    try {
      const result = execFileSync('/usr/bin/security', ['verify-cert', '-c', certPath, '-p', 'ssl'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return typeof result === 'string';
    } catch {
      return false;
    }
  }
  if (process.platform === 'win32') {
    try {
      const thumbprint = certSha1Fingerprint(certPem);
      const script = `Test-Path "Cert:\\LocalMachine\\Root\\${thumbprint}"`;
      const out = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return out.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }
  return fs.existsSync('/usr/local/share/ca-certificates/magpie-cursor-bridge-ca.crt');
}

/** Ensure CA files exist under `<dataDir>/ca/{ca.crt,ca.key}` and report CA readiness. */
export function initializeBridgeCa(dataDir) {
  const caDir = path.join(dataDir, 'ca');
  const certPath = path.join(caDir, 'ca.crt');
  const keyPath = path.join(caDir, 'ca.key');

  const hasCert = fs.existsSync(certPath);
  const hasKey = fs.existsSync(keyPath);

  if (hasCert !== hasKey) {
    throw new Error('CA files are incomplete or invalid');
  }

  let certPem;
  let keyPem;
  if (!hasCert && !hasKey) {
    fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });
    const generated = generateLocalCa();
    certPem = generated.certPem;
    keyPem = generated.keyPem;
    atomicWrite(keyPath, keyPem, { mode: 0o600 });
    atomicWrite(certPath, certPem, { mode: 0o644 });
  } else {
    certPem = fs.readFileSync(certPath, 'utf8');
    keyPem = fs.readFileSync(keyPath, 'utf8');
    if (!validateCaPair(certPem, keyPem)) {
      throw new Error('CA files are incomplete or invalid');
    }
  }

  const trusted = isCaTrustedByOs(certPath, certPem);
  return {
    ca: trusted ? 'ready' : 'untrusted',
    certificate: certPath,
    fingerprint: certSha1Fingerprint(certPem),
  };
}

/** Load an existing valid CA pair from `<dataDir>/ca/{ca.crt,ca.key}`. */
export function loadBridgeCa(dataDir) {
  const certPath = path.join(dataDir, 'ca', 'ca.crt');
  const keyPath = path.join(dataDir, 'ca', 'ca.key');
  const certPem = fs.readFileSync(certPath, 'utf8');
  const keyPem = fs.readFileSync(keyPath, 'utf8');
  if (!validateCaPair(certPem, keyPem)) {
    throw new Error('Bridge CA certificate/key pair is invalid');
  }
  return { certPath, keyPath, certPem, keyPem };
}
