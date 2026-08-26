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
const MAX_STDIN_BYTES = 1024 * 64;

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

// Expand a single occurrence of ${PLUGIN_ROOT} or ${PLUGIN_DATA}. Only one expansion
// token is allowed per path. The expanded value is then resolved against the corresponding
// root for real-path and symlink containment. PLUGIN_ROOT and PLUGIN_DATA are independent
// roots; a path under PLUGIN_DATA is not required to be under PLUGIN_ROOT.
function expandAndCheck(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('${PLUGIN_ROOT}')) {
    const root = env.PLUGIN_ROOT;
    if (!root) return null;
    return ensureContained(join(root, value.slice('${PLUGIN_ROOT}'.length)), root);
  }
  if (value.startsWith('${PLUGIN_DATA}')) {
    const dataRoot = env.PLUGIN_DATA;
    if (!dataRoot) return null;
    return ensureContained(join(dataRoot, value.slice('${PLUGIN_DATA}'.length)), dataRoot);
  }
  return null;
}

function ensureContained(target, root) {
  const rootReal = resolve(root);
  const targetReal = resolve(target);
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (targetReal !== rootReal && !targetReal.startsWith(prefix)) {
    throw new Error(`path escapes plugin root: ${targetReal} is not under ${rootReal}`);
  }
  return targetReal;
}

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) break;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function trimRecords(records) {
  if (records.length <= MAX_RECORDS) return records;
  return records.slice(records.length - MAX_RECORDS);
}

async function loadState(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
      // Existing state is over the bound; discard it and start clean rather than carry
      // forward a payload that already exceeds what we promise to keep.
      return { records: [] };
    }
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.records)) {
      return { records: trimRecords(parsed.records.filter((r) => r && typeof r === 'object')) };
    }
  } catch {
    // First run or unreadable prior state: start clean.
  }
  return { records: [] };
}

async function saveState(path, state) {
  const staged = path + '.staging';
  const text = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
    throw new Error(`state exceeds ${MAX_STATE_BYTES} bytes after trim`);
  }
  await writeFile(staged, text, 'utf8');
  await rename(staged, path);
}

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.event || !args.state) {
    return;
  }
  let statePath;
  try {
    statePath = expandAndCheck(args.state);
  } catch {
    return;
  }
  if (!statePath) return;

  try {
    const payload = await readStdin();
    const record = {
      event: args.event,
      receivedAt: new Date().toISOString(),
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
    };
    await mkdir(dirname(statePath), { recursive: true });
    const state = await loadState(statePath);
    state.records = trimRecords([...state.records, record]);
    await saveState(statePath, state);
  } catch {
    // Observer must never affect agent behavior; swallow all errors silently.
  }
}

main();
