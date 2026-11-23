import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const tracked = [
  'agent.js',
  'bridge.js',
  'engine.js',
  'install.js',
  'setup.command',
  'setup.ps1',
  'setup.cmd',
  'package.json',
  'icon.svg',
  'icon.png',
];

for (const entry of fs.readdirSync(path.join(root, 'lib')).sort()) {
  if (entry.endsWith('.js')) {
    tracked.push(`lib/${entry}`);
  }
}

const files = {};
for (const relPath of tracked) {
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, relPath))).digest('hex');
  files[relPath] = digest;
}

const output = {
  version: manifest.version,
  files,
};
fs.writeFileSync(path.join(root, 'integrity.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Updated integrity.json for v${manifest.version} (${Object.keys(files).length} files)`);
