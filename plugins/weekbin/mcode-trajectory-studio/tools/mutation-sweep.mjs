#!/usr/bin/env node
/**
 * Run every mutation script in this Plugin, serially, and report what they actually proved.
 *
 * The defect this exists to prevent: **a mutation total that nobody can reproduce.**
 *
 * `tools/mutate-*.sh` is 31 scripts deep. For a long time the only way to run them all
 * was an ad-hoc shell incantation typed into a terminal, and it printed a summary like
 * `RED: 178 / SURVIVED: 0 / problems: 3`. Two of those numbers came straight from the
 * scripts' own `RED`/`SURVIVED` lines. The third came from a `grep` pattern that existed
 * only in that one invocation: it was never written down, never re-run, and could not be
 * reproduced. A sweep that reports `problems: 3` while exiting 0 is indistinguishable
 * from a sweep that found nothing — and the two outcomes demand different work.
 *
 * So the tally is defined here, in one place, with a name for every category, and a
 * non-zero exit whenever any category fires. The categories are the ones that make a
 * mutation's verdict meaningless rather than merely unflattering:
 *
 *   anchor-missing     The script could not find its literal anchor, so it changed
 *                      nothing. Its RED line would have been a **green light for a
 *                      mutation that never ran** — the most dangerous outcome there is,
 *                      because it is indistinguishable from a correctly-killed mutant.
 *   did-not-land       The replacement was written but is not in the file. Same verdict,
 *                      reported later and by a different check.
 *   survivor           The mutant survived: no test pins the thing it changed. This is
 *                      the number the sweep exists to keep at zero.
 *   tree-drift         The script did not put the working tree back. Every later
 *                      verdict is then read against a tree nobody remembers editing,
 *                      and the next run inherits the contamination. Checked by hashing
 *                      the whole Plugin before and after each script, not just the files
 *                      the script names, because a script that forgets one file in its
 *                  `restore` is exactly the case a per-file check would miss.
 *   silent             The script produced no RED and no SURVIVED line at all. A script
 *                      whose every mutation was skipped still prints a tally, and reads
 *                      as a clean run.
 *   crash              The script exited non-zero without saying why in the categories
 *                      above, so its failure is not attributable.
 *
 * Serial, and not merely by convention: these scripts rewrite files in this tree, so
 * running two at once — or running one while a test suite reads the same files — makes
 * verdicts that are not merely wrong but untraceable.
 *
 * Usage:
 *   node tools/mutation-sweep.mjs                 # every script
 *   node tools/mutation-sweep.mjs --list          # names only, runs nothing
 *   node tools/mutation-sweep.mjs ingress         # only scripts matching a substring
 *   node tools/mutation-sweep.mjs --root <dir>    # a throwaway copy, for tests
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN = path.join(import.meta.dirname, '..');

/** Longest a single script may take. Each one runs a real suite several times. */
const SCRIPT_TIMEOUT_MS = 30 * 60 * 1000;

/** Directories a verdict must never depend on. */
const VOLATILE = new Set(['node_modules', '.git', '.cache', 'coverage']);

/**
 * Hash every file in the Plugin, so "did this script clean up" is answered by the whole
 * tree rather than by the list of files the script remembered to back up. Returns a
 * single hex digest plus the file count, so a file appearing or disappearing is as
 * visible as a file changing.
 */
async function hashTree(root) {
  // Recursion must not finalise: `digest()` on any level but the last ends the hash and
  // every update after it throws ERR_CRYPTO_HASH_FINALIZED.
  const digest = createHash('sha256');
  let files = 0;
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (VOLATILE.has(entry.name)) continue;
      const here = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(here);
        continue;
      }
      if (!entry.isFile()) continue;
      digest.update(path.relative(root, here));
      digest.update(await readFile(here));
      files += 1;
    }
  };
  await walk(root);
  return `${digest.digest('hex')}:${files}`;
}

async function mutationScripts(root) {
  const entries = await readdir(path.join(root, 'tools'));
  return entries.filter((name) => /^mutate-.*\.sh$/u.test(name)).sort();
}

