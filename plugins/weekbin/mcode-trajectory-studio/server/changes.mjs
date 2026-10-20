/**
 * What a session changed on disk, turn by turn.
 *
 * The runtime records a change set per turn in `local_runtime_turn_diffs`: the files
 * touched, whether each was added, modified or deleted, the line counts, and a full
 * unified diff. On the machine this was found on, 1,404 change sets across 351 of 633
 * sessions — 55% of the history, and more answerable questions than every other table
 * in the database combined for a coding session. The plugin read none of it: no tool
 * mentioned it, no panel drew it.
 *
 * What that costs is concrete. Asked "what did that session actually change", a
 * reader holding only `trajectory_get` has to page the transcript, read each write and
 * edit tool call's arguments, and infer the edit set — from argument text, which is
 * the shape the agent *intended*, not the shape the diff *recorded*. The runtime had
 * the answer in a column the whole time.
 *
 * Three things about the real rows drive the shape of what comes out, and each was
 * measured rather than assumed:
 *
 * 1. `file_changes_json` holds paths in two forms. Files inside the workspace are
 *    stored **relative** to it; files outside — every `/tmp` scratch script in these
 *    sessions — are stored **absolute**. On the machine this was written for, 3,299 of
 *    8,431 entries were relative and all 3,299 resolved inside their own workspace,
 *    while all 5,132 absolute ones sat outside it. A reader handed the stored string
 *    would have to know the workspace to make sense of half the rows, so relative
 *    paths are resolved against the turn's own `workspace_dir` here and always
 *    reported absolute.
 *
 * 2. More than half the entries are scratch. 4,883 of 8,431 files across this
 *    machine's sessions live under `/tmp` or the macOS per-user temp directory — the
 *    apply-scripts and brief files these runs generate before touching the repo. That
 *    is not noise to be filtered out; it is the truth about how the sessions worked.
 *    But a reader who opens this tool on a busy session and gets 82 files in one turn
 *    needs to be able to tell 6 of them from the other 76, so the split is reported
 *    per turn and per page rather than applied as a filter.
 *
 * 3. `status` is `active` on all 1,404 rows and `reverted_at_ms` is NULL on all of
 *    them. Both are carried through because a runtime that records a revert is a
 *    runtime this should answer for, but neither is presented as a finding: a reader
 *    who saw "active" on 1,404 rows in a row and no counterexample has learned nothing
 *    from the column. `undoable` is the one that carries real signal (1,234 of 1,404).
 */

import path from 'node:path';
import { tmpdir } from 'node:os';

import { LIMITS } from './config.mjs';
import { tableExists } from './sqlite.mjs';

/** The shape a session with nothing recorded, or a runtime that cannot tell. */
const unavailable = { turns: [], total: 0, available: false };

/**
 * The temporary roots a session's scratch work lands in.
 *
 * `os.tmpdir()` is the one that matters and it is **not** the same string on every
 * platform — an `AppData\Local\Temp` directory under the user profile on Windows, a per-user directory
 * under `/var/folders` on macOS, `/tmp` on most Linux. The first version of this file
 * hardcoded the two POSIX spellings, which meant that on a Windows machine every
 * scratch file was reported as repository work: `scratchFiles: 0` on a turn that was
 * nothing but. A silent wrong answer is worse than the field being absent, because the
 * count exists precisely so a reader does not mistake a busy scratch turn for a big
 * edit — and the only sign it was broken was that number reading zero everywhere.
 *
 * `/tmp` and `/var/folders` are kept alongside `os.tmpdir()` because the machine this
 * was measured on writes there regardless of what `os.tmpdir()` returns for the
 * process, and the POSIX roots are not interchangeable with it: `os.tmpdir()` on macOS
 * names one user's directory, while the sessions under measurement wrote to the shared
 * `/tmp` and to other users' `/var/folders` trees alike.
 */
const POSIX_TEMP_ROOTS = ['/tmp', '/var/folders'];

/** `\` to `/`, no trailing slash, so two spellings of one root compare equal. */
function normalizeRoot(value) {
  return String(value).replace(/\\/gu, '/').replace(/\/+$/u, '');
}

/**
 * A drive-letter root compares case-insensitively; a POSIX root does not.
 *
 * Windows paths are case-insensitive below the volume, and `os.tmpdir()` and a path
 * the runtime recorded are not guaranteed to spell the drive the same way.
 */
function sameCaseSpelling(root) {
  return !/^[a-z]:/iu.test(root);
}

