#!/usr/bin/env bash
# Mutation check for the search-encoding fix.
#
# Each variant reintroduces exactly one of the defects, and the suite must turn
# RED on each. A surviving variant would mean the test does not pin the behaviour it
# names.
#
# The backup is a directory that is created once and removed once, in the exit trap.
# An earlier version of this script called `restore` (which deleted it) between
# mutations, so mutations 3-5 ran against files that were already damaged and their
# red was caused by the previous mutation rather than by the one under test — the
# same failure mode as the code being guarded, one level up. `restore` now only
# copies, and the verification that every mutation actually changed the file is part
# of the run rather than something assumed from the exit status.
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
FIXTURE=tools/fixture.mjs
BAK=$(mktemp -d)
cp "$SEARCH" "$BAK/search.mjs"
cp "$FIXTURE" "$BAK/fixture.mjs"
restore() { cp "$BAK/search.mjs" "$SEARCH"; cp "$BAK/fixture.mjs" "$FIXTURE"; }
trap 'restore; rm -rf "$BAK"' EXIT
# Proof that the tree came back. Every other mutation script here ends with this and this
# one did not, which made its success line weaker than it read: five REDs followed by
# "all mutations applied" says nothing at all if a restore silently failed and the next
# run of the suite starts from a mutated `search.mjs`. The hashes are taken from the
# original paths so the comparison is of content, not of mtime.
BASELINE_SUMS=$(shasum "$SEARCH" "$FIXTURE")

run() { node --test test/search-encoding.test.mjs 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0
check_red() {
  local name="$1"
  local out passed failed
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

# A mutation that changes nothing would "survive" for a reason that says nothing about
# the tests, so the substitution is confirmed to have landed before its result counts.
#
# The replacement is done in Python rather than perl: several anchors contain `$`, and
# `perl -0pi -e "s/\Q$from\E/$to/"` lets both the shell and perl's replacement side
# interpret it. That produced a mutation which reported success, changed nothing, and
# whose test run was then read as a result about the wrong code.
mutate() {
  local file="$1" from="$2" to="$3"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
if src not in text:
    sys.exit(3)
open(path, 'w', encoding='utf-8').write(text.replace(src, dst))
PY
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "ANCHOR MISSING in $file: $from -- mutation not applied, its result would be meaningless"
    fail=1
    return 1
  fi
  if grep -qF -- "$to" "$file"; then return 0; fi
  echo "MUTATION DID NOT LAND in $file -- its result would be meaningless"
  fail=1
  return 1
}

echo "baseline:"
echo "       $(run)"
echo

# 1. No lowercasing: the query keeps the reader's case while the index is lowercase.
#    On the live machine this is 479 matches for "Documents" answered with zero.
mutate "$SEARCH" 'String(query).toLowerCase()' 'String(query)' \
  && check_red "M1 query case not folded"

# 2. Space dropped again: the index's word boundary is deleted from the query.
mutate "$SEARCH" 'if (code < 0x20) continue;' 'if (code <= 0x20) continue;' \
  && check_red "M2 space token dropped"

# 3. Phrase unquoted: a bare AND over the merged multi-column stream, which is what
#    matched 24 sessions for "trajectory" on a machine where the word occurs nowhere.
#    The anchor is the whole `map` line: it holds no `$`, so neither the shell nor
#    perl's replacement side has anything to interpret, and the landing check below
#    then verifies the quotes are actually gone.
mutate "$SEARCH" '`${column} : "${phrase}"`' '`${column} : ${phrase}`' \
  && check_red "M3 phrase unquoted (cross-column)"

# 4. Fixture drift restored: the index keeps original case, so the fixture stops
#    resembling the runtime and the lowercase assertions lose their footing.
mutate "$FIXTURE" 'String(text).toLowerCase()' 'String(text)' \
  && check_red "M4 fixture index not lowercased"

# 5. The schema guard removed: a differently-shaped index fails every query loudly
#    with a query-time "no such column" instead of degrading to a named state.
#
#    Anchored on the `goalOnly(...)` line rather than the older `return { ...EMPTY }`
#    form. §8.37 rewrote the early returns so the objective channel runs even without
#    FTS5, and the previous anchor no longer existed — which is the silent-mutation
#    shape: the tier reported "anchor missing" instead of a red, and stopped producing
#    evidence for the face it claims to guard. An anchor that stops matching is a
#    stronger finding than a mutation that survives.
mutate "$SEARCH" 'if (!searchable) return goalOnly({ unsearchable: true });' '' \
  && check_red "M5 schema guard removed"

echo
if [ "$(shasum "$SEARCH" "$FIXTURE")" != "$BASELINE_SUMS" ]; then
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