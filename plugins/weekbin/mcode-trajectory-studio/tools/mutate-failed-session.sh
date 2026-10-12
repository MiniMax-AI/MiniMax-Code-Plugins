#!/usr/bin/env bash
# Mutation check for carrying a failed session's reason into its summary.
#
# The defect: the session row carries `status` and `error_message`, and `sessionSummary`
# — the mapper behind `trajectory_list`, `trajectory_search` and `/api/sessions` —
# publishes both. `stats.mjs` republished seven fields off that same row and dropped the
# eighth, so `trajectory_summary` answered "what happened to this run?" with
# `status: 'error'` and nothing else. On the machine this was found on, 43 sessions carry
# an error, and the messages are specific enough to act on: `ENOSPC: no space left on
# device, write`, `Mandatory V2 Agent prompt is missing: _v2/…`, `BYOK provider …
# upstream error: The value of the enable_thinking parameter is restricted to True.`
#
# A status word is read as an answer, so the mutation below attacks the *carrying*, not
# the wording: renaming the field, reordering it, or moving the comment all leave the
# behaviour intact and are not mutations at all.
#
# Anchors are read from quoted heredoc files because these lines carry backticked
# identifiers and an em-dashed ellipsis that do not survive a multi-line single-quoted
# shell argument.
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

STATS=server/stats.mjs
SESSIONS=server/sessions.mjs
TEST=test/failed-session.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$STATS" "$BAK/stats.mjs"
cp "$SESSIONS" "$BAK/sessions.mjs"
restore() {
  cp "$BAK/stats.mjs" "$STATS"
  cp "$BAK/sessions.mjs" "$SESSIONS"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$STATS" "$SESSIONS"; do shasum "$f"; done)

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

# A. The defect as it was: the fold publishes the status and drops the reason.
anchor "$BAK/a.from" <<'EOF'
    ...(typeof session.errorMessage === 'string' && session.errorMessage.length > 0
      ? { errorMessage: session.errorMessage } : {}),
EOF
: > "$BAK/a.to"
mutate "$STATS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the fold drops the reason and publishes only the status"

# B. The field is published for every session, empty when there is nothing to say. This
#    is the tempting second fix, and it is worse than silence: a field that is present
#    and empty on every healthy session is one every reader has to learn to skip, and a
#    string test cannot tell it apart from a real one.
anchor "$BAK/b.from" <<'EOF'
    ...(typeof session.errorMessage === 'string' && session.errorMessage.length > 0
      ? { errorMessage: session.errorMessage } : {}),
EOF
anchor "$BAK/b.to" <<'EOF'
    errorMessage: typeof session.errorMessage === 'string' ? session.errorMessage : '',
EOF
mutate "$STATS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the field is published even when there is no message"

# C. The presence test stops distinguishing an empty message from a real one, so an
#    `error_message` column the runtime wrote as '' arrives as a message that says
#    nothing — present, and indistinguishable from the real thing to any string check.
anchor "$BAK/c.from" <<'EOF'
    ...(typeof session.errorMessage === 'string' && session.errorMessage.length > 0
      ? { errorMessage: session.errorMessage } : {}),
EOF
anchor "$BAK/c.to" <<'EOF'
    ...(typeof session.errorMessage === 'string'
      ? { errorMessage: session.errorMessage } : {}),
EOF
mutate "$STATS" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C an empty message is published as if it were one"

# D. The mapper stops sweeping the text. The list and the search have always swept it —
#    a failed run's error text routinely quotes the command that failed, which is how a
#    key reaches an error string — so this mutation does not make the summary match the
#    list, it makes it an egress the list never had.
anchor "$BAK/d.from" <<'EOF'
    errorMessage: redactText(col('error_message', null)),
EOF
anchor "$BAK/d.to" <<'EOF'
    errorMessage: col('error_message', null),
EOF
mutate "$SESSIONS" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the session mapper stops sweeping the error text"

echo
if [ "$(for f in "$STATS" "$SESSIONS"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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