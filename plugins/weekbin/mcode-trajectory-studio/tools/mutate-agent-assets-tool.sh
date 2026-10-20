#!/usr/bin/env bash
# Mutation check for `trajectory_agent` and `trajectory_assets` — the two tools that had
# no mutation tier at all.
#
# How the gap was found: counting. `grep -l` for each of the thirteen tool names across
# `tools/mutate-*.sh` returned a script for eleven of them, and **nothing for
# `trajectory_agent` and `trajectory_assets`**. Both have behavioural tests — eleven cases
# between them — so neither was untested; what was missing was any evidence that those
# tests *bite*. A test suite that has never been shown to fail is the same decoration as an
# untested one, and this Plugin's whole claim about its egress and disclosure rests on
# tests that are known to fail when the thing they describe is removed.
#
# These two are the worst place for that, because both are the tools that hand the reader
# a **file path** and a **system prompt** — free text produced outside this codebase, by
# whoever wrote the asset name and whoever configured the agent. Neither is a field this
# Plugin controls, and a credential in either leaves by exactly the route that looks like
# every other route.
#
# The tiers are the ways each can decay back into a decoration: reading a table that could
# not be read as a session that produced nothing, a page that cannot be told from the
# whole, a byte-budget cut that is not disclosed, a sweep that covers the field it knows
# about instead of the row, a path left unfolded, an absent definition reported as a
# withheld one, a redaction that covers the prompt but not the project beside it, and a
# list budget handed an object.
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
# `mutate`, `mutate_case`, `anchor`, `anchor_inline` and `check_red` live in the shared
# library, so a fix to what makes a mutation's verdict trustworthy is made once.
. tools/mutation-lib.sh

