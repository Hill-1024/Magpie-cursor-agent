import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProxy, clearStaleProxy, readSettingsDocument, restoreProxy } from '../lib/settings.js';

function makeTemp(testCtx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-settings-'));
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return [path.join(dir, 'settings.json'), path.join(dir, 'journal.json')];
}

test('applyProxy and restoreProxy restore JSONC comments and trailing commas byte-for-byte', testCtx => {
  const [settingsPath, journalPath] = makeTemp(testCtx);
  const original = '{\n  // my settings\n  "editor.fontSize": 16,\n  "http.proxy": "http://localhost:8888",\n}\n';
  fs.writeFileSync(settingsPath, original);

  assert.equal(applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407'), true);
  assert.equal(applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407'), false);
  assert.equal(applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52408'), true);

  assert.deepEqual(restoreProxy(journalPath), []);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), original);
});

test('restoreProxy preserves user edits made while bridge is active', testCtx => {
  const [settingsPath, journalPath] = makeTemp(testCtx);
  fs.writeFileSync(settingsPath, '{"editor.fontSize": 16}\n');
  applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407');

  const parsed = readSettingsDocument(settingsPath).data;
  parsed['http.proxy'] = 'http://corp-proxy:8080';
  parsed['editor.fontSize'] = 20;
  fs.writeFileSync(settingsPath, JSON.stringify(parsed));

  assert.deepEqual(restoreProxy(journalPath), ['http.proxy']);
  assert.deepEqual(readSettingsDocument(settingsPath).data, {
    'editor.fontSize': 20,
    'http.proxy': 'http://corp-proxy:8080',
  });
});

test('external proxy change refuses overwrite and malformed settings retain journal', testCtx => {
  const [settingsPath, journalPath] = makeTemp(testCtx);
  fs.writeFileSync(settingsPath, '{}\n');
  applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407');

  const parsed = readSettingsDocument(settingsPath).data;
  parsed['http.proxy'] = 'http://localhost:8888';
  fs.writeFileSync(settingsPath, JSON.stringify(parsed));
  assert.throws(() => applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407'), /externally/);

  fs.writeFileSync(settingsPath, '{"broken"');
  assert.throws(() => restoreProxy(journalPath), /Invalid settings JSONC/);
  assert.ok(fs.existsSync(journalPath));
});

test('clearStaleProxy cleans orphaned loopback proxy but spares manual user proxy', testCtx => {
  const [settingsPath, journalPath] = makeTemp(testCtx);
  fs.writeFileSync(settingsPath, '{"editor.fontSize": 15}\n');
  applyProxy(settingsPath, journalPath, 'http://127.0.0.1:52407');
  fs.unlinkSync(journalPath);
  const removed = clearStaleProxy(settingsPath);
  assert.ok(removed.includes('http.proxy'));
  assert.deepEqual(readSettingsDocument(settingsPath).data, { 'editor.fontSize': 15 });

  fs.writeFileSync(settingsPath, '{"http.proxy": "http://corp-proxy:8080", "editor.fontSize": 14}\n');
  assert.deepEqual(clearStaleProxy(settingsPath), []);
  assert.equal(readSettingsDocument(settingsPath).data['http.proxy'], 'http://corp-proxy:8080');
});
