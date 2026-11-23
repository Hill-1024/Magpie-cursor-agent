/**
 * Decide whether the detached watchdog should relaunch a dead supervisor.
 * Clean stops and explicit disconnects stay down; stale active states revive.
 */
export function shouldRevive(status, now = Date.now(), staleAfterMs = 20000) {
  if (!status || typeof status !== 'object') return true;
  if (status.state === 'stopped' || status.state === 'disconnected') return false;
  const heartbeat = Number(status.heartbeat);
  if (Number.isFinite(heartbeat) && now - heartbeat < staleAfterMs) {
    return false;
  }
  return (
    status.state === 'connected' ||
    status.state === 'starting' ||
    status.state === 'paused' ||
    status.state === 'error'
  );
}