MCP=server/mcp.mjs
ASSETS=test/assets-tool.test.mjs
AGENT=test/agent-tool.test.mjs
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$MCP" "$BAK/mcp.mjs"
restore() { cp "$BAK/mcp.mjs" "$MCP"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$MCP")

run() { node --test "$1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0

echo "baseline:"
echo "       assets: $(run "$ASSETS")"
echo "       agent:  $(run "$AGENT")"
echo

# ------------------------------------------------------------- trajectory_assets --

# A. The table could not be read, and the reply says nothing. This is the failure the
#    `note` exists for: an empty `assets` array next to `available: true` is the shape a
#    session that genuinely produced nothing has, so folding the two makes a runtime that
#    cannot answer look like a session with no files.
anchor "$BAK/a.to" <<'EOF'
        ...(available ? {} : {}),
EOF
anchor "$BAK/a.from" <<'EOF'
        ...(available ? {} : { note: 'session assets are unavailable on this runtime: it exposes no local_runtime_session_assets table, or the query failed — so an empty list here means "not listed", not "none exist"' }),
EOF
mutate_case trajectory_assets "$MCP" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a runtime with no assets table reads as a session that produced nothing" "$ASSETS"

# B. The cursor is pinned to the first page, so a session with more files than one page
#    silently looks like a session with a handful.
anchor "$BAK/b.from" <<'EOF'
        nextOffset: delivered === 0 || offset + delivered >= total ? null : offset + delivered,
EOF
anchor "$BAK/b.to" <<'EOF'
        nextOffset: null,
EOF
mutate_case trajectory_assets "$MCP" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B the cursor never leaves the first page" "$ASSETS"

# C. A byte-budget cut stops being reported. The frame bound and the byte bound are two
#    different cuts, and only reporting one of them is how a list quietly stops being
#    complete.
anchor "$BAK/c.from" <<'EOF'
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        assets: bounded.items,
EOF
anchor "$BAK/c.to" <<'EOF'
        truncated: false,
        omitted: 0,
        assets: bounded.items,
EOF
mutate_case trajectory_assets "$MCP" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C a cut asset list claims to be complete" "$ASSETS"

# D. The reply stops carrying the total, so a page cannot be told from the whole. The
#    cursor above already answers "is there more"; without `total` the first page of a
#    one-file session and the first page of a four-hundred-file session read identically.
anchor "$BAK/d.from" <<'EOF'
        total,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= total ? null : offset + delivered,
EOF
anchor "$BAK/d.to" <<'EOF'
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= total ? null : offset + delivered,
EOF
mutate_case trajectory_assets "$MCP" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a page cannot be told from the whole" "$ASSETS"

# E. The sweep covers the field it knows about instead of the row. An asset's `path` is
#    folded explicitly, and the tempting simplification is to sweep that path alone — but
#    the `name` is free text typed by whoever produced the file, and the fixture caught
#    exactly that: `api_key=` in a name went out verbatim while the sibling path folded.
anchor "$BAK/e.from" <<'EOF'
      const rows = assets.map((asset) => redactPayload(
        { ...asset, path: asset.path ? redactPath(asset.path, { homeDir, roots: redactRoots }) : null },
        options,
      ));
EOF
anchor "$BAK/e.to" <<'EOF'
      const rows = assets.map((asset) => ({
        ...asset,
        path: asset.path ? redactPath(asset.path, { homeDir, roots: redactRoots }) : null,
      }));
EOF
mutate_case trajectory_assets "$MCP" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the sweep covers the path instead of the row" "$ASSETS"

# F. The row stops saying which file it was.
#
#    The obvious target here is the explicit `redactPath` — "the path is left unfolded and
#    an absolute home directory leaves in a field this Plugin never had to be told about".
#    That target was tried first and it is an **equivalent mutation**, proven rather than
#    assumed: `redactPath` *is* `foldHomePaths`, and the generic row sweep below it is handed
#    the same `homeDir` and the same `roots`, so removing the explicit call changes nothing
#    observable and every assertion here stayed green. Two foldings doing one job is worth
#    knowing about, and an equivalent mutation is not a weak one — it reports a pass for a
#    face that nothing tests.
#
#    So the target is the face that is actually load-bearing and locally scoped: the row
#    keeping its identifying tail. Folding has to preserve the part that names the file, or
#    a reply that correctly refuses to leak the directory has stopped being useful.
anchor "$BAK/f.from" <<'EOF'
        { ...asset, path: asset.path ? redactPath(asset.path, { homeDir, roots: redactRoots }) : null },
EOF
anchor "$BAK/f.to" <<'EOF'
        { ...asset, path: null },
EOF
mutate_case trajectory_assets "$MCP" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F the row stops naming the file it describes" "$ASSETS"

# -------------------------------------------------------------- trajectory_agent --

# G. "This session was dispatched without an agent" becomes "there is an agent and I am
#    not showing it to you". Different answers: the first is common and unremarkable, the
#    second sends the reader looking for a definition that was never written.
anchor "$BAK/g.from" <<'EOF'
        return { sessionId, present: false, available: true };
EOF
anchor "$BAK/g.to" <<'EOF'
        return { sessionId, present: true, available: true, definition: null };
EOF
mutate_case trajectory_agent "$MCP" "$BAK/g.from" "$BAK/g.to" \
  && check_red "G an absent definition reads as a withheld one" "$AGENT"

# H. The redaction stops being told where home is, so a path written into the system
#    prompt survives it. Kept as a two-line anchor because dropping the `homeDir` and
#    `roots` options is the smallest edit that makes the same leak the panel route
#    already had to fix for itself.
anchor "$BAK/h.from" <<'EOF'
        maxLength: 20000, maxDepth: EGRESS_MAX_DEPTH, maxEntries: EGRESS_MAX_ENTRIES,
        homeDir, roots: redactRoots,
EOF
anchor "$BAK/h.to" <<'EOF'
        maxLength: 20000, maxDepth: EGRESS_MAX_DEPTH, maxEntries: EGRESS_MAX_ENTRIES,
EOF
mutate_case trajectory_agent "$MCP" "$BAK/h.from" "$BAK/h.to" \
  && check_red "H the definition is swept without being told where home is" "$AGENT"

# I. The list budget is handed the definition instead of a list of one. `boundPayloadList`
#    answers an empty list for anything that is not an array, which is how a 6 KB
#    definition came back as two bytes while `present: true` still said it was there.
anchor "$BAK/i.from" <<'EOF'
      const bounded = boundPayloadList([redacted], { maxBytes: EGRESS_TOTAL_BYTES_MCP });
EOF
anchor "$BAK/i.to" <<'EOF'
      const bounded = boundPayloadList(redacted, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
EOF
mutate_case trajectory_agent "$MCP" "$BAK/i.from" "$BAK/i.to" \
  && check_red "I the list budget is handed an object" "$AGENT"

# J. A definition cut by the byte budget stops saying so. The reply is one record, so the
#    only place the cut can be disclosed is these two fields.
anchor "$BAK/j.from" <<'EOF'
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        definition: bounded.items[0] ?? null,
EOF
anchor "$BAK/j.to" <<'EOF'
        truncated: false,
        omitted: 0,
        definition: bounded.items[0] ?? null,
EOF
mutate_case trajectory_agent "$MCP" "$BAK/j.from" "$BAK/j.to" \
  && check_red "J a cut definition claims to be whole" "$AGENT"

exit "$fail"