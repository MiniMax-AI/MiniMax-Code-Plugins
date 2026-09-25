#!/usr/bin/env node
// SessionStart hook for mcode-computer-use.
// Ensures PLUGIN_DATA exists and resets the screenshot counter.

import { argv, env } from 'node:process';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadState, saveState } from '../../../lib/state.mjs';

const args = parseArgs(argv.slice(2));
if (!args.state) process.exit(0);
const statePath = args.state;

await mkdir(dirname(statePath), { recursive: true });
await mkdir(`${dirname(statePath)}/trajectory`, { recursive: true });

const cur = await loadState(statePath);
await saveState(statePath, {
  ...cur,
  screenshotCount: 0,
  sessionStartedAt: new Date().toISOString(),
  pid: process.pid,
});

function parseArgs(args) {
  const out = { state: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') { out.state = args[i + 1]; i += 1; }
  }
  return out;
}
