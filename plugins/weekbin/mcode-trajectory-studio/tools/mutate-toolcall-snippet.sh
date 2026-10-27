#!/usr/bin/env bash
# Mutation check for the excerpt on a hit that lives inside a tool call.
#
# `trajectory_find` locates a match against the whole record, so the needle can be in the
# message, in the thinking, or in neither — a tool argument or a tool result. The last case
# used to stop at `field: 'other'` with no excerpt at all, so a caller who had just asked
# for `full` detail was told only which record to go and read. Measured on a real session,
# one word from the user's own messages matched 193 records and three of the first five
# were of this kind.
#
# Both readers are covered, because the defect was in both and only one was looked at.
# The projection search located its own match over `msg_content` / `thinking_content` /
# `tool_calls`, and the artifact search located its own over `content[].text` /
# `content[].thinking` / `content[].toolCall` — and the second read a call's payload from
# `part.input ?? part.args` while the runtime writes `part.arguments`, so on the six largest
# artifacts here all 1,273 tool calls contributed the string `{}` to the haystack and a
# term in a tool argument was simply not findable. Two implementations, one silent
# disagreement between them. They now share `locateNeedle`, and each mutation below
# removes one of the things that makes the answer usable: the excerpt itself, the field
# naming which half of the call matched, pairing the needle with the text it was actually
# found in, the artifact's ability to see tool arguments at all, and the field the artifact
# path reports.
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
JSONL=server/jsonl.mjs
MCP=server/mcp.mjs
TEST=test/find-tool.test.mjs
BAK=$(mktemp -d)
for file in "$EVENTS" "$JSONL" "$MCP"; do
  mkdir -p "$BAK/$(dirname "$file")"
  cp "$file" "$BAK/$file"
done
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree, and those
# runs still report a result — the defect this script exists to catch, inside the script
# that catches it.
restore() {
  for file in "$EVENTS" "$JSONL" "$MCP"; do cp "$BAK/$file" "$file"; done
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$EVENTS" "$JSONL" "$MCP")

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

# A. The excerpt gone from a hit the locator placed, so a match outside the message and
#    the thinking ends at `field: 'other'` with nothing — the original defect.
mutate "$EVENTS" \
  "    if (detailLevel === 'full' && located) {
      hit.snippet = snippetAround(located.text, needle);
      if (located.in) hit.matchedToolCall = located.in;
    }" \
  "    if (detailLevel === 'full' && located && !located.in) {
      hit.snippet = snippetAround(located.text, needle);
    }" \
  && check_red "A a hit in a tool call has no excerpt again"

# B. The excerpt stays but the field that says which half matched is dropped. An argument
#    is what the model wrote and a result is what came back; a reader told only 'other'
#    cannot tell them apart, which is the question the hit was asked to answer.
mutate "$EVENTS" \
  "      if (located.in) hit.matchedToolCall = located.in;" \
  "      void located.in;" \
  && check_red "B the reply does not say which half of the tool call matched"

# C. The two halves swapped inside the locator. The excerpt cannot go wrong here — every
#    candidate is tested for the needle before it is quoted — so what flips is
#    `matchedToolCall` on the commonest shape of all: a shell call whose result echoes the
#    command line, where both halves hold the needle. Then the answer becomes 'result',
#    i.e. the model's own wording reported as the machine's output.
mutate "$EVENTS" \
  "    const inArgs = holds(call?.args);
    if (inArgs !== null) return { field: 'other', in: 'args', text: inArgs };
    const inResult = holds(call?.result);
    if (inResult !== null) return { field: 'other', in: 'result', text: inResult };" \
  "    const inResult = holds(call?.result);
    if (inResult !== null) return { field: 'other', in: 'result', text: inResult };
    const inArgs = holds(call?.args);
    if (inArgs !== null) return { field: 'other', in: 'args', text: inArgs };" \
  && check_red "C a term in both halves of one call is reported as the tool's output"

# D. The artifact reader back to the two key names the runtime does not write. Nothing
#    about the reply changes shape: it still answers, still with `source: 'jsonl'`, and
#    still says the session holds no such term.
mutate "$JSONL" \
  "      .map((part) => ({ args: part?.arguments, result: part?.result }))," \
  "      .map((part) => ({ args: part?.input ?? part?.args, result: part?.result }))," \
  && check_red "D a term in a tool argument is not findable from the artifact"

# E. The artifact path's field hardcoded again. A term in the thinking comes back saying
#    it was in the message — and, since the excerpt is quoted from the located text while
#    this removes the label only, with an excerpt that contradicts the label.
mutate "$MCP" \
  "              field: event.matchLoc?.field ?? 'other'," \
  "              field: 'content'," \
  && check_red "E the artifact path calls a hit in the thinking a hit in the message"

# F. The located text not carried onto the event, so the artifact path has nothing to
#    report: every hit degrades to `field: 'other'` with no excerpt in full detail. This
#    is the shape a caller cannot distinguish from a session that genuinely had nothing.
mutate "$JSONL" \
  "    if (located && typeof located === 'object') event.matchLoc = located;" \
  "" \
  && check_red "F the artifact path says nothing about where the needle was"

echo
if [ "$(shasum "$EVENTS" "$JSONL" "$MCP")" != "$BASELINE_SUMS" ]; then
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