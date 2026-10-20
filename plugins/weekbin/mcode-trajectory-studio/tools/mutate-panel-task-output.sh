#!/usr/bin/env bash
# Mutation check for the panel's use of `/api/task-output`.
#
# The route was served, capability-gated, redacted and covered by tests for the whole life
# of the panel, and nothing on the page called it. A tool call showed its task id and the
# reader stopped there — so the panel could say a background task failed but never why,
# while `trajectory_task_output` answered the same question for a model in one call.
#
# `tools/browser-check.mjs` proves the button works end to end, but it needs Chrome and so
# does not run in the default suite. These mutations guard the part that always runs:
# that the route has a caller at all.
#
# Two directions, because "the panel calls it" and "the server serves it" are separate
# facts and either can rot on its own.
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

PANEL=web/js/inspector.js
HTTP=server/http.mjs
TEST=test/route-liveness.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/web/js" "$BAK/server"
cp "$PANEL" "$BAK/inspector.js"
cp "$HTTP" "$BAK/http.mjs"
# Copies only. The backup is removed once, by the exit trap; removing it here as well
# leaves every later mutation running against an already-mutated tree while still
# reporting a result.
restore() { cp "$BAK/inspector.js" "$PANEL"; cp "$BAK/http.mjs" "$HTTP"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$PANEL" "$HTTP"; do shasum "$f"; done)

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

# A. The panel fetches some other endpoint instead — the shape a rename or a copy-paste
#    produces. The route goes back to having no caller while still being served, secured
#    and tested, which is exactly the state this file was written about.
# The request now reads its limit from a named constant rather than inline, because that
# constant is also what decides the byte count the panel prints. The anchor moved with it.
mutate "$PANEL" \
  '      const payload = await api(`/api/task-output?taskId=${encodeURIComponent(call.taskId)}&maxBytes=${maxBytes}`);' \
  '      const payload = await api(`/api/meta`);' \
  && check_red "A the panel fetches a different endpoint"

# B. The server renames the route. The panel keeps asking for the old one and gets a 404
#    from a feature that looks present on both sides.
mutate "$HTTP" \
  "if (route === '/api/task-output') {" \
  "if (route === '/api/task-log') {" \
  && check_red "B the server renames the route out from under the panel"

echo
if [ "$(for f in "$PANEL" "$HTTP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- one of the two files differs from where the run started"
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