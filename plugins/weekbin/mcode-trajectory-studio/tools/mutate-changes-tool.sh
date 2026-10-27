#!/usr/bin/env bash
# Mutation check for `trajectory_changes` — the table nobody was reading.
#
# The gap: the runtime records a change set per turn in `local_runtime_turn_diffs`, and
# on the machine this was found on that was 1,404 change sets across 351 of 633
# sessions, 8,431 file entries with full unified diffs. No tool read the table, no panel
# drew it, and `grep -rn "turn_diff\|file_changes\|undoable" server/ web/ skills/` came
# back with nothing at all. Asked what a session changed on disk, the plugin's answer
# was a page of `trajectory_get` — what an agent *said* it did.
#
# The tiers below are the ways this new tool can decay back into a decoration: answering
# the count instead of the list, resolving no paths, reporting scratch as if it were
# repository work, cutting a diff without saying so, and reading "nothing changed" for a
# runtime that cannot tell. Each of those is a shape a careless reader of the code would
# call finished.
set -uo pipefail
cd "$(dirname "$0")/.."

# `shasum` ships with Perl, and Linux coreutils ships `sha1sum` instead. The missing tool
# is the smaller half of this: the larger half is what a **missing** tool does here. Both
# sides of the restore comparison come back empty, `[ "" != "" ]` is false, and the script
# prints "tree restored byte-for-byte" having verified nothing — on a machine where every
# tier's verdict is only worth anything if the tree it ran against was put back exactly.
# A guard that silently becomes a no-op is worse than no guard, because it still claims.
if ! command -v shasum >/dev/null 2>&1; then
  if command -v sha1sum >/dev/null 2>&1; then
    shasum() { sha1sum "$@"; }
  elif command -v openssl >/dev/null 2>&1; then
    shasum() { openssl dgst -sha1 "$@"; }
  else
    echo "no SHA-1 tool available: need one of shasum, sha1sum, openssl" >&2
    exit 1
  fi
fi
# `mutate`, `mutate_case`, `anchor`, `anchor_inline` and `check_red` live in the shared
# library, so a fix to what makes a mutation's verdict trustworthy is made once.
. tools/mutation-lib.sh

CHANGES=server/changes.mjs
MCP=server/mcp.mjs
STATS=server/stats.mjs
STORE=server/store.mjs
TEST=test/changes-tool.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$CHANGES" "$MCP" "$STATS" "$STORE"; do
  cp "$f" "$BAK/$(basename "$f")"
