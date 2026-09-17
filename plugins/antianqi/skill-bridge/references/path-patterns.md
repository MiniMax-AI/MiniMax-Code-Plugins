# Path Patterns

This document describes the hardcoded path patterns that `skill-bridge` recognizes and replaces, the placeholder variables used, and how downstream code should resolve them at runtime.

## Placeholders

| Placeholder | Meaning | Default suggested value |
|---|---|---|
| `${OPENCLAW_HOME}` | openclaw root dir (where the user kept `.openclaw/`) | unset — user must set |
| `${OPENCLAW_WORKSPACE}` | openclaw workspace (typically `${OPENCLAW_HOME}/workspace`) | unset — user must set |
| `${SCRATCH}` | OS-appropriate scratch dir | `os.tmpdir()` |
| `${DATA_DIR}` | mavis data dir | `~/.minimax` |

## The 6 rules (in priority order)

```js
// 1. openclaw workspace — most specific, checked first
{C:\Users\Administrator\.openclaw[/\]workspace[/\]?
   → ${OPENCLAW_WORKSPACE}/}

// 2. openclaw home (any other subdir)
{C:\Users\Administrator\.openclaw[/\]?
   → ${OPENCLAW_HOME}/}

// 3. tilde form
{~/.openclaw/
   → ${OPENCLAW_HOME}/}

// 4. CLI-Anything scratch
{/tmp/CLI-Anything/
   → ${SCRATCH}/cli-anything/}

// 5. generic /tmp
{/(?![\w/])/tmp/
   → ${SCRATCH}/}

// 6. mavis data dir
{C:\Users\Administrator\.minimax[/\]?
   → ${DATA_DIR}/}
```

The order matters: rule 1 must run before rule 2, otherwise `workspace/` would be replaced with `${OPENCLAW_HOME}/workspace/` and then re-matched by rule 1, leaving a double placeholder.

After all rules run, a post-pass collapses runs of slashes that may appear at the boundary between the placeholder and what was originally the separator — e.g. `${OPENCLAW_HOME}//workspace/foo.md` becomes `${OPENCLAW_HOME}/workspace/foo.md`.

## Why we don't auto-resolve the placeholders

`OPENCLAW_HOME` is genuinely environment-specific. We don't pretend to know where the user's old openclaw workspace is on a new machine. The skill body says `${OPENCLAW_HOME}/workspace/TASKS.md` and downstream code (or the user) fills in the env var at runtime.

For users who don't have an openclaw workspace anymore, the path is effectively dead and the skill should be rewritten to not depend on it. This is a content decision, not a tool decision.

## Extending the rules

If you have a new pattern (e.g. a hardcoded `/home/foo/claude/` from another framework), add it to `lib/paths.js` `PATH_RULES`. Order matters: more specific patterns go first. Re-run the tests:

```bash
node --test tests/paths.test.mjs
```

Add a test for the new pattern in the same file before opening a PR.
