import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { compatibilityProblems } from '../tools/compat-matrix.mjs';

const PLUGIN = path.join(import.meta.dirname, '..');

/**
 * The rule the compatibility tool enforces, tested without running a suite.
 *
 * The failure this pins is real and was caught by CI rather than here. The engines job
 * on Node 22.13.0 — a runtime whose bundled SQLite has no FTS5 — failed with
 *
 *   - 7 test(s) failed on a supported release
 *   - expected 1 skip(s) with FTS5 absent, saw 33
 *
 * The first line was seven tests whose premises assumed FTS5 was present; the second was
 * the tool's own expectation, and it was the part that was wrong. "Exactly one skip" was
 * true while exactly one test in the suite depended on FTS5. Every search case added
 * since then made the number stale, and a *count* of permitted skips cannot be kept true
 * except by never adding a test.
 *
 * The rule that carries the meaning is stated in terms of reasons rather than totals:
 * with FTS5 present nothing may be skipped at all, and with it absent every skip has to
 * name FTS5. A suite may grow any number of FTS5-dependent tests and this still holds.
 */

/** A suite result, with only the fields the judgement reads. */
const run = ({ fail = 0, tests = 700, skipped = [] } = {}) => ({
  fail,
  tests,
  skippedCount: skipped.length,
  skipped,
  failed: [],
  output: '',
});

/** A skip whose reason names FTS5, which is what every permitted one must look like. */
const ftsSkip = (name) => ({ name, reason: 'this runtime has no FTS5' });

test('a runtime with FTS5 may not skip anything', () => {
  assert.deepEqual(
    compatibilityProblems({ node: '22.23.2', fts5: true, verified: true, suite: run() }),
    [],
    'a clean run on a runtime with FTS5 is the baseline and must stay silent',
  );
  const problems = compatibilityProblems({
    node: '22.23.2', fts5: true, verified: true, suite: run({ skipped: [ftsSkip('a search test')] }),
  });
  assert.equal(problems.length, 1, `expected the skip to be reported, got ${JSON.stringify(problems)}`);
  assert.match(problems[0], /even though FTS5 is present/u);
});

test('the 33-skip run CI reported is not a failure', () => {
  // The exact shape of the run that failed. Every one of those skips named FTS5, which
  // is the whole condition; the total was incidental and is allowed to grow.
  const skipped = Array.from({ length: 33 }, (_, i) => ftsSkip(`an FTS5-dependent search case ${i}`));
  assert.deepEqual(
    compatibilityProblems({ node: '22.13.0', fts5: false, verified: false, suite: run({ skipped }) }),
    [],
    'a runtime without FTS5, whose every skip is an FTS5 skip, is consistent',
  );
});

test('a runtime with no FTS5 that skipped nothing is not a clean run', () => {
  // The converse, and the one that would otherwise read as a pass: zero skips on a
  // runtime without FTS5 means the degraded path is exercised nowhere here.
  const problems = compatibilityProblems({
    node: '22.13.0', fts5: false, verified: false, suite: run(),
  });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /no test was skipped/u);
});

test('a skip for any other reason is named', () => {
  const problems = compatibilityProblems({
    node: '22.13.0',
    fts5: false,
    verified: false,
    suite: run({ skipped: [{ name: 'the git probe needs a remote', reason: 'no origin configured' }] }),
  });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  // Named, because "a skip happened for a reason nobody checked" is the finding.
  assert.match(problems[0], /the git probe needs a remote/u);
  assert.match(problems[0], /unrelated to FTS5/u);
});

test('a failing suite fails this judgement whatever FTS5 says', () => {
  for (const fts5 of [true, false]) {
    const problems = compatibilityProblems({
      node: '22.13.0', fts5, verified: false, suite: run({ fail: 7, skipped: [ftsSkip('x')] }),
    });
    assert.ok(problems.some((p) => /7 test\(s\) failed/u.test(p)), `fts5=${fts5}: ${JSON.stringify(problems)}`);
  }
});

test('a runtime inside the verified range without FTS5 indicts the range', () => {
  // Node 22.23.2 inside `>=22.19 <23` with no FTS5 means the manifests claim something
  // the runtime cannot do. Saying so is the point of this tool rather than a nuisance.
  const problems = compatibilityProblems({
    node: '22.23.2', fts5: false, verified: true, suite: run({ skipped: [ftsSkip('x')] }),
  });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /inside the verified range/u);
});

test('no TAP summary at all is a finding, not a pass', () => {
  // `tests: null` is what a crashed or unparseable run looks like. Counting it as zero
  // skips and zero failures is how "nothing was verified" reads as "everything passed".
  const problems = compatibilityProblems({
    node: '22.13.0', fts5: false, verified: false, suite: run({ tests: null, skipped: [ftsSkip('x')] }),
  });
  assert.ok(problems.some((p) => /no TAP summary/u.test(p)), JSON.stringify(problems));
});

