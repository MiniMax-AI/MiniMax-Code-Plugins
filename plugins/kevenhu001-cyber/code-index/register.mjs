#!/usr/bin/env node

// Register the code-index plugin with MiniMax Code by copying this folder into
// MiniMax Code's local plugins directory. The plugin is a portable Agent Plugins
// 1.0 package: MiniMax Code reads mcp.json (stdio -> `node ./server.mjs`) and the
// skills/ folder, so no extra config is needed once the folder is in place.
//
// Usage:
//   node register.mjs                         # auto-detect the plugins directory
//   node register.mjs --dir "C:\path\to\plugins"   # explicit target
//   MINIMAX_CODE_PLUGINS_DIR="..." node register.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const owner = 'kevenhu001-cyber';
const pluginName = 'code-index';

function fail(message) {
  console.error(`register: ${message}`);
  process.exit(1);
}

const [nodeMajor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22) {
  fail(`Node.js 22+ is required (found ${process.versions.node}).`);
}

const argIndex = process.argv.indexOf('--dir');
const explicitDir = argIndex !== -1 ? process.argv[argIndex + 1] : process.env.MINIMAX_CODE_PLUGINS_DIR;

let target = explicitDir;
if (!target) {
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(home, '.minimax', 'plugins'),
          process.env.APPDATA && path.join(process.env.APPDATA, 'minimax-code', 'plugins'),
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'minimax-code', 'plugins'),
          path.join(home, '.minimax-code', 'plugins'),
        ]
      : process.platform === 'darwin'
        ? [
            path.join(home, '.minimax', 'plugins'),
            path.join(home, 'Library', 'Application Support', 'minimax-code', 'plugins'),
            path.join(home, '.minimax-code', 'plugins'),
          ]
        : [
            path.join(home, '.minimax', 'plugins'),
            path.join(home, '.minimax-code', 'plugins'),
            path.join(home, '.config', 'minimax-code', 'plugins'),
          ];
  target = candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate));
  if (!target) {
    fail(
      'Could not auto-detect a MiniMax Code plugins directory.\n' +
        'Pass one explicitly, e.g.:\n' +
        '  node register.mjs --dir "C:\\\\Users\\\\you\\\\.minimax-code\\\\plugins"\n' +
        'Searched:\n  - ' +
        candidates.filter(Boolean).join('\n  - '),
    );
  }
  console.log(`register: auto-detected plugins dir: ${target}`);
}

for (const required of ['plugin.json', 'mcp.json', 'README.md', 'LICENSE', 'server.mjs']) {
  if (!fs.existsSync(path.join(here, required))) fail(`missing required file: ${required}`);
}

try {
  execFileSync(process.execPath, ['--check', path.join(here, 'server.mjs')], { stdio: 'ignore' });
} catch {
  fail('server.mjs failed the Node syntax check.');
}

await fsp.mkdir(target, { recursive: true });
const dest = path.join(target, owner, pluginName);
await fsp.rm(dest, { recursive: true, force: true });
await fsp.cp(here, dest, { recursive: true });

console.log(`register: installed ${owner}/${pluginName} -> ${dest}`);
console.log('Next: reload or restart MiniMax Code. It will read mcp.json and start');
console.log('      `node ./server.mjs` over stdio, and load the code-index skill.');
console.log('      Then ask: "Use the code-index skill. Build the index for this project,');
console.log('      then tell me where <symbol> is defined and every place it is called."');
