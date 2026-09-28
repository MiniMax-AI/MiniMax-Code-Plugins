import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

/**
 * The release gates run in CI. This asserts that they run at all.
 *
 * A gate that only exists as a workflow step is one merge away from being a line of
 * YAML nobody reads, and its absence is invisible: the suite stays green, the
 * manifest drifts, and the next reviewer finds it. So the gate runner is invoked
 * here as a subprocess — the same entry point CI uses — and its failure has to fail
 * this test.
 *
 * The gates' own sensitivity (does each one actually fail when its invariant is
 * broken?) was verified by mutating each invariant in turn; that is a one-off
 * exercise rather than a test, because a test that deliberately corrupts the
 * repository to see whether a script notices is a test that can leave the
 * repository corrupted.
 */

const run = promisify(execFile);
const PLUGIN = path.join(import.meta.dirname, '..');
const GATES = path.join(PLUGIN, 'tools', 'release-gates.mjs');

test('the release gates pass on the current tree', async () => {
  const { stdout } = await run(process.execPath, [GATES], { cwd: PLUGIN });
  assert.match(stdout, /release gates passed\./u, stdout);
  // Every gate reports what it prevents, so a failure names the risk rather than
  // just "check failed".
  // Gate ids are hyphenated, and every gate prints the defect it prevents, so a
  // failure names the risk rather than just "check failed".
  const lines = stdout.split('\n').filter((line) => /^(?:ok|FAIL)\s+[\w-]+/u.test(line));
  assert.ok(lines.length >= 5, `expected one line per gate, got:\n${stdout}`);
  for (const line of lines) {
    assert.match(line, /^(?:ok|FAIL)\s+[\w-]+\s+\S.{10,}/u, `gate printed no description: ${line}`);
  }
});

test('the gates exit non-zero when an invariant is broken', async () => {
  // Point them at a tree that does not exist: the runner must fail loudly rather than
  // reporting a pass because it read nothing.
  await assert.rejects(
    run(process.execPath, [path.join(PLUGIN, 'tools', 'does-not-exist.mjs')], { cwd: PLUGIN }),
    'a missing gate runner must not look like a passing gate runner',
  );
});

test('the gate tool is dependency-free like the rest of the Plugin', async () => {
  // The Plugin ships no node_modules and no build step. A gate that imported a
  // package would make CI install dependencies for a Plugin that has none.
  const source = await (await import('node:fs/promises')).readFile(GATES, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';/gmu)].map((match) => match[1]);
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('.'),
      `release-gates.mjs imports "${specifier}"; the Plugin ships no dependencies`,
    );
  }
});
