#!/usr/bin/env bash
# Mutation check for "this installation cannot search" as a distinct answer.
#
# The defect: `searchSessions` returned the bare empty list whenever the store had no
# full-text index at all, so `unsearchable` stayed false and the panel's route reported a
# machine that cannot search as one with no matches. `wire.js` has three banners for the
# three ways a query produces nothing; this one matched none of the two flags and fell
# through to 没有匹配的会话.
#
# A Node runtime bundling SQLite without FTS5 is a real configuration — it is the one the
# compat matrix records — and on it the panel's search box invents a finding: "no session
# matches that" for every query, forever. The MCP tool was honest about the same store,
# because its handler checks `hasFts` itself. That is the shape to kill: two places each
# deciding once whether search is possible.
#
# The mutants below all preserve "an empty list of sessions" and change only what the
# answer *says*. A mutation that removed the rows would pass every one of these tests and
# say nothing about this defect.
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
HTTP=server/http.mjs
TEST=test/search-failure.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$SEARCH" "$BAK/search.mjs"
cp "$HTTP" "$BAK/http.mjs"
restore() {
  cp "$BAK/search.mjs" "$SEARCH"
  cp "$BAK/http.mjs" "$HTTP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$SEARCH" "$HTTP"; do shasum "$f"; done)

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

# A. The defect itself: a store with no index answers as though it had run the query.
#
#    Both no-index guards, in one mutation, because §8.37 split them: the objective
#    channel is a plain table scan and must keep working without FTS5, so there are now
#    two early returns instead of the single combined one these tiers were written
#    against. Mutating only one leaves the other reporting `unsearchable: true` and the
#    assertion green for the wrong reason — which is the same trap as mutating one face
#    of a two-faced implementation.
mutate "$SEARCH" \
  '  if (!store.db) return goalOnly({ unsearchable: true });
  if (!store.hasFts) return goalOnly({ unsearchable: true });' \
  '  if (!store.db) return EMPTY;
  if (!store.hasFts) return EMPTY;' \
  && check_red "A a store with no index reports itself as searchable"

# B. The same fault wearing the other guard: schema-mismatch still says `unsearchable`,
#    so the flag still works for its original case and the suite stays green except here.
mutate "$SEARCH" \
  '  if (!searchable) return goalOnly({ unsearchable: true });' \
  '  if (!searchable) return EMPTY;' \
  && check_red "B a schema mismatch stops being reported as unsearchable"

# C. The store answers correctly but the route stops forwarding the flag — the panel half
#    of the defect, where the server was right and the layer that serves it was not. The
#    client is untouched and still branches on `searchUnsearchable`, so this is invisible
#    everywhere except at the two lines that make the truth travel.
mutate "$HTTP" \
  '      searchFailed: raw.failed === true,
      searchUnsearchable: raw.unsearchable === true,' \
  '      searchFailed: false,
      searchUnsearchable: false,' \
  && check_red "C the panel route stops forwarding the search state"

# D. An empty query stops being a plain empty answer. This is the mutation that keeps the
#    fix honest in the other direction: with the no-index guard moved into the same
#    return as the empty-query one, the panel would claim the runtime is broken before the
#    first keystroke.
mutate "$SEARCH" \
  '  if (!query) return EMPTY;' \
  '  if (!query) return { ...EMPTY, unsearchable: true };' \
  && check_red "D an empty query is reported as a machine that cannot search"

echo
if [ "$(for f in "$SEARCH" "$HTTP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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