#!/usr/bin/env bash
# Mutation check for dating a turn, and for the two sources agreeing on the order.
#
# The defect: `trajectory_turns` folded each turn into `{turnId, count, llmMs,
# outputTokens, failureCount}`. The SQL already computed `MIN(created_at_ms) AS first_ms`
# — it is what the rows are *ordered by* — and the mapping step dropped it. A caller could
# see that turn 40 came after turn 39 and could not say when either happened, which is the
# whole of "progress" missing from the progress view.
#
# Publishing it exposed a second, older disagreement: the projection sorts by `first_ms`
# and the artifact returned file order. On the machine this was written against 21 of 613
# artifact files carry a record whose timestamp goes backwards, so the two paths really do
# answer with different orders — and nothing could reveal it while neither row said what
# order it was in.
#
# So the mutations below split into three families: the value not being computed, the two
# sources computing it differently, and the order one of them imposes.
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
TEST=test/turn-time.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$EVENTS" "$BAK/events.mjs"
cp "$JSONL" "$BAK/jsonl.mjs"
restore() {
  cp "$BAK/events.mjs" "$EVENTS"
  cp "$BAK/jsonl.mjs" "$JSONL"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$EVENTS" "$JSONL"; do shasum "$f"; done)

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

# A. The projection stops publishing it — the defect as it was. The aggregate is still
#    computed and still drives `ORDER BY`, so the fold is unchanged and the rows are
#    still in order; only the clock is gone.
anchor "$BAK/a.from" <<'EOF'
      firstMs: num(row.first_ms) ?? null,
EOF
: > "$BAK/a.to"
mutate "$EVENTS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the projection stops publishing the turn time"

# B. The last record's time instead of the first. The first version of this tier aimed at
#    `?? null` → `?? 0` and **survived**: `local_runtime_message_rows.created_at_ms` is
#    `NOT NULL`, so `MIN()` over a group can never be null and the two arms are
#    behaviourally identical. An equivalent mutation changes target rather than gaining a
#    fixture — the fixture would have had to contradict the schema to produce a null.
#    This one targets what the field is actually for: the field is named `firstMs`, and
#    the turn's start is its first record, not its last. The fixture's records carry
#    `at + i`, so a fold that publishes the end of the turn is distinguishable.
anchor "$BAK/b.from" <<'EOF'
        MIN(created_at_ms) AS first_ms
EOF
anchor "$BAK/b.to" <<'EOF'
        MAX(created_at_ms) AS first_ms
EOF
mutate "$EVENTS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the turn is dated by its last record instead of its first"

# C. The artifact path stops publishing it. The capability existing on one source and not
#    the other is the difference that makes the other look like it lost its timing.
anchor "$BAK/c.from" <<'EOF'
        firstMs: at,
EOF
: > "$BAK/c.to"
mutate "$JSONL" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C the artifact stops publishing the turn time"

# D. The artifact reads the timestamp from the top of the record instead of inside
#    `message`. That is a shape no real artifact has — verified against 613 files on this
#    machine, every one of which nests it — so the value silently goes null everywhere
#    while the code still looks like it is reading a timestamp.
anchor "$BAK/d.from" <<'EOF'
        const at = num(record?.message?.timestamp);
EOF
anchor "$BAK/d.to" <<'EOF'
        const at = num(record?.timestamp);
EOF
mutate "$JSONL" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the artifact reads a timestamp the runtime never writes"

# E. The artifact stops sorting. 21 of 613 real files have a record whose timestamp goes
#    backwards, so this is not a hypothetical: the same session answers with its turns in
#    a different order depending on which source was read.
anchor "$BAK/e.from" <<'EOF'
    dated.sort((a, b) => {
EOF
anchor "$BAK/e.to" <<'EOF'
    dated.sort((a, b) => {
      return a.index - b.index;
    });
    if (false) dated.sort((a, b) => {
EOF
mutate "$JSONL" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the artifact returns file order while the projection sorts"

# F. The sort puts undated turns first, on the assumption that an absent time is "early".
#    It is not early, it is unknown, and the ordering a caller reads off the list depends
#    on which end of the unknown pile they land.
anchor "$BAK/f.from" <<'EOF'
      if (a.at === null) return 1;
      if (b.at === null) return -1;
EOF
anchor "$BAK/f.to" <<'EOF'
      if (a.at === null) return -1;
      if (b.at === null) return 1;
EOF
mutate "$JSONL" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F undated turns sort to the front"

echo
if [ "$(for f in "$EVENTS" "$JSONL"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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