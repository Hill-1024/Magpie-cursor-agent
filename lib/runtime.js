import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BUN_MIN_HTTP2_VERSION = '1.4.4';
const NODE_MIN_HTTP2_VERSION = '18.0.0';
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

function defaultExec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

/** Parse a `major.minor.patch` version string into a numeric tuple, or `null` if invalid. */
export function parseSemver(rawVersion) {
  const match = SEMVER_RE.exec(String(rawVersion || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two semver strings numerically (`> 0` when `left > right`). */
export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft && !parsedRight) return 0;
  if (!parsedLeft) return -1;
  if (!parsedRight) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] !== parsedRight[index]) {
      return parsedLeft[index] - parsedRight[index];
    }
  }
  return 0;
}

/** Return deduplicated candidate directories where Magpie caches `magpie-bun`. */
export function magpieBunRoots(homeDir = os.homedir(), env = process.env) {
  const candidates = [path.join(homeDir, 'Desktop', 'data', 'cache', 'bun')];
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) {
    candidates.push(path.join(env.XDG_CACHE_HOME, 'magpie', 'bun'));
  }
  candidates.push(path.join(homeDir, '.cache', 'magpie', 'bun'));
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const roamingAppData = env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  candidates.push(path.join(localAppData, 'magpie', 'bun'));
  candidates.push(path.join(roamingAppData, 'magpie', 'bun'));
  return [...new Set(candidates)];
}

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const mode = platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
    fs.accessSync(filePath, mode);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Discover installed `magpie-bun` binaries sorted newest-first by numeric semver. */
