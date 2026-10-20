/**
 * What a session changed on disk was recorded the whole time and had no route out.
 *
 * The runtime writes a change set per turn into `local_runtime_turn_diffs` — the files
 * touched, whether each was added, modified or deleted, line counts, and a full unified
 * diff. Measured on the machine this was found on: 1,404 change sets across 351 of 633
 * sessions, 8,431 file entries, 1,234 of them undoable. No tool read the table, no panel
 * drew it, and the plugin's answer to "what did that run actually do" was a page of
 * `trajectory_get` whose rows carry what an agent *said* it did.
 *
 * These tests pin the parts that make the list usable rather than merely present, and
 * each one is a thing the real rows do that a tidy fixture would have got wrong.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, FIXTURE_WORKSPACE, dropProjectionTable, withProjectionDb } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { isScratchPath } from '../server/changes.mjs';
import { EGRESS_MAX_LENGTH_MCP, LIMITS } from '../server/config.mjs';

const NOW = 1_700_000_000_000;

/**
 * A change set shaped like the real ones: one workspace-relative repository file, one
 * absolute scratch file, and the line counts the runtime records.
 */
function changeSet({ file = 'src/app.js', scratch = '/tmp/run/apply.py', additions = 12, deletions = 3 } = {}) {
  return [
    { file, additions, deletions, status: 'modified', diff: `--- a/${file}\n+++ b/${file}\n@@\n-old\n+new\n` },
    { file: scratch, additions: 40, deletions: 0, status: 'added', diff: `--- /dev/null\n+++ b/${scratch}\n@@\n+print(1)\n` },
  ];
}

async function seeded(t, { dropTable = false, turns = 3 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.session({ id: 'sess-b', title: 'Beta', updatedAtMs: NOW - 10_000 });
  for (let i = 0; i < turns; i += 1) {
    projection.turnDiff({
      sessionId: 'sess-a',
      turnId: `turn-${i}`,
      workspaceDir: FIXTURE_WORKSPACE,
      capturedAtMs: NOW - 1000 + i * 100,
      files: changeSet({ additions: i + 1 }),
      undoable: 1,
    });
  }
  projection.close();
  if (dropTable) dropProjectionTable(dbPath, 'local_runtime_turn_diffs');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, dbPath, dataDir };
}

const call = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_changes', args);

/* ------------------------------------------------------------- the list -- */

test('the answer is which files, not only how many turns', async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a' });

  assert.equal(reply.available, true);
  assert.equal(reply.total, 3);
  assert.equal(reply.returned, 3);
  assert.equal(reply.turns.length, 3);
  const first = reply.turns[0];
  assert.equal(first.fileCount, 2);
  assert.deepEqual(first.files.map((file) => file.status), ['modified', 'added']);
  assert.equal(first.additions, 41);
  assert.equal(first.deletions, 3);
});

test('a file inside the workspace is reported at a path a reader can open', async (t) => {
  // The real table stores workspace files **relative** and out-of-workspace files
  // absolute. A reader handed the stored string would have to know the workspace to
  // make sense of three entries in four.
  //
  // `~/ws/...` rather than the fixture's own absolute prefix: the reply folds `$HOME`
  // to `~`, the same as `trajectory_assets` and every other path this plugin returns.
  // That is the privacy behaviour, and it is why the `scratch` flag is decided before
  // redaction rather than from the folded string.
  //
  // The tail is computed with `path.relative`, not by slicing a fixed length off a
  // `path.join`. On Windows `path.resolve` gives the workspace a volume
  // (`D:\tmp\trajectory-fixture-home\ws`) while `FIXTURE_HOME` is written without one,
  // so the two strings are not the same length apart and slicing produced a `~` path that
  // was missing its first segment — an expectation that described no directory.
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a', limit: 1 });
  const [repoFile, scratchFile] = reply.turns[0].files;

  assert.equal(repoFile.path, `~${path.sep}${path.relative(FIXTURE_HOME, path.join(FIXTURE_WORKSPACE, 'src/app.js'))}`);
  assert.equal(repoFile.relativeToWorkspace, true);
  // The scratch entry is recorded **absolute**, and absolute still goes through
  // `path.resolve`, which prepends the host's volume: on Windows the reply carries
  // `D:\tmp\run\apply.py` where the row said `/tmp/run/apply.py`. Written as a literal the
  // expectation named a file this platform cannot produce, and it failed on Windows for
  // stating a true thing about the wrong host. Resolved the same way the reply resolves it,
  // so the assertion is about the resolution and not about which volume the runner has.
  assert.equal(scratchFile.path, path.resolve(FIXTURE_WORKSPACE, '/tmp/run/apply.py'));
  assert.equal(scratchFile.relativeToWorkspace, false);
});

