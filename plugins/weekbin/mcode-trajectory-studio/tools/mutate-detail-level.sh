#!/usr/bin/env bash
# Mutation check for `detailLevel` — the only route to message text.
#
# The trap: the Skill carried a policy ("prefer `summary`, ask before requesting `full`")
# and never named the parameter that does it, on the two tools whose entire second half is
# message text. A model reading only the Skill could not ask for the words. Worse, a value
# outside the enum was ignored silently: on a record whose text is sixteen characters, the
# default, the right value and a misspelling returned records with `content` simply absent —
# the exact shape of "this session said nothing", and nothing in the reply said otherwise.
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
SKILL=skills/mcode-trajectory-studio/SKILL.md
TEST=test/detail-level.test.mjs
BAK=$(mktemp -d)
cp "$MCP" "$BAK/mcp.mjs"
cp "$SKILL" "$BAK/SKILL.md"
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree, and those
# runs still report a result — the defect this script exists to catch, inside the script
# that catches it.
restore() { cp "$BAK/mcp.mjs" "$MCP"; cp "$BAK/SKILL.md" "$SKILL"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$MCP" "$SKILL")

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

# A. The note removed, so an unrecognised level is dropped exactly as before. The reply
#    still says `detailLevel: "summary"`, which is true and useless: nothing says the
#    caller's value was never read.
mutate "$MCP" \
  "  const detailNote = requestedDetail !== undefined && !DETAIL_LEVELS.includes(requestedDetail)" \
  "  const detailNote = false && requestedDetail !== undefined && !DETAIL_LEVELS.includes(requestedDetail)" \
  && check_red "A an unrecognised detail level is dropped without a word"

# B. The fallback widened, so any unknown value is read as `full`. The opposite failure and
#    the more dangerous one: a typo would hand back every message body in a session, which
#    is the payload the Skill tells the model to ask a human before retrieving.
mutate "$MCP" \
  "  const detailLevel = DETAIL_LEVELS.includes(requestedDetail) ? requestedDetail : 'summary';" \
  "  const detailLevel = DETAIL_LEVELS.includes(requestedDetail) ? requestedDetail : 'full';" \
  && check_red "B a misspelled level is served as full"

# C. The parameter named in one tool's description and not the other, which is how the
#    Skill's guidance ended up attached to a tool that has no such argument.
mutate "$SKILL" \
  "**The parameter is \`detailLevel\`; \`full\` is what carries message text**" \
  "**\`full\` is what carries message text**" \
  && check_red "C the Skill stops naming the parameter"

echo
if [ "$(shasum "$MCP" "$SKILL")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- a file differs from where the run started"
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