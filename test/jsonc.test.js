import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc, setJsoncProperty } from '../lib/jsonc.js';

test('parseJsonc handles comments, trailing commas, and escapes', () => {
  const input = `{
    // line comment
    "editor.fontSize": 16,
    /* block
       comment */
    "list": ["a", "b//not-comment", "c/*not*/",],
  }`;
  assert.deepEqual(parseJsonc(input), {
    'editor.fontSize': 16,
    list: ['a', 'b//not-comment', 'c/*not*/'],
  });
});

test('parseJsonc rejects malformed documents', () => {
  assert.throws(() => parseJsonc('{"broken"'));
  assert.throws(() => parseJsonc('{"a": 1} extra'));
  assert.throws(() => parseJsonc('/* unclosed'));
});

test('setJsoncProperty inserts, updates, and deletes while preserving comments and EOL', () => {
  const original = '{\r\n  // keep me\r\n  "editor.fontSize": 14,\r\n  "theme": "dark"\r\n}\r\n';
  const added = setJsoncProperty(original, 'http.proxy', 'http://127.0.0.1:52407', true);
  assert.match(added, /\/\/ keep me/);
  assert.ok(added.includes('\r\n'));
  assert.equal(parseJsonc(added)['http.proxy'], 'http://127.0.0.1:52407');

  const updated = setJsoncProperty(added, 'http.proxy', 'http://127.0.0.1:52408', true);
  assert.equal(parseJsonc(updated)['http.proxy'], 'http://127.0.0.1:52408');
  assert.match(updated, /\/\/ keep me/);

  const removed = setJsoncProperty(updated, 'http.proxy', undefined, false);
  assert.deepEqual(parseJsonc(removed), { 'editor.fontSize': 14, theme: 'dark' });
  assert.match(removed, /\/\/ keep me/);
});

test('setJsoncProperty handles empty object insertion and removal', () => {
  const empty = '{}\n';
  const withKey = setJsoncProperty(empty, 'http.proxy', 'http://127.0.0.1:52407', true);
  assert.deepEqual(parseJsonc(withKey), { 'http.proxy': 'http://127.0.0.1:52407' });
  const back = setJsoncProperty(withKey, 'http.proxy', undefined, false);
  assert.deepEqual(parseJsonc(back), {});
});

test('setJsoncProperty updates effective last key and deletes all duplicates', () => {
  const dup = '{\n  "http.proxy": "http://corp:8080",\n  "http.proxy": "http://corp:9090"\n}\n';
  const updated = setJsoncProperty(dup, 'http.proxy', 'http://127.0.0.1:52407', true);
  assert.equal(parseJsonc(updated)['http.proxy'], 'http://127.0.0.1:52407');
  assert.ok(updated.includes('"http://corp:8080"'));

  const deleted = setJsoncProperty(updated, 'http.proxy', undefined, false);
  assert.deepEqual(parseJsonc(deleted), {});
});
