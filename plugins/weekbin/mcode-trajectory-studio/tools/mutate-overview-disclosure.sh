#!/usr/bin/env bash
# Mutation check for the overview route disclosing what the event route discloses.
#
# The defect: `/api/events` and `/api/overview` both publish a shape derived from the same
# message rows. The event route carried `recordsUnavailable`; the overview's embedded
# `stats` did not. Measured on a real machine, a session with a row and no records
# anywhere came back from the overview as `turns: 0, steps: 0, toolCalls: 0, events: 0`
# with no flag beside it. The panel happened to see a correct account only because it
# calls both routes — a reader of either route alone did not, and the overview is the one
# carrying the totals the header is drawn from.
#
# Two halves, and they rot separately: the route has to publish the verdict, and the panel
# has to read it from the totals as well as from the record page — so the notice survives
# a failed record page, which is exactly when a reader most needs it.
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
FLOW=web/js/flow.js
TEST=test/overview-disclosure.test.mjs
PANEL=test/panel-flow.test.mjs
PANEL_AUTH=test/http.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$HTTP" "$BAK/http.mjs"
cp "$FLOW" "$BAK/flow.js"
restore() {
  cp "$BAK/http.mjs" "$HTTP"
  cp "$BAK/flow.js" "$FLOW"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$HTTP" "$FLOW"; do shasum "$f"; done)

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
echo "       unit   $(run "$TEST")"
echo "       http   $(run "$PANEL_AUTH")"
echo

# A. The defect as it was: the overview publishes the zero-fold with nothing beside it.
anchor "$BAK/a.from" <<'EOF'
      ? { ...stats, workspaceDir: fold(stats.workspaceDir), ...(unavailable ? { recordsUnavailable: true } : {}) }
EOF
anchor "$BAK/a.to" <<'EOF'
      ? { ...stats, workspaceDir: fold(stats.workspaceDir) }
EOF
mutate "$HTTP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the overview stops disclosing it" "$TEST"

# B. The route publishes it for every session. A field that is always there and usually
#    false is a field every reader has to learn to skip, and a string test cannot tell it
#    apart from a real one.
anchor "$BAK/b.from" <<'EOF'
      ? { ...stats, workspaceDir: fold(stats.workspaceDir), ...(unavailable ? { recordsUnavailable: true } : {}) }
EOF
anchor "$BAK/b.to" <<'EOF'
      ? { ...stats, workspaceDir: fold(stats.workspaceDir), recordsUnavailable: unavailable }
EOF
mutate "$HTTP" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the field is published even when there is nothing to disclose" "$TEST"

# C. The route concludes from the row count alone and never consults the artifact — so a
#    session whose records are on disk and not indexed yet is reported as having none.
#    That is the over-claiming direction, and it is the one that trains a reader to
#    ignore the flag.
#
#    The first version of this tier aimed at `projectionRows` itself and **survived**: the
#    only consumer asks `=== 0`, so mapping every non-zero count to `null` (which means
#    "the count failed") and every zero to `0` behaves identically for everything that
#    reads the field. An equivalent mutation changes target rather than gaining a fixture.
anchor "$BAK/c.from" <<'EOF'
    unavailable = recordsUnavailable({ sessionExists: true, projectionRows, artifact });
EOF
anchor "$BAK/c.to" <<'EOF'
    unavailable = projectionRows === 0;
EOF
mutate "$HTTP" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C a session whose records are on disk is reported as having none" "$TEST"

# C2. The guard that keeps a disclosure from becoming an outage is removed. Several route
#     doubles and hand-built store objects do not carry `messageRowCount`, and without
#     this the overview answers 500 for them — a session's totals unservable because a
#     side-note could not be produced.
anchor "$BAK/c2.from" <<'EOF'
  const projectionRows = typeof store.messageRowCount === 'function'
    ? store.messageRowCount(sessionId) : null;
EOF
anchor "$BAK/c2.to" <<'EOF'
  const projectionRows = store.messageRowCount(sessionId);
EOF
mutate "$HTTP" "$BAK/c2.from" "$BAK/c2.to" \
  && check_red "C2 an optional disclosure can no longer take the route down" "$PANEL_AUTH"

# D. The panel reads the flag from the record page only. The notice then disappears
#    exactly when the record page is the thing that went wrong — which is the moment the
#    reader most needs to be told that the zeros beside them mean "not found".
anchor "$BAK/d.from" <<'EOF'
  state.eventsRecordsUnavailable = payload.stats?.recordsUnavailable === true;
EOF
: > "$BAK/d.to"
mutate "$FLOW" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the panel reads the totals but never acts on them" "$PANEL"

echo
if [ "$(for f in "$HTTP" "$FLOW"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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