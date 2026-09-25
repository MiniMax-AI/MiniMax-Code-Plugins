#!/usr/bin/env node
// Observer Hook for mcode-think-filter.
//
// Reads one JSON payload from stdin (the event), counts thinking blocks
// in the current assistant turn if the payload exposes them, and writes
// a compact audit entry to PLUGIN_DATA/state.json. Never edits the
// transcript; never affects agent behavior.

import { argv, env } from 'node:process';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECORDS = 4096;
const MAX_STDIN_BYTES = 64 * 1024;

function parseArgs(args) {
  const out = { state: null, phase: 'post-tool-use' };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--state') { out.state = args[i + 1]; i += 1; }
    else if (a === '--phase') { out.phase = args[i + 1]; i += 1; }
  }
  return out;
}

function expandRoot(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('${PLUGIN_DATA}')) {
    const r = env.PLUGIN_DATA;
    return r ? r + value.slice('${PLUGIN_DATA}'.length) : null;
  }
  return null;
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

async function loadState(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) return { records: [] };
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.records)) {
      return { records: parsed.records.slice(-MAX_RECORDS) };
    }
  } catch {}
  return { records: [] };
}

async function saveState(path, state) {
  const text = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_STATE_BYTES) {
    throw new Error(`state exceeds ${MAX_STATE_BYTES} bytes`);
  }
  await mkdir(dirname(path), { recursive: true });
  const staged = path + '.staging';
  await writeFile(staged, text, 'utf8');
  await rename(staged, path);
}

function countThinkingBlocks(payload) {
  // Different runtime versions expose different shapes. Look for a few
  // common keys and return the count we can find, or null.
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.thinkingBlocks)) return payload.thinkingBlocks.length;
  if (Array.isArray(payload.assistantMessage?.thinkingBlocks)) {
    return payload.assistantMessage.thinkingBlocks.length;
  }
  if (Array.isArray(payload.message?.thinking)) return payload.message.thinking.length;
  if (typeof payload.thinkingBlockCount === 'number') return payload.thinkingBlockCount;
  return null;
}

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.state) return;
  const statePath = expandRoot(args.state);
  if (!statePath) return;

  try {
    const payload = await readStdin();
    const count = countThinkingBlocks(payload);
    const state = await loadState(statePath);
    state.records.push({
      ts: new Date().toISOString(),
      phase: args.phase,
      thinkingBlockCount: count,
      payloadKeys: payload && typeof payload === 'object'
        ? Object.keys(payload).sort().slice(0, 10)
        : [],
    });
    if (state.records.length > MAX_RECORDS) {
      state.records = state.records.slice(-MAX_RECORDS);
    }
    await saveState(statePath, state);
  } catch {
    // Observer must never affect agent behavior.
  }
}

main();
