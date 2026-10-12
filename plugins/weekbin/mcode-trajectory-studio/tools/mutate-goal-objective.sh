#!/usr/bin/env bash
# Mutation check for the objective channel — "what was that run actually asked to do".
#
# The gap: `local_runtime_thread_goals` holds the objective the runtime kicked each run
# off with, and the plugin read none of it — `grep -rn thread_goals server/ web/ skills/
# tools/` returned nothing. On the machine this was measured on that text is the **only**
# copy: the FTS table has no objective column, and none of those sessions has a
# `messages.jsonl`. So the question had no answer anywhere in the plugin.
#
# It is not a restatement of the title. Over all 15 rows on that machine, `objective` and
# `title` share almost no vocabulary in **13** — one is titled 同步本地与远程分支代码 and was
# asked to 继续深挖当前插件的方方面面可能存在的问题. A reader inferring the task from the title is
# wrong two times in three, with nothing on any reply to say so.
#
# The tiers below are the ways this decays back into a decoration: falling back to the
# title when no goal was recorded, answering "nothing recorded" for a runtime that cannot
# tell, letting the index's own shape leak into the objective channel's answers, and
# quietly dropping the field again.
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
SEARCH=server/search.mjs
MCP=server/mcp.mjs
TEST=test/goal-tool.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$STATS" "$SEARCH" "$MCP"; do cp "$f" "$BAK/$(basename "$f")"; done
restore() {
  cp "$BAK/stats.mjs" "$STATS"
  cp "$BAK/search.mjs" "$SEARCH"
  cp "$BAK/mcp.mjs" "$MCP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$STATS" "$SEARCH" "$MCP"; do shasum "$f"; done)

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

# A. The summary falls back to the title when no goal was recorded. This is the one that
#    would have shipped by accident: 618 of the 633 sessions on the measured machine have
#    no goal row, so the fallback is on the common path, and it makes a field that is
#    usually absent look present — a reader who believes they were told what the run was
#    asked to do, having been handed the one field §8.37 measures as unreliable in 13 of
#    15 real pairs.
anchor "$BAK/a.from" <<'EOF'
    ...(goal.goal?.objective ? {
EOF
anchor "$BAK/a.to" <<'EOF'
    ...(true ? {
EOF
mutate "$STATS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a session with no goal falls back to the title" "$TEST"

# B. The objective is dropped from the summary reply entirely. Every number stays right and
#    nothing is inconsistent — that is the shape this whole feature was missing, and a
#    review that only checked for contradictions would pass it.
anchor "$BAK/b.from" <<'EOF'
    ...(goal.goal?.objective ? {
      objective: goal.goal.objective,
EOF
: > "$BAK/b.to"
mutate "$STATS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the summary stops publishing the objective" "$TEST"

# C. A missing goal table reports "no goal recorded" instead of "cannot tell". The reply
#    then looks exactly like the 618 sessions that genuinely have no goal, and a reader
#    concludes this run was never given one — which is a claim, on a runtime whose own
#    database simply does not carry the field.
anchor "$BAK/c.from" <<'EOF'
  if (!store.db || !tableExists(store.db, 'local_runtime_thread_goals')) {
    return {
      goal: null,
      available: false,
EOF
anchor "$BAK/c.to" <<'EOF'
  if (!store.db || !tableExists(store.db, 'local_runtime_thread_goals')) {
    return {
      goal: null,
      available: true,
EOF
mutate "$STATS" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C a runtime with no goal table reads as one with no goals" "$TEST"

# D. The objective channel stops running. The index finds nothing this text holds, so
#    search goes back to matching on titles alone — measured on a real machine as 0 of 15
#    goal-bearing sessions reachable by a word from their own objective.
anchor "$BAK/d.from" <<'EOF'
  const { ids } = goalObjectiveMatches(store, query);
EOF
anchor "$BAK/d.to" <<'EOF'
  const ids = [];
EOF
mutate "$SEARCH" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a run is no longer findable by what it was asked" "$TEST"

# E. The objective channel is gated behind FTS, so a machine whose bundled SQLite has no
#    index loses the one field that still works there. The channel is a plain `LIKE` scan
#    and never needed the index — this makes the strongest runtimes the only ones that can
#    search a run by its own brief.
anchor "$BAK/e.from" <<'EOF'
  if (!store.db) return goalOnly({ unsearchable: true });
  if (!store.hasFts) return goalOnly({ unsearchable: true });
EOF
anchor "$BAK/e.to" <<'EOF'
  if (!store.db) return goalOnly({ unsearchable: true });
  if (!store.hasFts) return { ...EMPTY, unsearchable: true };
EOF
mutate "$SEARCH" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E a runtime without FTS5 loses the objective channel" "$TEST"

# F. Objective matches are folded into `total`, so a reader comparing it against the rows
#    they hold is told the page is smaller than the answer. It also makes the cursor's
#    meaning depend on which of two sources happened to match — the one thing a cursor
#    must never do.
anchor "$BAK/f.from" <<'EOF'
    sessions: attachObjective(store, rows, ids),
    objectivesIndexed: true,
EOF
anchor "$BAK/f.to" <<'EOF'
    sessions: attachObjective(store, rows, ids),
    total: (rows.length) || undefined,
    objectivesIndexed: true,
EOF
mutate "$SEARCH" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F objective matches are counted into the FTS walk's total" "$TEST"

# G. A matched row stops carrying the text that matched. It still says it matched, so a
#    reader is told *that* something matched and still cannot learn what the run was asked
#    to do — which is the entire reason the channel exists.
anchor "$BAK/g.from" <<'EOF'
      return { ...row, objectiveMatched: true, objective };
EOF
anchor "$BAK/g.to" <<'EOF'
      return { ...row, objectiveMatched: true };
EOF
mutate "$SEARCH" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G a row says it matched without saying what" "$TEST"

# H. `objectivesIndexed` is dropped from the reply, so "no objective matched" and "this
#    build records no objectives" become the same empty list again.
anchor "$BAK/h.from" <<'EOF'
        objectivesIndexed: objectivesIndexed !== false,
EOF
: > "$BAK/h.to"
mutate "$MCP" "$BAK/h.from" "$BAK/h.to" \
  && check_red "H the reply stops saying whether objectives were searched" "$TEST"

# I. The objective leaves the reply unredacted. It is the most free-form text this plugin
#    publishes — whatever the user typed to start the run — so it can hold a path, a
#    branch name, a pasted snippet or a credential.
anchor "$BAK/i.from" <<'EOF'
          ...(typeof session.objective === 'string' ? { objective: redactPayload(session, options).objective ?? null } : {}),
EOF
: > "$BAK/i.to"
mutate "$MCP" "$BAK/i.from" "$BAK/i.to" \
  && check_red "I the objective skips the redaction sweep" "$TEST"

echo
if [ "$(for f in "$STATS" "$SEARCH" "$MCP"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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