done
restore() {
  cp "$BAK/changes.mjs" "$CHANGES"
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/stats.mjs" "$STATS"
  cp "$BAK/store.mjs" "$STORE"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$CHANGES" "$MCP" "$STATS" "$STORE"; do shasum "$f"; done)

run() { node --test "$TEST" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0

echo "baseline:"
echo "       $(run)"
echo

# A. The tool answers the count instead of the list — the shape `trajectory_summary`
#    already had, and the reason the table went unread in the first place. Anchored with
#    the field above it, because `turns: bounded.items,` is the reply shape two tools
#    share and an anchor that matched the wrong one would be evidence for neither.
anchor "$BAK/a.from" <<'EOF'
        turns: bounded.items,
        // How many files the filter matched across the whole session, and how many of
EOF
anchor "$BAK/a.to" <<'EOF'
        turns: [],
        // How many files the filter matched across the whole session, and how many of
EOF
mutate "$MCP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the list collapses to a count" "$TEST"

# B. The list survives but the cursor is pinned to the first page, so a long session
#    silently looks like a three-turn one.
#
#    Scoped to the tool, because this expression is shared: `trajectory_ingress` publishes
#    the same `nextOffset` line, so a whole-file anchor matched twice and the tier stopped
#    producing evidence without stopping looking like it did.
anchor "$BAK/b.from" <<'EOF'
        nextOffset: delivered === 0 || offset + delivered >= reachable ? null : offset + delivered,
EOF
anchor "$BAK/b.to" <<'EOF'
        nextOffset: null,
EOF
mutate_case trajectory_changes "$MCP" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the cursor never leaves the first page" "$TEST"

# C. Paths stop being resolved against the turn's workspace, so three entries in four
#    come back as "src/app.js" and the reader cannot tell which checkout they are from.
anchor "$BAK/c.from" <<'EOF'
  const resolved = stored === ''
    ? null
    : path.resolve(workspaceDir, stored);
EOF
anchor "$BAK/c.to" <<'EOF'
  const resolved = stored === '' ? null : stored;
EOF
mutate "$CHANGES" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C workspace-relative paths are handed back unresolved" "$TEST"

# D. Scratch is decided by the temp prefix alone. This is the version that looked right
#    on the measuring machine and is wrong for any checkout that lives under /tmp — which
#    is every checkout in this repo's own test fixture, so the fixture is what caught it.
anchor "$BAK/d.from" <<'EOF'
  if (typeof workspaceDir === 'string' && workspaceDir !== '') {
    const relative = path.relative(workspaceDir, resolved);
    if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return false;
  }
EOF
: > "$BAK/d.to"
mutate "$CHANGES" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a workspace under the temp directory is called scratch" "$TEST"

# E. The scratch count is dropped rather than made wrong. Both matter: a turn of 7 files
#    that is really 5 edits is the reading this number exists to prevent.
anchor "$BAK/e.from" <<'EOF'
        scratchFiles: files.filter((file) => file.scratch).length,
EOF
: > "$BAK/e.to"
mutate "$CHANGES" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the scratch count is dropped" "$TEST"

# F. A cut diff no longer says it was cut, so a truncated hunk reads as the whole change
#    to that file.
anchor "$BAK/f.from" <<'EOF'
  file.diffTruncated = kept.length < diff.length;
EOF
anchor "$BAK/f.to" <<'EOF'
  file.diffTruncated = false;
EOF
mutate "$CHANGES" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F a cut diff claims to be complete" "$TEST"

# G. The diff is never cut at all. Every file that does not fit is dropped from the reply
#    silently, which is the failure the ceiling was added to prevent and the one the
#    32 KiB version actually had: it was looser than the sweep's own 20,000-character
#    limit, so it never bound and redaction cut instead.
anchor "$BAK/g.from" <<'EOF'
  const kept = diff.length > diffBytes ? diff.slice(0, diffBytes) : diff;
EOF
anchor "$BAK/g.to" <<'EOF'
  const kept = diff;
EOF
mutate "$CHANGES" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G the per-file diff ceiling stops binding" "$TEST"

# H. A runtime without the table reports itself as having recorded nothing. This is the
#    exact conflation the `available` field exists to prevent, and the one §8.25 was
#    written about on a different table.
anchor "$BAK/h.from" <<'EOF'
  if (!store.db || !tableExists(store.db, 'local_runtime_turn_diffs')) return unavailable;
EOF
anchor "$BAK/h.to" <<'EOF'
  if (!store.db) return unavailable;
EOF
mutate "$CHANGES" "$BAK/h.from" "$BAK/h.to" \
  && check_red "H a missing table is answered instead of refused" "$TEST"

# I. The path filter is applied to the stored string rather than the resolved one, so a
#    caller narrowing to a workspace path silently matches nothing — and the flag that
#    would have said so is on a different condition.
#
#    Re-anchored on the call site rather than on `String#includes`, which is what this tier
#    used to name. The matcher grew a helper when the filter became separator-insensitive,
#    and the anchor stayed on the line it replaced — so the tier went dark: it reported
#    `anchor-missing` instead of a verdict, and a sweep that reports an anchor problem is
#    a sweep whose count for this tier is zero **for a reason that has nothing to do with
#    the tests**. The mutation is the same one; only where it is applied moved.
anchor "$BAK/i.from" <<'EOF'
      if (needle) files = files.filter((file) => matchesPathNeedle(file.path, needle));
EOF
: > "$BAK/i.to"
mutate "$CHANGES" "$BAK/i.from" "$BAK/i.to" \
  && check_red "I the path filter stops narrowing" "$TEST"

# J. The aggregate stops being session-wide and becomes the page's own count. This is the
#    defect the field's name and description used to disagree with: the numbers were
#    accumulated while scanning, then documented as if they came off the slice, so a
#    one-turn page out of 327 reported 3,048 files where it held 7. Both numbers were
#    real. Only the scope was wrong, and nothing on the page contradicts a session-wide
#    number — which is why the tier below is the only thing that finds it.
anchor "$BAK/j.from" <<'EOF'
      matchedFiles,
      matchedScratchFiles: scratchFiles,
EOF
anchor "$BAK/j.to" <<'EOF'
      matchedFiles: page.reduce((sum, turn) => sum + turn.fileCount, 0),
      matchedScratchFiles: page.reduce((sum, turn) => sum + turn.scratchFiles, 0),
EOF
mutate "$CHANGES" "$BAK/j.from" "$BAK/j.to" \
  && check_red "J the reply-level counts become page-scoped" "$TEST"

# K. Scratch goes back to the two POSIX spellings. This is not hypothetical: it is what
#    the file was written with two hours earlier, and on a Windows machine it made every
#    scratch file read as repository work — `scratchFiles: 0` on a turn that was nothing
#    but. Nothing on the reply contradicts zero; the field is simply wrong everywhere,
#    which is why the only evidence is a predicate tested against a foreign root.
anchor "$BAK/k.from" <<'EOF'
  if (underRoot(normalized, normalizeRoot(tempRoot))) return true;
  return POSIX_TEMP_ROOTS.some((root) => underRoot(normalized, root));
EOF
anchor "$BAK/k.to" <<'EOF'
  return POSIX_TEMP_ROOTS.some((root) => underRoot(normalized, root));
EOF
mutate "$CHANGES" "$BAK/k.from" "$BAK/k.to" \
  && check_red "K the platform temp root stops being consulted" "$TEST"

# L. Windows roots stop comparing case-insensitively. Lower-cased drive roots are the
#    same directory on that platform, so a drive spelled differently would drop every
#    scratch file on a machine that spells its temp root with a different case.
anchor "$BAK/l.from" <<'EOF'
  return !/^[a-z]:/iu.test(root);
EOF
anchor "$BAK/l.to" <<'EOF'
  return true;
EOF
mutate "$CHANGES" "$BAK/l.from" "$BAK/l.to" \
  && check_red "L a drive-letter root stops comparing case-insensitively" "$TEST"

# M. The summary drops the change-set half of its cache key. A change set is written
#    *after* the message rows of its own turn — 320 of 351 sessions on the machine this
#    was measured on have their last change set land after their last message row, median
#    lag 422 ms — so the moment someone asks what a session just did is exactly when a
#    summary computed a moment earlier answered `changedTurns: 0`. Without this tier the
#    key looks complete: it still moves when messages move, and every other test is about
#    a session nobody is still writing to.
#
#    Anchored on the change term alone, not on the whole key line. The key has since grown
#    a third term (`ingressSignature`), which is what invalidated the original line-anchor:
#    a tier that names the *whole* expression has to be re-anchored every time the key
#    gains a source, and re-anchoring is a step that gets skipped silently. This one keeps
#    meaning whatever else is in the key.
anchor_inline "$BAK/m.from" <<'EOF'
|${store.changeSignature(sessionId)}
EOF
anchor_inline "$BAK/m.to" <<'EOF'
|
EOF
mutate "$STATS" "$BAK/m.from" "$BAK/m.to" \
  && check_red "M the summary forgets a change set that lands after its last message" "$TEST"

# N. The summary reports a session that changed nothing as a count of zero on a runtime
#    that cannot tell. That is §8.25's conflation on a table that did not exist two hours
#    before this tool was written, and the field it fills is the one a reader trusts most.
anchor "$BAK/n.from" <<'EOF'
    changesAvailable: changes.available,
EOF
: > "$BAK/n.to"
mutate "$STATS" "$BAK/n.from" "$BAK/n.to" \
  && check_red "N a missing change-set table is reported as a count of zero" "$TEST"

# O. The orphan count is dropped from the reply entirely. This is the failure that is
#    invisible in review rather than wrong: every number in the reply is still correct,
#    `changedTurns` still counts all six change sets, and nothing anywhere says that five
#    of them name a turn `trajectory_get` cannot find. It is the state this plugin shipped
#    in — 7 sessions on a measured machine report more changed turns than the transcript
#    has turns, with no reply carrying a fact that would explain it.
anchor "$BAK/o.from" <<'EOF'
      unmatchedTurns: transcriptTurns === null ? null : unmatchedTurns,
EOF
: > "$BAK/o.to"
mutate "$CHANGES" "$BAK/o.from" "$BAK/o.to" \
  && check_red "O the reply stops saying which change sets the transcript lacks" "$TEST"

# P. The per-row flag is hardcoded to `true`. Everything else in the reply is untouched,
#    so `unmatchedTurns` still counts correctly while the rows claim the opposite — the
#    worst shape a single field can have, because a reader paging the list is told each
#    turn is findable and only the session-level number contradicts them.
anchor "$BAK/p.from" <<'EOF'
      const inTranscript = transcriptTurns === null ? null : transcriptTurns.has(key);
EOF
anchor "$BAK/p.to" <<'EOF'
      const inTranscript = true;
EOF
mutate "$CHANGES" "$BAK/p.from" "$BAK/p.to" \
  && check_red "P every row claims to be findable by turnId" "$TEST"

# Q. The turn comparison goes back to `COALESCE(...) = COALESCE(...)`. Identical answers,
#    identical rows — and 287 ms on the busiest session here (330 change sets) against
#    0.20 ms, because a function on either side of the comparison stops the planner using
#    `(session_id, turn_id, role, id)`. The guard that catches this one is a source
#    assertion, not a behavioural one: nothing a test can *observe* changed.
anchor "$BAK/q.from" <<'EOF'
               WHERE m.session_id = d.session_id AND m.turn_id IS d.turn_id
EOF
anchor "$BAK/q.to" <<'EOF'
               WHERE m.session_id = d.session_id AND COALESCE(m.turn_id, '') = COALESCE(d.turn_id, '')
EOF
mutate "$STATS" "$BAK/q.from" "$BAK/q.to" \
  && check_red "Q the turn comparison stops being index-usable" "$TEST"

# R. The summary files the口径 difference as a `warnings` entry. Both numbers stay
#    correct and the field stays put, but the reply now claims to be degraded — which in
#    this plugin means "an aggregate could not be computed, so its 0 is not a finding".
#    A reader is told the count they are holding cannot be trusted when the only thing
#    wrong is that they compared it against the wrong denominator.
anchor "$BAK/r.from" <<'EOF'
      degraded: null,
    };
  } catch {
    return {
      turns: 0,
      unmatchedTurns: null,
      available: false,
      degraded: 'file change counts are unavailable: the query failed, so 0 means "not counted", not "nothing changed"',
EOF
anchor "$BAK/r.to" <<'EOF'
      degraded: 'file change counts are unavailable: the query failed, so 0 means "not counted", not "nothing changed"',
    };
  } catch {
    return {
      turns: 0,
      unmatchedTurns: null,
      available: false,
      degraded: 'file change counts are unavailable: the query failed, so 0 means "not counted", not "nothing changed"',
EOF
mutate "$STATS" "$BAK/r.from" "$BAK/r.to" \
  && check_red "R a correct count is reported as a degraded reading" "$TEST"

# S. A drive-relative root stops matching a path that carries a volume. This is the tier
#    for the Windows defect this round fixed: the two POSIX supplement roots are written
#    without a drive, every path naming one goes through `path.resolve`, and the volume it
#    prepends made `'D:/tmp/run/apply.py'` fail to start with `'/tmp/'`. The result was
#    `scratchFiles: 0` on a turn that was nothing but — and nothing on the reply
#    contradicts zero.
anchor "$BAK/s.from" <<'EOF'
  const dropVolume = volume(root) === '';
EOF
anchor "$BAK/s.to" <<'EOF'
  const dropVolume = false;
EOF
mutate "$CHANGES" "$BAK/s.from" "$BAK/s.to" \
  && check_red "S a drive-relative temp root stops matching" "$TEST"

# T. The separator normalisation goes away and the filter is a raw substring again. A
#    reader narrowing to `src/app.js` on Windows is then matching it against `…\src\app.js`,
#    so the filter silently drops the query and the reply says the session changed nothing.
anchor "$BAK/t.from" <<'EOF'
  return normalizeRoot(resolved).includes(normalizeRoot(needle));
EOF
anchor "$BAK/t.to" <<'EOF'
  return resolved.includes(needle);
EOF
mutate "$CHANGES" "$BAK/t.from" "$BAK/t.to" \
  && check_red "T the path filter stops being separator-insensitive" "$TEST"

# U. A drive-lettered root stops being compared exactly, so the volume is stripped from both
#    sides and a temp directory on one drive matches a root naming another. This over-
#    redacts, which is the direction the module documents as safe — and the tier exists
#    because the stripped version is the one a reader would call simpler. Without it, the
#    fix for S reads as a licence to drop the volume unconditionally.
anchor "$BAK/u.from" <<'EOF'
  const dropVolume = volume(root) === '';
EOF
anchor "$BAK/u.to" <<'EOF'
  const dropVolume = true;
EOF
mutate "$CHANGES" "$BAK/u.from" "$BAK/u.to" \
  && check_red "U a drive-lettered root stops being compared exactly" "$TEST"

# V. The fold's component boundary lives in `server/redact.mjs`, so its tier is in
#    `tools/mutate-home-folding.sh` alongside the other two guards added with it. An
#    anchored tier that names a file the tier does not mutate cannot produce evidence: it
#    reports `anchor-missing`, which is a different finding from a verdict.

echo
if [ "$(for f in "$CHANGES" "$MCP" "$STATS" "$STORE"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- one of the four files differs from where the run started"
  fail=1
else
  echo "tree restored byte-for-byte"
fi
if [ "$fail" -eq 0 ]; then
  echo "all mutations applied and turned the suite red"
else
  echo "PROBLEM -- see the lines above; do not trust this run"
fi
exit "$fail"
