import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Query the OS start timestamp for `pid` so recycled PIDs cannot masquerade
 * as an earlier lock holder.
 */
export function processStartTime(pid) {
  if (!(pid > 0)) return null;
  try {
    if (process.platform === 'win32') {
      const command = `$proc=Get-Process -Id ${Math.floor(pid)} -ErrorAction Stop; $proc.ProcessName+'|'+$proc.StartTime.ToUniversalTime().ToString('o')`;
      const output = execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return output.trim() || null;
    }
    const output = execFileSync('ps', ['-p', String(Math.floor(pid)), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

/** Return `true` when `pid` currently maps to a live OS process. */
export function isProcessAlive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return processStartTime(pid) !== null;
  }
}

/** Verify whether `ownerFile` points to a still-running matching process. */
export function isLockHeld(ownerFile) {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    const pid = Number(owner.pid);
    if (!(pid > 0)) return false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code !== 'EPERM') return false;
    }
    if (!owner.start) return true;
    const currentStart = processStartTime(pid);
    return currentStart === null || currentStart === owner.start;
  } catch {
    return false;
  }
}

/** Exclusively claim `lockDir` with `owner.json` (`O_CREAT | O_EXCL`), reclaiming stale locks. */
export function claimLock(lockDir) {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const ownerFile = path.join(lockDir, 'owner.json');
  const owner = {
    pid: process.pid,
    start: processStartTime(process.pid),
    wrote: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const descriptor = fs.openSync(ownerFile, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(owner));
      } finally {
        fs.closeSync(descriptor);
      }
      fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid), { mode: 0o600 });
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isLockHeld(ownerFile)) {
        throw new Error('bridge supervisor already running');
      }
      try {
        fs.rmSync(ownerFile, { force: true });
      } catch {
        // Retry on next loop pass.
      }
    }
  }
  throw new Error('bridge supervisor already running');
}

/** Release `lockDir` only if `owner` still matches the recorded PID. */
export function releaseLock(lockDir, owner = { pid: process.pid }) {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
    if (current.pid !== owner.pid) return;
  } catch {
    // Best-effort cleanup if owner metadata is unreadable.
  }
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}
