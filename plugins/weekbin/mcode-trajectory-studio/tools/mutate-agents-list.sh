#!/usr/bin/env bash
# Mutation check for the `agents` list on the MCP `trajectory_list` reply.
#
# The defect: SKILL.md told the model that `agent` is an exact, case-sensitive filter and
# that the remedy for guessing wrong was to read "`trajectory_list`'s `agents` list". The
# reply had no such field. The store computed it all along — one indexed `GROUP BY`, and
# the panel's sidebar is built from the same call — but nothing on the MCP surface
# published it, so the instruction aimed at a field that was not there.
#
# Mutation C is the one worth reading twice. It edits SKILL.md rather than the code, to
# show the sentence test is not a formality: a guard that passes no matter what the
# document says would let the next person delete the sentence and leave the model with
# no way to find the filter vocabulary.
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
HTTP=server/http.mjs
SKILL=skills/mcode-trajectory-studio/SKILL.md
TEST=test/list-agents.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$MCP" "$BAK/mcp.mjs"
cp "$SESSIONS" "$BAK/sessions.mjs"
cp "$HTTP" "$BAK/http.mjs"
cp "$SKILL" "$BAK/SKILL.md"
# Copies only. The backup is removed once, by the exit trap; removing it here as well
# leaves every later mutation running against an already-mutated tree while still
# reporting a result.
restore() {
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/sessions.mjs" "$SESSIONS"
  cp "$BAK/http.mjs" "$HTTP"
  cp "$BAK/SKILL.md" "$SKILL"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$MCP" "$SESSIONS" "$HTTP" "$SKILL"; do shasum "$f"; done)

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

# A. The list is written down instead of derived. This is the shape a future editor is
#    most likely to reach for, and it is the one that quietly rots: the vocabulary stops
#    being this machine's and becomes whatever it was on the day it was typed.
mutate "$MCP" \
  '      const agents = store.listAgents({ includeArchived: filters.includeArchived });' \
  '      const agents = [{ name: '"'"'mavis'"'"', count: 1 }];' \
  && check_red "A the vocabulary is hand-written instead of derived"

# B. The list is derived but truncated to one entry — derived data, wrong answer. The
#    counts are real, so this looks correct at a glance.
mutate "$MCP" \
  '      const agents = store.listAgents({ includeArchived: filters.includeArchived });' \
  '      const agents = store.listAgents({ includeArchived: filters.includeArchived }).slice(0, 1);' \
  && check_red "B the vocabulary is truncated to its first entry"

# E. The reply's own scope never reaches the counts. This is the wiring that was missing,
#    and it fails in the direction that looks *more* complete: the counts describe the
#    whole machine while `total` describes the filtered population, so both numbers are
#    present and only one of them is about what the caller can see.
mutate "$MCP" \
  '      const agents = store.listAgents({ includeArchived: filters.includeArchived });' \
  '      const agents = store.listAgents();' \
  && check_red "E the counts ignore the includeArchived this reply was asked for"

# F. The population clause is dropped from the grouped query, so `listAgents` keeps its
#    own idea of which sessions count while every `total` uses `sessionFilter`'s. This
#    is the defect in the shape it was found: two copies of "which sessions count", one
#    of them missing the condition, both of them in the same reply.
mutate "$SESSIONS" \
  "      WHERE agent_name IS NOT NULL AND agent_name <> '' AND \${population}" \
  "      WHERE agent_name IS NOT NULL AND agent_name <> ''" \
  && check_red "F the counts stop sharing the population the total counts"

# G. The scope is honoured, but always in one direction: every count includes archived
#    sessions. A caller that never asked for them is told about them anyway, which is the
#    same disagreement as F with a different trigger.
mutate "$SESSIONS" \
  '  const { where: population, params } = sessionFilter(store, { includeArchived });' \
  '  const { where: population, params } = sessionFilter(store, { includeArchived: true });' \
  && check_red "G the counts always include archived sessions"

# H. The panel route ignores the `includeArchived` its sibling route honours, so a caller
#    sizing the list one way gets a filter menu sized another way.
mutate "$HTTP" \
  "        includeArchived: url.searchParams.get('includeArchived') === '1'," \
  '        includeArchived: false,' \
  && check_red "H /api/agents ignores the includeArchived /api/sessions honours"

# C. The sentence the model is told to follow is deleted from the Skill.
mutate "$SKILL" \
  "the \`agents\` list on \`trajectory_list\`'s reply" \
  'the session list' \
  && check_red "C the Skill stops pointing at the field"

# D. The vocabulary degrades to `[]` when it cannot be read, and nothing says why. The
#    list is then the same shape as a machine with no sub-agent presets, so the caller
#    reports a finding — "nothing was dispatched" — that is simply not known.
mutate "$SESSIONS" \
  "    store.warn('agent_list_failed:the agent names could not be listed, so an empty list means \"not counted\"');" \
  "    void 0;" \
  && check_red "D the degraded vocabulary stops saying it could not be counted"

echo
if [ "$(for f in "$MCP" "$SESSIONS" "$HTTP" "$SKILL"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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