/* ------------------------------------------------- the entry guard -- */

/**
 * The three tools that must run when executed and only then.
 *
 * Each ends with a guard so importing it is safe — `compatibilityProblems` and
 * `classify` are exported for their contracts to be tested, and a bare `main()` at the
 * bottom would answer an import by running the whole suite.
 */
const GUARDED = ['tools/compat-matrix.mjs', 'tools/mutation-sweep.mjs', 'server/main.mjs'];

test('every guarded tool builds its entry URL from pathToFileURL, not a template', () => {
  // The defect CI found, and it is invisible on the platform that wrote it: a
  // `file://${process.argv[1]}` template compares true on POSIX, where `argv[1]` already
  // *is* a URL, and false on Windows, where it is a backslash path with a drive letter.
  // So the guard was permanently false there, `main()` never ran, and the tool exited 0
  // having printed nothing: `node tools/mutation-sweep.mjs --list` listed no scripts and
  // exited clean, which is the exact shape of "there is nothing to sweep".
  //
  // Asserting the rule rather than one host's behaviour is the point. The old spelling
  // passes every test on macOS — this one included — so only the source can catch it.
  for (const rel of GUARDED) {
    const source = readFileSync(path.join(PLUGIN, rel), 'utf8');
    const guard = source.match(/if \(process\.argv\[1\][\s\S]{0,120}?import\.meta\.url\)/u);
    assert.ok(guard, `${rel} has no entry guard`);
    assert.ok(
      /pathToFileURL\(/u.test(guard[0]),
      `${rel} builds its entry URL by string template, which is false on Windows:\n${guard[0]}`,
    );
  }
});

test('the guard spelling is the one Windows agrees with, checked without running Windows', () => {
  // The template and the canonical form are compared for a POSIX path and for a Windows
  // one. `import.meta.url` is canonical by construction, so "would the guard fire" is
  // answerable on any host by asking whether the two expressions agree for that path.
  //
  // **Both samples are spelled for their platform explicitly**, and so is the conversion.
  //
  // The first version derived the POSIX sample from the host, so on Windows it built
  // `\srv\repo\…` — a Windows path wearing the label POSIX — and the assertion "on POSIX
  // the two spellings agree" failed on the platform with the most to lose from the bug.
  // Switching `resolve` to `path.posix` fixed half of it and the CI failure survived,
  // because **`pathToFileURL` is host-dependent too**: given `/srv/…` on Windows it reads
  // the leading separator as drive-relative and produces `file:///D:/srv/…`. Resolving for
  // one platform and converting for another is not a platform, it is two of them.
  //
  // So the platform is a single value threaded through both steps — `path.win32` or
  // `path.posix` for the path, `{ windows }` for the URL. The option exists since Node
  // 22.1.0 and this plugin's floor is 22.13.0, so the test is not asking for anything the
  // engines job does not already run.
  //
  // The samples are absolute, because `argv[1]` always is and a relative one would be
  // resolved against the cwd and prove nothing about the spelling.
  const forPlatform = (isWindows) => ({
    resolve: (value) => (isWindows ? path.win32 : path.posix).resolve(value),
    href: (value) => pathToFileURL((isWindows ? path.win32 : path.posix).resolve(value), { windows: isWindows }).href,
  });
  const agrees = (argv1, isWindows) => forPlatform(isWindows).href(argv1) === `file://${argv1}`;

  const POSIX_SAMPLE = '/srv/repo/tools/mutation-sweep.mjs';
  const WIN_SAMPLE = 'D:\\a\\repo\\tools\\mutation-sweep.mjs';

  assert.equal(agrees(POSIX_SAMPLE, false), true,
    'POSIX: both spellings agree, which is why this passed for so long');
  assert.equal(agrees(WIN_SAMPLE, true), false,
    'Windows: the template cannot equal a canonical file URL — this is the CI failure');

  // The form the fix uses produces a **canonical** file URL for both — three slashes, the
  // drive spelled `/D:` — which is the shape `import.meta.url` actually has, and therefore
  // the only one a guard comparing against it can ever be equal to. The first version of
  // this compared the expression with itself, which is true for any input including a
  // broken one and so asserted nothing at all.
  for (const [label, sample, isWindows] of [
    ['POSIX', POSIX_SAMPLE, false],
    ['Windows', WIN_SAMPLE, true],
  ]) {
    const href = forPlatform(isWindows).href(sample);
    assert.ok(href.startsWith('file:///'), `${label}: ${href} is not a canonical file URL`);
    assert.equal(href, pathToFileURL(sample, { windows: isWindows }).href,
      `${label}: resolve must not change a canonical URL`);
  }
});