export function findMagpieBuns({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const binaryNames = platform === 'win32' ? ['magpie-bun.exe', 'magpie-bun'] : ['magpie-bun'];
  const entries = [];
  const seenPaths = new Set();

  for (const root of magpieBunRoots(homeDir, env)) {
    let stateCurrent = '';
    try {
      const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
      if (typeof state?.current === 'string') stateCurrent = state.current.trim();
    } catch {
      // state.json may be absent before Magpie checks for Bun updates.
    }

    let dirEntries = [];
    try {
      dirEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirEntry of dirEntries) {
      if (!dirEntry.isDirectory() || !parseSemver(dirEntry.name)) continue;
      for (const binaryName of binaryNames) {
        const candidate = path.join(root, dirEntry.name, binaryName);
        if (!isExecutableFile(candidate, platform) || seenPaths.has(candidate)) continue;
        seenPaths.add(candidate);
        entries.push({
          path: candidate,
          version: dirEntry.name,
          isCurrent: dirEntry.name === stateCurrent,
        });
      }
    }
  }

  entries.sort((left, right) => {
    const verDiff = compareSemver(right.version, left.version);
    if (verDiff !== 0) return verDiff;
    if (left.isCurrent !== right.isCurrent) return left.isCurrent ? -1 : 1;
    return 0;
  });
  return entries;
}

/** Return the newest installed `magpie-bun` path, or `null` when unavailable. */
export function findMagpieBun(
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform
) {
  return findMagpieBuns({ homeDir, env, platform })[0]?.path || null;
}

/** Locate an available `node` executable on PATH or standard install directories. */
export function findNodeBinary({
  env = process.env,
  platform = process.platform,
  currentExecPath = process.execPath,
  exec = defaultExec,
} = {}) {
  const candidates = [];
  if (currentExecPath && /^node(\.exe)?$/i.test(path.basename(currentExecPath))) {
    candidates.push(currentExecPath);
  }
  if (platform === 'win32') {
    const probe = exec('where', ['node.exe']);
    if (probe.status === 0 && probe.stdout) {
      for (const line of probe.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) candidates.push(trimmed);
      }
    }
  } else {
    const probe = exec('/bin/sh', ['-c', 'command -v node 2>/dev/null || true'], { env });
    const resolved = (probe.stdout || '').trim();
    if (resolved) candidates.push(resolved);
    candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  }

  for (const candidate of candidates) {
    if (candidate && isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

/** Return whether a runtime version meets known HTTP/2 server ALPN requirements. */
export function isVersionHttp2Capable(kind, version) {
  if (!version) return false;
  if (kind === 'bun') return compareSemver(version, BUN_MIN_HTTP2_VERSION) >= 0;
  if (kind === 'node') return compareSemver(version, NODE_MIN_HTTP2_VERSION) >= 0;
  return false;
}

/** Inspect runtime kind (`bun` | `node`), semver, and HTTP/2 ALPN capability. */
export function inspectRuntime(runtimePath, exec = defaultExec) {
  if (!runtimePath) return null;
  const probe = exec(
    runtimePath,
    ['-e', 'console.log(JSON.stringify({bun:process.versions.bun||null,node:process.versions.node||null}))'],
    { timeout: 5000 }
  );
  if (probe.status !== 0 || !probe.stdout) {
    return null;
  }
  let info = null;
  try {
    info = JSON.parse(probe.stdout.trim());
  } catch {
    return null;
  }
  const kind = info?.bun ? 'bun' : info?.node ? 'node' : 'unknown';
  const version = info?.bun || info?.node || '';
  let realpath = runtimePath;
  try {
    realpath = fs.realpathSync(runtimePath);
  } catch {
    // Keep original path when realpath fails.
  }
  return {
    path: runtimePath,
    realpath,
    kind,
    version,
    http2: isVersionHttp2Capable(kind, version),
  };
}

/**
 * Select the best runtime for staging background bridge processes.
 * Prefers HTTP/2-capable `magpie-bun` (>= 1.4.4), then HTTP/2-capable `node`,
 * and falls back to older `magpie-bun` (e.g. 1.4.2) only when no Node exists.
 */
export function selectPreferredRuntime({
  homeDir = os.homedir(),
  env = process.env,
  platform = process.platform,
  currentExecPath = process.execPath,
  exec = defaultExec,
} = {}) {
  if (env.MAGPIE_BUN && isExecutableFile(env.MAGPIE_BUN, platform)) {
    const explicit = inspectRuntime(env.MAGPIE_BUN, exec);
    if (explicit) return explicit;
  }

  const buns = findMagpieBuns({ homeDir, env, platform });
  const topBun = buns[0] ? inspectRuntime(buns[0].path, exec) : null;
  if (topBun && topBun.http2) {
    return topBun;
  }

  const nodePath = findNodeBinary({ env, platform, currentExecPath, exec });
  const nodeInfo = nodePath ? inspectRuntime(nodePath, exec) : null;
  if (nodeInfo && nodeInfo.http2) {
    return nodeInfo;
  }

  if (topBun) return topBun;
  if (nodeInfo) return nodeInfo;
  return inspectRuntime(currentExecPath, exec) || {
    path: currentExecPath,
    realpath: currentExecPath,
    kind: 'unknown',
    version: '',
    http2: false,
  };
}

/**
 * Return `true` if `runtimePath` is a standalone binary that remains runnable
 * when copied out of its installation directory without adjacent shared libraries.
 */
export function isSelfContainedExecutable(
  runtimePath,
  { platform = process.platform, exec = defaultExec } = {}
) {
  if (platform === 'win32') return true;
  let targetPath = runtimePath;
  try {
    targetPath = fs.realpathSync(runtimePath);
  } catch {
    return false;
  }

  // Non-binary scripts (e.g. version manager shims) cannot be copied raw.
  try {
    const head = Buffer.alloc(4);
    const fd = fs.openSync(targetPath, 'r');
    try {
      const bytesRead = fs.readSync(fd, head, 0, 4, 0);
      if (bytesRead >= 2 && head[0] === 0x23 && head[1] === 0x21) {
        return false;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }

  if (platform === 'darwin') {
    const otool = exec('/usr/bin/otool', ['-L', targetPath]);
    if (otool.status !== 0 || !otool.stdout) return false;
    const lines = otool.stdout.split(/\r?\n/).slice(1);
    for (const rawLine of lines) {
      const dep = rawLine.trim().split(/\s+\(/)[0];
      if (!dep) continue;
      if (
        dep.startsWith('@rpath/') ||
        dep.startsWith('@loader_path/') ||
        dep.startsWith('@executable_path/')
      ) {
        return false;
      }
    }
    return true;
  }

  const ldd = exec('ldd', [targetPath]);
  if (ldd.status === 0 && ldd.stdout) {
    if (/libnode\.so|libv8\.so|libbun/i.test(ldd.stdout)) {
      return false;
    }
  }
  return true;
}

function writePosixRuntimeWrapper(runtimeDest, targetPath) {
  const escapedTarget = String(targetPath).replaceAll("'", "'\\''");
  const script = `#!/bin/sh\nexec '${escapedTarget}' "$@"\n`;
  fs.writeFileSync(runtimeDest, script, { mode: 0o755 });
  fs.chmodSync(runtimeDest, 0o755);
}

/**
 * Populate `runtimeDest` for a staged release and verify it executes `verifyScriptPath --version`.
 * Copies standalone runtimes (`magpie-bun`, static `node`), and falls back to a POSIX wrapper
 * script for dynamically-linked runtimes (e.g. Homebrew `node` with `@rpath/libnode`).
 */
export function stageRuntimeBinary(
  runtimePath,
  runtimeDest,
  verifyScriptPath,
  expectedVersion,
  { platform = process.platform, exec = defaultExec } = {}
) {
  const verify = () => {
    const check = exec(runtimeDest, [verifyScriptPath, '--version'], { timeout: 5000 });
    return check.status === 0 && String(check.stdout || '').trim() === expectedVersion;
  };

  if (isSelfContainedExecutable(runtimePath, { platform, exec })) {
    fs.copyFileSync(runtimePath, runtimeDest);
    if (platform !== 'win32') fs.chmodSync(runtimeDest, 0o755);
    if (verify()) {
      return { mode: 'copy', path: runtimeDest };
    }
  }

  if (platform === 'win32') {
    throw new Error(`无法运行托管运行时: ${runtimePath}`);
  }

  const stableTarget = path.resolve(runtimePath);
  writePosixRuntimeWrapper(runtimeDest, stableTarget);
  if (!verify()) {
    throw new Error(`无法验证托管运行时: ${stableTarget}`);
  }
  return { mode: 'wrapper', path: runtimeDest, target: stableTarget };
}
