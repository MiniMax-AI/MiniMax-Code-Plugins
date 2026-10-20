#!/usr/bin/env bash
# Mutation check for the `role` filter on `trajectory_get`.
#
# Why the filter exists: on the machine this was measured on, `role` is `assistant` for
# 112,290 of 116,304 rows and `user` for **2,388** — 2.1%. One session held 5,272
# assistant records and 9 user ones, so "what did this conversation ask and how far did it
# get" was a question about nine records, reachable only by walking all of them:
# **27 calls and 24.6 MiB** for a nine-message answer. That is not a slow path, it is a
# closed one, and `full` detail — the only level that carries the text — is exactly what
# the Skill tells a model not to widen to on its own.
#
# The tiers are the ways a filter like this silently stops filtering. Every one of them is
# a change that **still answers**, still returns records, and still reports a count — so
# nothing about the reply's shape gives the caller a reason to suspect it. A filter that
# returns nothing is loud; one that returns everything is quiet, and the caller concludes
# the session had a lot of user messages.
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
EVENTS=server/events.mjs
JSONL=server/jsonl.mjs
TEST=test/role-filter.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
for f in "$MCP" "$EVENTS" "$JSONL"; do cp "$f" "$BAK/$(basename "$f")"; done
restore() {
  cp "$BAK/mcp.mjs" "$MCP"
  cp "$BAK/events.mjs" "$EVENTS"
  cp "$BAK/jsonl.mjs" "$JSONL"
}
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(for f in "$MCP" "$EVENTS" "$JSONL"; do shasum "$f"; done)

run() { node --test "$1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0

echo "baseline:"
echo "       $(run "$TEST")"
echo

# A. The filter is not applied on the projection at all.
anchor "$BAK/a.from" <<'EOF'
      where.push('role = ?');
      params.push(role);
EOF
anchor "$BAK/a.to" <<'EOF'
    void role;
EOF
mutate "$EVENTS" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A the projection stops narrowing by role" "$TEST"

# B. `null` is folded into "no filter". The role-less group is real — 1,626 rows on the
#    measuring machine — and answering it with the whole session is the collapse the
#    `turnId` filter already had to be rescued from once.
anchor "$BAK/b.from" <<'EOF'
      where.push('role IS NULL');
EOF
anchor "$BAK/b.to" <<'EOF'
      void 0;
EOF
mutate "$EVENTS" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B null reads as no filter" "$TEST"

# C. The artifact reads the role from the wrong level of the record. This is not
#    hypothetical: the first version of this filter read `record.role`, and the role an
#    artifact line carries lives inside `message` — the same object the event is built
#    from. Every line therefore read as role-less, so the filter still *applied* and still
#    returned rows, just the wrong ones. A filter that runs and answers a different question
#    is harder to notice than one that does not run.
anchor "$BAK/c.from" <<'EOF'
      const recordRole = (record?.message && typeof record.message === 'object'
        ? record.message.role
        : undefined) ?? null;
EOF
anchor "$BAK/c.to" <<'EOF'
      const recordRole = record?.role ?? null;
EOF
mutate "$JSONL" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C the artifact reads the role from the wrong level" "$TEST"

# D. The artifact filter is dropped entirely — the projection still narrows, so a session
#    that happens to be indexed answers correctly and one that is not does not.
anchor "$BAK/d.from" <<'EOF'
      const recordRole = (record?.message && typeof record.message === 'object'
        ? record.message.role
        : undefined) ?? null;
      if (role === null || role === '') {
        if (recordRole !== null) return false;
      } else if (recordRole !== role) {
        return false;
      }
EOF
anchor "$BAK/d.to" <<'EOF'
      void role;
EOF
mutate "$JSONL" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the artifact fallback stops narrowing" "$TEST"

# E. The handler stops handing the argument to the projection.
anchor "$BAK/e.from" <<'EOF'
        turnId: args.turnId,
        role: args.role,
        detailLevel,
      });
EOF
anchor "$BAK/e.to" <<'EOF'
        turnId: args.turnId,
        detailLevel,
      });
EOF
mutate_case trajectory_get "$MCP" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the handler stops passing the role through" "$TEST"

# F. And the same for the artifact read inside the same handler. This is the one that
#    makes the two sources disagree, which is worse than either being uniformly wrong:
#    the same question about the same session has two answers depending on indexing.
anchor "$BAK/f.from" <<'EOF'
detailLevel, turnId: args.turnId, role: args.role,
EOF
anchor "$BAK/f.to" <<'EOF'
detailLevel, turnId: args.turnId,
EOF
mutate_case trajectory_get "$MCP" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F the handler stops passing the role to the artifact" "$TEST"

exit "$fail"