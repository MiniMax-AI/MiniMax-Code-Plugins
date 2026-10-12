#!/usr/bin/env bash
# Mutation check for the timeline's artifact fallback and its disclosure.
#
# The defect: five surfaces read a session's records and four of them fall back to the
# session's own `messages.jsonl` when the projection has no rows for it. The timeline did
# not, so for a session whose records were on disk and not indexed it answered
# `points: 0, truncated: false` — and `truncated: false` is the strongest claim this
# Plugin can make that a list is complete. The same session answered `returned: 3` from
# `trajectory_get` and `total: 1` from `trajectory_turns`.
#
# The fallback draws input markers and no model bars, because an artifact records no
# durations. That is honest and it is also a picture of a run where the model never
# answered, so the reply names its source and the panel says what the missing bars mean.
# The mutations cover the three halves separately: the fallback happening, the source
# being reported, and the reader being told.
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

HTTP=server/http.mjs
EVENTS=server/events.mjs
FLOW=web/js/flow.js
UNIT=test/timeline-fallback.test.mjs
PANEL=test/panel-flow.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$HTTP" "$BAK/http.mjs"
cp "$EVENTS" "$BAK/events.mjs"
cp "$FLOW" "$BAK/flow.js"
restore() {
  cp "$BAK/http.mjs" "$HTTP"
  cp "$BAK/events.mjs" "$EVENTS"
  cp "$BAK/flow.js" "$FLOW"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$HTTP" "$EVENTS" "$FLOW"; do shasum "$f"; done)

run() { node --test "$1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0
check_red() {
  local name="$1" suite="$2" out passed failed
  out=$(run "$suite")
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
echo "       unit   $(run "$UNIT")"
echo "       panel  $(run "$PANEL")"
echo

# A. The defect as it was: the axis never goes looking for the artifact.
anchor "$BAK/a.from" <<'EOF'
    if (sessionRows === 0) {
      const artifact = await store.readJsonlEvents({
EOF
anchor "$BAK/a.to" <<'EOF'
    if (false) {
      const artifact = await store.readJsonlEvents({
EOF
mutate "$HTTP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the axis never falls back" "$UNIT"

# B. It falls back but does not say so. The points are right and the reply is silent,
#    which is the state this Plugin calls the most confident wrong answer it can give.
anchor "$BAK/b.from" <<'EOF'
        truncated = false;
        source = 'jsonl';
EOF
anchor "$BAK/b.to" <<'EOF'
        truncated = false;
EOF
mutate "$HTTP" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the axis falls back without naming its source" "$UNIT"

# C. The fallback reads a smaller page than the axis cap and still reports the axis as
#    complete. `truncated: false` beside a partial artifact is the same confident wrong
#    answer the defect was, one page smaller.
#
#    The first version of this tier aimed at `sessionRows: store.messageRowCount(…)` →
#    `rows.length` and **survived**: the only consumer asks `=== 0`, the fold stops at a
#    cap of 6000, and `rows.length` is zero exactly when the session has no rows — so the
#    two arms are behaviourally identical for everything that reads the field. An
#    equivalent mutation changes target rather than gaining a fixture, and a fixture with
#    6,001 rows would cost a large test to prove a field nobody misreads.
anchor "$BAK/c.from" <<'EOF'
        sessionId, offset: 0, limit: LIMITS.timeline, detailLevel: 'summary',
EOF
anchor "$BAK/c.to" <<'EOF'
        sessionId, offset: 0, limit: 1, detailLevel: 'summary',
EOF
mutate "$HTTP" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C the fallback reads one page and calls the axis complete" "$UNIT"

# C2. A point from the artifact loses its time. The panel filters on
#     `Number.isFinite(point.at)`, so it would draw nothing while the reply reported the
#     points as delivered — the axis back to being empty, by another route.
anchor "$BAK/c2.from" <<'EOF'
    at: num(event.createdAtMs),
EOF
anchor "$BAK/c2.to" <<'EOF'
    at: null,
EOF
mutate "$EVENTS" "$BAK/c2.from" "$BAK/c2.to" \
  && check_red "C2 a fallback point loses the time the file recorded" "$UNIT"

# D. A duration is invented so the bars have a width. A `messages.jsonl` recorded none,
#    and a bar with an invented width is a measurement of nothing drawn to scale.
anchor "$BAK/d.from" <<'EOF'
    durationMs: null,
    thinkingMs: null,
  }));
EOF
anchor "$BAK/d.to" <<'EOF'
    durationMs: 1000,
    thinkingMs: 0,
  }));
EOF
mutate "$EVENTS" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a duration is invented for a record that had none" "$UNIT"

# E. The panel reads the field but never shows it, so the reader sees markers with no
#    bars and nothing saying what that means.
anchor "$BAK/e.from" <<'EOF'
  if (state.timelineSource && state.timelineSource !== 'sqlite') {
EOF
anchor "$BAK/e.to" <<'EOF'
  if (false && state.timelineSource && state.timelineSource !== 'sqlite') {
EOF
mutate "$FLOW" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the panel never tells the reader why the axis is bare" "$PANEL"

# F. The panel reads the field and never clears it, so one artifact-backed session tells
#    the reader that every session after it has no timings either.
anchor "$BAK/f.from" <<'EOF'
  state.timelineTruncated = false;
  state.timelineFailed = null;
  state.timelineSource = null;
EOF
anchor "$BAK/f.to" <<'EOF'
  state.timelineTruncated = false;
  state.timelineFailed = null;
EOF
mutate "$FLOW" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F the panel keeps the notice on the next session" "$PANEL"

echo
if [ "$(for f in "$HTTP" "$EVENTS" "$FLOW"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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