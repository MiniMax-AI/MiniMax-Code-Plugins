/**
 * The sweep runner's own tally has to be trustworthy, or it is decoration.
 *
 * `tools/mutation-sweep.mjs` exists because a full mutation sweep had no single entry
 * point: 31 scripts, run from whatever shell line was typed that day. The ad-hoc runner
 * reported `problems: 3` and exited 0. The `3` came from a grep pattern that existed only
 * in that one invocation — it could not be reproduced, so nobody could act on it, and an
 * exit code of 0 made it indistinguishable from a clean sweep.
 *
 * A tally that cannot be reproduced is not evidence, and a detector that has only ever
 * reported "no problems" is indistinguishable from a detector that never looks. So this
 * file does two things the sweep's own design needs anyway:
 *
 *   1. pins the classifier against synthetic output for every category, including the two
 *      that make a verdict worthless rather than merely unflattering (`anchor-missing`
 *      and `did-not-land`: a mutation that did not apply still prints a RED line, which is
 *      a green light for a mutant that never ran);
 *   2. runs the real runner over synthetic scripts that misbehave, and over one that
 *      behaves, because the control is what makes the misbehaviour results mean anything —
 *      a check that can only be shown to fail by breaking the tree is a check that gets
 *      skipped.
 *
 * Everything here runs against `--root`, a throwaway tree built in `tmpdir()`. The first
 * version wrote its synthetic scripts into the real `tools/` and deleted them afterwards,
 * and it broke the suite twice over: `node --test test/*.test.mjs` runs files
 * concurrently, `test/release-gates.test.mjs` copies this whole tree while they are
 * there, and a file that disappears mid-copy is an ENOENT attributed to a gate that never
 * touched mutation. That is the same rule the mutation scripts live by — nothing that
 * writes the tree runs beside anything that reads it — and the runner was made to obey it
 * rather than the test being made to be careful.
 *
 * Nothing here runs a real mutation: the synthetic scripts are deliberately instant.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classify } from '../tools/mutation-sweep.mjs';

const PLUGIN = path.join(import.meta.dirname, '..');
const SWEEP = path.join(PLUGIN, 'tools', 'mutation-sweep.mjs');

/**
 * A throwaway Plugin-shaped tree holding exactly the synthetic scripts a test asks for.
 * `t.after` removes it, so a failing assertion cannot leave one behind for the next run.
 */
async function treeWith(t, scripts) {
  const root = await mkdtemp(path.join(tmpdir(), 'trajectory-sweep-'));
  const tools = path.join(root, 'tools');
  await mkdir(tools);
  // Something that is not a mutation script, so the glob is exercised rather than assumed.
  await writeFile(path.join(tools, 'fixture.mjs'), 'export const nothing = 1;\n');
  for (const [name, body] of Object.entries(scripts)) {
    await writeFile(path.join(tools, `mutate-${name}.sh`), `${body}\n`, { mode: 0o755 });
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * Run the real runner over a throwaway tree, and return both what it printed and how it
 * exited. The exit code is part of the evidence: the defect this file covers is a tally
 * that reported problems and still exited 0.
 */
function sweep(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SWEEP, '--root', root], { cwd: PLUGIN });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Run `--list` with exactly the arguments given, and return stdout. */
function listWith(root, ...rest) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SWEEP, ...rest], { cwd: PLUGIN });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', () => resolve(output));
  });
}

/**
 * Whether this machine can execute the synthetic scripts at all.
 *
 * **Asked, not assumed.** Every script under `tools/` is `bash`, and a Windows machine
 * without Git Bash — or a minimal container — has none. Taking that as given would turn
 * the four end-to-end cases below into a suite that fails for a reason that has nothing to
 * do with the runner, on a platform where the reader cannot do anything about it. The
 * classifier cases, `--list`, and the empty-tree case need no bash at all and always run.
 */
const hasBash = await new Promise((resolve) => {
  const probe = spawn('bash', ['--version'], { stdio: 'ignore' });
  probe.on('error', () => resolve(false));
  probe.on('close', (code) => resolve(code === 0));
});

/** The reported number, read from the runner's own output rather than recomputed here. */
function reported(output, label) {
  const match = output.match(new RegExp(`^${label}:\\s*(\\d+)$`, 'mu'));
  assert.ok(match, `the runner did not report ${label}:\n${output}`);
  return Number(match[1]);
}

/** Every problem line, in order, so a category can be attributed to a script. */
function problems(output) {
  return output.split('\n').filter((line) => line.startsWith('  - ')).map((line) => line.slice(4));
}

/* ------------------------------------------------ the classifier -- */

test('a RED line is a killed mutant, and nothing else', () => {
  const { red, problems: found } = classify([
    'RED      ctrl-c-missing  (pass=1 fail=1)',
    'RED      ctrl-s-too-wide  (pass=2 fail=1)',
  ].join('\n'));
  assert.equal(red, 2);
  assert.deepEqual(found, []);
});

