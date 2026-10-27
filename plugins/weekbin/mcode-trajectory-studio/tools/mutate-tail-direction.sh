#!/usr/bin/env bash
# Mutation check for the direction of a length bound on a tail read.
#
# The defect: `readTaskOutput` deliberately reads the *tail* of a task's `output.log`
# (`start = size - limit`), because the answer to "why did this task fail" is at the
# end. One layer up the egress sweep bounded that text by characters and kept the
# **head**. Past 64000 characters the second bound silently undid the first: on a real
# 2,725,910-byte log, `maxBytes: 262144` came back 70554 characters short of the file's
# last line, while `maxBytes: 16384` — a smaller request — contained it. Asking for more
# returned less of the newest output.
#
# Every mutation below changes the *direction* or *accounting* of the bound. A mutation
# that only shortened the text would not be testing this defect: the defect is not that
# characters were dropped, it is which end they were dropped from.
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

REDACT=server/redact.mjs
MCP=server/mcp.mjs
HTTP=server/http.mjs
TEST=test/tail-direction.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$REDACT" "$BAK/redact.mjs"
cp "$MCP" "$BAK/mcp.mjs"
cp "$HTTP" "$BAK/http.mjs"
restore() {
  cp "$BAK/redact.mjs" "$REDACT"
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/http.mjs" "$HTTP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$REDACT" "$MCP" "$HTTP"; do shasum "$f"; done)

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

# A. The defect as it was: the bound keeps the head of a tail read.
mutate "$REDACT" \
  "  const kept = keep === 'tail' ? body.slice(body.length - maxLength) : body.slice(0, maxLength);" \
  '  const kept = body.slice(0, maxLength);' \
  && check_red "A the bound keeps the head of a tail read"

# B. The same defect with the option still honoured elsewhere — the bound takes the
#    tail from a length that is off by one, which keeps a tail-shaped reply that is
#    missing its final character. The exact form a later "tidy-up" would produce.
mutate "$REDACT" \
  "  const kept = keep === 'tail' ? body.slice(body.length - maxLength) : body.slice(0, maxLength);" \
  '  const kept = keep === '"'"'tail'"'"' ? body.slice(body.length - maxLength - 1) : body.slice(0, maxLength);' \
  && check_red "B the tail bound is off by one character"

# C. `keep` is accepted and then ignored: the signature takes it, the body never reads
#    it. This is the shape of a silently dropped option, and it is the one that would
#    survive a reviewer who only reads the call sites.
mutate "$REDACT" \
  'function boundLength(text, maxLength, keep = '"'"'head'"'"') {' \
  "function boundLength(text, maxLength, keep = 'head') {
  keep = 'head';" \
  && check_red "C keep is accepted and then ignored"

# D. The MCP surface stops asking for a tail, which is the defect one layer up: the
#    call site is correct again but the tail read it wraps is not preserved.
mutate "$MCP" \
  "redactText(output.text, { maxLength: 64000, keep: 'tail', homeDir, roots: redactRoots })" \
  "redactText(output.text, { maxLength: 64000, homeDir, roots: redactRoots })" \
  && check_red "D the MCP sweep stopped keeping the tail"

# E. And the same on the panel route, where the margin between the byte ceiling and the
#    character cap is only the read's own prefix — small enough that the direction is
#    the only thing holding it together.
mutate "$HTTP" \
  "redactText(output.text, { maxLength: 262144, keep: 'tail', homeDir, roots: redactRoots })" \
  "redactText(output.text, { maxLength: 262144, homeDir, roots: redactRoots })" \
  && check_red "E the panel sweep stopped keeping the tail"

# F. The marker stops accounting for what it removed. The text is right and the
#    disclosure is wrong — which is the failure mode where a reader believes a number
#    that no longer describes anything.
mutate "$REDACT" \
  '  return `${kept}\n… [truncated ${omitted} chars]`;' \
  '  return `${kept}\n… [truncated ${Math.floor(omitted / 2)} chars]`;' \
  && check_red "F the marker under-reports what was dropped"

echo
if [ "$(for f in "$REDACT" "$MCP" "$HTTP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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