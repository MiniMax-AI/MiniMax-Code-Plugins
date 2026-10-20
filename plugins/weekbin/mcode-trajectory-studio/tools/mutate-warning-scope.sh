#!/usr/bin/env bash
# Mutation check for scoping a store warning ring to the call that produced it.
#
# The defect: a tool's reply published either the whole ring or nothing, so a warning
# raised by an *earlier* read was presented as this answer's omission — and a failure
# this call actually had was dropped.
#
# Anchors are read from files rather than written inline. Two reasons, both learned the
# hard way: the lines carry backticked identifiers that do not survive a multi-line
# single-quoted shell argument, and every one of these lines now appears **twice** in
# `mcp.mjs` because `trajectory_tasks` adopted the same idiom. An inline one-liner that
# used to be unique became ambiguous the moment a second tool joined, and the script
# reported `ANCHOR MISSING` for all four mutations — which is the helper working, but it
# means this file had stopped producing evidence for `trajectory_list` without anyone
# noticing. Each anchor below therefore names the comment that introduces its tool.
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

MCP=server/mcp.mjs
TEST=test/warning-scope.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$MCP" "$BAK/mcp.mjs"
restore() { cp "$BAK/mcp.mjs" "$MCP"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$MCP")

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

# mutate <from-file> <to-file>: each file holds the literal text to look for and to write.
mutate() {
  local from_file="$1" to_file="$2"
  python3 - "$MCP" "$from_file" "$to_file" <<'PY'
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
    echo "ANCHOR MISSING or AMBIGUOUS in $MCP (needs exactly one match)"
    echo "  -- the mutation did not apply, so its result would say nothing"
    fail=1
    return 1
  fi
  if ! grep -qF -- "$(head -c 40 "$to_file")" "$MCP"; then
    echo "MUTATION DID NOT LAND in $MCP -- its result would say nothing"
    fail=1
    return 1
  fi
  return 0
}

anchor() { cat > "$1"; }

echo "baseline:"
echo "       $(run)"
echo

# A. The whole ring is published again: one earlier failure tags every later list.
anchor "$BAK/a.from" <<'EOF'
        // What the store said while answering, and only that: a drop caused by an earlier
        // read is not this answer's omission, and `trajectory_list` works the same slice
        // out of the same ring.
        warnings: store.warnings.slice(from),
EOF
anchor "$BAK/a.to" <<'EOF'
        // What the store said while answering, and only that: a drop caused by an earlier
        // read is not this answer's omission, and `trajectory_list` works the same slice
        // out of the same ring.
        warnings: store.warnings,
EOF
mutate "$BAK/a.from" "$BAK/a.to" && check_red "A the ring is published whole again"

# B. The slice starts at the mark and forgets that the ring may have overflowed. Only
#    observable once the ring is full — which is why the test that catches this fills it.
#    Named by the same task-reply comment, so it keeps testing this tool's slice rather
#    than whichever of the two matches first.
anchor "$BAK/b.from" <<'EOF'
      const omitted = Math.max(0, total - delivered.length);
      const droppedHere = store.warningsDropped - droppedAt;
      const from = Math.max(0, warnedAt - droppedHere);
EOF
anchor "$BAK/b.to" <<'EOF'
      const omitted = Math.max(0, total - delivered.length);
      const droppedHere = store.warningsDropped - droppedAt;
      const from = warnedAt;
EOF
mutate "$BAK/b.from" "$BAK/b.to" && check_red "B the slice ignores entries this call pushed out"

# C. The field is emptied rather than scoped — the other tempting fix. Every failure this
#    reply had of its own would now look clean.
anchor "$BAK/c.from" <<'EOF'
        // out of the same ring.
        warnings: store.warnings.slice(from),
EOF
anchor "$BAK/c.to" <<'EOF'
        // out of the same ring.
        warnings: [],
EOF
mutate "$BAK/c.from" "$BAK/c.to" && check_red "C the field is silenced instead of scoped"

# D. The drop counter goes back to the cumulative value, so the number disagrees with the
#    array it explains.
anchor "$BAK/d.from" <<'EOF'
        // out of the same ring.
        warnings: store.warnings.slice(from),
        ...(store.warningsDropped > droppedAt
          ? { warningsDropped: store.warningsDropped - droppedAt } : {}),
EOF
anchor "$BAK/d.to" <<'EOF'
        // out of the same ring.
        warnings: store.warnings.slice(from),
        ...(store.warningsDropped > 0 ? { warningsDropped: store.warningsDropped } : {}),
EOF
mutate "$BAK/d.from" "$BAK/d.to" && check_red "D the drop count is cumulative again"

echo
if [ "$(shasum "$MCP")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- $MCP differs from where the run started"
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