function run(root, script) {
  return new Promise((resolve) => {
    let spawnFailed = false;
    const child = spawn('bash', [path.join(root, 'tools', script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      output += `\n[mutation-sweep] killed after ${SCRIPT_TIMEOUT_MS}ms\n`;
      child.kill('SIGKILL');
    }, SCRIPT_TIMEOUT_MS);
    // A machine with no `bash` produces a spawn **error**, and without this listener Node
    // throws an unhandled `error` event and the runner dies with a stack trace instead of
    // a verdict. These scripts are `bash` by construction, so this is a real platform to
    // report rather than a corner: the tally has to say which platform could not run, not
    // stop at the first one. `spawnFailed` is carried out rather than folded into the
    // output so the caller can name it — an unreadable failure is exactly the shape this
    // whole tool exists to stop shipping.
    child.on('error', (error) => {
      output += `\n[mutation-sweep] could not execute bash: ${error.message}\n`;
      spawnFailed = true;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, spawnFailed });
    });
  });
}

/**
 * Whether this machine can run the scripts at all.
 *
 * Asked rather than assumed, because the answer differs by platform and the consequence of
 * guessing wrong is a verdict that means nothing: `bash` ships with macOS and with Git for
 * Windows, and most Linux images have it, but a Windows machine without Git Bash — or a
 * minimal container — has none, and the sweep there would report every script as having
 * produced nothing.
 */
