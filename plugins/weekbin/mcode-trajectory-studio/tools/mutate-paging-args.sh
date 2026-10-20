#!/usr/bin/env bash
# Mutation check for the note that says a paging argument was ignored.
#
# Five tools page by `offset` over an append-only key; two page by a pinned cursor. Nothing
# validated the argument, so passing one to the other was answered with silence:
# `trajectory_turns` with `cursor: 3` returned page zero of a 445-turn session looking
# exactly like the page that was asked for, and `trajectory_list` with `offset: 3` was
# worse — its reply has no `offset` field to contradict the request.
#
# Each mutation removes one of the things that makes the note usable, or tests the wrong
# thing: saying nothing, saying it for only one direction, saying it on a call that was
# right, letting it overwrite a note the reply already carried, and hanging it off a reply
# that had already failed.
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
TEST=test/paging-args.test.mjs
BAK=$(mktemp -d)
cp "$MCP" "$BAK/mcp.mjs"
restore() { cp "$BAK/mcp.mjs" "$MCP"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$MCP")

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

# A. No note at all — the behaviour before this existed, and the silent wrong page with it.
mutate "$MCP" \
  "function withPagingNote(value, name, args) {" \
  "function withPagingNote(value, name, args) {
  return value;" \
  && check_red "A the reply says nothing about the argument it ignored"

# B. Only one direction. A caller moving the other way is then back to silence, and the
#    asymmetry is the worse half: `trajectory_list` has no `offset` field in its reply to
#    contradict what was asked.
mutate "$MCP" \
  "  const ignored = PAGING_BY_OFFSET.has(name) && args?.cursor !== undefined
    ? 'cursor'
    : PAGING_BY_CURSOR.has(name) && args?.offset !== undefined ? 'offset' : null;" \
  "  const ignored = PAGING_BY_OFFSET.has(name) && args?.cursor !== undefined ? 'cursor' : null;" \
  && check_red "B an offset handed to a cursor tool is still silently ignored"

# C. Fire on the right key too. A note on every call is the same defect in the other
#    direction: the caller learns to skip it, and the reply that needed it is skipped too.
mutate "$MCP" \
  "  const ignored = PAGING_BY_OFFSET.has(name) && args?.cursor !== undefined" \
  "  const ignored = (PAGING_BY_OFFSET.has(name) && (args?.cursor !== undefined || args?.offset !== undefined))" \
  && check_red "C a call that paged the tool correctly is told its argument was ignored"

# D. Replace the note instead of appending to it. A call can be wrong in two independent
#    ways at once — the level asked for and the key used to page — and a caller who fixed
#    one and broke the other needs to hear about both.
mutate "$MCP" \
  "  return { ...value, note: existing ? \`\${existing}; \${text}\` : text };" \
  "  return { ...value, note: text };" \
  && check_red "D the paging note overwrites the note the reply already carried"

# E. Hang the note off a reply that already failed. There is no page to be wrong about,
#    so it describes a question nobody asked — and the reply it lands on is the one whose
#    `error` the caller is already reading.
mutate "$MCP" \
  "  if (!ignored || !value || typeof value !== 'object' || Array.isArray(value) || value.error) return value;" \
  "  if (!ignored || !value || typeof value !== 'object' || Array.isArray(value)) return value;" \
  && check_red "E a failed reply is told about paging"

echo
if [ "$(shasum "$MCP")" != "$BASELINE_SUMS" ]; then
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