#!/usr/bin/env bash
# Mutation check for the source-swap fix in the event read.
#
# The defect: when a session has no indexed rows, the read falls back to its
# `messages.jsonl` and merges the artifact over the projection. `readJsonlEvents`
# carries no row count of its own, so the projection's own `0` survived into a reply
# holding the artifact's events and both surfaces published it:
#
#   source: 'jsonl', total: null, sessionTotal: 0, returned: 3
#
# `sessionTotal: 0` is not an absence a reader can question, it is a count — beside three
# returned records, saying the session is empty. The rule the suite now holds: a count may
# only be published if it counts the records the same reply is publishing.
#
# Each mutation below removes one half of that rule and the suite must go red. Two of them
# restore the lie; two remove the field that is load-bearing, which must also go red —
# a fix that trades a wrong count for silence is not a fix.
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
HTTP=server/http.mjs
EVENTS=server/events.mjs
TEST=test/session-total-source.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/server"
for f in "$MCP" "$HTTP" "$EVENTS"; do cp "$f" "$BAK/$(basename "$f")"; done
# Only copies here. Deleting the backup belongs to the exit trap and nowhere else — an
# earlier version removed it on the first call, so every mutation after it ran against
# an already-damaged tree and still reported its result.
restore() { for f in "$MCP" "$HTTP" "$EVENTS"; do cp "$BAK/$(basename "$f")" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$MCP" "$HTTP" "$EVENTS"; do shasum "$f"; done)

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

# A. The MCP merge keeps the projection's row count again.
mutate "$MCP" \
  '          const { sessionRows: _projectionRows, ...projection } = page;
          page = { ...projection, ...artifact };' \
  '          page = { ...page, ...artifact };' \
  && check_red "A MCP republishes the projection's row count"

# B. Same merge, in the panel route. Two surfaces, one defect: fixing one and not the
#    other is exactly how they came to disagree the first time.
mutate "$HTTP" \
  '        const { sessionRows: _projectionRows, ...projection } = page;
        page = { ...projection, ...artifact };' \
  '        page = { ...page, ...artifact };' \
  && check_red "B panel republishes the projection's row count"

# C. The field is published even when it agrees with `total` — i.e. on an ordinary page,
#    where it distinguishes nothing and a reader is invited to treat it as a finding.
mutate "$MCP" \
  '...(page.sessionRows !== undefined && page.sessionRows !== page.total' \
  '...(page.sessionRows !== undefined || page.sessionRows === page.total' \
  && check_red "C sessionTotal published when it says nothing"

# D. `findEvents` seeds the count from the match count again. Nothing user-visible moves
#    on its own — which is the point: the field is shared by name with `getEvents`, where
#    it *is* the session row count, so the trap is set for whoever reads it next.
mutate "$EVENTS" \
  '  let sessionRows;
  if (total === 0) {' \
  '  let sessionRows = total;
  if (total === 0) {' \
  && check_red "D findEvents reuses the name for the match count"

echo
if [ "$(for f in "$MCP" "$HTTP" "$EVENTS"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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