#!/usr/bin/env node
// Experimental observer for the io.minimax.mcode Hooks preview.
//
// Reads one UTF-8 JSON document from stdin (the event payload), then appends a compact record
// to a per-instance state file using an atomic stage-and-rename write. No network access, no
// credentials, no telemetry. Resolves all paths from runtime-injected environment values
// only. Cross-platform: uses node:fs/promises and node:path, never host-absolute literals.

import { readFile, writeFile, rename, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
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
async function expandAndCheck(value) {
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

// Real-path containment. The round-4 review pointed out that the
// previous implementation only did `path.resolve` (a lexical
// normalization), which is bypassed by symlinks. For example:
//
//   PLUGIN_DATA = /tmp/d  (realpath /var/srv/d)
//   ${PLUGIN_DATA}/link/state.json  where 'link' is a symlink to /etc
//
// Lexically: targetReal='/tmp/d/link/state.json',
//            rootReal='/var/srv/d', prefix='/var/srv/d/'. The
//            `startsWith` check is FALSE — the lexical check
//            refuses. So the old code was actually safe for THIS
//            case, but only by accident (the symlink happens to
//            live at a different lexical prefix than the
//            realpath of the root).
//
// The real bypass is the OPPOSITE: when the root itself is reached
// via a symlink, the lexical prefix can be lexically INSIDE the
// root, while the realpath target is OUTSIDE. For example:
//
//   PLUGIN_DATA = /tmp/d  (realpath /var/srv/d)
//   realpath('/tmp/d/foo') = '/var/srv/d/foo'  → contained ✓
//   but if /tmp/d itself is a symlink to /etc, then:
//   lex '/tmp/d/foo' starts with '/tmp/d/'  → 'contained' (false positive)
//   realpath('/tmp/d/foo') = '/etc/foo'     → NOT contained (the truth)
//
// The fix is to call realpath on the root once (if it exists) and
// then call realpath on every prefix of the target up to the
// common ancestor with the realpath-root. If any segment along
// the way is a symlink, we resolve it eagerly. This makes the
// lexical-vs-realpath race a structural impossibility: we always
// compare realpath to realpath.
//
// Note on Windows: mkdtemp returns a short 8.3 path
// (C:\Users\ADMINI~1\...) but realpath returns the long form
// (C:\Users\Administrator\...). The two strings are different
// lengths, so a naive `target.slice(parent.length + 1)` produces
// a corrupted basename. We use `path.relative` instead, which is
// length-independent.
async function ensureContained(target, root) {
  if (!isAbsolute(root)) {
    throw new Error(`plugin root is not absolute: ${root}`);
  }
  if (!isAbsolute(target)) {
    throw new Error(`target path is not absolute: ${target}`);
  }
  const rootReal = await realpathOf(root);
  let cursor = target;
  while (true) {
    let cursorReal;
    try {
      cursorReal = await realpathOf(cursor);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        const parent = dirname(cursor);
        if (parent === cursor) {
          throw new Error(`path escapes plugin root: ${target} is not under ${root}`);
        }
        const parentReal = await realpathOf(parent);
        if (!isUnder(parentReal, rootReal)) {
          throw new Error(`path escapes plugin root: ${target} is not under ${root}`);
        }
        // The basename is the segment AFTER the last path
        // separator in `target`; using `relative` is length-safe
        // even when short/long paths are mixed (Windows).
        const base = relative(parent, target);
        if (base.startsWith('..') || isAbsolute(base)) {
          throw new Error(`path escapes plugin root: ${target} is not under ${root}`);
        }
        return join(parentReal, base);
      }
      throw error;
    }
    if (cursorReal === rootReal) {
      return cursorReal;
    }
    if (isUnder(cursorReal, rootReal)) {
      return cursorReal;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Error(`path escapes plugin root: ${target} is not under ${root}`);
    }
    cursor = parent;
  }
}

async function realpathOf(p) {
  // Always run realpath. We deliberately do NOT catch ENOENT here
  // and return the input path: that would defeat the comparison
  // against rootReal, because a short/long path mix on Windows
  // would compare unequal even when the file is contained. The
  // caller (ensureContained) is responsible for the ENOENT
  // fallback when the target is a new file inside an existing
  // directory.
  return await realpath(p);
}

function isUnder(child, parent) {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
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
    statePath = await expandAndCheck(args.state);
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
