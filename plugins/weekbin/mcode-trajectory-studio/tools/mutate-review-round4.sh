#!/usr/bin/env bash
# Mutation check for the five defects raised in the fourth review round, at head `1857360`.
#
# The suite that answered that round is `test/review-round4.test.mjs`, and it passes — which
# is the weakest possible evidence on its own, because a passing suite is exactly what the
# previous three rounds produced while all five defects were live. Each of the five is a
# *confident wrong answer* rather than a crash: the reply is well-formed, the counts are
# numbers, and nothing in the shape says "this is not what you asked for".
#
# So the question this script answers is not "are the tests green" but "would they go red".
# Every tier below puts back the behaviour the reviewer described and requires the suite to
# notice. A tier that survives means the fix is real and untested, which reads identically
# to a tier that killed something in any tally counting only RED and SURVIVED.
#
# The five, in the reviewer's order:
#   1 `trajectory_tasks` advanced the cursor by the rows *read* rather than the rows
#     delivered, so a page trimmed by the byte budget answered `nextOffset: null` — "no
#     more pages" — while hundreds of tasks sat between the last delivered record and the
#     end of the session. Counted in `omitted`, unreachable from every surface.
#   2 The JSONL fallback discarded its own corruption evidence at exactly the moment it
#     mattered: a page stopped on its look-ahead record returned without the `malformed`
#     count it had accumulated, and an artifact whose lines were *all* corrupt was never
#     adopted, because adoption was gated on "did it yield an event".
#   3 The task index asked for one row past its cap to detect capping, and the read clamped
#     that request back to the cap — so `capped` was never true for any session.
#   4 `tasksOmitted` was measured against the rows this handler read rather than against the
#     session total published beside it: a session owning 5,000 tasks answered
#     `tasksOmitted: 1` against `tasksTotal: 5000` in the same payload.
#   5 A list read materialised every row `limit` allowed, and the transport answered a
#     malformed envelope with the wrong error and an empty batch with an empty reply.
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
. tools/mutation-lib.sh

MCP=server/mcp.mjs
JSONL=server/jsonl.mjs
TASKS=server/tasks.mjs
HTTP=server/http.mjs
TEST=test/review-round4.test.mjs

FILES="$MCP $JSONL $TASKS $HTTP"
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in $FILES; do cp "$f" "$BAK/$(basename "$f")"; done
restore() {
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/jsonl.mjs" "$JSONL"
  cp "$BAK/tasks.mjs" "$TASKS"
  cp "$BAK/http.mjs" "$HTTP"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in $FILES; do shasum "$f"; done)

run() { node --test "$1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

# Declared before the first tier, and not merely for tidiness: `check_red` only ever
# *assigns* to it, so a run in which every tier is killed leaves it unset — and under
# `set -u` the summary below would abort on an unbound variable and exit non-zero. The
# clean run is the one case that must report success, and an unset flag makes exactly
# that case the one that reports failure.
fail=0

echo "baseline:"
echo "       $TEST  $(run "$TEST")"
echo

# A. Defect 1. The cursor is derived from the records the reply carried. Advancing by the
#    records the store read is the defect verbatim: the trim is a second cut on top of the
#    read, and a page cut short then answers "no more pages" while `omitted` counts what it
#    cannot reach.
anchor "$BAK/a.from" <<'EOF'
      const consumed = bounded.truncated ? delivered.length : tasks.length;
EOF
anchor "$BAK/a.to" <<'EOF'
      const consumed = tasks.length;
EOF
mutate "$MCP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a trimmed task page advances by the rows read" "$TEST"

# B. Defect 2, first half. `malformed` has to travel on the early return too: a page that
#    stopped on its look-ahead record had already counted the corrupt lines it walked past,
#    and dropping the count means the count depends on where the page boundary happened to
#    fall rather than on what is on disk.
anchor "$BAK/b.from" <<'EOF'
      if (take(line)) return { events, droppedOversized, malformed: state.malformed, hasMore: true };
EOF
anchor "$BAK/b.to" <<'EOF'
      if (take(line)) return { events, droppedOversized, malformed: 0, hasMore: true };
EOF
mutate "$JSONL" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B a page stopped on its look-ahead forgets the corrupt lines behind it" "$TEST"

# C. Defect 2, second half. Gating adoption on the event count is what made a wholly corrupt
#    artifact describe itself as an empty SQLite session: the file was there, damaged, and
#    the only evidence of it was the count of lines that would not parse.
anchor "$BAK/c.from" <<'EOF'
  return artifact.source === 'jsonl' || (Array.isArray(artifact.events) && artifact.events.length > 0);
EOF
anchor "$BAK/c.to" <<'EOF'
  return Array.isArray(artifact.events) && artifact.events.length > 0;
EOF
mutate "$JSONL" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C an artifact that yielded no event is not evidence of anything" "$TEST"

# D. Defect 3. `capped` measured against the page cannot be true for any session, because
#    the read clamped the look-ahead request back to the cap before the comparison. The
#    consequence is not a missing flag: the oldest tasks silently resolve to no timing at
#    all, which is a claim about the run rather than an omission the reader can see.
anchor "$BAK/d.from" <<'EOF'
    const capped = total > tasks.length;
EOF
anchor "$BAK/d.to" <<'EOF'
    const capped = tasks.length > LIMITS.tasks.max;
EOF
mutate "$TASKS" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the task index cannot report being capped" "$TEST"

# E. Defect 4. The omission count has to be measured against the same total it is published
#    next to. Measured against the read window it is arithmetically correct and useless:
#    `tasksOmitted: 1` beside `tasksTotal: 5000`, and the smaller number is the one a client
#    trusts.
anchor "$BAK/e.from" <<'EOF'
    tasksOmitted: Math.max(0, tasksTotal - boundedTasks.items.length),
EOF
anchor "$BAK/e.to" <<'EOF'
    tasksOmitted: Math.max(0, taskRows.length - boundedTasks.items.length),
EOF
mutate "$HTTP" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E omissions are counted against the read window, not the session" "$TEST"

# F. Defect 5, first half. The read cap is what bounds how many unbounded descriptions and
#    commands one request can make the process hold, before any egress trimming happens. A
#    cap applied after materialisation is not a cap.
anchor "$BAK/f.from" <<'EOF'
      const readLimit = Math.min(wanted, TASK_LIST_MAX_ROWS);
EOF
anchor "$BAK/f.to" <<'EOF'
      const readLimit = wanted;
EOF
mutate "$MCP" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F one request can materialise every row the caller asked for" "$TEST"

# G. Defect 5, second half. An empty batch is one invalid request, not an empty reply: a
#    caller that sent nothing and got nothing back cannot tell a conforming server from one
#    that never read its message.
anchor "$BAK/g.from" <<'EOF'
  if (message.length === 0) return rpcError(null, -32600, 'Invalid Request');
EOF
anchor "$BAK/g.to" <<'EOF'
  if (message.length === 0) return [];
EOF
mutate "$MCP" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G an empty batch is answered with an empty reply" "$TEST"

echo
if [ "$(for f in $FILES; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- one of the four files differs from where the run started"
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