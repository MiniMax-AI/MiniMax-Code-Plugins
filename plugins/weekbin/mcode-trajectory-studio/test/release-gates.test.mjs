import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('the documented tool count is counted from TOOLS, not pinned', async () => {
  // The drift this gate exists for is real and has happened twice in one review round:
  // the README said "the seven declared tools" and DESIGN's layout said "MCP JSON-RPC +
  // 10 个工具" while the server had been serving thirteen for several rounds.
  //
  // The mutation below **adds a fourteenth tool**, which is what makes this gate different
  // from one that pinned the string "thirteen". A pinned gate would still be green here —
  // it would be reporting on a number that no longer describes anything, which is the
  // defect restated. Deriving the count from `TOOLS` means the gate fails at the moment
  // the server changes, in every file that states the count, and names the number to use.
  const mutated = await gateOutput((root) => editTools(root,
    'export const TOOLS = [\n',
    'export const TOOLS = [\n  { name: \'trajectory_extra\', description: \'added by the gate test\' },\n'));

  const failures = gateFailures(mutated, 'doc-tool-count');
  assert.ok(failures.length > 0, `a fourteenth tool must fail the count gate\n${mutated}`);
  for (const file of ['README.md', 'README.zh-CN.md', 'skills/mcode-trajectory-studio/SKILL.md']) {
    assert.ok(
      failures.some((line) => line.includes(file) && line.includes('14')),
      `the gate must name ${file} and the number to use\n${failures.join('\n')}`,
    );
  }

  // And the reverse direction: a doc edited to a count the server never had. This is the
  // shape both of the real occurrences had — the code moved and the prose did not.
  const edited = await gateOutput(async (root) => {
    const file = path.join(root, 'README.zh-CN.md');
    const text = await readFile(file, 'utf8');
    assert.ok(text.includes('十三个工具'), 'the anchor count is gone from README.zh-CN.md');
    return writeFile(file, text.replace('十三个工具', '十一个工具'));
  });
  const fromDoc = gateFailures(edited, 'doc-tool-count');
  assert.ok(
    fromDoc.some((line) => line.includes('README.zh-CN.md') && line.includes('十三个工具')),
    `a doc edited to a stale count must fail the gate\n${edited}`,
  );
});

/* ------------------------------- the record-list gate, against its own blind spot -- */
/**
 * `trajectory_search` shipped for a long time with a 200-row ceiling, an SQL query
 * that bound only `LIMIT ?`, and no count. The gate that was supposed to catch a
 * list without a completeness contract checked the *frame budget* fields and nothing
 * else — so a list that never dropped anything under pressure, and instead simply
 * ended, passed it. On a real machine 433 of 633 matches were unreachable by any
 * call and the reply disclosed nothing.
 *
 * These mutations reintroduce exactly that, one field at a time. Each has to be
 * caught, or the gate is decoration.
 */
/**
 * Read a source file with its line endings normalised to `\n`.
 *
 * Every anchor below is written with `\n`, and a checkout whose files carry `\r\n`
 * matches none of them. That failure reads as the mutation being impossible rather than
 * as a line-ending mismatch: `the mutation anchor is gone from TOOLS` on a file that
 * plainly contains it, and `the record-list gate catches a reply that drops total` failed
 * on Windows for exactly this reason. A mutation that cannot be applied proves nothing —
 * it is not evidence that the gate is blind, and it is not a pass either.
 *
 * Normalising on read also means the mutation is written back in the file's own spelling,
 * since the rest of the file is untouched.
 */
const readLf = async (file) => (await readFile(file, 'utf8')).replace(/\r\n/gu, '\n');

/** Apply an edit inside the `TOOLS` declaration — a schema, not a handler. */
const editTools = (root, from, to) =>
  readLf(path.join(root, 'server', 'mcp.mjs')).then((source) => {
    const start = source.indexOf('export const TOOLS = [');
    assert.notEqual(start, -1, 'no TOOLS declaration in mcp.mjs');
    const rest = source.slice(start);
    const end = rest.indexOf('\n];');
    const block = end === -1 ? rest : rest.slice(0, end);
    assert.ok(block.includes(from), `the mutation anchor is gone from TOOLS: ${from}`);
    return writeFile(path.join(root, 'server', 'mcp.mjs'), source.slice(0, start) + block.replace(from, to) + rest.slice(end));
  });

