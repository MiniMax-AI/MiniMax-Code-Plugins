import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

/**
 * The release gates run in CI. This asserts that they run at all — and that they
 * still fail when the invariant they exist for is broken.
 *
 * A gate that only exists as a workflow step is one merge away from being a line of
 * YAML nobody reads, and its absence is invisible: the suite stays green, the
 * manifest drifts, and the next reviewer finds it. So the gate runner is invoked
 * here as a subprocess — the same entry point CI uses — and its failure has to fail
 * this test.
 *
 * The sensitivity is proved against a *copy*. A check that can only be shown to
 * fail by corrupting the tree the suite runs in is a check that gets skipped, and
 * the previous version of this file was exactly that: it read one file, matched one
 * declaration form, and called itself enforcement. Each mutation below is a bypass
 * that passed it.
 */

const run = promisify(execFile);
const PLUGIN = path.join(import.meta.dirname, '..');
const GATES = path.join(PLUGIN, 'tools', 'release-gates.mjs');

/**
 * Run the gates over a throwaway copy of the Plugin with one mutation applied, and
 * return what the runner wrote. Returns an empty string when the gates passed.
 */
async function gateOutput(mutate) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'trajectory-gates-'));
  try {
    await cp(PLUGIN, scratch, { recursive: true });
    await mutate(scratch);
    // A gate failure exits non-zero, which execFile reports as a rejection; the
    // rejection carries the same output a reader would see.
    const failure = await run(process.execPath, [path.join(scratch, 'tools', 'release-gates.mjs')], { cwd: scratch })
      .then(() => null, (error) => error);
    return failure ? `${failure.stdout}${failure.stderr}` : '';
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The failure lines one gate reported, in the runner's own `  - <id>: <what>` form. */
const gateFailures = (output, id) => output
  .split('\n')
  .map((line) => line.trimStart())
  .filter((line) => line.startsWith(`- ${id}:`));

const appendTo = (root, file, text) =>
  readFile(path.join(root, file), 'utf8').then((source) => writeFile(path.join(root, file), `${source}\n${text}\n`));

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

test('the zero-dependency gate sees the Plugin as it is', async () => {
  // The control for the mutations below: an unmutated copy must report nothing,
  // or every "caught" result afterwards would only mean the copy was broken.
  const output = await gateOutput(() => {});
  assert.deepEqual(gateFailures(output, 'zero-dependency'), [], output);
});

test('the zero-dependency gate rejects every way a package can be reached', async () => {
  const bypasses = [
    {
      what: 'a manifest declaring dependencies and devDependencies',
      expect: 'lodash',
      apply: (root) => writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'x', dependencies: { lodash: '^4' }, devDependencies: { 'left-pad': '^1' } }),
      ),
    },
    {
      what: 'a double-quoted dynamic load',
      expect: 'lodash',
      apply: (root) => appendTo(root, 'tools/fixture.mjs', 'export const probe = () => import("lodash");'),
    },
    {
      what: 'a single-quoted dynamic load',
      expect: 'left-pad',
      apply: (root) => appendTo(root, 'tools/panel-e2e.mjs', 'export const probe = () => import(\'left-pad\');'),
    },
    {
      what: 'a dynamic load in the gate runner itself',
      expect: 'lodash',
      apply: (root) => appendTo(root, 'tools/release-gates.mjs', 'await import("lodash");'),
    },
    {
      what: 'a createRequire load',
      expect: 'js-yaml',
      apply: (root) => appendTo(
        root,
        'tools/fixture.mjs',
        'import { createRequire } from \'node:module\';\nconst load = createRequire(import.meta.url)("js-yaml");',
      ),
    },
    {
      what: 'a package specifier written into a string literal',
      expect: 'js-yaml',
      apply: (root) => appendTo(
        root,
        'tools/compat-matrix.mjs',
        'export const note = `import yaml from "js-yaml"`;',
      ),
    },
    {
      what: 'a static declaration in a tool other than the gate runner',
      expect: 'js-yaml',
      apply: (root) => appendTo(root, 'tools/compat-matrix.mjs', 'import yaml from \'js-yaml\';'),
    },
    {
      what: 'a bare side-effect load',
      expect: 'dotenv/config',
      apply: (root) => appendTo(root, 'tools/compat-matrix.mjs', 'import \'dotenv/config\';'),
    },
    {
      what: 'a declaration split across lines and double-quoted',
      expect: 'js-yaml',
      apply: (root) => appendTo(
        root,
        'tools/compat-matrix.mjs',
        'import {\n  parse,\n} from "js-yaml"\nexport const parseAll = parse',
      ),
    },
    {
      what: 'an installed dependency tree',
      expect: 'node_modules',
      apply: async (root) => {
        await mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
        await writeFile(path.join(root, 'node_modules', 'left-pad', 'package.json'), '{"name":"left-pad"}');
      },
    },
    {
      what: 'a lockfile',
      expect: 'package-lock.json',
      apply: (root) => writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}'),
    },
  ];

  for (const bypass of bypasses) {
    const output = await gateOutput(bypass.apply);
    const failures = gateFailures(output, 'zero-dependency');
    assert.ok(failures.length > 0, `${bypass.what}: zero-dependency reported nothing\n${output}`);
    assert.ok(
      failures.some((line) => line.includes(bypass.expect)),
      `${bypass.what}: reported, but not the ${bypass.expect} it should have named\n${failures.join('\n')}`,
    );
  }
});

test('the documented test count is counted rather than assumed', async () => {
  // Adding a case without touching the docs is the drift this gate exists for, and
  // it has to be visible without running the suite: the count comes from test/.
  const drifted = await gateOutput((root) => appendTo(root, 'test/format.test.mjs', 'test(\'an added case\', () => {});'));
  const fromSuite = gateFailures(drifted, 'doc-test-counts');
  assert.ok(
    fromSuite.some((line) => line.includes('test/ declares')),
    `adding a case must fail the count gate\n${drifted}`,
  );

  // And the other direction: a doc edited to a number the suite never had.
  const edited = await gateOutput(async (root) => {
    const file = path.join(root, 'README.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\d+(?= tests, \d+ pass, 0 fail, 0 skipped)/u, '999'));
  });
  const fromDoc = gateFailures(edited, 'doc-test-counts');
  assert.ok(
    fromDoc.some((line) => line.startsWith('- doc-test-counts: README.md:') && line.includes('999')),
    `editing the documented count must fail the count gate\n${edited}`,
  );
});
