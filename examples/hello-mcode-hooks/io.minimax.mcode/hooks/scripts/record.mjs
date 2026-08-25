#!/usr/bin/env node
// Experimental observer for the io.minimax.mcode Hooks preview.
//
// Reads one UTF-8 JSON document from stdin (the event payload), then appends a compact record
// to a per-instance state file using an atomic stage-and-rename write. No network access, no
// credentials, no telemetry. Resolves all paths from runtime-injected environment values
// only. Cross-platform: uses node:fs/promises and node:path, never host-absolute literals.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { argv, env } from 'node:process';

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECORDS = 4096;

function parseArgs(args) {
  const out = { event: null, state: null };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--event') {
      out.event = args[i + 1] ?? null;
      i += 1;
    } else if (a === '--state') {
      out.state = args[i + 1] ?? null;
      i += 1;
    }
  }
  return out;
}

function expandRoot(value, root) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('${PLUGIN_ROOT}')) {
    return join(root, value.slice('${PLUGIN_ROOT}'.length));
  }
  if (value.startsWith('${PLUGIN_DATA}')) {
    return join(env.PLUGIN_DATA ?? '', value.slice('${PLUGIN_DATA}'.length));
  }
  return value;
}

function ensureContained(target, root) {
  const rootReal = resolve(root);
  const targetReal = resolve(target);
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (targetReal !== rootReal && !targetReal.startsWith(prefix)) {
    throw new Error('path escapes plugin root');
  }
  return targetReal;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > 1024 * 64) break;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function loadState(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.records)) return parsed;
  } catch {
    // First run or unreadable prior state: start clean.
  }
  return { records: [] };
}

async function saveState(path, state) {
  const staged = path + '.staging';
  const text = JSON.stringify(state, null, 2);
  await writeFile(staged, text, 'utf8');
  await rename(staged, path);
}

function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.event || !args.state) {
    process.exit(0);
  }
  const root = env.PLUGIN_ROOT;
  if (!root) {
    process.exit(0);
  }
  const statePath = ensureContained(expandRoot(args.state, root), root);

  readStdin()
    .then((payload) => {
      const record = {
        event: args.event,
        receivedAt: new Date().toISOString(),
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
      };
      return mkdir(dirname(statePath), { recursive: true })
        .then(() => loadState(statePath))
        .then((state) => {
          state.records.push(record);
          if (state.records.length > MAX_RECORDS) {
            state.records.splice(0, state.records.length - MAX_RECORDS);
          }
          return saveState(statePath, state);
        });
    })
    .catch(() => {
      // Observer must never affect agent behavior.
    });
}

main();