/**
 * Apply an edit inside one tool's `case` block, and nowhere else.
 *
 * The naive version — a plain string replace over the whole file — edits whichever
 * handler happens to come first. Three handlers here end their cursor with the same
 * expression, so two of these mutations silently rewrote `trajectory_turns` and the
 * gate passed for the wrong reason. The gate reads per-tool bodies, so the mutation
 * has to be scoped the same way.
 */
const editMcp = (root, tool, from, to) =>
  readLf(path.join(root, 'server', 'mcp.mjs')).then((source) => {
    const start = source.indexOf(`case '${tool}':`);
    assert.notEqual(start, -1, `no case block for ${tool}`);
    const rest = source.slice(start);
    const end = rest.indexOf("\n    case '", 1);
    const body = end === -1 ? rest : rest.slice(0, end);
    assert.ok(body.includes(from), `the mutation anchor is gone from ${tool}: ${from}`);
    const mutated = body.replace(from, to);
    return writeFile(
      path.join(root, 'server', 'mcp.mjs'),
      source.slice(0, start) + mutated + (end === -1 ? '' : rest.slice(end)),
    );
  });

test('the record-list gate sees a list that carries the budget fields but no cursor', async () => {
  // The control for the three below: the current tree reports nothing, so a "caught"
  // result afterwards means the gate fired and not that the copy was simply broken.
  const output = await gateOutput(() => {});
  assert.deepEqual(gateFailures(output, 'record-list-egress'), [], output);
});

test('the record-list gate catches a reply that drops its continuation', async () => {
  // Renamed, not set to null: `nextCursor: null` still *carries* the field, and a
  // gate that cannot tell those apart is the same gate that could not tell a field
  // from a reference to it. `trajectory_search` is the example under test because it
  // publishes the keyset form; the positional one is `trajectory_get`, checked below by
  // the gate's own rule that a tool publishes exactly one of the two.
  const output = await gateOutput((root) => editMcp(root, 'trajectory_search',
    '        nextCursor: reachedEnd || !lastCarried',
    '        pageCursor: reachedEnd || !lastCarried'));
  const failures = gateFailures(output, 'record-list-egress');
  assert.equal(failures.length > 0, true, `the gate accepted a list with no cursor:\n${output}`);
  assert.match(failures.join('\n'), /continuation/u);
});

test('the record-list gate catches a reply that drops total', async () => {
  // The trap this one sets: `nextOffset: … >= total` still contains the word `total`
  // after the field is gone, so a body-level search for it would pass this copy.
  const output = await gateOutput((root) => editMcp(root, 'trajectory_search',
    '        total,\n        returned: delivered,', '        returned: delivered,'));
  const failures = gateFailures(output, 'record-list-egress');
  assert.equal(failures.length > 0, true, `the gate accepted a page that cannot be told from the whole:\n${output}`);
  assert.match(failures.join('\n'), /total/u);
});

test('the record-list gate catches a paged tool with no way to continue', async () => {
  // The defect behind the other two: even a reply that carries `total` and a
  // continuation is unusable if there is no argument to feed the cursor back into.
  // The schema lives in `TOOLS`, not in the handler — the first version of this
  // mutation tried to edit it through the handler scoper, found no anchor, and the
  // copy went through unmutated.
  const output = await gateOutput((root) => editTools(root,
    "      cursor: str('Continue a walk over matches:",
    "      goneCursor: str('Continue a walk over matches:"));
  const failures = gateFailures(output, 'record-list-egress');
  assert.equal(failures.length > 0, true, `the gate accepted a list with no way to ask for the rest:\n${output}`);
  assert.match(failures.join('\n'), /cursor/u);
});

