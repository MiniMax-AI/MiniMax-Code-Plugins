#!/usr/bin/env bash
# Mutation check for the cursor walk on `trajectory_list` and `trajectory_search`.
#
# The defect: both lists are ordered `updated_at_ms DESC`, and that column is the one the
# runtime rewrites every time it writes to a session. `LIMIT ? OFFSET ?` counts
# *positions*, so a session written to between two pages jumps above the cursor and is
# never delivered again — while the walk still ends by reporting no cursor, the word every
# other field in this Plugin uses for "that is the whole list".
#
# Measured on a twelve-session fixture: the walk ended claiming twelve of twelve and had
# delivered eleven distinct sessions, with one duplicate in their place. `total` agreed with
# the number of rows sent, so a caller counting its own results could not have noticed.
#
# Each mutation below removes one of the three things that make the walk lossless, and each
# has to turn the suite red. A mutation that survives is not a near miss — it means the walk
# can lose a session and the tests say nothing about it.
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

MCP=server/mcp.mjs
SESSIONS=server/sessions.mjs
SEARCH=server/search.mjs
CONFIG=server/config.mjs
TEST="test/list-paging.test.mjs test/search-paging.test.mjs"
BAK=$(mktemp -d)
for f in "$MCP" "$SESSIONS" "$SEARCH" "$CONFIG"; do cp "$f" "$BAK/$(basename "$f")"; done
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree, and those
# runs still report a result — the defect this script exists to catch, inside the script
# that catches it.
restore() { for f in "$MCP" "$SESSIONS" "$SEARCH" "$CONFIG"; do cp "$BAK/$(basename "$f")" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$MCP" "$SESSIONS" "$SEARCH" "$CONFIG"; do shasum "$f"; done)

run() { node --test $TEST 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0
check_red() {
  local name="$1" out passed failed
  out=$(run)
  passed=$(echo "$out" | sed -n 's/.*pass \([0-9]*\).*/\1/p')
  failed=$(echo "$out" | sed -n 's/.*fail \([0-9]*\).*/\1/p')
  if [ "${failed:-0}" -gt 0 ]; then
    echo "RED      $name  (pass=$passed fail=$failed)"
  else
    echo "SURVIVED $name  (pass=$passed fail=0)  -- the test does not pin this"
    fail=1
  fi
  restore
}

mutate() {
  local file="$1" from="$2" to="$3"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
if text.count(src) != 1:
    sys.exit(3)
open(path, 'w', encoding='utf-8').write(text.replace(src, dst))
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ANCHOR MISSING or AMBIGUOUS in $file (needs exactly one match)"
    echo "  -- the mutation did not apply, so its result would say nothing"
    fail=1
    return 1
  fi
  if [ -n "$to" ] && ! grep -qF -- "$to" "$file"; then
    echo "MUTATION DID NOT LAND in $file -- its result would say nothing"
    fail=1
    return 1
  fi
  return 0
}

echo "baseline:"
echo "       $(run)"
echo

# A. The keyset predicate removed, so the cursor branch pages by position again. This is the
#    original defect in its exact shape: `LIMIT ?` with no comparison against the sort key,
#    which means the cursor selects the newest rows of every page.
mutate "$SESSIONS" \
  "    if (at) {
      clauses.push('(updated_at_ms < ? OR (updated_at_ms = ? AND session_id < ?))');
      args.push(at.updatedAtMs, at.updatedAtMs, at.sessionId);
    }" \
  "    if (false) {
      clauses.push('(updated_at_ms < ? OR (updated_at_ms = ? AND session_id < ?))');
      args.push(at.updatedAtMs, at.updatedAtMs, at.sessionId);
    }" \
  && check_red "A session list pages by position instead of by key"

# B. The snapshot pin loosened from strict to inclusive. `updated_at_ms` is a millisecond
#    stamp, so a write landing in the pin's own millisecond is not distinguishable from one
#    that landed just before it: inclusive, the moved row stays inside the window, falls
#    above the cursor, and is dropped from the walk while `total` still counts it. The whole
#    defect surviving in a one-millisecond corner. Anchored on the session list's own copy
#    of the line — the search handler computes the same bound and is pinned by D.
mutate "$MCP" \
  '        sinceMs: args.sinceMs,
        // A caller'"'"'s own upper bound still wins when it is the tighter of the two.
        untilMs: Math.min(Number.isFinite(args.untilMs) ? args.untilMs : Number.POSITIVE_INFINITY, pinMs - 1),' \
  '        sinceMs: args.sinceMs,
        // A caller'"'"'s own upper bound still wins when it is the tighter of the two.
        untilMs: Math.min(Number.isFinite(args.untilMs) ? args.untilMs : Number.POSITIVE_INFINITY, pinMs),' \
  && check_red "B the walk pin is inclusive of its own millisecond"

# C. The tiebreak dropped. `updated_at_ms` is a millisecond stamp and sessions tie on it —
#    three do on the machine this was measured on — so with no secondary key the row order
#    is only partly determined and a page boundary can land anywhere inside the tie group.
mutate "$SESSIONS" \
  "    order = 'updated_at_ms DESC, session_id DESC';" \
  "    order = 'updated_at_ms DESC';" \
  && check_red "C the sort order has no secondary key"

# D. The count bounded by the cursor as well as the pin. That turns `total` into "how many
#    are still ahead of you": the walk reports 12, 7, 3, 0 and ends on a page claiming zero
#    matches while the caller is holding eleven of them.
mutate "$SEARCH" \
  "  const pageWhere = bounds.length ? \` AND \${bounds.join(' AND ')}\` : '';
  const pinOnly = Number.isFinite(untilMs) ? ' AND s.updated_at_ms <= ?' : '';" \
  "  const pageWhere = bounds.length ? \` AND \${bounds.join(' AND ')}\` : '';
  const pinOnly = pageWhere;" \
  && check_red "D the match count is bounded by the cursor"

# E. An unreadable cursor treated as a comparison key instead of a fresh start. `NaN`
#    compares false against every row, so the one call whose job is to say the list is not
#    empty answers nothing at all.
mutate "$CONFIG" \
  "  if (parts.length < 5 || parts[0] !== 'v2') return null;" \
  "  if (parts.length < 5 || parts[0] !== 'v2') return { pinMs: NaN, updatedAtMs: NaN, fingerprint: '', sessionId: parts.slice(4).join('.') };" \
  && check_red "E an unreadable cursor reads as a comparison key"

# F. The end of the walk decided by the count instead of by the page being short. The count
#    falls when a row leaves the pinned window, so a walk that still owes rows would be
#    closed early — and a walk that is owed nothing would be handed a cursor inviting a
#    pointless extra call.
mutate "$MCP" \
  '      const reachedEnd = delivered === 0 || (delivered === read.length && read.length < pageSize);' \
  '      const reachedEnd = delivered === 0 || delivered >= total;' \
  && check_red "F the walk ends on a count instead of a short read"

# G. The walk identity dropped from the cursor, so any cursor resumes any question. A
#    filtered walk cursor handed back without its filter returned a page of a different
#    population at an arbitrary key beside the unfiltered total; across two queries it
#    returned an empty page, which is an answer this Plugin never means to give by
#    accident. Collapsing the fingerprint to a constant is the blunt version: the guard
#    still runs, it simply never fires.
mutate "$CONFIG" \
  'export function sessionCursorFingerprint(scope = {}) {' \
  'export function sessionCursorFingerprint() {
  if (true) return "always-the-same";' \
  && check_red "G a cursor resumes a walk it does not belong to"

# H. The page size folded into the walk identity. `limit` decides how much is carried, not
#    which rows match, so this refuses a perfectly good continuation - and the refusal is
#    invisible from the caller side unless the note is there, which is a worse way to fail
#    than the one G covers.
mutate "$MCP" \
  '        includeArchived: toBoolean(args.includeArchived),
      });
      const decoded = decodeSessionCursor(args.cursor);' \
  '        includeArchived: toBoolean(args.includeArchived),
        limit: args.limit,
      });
      const decoded = decodeSessionCursor(args.cursor);' \
  && check_red "H the page size is treated as part of the walk identity"

# I. The session id read as a single dot-delimited field. `session_id` is a TEXT primary
#    key with nothing constraining its shape, and an id carrying a dot does not merely
#    page to the wrong row: every page comes back as page one with a fresh cursor that
#    also cannot be read, so `nextCursor` is never null and the walk never ends.
mutate "$CONFIG" \
  "  if (parts.length < 5 || parts[0] !== 'v2') return null;
  const sessionId = parts.slice(4).join('.');" \
  "  if (parts.length !== 5 || parts[0] !== 'v2') return null;
  const sessionId = parts[4];" \
  && check_red "I a session id carrying a dot traps the walk"

echo
if [ "$(for f in "$MCP" "$SESSIONS" "$SEARCH" "$CONFIG"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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
