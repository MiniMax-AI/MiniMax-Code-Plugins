/**
 * No exported symbol is dead.
 *
 * The plugin is built to be read as much as run: every module explains why it is shaped
 * the way it is, and a reader who cannot tell which of those explanations correspond to
 * code that executes has no way to trust any of them. A dead export is worse than a
 * missing one — it looks like a second place the truth lives, and it will drift.
 *
 * This is the standing version of a scan that was run by hand after `web/js/rows.js`
 * shipped with `streamBounds()` in it: an accessor nobody called, reading
 * `state.renderedRows` — render *state*, in a module about how records become rows. It
 * was left over from the design that was not adopted, and nothing in the package would
 * have said so. The hand scan found it; this file keeps finding it.
 *
 * "Referenced" means any mention outside the defining line — inside the same module
 * (a helper the module calls), in another module, in the browser entry point, or in a
 * test. A test counts: it is a real caller, and the question here is "can a reader find
 * out whether this runs", not "does production code call it".
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');

/** Directories whose text counts as a caller, plus the file extensions that carry code. */
const SCANNED = [
  { dir: path.join(ROOT, 'server'), ext: '.mjs' },
  // `web/`, not `web/js/`: the entry point `web/app.js` is where `installController`,
  // `loadAgents` and `readTheme` are actually called, and a scan rooted one level too
  // deep reported all three as dead. The modules were fine; the scan was wrong — which is
  // why every report this file makes has to be checked against the package before anyone
  // deletes anything on its word.
  { dir: path.join(ROOT, 'web'), ext: '.js' },
  { dir: path.join(ROOT, 'test'), ext: '.mjs' },
  { dir: path.join(ROOT, 'tools'), ext: '.mjs' },
];

async function filesUnder(dir, ext) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** `export function foo(`, `export async function foo(`, `export const foo =`. */
const DEFINITION = /^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gmu;

/**
 * Source with block and line comments removed.
 *
 * Without this the guard counts its own documentation. Every module header names the
 * symbols it discusses — and so does this file, which mentions `streamBounds` while
 * explaining why it was deleted — so a symbol mentioned only in prose reads as live. That
 * is not hypothetical: re-adding that exact export left this check green.
 *
 * The same trap bit `stats.mjs` earlier, where a scan for `json_array_length` found the
 * sentence explaining why the summary does *not* use it. A scanner that reads prose is a
 * scanner that has to be told to stop.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

async function exportedSymbols(file) {
  const text = stripComments(await readFile(file, 'utf8'));
  return [...text.matchAll(DEFINITION)].map((match) => match[1]);
}

test('every exported symbol has a caller somewhere in the package', async () => {
  const sources = [];
  for (const { dir, ext } of SCANNED) sources.push(...await filesUnder(dir, ext));
  const texts = new Map(await Promise.all(
    sources.map(async (file) => [file, stripComments(await readFile(file, 'utf8'))]),
  ));

  const dead = [];
  for (const [file, text] of texts) {
    if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue;
    for (const symbol of await exportedSymbols(file)) {
      // Every mention anywhere, minus the ones that are the definition itself. Counting
      // the whole package rather than only the sibling files is what lets a symbol be
      // called from its own module, from another one, or from a test.
      let mentions = 0;
      for (const other of texts.values()) {
        mentions += (other.match(new RegExp(`\\b${symbol}\\b`, 'gu')) ?? []).length;
      }
      const definitions = (text.match(new RegExp(`^export\\s+(?:async\\s+)?(?:function|const)\\s+${symbol}\\b`, 'gmu')) ?? []).length;
      if (mentions - definitions <= 0) dead.push(`${path.relative(ROOT, file)} exports ${symbol}`);
    }
  }
  assert.deepEqual(dead, [], dead.join('; '));
});

test('the guard sees a symbol nobody calls', async () => {
  // Without this the check could pass because the scan finds nothing at all — a file it
  // failed to read, a pattern that never matches, a directory that moved. Same shape as
  // the "not vacuous" half of the portable-paths guard.
  const symbol = 'zzDeadSymbolProbe';
  const file = path.join(ROOT, 'web', 'js', 'zz-dead-probe.js');
  const { writeFile, rm } = await import('node:fs/promises');
  await writeFile(file, `// A comment that mentions ${symbol} is prose, not a caller.\nexport const ${symbol} = 1;\n`);
  try {
    const text = stripComments(await readFile(file, 'utf8'));
    const mentions = (text.match(new RegExp(`\\b${symbol}\\b`, 'gu')) ?? []).length;
    assert.equal(mentions - 1, 0, 'the probe export must read as unreferenced');
  } finally {
    await rm(file, { force: true });
  }
});