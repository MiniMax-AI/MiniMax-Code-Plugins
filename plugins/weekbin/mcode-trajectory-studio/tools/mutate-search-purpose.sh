#!/usr/bin/env bash
# Mutation check for the fields `trajectory_search` reaches, and for whether they are named.
#
# The runtime records the objective it dispatched a sub-agent with, the FTS index carries
# it, and `search.mjs` has always queried it. Neither the tool description, SKILL.md, nor
# either README said so — all three promised "titles, agent names, statuses and workspace
# paths", which is true and incomplete.
#
# Nothing fails when that happens, which is the problem: the capability works, so no test
# goes red, and a reader who said "find the session where I audited dead paths" reads a
# tool that says it searches titles, searches for a title, finds none, and concludes the
# session does not exist.
#
# Three mutations, because the two halves rot separately and neither one announces itself:
# dropping the column loses the capability, dropping the name leaves it invisible. The
# second is the worse failure precisely because it raises nothing.
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

SEARCH=server/search.mjs
MCP=server/mcp.mjs
SKILL=skills/mcode-trajectory-studio/SKILL.md
TEST=test/skill-contract.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/server" "$BAK/skills"
cp "$SEARCH" "$BAK/search.mjs"
cp "$MCP" "$BAK/mcp.mjs"
cp "$SKILL" "$BAK/SKILL.md"
# Copies only. The backup is removed once, by the exit trap; removing it here as well
# leaves every later mutation running against an already-mutated tree while still
# reporting a result.
restore() {
  cp "$BAK/search.mjs" "$SEARCH"
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/SKILL.md" "$SKILL"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$SEARCH" "$MCP" "$SKILL"; do shasum "$f"; done)

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

# A. The column stops being queried. A content query still returns sessions — the ones
#    whose titles happen to match — so this looks like "search is just fuzzy".
mutate "$SEARCH" \
  "  'purpose_terms',
" \
  '' \
  && check_red "A the purpose column is no longer queried"

# B. The column is queried but the description stops naming it. Nothing fails anywhere;
#    the capability is simply invisible to the only reader that matters.
mutate "$MCP" \
  'and the per-session purpose the runtime records when it dispatches a sub-agent.' \
  'and nothing else.' \
  && check_red "B the description stops naming the purpose"

# C. The same omission in the Skill, which is the document a model is asked to follow.
mutate "$SKILL" \
  'workspace paths, and **the per-session `purpose`**.' \
  'workspace paths.' \
  && check_red "C the Skill stops naming the purpose"

echo
if [ "$(for f in "$SEARCH" "$MCP" "$SKILL"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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