/**
 * Whether `resolved` is inside `root` — or is `root` itself.
 *
 * **The volume is only dropped from a root that has none.** The POSIX supplement roots
 * are written without one (`/tmp`, `/var/folders`), and on Windows every path that names
 * one has been through `path.resolve`, which prepends the current drive: a recorded
 * `/tmp/run/apply.py` arrives as `D:\tmp\run\apply.py`. `'D:/tmp/run/apply.py'` does not
 * start with `'/tmp/'`, so nothing matched, every scratch file on a Windows machine was
 * reported as repository work, and `scratchFiles: 0` on a turn that was nothing but — the
 * exact silent wrong answer this module was written to stop.
 *
 * A drive-lettered root keeps its volume, and so must the path matched against it: a temp
 * directory on the `D:` volume is **not** the one named by a root on `C:`, even when the
 * rest of the directory names agree exactly. Stripping both sides to compare the bare
 * directory would call it a match, and that is a different machine's temp rather than this
 * one's scratch.
 *
 * @param {string} resolved Normalized-with-forward-slashes path.
 * @param {string} root Normalized-with-forward-slashes directory.
 */
function underRoot(resolved, root) {
  const volume = (value) => (value.match(/^[a-z]:(?=\/)/iu) || [''])[0];
  // A drive-relative root cannot name a volume, so the path's own is the only one there
  // is and dropping it compares the location. A root that names one is compared exactly.
  const dropVolume = volume(root) === '';
  const shape = (value) => (dropVolume ? value.slice(volume(value).length) : value);
  const fold = sameCaseSpelling(root) ? (value) => value : (value) => value.toLowerCase();
  const target = fold(shape(resolved));
  const base = fold(shape(root));
  return target === base || target.startsWith(`${base}/`);
}

/**
 * Whether a path is scratch: outside the session's own workspace and inside a
 * temporary directory.
 *
 * The workspace half is not decoration. Deciding this by the temp prefix alone looked
 * right on the machine this was measured on — all 5,132 absolute entries sat outside
 * their workspace, and 4,883 of 8,431 sat under a temp directory — but a checkout that
 * legitimately lives under `/tmp` (a CI sandbox, a container workspace, anything under
 * `TMPDIR`) would have every one of its files counted as scratch, and a count that
 * cannot distinguish the two is not a count. Every workspace-relative entry is inside
 * the workspace by construction, so this can never call one scratch.
 *
 * `tempRoot` is a parameter rather than a module constant so a test can hand in a
 * Windows root while running on macOS. That is the same trick `path-folding.test.mjs`
 * uses: the paths under test are data, not the host's.
 *
 * @param {string} resolved An absolute, normalized path.
 * @param {string} [workspaceDir] The turn's `workspace_dir`, if known.
 * @param {string} [tempRoot] The platform's temp directory; defaults to this process's.
 * @returns {boolean}
 */
export function isScratchPath(resolved, workspaceDir = null, tempRoot = tmpdir()) {
  if (typeof resolved !== 'string' || resolved === '') return false;
  if (typeof workspaceDir === 'string' && workspaceDir !== '') {
    const relative = path.relative(workspaceDir, resolved);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return false;
  }
  const normalized = normalizeRoot(resolved);
  if (underRoot(normalized, normalizeRoot(tempRoot))) return true;
  return POSIX_TEMP_ROOTS.some((root) => underRoot(normalized, root));
}

/**
 * One recorded change entry, with its path resolved to something a reader can open.
 *
 * @param {object} entry One element of `file_changes_json`.
 * @param {string} workspaceDir The turn's `workspace_dir`.
 * @param {number} [diffBytes] Per-file diff ceiling; omit to leave `diff` out.
 */
function projectFile(entry, workspaceDir, diffBytes) {
  const stored = typeof entry?.file === 'string' ? entry.file : '';
  // An entry with no usable `file` is still an entry. It is reported with a null path
  // rather than dropped, because a change set that records three files and can only
  // describe two is a finding, and silently dropping the third is how that would be
  // missed.
  const resolved = stored === ''
    ? null
    : path.resolve(workspaceDir, stored);
  const file = {
    path: resolved,
    // Carried through, not derived: whether the path came out of the workspace is a
    // property of what the runtime recorded, and re-deriving it later from the string
    // would lose the difference between "outside the workspace" and "in the temp dir".
    relativeToWorkspace: resolved === null ? null : stored !== '' && !path.isAbsolute(stored),
    // Decided here, on the real path, and not after redaction. Redaction folds `$HOME`
    // to `~`, and a folded path can no longer be tested against the temp prefixes —
    // the flag would have to be a guess, or the folding would have to be undone.
    scratch: resolved === null ? false : isScratchPath(resolved, workspaceDir),
    status: typeof entry?.status === 'string' ? entry.status : null,
    additions: Number.isFinite(entry?.additions) ? entry.additions : null,
    deletions: Number.isFinite(entry?.deletions) ? entry.deletions : null,
  };
  if (diffBytes === undefined) return file;
  const diff = typeof entry?.diff === 'string' ? entry.diff : '';
  const kept = diff.length > diffBytes ? diff.slice(0, diffBytes) : diff;
  file.diff = kept;
  // A diff cut mid-hunk is not a diff. The flag says so rather than letting a truncated
  // patch read as the complete change to that file.
  //
  // There is deliberately no byte count here. The redaction sweep rewrites these
  // strings on their way out — it masks credentials and folds `$HOME` — so any length
  // measured before it describes text the caller does not receive. The first version
  // of this shipped `diffBytes: 32768` beside a 20,026-character payload and was
  // wrong by 12,000. One honest flag beats a precise-looking number that cannot be.
  file.diffTruncated = kept.length < diff.length;
  return file;
}

