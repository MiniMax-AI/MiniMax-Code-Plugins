# Validation evidence

Test date: 2026-11-03. This is a submission candidate, not evidence of acceptance
or a successful end-to-end MiniMax build.

## References inspected

- MiniMax community repository base: `01c44b6828085f8000bd40926170c18af7b0bb10`.
  Read `CONTRIBUTING.md`, `docs/architecture.md`, `docs/plugin-compatibility.md`,
  the v0.4 manifest proposal, pull-request template, validator, and existing
  TickTick global-MCP setup pattern.
- VividSites connector reference: `bee5559327a17aeab297486918dcb05b753a3b87` in
  `krumjahn/vividsites-connectors`; README, published configs, skill, live verifier,
  and license inspected. No changes to that repository are part of this submission.
- Published `@minimax-ai/code@0.7.4` package source: inspected portable and
  Claude-compatible manifest readers and skill discovery. The current compatible
  reader resolves `./skills` from the plugin root and discovers `skills/SKILL.md`;
  this avoids relying on older documentation's conflicting manifest-relative
  file-path examples. This was source inspection, not execution in MiniMax.

## Automated local checks

On macOS arm64, Node 24.21.0, Python 3.14, Pillow 12.3.0:

```text
npm run check
Validated 30 hosted Plugins and all examples.
tests 1121; pass 1120; fail 0; cancelled 0; skipped 1
```

The first sandboxed run failed because existing repository tests could not bind
loopback sockets (`listen EPERM 127.0.0.1`). The full suite passed when rerun with
loopback access. No existing plugin or test was modified to obtain this result.
The one skipped upstream test is platform-dependent.

The skill-creator `quick_validate.py` reported `Skill is valid!`. All plugin JSON
files parse; the two skill copies are byte-identical; no symlinks are present;
`git diff --check` passes. These are static checks, not an authenticated host test.

## Live access checks

Ran the connector's existing `python3 scripts/verify-live.py` against
`https://www.vividsites.app/api/connector` without an API key:

```text
PASS: anonymous initialization, discovery and all six tools blocked; invalid key blocked
SKIP: live unpaid-account checks (VIVIDSITES_UNPAID_API_KEY not supplied)
SKIP: live paid-account checks (VIVIDSITES_API_KEY not supplied)
```

These are nine HTTP 401 denial checks, not successful library retrievals. No
paid purchase, new credential, premium prompt allowance, media generation, or
production configuration change was used. Tool names/behavior come from the
maintained connector reference; live authenticated discovery remains unverified.

## Manual behavior review

- Browse-only example ends after search/preview comparison; no project edits or
  metered build-prompt request is authorized by browsing.
- Build example uses returned slugs, retrieves only the selected build prompt,
  preserves the project's framework, and verifies the local page without deployment.
- Missing credentials lead to private global MCP setup, not an anonymous fallback,
  a key in chat/URL, or a claimed successful result.
- Informational links carry only fixed campaign labels. MCP and media URLs, user
  CTAs, and generated customer pages receive no tracking additions.
- No template, media, component source, or proprietary logo is redistributed here.

This is a manual instruction review, not an independent model execution. The
repository validator and skill-frontmatter check provide static package evidence;
MiniMax installation, model behavior, paid retrieval, and rendered output remain
pending a maintainer or user test with an existing paid account. Cross-platform
runtime execution has not been tested.
