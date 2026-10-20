#!/usr/bin/env bash
# Mutation check for disclosing that a session's records are not readable anywhere.
#
# The defect: the projection holds a `local_runtime_sessions` row for every session the
# runtime has heard of, and message rows only for the ones it has indexed. On the machine
# this was found on, 18 sessions were in the first state and not the second — every one at
# least a week old, twelve of them archived, several titled after work that plainly
# happened. Every surface answered them with clean emptiness: `turns: 0, steps: 0,
# toolCalls: 0`, `source: 'sqlite', total: 0`, no note, no flag, no warning. A correct
# count of nothing, which is the shape a reader treats as an answer.
#
# Every mutation below attacks one of the three things the disclosure is made of — that
# the session exists, that the count is zero, and that nothing readable was found
# elsewhere — or one of the four surfaces that has to publish it. A mutation that only
# renamed the field would test nothing: the defect is not what the field is called, it
# is that the reply said nothing at all.
#
# Anchors are read from quoted heredoc files rather than written inline, because these
# lines carry backticked identifiers and Chinese text that do not survive a multi-line
# single-quoted shell argument. Each anchor also carries enough surrounding context to
# stay unique: `...(unavailable ? { recordsUnavailable: true } : {})` appears in both the
# summary and the turn list at the same indent, and an anchor that matched the wrong one
# would report evidence for a surface it never touched.
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

JSONL=server/jsonl.mjs
STORE=server/store.mjs
MCP=server/mcp.mjs
HTTP=server/http.mjs
FLOW=web/js/flow.js
UNIT=test/unavailable-records.test.mjs
PANEL=test/panel-flow.test.mjs

BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$JSONL" "$STORE" "$MCP" "$HTTP" "$FLOW"; do
  cp "$f" "$BAK/$(basename "$f")"
done
restore() {
  cp "$BAK/jsonl.mjs" "$JSONL"
  cp "$BAK/store.mjs" "$STORE"
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/http.mjs" "$HTTP"
  cp "$BAK/flow.js" "$FLOW"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$JSONL" "$STORE" "$MCP" "$HTTP" "$FLOW"; do shasum "$f"; done)

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
echo "       unit  $(run "$UNIT")"
echo "       panel $(run "$PANEL")"
echo

# A. The existence guard is dropped. `/api/events` takes its id from the query string and
#    never resolves it first, so without this an id nobody has ever heard of is reported
#    as a session whose records went missing — a second wrong answer beside the first.
anchor "$BAK/a.from" <<'EOF'
  if (sessionExists !== true) return false;
  if (projectionRows !== 0) return false;
EOF
anchor "$BAK/a.to" <<'EOF'
  if (projectionRows !== 0) return false;
EOF
mutate "$JSONL" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A an unknown session is reported as one missing records" "$UNIT"

# B. The count guard is widened to "not a positive count", so a count that *failed* —
#    which is null — is read as a count of zero. A store that could not look would then
#    be reported as one that looked and found nothing.
anchor "$BAK/b.from" <<'EOF'
  if (projectionRows !== 0) return false;
  return !hasArtifactEvidence(artifact);
EOF
anchor "$BAK/b.to" <<'EOF'
  if (!(projectionRows > 0)) return false;
  return !hasArtifactEvidence(artifact);
EOF
mutate "$JSONL" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B a count that failed is read as a count of zero" "$UNIT"

# C. The artifact is ignored, so a session whose records are on disk is reported as
#    having none. The fallback path is what makes the "unavailable" answer honest; a
#    disclosure that outran the fallback would be worse than the silence.
anchor "$BAK/c.from" <<'EOF'
  return !hasArtifactEvidence(artifact);
}
EOF
anchor "$BAK/c.to" <<'EOF'
  return true;
}
EOF
mutate "$JSONL" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C a session whose records are on disk is reported as having none" "$UNIT"

# D. `messageRowCount` folds its own failure into zero — the exact error this predicate
#    exists to survive, one layer down.
anchor "$BAK/d.from" <<'EOF'
      ).get(sessionId);
      return num(row?.n) ?? 0;
    } catch {
      return null;
    }
EOF
anchor "$BAK/d.to" <<'EOF'
      ).get(sessionId);
      return num(row?.n) ?? 0;
    } catch {
      return 0;
    }
EOF
mutate "$STORE" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a failed row count comes back as zero" "$UNIT"

# E. The summary stops publishing it. Named by the following line so the anchor keeps
#    targeting the summary rather than whichever of the two emits matches first.
anchor "$BAK/e.from" <<'EOF'
        ...(unavailable ? { recordsUnavailable: true } : {}),
        ...(inArtifact ? { recordsInArtifact: true } : {}),
EOF
anchor "$BAK/e.to" <<'EOF'
        ...(inArtifact ? { recordsInArtifact: true } : {}),
EOF
mutate "$MCP" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the summary stops disclosing it" "$UNIT"

# F. The other side of the summary: the case where the records *are* on disk and the
#    fold could not see them. Without this the summary reads as a contradiction of the
#    two list tools that went on to list those same records.
anchor "$BAK/f.from" <<'EOF'
        inArtifact = !unavailable && artifact.available;
