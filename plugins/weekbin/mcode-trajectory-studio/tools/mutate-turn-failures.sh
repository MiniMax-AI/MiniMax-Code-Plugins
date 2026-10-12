#!/usr/bin/env bash
# Mutation check for `failureCount` on the turn rows of `trajectory_turns`.
#
# The gap: `trajectory_summary` publishes `toolFailures` and every record carries its own
# `failureCount`, but the turn rows carried neither, so "which turn of this run went
# wrong" had no cheap answer. Measured on the session this was written against — 21992
# records, 752 failures, 444 turns — the only route was twenty-two `trajectory_get` pages
# and a hand inspection of `toolCalls[].ok` on each, 1.4 seconds and a context full of
# records nobody wanted.
#
# Each mutation below removes one of the three things the field is made of: that it is
# computed at all, that "no tool calls" reads as zero rather than absence, and that it
# counts failures rather than successes. All three fail silently — a turn row that reports
# zero when it should report two is indistinguishable from a turn where nothing failed.
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
TEST=test/turns-tool.test.mjs
BAK=$(mktemp -d)
cp "$EVENTS" "$BAK/events.mjs"
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree, and
# those runs still report a result — the defect this script exists to catch, inside the
# script that catches it.
restore() { cp "$BAK/events.mjs" "$EVENTS"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$EVENTS")

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

# A. The per-turn fold not consulted at all. The column stays on the row, so every
#    assertion that only checks it *exists* still passes and the answer is uniformly zero.
mutate "$EVENTS" \
  '      failureCount: failures.get(row.turn_key ?? null) ?? 0,' \
  '      failureCount: 0,' \
  && check_red "A a turn never reports its failures"

# B. The absent-versus-zero default dropped. `json_each` on a missing path yields no rows,
#    so a turn whose records made no tool calls is absent from the fold entirely — and
#    `undefined` on the row reads as "not computed", which sends the caller back to
#    paging every record rather than reading "nothing failed here".
mutate "$EVENTS" \
  '      failureCount: failures.get(row.turn_key ?? null) ?? 0,' \
  '      failureCount: failures.get(row.turn_key ?? null),' \
  && check_red "B a turn with no tool calls reads as absent, not zero"

# C. The predicate inverted, so the fold counts the calls that succeeded. The total still
#    looks plausible on a session where most calls work, and it is the same shape as the
#    right answer — which is why only the reconciliation against `trajectory_summary`
#    catches it.
mutate "$EVENTS" \
  '        SUM(CASE WHEN COALESCE(json_extract(tc.value, '"'"'$.tool_call_status'"'"'), ${TOOL_STATUS_OK}) <> ${TOOL_STATUS_OK} THEN 1 ELSE 0 END) AS failures' \
  '        SUM(CASE WHEN COALESCE(json_extract(tc.value, '"'"'$.tool_call_status'"'"'), ${TOOL_STATUS_OK}) = ${TOOL_STATUS_OK} THEN 1 ELSE 0 END) AS failures' \
  && check_red "C the fold counts the successes instead"

echo
if [ "$(shasum "$EVENTS")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- the file differs from where the run started"
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
