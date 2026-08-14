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
- A six-step investigation workflow (search exact text/symbols, read definitions, identify
  adjacent code paths, identify coupled tests/docs/configs, report a concise investigation
  summary, then change).
- A minimum-investigation checklist the agent must answer before editing (where is the primary
  implementation, what calls it, what is coupled to it, what nearby pattern to follow, what is
  the smallest safe change).
- Priorities: exact evidence over assumptions, existing project patterns over invented ones,
  narrow targeted changes, and version-aware official documentation checks — with an explicit
  offline fallback — before external API/SDK changes.

## Requirements

- No additional executables, accounts, or paid services.
- The Skill directs how the agent uses its existing search, read, and optional documentation tools.
- Supported wherever MiniMax Code Agent Plugins 1.0 Skills are available.

## Data and network

- Repository investigation is local and requires no network access.
- Conditional network access: when a task proposes changing how code uses an external API or SDK
  and versioned documentation is unavailable locally, the Skill may ask the host's documentation
  or web tool to retrieve the vendor's official documentation. There is no fixed destination: the
  public dependency may be named by the user or identified from repository imports/manifests, and
  its official documentation domain becomes the destination.
- Only public product, API, and version identifiers may be used for that lookup. Source code,
  credentials, personal data, private endpoints, internal hostnames, and private package names must
  not be sent. A repository-discovered private dependency must never trigger an online lookup.
- Read-only tracing, explanation, and investigation tasks never initiate online documentation
  lookups; they report version-sensitive uncertainty instead.
- If host policy or connectivity blocks the lookup, the Skill reports the documentation gap,
  treats version-sensitive behavior as unverified, and asks the user for documentation or explicit
  acceptance of the stated risk instead of guessing.
- No credentials are required by this Plugin.

## License

Apache-2.0. See [LICENSE](LICENSE).
