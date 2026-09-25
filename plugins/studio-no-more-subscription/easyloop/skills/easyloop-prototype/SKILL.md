---
name: easyloop-prototype
description: EasyLoop variant for prototype-quality work. Defaults to quality=prototype (5-turn cap, no tests, no docs). Spawns background Task agents in parallel but caps each loop at fewer iterations.
license: Apache-2.0
compatibility: Requires easyloop plugin.
metadata:
  author: bro
  version: "0.1.0"
---

# EasyLoop — Prototype variant

Same selection menu as `easyloop`, but the **defaults** are tuned for
spike/exploration quality:

- Iteration cap: **5 turns** (vs 25 for release).
- Verify (tests + linter + type-check): **off**.
- Sub-agent count: **2–3 background Tasks** (not 3–5).
- Doc generation: skip.

## Step 1: call `get_menu` to see the live plugin list

Before calling `finish_plugin_selection`, call `get_menu`. It lists
every installed plugin (built-in + custom) with its one-line
description. Pick the plugins whose descriptions match the task.

## Recommended selection for most prototype tasks

```
finish_plugin_selection({
  loops:   ["explore", "implement"],
  quality: "prototype",
  plugins: [],                  // or any custom plugin that fits
  notes:   "<one-line plan>"
})
```

## Call shape (same as easyloop)

```
finish_plugin_selection({
  loops:   [...],         // array of loop names from get_menu
  quality: "prototype",   // hard-coded
  plugins: [...],         // optional, from get_menu
  notes:   "..."
})
```

## After the call

- Move fast. Use 1–3 iterations per loop. Don't run tests; smoke-check
  by reading the diff.
- If you discover the prototype is going to ship, **re-invoke the
  `easyloop-release` Skill** to switch to release quality — call
  `finish_plugin_selection` again with `quality: "release"`.

## Disclosure

Same as `easyloop`: persists to `${PLUGIN_DATA}`, no network, no native
binaries.
