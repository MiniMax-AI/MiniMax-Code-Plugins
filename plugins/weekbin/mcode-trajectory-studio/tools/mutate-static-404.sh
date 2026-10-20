#!/usr/bin/env bash
# Mutation check for the status a missing static file is reported with.
#
# The client is served by route *shape*, not by enumeration: `/js/<name>.js` is a route
# whether or not that module is on disk, which is what lets a module ship without editing
# the router. Existence was therefore decided by the read that followed, and every failure
# of that read came back as `static_unavailable` — so a missing module was a 500 while a
# missing path at the root was a 404. That sends whoever is debugging a broken panel to
# look at the server instead of at the file they renamed, and it fires a 5xx alarm on an
# ordinary miss.
#
# Each mutation below puts one half of the distinction back the way it was.
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
TEST=test/http.test.mjs
BAK=$(mktemp -d)
cp "$HTTP" "$BAK/http.mjs"
# Copies only; the backup is removed once, by the exit trap. Removing it here as well
# leaves every mutation after the first running against an already-mutated tree.
restore() { cp "$BAK/http.mjs" "$HTTP"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$HTTP")

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

mutate() {
  local file="$1" from="$2" to="$3"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
path, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
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
  if [ -n "$to" ] && ! grep -qF -- "$to" "$file"; then
    echo "MUTATION DID NOT LAND in $file -- its result would say nothing"
    fail=1
    return 1
  fi
  return 0
}

echo "baseline:"
echo "       $(run)"
echo

# A. The distinction gone: nothing is ever reported as absent, so a missing module is a
#    server error again — the behaviour this file exists to catch.
mutate "$HTTP" \
  "  return errorCode === 'ENOENT';" \
  "  return false;" \
  && check_red "A a missing module is a server error again"

# B. The rule widened to every failure. `EISDIR` means the target is a directory and
#    `ENOTDIR` that a path component is not one; neither proves the resource is absent, so
#    a 404 there is a claim the caller acts on, while the 500 it replaces is only a
#    refusal to answer. This is the over-correction the first version of this fix made —
#    it widened the branch to ENOENT *or* ENOTDIR and the test could not tell, because no
#    route shape produces ENOTDIR here. The rule is now a named function so it can be
#    asserted directly.
mutate "$HTTP" \
  "  return errorCode === 'ENOENT';" \
  "  return errorCode !== undefined;" \
  && check_red "B a file that is present but unreadable is reported as absent"

# C. The status right but the code wrong. `not_found` is what a caller matches on to tell
#    "there is no such thing" from "the server could not answer"; a 404 carrying
#    `static_unavailable` says the file is missing *and* that the static root is broken,
#    which is two claims and only one is true.
mutate "$HTTP" \
  "        return fail(res, 404, 'not_found');" \
  "        return fail(res, 404, 'static_unavailable');" \
  && check_red "C a 404 that names the static root as unavailable"

echo
if [ "$(shasum "$HTTP")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- the file differs from where the run started"
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