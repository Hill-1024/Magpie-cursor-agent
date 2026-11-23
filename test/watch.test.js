import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { shouldRevive } from '../lib/watch.js';

test('shouldRevive handles active, stale, stopped, and disconnected states', () => {
  const stale = Date.parse('2026-01-01T00:00:00Z');
  for (const state of ['connected', 'starting', 'paused', 'error']) {
    assert.equal(shouldRevive({ state, heartbeat: stale }), true);
  }
  assert.equal(shouldRevive(null), true);
  const now = Date.now();
  assert.equal(shouldRevive({ state: 'connected', heartbeat: now - 5000 }, now), false);
  assert.equal(shouldRevive({ state: 'connected', heartbeat: now - 25000 }, now), true);
  assert.equal(shouldRevive({ state: 'stopped' }), false);
  assert.equal(shouldRevive({ state: 'disconnected' }), false);
});

test('bridge.js declares watchSpawnedAt before ensureWatch and runs status cleanly', () => {
  const bridgeFile = fileURLToPath(new URL('../bridge.js', import.meta.url));
  const source = fs.readFileSync(bridgeFile, 'utf8');
  const callAt = source.indexOf('ensureWatch();');
  const declAt = source.indexOf('let watchSpawnedAt');
  assert.ok(declAt > 0 && declAt < callAt);
  const run = spawnSync(process.execPath, [bridgeFile, 'status'], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0, run.stderr);
});
