#!/usr/bin/env bash
# Mutation check for what the panel paints before the reader does anything.
#
# The defect this was written for is in a checker, not in the panel — which is the
# more interesting half of it. `tools/browser-check.mjs` walks a real page to click a
# background tool call's captured output, and it chose which session to click by
# asking the store whether the session's first page carried an output-bearing call.
# Three runs failed on the same assertion: "offered by no row among 69 tool rows",
# while the same report said the store had counted 27 of 181 calls as reachable.
#
# Both numbers were right. The panel fetches 200 records, but a record is a stream row
# and each of its tool calls is another, and the first paint renders at most
# `STREAM_PAGE` rows. 200 records carrying 181 calls pack to 381 rows, and the first
# output-bearing call sat at row 327. The check was asking about the store's page and
# then looking at the screen.
#
# The fix is a single definition both sides use: `web/js/rows.js`. So the tiers below
# split along the seams of that sharing. Each of them is a way for the panel and the
# check to drift apart again without either file changing anything else — the exact
# failure this module was added to end.
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

ROWS=web/js/rows.js
FLOW=web/js/flow.js
STREAM=web/js/stream.js
TEST=test/stream-first-batch.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$ROWS" "$FLOW" "$STREAM"; do
  cp "$f" "$BAK/$(basename "$f")"
done
restore() {
  cp "$BAK/rows.js" "$ROWS"
  cp "$BAK/flow.js" "$FLOW"
  cp "$BAK/stream.js" "$STREAM"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$ROWS" "$FLOW" "$STREAM"; do shasum "$f"; done)

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

# A. The message row stops being packed. A transcript with no record rows is not a
#    transcript, and every row index shifts by one per record — which is exactly how a
#    "first screen" question silently becomes a different question.
anchor "$BAK/a.from" <<'EOF'
    rows.push({ kind: 'message', event });
EOF
: > "$BAK/a.to"
mutate "$ROWS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a record is no longer a row" "$TEST"

# B. The tool rows come before the record they belong to, so the packer stops being the
#    panel's render order. Both counts survive this; only the order is wrong, which is
#    why an assertion on row *count* would have missed it.
anchor "$BAK/b.from" <<'EOF'
  for (const event of events ?? []) {
    rows.push({ kind: 'message', event });
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      rows.push({ kind: 'tool', event, call, position });
    }
  }
EOF
anchor "$BAK/b.to" <<'EOF'
  for (const event of events ?? []) {
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      rows.push({ kind: 'tool', event, call, position });
    }
    rows.push({ kind: 'message', event });
  }
EOF
mutate "$ROWS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the calls are packed before the record" "$TEST"

# C. The page bound is gone: everything in the page counts as the first screen. This is
#    the defect returning by another route — same symptom, and no test that only counts
#    rows would catch it.
anchor "$BAK/c.from" <<'EOF'
  return (rows ?? []).slice(0, Math.min(total, STREAM_PAGE));
EOF
anchor "$BAK/c.to" <<'EOF'
  return (rows ?? []).slice(0, total);
EOF
mutate "$ROWS" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C the first screen is the whole page" "$TEST"

# D. `position` is not carried. It is the index the panel uses to highlight the call a
#    tool row belongs to, so losing it leaves every row highlighting the wrong call —
#    and a count of rows is unchanged.
anchor "$BAK/d.from" <<'EOF'
      rows.push({ kind: 'tool', event, call, position });
EOF
anchor "$BAK/d.to" <<'EOF'
      rows.push({ kind: 'tool', event, call });
EOF
mutate "$ROWS" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a tool row no longer knows which call it is" "$TEST"

# E. The predicate accepts only a task that reported output inline, dropping the task-id
#    case. `inspector.js` offers the button for either, so this rejects sessions the
#    panel can open — a check that is stricter than the feature it checks.
anchor "$BAK/e.from" <<'EOF'
  return (rows ?? []).filter((row) => row.kind === 'tool' && (row.call.taskId || row.call.hasOutput));
EOF
anchor "$BAK/e.to" <<'EOF'
  return (rows ?? []).filter((row) => row.kind === 'tool' && row.call.hasOutput === true);
EOF
mutate "$ROWS" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E a task id alone no longer counts as an offer" "$TEST"

# F. `firstScreenOffersOutput` stops consulting the screen. This is the original bug,
#    reintroduced as a one-line edit, and it is the tier that says the module earns its
#    keep: with the arithmetic shared and tested, this is the only remaining seam.
anchor "$BAK/f.from" <<'EOF'
  return offeredCalls(firstRenderBatch(packStreamRows(events ?? []))).length > 0;
EOF
anchor "$BAK/f.to" <<'EOF'
  return offeredCalls(packStreamRows(events ?? [])).length > 0;
EOF
mutate "$ROWS" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F the selection stopped asking about the first screen" "$TEST"

# G. The renderer paints a bigger first batch than the helper describes. This is the
#    seam the helper exists on: `firstRenderBatch` restates `appendStreamRows`'s bound,
#    and nothing but a test that drives the real DOM stops the two from drifting. It
#    also hides behind the strongest-looking signal there is — the page still renders,
#    the button is still there after two clicks — so only a count of painted rows finds
#    it.
anchor "$BAK/g.from" <<'EOF'
  const end = Math.min(total, state.renderedRows + STREAM_PAGE);
EOF
anchor "$BAK/g.to" <<'EOF'
  const end = Math.min(total, state.renderedRows + STREAM_PAGE * 4);
EOF
mutate "$STREAM" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G the panel paints a first screen larger than the helper describes" "$TEST"

echo
if [ "$(for f in "$ROWS" "$FLOW" "$STREAM"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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