test('a workspace file is never scratch, and the test says whether its workspace is in a temp dir', async (t) => {
  // Deciding scratch by the temp prefix alone called every repository file scratch, and
  // the count that exists to separate the two became useless — a checkout under `/tmp`
  // (a CI sandbox, a container workspace, anything under `TMPDIR`) has all of its files
  // reported as scratch. So the workspace exclusion is the thing under test here.
  //
  // Whether the fixture's workspace is in a temp directory at all is a fact about the
  // platform, and it is **false on two of the three CI platforms**: `FIXTURE_WORKSPACE`
  // is the literal `/tmp/...`, which Node resolves against the current drive — `C:\tmp\…`
  // on Windows, which is not `os.tmpdir()`, and `/tmp/…` on macOS, which is not macOS's
  // `os.tmpdir()` either (that is a per-user `/var/folders` directory). The first
  // version of this test asserted `startsWith('/tmp/')`, passed on all three, and on the
  // two where the premise is false it passed for a reason that does not hold there. Ask
  // rather than assume, the way `fixtureHasFts5()` does.
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a', limit: 1 });

  // The claim that holds everywhere: a file inside the workspace is not scratch, and the
  // tool agrees.
  assert.equal(reply.turns[0].files[0].scratch, false);
  assert.equal(isScratchPath(path.join(FIXTURE_WORKSPACE, 'src/app.js'), FIXTURE_WORKSPACE), false);
  // The control: a scratch file outside it still is.
  assert.equal(reply.turns[0].files[1].scratch, true);
  assert.equal(isScratchPath('/tmp/run/apply.py', FIXTURE_WORKSPACE), true);
});

