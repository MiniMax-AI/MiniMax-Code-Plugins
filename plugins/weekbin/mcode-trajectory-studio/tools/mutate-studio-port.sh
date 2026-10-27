#!/usr/bin/env bash
# Mutation check for telling the caller when the panel is not on the port it asked for.
#
# The defect: `trajectory_studio` takes a `port`, and `listenOnFreePort` refuses to fail
# on a busy one — it moves to an ephemeral port and answers, which is right. The comment
# above that write names exactly what moving is not enough to solve: "something else is
# already serving the requested one, so the old panel keeps answering and the reader is
# looking at stale code". It then reported the move only to `process.stderr`. The operator
# saw it; the caller did not. The reply carried a working URL on a different port and no
# word about it, with the capability note the only string in it — the exact shape that
# reads as "done what you asked".
#
# The mutations attack the two halves separately, because they rot separately: the studio
# has to report *what it actually bound*, and the tool has to put that in the reply. A
# mutation that only silenced the note would also pass if the studio never reported.
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
MCP=server/mcp.mjs
TEST=test/studio-port.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$HTTP" "$BAK/http.mjs"
cp "$MCP" "$BAK/mcp.mjs"
restore() {
  cp "$BAK/http.mjs" "$HTTP"
  cp "$BAK/mcp.mjs" "$MCP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$HTTP" "$MCP"; do shasum "$f"; done)

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

# A. The tool stops appending. The defect as it was: stderr got the warning, the reply
#    did not, and the capability note was the only thing in it.
anchor "$BAK/a.from" <<'EOF'
      if (started.portHonoured === false) {
EOF
anchor "$BAK/a.to" <<'EOF'
      if (false) {
EOF
mutate "$MCP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the reply no longer says the port moved"

# B. The note reports the move without naming the port that was asked for. A reader told
#    "it moved" still does not know what the panel they were looking at was on.
anchor "$BAK/b.from" <<'EOF'
          : `port ${started.requestedPort} was requested but is in use by something else, so this panel is on ${started.port}`);
EOF
anchor "$BAK/b.to" <<'EOF'
          : `the requested port is in use, so the panel is on another port entirely (${started.port})`);
EOF
mutate "$MCP" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the note reports the move without saying which port"

# C. Reuse is reported in the words for the occupied case. Both are "you asked for X, you
#    got Y", and they need different words: on the second one the other panel is *this*
#    panel, and replacing it would invalidate a URL the caller may already hold open.
anchor "$BAK/c.from" <<'EOF'
        notes.push(started.reused
EOF
anchor "$BAK/c.to" <<'EOF'
        notes.push(!started.reused
EOF
mutate "$MCP" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C reuse is reported in the words for the occupied case"

# D. The second fact replaces the capability note instead of joining it. The capability
#    note is why the URL is safe to hand over at all; trading it for a port warning is
#    not a trade anybody asked for.
anchor "$BAK/d.from" <<'EOF'
        note: notes.join(' '),
EOF
anchor "$BAK/d.to" <<'EOF'
        note: started.portHonoured === false ? notes[notes.length - 1] : notes[0],
EOF
mutate "$MCP" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the port sentence displaces the capability note"

# E. The studio stops reporting whether it honoured the request, which is the other half
#    of the same contract: the tool can only say what the studio told it.
anchor "$BAK/e.from" <<'EOF'
    port = await listenOnFreePort(server, Number.isInteger(requested) ? requested : null);
EOF
anchor "$BAK/e.to" <<'EOF'
    port = await listenOnFreePort(server, Number.isInteger(requested) ? requested : null);
    // MUTATION: pretend the request was always honoured.
    wanted = port;
EOF
mutate "$HTTP" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the studio always claims it honoured the requested port"

echo
if [ "$(for f in "$HTTP" "$MCP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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