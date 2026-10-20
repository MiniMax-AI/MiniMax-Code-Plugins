#!/usr/bin/env bash
# Mutation check for the byte count the panel prints beside a truncated read.
#
# `payload.bytes` is the size of the file on disk; the read is bounded by `maxBytes`. The
# panel printed the first as the second, so on a real 50791-byte task it announced
# 「仅显示末尾 50791 字节」 while the text on screen was the last 16384. A bounded read
# whose bound is not stated is not a finding, it is a decoration on a string.
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

INSPECTOR=web/js/inspector.js
TEST=test/task-output-notice.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK/web/js"
cp "$INSPECTOR" "$BAK/web/js/inspector.js"
restore() { cp "$BAK/web/js/inspector.js" "$INSPECTOR"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$INSPECTOR")

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

# A. The original defect: the file's size printed as the shown count.
mutate "$INSPECTOR" \
  "  const shown = Math.min(payload.bytes, maxBytes);" \
  "  const shown = payload.bytes;" \
  && check_red "A the file size is printed as the shown count again"

# B. The bound stated as a constant rather than the one asked for. The first case passes
#    with a hardcoded 65536, so this is what keeps the count tied to the request.
mutate "$INSPECTOR" \
  "  const shown = Math.min(payload.bytes, maxBytes);" \
  "  const shown = Math.min(payload.bytes, 65536);" \
  && check_red "B the count follows a constant instead of the requested limit"

# C. The tail notice dropped, so a bounded read looks like a whole one — the reader is
#    not told the output starts mid-file at all.
mutate "$INSPECTOR" \
  "  if (!payload.truncated) return payload.text || '该任务没有捕获输出。';" \
  "  if (!payload.truncated) return payload.text || '该任务没有捕获输出。';
  if (payload.truncated) return payload.text;" \
  && check_red "C a truncated read is presented without saying it is one"

# D. The file size dropped from the sentence, which leaves the shown count with nothing
#    to be measured against — the reader can no longer tell a bound from the whole file.
mutate "$INSPECTOR" \
  "  return \`\${payload.text}\n\n…（仅显示末尾 \${shown} 字节，共 \${payload.bytes}）\`;" \
  "  return \`\${payload.text}\n\n…（仅显示末尾 \${shown} 字节）\`;" \
  && check_red "D the shown count is stated with nothing to compare it to"

echo
if [ "$(shasum "$INSPECTOR")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- the file differs from where the run started"
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