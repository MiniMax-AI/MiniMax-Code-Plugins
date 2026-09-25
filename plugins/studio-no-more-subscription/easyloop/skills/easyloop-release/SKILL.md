---
name: easyloop-release
description: EasyLoop variant for release-quality work. Defaults to quality=release (25-turn cap, full tests + linter + type-check, docstrings). Spawns 3–5 background Task agents per exploration round and aggregates before implementing.
license: Apache-2.0
compatibility: Requires easyloop plugin.
metadata:
  author: bro
  version: "0.1.0"
---

# EasyLoop — Release variant

Same selection menu as `easyloop`, but the **defaults** are tuned for
ship-ready output:

- Iteration cap: **25 turns**.
- Verify: **on** — run tests, linter, type-check after every
  implement/test/refactor cycle.
- Sub-agent count: **3–5 background Tasks** per exploration round.
- Doc generation: docstring stubs at minimum.

## Step 1: call `get_menu` to see the live plugin list

Before calling `finish_plugin_selection`, call `get_menu`. It lists
every installed plugin (built-in + custom) with its one-line
description. Release-quality work should enable:

- `mcode-think-filter` (recommended for release quality — long
  iterations benefit from lean transcripts).
- Any custom plugin whose description matches the task.

## Recommended selection for most release tasks

```
finish_plugin_selection({
  loops:   ["explore", "implement", "test", "review", "document"],
  quality: "release",
  plugins: ["mcode-think-filter", /* + any relevant custom plugin */],
  notes:   "<one-line plan>"
})
```

## Call shape (same as easyloop)

```
finish_plugin_selection({
  loops:   [...],
  quality: "release",
  plugins: [...],         // from get_menu
  notes:   "..."
})
```

## After the call

- Always run the project's test suite at the end of `implement` and
  every `test` cycle. Fix until green before declaring the loop done.
- For migration / dependency-update work, run `test` twice (once
  before changes as a baseline, once after).
- For `release` loop, bump the version in the project's version file
  and update CHANGELOG.md.
- Use `log_iteration({ turn, loop, summary })` to audit which loops
  ran and how many turns each consumed.

## Disclosure

Same as `easyloop`: persists to `${PLUGIN_DATA}`, no network, no native
binaries.