test('a workspace that really is inside the platform temp directory is still not scratch', async (t) => {
  // The shape the fixture's own workspace cannot express on two of three platforms, so it
  // is built here instead: a turn whose `workspace_dir` is under `os.tmpdir()` — a CI
  // sandbox, a container workspace, any checkout under `TMPDIR`. Asking the predicate
  // directly first proves the premise holds on this platform, so the test cannot quietly
  // become a tautology where it does not.
  const workspace = path.join(tmpdir(), 'sandbox-checkout', 'proj');
  const repoFile = path.join(workspace, 'src/app.js');
  const outside = path.join(tmpdir(), 'elsewhere', 'apply.py');

  assert.equal(isScratchPath(repoFile, null), true,
    `the premise: without a workspace, ${repoFile} must look scratch on this platform`);
  assert.equal(isScratchPath(repoFile, workspace), false,
    'and with its workspace, the same path must not');
  assert.equal(isScratchPath(outside, workspace), true,
    'the control: a temp file outside the workspace is still scratch');

  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-ws-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.turnDiff({
    sessionId: 'sess-a',
    turnId: 'turn-0',
    workspaceDir: workspace,
    files: [
      { file: 'src/app.js', additions: 3, deletions: 1, status: 'modified', diff: '--- a/src/app.js\n+++ b/src/app.js\n@@\n-a\n+b\n' },
      { file: outside, additions: 5, deletions: 0, status: 'added', diff: '--- /dev/null\n+++ b/x\n@@\n+x\n' },
    ],
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, { sessionId: 'sess-a' });
  assert.deepEqual(reply.turns[0].files.map((file) => file.scratch), [false, true],
    'the tool must agree with the predicate it is built on');
  assert.equal(reply.turns[0].scratchFiles, 1);
  assert.equal(reply.matchedScratchFiles, 1);
});

test('scratch is found on a Windows temp root, not only the two POSIX spellings', async (t) => {
  // The first version of this file hardcoded `/tmp` and `/var/folders`. On a Windows
  // machine — where the platform's temp is `C:\Users\<user>\AppData\Local\Temp` —
  // neither ever matches, so every scratch file was reported as repository work and
  // `scratchFiles` read zero on a turn that was nothing but. Silent, and invisible
  // precisely because the count exists to stop that misreading.
  //
  // The roots are passed in as data so this runs on macOS, the same way
  // `path-folding.test.mjs` tests Windows home paths. There is no way to make a
  // macOS process see a Windows temp directory — the honest move is to test the
  // predicate with the foreign root, not to pretend the host changed.
  const WIN_TEMP = 'C:\\Users\\Bob\\AppData\\Local\\Temp';
  const WIN_WORKSPACE = 'C:\\work\\proj';
  const winScratch = `${WIN_TEMP}\\run-7\\apply.py`;

  assert.equal(isScratchPath(winScratch, WIN_WORKSPACE, WIN_TEMP), true,
    'a Windows temp file must count as scratch');
  assert.equal(isScratchPath(`${WIN_TEMP}`, WIN_WORKSPACE, WIN_TEMP), true,
    'the temp directory itself counts');
  assert.equal(isScratchPath('C:\\work\\proj\\src\\app.js', WIN_WORKSPACE, WIN_TEMP), false,
    'a repository file on Windows is not scratch');
  // Case-insensitive below the drive letter, because Windows is.
  assert.equal(isScratchPath('c:\\users\\bob\\appdata\\local\\temp\\x', WIN_WORKSPACE, WIN_TEMP), true);
  // A trailing separator on the root is not a different root.
  assert.equal(isScratchPath(winScratch, WIN_WORKSPACE, `${WIN_TEMP}\\`), true);
  // And the workspace exclusion still wins on Windows, exactly as on POSIX.
  assert.equal(isScratchPath('C:\\work\\proj\\tmp\\a', WIN_WORKSPACE, WIN_TEMP), false);

  // The default root is this process's, so a caller that passes nothing still gets the
  // host's answer rather than a POSIX guess. Built from `os.tmpdir()` rather than
  // hardcoded: a literal here would pass for the wrong reason on this machine and for no
  // reason at all on another.
  assert.equal(isScratchPath(path.join(tmpdir(), 'run-7', 'apply.py'), null), true);
  assert.equal(isScratchPath(path.join(tmpdir()), null), true);
  // The POSIX supplements are still there for a session that wrote to the shared `/tmp`
  // rather than to this process's temp — which is what the machine this was measured on
  // did, and which `os.tmpdir()` on macOS does *not* name.
  assert.equal(isScratchPath('/tmp/run/apply.py', null, '/some/other/tmp'), true);
  assert.equal(isScratchPath('/var/folders/ab/T/thing', null, '/some/other/tmp'), true);
});

test('a POSIX temp root still matches once Windows has put a volume on the path', () => {
  // The gap the drive-lettered case above cannot reach. That one hands in a Windows temp
  // root *with* a drive, so both sides carry one and they compare. But the two POSIX
  // supplement roots are written without a volume, and on Windows every path that names
  // one has been through `path.resolve`, which prepends the current drive: the recorded
  // `/tmp/run/apply.py` arrives as `D:\tmp\run\apply.py`. `'D:/tmp/run/apply.py'` does
  // not start with `'/tmp/'`, so nothing matched — and `scratchFiles: 0` on a turn that
  // was nothing but is the exact silent wrong answer this predicate exists to prevent.
  //
  // This is the shape the fixture itself produces, which is why `scratchFiles` read 0 on
  // the Windows runner while reading 1 everywhere else.
  assert.equal(isScratchPath('D:\\tmp\\run\\apply.py', 'D:\\tmp\\trajectory-fixture-home\\ws', 'C:\\Users\\Bob\\AppData\\Local\\Temp'), true,
    'the shared /tmp is scratch on whichever volume the host resolved it against');
  assert.equal(isScratchPath('D:/tmp/run/apply.py', 'D:/tmp/ws', 'C:/Users/Bob/AppData/Local/Temp'), true,
    'and the same with the forward slashes a serialized path carries');
  // The volume is not a licence: a Windows temp root on a *different* volume is still a
  // temp root, and a repository file on C: is still not scratch.
  assert.equal(isScratchPath('C:\\tmp\\run\\apply.py', 'C:\\work\\proj', 'D:\\Users\\Bob\\AppData\\Local\\Temp'), true);
  assert.equal(isScratchPath('C:\\work\\proj\\src\\app.js', 'C:\\work\\proj', 'D:\\Users\\Bob\\AppData\\Local\\Temp'), false);
  // And stripping the volume must not turn a same-named directory on another drive into
  // a match against a root that does carry one — the drive-lettered root stays exact.
  assert.equal(isScratchPath('D:\\Users\\Bob\\AppData\\Local\\Temp\\x', 'C:\\work\\proj', 'C:\\Users\\Bob\\AppData\\Local\\Temp'), false,
    'a drive-lettered root is not matched by a different volume');
});

test('the path filter narrows on separators the reader did not have to know', async (t) => {
  // A reader narrowing to `src/app.js` on Windows was matching that needle against
  // `…\src\app.js`, so the filter silently matched nothing and the reply reported
  // `matchedFiles: 0` for a session with three changes to exactly that file. A filter
  // that drops a query is the same defect as an argument that is ignored.
  const { store } = await seeded(t);
  const forward = await call(store, { sessionId: 'sess-a', path: 'src/app.js' });
  const native = await call(store, { sessionId: 'sess-a', path: path.join('src', 'app.js') });
  const backslash = await call(store, { sessionId: 'sess-a', path: 'src\\app.js' });

  for (const [label, reply] of [['forward', forward], ['native', native], ['backslash', backslash]]) {
    assert.equal(reply.matchedFiles, 3, `${label} slash spelling must narrow to the same three turns`);
    assert.equal(reply.matchedScratchFiles, 0, `${label}: the scratch entry does not match src/app.js`);
    assert.equal(reply.total, 3, `${label}: total stays the session's own change-set count`);
  }
});

test('the path filter still matches on the substring, not only the whole path', async (t) => {
  // The separator normalisation above must not turn a substring match into a path-shape
  // match: `app.js` alone, and a fragment in the middle of a name, are both legal queries.
  const { store } = await seeded(t);
  for (const needle of ['app.js', '/ws/', 'src']) {
    const reply = await call(store, { sessionId: 'sess-a', path: needle });
    assert.equal(reply.matchedFiles, 3, `"${needle}" must still match as a substring`);
  }
});

test('scratch files are counted, not filtered', async (t) => {
  // The real entries are mostly temp-dir apply scripts. Hiding them would change what
  // happened; counting them is what lets a reader see that a 7-file turn was really 5
  // repository edits.
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a', limit: 1 });

  assert.equal(reply.turns[0].fileCount, 2);
  assert.equal(reply.turns[0].scratchFiles, 1);
});

test('the two scratch counts answer different questions and say so in their names', async (t) => {
  // The reply-level aggregates are accumulated while scanning every turn, before the page
  // is sliced, so they are **session-wide**. They were named and documented as if they
  // were the page's: a one-turn page out of 327 carried 7 files and 2 scratch, and the
  // reply said 3,048 and 2,212 — right numbers, wrong scope, and nothing on the page
  // contradicts them. A reader following the description computed 73% where the page was
  // 29%. The name now carries the scope so the description cannot drift from it again.
  const { store } = await seeded(t);
  const page = await call(store, { sessionId: 'sess-a', limit: 1 });

  assert.equal(page.turns.length, 1, 'the fixture must deliver exactly one turn here');
  assert.equal(page.turns[0].fileCount, 2, 'the turn carries its own page-shaped count');
  assert.equal(page.turns[0].scratchFiles, 1);
  // Three turns in the fixture, one scratch file each: session-wide, not this page's one.
  assert.equal(page.matchedScratchFiles, 3);
  assert.equal(page.matchedFiles, 6);
  // And a page holding one turn must never be able to look like it covers three.
  assert.notEqual(page.matchedFiles, page.turns[0].fileCount);

  const all = await call(store, { sessionId: 'sess-a' });
  assert.equal(all.matchedFiles, page.matchedFiles, 'the aggregate does not move with the page');
  assert.equal(all.turns.length, 3);
});

test('a narrowed read reports the whole matched set, so the narrowing stays visible', async (t) => {
  const { store } = await seeded(t);
  const narrowed = await call(store, { sessionId: 'sess-a', path: 'src/app.js' });
  assert.equal(narrowed.matchedFiles, 3, 'one repo file per turn, across all three turns');
  assert.equal(narrowed.matchedScratchFiles, 0);
  assert.equal(narrowed.total, 3, 'total stays the session own change-set count');
});

test('the per-file diff ceiling binds, and is tighter than the egress string limit', async (t) => {
  // The ceiling started at 32 KiB, which is *looser* than the 20,000-character egress
  // limit every reply passes through. It could therefore never be the bound that cut
  // anything: redaction truncated first, and the diff arrived cut under a flag the
  // sweep had nothing to do with. A limit looser than the limit above it is not a
  // limit.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-big-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  const huge = 'x'.repeat(LIMITS.changeDiffBytes + 500);
  projection.turnDiff({
    sessionId: 'sess-a',
    turnId: 'turn-0',
    workspaceDir: FIXTURE_WORKSPACE,
    files: [{ file: 'big.txt', additions: 1, deletions: 0, status: 'added', diff: huge }],
  });
  // The control turn, on the same reply: a diff under the ceiling must not claim a cut.
  projection.turnDiff({
    sessionId: 'sess-a',
    turnId: 'turn-1',
    workspaceDir: FIXTURE_WORKSPACE,
    capturedAtMs: NOW + 1,
    files: [{
      file: 'small.txt', additions: 1, deletions: 1, status: 'modified',
      diff: '--- a/small.txt\n+++ b/small.txt\n@@\n-old\n+new\n',
    }],
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.ok(LIMITS.changeDiffBytes < EGRESS_MAX_LENGTH_MCP,
    `the per-file ceiling (${LIMITS.changeDiffBytes}) must sit under the egress string limit (${EGRESS_MAX_LENGTH_MCP}) or it can never bind`);

  const reply = await call(store, { sessionId: 'sess-a', detailLevel: 'full' });
  const file = reply.turns[0].files[0];
  assert.equal(file.diffTruncated, true);
  assert.equal(file.diff.length, LIMITS.changeDiffBytes,
    'the delivered text must be this module\'s cut, not the sweep\'s');
  assert.ok(file.diff.length < huge.length);
  // The flag must not be reachable without a cut, or it is decoration that happens to
  // be right once. This one comes from the same reply, so a ceiling that was simply
  // always-true would fail here.
  assert.equal(reply.turns[1].files[0].diffTruncated, false);
});

test('the diff is available but is not the default answer', async (t) => {
  const { store } = await seeded(t);

  const summary = await call(store, { sessionId: 'sess-a', limit: 1 });
  assert.equal(summary.detailLevel, 'summary');
  assert.equal('diff' in summary.turns[0].files[0], false,
    'a summary page must not carry a diff key at all, not an empty one');

  const full = await call(store, { sessionId: 'sess-a', limit: 1, detailLevel: 'full' });
  assert.equal(full.detailLevel, 'full');
  assert.match(full.turns[0].files[0].diff, /^--- a\/src\/app\.js/mu);
  assert.equal(full.turns[0].files[0].diffTruncated, false);
});

/* --------------------------------------------------------------- paging -- */

test('the cursor walks the change sets in the order they were captured', async (t) => {
  const { store } = await seeded(t);
  const seen = [];
  let offset = 0;
  for (;;) {
    const page = await call(store, { sessionId: 'sess-a', offset, limit: 2 });
    seen.push(...page.turns.map((turn) => turn.turnId));
    if (page.nextOffset === null) break;
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, ['turn-0', 'turn-1', 'turn-2']);
});

/* ------------------------------------------------------------- narrowing -- */

test('a path filter narrows to the resolved path and says so when it matches nothing', async (t) => {
  const { store } = await seeded(t);

  const narrowed = await call(store, { sessionId: 'sess-a', path: 'src/app.js' });
  assert.equal(narrowed.returned, 3);
  assert.equal(narrowed.total, 3, 'total stays the session own count, so the narrowing is visible');
  assert.ok(narrowed.turns.every((turn) => turn.fileCount === 1));

  const miss = await call(store, { sessionId: 'sess-a', path: 'zzz-no-such-path' });
  assert.equal(miss.returned, 0);
  assert.equal(miss.total, 3);
  assert.equal(miss.pathMatchedNothing, true);
  assert.equal(miss.nextOffset, null);
});

test('a narrowed read pages against what survived, not against the whole session', async (t) => {
  // Paging a filter by the unfiltered total hands back a cursor that walks past the end
  // of a three-row answer.
  const { store } = await seeded(t);
  const first = await call(store, { sessionId: 'sess-a', path: 'src/app.js', limit: 2 });
  assert.equal(first.nextOffset, 2);
  const last = await call(store, { sessionId: 'sess-a', path: 'src/app.js', offset: first.nextOffset, limit: 2 });
  assert.equal(last.returned, 1);
  assert.equal(last.nextOffset, null, 'three surviving rows must not offer a fourth');
});

/* --------------------------------------------------------- what is absent -- */

test('a runtime without the table says so rather than reading as "nothing changed"', async (t) => {
  const { store } = await seeded(t, { dropTable: true });
  const reply = await call(store, { sessionId: 'sess-a' });

  assert.equal(reply.available, false);
  assert.deepEqual(reply.turns, []);
  assert.match(reply.note, /local_runtime_turn_diffs/u);
  assert.match(reply.note, /not recorded/u);
});

test('a table this runtime never had is not reported as a failure', async (t) => {
  // The two ways to answer "unavailable" — the table is not there, and the query threw
  // — are indistinguishable in the reply, and that is fine: the reader needs to know it
  // cannot be answered, not why. They are *not* interchangeable in the warning log,
  // where one means "this runtime does not have the table" and the other means
  // "something went wrong reading it". Probing with `tableExists` first is what keeps
  // every call on an older runtime from warning about a database that is fine.
  //
  // Found by mutation tier H: dropping the probe left every assertion here passing,
  // because the query's own catch returns the same shape. The reply could not tell them
  // apart, so the log had to be the place the difference is pinned.
  const { store } = await seeded(t, { dropTable: true });
  await call(store, { sessionId: 'sess-a' });
  assert.deepEqual(store.warnings.filter((warning) => String(warning).includes('turn_diff')),
    [], 'a missing table must not be logged as a failed read');

  // The control: a query that really fails is logged. Without this the assertion above
  // would also pass on a build that never warns at all.
  const failing = await seeded(t);
  const real = failing.store.db.prepare.bind(failing.store.db);
  failing.store.db.prepare = (sql) => {
    if (String(sql).includes('local_runtime_turn_diffs')) throw new Error('probe blew up');
    return real(sql);
  };
  await call(failing.store, { sessionId: 'sess-a' });
  assert.ok(failing.store.warnings.some((warning) => String(warning).includes('turn_diff_list_failed')),
    'a read that actually failed must say so');
});

test('a session that changed nothing and a session with no records read the same way', async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-b' });
  assert.equal(reply.available, true);
  assert.deepEqual(reply.turns, []);
  assert.equal(reply.total, 0);
});

/* ------------------------------------------------------------- redaction -- */

test('a diff is swept, so a secret written into a changed file does not travel out', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-secret-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.turnDiff({
    sessionId: 'sess-a',
    turnId: 'turn-0',
    workspaceDir: FIXTURE_WORKSPACE,
    files: [{
      file: '.env',
      additions: 1,
      deletions: 0,
      status: 'added',
      // The exact shape the egress contract caught escaping from `trajectory_agent`:
      // the field is free text written by whoever produced the row.
      diff: '--- /dev/null\n+++ b/.env\n@@\n+API_KEY=sk-live-0123456789abcdef\n',
    }],
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_changes', { sessionId: 'sess-a', detailLevel: 'full' });
  const diff = reply.turns[0].files[0].diff;
  assert.ok(!diff.includes('sk-live-0123456789abcdef'), `the secret left the store: ${diff}`);
});

/* ------------------------- the summary carries the disambiguating fact -- */

test('the summary separates files delivered from turns that recorded edits', async (t) => {
  // `assets: 0` was the summary's only file number, and on a machine where 329 of the 351
  // sessions carrying change records delivered nothing, that made the most natural reading
  // of the first tool wrong by dozens of files. `changedTurns` sits beside it so the two
  // facts cannot be collapsed into one.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-summary-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  for (let i = 0; i < 3; i += 1) {
    projection.turnDiff({
      sessionId: 'sess-a',
      turnId: `turn-${i}`,
      workspaceDir: FIXTURE_WORKSPACE,
      capturedAtMs: NOW + i,
      files: [{ file: `src/${i}.js`, additions: 1, deletions: 0, status: 'modified', diff: 'x' }],
    });
  }
  projection.close();
  const store = openStore({ dataDir });
  // One hook, and it closes the *second* store as well. node:test runs `after` hooks in
  // registration order, so the `degradedStore.close()` registered further down runs
  // **after** this one has already tried to remove the directory — and on Windows it
  // cannot, because that store still has the file open. Registering the close later was
  // the bug; it reads as tidier and is the opposite.
  const extra = [];
  t.after(async () => {
    for (const handle of extra) handle.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(reply.changedTurns, 3);
  assert.equal(reply.changesAvailable, true);
  assert.equal(reply.assets, 0, 'the control: nothing was delivered');
  assert.deepEqual(reply.warnings, []);
  assert.notEqual(reply.changedTurns, reply.assets,
    'the two numbers must not be the same field wearing two names');

  store.close();
  // The table is dropped **before** the next store is opened, not underneath a live one:
  // `getStats` caches on the session's message and change-set signatures, and a table
  // that vanishes without either moving is served from that cache. The first version of
  // this test dropped it in place, saw `changedTurns: 3, changesAvailable: true` come
  // back unchanged, and looked like a broken capability probe — when the cache was
  // behaving correctly and the probe was not asking the store anything.
  dropProjectionTable(dbPath, 'local_runtime_turn_diffs');
  const degradedStore = openStore({ dataDir });
  extra.push(degradedStore);
  const degraded = await createHandler({ store: degradedStore, homeDir: FIXTURE_HOME, redactRoots: [] })
    .call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(degraded.changedTurns, 0);
  assert.equal(degraded.changesAvailable, false, 'a missing table is not a count of zero');
  assert.ok(degraded.warnings.some((warning) => String(warning).includes('turn_diffs')),
    `the warning must name the table: ${JSON.stringify(degraded.warnings)}`);
});

test('a change set landing after the summary is not served from cache', async (t) => {
  // A change set is written *after* the message rows of its own turn. Measured on a
  // machine with 351 such sessions: **320 of them (91%)** have their last change set
  // written after their last message row, median lag 422 ms. So the moment someone is
  // most likely to ask what a session just did is exactly the moment a summary computed
  // a moment earlier said "changed nothing" — and with only the message signature in
  // the cache key, it kept saying so for as long as the process lived.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-cache-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-a',
    msgId: 'm1',
    role: 'user',
    turnId: 'turn-0',
    createdAtMs: NOW,
    data: { role: 'user', content: 'go' },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });
  const before = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(before.changedTurns, 0);
  assert.equal(before.changesAvailable, true);

  // The runtime finalises the turn's change set now. No message row is written, so the
  // message signature does not move. Written through a **separate writable connection**
  // because the store opens the projection read-only by design — which is also what makes
  // this a faithful reproduction: the runtime writes, the plugin reads.
  withProjectionDb(dbPath, (db) => db.prepare(`
    INSERT INTO local_runtime_turn_diffs
      (change_set_id, session_id, turn_id, workspace_dir, captured_at_ms, status,
       file_changes_json, raw_diff, reverted_at_ms, agent_name, undo_json, undoable, updated_at_ms)
    VALUES ('cs1', 'sess-a', 'turn-0', ?, ?, 'active', ?, NULL, NULL, NULL, '[]', 1, ?)
  `).run(FIXTURE_WORKSPACE, NOW + 5000, JSON.stringify([{ file: 'a.js', additions: 1, deletions: 0, status: 'added', diff: 'x' }]), NOW + 5000));

  const after = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  assert.equal(after.changedTurns, 1,
    'the cached summary must not survive the change set it could not have seen');
});

/* ------------------- the two turn counts must be reconcilable -- */

/**
 * A session whose change sets name turns the transcript never recorded.
 *
 * This is the real shape, not a tidy one: the runtime writes a change set per turn and
 * the two tables do not have to agree on which turns exist. Measured on the machine this
 * was found on — 307 of 1,417 change sets (11.8% of all file entries) name a `turn_id`
 * that appears in no message row, and on **7 sessions `changedTurns` is strictly larger
 * than `trajectory_turns`'s `total`**, worst case 165 against 2.
 *
 * Both numbers were correct. Each counts turns, and neither is a subset of the other,
 * so a reader who pages `trajectory_turns` to see what a session's `changedTurns` refers
 * to finds fewer turns than the number they are holding — with nothing on either reply
 * to say the two were never comparable.
 */
async function orphanedTurns(t, { messageTurns = 2, changeSets = 6, matched = 1 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'changes-orphan-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  for (let i = 0; i < messageTurns; i += 1) {
    projection.row({
      sessionId: 'sess-a',
      msgId: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      turnId: `turn-${i}`,
      createdAtMs: NOW + i,
      data: { role: 'user', content: 'go' },
    });
  }
  for (let i = 0; i < changeSets; i += 1) {
    projection.turnDiff({
      sessionId: 'sess-a',
      // The first `matched` change sets name turns the transcript has; the rest name
      // turns it does not, which is the shape that made the two counts disagree.
      turnId: i < matched ? `turn-${i}` : `ghost-${i}`,
      workspaceDir: FIXTURE_WORKSPACE,
      capturedAtMs: NOW + i,
      files: [{ file: `src/${i}.js`, additions: 1, deletions: 0, status: 'modified', diff: 'x' }],
    });
  }
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

test('a change set naming a turn the transcript lacks is reported as unmatchable', async (t) => {
  const store = await orphanedTurns(t, { messageTurns: 2, changeSets: 6, matched: 1 });
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });

  const changes = await handler.call('trajectory_changes', { sessionId: 'sess-a' });
  assert.equal(changes.total, 6, 'the control: every change set is a real row');
  assert.equal(changes.matchedFiles, 6, 'and none of them are filtered away');

  // The count of change sets whose turn the transcript can be found under. It is
  // reported next to the total, never instead of it: the file entries behind the
  // unmatched change sets are real edits, and dropping them from the list would hide
  // 11.8% of a real machine's file changes.
  assert.equal(changes.unmatchedTurns, 5,
    '5 of the 6 change sets name a turn no message row carries');
  assert.equal(changes.total - changes.unmatchedTurns, 1);

  // Per row, so a reader who pages the list can tell which turn is not in the transcript
  // without holding both tools' answers side by side.
  const ghosts = changes.turns.filter((turn) => turn.turnId.startsWith('ghost-'));
  assert.equal(ghosts.length, 5);
  for (const ghost of ghosts) {
    assert.equal(ghost.turnInTranscript, false,
      `${ghost.turnId} names a turn the transcript does not carry`);
  }
  assert.equal(changes.turns.find((turn) => turn.turnId === 'turn-0').turnInTranscript, true);
});

test('the summary does not claim to out-count the transcript', async (t) => {
  // The defect a reader actually hits: `trajectory_summary` says `changedTurns: 6`, the
  // turn view says the session has 2 turns, and neither reply carries anything that
  // reconciles them. On the real machine 7 sessions look like this, the largest 165
  // change sets against 2 turns.
  const store = await orphanedTurns(t, { messageTurns: 2, changeSets: 6, matched: 1 });
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });

  const summary = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  const turns = await handler.call('trajectory_turns', { sessionId: 'sess-a' });

  assert.equal(summary.changedTurns, 6, 'the control: the change sets are all counted');
  assert.equal(turns.total, 2, 'the control: the transcript carries two turns');
  assert.ok(summary.changedTurns > turns.total, 'the control: the two really do disagree');

  // The fix is not to shrink `changedTurns` — that would report 1 and hide five real
  // change sets. It is to publish, next to it, how many of those change sets name a turn
  // the transcript does not carry, so the disagreement is visible from the one tool the
  // Skill tells a reader to call first.
  assert.equal(summary.unmatchedTurns, 5);
  assert.equal(summary.changesAvailable, true,
    'both numbers were computed, so neither is a degraded reading');
  assert.equal(summary.changedTurns - summary.unmatchedTurns, 1,
    'the remainder is what a reader can actually page trajectory_turns for');

  // Deliberately **not** a `warnings` entry. A warning in this reply means an aggregate
  // could not be computed, so its `0` is not a finding — and both of these numbers were
  // computed from real rows. Filing a caveat here would tell a reader that
  // `changedTurns` is unreliable when the only unreliability is that they measured it
  // against the wrong denominator. The first version of this fix put it in `warnings`
  // and turned an existing test red: a session with three change sets and no message
  // rows at all, which is a fact, came back reporting itself degraded.
  assert.deepEqual(summary.warnings, [],
    'a口径 difference between two correct counts is not a degraded reading');
});

