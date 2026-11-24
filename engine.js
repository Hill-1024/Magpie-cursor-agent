#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedRoles, validateConfig } from './lib/config.js';
import { CursorBridgeEngine } from './lib/cursor-engine.js';
import { startMitmProxy } from './lib/mitm-proxy.js';
import { initializeBridgeCa, loadBridgeCa } from './lib/x509.js';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));

function requireDataDir() {
  const raw = process.env.CURSOR_BYOK_DATA_DIR || process.env.CURSOR_BRIDGE_DATA_DIR;
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error('CURSOR_BYOK_DATA_DIR (or CURSOR_BRIDGE_DATA_DIR) must be an absolute path');
  }
  return raw;
}

function readValidatedConnection(configPath) {
  const bytes = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(bytes);
  const rootDir = process.env.CURSOR_BRIDGE_ROOT || path.dirname(configPath);
  const defaultRoot = path.join(os.homedir(), '.config', 'magpie-cursor-bridge');
  const allowPluginsJson =
    Boolean(process.env.CURSOR_BRIDGE_PLUGINS_JSON) ||
    path.resolve(rootDir) === path.resolve(defaultRoot);
  const mergedRoles = loadMergedRoles({
    rootDir,
    configRoles: parsed.roles || parsed,
    includeMagpiePlugins: allowPluginsJson,
    pluginsJsonPath: process.env.CURSOR_BRIDGE_PLUGINS_JSON || '',
  });
  const validated = validateConfig(
    { enabled: true, ...parsed, roles: mergedRoles },
    { fallbackMissingModel: true }
  );
  if (!validated) {
    throw new Error('Missing gateway, key, or selected model in connection config');
  }
  return { raw: bytes, rolesSig: JSON.stringify(mergedRoles), config: validated };
}

async function main() {
  const argument = process.argv[2];
  if (argument === '--version') {
    console.log(manifest.version);
    return;
  }
  if (!argument || argument === '--help' || argument === '-h') {
    console.log(
      `cursor-magpie-bridge ${manifest.version}\nUsage: engine.js --init-ca | CONNECTION.json`
    );
    return;
  }

  const dataDir = requireDataDir();
  if (argument === '--init-ca') {
    const state = initializeBridgeCa(dataDir);
    console.log(JSON.stringify(state));
    return;
  }

  const caStatus = initializeBridgeCa(dataDir);
  if (caStatus.ca !== 'ready' && process.env.CURSOR_BRIDGE_ALLOW_UNTRUSTED_CA !== '1') {
    throw new Error('Bridge requires an already trusted local CA certificate');
  }
  const { certPem, keyPem } = loadBridgeCa(dataDir);
  const configPath = path.resolve(argument);
  let { raw: lastRaw, rolesSig: lastRolesSig, config } = readValidatedConnection(configPath);

  const engine = new CursorBridgeEngine(config);
  const proxy = await startMitmProxy({
    engine,
    caCertPem: certPem,
    caKeyPem: keyPem,
    allowAuthPassthrough: process.env.CURSOR_BRIDGE_STRICT_OFFLINE !== '1',
  });

  console.log(
    JSON.stringify({
      event: 'ready',
      proxy: proxy.proxyUrl,
      backend: `https://127.0.0.1:${proxy.tlsPort}`,
      models: config.models.length,
    })
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(reloadTimer);
    await proxy.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.stdin && !process.stdin.destroyed) {
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }

  const reloadTimer = setInterval(() => {
    try {
      const next = readValidatedConnection(configPath);
      if (next.raw === lastRaw && next.rolesSig === lastRolesSig) return;
      engine.updateConfig(next.config);
      lastRaw = next.raw;
      lastRolesSig = next.rolesSig;
      console.log(JSON.stringify({ event: 'catalogue', models: next.config.models.length }));
    } catch {
      // Retain last valid catalogue when file is mid-write or temporarily invalid.
    }
  }, 2000);
  reloadTimer.unref?.();
}

main().catch(error => {
  console.error(error?.message || String(error));
  process.exit(1);
});
