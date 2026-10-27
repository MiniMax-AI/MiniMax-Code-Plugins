#!/usr/bin/env bash
# Shared helpers for the mutation scripts in this directory.
#
# Sourced, never run. It is named `mutation-lib.sh` rather than `mutate-lib.sh` on purpose:
# `tools/mutation-sweep.mjs` discovers scripts by the glob `mutate-*.sh`, and a helper that
# matched it would be executed as a mutation script of its own.
#
# What is here, and why each piece exists rather than being retyped per script:
#
#   anchor / anchor_inline   A file holding the literal text to look for and to write.
#                            `anchor_inline` omits the trailing newline, for an anchor that
#                            sits in the middle of a line — a heredoc always ends with one,
#                            so a mid-line anchor written with `anchor` matches nothing and
#                            reads as a missing anchor, which is a shape that already costs
#                            two ways of producing failed evidence.
#   mutate                   Whole-file replace. Requires **exactly one** match, and refuses
#                            to report a verdict when the write is not verifiably in place.
#   mutate_case              The same, scoped to one tool's `case '<name>':` block.
#   check_red                Run a suite and print RED or SURVIVED.
#
# The rule the whole thing exists to serve: **a mutation that did not apply must never be
# able to report a result.** A script that finds no anchor, or whose write is not in the
# file, has produced no evidence at all — and an evidence-free tier is indistinguishable
# from a killed one in any tally that only counts RED and SURVIVED. That is not a
# hypothetical: two tiers sat dead that way across two review rounds, and the number of
# them was only ever visible to a sweep that names its problem categories.
#
# Each tier reads `run` and `restore` from the sourcing script, so the suite and the files
# to restore stay the caller's decision.

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

# mutate_case <tool> <file> <from-file> <to-file>: as `mutate`, but the literal is replaced
# only inside that tool's `case` block.
#
# This exists because `mutate` needs its anchor to be unique in the whole file, and
# `server/mcp.mjs` publishes the *same reply shape* for more than one tool — on purpose.
# `trajectory_ingress` was written with `trajectory_changes`' `nextOffset` expression
# verbatim, which turned that script's tier B from one match into two. The tier then
# reported nothing at all, and in the tally it looked exactly like a tier that killed
# something. Anchoring on a copy-pasted expression is anchoring on something a later tool
# is entitled to duplicate; the scope has to be the tool the tier is about, which is how
# `release-gates.mjs` scopes the same job.
mutate_case() {
  local tool="$1" file="$2" from_file="$3" to_file="$4"
  python3 - "$file" "$from_file" "$to_file" "$tool" <<'PY'
import sys
path, src_path, dst_path, tool = sys.argv[1:5]
text = open(path, encoding='utf-8').read()
src = open(src_path, encoding='utf-8').read()
dst = open(dst_path, encoding='utf-8').read()
marker = f"case '{tool}':"
start = text.find(marker)
if start == -1:
    sys.exit(4)
rest = text[start:]
nxt = rest.find("\n    case '", 1)
block = rest if nxt == -1 else rest[:nxt]
if block.count(src) != 1:
    sys.exit(3)
open(path, 'w', encoding='utf-8').write(text[:start] + block.replace(src, dst) + rest[nxt if nxt != -1 else len(rest):])
PY
  local rc=$?
  if [ "$rc" -eq 4 ]; then
    echo "NO CASE BLOCK '$tool' in $file"
    echo "  -- the mutation did not apply, so its result would say nothing"
    fail=1
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "ANCHOR MISSING or AMBIGUOUS in $tool (needs exactly one match inside its case block)"
    echo "  -- the mutation did not apply, so its result would say nothing"
    fail=1
    return 1
  fi
  if [ -s "$to_file" ] && ! grep -qF -- "$(head -c 40 "$to_file")" "$file"; then
    echo "MUTATION DID NOT LAND in $tool -- its result would say nothing"
    fail=1
    return 1
  fi
  return 0
}

# check_red <name> [suite]: run a suite and report whether the mutation was caught.
check_red() {
  local name="$1" suite="${2:-$TEST}" out passed failed
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

anchor() { cat > "$1"; }

# anchor_inline <file>: `anchor` without the trailing newline, for an anchor that sits in
# the middle of a line.
anchor_inline() { printf '%s' "$(cat)" > "$1"; }