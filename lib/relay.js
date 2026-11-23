import net from 'node:net';

/**
 * Create a local TCP relay that forwards incoming connections to `getUpstreamPort()`.
 * Keeps Cursor's configured `http.proxy` address constant across engine restarts.
 */
export function createTcpRelay(getUpstreamPort, { port = 0, host = '127.0.0.1' } = {}) {
  const activeSockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, clientSocket => {
    activeSockets.add(clientSocket);
    clientSocket.setNoDelay(true);
    clientSocket.on('error', () => {});
    const upstreamPort = getUpstreamPort();
    if (!upstreamPort) {
      clientSocket.destroy();
      return;
    }
    const upstreamSocket = net.connect({ host, port: upstreamPort, allowHalfOpen: true });
    activeSockets.add(upstreamSocket);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => {
      activeSockets.delete(clientSocket);
      upstreamSocket.destroy();
    });
    upstreamSocket.on('close', () => {
      activeSockets.delete(upstreamSocket);
      clientSocket.destroy();
    });
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      }),
    close: () => {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      return new Promise(resolve => server.close(resolve));
    },
  };
}

/**
 * Bind `preferredPort` with brief retries (handles TIME_WAIT / fast restarts),
 * falling back to an OS-assigned ephemeral port if unavailable.
 */
export async function listenWithFallback(
  getUpstreamPort,
  preferredPort,
  { host = '127.0.0.1', attempts = 12, delayMs = 250 } = {}
) {
  if (preferredPort) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const relay = createTcpRelay(getUpstreamPort, { port: preferredPort, host });
      try {
        const boundPort = await relay.listen();
        return { relay, port: boundPort, fixed: boundPort === preferredPort };
      } catch {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  const relay = createTcpRelay(getUpstreamPort, { port: 0, host });
  const boundPort = await relay.listen();
  return { relay, port: boundPort, fixed: false };
}

/** Probe whether a TCP port on `host` is free right now. */
export function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}