test('the record-list gate refuses to let a mutable-order list page by position', async () => {
  // `trajectory_list` and `trajectory_search` order by `updated_at_ms DESC`, the column
  // the runtime rewrites whenever it writes to a session. `LIMIT ? OFFSET ?` counts
  // positions, so a session written to mid-walk jumps above the cursor and is never
  // delivered again while the walk still reports no cursor: on a twelve-session fixture
  // that walk ended claiming twelve of twelve and had delivered eleven distinct ones.
  //
  // Both halves are mutated separately, because either one alone re-exposes the walk:
  // a reply that stopped carrying the cursor, and a tool that accepts a positional
  // argument alongside it.
  const halves = [
    ['the reply stops carrying a cursor', (root) => editMcp(root, 'trajectory_list', '        nextCursor,', '        nextOffset,')],
    ['the tool accepts an offset again', (root) => editTools(root,
      "      cursor: str('Continue a walk over sessions:",
      "      offset: int('Zero-based session offset.', { minimum: 0, default: 0 }),\n      cursor: str('Continue a walk over sessions:")],
  ];
  for (const [name, mutate] of halves) {
    const output = await gateOutput(mutate);
    const failures = gateFailures(output, 'record-list-egress');
    assert.equal(
      failures.length > 0,
      true,
      `the gate accepted a mutable-order list when ${name}:\n${output}`,
    );
    assert.match(failures.join('\n'), /must page by cursor|accepts no offset/u);
  }
});

/**
 * Whether this filesystem keeps POSIX permission bits at all.
 *
 * Measured rather than assumed from `process.platform`. The question the red-path
 * test needs answered is not "is this Windows" but "can a file here be made
 * executable", and only the second one is what the test's premise rests on. A
 * hardcoded platform name would be a second assertion about the environment,
 * asserted in a place that cannot fail if it drifts.
 *
 * Windows answers no: `chmod` toggles the read-only attribute and `stat.mode`
 * carries no execute bit, so `stat.mode & 0o111` is 0 for every file. The gate is
 * therefore *correct and silent* there — it finds nothing because there is nothing
 * to find — but a test that chmods a file to 0o755 and expects the gate to notice
 * is asserting something no Windows filesystem can produce.
 */
const KEEPS_POSIX_MODES = await (async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'trajectory-modes-'));
  const probe = path.join(dir, 'probe');
  try {
    await writeFile(probe, 'x');
    await chmod(probe, 0o600);
    const withoutExecute = (await lstat(probe)).mode & 0o100;
    await chmod(probe, 0o700);
    const withExecute = (await lstat(probe)).mode & 0o100;
    return withoutExecute === 0 && withExecute !== 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
})();

test('the package-plainness gate rejects a shipped file carrying an executable bit', {
  skip: KEEPS_POSIX_MODES
    ? false
    : 'this filesystem keeps no POSIX permission bits, so no shipped file can be executable here',
}, async () => {
  // Seventeen `tools/mutate-*.sh` files shipped with mode 755 and every other gate
  // passed. Nothing here could see it: each script is launched as `bash <path>` by
  // `mutation-sweep.mjs`, no behavioural test reads a mode, and the docs quote none.
  // The bit was rejected by the *host repository's* packaging check, after this
  // Plugin's own gates had certified it shippable — which is exactly why the gate
  // lives here rather than being left to the one check that is not ours.
  //
  // The mutation is a chmod rather than a written file, because the mode is the
  // defect: a fixture that adds `package-plain.txt` with no bit set would pass this
  // gate and teach nothing about the thing it exists to catch.
  const output = await gateOutput(async (root) => {
    await chmod(path.join(root, 'tools', 'mutation-lib.sh'), 0o755);
  });
  const failures = gateFailures(output, 'package-plainness');
  assert.ok(failures.length > 0, `the gate accepted an executable shipped file:\n${output}`);
  assert.match(failures.join('\n'), /tools\/mutation-lib\.sh carries mode 755/u, failures.join('\n'));
  // It must name the file, not just fail: a gate that reports "a problem" sends the
  // reader back to `find`, which is how a seventeen-file defect becomes a hunt.
  assert.match(failures.join('\n'), /no shipped file is executable/u);
});

test('the package-plainness gate rejects a shipped symlink', async () => {
  // Same class of claim: a link resolves on the machine that made it. A symlinked
  // file passes every content gate in this file — the text it resolves to is real —
  // and dangles the moment the Plugin is installed somewhere the target is absent.
  const output = await gateOutput(async (root) => {
    await symlink(path.join(root, 'server', 'mcp.mjs'), path.join(root, 'server', 'mcp-link.mjs'));
  });
  const failures = gateFailures(output, 'package-plainness');
  assert.ok(failures.length > 0, `the gate accepted a symlink inside the shipped tree:\n${output}`);
  assert.match(failures.join('\n'), /server\/mcp-link\.mjs is a symlink/u, failures.join('\n'));
});
