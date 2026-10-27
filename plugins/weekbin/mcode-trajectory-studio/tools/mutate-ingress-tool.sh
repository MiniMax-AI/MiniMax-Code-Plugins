#!/usr/bin/env bash
# Mutation check for `trajectory_ingress` — the turns the transcript never saw.
#
# The gap: `local_runtime_turn_ingress` records every turn the runtime accepted, when it
# was taken in, what claimed it and how it ended. `local_runtime_message_rows` records
# what happened inside a turn. Neither is a subset of the other, and on the machine this
# was measured on **14 turns that failed or aborted appear in no message row at all**,
# across 7 sessions that every other tool reports with no error, no `errorMessage` and
# `warnings: []` — a clean run with the deaths nowhere in it.
#
# The tiers below are the ways this decays back into a decoration: listing only the turns
# the transcript already had, folding "the runtime cannot tell" into "nothing failed",
# inventing a reason the table does not record, attributing an unclaimed turn to the user,
# and quietly dropping the field that says a turn is missing from the transcript.
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

INGRESS=server/ingress.mjs
STATS=server/stats.mjs
MCP=server/mcp.mjs
STORE=server/store.mjs
TEST=test/ingress-tool.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$INGRESS" "$STATS" "$MCP" "$STORE"; do cp "$f" "$BAK/$(basename "$f")"; done
restore() {
  cp "$BAK/ingress.mjs" "$INGRESS"
  cp "$BAK/stats.mjs" "$STATS"
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/store.mjs" "$STORE"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$INGRESS" "$STATS" "$MCP" "$STORE"; do shasum "$f"; done)

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

# A. The list becomes the transcript's turns again — the shape this plugin already had
#    everywhere else, and the reason those turns were invisible. Anchored on the
#    transcript set being built at all, so it cannot match a different lookup.
anchor "$BAK/a.from" <<'EOF'
    const transcriptTurns = transcriptTurnIds(store, sessionId);
EOF
anchor "$BAK/a.to" <<'EOF'
    const transcriptTurns = new Set();
EOF
mutate "$INGRESS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A every turn is reported as being in the transcript" "$TEST"

# B. A missing table answers "no turns failed". This is the failure the tool most easily
#    hides: an empty list plus `failedOrAborted: 0` on a machine that cannot answer is a
#    clean bill of health — the exact reading that was wrong in the first place.
anchor "$BAK/b.from" <<'EOF'
      failedOrAborted: null,
      missingFromTranscript: null,
      degraded: 'turn intake records are unavailable: this runtime exposes no local_runtime_turn_ingress table, so this session\'s failed and aborted turns cannot be counted — the transcript alone would read as a clean run',
EOF
anchor "$BAK/b.to" <<'EOF'
      failedOrAborted: 0,
      missingFromTranscript: 0,
      degraded: null,
EOF
mutate "$INGRESS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B a runtime that cannot count reports a count of zero" "$TEST"

# C. The failure count stops distinguishing "ended badly" from "never recorded". Folding
#    them together is what §8.36 got wrong one field over: a reader is told 14 turns died
#    when 27 are merely absent, and stops trusting the number.
anchor "$BAK/c.from" <<'EOF'
      failedOrAborted,
      missingFromTranscript: transcriptTurns === null ? null : missingFromTranscript,
EOF
anchor "$BAK/c.to" <<'EOF'
      failedOrAborted: kept.length,
      missingFromTranscript: transcriptTurns === null ? null : missingFromTranscript,
EOF
mutate "$INGRESS" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C every accepted turn is reported as one that failed" "$TEST"

# D. A reason is invented for a turn that failed. The table has sixteen columns and none
#    of them says why — this would be a guess wearing a field name, and every value it
#    could print would be one.
anchor "$BAK/d.from" <<'EOF'
        inTranscript,
        attachmentCount: readAttachmentCount(row.input_metadata_json),
EOF
anchor "$BAK/d.to" <<'EOF'
        inTranscript,
        reason: 'the model rejected it',
        attachmentCount: readAttachmentCount(row.input_metadata_json),
EOF
mutate "$INGRESS" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a reason is invented for a turn the runtime records none for" "$TEST"

# E. An unclaimed turn is attributed to the user. 1,603 of 2,466 real rows have a null
#    `claim_source`, so this would misattribute the majority of them — and it is the one
#    attribution this plugin has no other basis for.
anchor "$BAK/e.from" <<'EOF'
      if (typeof row.claim_source === 'string' && row.claim_source !== '') {
        claimCounts[row.claim_source] = (claimCounts[row.claim_source] ?? 0) + 1;
      }
EOF
anchor "$BAK/e.to" <<'EOF'
      if (typeof row.claim_source === 'string' && row.claim_source !== '') {
        claimCounts[row.claim_source] = (claimCounts[row.claim_source] ?? 0) + 1;
      } else {
        claimCounts.user = (claimCounts.user ?? 0) + 1;
      }
EOF
mutate "$INGRESS" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E a turn with no claim is attributed to the user" "$TEST"