test('a SURVIVED line names the mutant that got away', () => {
  // The count the sweep exists to keep at zero, so it has to be separated from RED
  // rather than folded into a single "failed" tally: a survivor and a dead mutant are
  // opposite findings, and reporting them as one number hides which one happened.
  const { red, problems: found } = classify([
    'RED      good  (pass=1 fail=1)',
    'SURVIVED bad  (pass=9 fail=0)  -- the test does not pin this',
  ].join('\n'));
  assert.equal(red, 1);
  assert.deepEqual(found, ['survivor: bad']);
});

test('a mutation that did not apply is a problem, even though it went on to print RED', () => {
  // The most dangerous outcome available to a mutation sweep: the script cannot find its
  // anchor, changes nothing, and the tests still fail for unrelated reasons — or the
  // script reports RED anyway. Either way the number looks clean.
  const { red, problems: found } = classify([
    'RED      anchor-probe  (pass=1 fail=1)',
    'ANCHOR MISSING or AMBIGUOUS in server/search.mjs (needs exactly one match)',
    '  -- the mutation did not apply, so its result would say nothing',
  ].join('\n'));
  assert.equal(red, 1);
  assert.deepEqual(found, ['anchor-missing: server/search.mjs']);
});

test('a write that is not in the file is reported as not landing', () => {
  // Distinct from a missing anchor: the replace succeeded, and something afterwards put
  // the original text back. Only the second check catches it, so it has to be its own
  // category — collapsing both into "problem" would let this one hide behind the other.
  const { problems: found } = classify([
    'MUTATION DID NOT LAND in server/stats.mjs -- its result would say nothing',
  ].join('\n'));
  assert.deepEqual(found, ['did-not-land: server/stats.mjs']);
});

// The four cases below execute synthetic scripts, so they need bash; the ones after
// this block do not. Run the guarded set only where it can run, and assert the
// runner's own platform answer where it cannot — so a machine without bash gets a
// meaningful result instead of four failures that describe the machine, not the code.
if (hasBash) {
  /* ------------------------------------------- the runner, for real -- */

  test('a survivor and a dirty tree are each reported, attributed, and exit 1', async (t) => {
    const root = await treeWith(t, {
      'bad': [
        'echo "RED      fake-killed  (pass=1 fail=1)"',
        'echo "SURVIVED fake-survivor  (pass=9 fail=0)  -- the test does not pin this"',
        // Deliberately leaves a file behind, the way a `restore` that forgot one path does.
        'printf \'x\' > tools/leftover.tmp',
        'exit 0',
      ].join('\n'),
    });

    const { code, output } = await sweep(root);
    assert.equal(reported(output, 'RED'), 1, output);
    assert.equal(reported(output, 'SURVIVED'), 1, output);

    const found = problems(output);
    // Every category, attributed to the script that produced it. Asserting the count alone
    // would pass if the runner reported the survivor three times and the drift never.
    assert.ok(found.some((p) => p.includes('survivor: fake-survivor')), found.join('\n'));
    assert.ok(found.some((p) => p.includes('tree-drift:')), found.join('\n'));
    assert.ok(found.every((p) => p.startsWith('mutate-bad.sh ')), found.join('\n'));

    // The whole reason the runner exists: problems must not exit 0.
    assert.equal(code, 1, `a sweep that found ${found.length} problem(s) must not exit 0`);
  });

  test('the control: a script that behaves is reported clean', async (t) => {
    // Without this, "reports drift" is only meaningful next to "does not report drift when
    // there is nothing to report". A file created and removed inside the script exercises
    // the same tree hashing and must leave no drift — otherwise the check above would pass
    // because the hash is wrong, not because the script dirtied it.
    const root = await treeWith(t, {
      good: [
        'printf \'x\' > tools/transient.tmp',
        'rm -f tools/transient.tmp',
        'echo "RED      fake-killed  (pass=1 fail=1)"',
        'exit 0',
      ].join('\n'),
    });

    const { code, output } = await sweep(root);
    assert.equal(reported(output, 'RED'), 1, output);
    assert.equal(reported(output, 'SURVIVED'), 0, output);
    assert.equal(reported(output, 'problems'), 0, output);
    assert.equal(code, 0, output);
  });

  test('a script that prints nothing is silent, not clean', async (t) => {
    // A script whose every mutation was skipped, or that never ran any, still produces a
    // tally and reads exactly like a script that killed everything. Nothing on the output
    // distinguishes them without this check.
    const root = await treeWith(t, { mute: 'exit 0' });

    const { code, output } = await sweep(root);
    assert.equal(reported(output, 'RED'), 0, output);
    assert.ok(problems(output).some((p) => p.includes('silent:')), output);
    assert.equal(code, 1, output);
  });

  test('an exit code nothing explains is reported as a crash, not as silence', async (t) => {
    // A script can exit non-zero for a reason outside the named categories — a missing
    // file, a syntax error, a killed subprocess. Two things have to hold at once: it is
    // reported, and it is reported as the thing that happened. A crashed script said no
    // RED and no SURVIVED either, so a runner that checked `silent` first filed every
    // crash under "silent" — the vaguer finding, and the one that reads like a pass.
    const root = await treeWith(t, {
      crash: ['echo "something went wrong" >&2', 'exit 3'].join('\n'),
    });

    const { code, output } = await sweep(root);
    const found = problems(output);
    assert.ok(found.some((p) => p.includes('crash:')), found.join('\n'));
    assert.ok(!found.some((p) => p.includes('silent:')), found.join('\n'));
    assert.equal(code, 1, output);
  });

} else {
  test('without bash the runner names the platform instead of failing', async (t) => {
    const root = await treeWith(t, { anything: ['echo "RED x"', 'exit 0'].join('\n') });
    const { code, output } = await sweep(root);
    assert.ok(problems(output).some((p) => p.includes('no-bash:')), output);
    assert.match(output, /no-bash/u);
    assert.equal(code, 1, 'a sweep that could not run anything must not exit 0');
  });
}

