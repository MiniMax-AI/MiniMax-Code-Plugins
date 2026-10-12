#!/usr/bin/env bash
# Mutation check for the shape of the persisted sidebar state.
#
# `readCollapsed` wrapped `JSON.parse` in a try/catch, which covers a document that does
# not parse and nothing else. A bare JSON string parses cleanly and `new Set('hello')` is
# a set of characters, so the catch never ran: every group looked expanded, and the first
# write persisted `["h","e","l","o"]` back over the reader's real state.
#
# Two mutations because there are two guards: the list shape, and the entry shape. Dropping
# only the second leaves a list that parses and is a list — and still carries values that
# can never be a group key.
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

STORAGE=web/js/storage.js
TEST=test/panel-storage.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/web/js"
cp "$STORAGE" "$BAK/storage.js"
# Copies only. The backup is removed once, by the exit trap; removing it here as well
# leaves every later mutation running against an already-mutated tree while still
# reporting a result.
restore() { cp "$BAK/storage.js" "$STORAGE"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$STORAGE")

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

# A. The list-shape guard removed, so a bare JSON string becomes a set of its characters.
mutate "$STORAGE" \
  '  if (!Array.isArray(parsed)) return new Set();' \
  '' \
  && check_red "A a parsed string is no longer refused"

# B. The entry-shape guard removed. The document still parses and still is a list, so the
#    first guard is satisfied — and values that can never be a group key are kept.
mutate "$STORAGE" \
  '  return new Set(parsed.filter((entry) => typeof entry === '"'"'string'"'"'));' \
  '  return new Set(parsed);' \
  && check_red "B non-string entries are kept"

echo
if [ "$(shasum "$STORAGE")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- $STORAGE differs from where the run started"
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