#!/usr/bin/env bash
# Mutation check for the paging-limit clamp on `trajectory_turns`.
#
# The defect: `trajectory_turns` was the one paged tool with no store query to clamp its
# `limit`, because the turn list is folded whole and sliced in the handler. A `slice`
# applies whatever arithmetic it is handed, and `tools/call` validates no arguments, so
# the schema's `minimum: 1` was documentation and nothing more:
#
#   limit: 0   -> slice(at, at)     -> an empty page, `nextOffset: null`, `total: 40`
#   limit: -5  -> slice(at, at - 5) -> everything except the last five turns
#   limit: 'lots' -> slice(at, NaN) -> nothing at all
#
# The empty page is the sharp one: `nextOffset: null` is how every other tool in this
# Plugin says "that is the whole list", so a caller paging on the cursor stopped there
# having seen none of the forty turns, while holding the count that says there are forty.
#
# Mutation B is not about this fix. It removes the clamp from a tool that already had
# one, because the cross-tool test claims *every* paged tool is bounded and a claim like
# that is only worth making if something can break it.
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
CONFIG=server/config.mjs
EVENTS=server/events.mjs
TEST=test/tool-limits.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/server"
for f in "$MCP" "$CONFIG" "$EVENTS"; do cp "$f" "$BAK/$(basename "$f")"; done
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree, and
# those runs still report a result — the defect this script exists to catch, inside the
# script that catches it.
restore() { for f in "$MCP" "$CONFIG" "$EVENTS"; do cp "$BAK/$(basename "$f")" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$MCP" "$CONFIG" "$EVENTS"; do shasum "$f"; done)

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

# A. The clamp removed, back to handing the raw argument to `slice`.
mutate "$MCP" \
  '      const pageSize = clamp(args.limit ?? 200, LIMITS.turns);' \
  '      const pageSize = args.limit ?? 200;' \
  && check_red "A turn page clamped by slice arithmetic instead"

# B. The floor lowered to zero, so `limit: 0` is honoured rather than raised. This is the
#    subtle half: the clamp is still *there*, the page is still bounded, and the reply is
#    still self-consistent — it just closes a forty-turn walk on an empty page.
mutate "$CONFIG" \
  '  turns: { min: 1, max: 2000, default: 200 },' \
  '  turns: { min: 0, max: 2000, default: 200 },' \
  && check_red "B clamp floor lowered to zero"

# C. A tool that already clamped loses its clamp, so the cross-tool sweep is not a claim
#    about one tool wearing a general statement.
mutate "$EVENTS" \
  '  const safeLimit = clamp(limit, LIMITS.events);
  // The offset is normalised here' \
  '  const safeLimit = limit;
  // The offset is normalised here' \
  && check_red "C another tool stops clamping"

echo
if [ "$(for f in "$MCP" "$CONFIG" "$EVENTS"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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