test('a session whose change sets all match says nothing about orphans', async (t) => {
  // The control for the control. A warning that appears whenever an orphan check runs
  // is decoration; it has to be reachable only when there is something to say, or every
  // summary on the machine learns to ignore it.
  const store = await orphanedTurns(t, { messageTurns: 2, changeSets: 2, matched: 2 });
  const handler = createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] });

  const summary = await handler.call('trajectory_summary', { sessionId: 'sess-a' });
  const changes = await handler.call('trajectory_changes', { sessionId: 'sess-a' });

  assert.equal(changes.unmatchedTurns, 0);
  assert.equal(changes.total, changes.total - changes.unmatchedTurns);
  assert.ok(changes.turns.every((turn) => turn.turnInTranscript === true));
  assert.deepEqual(summary.warnings, [],
    'nothing degraded, so the summary must be silent');
  assert.equal(summary.changedTurns, 2);
});

test('the summary does not carry a file count it cannot afford', () => {
  // The file total needs `SUM(json_array_length(file_changes_json))`: 206 ms on the
  // busiest session measured here (328 change sets) against 0.03 ms for the row count,
  // and 965 ms to parse the same JSON in the process. This is the tool the Skill tells a
  // reader to call first, and `trajectory_changes` already returns the number as
  // `matchedFiles`. An assertion so the next person does not "helpfully" add it back.
  // Comments are stripped first: this file's own doc for `changeAggregate` quotes
  // `json_array_length` while explaining why the summary does **not** use it, and a
  // scanner that reads its own prose trips over the explanation.
  const source = readFileSync(new URL('../server/stats.mjs', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  assert.doesNotMatch(code, /json_array_length/u,
    'a per-file count in the first tool costs 200 ms+ on a long session');
  assert.doesNotMatch(code, /file_changes_json/u,
    'the summary must not parse change-set JSON to answer a row count');
  // And the cheap query it should be using is the one a row count needs. Matched on the
  // aggregate, not the whole statement: `changeAggregate` now also counts change sets
  // whose turn the transcript lacks, and pinning the full SQL text made this guard fail
  // on an unrelated, equally correct rewrite of the same count.
  assert.match(code, /COUNT\(\*\) AS total/);
  assert.match(code, /local_runtime_turn_diffs/);
  // The matching lookup must not join the transcript's *rows*. A correlated `EXISTS`
  // against the turn-id index is one probe per change set; a join carries every message
  // payload of the session through the sorter to produce the same number.
  assert.match(code, /EXISTS\s*\(\s*SELECT 1 FROM local_runtime_message_rows/);
  assert.doesNotMatch(code, /local_runtime_message_rows[^)]*JOIN/iu,
    'the orphan count must not be a join over every message row of the session');
  // The lookup must stay index-usable. Wrapping either side of the comparison in a
  // function — `COALESCE(m.turn_id, '') = COALESCE(d.turn_id, '')` reads the same and
  // normalises identically — costs **287 ms on the busiest session here (330 change
  // sets) against 0.20 ms**, because the planner cannot use
  // `(session_id, turn_id, role, id)` through a function call on its argument. That is
  // the same 200 ms class this aggregate was first written to avoid, so the guard is
  // pinned rather than left to a comment. `IS` is the NULL-safe comparison in SQLite and
  // matches exactly what `COALESCE` would have matched.
  assert.match(code, /m\.turn_id IS d\.turn_id/u,
    'the turn comparison must be `IS` so the turn-id index can be used');
  assert.doesNotMatch(code, /COALESCE\(\s*(?:m|d)\.turn_id/,
    'wrapping turn_id in COALESCE here disables the index this lookup depends on');
});

test('the changes lookup reads the transcript once, not once per change set', () => {
  // The other half of the same trap, in `changes.mjs`. Its `COALESCE` is on the `DISTINCT`
  // projection rather than a comparison, so it costs nothing — `DISTINCT` scans the rows
  // either way and the runtime's `(session_id, turn_id, role, id)` index covers the filter.
  // Measured here: 0.01 ms to 3.06 ms across sessions of 1 to 23,537 message rows.
  //
  // What would not be affordable is re-asking per row. The largest session on the machine
  // this was measured on carries 330 change sets, and a per-row query against a 23,537-row
  // transcript is the shape that made the summary cost 287 ms one field over.
  const source = readFileSync(new URL('../server/changes.mjs', import.meta.url), 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  // Both references must live inside `transcriptTurnIds` — the capability probe and the
  // query itself. Counting them outright would also be right today and wrong the first
  // time the function grows a second statement, which is the wrong reason for a test to
  // go red.
  const fnStart = code.indexOf('function transcriptTurnIds');
  assert.ok(fnStart > 0, 'the lookup must be its own named function, not inline in the loop');
  const body = code.slice(fnStart, code.indexOf('\n}', fnStart));
  assert.match(body, /tableExists\(store\.db, 'local_runtime_message_rows'\)/,
    'the capability probe belongs with the query it guards');
  assert.match(body, /FROM local_runtime_message_rows/);
  const outside = code.slice(0, fnStart) + code.slice(fnStart + body.length);
  assert.doesNotMatch(outside, /FROM local_runtime_message_rows/u,
    'no other statement in this module may read the transcript');
  // Called once per reply, and not from inside the per-row loop. Matched with the
  // leading `=`, which is the assignment at the call site: the bare `function` line is
  // the definition, and counting that as a call is the wrong reason for a test to go red.
  const calls = code.match(/=\s*transcriptTurnIds\(store, sessionId\)/gu) ?? [];
  assert.equal(calls.length, 1,
    `the lookup must be hoisted out of the row loop, found ${calls.length} call sites`);
});
