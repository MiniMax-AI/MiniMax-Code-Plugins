#!/usr/bin/env node
// SessionStart / Stop observer for the easyloop plugin. Ensures
// ${PLUGIN_DATA}/selections/ exists and appends a small audit entry.

import { argv, env } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(args) {
  const out = { data: null, phase: 'session-start' };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--data') { out.data = args[i + 1]; i += 1; }
    else if (a === '--phase') { out.phase = args[i + 1]; i += 1; }
  }
  return out;
}

function expandData(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('${PLUGIN_DATA}')) {
    const r = env.PLUGIN_DATA;
    return r ? r + value.slice('${PLUGIN_DATA}'.length) : null;
  }
  return value;
}

async function main() {
  const args = parseArgs(argv.slice(2));
  const dataDir = expandData(args.data);
  if (!dataDir) return;
  await mkdir(join(dataDir, 'selections'), { recursive: true });
  await writeFile(
    join(dataDir, 'session.log'),
    JSON.stringify({ ts: new Date().toISOString(), phase: args.phase, pid: process.pid }) + '\n',
    { flag: 'a' },
  );
}

main().catch(() => {});
