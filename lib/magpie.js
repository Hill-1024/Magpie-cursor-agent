import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const agentId = 'cursor-bridge';

/** Candidate paths where Magpie persists agent connection state. */
export function stateCandidates(homeDir = os.homedir()) {
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const roamingAppData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  return [
    path.join(homeDir, 'Desktop', 'data', 'cache', 'agents-state.json'),
    path.join(homeDir, '.cache', 'magpie', 'agents-state.json'),
    path.join(localAppData, 'magpie', 'cache', 'agents-state.json'),
    path.join(localAppData, 'Programs', 'magpie', 'cache', 'agents-state.json'),
    path.join(roamingAppData, 'magpie', 'cache', 'agents-state.json'),
  ];
}

/** Parse `agents-state.json` and return `true`/`false` for `agentId`, or `null` if indeterminate. */
export function readWiredFromFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsedState;
  try {
    parsedState = JSON.parse(raw).state;
  } catch {
    return null;
  }
  const agents = parsedState?.agents;
  if (!Array.isArray(agents)) return null;
  const entry = agents.find(item => item?.id === agentId);
  if (!entry) return null;
  return entry.wired === true;
}

/** Return the first definitive `wired` reading across Magpie state files. */
export function readMagpieWired(homeDir = os.homedir()) {
  for (const candidate of stateCandidates(homeDir)) {
    const answer = readWiredFromFile(candidate);
    if (answer !== null) return answer;
  }
  return null;
}

/** Return `true` only when Magpie explicitly marks this agent disconnected. */
export function isSwitchedOff(homeDir = os.homedir()) {
  return readMagpieWired(homeDir) === false;
}

/**
 * State machine for Magpie's `wired` toggle so a transient omission across a
 * Magpie restart does not permanently lock out reconnection.
 */
export function nextMagpieGate(previous, reading) {
  if (reading === true) return { hold: false, next: true };
  if (reading === false && (previous === true || previous === false)) {
    return { hold: true, next: false };
  }
  return { hold: false, next: previous };
}
