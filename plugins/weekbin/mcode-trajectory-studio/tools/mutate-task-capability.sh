#!/usr/bin/env bash
# Mutation check for "this installation cannot answer" on the task list.
#
# The defect: a projection with no `local_runtime_background_tasks` table. The reads guard
# on `tableExists` and return `[]` / `0` before preparing anything, so the answer was
# byte-identical to a session that genuinely dispatched nothing — the one reply in this
# tool that reads as a finding. `test/silent-degradation.test.mjs` was built around this
# class and still missed it, because its header enumerates reads that fall back to zero
# "when their query throws" and a guard that never reaches a query is not a throw.
#
# A second half hides inside the first: `task_count_failed` *was* raised and *was* on the
# store, but `trajectory_tasks` had no `warnings` key, so the one warning this tool's
# family could produce could not reach a model by any route. Every mutant below therefore
# leaves the rows and the counts alone and changes only whether the answer is honest.
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

STORE=server/store.mjs
TASKS=server/tasks.mjs
MCP=server/mcp.mjs
TEST=test/silent-degradation.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$STORE" "$BAK/store.mjs"
cp "$TASKS" "$BAK/tasks.mjs"
cp "$MCP" "$BAK/mcp.mjs"
restore() {
  cp "$BAK/store.mjs" "$STORE"
  cp "$BAK/tasks.mjs" "$TASKS"
  cp "$BAK/mcp.mjs" "$MCP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$STORE" "$TASKS" "$MCP"; do shasum "$f"; done)

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

# A. The reply claims the install can read tasks. The rows and the count are untouched —
#    this is the entire defect in one line, and the only mutant here that is not a
#    rewording of something else.
#
#    The *guard* is deliberately not a target. Turning it off is an equivalent mutant:
#    the query then throws and is caught on the `task_count_failed` path, which reaches
#    the same honest answer by a different route. Verified rather than assumed — with the
#    guard stubbed the reply still carried `tasksAvailable: false` and
#    `task_count_failed: ... total=0 means "not counted"`. An equivalent mutant says
#    nothing about the tests, so it is replaced rather than argued with.
mutate "$MCP" \
  '        tasksAvailable: store.hasTasks,' \
  '        tasksAvailable: true,' \
  && check_red "A the reply claims this install can read tasks when it cannot"

# B. The capability probe is hard-coded true, so the reply claims the install can answer.
#    The rows and the count are unchanged — this is the whole defect in one line.
mutate "$STORE" \
  '    this.hasTasks = Boolean(db) && tableExists(db, '"'"'local_runtime_background_tasks'"'"');' \
  '    this.hasTasks = true;' \
  && check_red "B the store reports it can read tasks when it cannot"

# C. The warning is dropped, leaving the capability flag as the only disclosure — and the
#    panel, which has no such flag, with nothing at all.
mutate "$STORE" \
  "    if (db && !this.hasTasks) {
      this.warn('task_table_missing:this runtime\\'s projection has no background-task table, so an empty task list and total=0 mean \"not counted\"');
    }" \
  '    if (false) { /* silent */ }' \
  && check_red "C a missing task table stops being recorded"

# D. The task reply drops the warnings slice. `task_count_failed` was already raised and
#    already correct — it simply had no way out, because this was the one list tool with
#    no `warnings` key. The store and the rows are untouched.
#
#    Anchored on the two lines above the assignment, because that assignment also appears
#    in `trajectory_list` and a one-line anchor would be ambiguous. The comment above
#    `trajectory_list`'s copy carries a backticked name, which a single-quoted shell
#    argument will not carry across two lines; these two do not.
mutate "$MCP" \
  $'        // out of the same ring.\n        warnings: store.warnings.slice(from),' \
  $'        // out of the same ring.\n        warnings: [],' \
  && check_red "D the task reply stopped publishing what the store said"

# E. The reply publishes the ring's whole history instead of its own slice, so a warning
#    raised before this call is presented as its own omission.
mutate "$MCP" \
  $'        // out of the same ring.\n        warnings: store.warnings.slice(from),' \
  $'        // out of the same ring.\n        warnings: store.warnings,' \
  && check_red "E the reply reports warnings from earlier reads as its own"

echo
if [ "$(for f in "$STORE" "$TASKS" "$MCP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- one of the three files differs from where the run started"
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