import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentId, nextMagpieGate, readWiredFromFile } from '../lib/magpie.js';

test('readWiredFromFile and nextMagpieGate track Magpie agent switch cleanly', testCtx => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-state-'));
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agents-state.json');

  fs.writeFileSync(file, JSON.stringify({ version: '1', state: { agents: [{ id: agentId, wired: true }] } }));
  assert.equal(readWiredFromFile(file), true);

  fs.writeFileSync(file, JSON.stringify({ version: '1', state: { agents: [{ id: agentId }] } }));
  assert.equal(readWiredFromFile(file), null);

  fs.writeFileSync(file, JSON.stringify({ version: '1', state: { agents: [{ id: agentId, wired: false }] } }));
  assert.equal(readWiredFromFile(file), false);

  assert.deepEqual(nextMagpieGate(null, false), { hold: false, next: null });
  assert.deepEqual(nextMagpieGate(null, true), { hold: false, next: true });
  assert.deepEqual(nextMagpieGate(true, false), { hold: true, next: false });
  assert.deepEqual(nextMagpieGate(false, null), { hold: false, next: false });
});
