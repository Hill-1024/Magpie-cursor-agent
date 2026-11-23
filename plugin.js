import path from 'node:path';
import {
  ensureBridgeStarted,
  parseRequestedPort,
  resolveDefaultRoot,
  resolveSourceDir,
  startManagedConfigService,
} from './lib/service.js';

const PLUGIN_GUARD = Symbol.for('magpie.cursor-bridge.plugin.v1');

/** Magpie Bun Host plugin entry point (sole export so `servers(mod)` invokes only once). */
export default async function magpieCursorBridgePlugin(input, options = {}) {
  if (globalThis[PLUGIN_GUARD]) return {};
  globalThis[PLUGIN_GUARD] = true;

  const log = (level, message) => {
    try {
      input?.client?.app?.log?.({ body: { service: 'cursor-bridge', level, message } })?.catch?.(() => {});
    } catch {
      // Logging errors must never disrupt Magpie plugin host startup.
    }
  };

  const rootDir = resolveDefaultRoot();
  const sourceDir = resolveSourceDir();
  const port = parseRequestedPort(options);

  try {
    const service = await startManagedConfigService({
      rootDir,
      uiDir: path.join(sourceDir, 'ui'),
      port,
      onLog: log,
    });
    globalThis[PLUGIN_GUARD] = { service };
  } catch (error) {
    log('warn', `cursor-bridge: config service failed (${error?.message || error})`);
  }

  ensureBridgeStarted({ rootDir, sourceDir, onLog: log }).catch(() => {});
  return {};
}