test('a bare name filter selects, and is not silently dropped', async (t) => {
  // Found by running the runner the way a person does — `node tools/mutation-sweep.mjs
  // panel-storage` — and reading the tally instead of trusting the command. It ran all
  // 33 scripts. The filter dropped its argument:
  //
  //   const filters = args.filter((arg, i) => !arg.startsWith('--') && i !== rootIndex + 1);
  //
  // With no `--root`, `rootIndex` is `-1`, so the guard excludes index `0` — the first
  // positional argument, which is the filter. The output was a plausible tally for the
  // wrong set of scripts, which is why the `--list` test beside this one never caught it:
  // it passed `--root` and a filter together, so the two cancel and both look right.
  //
  // So the shape has to be checked **without** `--root`, because that is the shape that
  // was broken — and it has to run against the real tree, because `--root` absent *is*
  // what makes it the real tree. Pointing a bare filter at a throwaway copy would not
  // reproduce it: with `--root` present the two arguments cancel and both look right.
  //
  // **The filter comes FIRST, `--list` after it**, and that ordering is the whole point.
  // The bug only fires when the filter sits at index 0 — which is what
  // `node tools/mutation-sweep.mjs panel-storage` is. Put `--list` first and the flag
  // occupies index 0 instead, the guard excludes the flag (which is excluded anyway),
  // and the test passes against the very code it is meant to catch. Verified: with the
  // fix reverted, `--list agents-list` still went green.
  //
  // **`--list`, not a run.** The first version left it off entirely, and the runner
  // dutifully ran a real sweep over `tools/mutate-agents-list.sh` — rewriting the
  // working tree from inside the suite that reads it. That is the rule mutation scripts
  // are built to obey, and a test that breaks it does not fail: it reports whatever the
  // tree happened to look like mid-mutation. It reported **8 survivors** for a script
  // that is 8/8 red. `--list` answers the same question and runs nothing.
  const real = await listWith(PLUGIN, 'agents-list', '--list');
  assert.deepEqual(real.trim().split('\n'), ['mutate-agents-list.sh'],
    'a bare filter must narrow the set, and must not be swallowed as an option value');

  const none = await listWith(PLUGIN, 'zzz-no-such-script', '--list');
  assert.equal(none.trim(), 'no mutation scripts matched',
    'a filter that matches nothing must say so rather than listing nothing');

  // And with `--root` present, the option's value is the thing dropped — not the filter.
  const root = await treeWith(t, { alpha: 'exit 0', beta: 'exit 0' });
  const both = await listWith(PLUGIN, 'alpha', '--root', root, '--list');
  assert.deepEqual(both.trim().split('\n'), ['mutate-alpha.sh'],
    '--root takes one argument and must not consume the filter as well');
});



test('a tree with no scripts at all is a problem, not a clean sweep of nothing', async (t) => {
  // `--list` on a typo'd filter prints nothing and exits 0; running it does the same.
  // An empty result and a sweep that found nothing to do are different findings, and only
  // one of them means the suite is covered.
  const root = await treeWith(t, {});
  const { code, output } = await sweep(root);
  assert.equal(code, 1, output);
  assert.match(output, /no mutation scripts matched/u);
});

test('--root decides which scripts run, and --list proves it without running any', async (t) => {
  // The cheapest proof that `--root` is honoured, and deliberately the only one: proving
  // it by *running* it would mean a regression here sends the runner over all 31 real
  // mutation scripts, which rewrite this tree and take half an hour. `--list` reads the
  // same directory the run path reads, so routing that is wrong for a list is wrong for a
  // run, and this fails in a second.
  const root = await treeWith(t, {
    alpha: 'exit 0',
    beta: 'exit 0',
    // Not a mutation script: the glob, not just the directory, has to decide.
  });
  await writeFile(path.join(root, 'tools', 'release-gates.mjs'), '// not a mutation\n');

  const listed = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SWEEP, '--root', root, '--list'], { cwd: PLUGIN });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
  assert.equal(listed.code, 0, listed.output);
  assert.deepEqual(
    listed.output.trim().split('\n'),
    ['mutate-alpha.sh', 'mutate-beta.sh'],
    'the throwaway tree\'s own scripts, and nothing from the real tools/',
  );
});
