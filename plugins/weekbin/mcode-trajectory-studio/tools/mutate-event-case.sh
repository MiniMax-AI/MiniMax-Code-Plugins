#!/usr/bin/env bash
# Mutation check for the case-handling fix in `findEvents`.
#
# Two defects, in two different layers, that disagreed with each other:
#
#   1. The excerpt located the needle on `text.toLowerCase()` and sliced the *original*
#      at that offset. Folding is not length-preserving — `İ` becomes two characters —
#      so every match after such a character was quoted shifted, and in the measured
#      case "matters" came back as "atters".
#
#   2. SQL `LIKE` folds ASCII case and nothing else, and SQLite's own `lower()` is the
#      same, so a query whose only occurrence differs by a non-ASCII letter was
#      invisible: the function answered "no such text" for text that is there.
#
# The fix is a second pass for (2) and an offset-honest search for (1). Each mutation
# below removes one of those, and the suite must go red for each.
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

EVENTS=server/events.mjs
TEST=test/snippet-offset.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/server"
cp "$EVENTS" "$BAK/events.mjs"
restore() { cp "$BAK/events.mjs" "$EVENTS"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$EVENTS" | sed "s|$BAK/events.mjs|server/events.mjs|")

run() { node --test "$TEST" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

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

# A. The excerpt's offset search replaced by the original: locate on the folded copy
#    and slice the original at that index. The first attempt at this mutation widened
#    the *fast path* to always run, which changed nothing — every text containing the
#    drifting character already fails the fast path's guard and takes the corrected
#    slow one, so the mutation was unreachable and "survived" for a reason that had
#    nothing to do with the tests. The mutation has to remove the correction itself.
mutate "$EVENTS" \
  '  for (let at = 0; at + width <= text.length; at += 1) {
    if (text.slice(at, at + width).toLowerCase() === folded) {
      return sliceAt(text, at, width);
    }
  }
  return null;' \
  '  return sliceAt(text, text.toLowerCase().indexOf(folded), width);' \
  && check_red "A excerpt offset taken from the folded string"

# B. The fast path's guard removed, so a text containing a length-changing character
#    takes the offset-from-folded-copy route. This was written as an *expected* no-op
#    on the reasoning that the fast path is only ever reached for ASCII, where folding
#    preserves length and the offsets coincide. That reasoning was wrong about which
#    side matters: the guard tests the *text*, not the needle, and a text containing
#    `İ` is exactly the case it exists to divert. So this mutation is a real defect and
#    must turn the suite red.
mutate "$EVENTS" \
  '  if (text.toLowerCase().length === text.length) {
    return sliceAt(text, text.toLowerCase().indexOf(folded), needle.length);
  }' \
  '  if (true) {
    return sliceAt(text, text.toLowerCase().indexOf(folded), needle.length);
  }' \
  && check_red "B fast-path guard removed"

# 2. The Unicode fallback removed: a non-ASCII-case query finds nothing again.
mutate "$EVENTS" \
  '  if (needsUnicodeFold(needle)) {
    const fallback = unicodeCaseScan(store, sessionId, needle, safeOffset, safeLimit);' \
  '  if (total === 0) {
    const fallback = unicodeCaseScan(store, sessionId, needle, safeOffset, safeLimit);' \
  && check_red "C fallback gated on an empty result (misses partial matches)"

# C2. The predicate reduced to "the needle has any non-ASCII character", which fires a
#     full scan for every Chinese query — the most common non-ASCII query there is.
mutate "$EVENTS" \
  '    if (char.codePointAt(0) <= 0x7f) continue;' \
  '    if (char.codePointAt(0) <= 0x7f) return false;' \
  && check_red "C2 scan fires for single-case non-ASCII needles"

# 3. The fallback runs but its answer is discarded — a scan that costs and lies.
mutate "$EVENTS" \
  '      rows = fallback.rows;
      total = fallback.total;
      unindexedCase = true;' \
  '      unindexedCase = true;' \
  && check_red "D scan ran but its rows were dropped"

# 4. The flag is claimed on every answer, so a caller cannot tell which path ran.
mutate "$EVENTS" \
  '...(unindexedCase ? { unindexedCaseMatch: true } : {}),' \
  '...(unindexedCase === false ? { unindexedCaseMatch: true } : {}),' \
  && check_red "E flag inverted"

# F. The Unicode pass numbers its hits in the reverse order. This is the drift the whole
#    point of `index` is exposed to: `getEvents` windows the session in `id` order and
#    `unicodeCaseScan` computes its own `ROW_NUMBER`, so the two agreeing is a property
#    nobody derives from either — it has to be checked against the other.
#
#    This mutation was added after finding that the test named for the property was
#    exercising the *indexed* path instead: its needle matched the stored bytes exactly,
#    so the scan never ran and the numbering it claimed to check was never computed.
#    A property with a test named after it and no coverage underneath.
mutate "$EVENTS" \
  '      ROW_NUMBER() OVER (ORDER BY id) - 1 AS position,
      ${DOC_SQL} AS data_json
    FROM local_runtime_message_rows WHERE session_id = ?
    ORDER BY id ASC' \
  '      ROW_NUMBER() OVER (ORDER BY id DESC) - 1 AS position,
      ${DOC_SQL} AS data_json
    FROM local_runtime_message_rows WHERE session_id = ?
    ORDER BY id ASC' \
  && check_red "F the Unicode pass numbers hits in the opposite order"

echo
if [ "$(shasum "$EVENTS" | sed "s|$BAK/events.mjs|server/events.mjs|")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- $EVENTS differs from where the run started"
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