async function bashAvailable() {
  return new Promise((resolve) => {
    const probe = spawn('bash', ['--version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Read one script's verdict. Every line it printed is classified, and the counts are
 * returned rather than an aggregate, because "3 problems" is only actionable next to
 * which category fired and in which script.
 */
export function classify(output) {
  const lines = output.split('\n');
  const problems = [];
  let red = 0;
  for (const line of lines) {
    if (/^RED\s+/u.test(line)) { red += 1; continue; }
    if (/^SURVIVED\s+/u.test(line)) {
      problems.push(`survivor: ${line.replace(/^SURVIVED\s+/u, '').split('  ')[0]}`);
      continue;
    }
    if (/ANCHOR MISSING or AMBIGUOUS/u.test(line)) {
      problems.push(`anchor-missing: ${line.replace(/^.*in /u, '').split(/\s/)[0]}`);
      continue;
    }
    if (/MUTATION DID NOT LAND/u.test(line)) {
      problems.push(`did-not-land: ${line.replace(/^.*in /u, '').split(/\s/)[0]}`);
    }
  }
  return { red, problems };
}

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args.includes('--list');
  // `--root` exists so the runner can be pointed at a throwaway copy, which is what its
  // own test does. Testing it by writing synthetic scripts into `tools/` and deleting
  // them again fails the whole suite: `node --test test/*.test.mjs` runs files
  // concurrently, `test/release-gates.test.mjs` copies this whole tree while it does,
  // and a file that vanishes mid-copy is an ENOENT in a test that had nothing to do with
  // mutation. A runner whose verdicts are only obtainable by editing the tree under the
  // reader is a runner whose verdicts cannot be obtained in a full-suite run at all.
  const rootIndex = args.indexOf('--root');
  const hasRoot = rootIndex !== -1;
  const root = hasRoot ? path.resolve(args[rootIndex + 1] ?? '') : PLUGIN;
  // The one index to drop is `--root`'s value, and **only when `--root` was passed**.
  // Written as `i !== rootIndex + 1` without that guard, an absent `--root` makes
  // `rootIndex + 1` equal `0`, so the *first positional argument* is dropped — and
  // `node tools/mutation-sweep.mjs panel-storage` silently ran all 33 scripts instead of
  // one, printing a perfectly plausible tally for the wrong set. Observed, not theorised:
  // the script named on the command line was absent from its own output.
  const filters = args.filter((arg, i) => !arg.startsWith('--') && !(hasRoot && i === rootIndex + 1));
  let scripts = await mutationScripts(root);
  if (filters.length > 0) scripts = scripts.filter((name) => filters.some((f) => name.includes(f)));

  // Checked **before** the `--list` early return, not after. A filter that matched
  // nothing used to print nothing at all under `--list` and exit 0, which is the exact
  // shape this tool exists to stop: a typo'd name returns a clean empty answer, and a
  // clean empty answer is indistinguishable from "there is nothing to sweep".
  if (scripts.length === 0) {
    process.stderr.write('no mutation scripts matched\n');
    process.exitCode = 1;
    return;
  }
  if (listOnly) {
    for (const name of scripts) process.stdout.write(`${name}\n`);
    return;
  }

  const before = await hashTree(root);
  let red = 0;
  let sawDrift = false;
  const problems = [];

  // Asked before the first script runs, so a machine that cannot run them is told so in
  // one line instead of once per script — and so the answer is not inferred from 33
  // crashes that all look like `silent`.
  if (!(await bashAvailable())) {
    problems.push('no-bash: this machine has no bash, and every script under tools/ is one; no tier could run');
  }

  for (const [index, script] of scripts.entries()) {
    process.stderr.write(`[${index + 1}/${scripts.length}] ${script}\n`);
    const { code, signal, output, spawnFailed } = await run(root, script);
    const { red: scriptRed, problems: scriptProblems } = classify(output);
    red += scriptRed;

    if (spawnFailed) {
      // The script never started, so it touched nothing and there is nothing to put back.
      // Said once per script because each one is a tier that produced no evidence — the
      // tally has to show 33 absent tiers, not one line and thirty-two silences.
      problems.push(`${script} no-bash: the script could not be executed on this machine`);
      continue;
    }

    const after = await hashTree(root);
    const drifted = after !== before;
    if (drifted) {
      scriptProblems.push(`tree-drift: ${script} left the working tree at ${after}, expected ${before}`);
      sawDrift = true;
    }
    // Order matters, and it is the reason `crash` is checked first. A script that died
    // without saying why also said no RED and no SURVIVED, so checking `silent` first
    // filed every crash under "silent" — the vaguer of the two findings, and the one
    // that reads like a passing sweep. A non-zero exit is the script telling us plainly
    // that it failed, so it gets the category that says so.
    if (code !== 0 && scriptProblems.length === 0) {
      scriptProblems.push(`crash: exited ${signal ?? code} without a categorised failure`);
    }
    if (scriptRed === 0 && scriptProblems.length === 0) {
      scriptProblems.push('silent: the script reported neither RED nor SURVIVED nor any failure');
    }
    problems.push(...scriptProblems.map((p) => `${script} ${p}`));
  }

  const survivors = problems.filter((p) => p.includes('survivor:')).length;
  // A backstop, not a second opinion. Drift introduced between two scripts belongs to
  // neither, and nothing above would have seen it — but re-reporting the drift a script
  // already got blamed for makes one mistake look like two findings to go and chase.
  const drifted = await hashTree(root);
  if (drifted !== before && !sawDrift) {
    problems.push(`tree-drift: the sweep left the working tree at ${drifted}, expected ${before}`);
  }

  process.stdout.write(`RED: ${red}\n`);
  process.stdout.write(`SURVIVED: ${survivors}\n`);
  process.stdout.write(`problems: ${problems.length}\n`);
  process.stdout.write(`scripts:       ${scripts.length}\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);

  // A non-zero exit is what stops "problems: 3, exit 0" from ever being read as a pass
  // again. Every category above is a verdict that cannot be trusted.
  if (problems.length > 0) process.exitCode = 1;
}

// `pathToFileURL(path.resolve(...))`, the way `server/main.mjs` gates itself, and not a
// `file://${process.argv[1]}` template. On Windows `process.argv[1]` is a backslash path
// with a drive letter, so the template produced `file://D:\a\repo\...` against a real
// `import.meta.url` of `file:///D:/a/repo/...` — never equal, so `main()` never ran. The
// runner then exited 0 having printed nothing at all, and `--list` read as "no scripts"
// rather than as "this tool did not start". Silent, exit-zero, and wrong in the exact way
// this tool exists to rule out.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
