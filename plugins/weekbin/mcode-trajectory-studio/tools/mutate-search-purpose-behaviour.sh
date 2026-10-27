#!/usr/bin/env bash
# Mutation check for the promise that a dispatch objective is searchable.
#
# The `trajectory_search` description makes the strongest content-search claim this Plugin
# has: a sub-agent's dispatch objective is in the FTS index, "so a word from it matches a
# session whose title never mentions it". On the machine this was written against 439 of
# 633 sessions carry a purpose, so it is two thirds of the corpus.
#
# What tested it before was `SEARCHABLE_COLUMNS.includes('purpose_terms')` — a claim about
# a JavaScript array rather than about the index. Printing the column name correctly is
# exactly what happens when the capability has quietly stopped existing, and the fixture
# could not even express the state: `purpose_terms` was written as `''` for every session
# ever created, so no test could ask for a searchable objective.
#
# The fixture now sets `purpose`, and these mutations go after the links that were broken:
# the fixture's own index write, the tokeniser it is handed, and the constant the query is
# built from. The last of those is what the old test covered; the first two are what it
# could not reach.
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

FIXTURE=tools/fixture.mjs
CONFIG=server/config.mjs
SEARCH=server/search.mjs
TEST=test/search-purpose-behaviour.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$FIXTURE" "$BAK/fixture.mjs"
cp "$SEARCH" "$BAK/search.mjs"
restore() {
  cp "$BAK/fixture.mjs" "$FIXTURE"
  cp "$BAK/search.mjs" "$SEARCH"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$FIXTURE" "$SEARCH"; do shasum "$f"; done)

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

# mutate <file> <from-file> <to-file>: each file holds the literal text to find and to write.
mutate() {
  local file="$1" from_file="$2" to_file="$3"
  python3 - "$file" "$from_file" "$to_file" <<'PY'
import sys
path, src_path, dst_path = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
src = open(src_path, encoding='utf-8').read()
dst = open(dst_path, encoding='utf-8').read()
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
  if [ -s "$to_file" ] && ! grep -qF -- "$(head -c 40 "$to_file")" "$file"; then
    echo "MUTATION DID NOT LAND in $file -- its result would say nothing"
    fail=1
    return 1
  fi
  return 0
}

anchor() { cat > "$1"; }

echo "baseline:"
echo "       $(run)"
echo

# A. The fixture stops writing the column — back to the state this file was written
#    against. Every purpose-search case goes red at once, which is the point: the old
#    constant assertion could not have seen this, because nothing about the array changed.
anchor "$BAK/a.from" <<'EOF'
      `).run(id, encodeFtsTerms(id), encodeFtsTerms(agent), encodeFtsTerms(title),
        encodeFtsTerms(workspaceDir), encodeFtsTerms(purpose), encodeFtsTerms(status));
EOF
anchor "$BAK/a.to" <<'EOF'
      `).run(id, encodeFtsTerms(id), encodeFtsTerms(agent), encodeFtsTerms(title),
        encodeFtsTerms(workspaceDir), '', encodeFtsTerms(status));
EOF
mutate "$FIXTURE" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the fixture stops indexing the dispatch objective"

# B. The objective is indexed raw instead of tokenised, so the hyphenated identifier the
#    runtime writes comes back as one term that no ordinary query can match. The
#    capability still exists — the column name is still printed — which is why only a
#    behavioural test sees this.
anchor "$BAK/b.from" <<'EOF'
        encodeFtsTerms(workspaceDir), encodeFtsTerms(purpose), encodeFtsTerms(status));
EOF
anchor "$BAK/b.to" <<'EOF'
        encodeFtsTerms(workspaceDir), purpose, encodeFtsTerms(status));
EOF
mutate "$FIXTURE" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the objective is indexed without being tokenised"

# C. The constant stops naming the column. This is the one the old assertion covered, kept
#    so the file also pins the half that rots the other way — documentation that stops
#    promising a capability which still works.
anchor "$BAK/c.from" <<'EOF'
  'purpose_terms',
EOF
: > "$BAK/c.to"
mutate "$SEARCH" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C the searchable columns stop naming purpose"

echo
if [ "$(for f in "$FIXTURE" "$SEARCH"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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