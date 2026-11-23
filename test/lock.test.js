import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimLock, isLockHeld, isProcessAlive, processStartTime, releaseLock } from '../lib/lock.js';

function tempLock(testCtx) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-cursor-lock-'));
  testCtx.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'supervisor.lock');
}

test('claimLock reclaims stale pid-only or mismatched start-time locks', testCtx => {
  const lockDir = tempLock(testCtx);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, start: 'Thu Jan  1 00:00:00 2000' })
  );
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isLockHeld(path.join(lockDir, 'owner.json')), false);

  const owner = claimLock(lockDir);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.start, processStartTime(process.pid));
  assert.throws(() => claimLock(lockDir), /already running/);

  releaseLock(lockDir, owner);
  assert.equal(fs.existsSync(lockDir), false);
});

test('releaseLock does not remove lock taken over by a newer owner', testCtx => {
  const lockDir = tempLock(testCtx);
  const owner = claimLock(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: owner.pid + 1, start: 'newer' })
  );
  releaseLock(lockDir, owner);
  assert.equal(fs.existsSync(lockDir), true);
});
