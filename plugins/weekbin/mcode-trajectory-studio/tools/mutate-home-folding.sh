#!/usr/bin/env bash
# Mutation check for `foldHomePaths` — the confidentiality boundary, on Windows spellings.
#
# `foldHomePaths` collapses the configured roots to `~` and every other account's home to
# `<user>`. It had no mutation tier at all: `mutate-tail-direction.sh` also mutates
# `server/redact.mjs`, but it runs `test/tail-direction.test.mjs`, which never reads a
# folded path. So a function this plugin's every surface depends on was covered only by the
# tests' own reading of it.
#
# The tiers below are the guards added when a drive-relative root stopped matching a path
# that carries a volume — the defect CI found on Windows, where `path.resolve` prepends
# `D:` to every root written without one, so `D:\tmp\build\ws` folded to `D:~\ws`: not a
# path anything can open, and not a redaction either, because the volume stayed.
#
# Each guard was arrived at by shipping the two obvious spellings first, and each of those
# broke something different:
#
#   `(?:[A-Za-z]:)?`            ate the `d:` of the *word* `sqlite_discovered:`, turning a
#                              warning into `sqlite_discovere~/.minimax/…`
#   `(?:[A-Za-z]:[/\\])?`      consumed the separator the variant needs to start with, so
#                              the volume was never absorbed and `D:~` remained
#   boundary + optional volume correct, and only correct together: an optional group cannot
#                              anchor what follows it, so without the boundary the bare
#                              variant still folds a root found *inside* `D:x\tmp\…`
#
# That is why these are four tiers rather than one: removing any single guard reintroduces
# a different wrong answer, and a fold that quietly stops working is the shape this plugin's
# own gates exist to refuse.
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
# `mutate`, `anchor` and `check_red` live in the shared library, so a fix to what makes a
# mutation's verdict trustworthy is made once.
. tools/mutation-lib.sh

REDACT=server/redact.mjs
# Three files, because the guards are about three different claims: `path-folding.test.mjs`
# states the drive-relative contract, `redact.test.mjs` states that the fold must not damage
# the text around it, and `portable-paths.test.mjs` is the one that catches a fixture
# literal leaking into shipped source. A tier is only worth anything if the files it runs can
# see the behaviour it mutated, so all three are named rather than picked while writing.
TESTS="test/path-folding.test.mjs test/redact.test.mjs test/portable-paths.test.mjs"
BAK=$(mktemp -d)
mkdir -p "$BAK"
cp "$REDACT" "$BAK/redact.mjs"
restore() { cp "$BAK/redact.mjs" "$REDACT"; }
trap 'restore; rm -rf "$BAK"' EXIT
BASELINE_SUMS=$(shasum "$REDACT")

run() { node --test $TESTS 2>&1 | grep -E '^# (pass|fail)' | tr '\n' ' '; }

fail=0

echo "baseline:"
echo "       $(run)"
echo

# A. The volume stops being absorbed, so a drive-relative root folds only its own spelling
#    and leaves the drive in front of the `~`: `D:~\ws\src\app.js`. Not a path a reader can
#    open, and the parent of the home root is still named by it.
anchor "$BAK/a.from" <<'EOF'
    const volumeFirst = /^[A-Za-z]:/u.test(root) ? '' : '(?<![A-Za-z0-9])[A-Za-z]:(?=[/\\\\])';
EOF
anchor "$BAK/a.to" <<'EOF'
    const volumeFirst = '';
EOF
mutate "$REDACT" "$BAK/a.from" "$BAK/a.to" \
  && check_red "A a drive-relative root leaves the volume in front of the fold" "$TESTS"

# B and C are **not** here, and their absence is the finding rather than an omission.
#
# Both lookarounds around the volume — the `(?=[/\\])` that requires a separator after the
# colon, and the `(?<![A-Za-z0-9])` that requires a boundary before the letter — are
# redundant *given* the component boundary in tier D, and each was measured to survive:
# removing either one alone leaves all 71 tests green. The reason is worth stating,
# because the same pair written alone would look load-bearing:
#
#   * the separator lookahead: every variant `rootVariants` returns begins with a separator,
#     so "a separator follows the colon" is already guaranteed by what comes next. It can
#     only decide the case where the variant does *not* start with one, which is a
#     drive-relative root written without a leading separator — a shape no caller produces.
#   * the lookbehind: once D is in place, a volume cannot start mid-word anyway, because
#     the char before it is a letter and D forbids exactly that.
#
# A tier that cannot turn the suite red is not evidence that a guard is pinned; it is a
# number in a tally that looks like coverage. Both were written, both were measured
# green, and both were deleted rather than kept for symmetry. If D is ever removed, they
# become real and belong back — together, because neither alone catches what D catches.

# D. The component boundary goes away. An optional group cannot anchor what follows it, so
#    without this the bare variant still folds a root found *inside* a longer path, and
#    `D:x\tmp\build\ws` becomes `D:x~\ws` — naming neither the directory nor anything real.
anchor "$BAK/d.from" <<'EOF'
      const startsAComponent = '(?<![A-Za-z0-9._-])';
EOF
anchor "$BAK/d.to" <<'EOF'
      const startsAComponent = '';
EOF
mutate "$REDACT" "$BAK/d.from" "$BAK/d.to" \
  && check_red "D the fold stops requiring a component boundary" "$TESTS"

echo
if [ "$(shasum "$REDACT")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- redact.mjs differs from where the run started"
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