/**
 * Whether a resolved path contains the reader's `needle`.
 *
 * Separators are normalized on both sides before the substring test. The needle is typed
 * by whoever asks, and the path is spelled by the host: a caller asking for
 * `src/app.js` on Windows was narrowing against `…\src\app.js`, so the filter matched
 * nothing and the reply reported `matchedFiles: 0` for a session that plainly had three
 * changes to that file. A filter that silently drops a query is the same defect as one
 * that silently ignores an argument.
 *
 * Normalizing both sides is symmetric — a backslash needle finds a forward-slash path,
 * and the reverse — so neither spelling is the privileged one.
 *
 * @param {string|null} resolved The entry's resolved path, before redaction folds it.
 * @param {string} needle The reader's substring.
 * @returns {boolean}
 */
function matchesPathNeedle(resolved, needle) {
  if (typeof resolved !== 'string') return false;
  return normalizeRoot(resolved).includes(normalizeRoot(needle));
}

/**
 * Page a session's per-turn file changes.
 *
 * @param {object} store An open store.
 * @param {string} sessionId Exact session ID.
 * @param {{offset?: number, limit?: number, path?: string, diffBytes?: number}} options
 *   `path` is a substring match against the **resolved** path, so a reader can narrow
 *   one directory or one extension out of a turn that touched eighty files.
 * @returns {{turns: object[], total: number, available: boolean, matchedFiles?: number,
 *   scratchFiles?: number}}
 */
/**
 * The turn ids the transcript can be found under, or `null` if they could not be read.
 *
 * `null` and an empty set are different answers and must not collapse. An empty set says
 * this session's messages carry no turn ids, which is a fact about the data — 34 of 616
 * sessions on the machine this was measured on. `null` says the question could not be
 * asked, in which case every row reports `turnInTranscript: null` and nothing counts as
 * unmatched. Reporting "0 unmatched" from a query that threw would turn a broken read
 * into a clean one.
 *
 * The normalisation matches the turn fold's: a row with no turn id, or an empty one, is
 * the same "no turn" group, so it is stored under the empty string rather than skipped.
 * Without that, a session whose transcript carries no turn ids would report every
 * unnamed change set in it as unmatched.
 */
function transcriptTurnIds(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_message_rows')) return null;
  try {
    const rows = store.db.prepare(`
      SELECT DISTINCT COALESCE(turn_id, '') AS tid
      FROM local_runtime_message_rows
      WHERE session_id = ?
    `).all(sessionId);
    return new Set(rows.map((row) => String(row.tid ?? '')));
  } catch (error) {
    store.warn(`turn_transcript_lookup_failed:${error.message}`);
    return null;
  }
}