EOF
anchor "$BAK/f.to" <<'EOF'
        inArtifact = false;
EOF
mutate "$MCP" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F a summary that folded nothing no longer says the records are on disk" "$UNIT"

# G. The turn list stops publishing it, identified by the comment beneath it.
anchor "$BAK/g.from" <<'EOF'
        ...(unavailable ? { recordsUnavailable: true } : {}),
        // Read straight off the same grouping `trajectory_get`'s `turnId` filter uses,
EOF
anchor "$BAK/g.to" <<'EOF'
        // Read straight off the same grouping `trajectory_get`'s `turnId` filter uses,
EOF
mutate "$MCP" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G the turn list stops disclosing it" "$UNIT"

# H. The record read stops publishing it.
anchor "$BAK/h.from" <<'EOF'
        }) ? { recordsUnavailable: true } : {})),
        events: bounded.items,
EOF
anchor "$BAK/h.to" <<'EOF'
        }) ? {} : {})),
        events: bounded.items,
EOF
mutate "$MCP" "$BAK/h.from" "$BAK/h.to" \
  && check_red "H the record read stops disclosing it" "$UNIT"

# I. A read that *failed* is also claimed to have found nothing. The `error` field
#    already says the Plugin never got to look, so the reply would carry both findings
#    and they contradict each other.
anchor "$BAK/i.from" <<'EOF'
        ...(page.source === 'error' ? {} : (recordsUnavailable({
EOF
anchor "$BAK/i.to" <<'EOF'
        ...(true ? {} : (recordsUnavailable({
EOF
mutate "$MCP" "$BAK/i.from" "$BAK/i.to" \
  && check_red "I a failed read is also claimed to have found nothing" "$UNIT"

# J. The panel route stops disclosing it, so the reader is left with an empty reader and
#    no statement that the records were never found.
anchor "$BAK/j.from" <<'EOF'
      }) ? { recordsUnavailable: true } : {}),
      events: bounded.items,
    };
EOF
anchor "$BAK/j.to" <<'EOF'
      }) ? {} : {}),
      events: bounded.items,
    };
EOF
mutate "$HTTP" "$BAK/j.from" "$BAK/j.to" \
  && check_red "J the panel route stops disclosing it" "$UNIT"

# M. The search stops disclosing it. It is the worst of the four to lose, because
#    `total: 0` from a search is read as a claim about the content — the query is absent
#    from this run — when no record was ever looked at. Measured on the machine this was
#    found on, the query `the` matches 22,207 records of a real session and zero of an
#    unreadable one.
anchor "$BAK/m.from" <<'EOF'
        }) ? { recordsUnavailable: true } : {})),
        matches: bounded.items,
EOF
anchor "$BAK/m.to" <<'EOF'
        }) ? {} : {})),
        matches: bounded.items,
EOF
mutate "$MCP" "$BAK/m.from" "$BAK/m.to" \
  && check_red "M the search stops disclosing it" "$UNIT"

# N. The same, aimed at the guard rather than the field: a failed search is also claimed
#    to have found nothing, so the reply carries `error` and `recordsUnavailable` at once
#    and the two findings contradict each other.
anchor "$BAK/n.from" <<'EOF'
        ...(found.source === 'error' ? {} : (recordsUnavailable({
EOF
anchor "$BAK/n.to" <<'EOF'
        ...(true ? {} : (recordsUnavailable({
EOF
mutate "$MCP" "$BAK/n.from" "$BAK/n.to" \
  && check_red "N a failed search is also claimed to have found nothing" "$UNIT"

# K. The panel never reads the flag, so the notice cannot appear however the server
#    answers.
anchor "$BAK/k.from" <<'EOF'
    if (payload.recordsUnavailable === true) state.eventsRecordsUnavailable = true;
EOF
: > "$BAK/k.to"
mutate "$FLOW" "$BAK/k.from" "$BAK/k.to" \
  && check_red "K the panel never reads the flag" "$PANEL"

# L. The panel reads the flag and never clears it, so a reader who opened one unreadable
#    session is told every session afterwards has lost its records.
#
#    This tier used to aim at the record-page reset, which held
#    `state.eventsRecordsUnavailable = false` beside `state.eventsFailed = null`. That line
#    is gone: the clearing moved up to the overview handler, which assigns the verdict
#    from the totals on every selection. The anchor below silently stopped matching and
#    the tier reported "anchor missing" — no evidence, and a check that looks armed. An
#    anchor that cannot find its subject is not a weak tier, it is a silent one.
anchor "$BAK/l.from" <<'EOF'
  state.eventsRecordsUnavailable = payload.stats?.recordsUnavailable === true;
EOF
anchor "$BAK/l.to" <<'EOF'
  if (payload.stats?.recordsUnavailable === true) state.eventsRecordsUnavailable = true;
EOF
mutate "$FLOW" "$BAK/l.from" "$BAK/l.to" \
  && check_red "L the panel keeps the notice on the next session" "$PANEL"

echo
if [ "$(for f in "$JSONL" "$STORE" "$MCP" "$HTTP" "$FLOW"; do shasum "$f"; done)" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- one of the five files differs from where the run started"
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