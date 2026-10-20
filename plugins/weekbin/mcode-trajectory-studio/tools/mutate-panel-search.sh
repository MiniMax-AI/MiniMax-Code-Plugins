#!/usr/bin/env bash
# Mutation check for the panel's search-field fix.
#
# The defect: `visibleSessions` re-matched the server's search results over a
# narrower field set than the server searches, so a query matched on agent, status,
# session type or purpose was emptied by the browser.
#
# The fix is three coordinated edits — a marker on the state, set when a search is
# accepted, consulted by the sidebar, and invalidated on both typing and a reload.
# A mutation script written to check that has to be more careful than the code it
# checks: an earlier ad-hoc version restored files by string surgery and left
# `flow.js` with a duplicated statement, which made one mutation a no-op and read
# as "the test has no teeth". So backups are taken once, every substitution asserts
# that it landed, and a post-run check confirms the tree is byte-identical.
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

FILES=(web/js/sidebar.js web/js/wire.js web/js/flow.js web/js/state.js)
TEST=test/panel-search-fields.test.mjs
BAK=$(mktemp -d)
for f in "${FILES[@]}"; do mkdir -p "$BAK/$(dirname "$f")"; cp "$f" "$BAK/$f"; done
restore() { for f in "${FILES[@]}"; do cp "$BAK/$f" "$f"; done; }
trap 'restore; rm -rf "$BAK"' EXIT

# Recorded so the final check can prove nothing was left mutated.
BASELINE_SUMS=$(shasum "${FILES[@]}" | sed "s|$BAK/||")

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
    echo "ANCHOR MISSING or AMBIGUOUS in $file (needs exactly one match): $from"
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

# A. The original defect: the sidebar re-matches the server's answer.
mutate web/js/sidebar.js \
  'if (state.searchedTerm && state.searchedTerm.toLowerCase() === term) return true;' \
  'if (false) return true;' \
  && check_red "A sidebar re-filters server results"

# B. The marker is never set, so the sidebar can never trust the server's answer.
mutate web/js/wire.js \
  'state.searchedTerm = term;' \
  'state.searchedTerm = null;' \
  && check_red "B a search never marks its results"

# C. Typing does not invalidate: the panel keeps showing results for a term that is
#    no longer on screen.
mutate web/js/wire.js \
  '    // The results on screen answered the term that was submitted. Once the reader
    // edits the box, they no longer describe what is being asked for, so the
    // sidebar must not keep showing them as though they did.
    state.searchedTerm = null;' \
  '' \
  && check_red "C typing does not invalidate the marker"

# D. A browsing page is left marked as the answer to the last search, so a reload
#    suppresses the sidebar's own filtering over an unrelated list.
mutate web/js/flow.js \
  '  // over an unrelated list of sessions.
  state.searchedTerm = null;' \
  '  // over an unrelated list of sessions.' \
  && check_red "D a reload does not retire the marker"

# E. A search that matched nothing still claims the loaded rows are its answer. The
#    empty branch's own clear is belt-and-braces while `input` clears on every
#    keystroke, so the mutation that actually changes behaviour removes that one:
#    with it gone, editing the box after a search keeps showing the old results.
mutate web/js/wire.js \
  '    // sidebar must not keep showing them as though they did.
    state.searchedTerm = null;' \
  '    // sidebar must not keep showing them as though they did.' \
  && check_red "E typing stops retiring stale results"

# F. The marker is compared case-sensitively while the term is lower-cased. Every
#    other case in this file is lower case, so this one is invisible to all of them;
#    it was found by driving a real browser with a real mixed-case query, which is
#    why the browser walk exists alongside these tests.
mutate web/js/sidebar.js \
  'if (state.searchedTerm && state.searchedTerm.toLowerCase() === term) return true;' \
  'if (state.searchedTerm === term) return true;' \
  && check_red "F marker compared case-sensitively"

echo
if [ "$(shasum "${FILES[@]}" | sed "s|$BAK/||")" != "$BASELINE_SUMS" ]; then
  echo "TREE NOT RESTORED -- the panel files differ from where the run started"
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