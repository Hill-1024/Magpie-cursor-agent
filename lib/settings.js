import fs from 'node:fs';
import path from 'node:path';
import { parseJsonc, setJsoncProperty } from './jsonc.js';

export const PROXY_KEYS = [
  'http.proxy',
  'http.proxyKerberosServicePrincipal',
  'http.proxySupport',
  'cursor.general.disableHttp2',
  'http.experimental.systemCertificatesV2',
  'http.noProxy',
];

const LOOPBACK_PROXY_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

/** Write a file atomically via a same-directory temp file and rename with Windows EPERM retry. */
export function atomicWrite(filePath, content, { mode = 0o600 } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  fs.writeFileSync(tempFile, content, { mode });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (error) {
      const retryable = error.code === 'EPERM' || error.code === 'EACCES';
      if (!retryable || attempt === 7) {
        try {
          fs.rmSync(tempFile, { force: true });
        } catch {
          // Ignore cleanup errors on throw path.
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1));
    }
  }
}

/** Read and validate a JSONC settings object from disk (defaulting to `{}` if absent). */
export function readSettingsDocument(filePath) {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}\n';
  let data;
  try {
    data = parseJsonc(text);
  } catch (error) {
    throw new Error(`Invalid settings JSONC: ${error.message}`);
  }
  if (!data || Array.isArray(data) || typeof data !== 'object') {
    throw new Error('Invalid settings JSONC: root must be an object');
  }
  return { text, data };
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function captureKeyState(data, key) {
  return Object.hasOwn(data, key) ? { exists: true, value: data[key] } : { exists: false };
}

function applyKeyState(text, key, keyState) {
  return setJsoncProperty(text, key, keyState.exists ? keyState.value : undefined, keyState.exists);
}

/**
 * Apply bridge proxy settings to Cursor's settings.json while persisting a durable
 * rollback journal beforehand. Returns `true` only if settings text changed.
 */
export function applyProxy(settingsPath, journalPath, proxyUrl) {
  const desired = {
    'http.proxy': proxyUrl,
    'http.proxyKerberosServicePrincipal': proxyUrl,
    'http.proxySupport': 'on',
    'cursor.general.disableHttp2': true,
    'http.experimental.systemCertificatesV2': true,
    'http.noProxy': [],
  };

  const { text, data } = readSettingsDocument(settingsPath);
  const previous = fs.existsSync(journalPath)
    ? JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    : null;

  if (previous && previous.settings !== settingsPath) {
    throw new Error('Journal settings path differs from target settings path');
  }

  const journal = previous || {
    settings: settingsPath,
    entries: {},
    originalText: text,
  };

  let updated = text;
  for (const [key, value] of Object.entries(desired)) {
    const appliedState = value === undefined ? { exists: false } : { exists: true, value };
    const priorEntry = journal.entries[key];
    if (priorEntry && !valuesEqual(captureKeyState(data, key), priorEntry.applied)) {
      throw new Error('Cursor proxy settings changed externally; bridge paused');
    }
    journal.entries[key] = {
      before: priorEntry?.before || captureKeyState(data, key),
      applied: appliedState,
    };
    updated = applyKeyState(updated, key, appliedState);
  }

  if (previous && updated === text && previous.appliedText === updated) {
    return false;
  }

  journal.appliedText = updated;
  atomicWrite(journalPath, JSON.stringify(journal, null, 2), { mode: 0o600 });
  if (updated !== text) {
    const mode = fs.existsSync(settingsPath) ? fs.statSync(settingsPath).mode & 0o777 : 0o644;
    atomicWrite(settingsPath, updated, { mode });
  }
  return updated !== text;
}

/**
 * Restore Cursor settings recorded in `journalPath`. Preserves external edits
 * made to individual keys while disconnected/connected and returns skipped keys.
 */
export function restoreProxy(journalPath) {
  if (!fs.existsSync(journalPath)) {
    return [];
  }
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const { text, data } = readSettingsDocument(journal.settings);
  const targetMode = fs.existsSync(journal.settings)
    ? fs.statSync(journal.settings).mode & 0o777
    : 0o644;

  if (text === journal.appliedText && typeof journal.originalText === 'string') {
    atomicWrite(journal.settings, journal.originalText, { mode: targetMode });
    fs.unlinkSync(journalPath);
    return [];
  }

  let updated = text;
  const skipped = [];
  for (const [key, entry] of Object.entries(journal.entries || {})) {
    const current = captureKeyState(data, key);
    if (valuesEqual(current, entry.applied)) {
      updated = applyKeyState(updated, key, entry.before);
    } else if (!valuesEqual(current, entry.before)) {
      skipped.push(key);
    }
  }

  if (updated !== text) {
    atomicWrite(journal.settings, updated, { mode: targetMode });
  }
  fs.unlinkSync(journalPath);
  return skipped;
}

/**
 * Remove leftover bridge-shaped loopback proxy settings when no journal remains.
 * User-configured non-loopback proxies or differing values are left untouched.
 */
export function clearStaleProxy(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return [];
  }
  const { text, data } = readSettingsDocument(settingsPath);
  const currentProxy = data['http.proxy'];
  if (typeof currentProxy !== 'string' || !LOOPBACK_PROXY_PATTERN.test(currentProxy)) {
    return [];
  }

  let updated = text;
  const removed = [];
  for (const key of PROXY_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    const matchesBridgeShape =
      key === 'http.proxy'
        ? true
        : key === 'http.proxyKerberosServicePrincipal'
          ? value === currentProxy
          : key === 'http.proxySupport'
            ? value === 'on'
            : key === 'cursor.general.disableHttp2'
              ? value === true
              : key === 'http.experimental.systemCertificatesV2'
                ? value === true
                : Array.isArray(value) && value.length === 0;
    if (!matchesBridgeShape) continue;
    updated = setJsoncProperty(updated, key, undefined, false);
    removed.push(key);
  }

  if (updated !== text) {
    const targetMode = fs.statSync(settingsPath).mode & 0o777;
    atomicWrite(settingsPath, updated, { mode: targetMode });
  }
  return removed;
}