export function listTurnChanges(store, sessionId, { offset = 0, limit = 200, path: pathFilter = null, diffBytes } = {}) {
  if (!store.db || !tableExists(store.db, 'local_runtime_turn_diffs')) return unavailable;
  const from = Math.max(0, Math.trunc(offset) || 0);
  const cap = Math.min(Math.max(1, Math.trunc(limit) || LIMITS.changes.default), LIMITS.changes.max);
  const needle = typeof pathFilter === 'string' && pathFilter !== '' ? pathFilter : null;
  try {
    const { total } = store.db.prepare(
      'SELECT COUNT(*) AS total FROM local_runtime_turn_diffs WHERE session_id = ?',
    ).get(sessionId) || {};
    const rows = store.db.prepare(`
      SELECT turn_id, workspace_dir, captured_at_ms, status, agent_name,
             file_changes_json, undoable, reverted_at_ms
      FROM local_runtime_turn_diffs
      WHERE session_id = ?
      ORDER BY captured_at_ms, turn_id
    `).all(sessionId);

    // Which turns the transcript can be found under, so each row can say whether paging
    // `trajectory_get` by its `turnId` will find anything.
    //
    // The two tables are written by the runtime independently and are not required to
    // agree on which turns exist. On the machine this was measured on, **307 of 1,417
    // change sets — 11.8% of every file entry — name a `turn_id` that appears in no
    // message row**, and on 7 of 351 sessions the change-set count is *larger* than the
    // number of turns the transcript has (worst case 165 against 2).
    //
    // Both counts were right and a reader cannot tell: they page the turn view to see
    // what `changedTurns` refers to and find fewer turns than the number they are
    // holding, with nothing on either reply to say the two were never comparable. The
    // file entries behind the unmatched change sets are real edits, so they are counted
    // and listed exactly as before — what changed is that the gap is now visible.
    const transcriptTurns = transcriptTurnIds(store, sessionId);

    // Paged after the filter rather than in SQL, because the filter is a substring
    // match on a path that only becomes a path once it is resolved against the turn's
    // own workspace. A session's change sets are a bounded list — the largest here is
    // 140 rows — so this reads them all and pages the survivors.
    let matchedFiles = 0;
    let scratchFiles = 0;
    let unmatchedTurns = 0;
    const turns = [];
    for (const row of rows) {
      const workspaceDir = typeof row.workspace_dir === 'string' ? row.workspace_dir : '';
      let entries;
      try {
        entries = JSON.parse(row.file_changes_json);
      } catch {
        entries = [];
      }
      if (!Array.isArray(entries)) entries = [];
      let files = entries.map((entry) => projectFile(entry, workspaceDir, diffBytes));
      if (needle) files = files.filter((file) => matchesPathNeedle(file.path, needle));
      if (files.length === 0) continue;
      matchedFiles += files.length;
      scratchFiles += files.filter((file) => file.scratch).length;
      // Whether `trajectory_get({turnId})` can find this turn's records.
      //
      // A change set with no `turn_id` is the "no turn" group, the same normalisation the
      // turn fold applies, so it is checked against that group rather than against
      // nothing — otherwise a session whose transcript carries no turn ids at all would
      // report every unnamed change set as unmatched.
      const key = row.turn_id ?? '';
      const inTranscript = transcriptTurns === null ? null : transcriptTurns.has(key);
      if (inTranscript === false) unmatchedTurns += 1;
      turns.push({
        turnId: row.turn_id ?? null,
        turnInTranscript: inTranscript,
        workspaceDir: workspaceDir || null,
        capturedAtMs: Number.isFinite(row.captured_at_ms) ? row.captured_at_ms : null,
        agentName: row.agent_name ?? null,
        status: typeof row.status === 'string' ? row.status : null,
        undoable: Number.isFinite(row.undoable) ? row.undoable !== 0 : null,
        revertedAtMs: Number.isFinite(row.reverted_at_ms) ? row.reverted_at_ms : null,
        fileCount: files.length,
        scratchFiles: files.filter((file) => file.scratch).length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        files,
      });
    }

    const page = turns.slice(from, from + cap);
    return {
      turns: page,
      // The session's change-set count, not the filtered one. `turns.length` after a
      // path filter is how many survived, and reporting that as the total would make a
      // narrowed search look like a session that only ever touched those files.
      total: Number.isFinite(total) ? total : turns.length,
      // How many turns the filter left, which is what paging has to be measured
      // against. Reporting `total` here would send the reader past the end on a
      // narrowed read that ended three rows in.
      matchedTurns: turns.length,
      available: true,
      // Both aggregates are **session-wide**, over everything the filter matched, not
      // page-scoped — they are accumulated while scanning, before the page is sliced.
      // That is the useful scope for "is this session mostly scratch work?", and the
      // per-page numbers are the ones already on each turn.
      //
      // They were named as if they were page-scoped, and the tool description said so
      // outright ("how many files the page covers"). On a 327-turn session a one-turn
      // page carries 7 files and 2 of them are scratch, while the reply said 3,048 and
      // 2,212 — a reader following the description computed 73% where the page was 29%.
      // The field was right and the scope it was documented with was wrong, which is
      // worse than a missing field: nothing on the page contradicts it.
      matchedFiles,
      matchedScratchFiles: scratchFiles,
      // How many of the change sets the filter matched name a turn the transcript does
      // not carry. Session-wide on the same terms as the two above, and `null` — not
      // `0` — when the transcript's own turn ids could not be read at all.
      //
      // This is what lets a reader see, from one reply, why `trajectory_summary`'s
      // `changedTurns` can be larger than the number of turns `trajectory_turns` lists.
      // It is reported beside `total` and never instead of it: those change sets are real
      // edits, and 11.8% of a real machine's file entries sit behind them.
      unmatchedTurns: transcriptTurns === null ? null : unmatchedTurns,
    };
  } catch (error) {
    store.warn(`turn_diff_list_failed:${error.message}`);
    return unavailable;
  }
}
