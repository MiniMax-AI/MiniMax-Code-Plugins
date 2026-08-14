# Search First

## The problem

Coding agents frequently edit code based on a plausible guess instead of the actual repository:
functions are duplicated because an existing helper was not found, call sites are missed because
only the target file was read, and tests or configs coupled to the change are discovered only
after regression. The fix is procedural, not model-level: force a search-and-read pass before
any edit is proposed.

This Plugin installs one Skill that makes the agent locate evidence first — files, symbols, call
sites, nearby patterns, and affected references — and only then propose or implement changes.

## Try it

```text
Use the search-first skill, then fix the flaky login test in this repository.
```

Expected result: before touching any file, the agent searches for the test, its fixtures, the
login implementation, its callers, and adjacent tests; it reports what it found, then proposes a
narrow change grounded in the existing project pattern.

## What the Skill does

- Core rule: no modification until the relevant files, symbols, call sites, nearby patterns, and
  affected references have been searched and read.
- A five-step investigation workflow (search exact text/symbols, read definitions, identify
  adjacent code paths, identify coupled tests/docs/configs, then change).
- A minimum-investigation checklist the agent must answer before editing (where is the primary
  implementation, what calls it, what is coupled to it, what nearby pattern to follow, what is
  the smallest safe change).
- Priorities: exact evidence over assumptions, existing project patterns over invented ones,
  narrow targeted changes, official documentation checks before external API/SDK changes.

## Requirements

- None. The Skill only directs how the agent uses its existing search and read tools.

## Data and network

- No network access required.
- No credentials required.
- No data leaves the machine beyond what the host agent already does.

## License

Apache-2.0. See [LICENSE](LICENSE).