# F. The transcript lookup stops being index-usable. `IS` is SQLite's NULL-safe
#    comparison and reads the same as `COALESCE(a,'') = COALESCE(b,'')` — but wrapping
#    either side in a function stops the planner using `(session_id, turn_id, role, id)`,
#    and measured on the largest session here that is 0.8 ms against 390 ms. The guard is
#    a source assertion, because nothing a test can *observe* changed.
anchor "$BAK/f.from" <<'EOF'
          WHERE m.session_id = i.session_id AND m.turn_id IS i.turn_id
EOF
anchor "$BAK/f.to" <<'EOF'
          WHERE m.session_id = i.session_id AND COALESCE(m.turn_id, '') = COALESCE(i.turn_id, '')
EOF
mutate "$INGRESS" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F the transcript lookup stops being index-usable" "$TEST"

# G. The summary's cache key drops the intake signature. A turn that fails at intake
#    writes **no message row** and does not touch the session row, so nothing else in the
#    key moves — the same trap §8.35 found for change sets, one field over.
anchor "$BAK/g.from" <<'EOF'
    `${sessionId}|${store.messageSignature(sessionId)}|${store.changeSignature(sessionId)}|${store.ingressSignature(sessionId)}`,
EOF
anchor "$BAK/g.to" <<'EOF'
    `${sessionId}|${store.messageSignature(sessionId)}|${store.changeSignature(sessionId)}`,
EOF
mutate "$STATS" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G the summary forgets a turn that died after it was summarised" "$TEST"

# H. The summary drops the intake counts. Every other number stays right and the session
#    still reads clean — which is the state this whole tool was added to remove.
anchor "$BAK/h.from" <<'EOF'
    turnsFailedOrAborted: ingress.failedOrAborted,
EOF
: > "$BAK/h.to"
mutate "$STATS" "$BAK/h.from" "$BAK/h.to" \
  && check_red "H the summary stops admitting that turns died" "$TEST"

# I. `claimCounts` folds every source into one number. 668 of 2,466 real turns came from a
#    thread goal, and that is the whole reason the field exists: it is the only record of
#    *who asked*.
anchor "$BAK/i.from" <<'EOF'
        claimCounts[row.claim_source] = (claimCounts[row.claim_source] ?? 0) + 1;
EOF
anchor "$BAK/i.to" <<'EOF'
        claimCounts.total = (claimCounts.total ?? 0) + 1;
EOF
mutate "$INGRESS" "$BAK/i.from" "$BAK/i.to" \
  && check_red "I every claim source is folded into one number" "$TEST"

# J. The cursor stops walking: every page claims to be the last one, so a 200-turn
#    session hands back 100 rows and reports itself complete.
anchor "$BAK/j.from" <<'EOF'
      const reachable = result.available ? result.matchedTurns : 0;
      return {
        sessionId,
        available: result.available,
        // "This runtime does not record intake" and "this session's turns all succeeded"
        // are both an empty list, and only one of them is a finding. See the assets
        // tool for why the reason is named rather than left to the reader.
        ...(result.available ? {} : { note: 'turn intake records are unavailable on this runtime: it exposes no local_runtime_turn_ingress table, or the query failed — so an empty list here means "not recorded", and a session reading clean does not mean its turns succeeded' }),
        total: result.total,
        matchedTurns: result.matchedTurns,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= reachable ? null : offset + delivered,
EOF
anchor "$BAK/j.from" <<'EOF'
      const reachable = result.available ? result.matchedTurns : 0;
      return {
        sessionId,
        available: result.available,
        // "This runtime does not record intake" and "this session's turns all succeeded"
        // are both an empty list, and only one of them is a finding. See the assets
        // tool for why the reason is named rather than left to the reader.
        ...(result.available ? {} : { note: 'turn intake records are unavailable on this runtime: it exposes no local_runtime_turn_ingress table, or the query failed — so an empty list here means "not recorded", and a session reading clean does not mean its turns succeeded' }),
        total: result.total,
        matchedTurns: result.matchedTurns,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= reachable ? null : offset + delivered,
EOF
anchor "$BAK/j.to" <<'EOF'
      const reachable = result.available ? result.matchedTurns : 0;
      return {
        sessionId,
        available: result.available,
        // "This runtime does not record intake" and "this session's turns all succeeded"
        // are both an empty list, and only one of them is a finding. See the assets
        // tool for why the reason is named rather than left to the reader.
        ...(result.available ? {} : { note: 'turn intake records are unavailable on this runtime: it exposes no local_runtime_turn_ingress table, or the query failed — so an empty list here means "not recorded", and a session reading clean does not mean its turns succeeded' }),
        total: result.total,
        matchedTurns: result.matchedTurns,
        offset,
        returned: delivered,
        nextOffset: null,
EOF
mutate "$MCP" "$BAK/j.from" "$BAK/j.to" \
  && check_red "J the cursor never leaves the first page" "$TEST"

echo
if [ "$(for f in "$INGRESS" "$STATS" "$MCP" "$STORE"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
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