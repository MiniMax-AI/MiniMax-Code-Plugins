#!/usr/bin/env bash
# Mutation check for the compatibility contract in `tools/compat-matrix.mjs`.
#
# This file is the one that runs the suite on every supported Node release and decides
# whether the result is consistent with what the manifests claim. It had **no test at
# all** — the only test mentioning it checks that it imports no dependency — because the
# judgement was inline in `main()` and importing the module ran the whole suite.
#
# So a stale expectation could not be caught here. One shipped: the permitted skip count
# was hard-coded to 1, true while exactly one test depended on FTS5, and every search
# case added since made it wrong. It was caught by the CI `engines` job on Node 22.13.0,
# which reported `expected 1 skip(s) with FTS5 absent, saw 33` on a runtime where the
# Plugin itself was fine. The check that was supposed to catch a lying manifest was the
# thing that was lying.
#
# Every tier below removes one half of the contract. They are all "a verdict becomes a
# pass", which is why none of them needs a failing Plugin to show up: a tool that stops
# complaining looks identical to a tool that has nothing to complain about.
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

TOOL=tools/compat-matrix.mjs
TEST=test/compat-contract.test.mjs

BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$TOOL" "$BAK/compat-matrix.mjs"
restore() { cp "$BAK/compat-matrix.mjs" "$TOOL"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$TOOL")

run() { node --test "$1" 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

# Declared before the first tier, and not merely for tidiness: `check_red` only ever
# *assigns* to it, so a run in which every tier is killed leaves it unset — and under
# `set -u` the summary below would abort on an unbound variable and exit non-zero. The
# clean run is the one case that must report success.
fail=0

echo "baseline:"
echo "       $TEST  $(run "$TEST")"
echo

# A. A failing suite stops failing this judgement. The most consequential removal here:
#    the whole purpose of the tool is to fail a release whose suite is red, and this is
#    the one line that says so.
anchor "$BAK/a.from" <<'EOF'
  if (suite.fail !== 0) problems.push(`${suite.fail} test(s) failed on a supported release`);
EOF
anchor "$BAK/a.to" <<'EOF'
  if (false) problems.push(`${suite.fail} test(s) failed on a supported release`);
EOF
mutate "$TOOL" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a failing suite no longer fails the judgement" "$TEST"

# B. The skip that names something other than FTS5 is allowed through. This is the check
#    that keeps "the suite skipped a test" from being indistinguishable from "the suite
#    skipped a test for the one reason this tool tolerates".
anchor "$BAK/b.from" <<'EOF'
    else if (!/fts5/iu.test(`${skip.name} ${skip.reason}`)) {
EOF
anchor "$BAK/b.to" <<'EOF'
    else if (false) {
EOF
mutate "$TOOL" "$BAK/b.from" "$BAK/b.to" \
  && check_red "B a skip for any reason at all is tolerated" "$TEST"

# C. The per-skip report on a runtime that *has* FTS5 is dropped, so a suite that skips
#    something it should not answers clean. The count is not enough on its own: which
#    test skipped is what someone has to act on.
anchor "$BAK/c.from" <<'EOF'
    if (fts5) problems.push(`"${skip.name}" was skipped even though FTS5 is present`);
EOF
anchor "$BAK/c.to" <<'EOF'
    if (false) problems.push(`"${skip.name}" was skipped even though FTS5 is present`);
EOF
mutate "$TOOL" "$BAK/c.from" "$BAK/c.to" \
  && check_red "C a skip on a runtime with FTS5 goes unreported" "$TEST"

# D. The converse case: a runtime with no FTS5 where nothing skipped. Zero skips reads
#    exactly like a clean run, and it means the degraded path is exercised nowhere.
anchor "$BAK/d.from" <<'EOF'
  if (!fts5 && suite.skippedCount === 0) {
    problems.push('no test was skipped on a runtime with no FTS5, so the degradation is not covered here');
  }
EOF
anchor "$BAK/d.to" <<'EOF'
  if (false) {
    problems.push('no test was skipped on a runtime with no FTS5, so the degradation is not covered here');
  }
EOF
mutate "$TOOL" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D a runtime with no FTS5 and no skips reads as clean" "$TEST"

# E. The range indiction. Node 22.23.2 sits inside the verified range, so a runtime there
#    without FTS5 means the manifests promise something the runtime cannot do — and this
#    is the finding that has to be reported even though the suite itself is fine.
anchor "$BAK/e.from" <<'EOF'
  if (verified && !fts5) {
EOF
anchor "$BAK/e.to" <<'EOF'
  if (false) {
EOF
mutate "$TOOL" "$BAK/e.from" "$BAK/e.to" \
  && check_red "E the verified range stops being indicted" "$TEST"

# F. A run that produced no TAP summary at all. Its counts are null, so every numeric
#    comparison above treats it as zero — which is how "nothing was verified" reads as
#    "everything passed".
anchor "$BAK/f.from" <<'EOF'
  if (suite.tests === null) problems.push('the suite produced no TAP summary, so nothing was verified');
EOF
anchor "$BAK/f.to" <<'EOF'
  if (false) problems.push('the suite produced no TAP summary, so nothing was verified');
EOF
mutate "$TOOL" "$BAK/f.from" "$BAK/f.to" \
  && check_red "F an unparseable run reads as a passing one" "$TEST"

echo
if [ "$(shasum "$TOOL")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- the tool differs from where the run started"
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