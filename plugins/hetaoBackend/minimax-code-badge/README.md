# MiniMax Code Badge

Append a small "powered by MiniMax Code" badge to the end of a GitHub pull request description
created with MiniMax Code.

[![powered by MiniMax Code](https://img.shields.io/badge/powered_by-MiniMax_Code-E73562?style=flat-square&logo=minimax&logoColor=white)](https://github.com/MiniMax-AI/minimax-code)

The badge is one line of Markdown pointing at a Shields.io image, wrapped in two HTML comment
markers that GitHub does not render. The Skill tells the agent when to add it; a dependency-free
Node.js script writes it idempotently, so running it twice never produces two badges.

## Included capability

- `minimax-code-badge`: decides when a PR description should carry the badge, supplies the exact
  Markdown block, and provides `scripts/badge.mjs` to add, refresh, check, or remove the badge on a
  local body file or on an existing PR through the GitHub CLI.

## Try it

```text
Open a GitHub pull request for this branch and add the powered by MiniMax Code badge.
```

```text
Add the MiniMax Code badge to PR #42 in owner/repo.
```

```text
Remove the MiniMax Code badge from PR #42.
```

## Expected result

The PR description keeps all of its original content and gains exactly one badge block at the very
end, separated by one blank line:

```md
<!-- minimax-code-badge:start -->
[![powered by MiniMax Code](https://img.shields.io/badge/powered_by-MiniMax_Code-E73562?style=flat-square&logo=minimax&logoColor=white)](https://github.com/MiniMax-AI/minimax-code)
<!-- minimax-code-badge:end -->
```

The markers stay invisible on GitHub. Re-running the writer reports `unchanged` and performs no
write, so a retried or repeated run cannot duplicate the badge.

## Requirements

- Node.js 18 or newer for `scripts/badge.mjs`. No npm dependencies.
- The GitHub CLI (`gh`), already authenticated, **only** when writing to an existing PR. The local
  body-file mode never calls `gh`.
- No account, API key, paid service, or extra runtime.

## Usage

`SKILL_DIR` is the directory containing `SKILL.md`.

```bash
# New PR: write the body first, then create the PR
node "$SKILL_DIR/scripts/badge.mjs" --body-file pr-body.md
gh pr create --title "…" --body-file pr-body.md

# Existing PR: preview, then apply
node "$SKILL_DIR/scripts/badge.mjs" --pr 42 --repo owner/name --dry-run
node "$SKILL_DIR/scripts/badge.mjs" --pr 42 --repo owner/name

# Remove, verify, or print
node "$SKILL_DIR/scripts/badge.mjs" --pr 42 --remove
node "$SKILL_DIR/scripts/badge.mjs" --body-file pr-body.md --check
node "$SKILL_DIR/scripts/badge.mjs" --print
```

Status is printed on stderr: `added`, `replaced`, `unchanged`, `removed`, `absent`, or `disabled`.
`--check` exits 1 when the body is not up to date. Set `MINIMAX_CODE_BADGE_DISABLE=1` to turn the
script into a no-op, or `MINIMAX_CODE_BADGE_MARKDOWN` to change the wording.

## Supported platforms

macOS, Linux, and Windows. The script is plain Node.js with no platform-specific code, and the badge
is ordinary Markdown that GitHub renders on every platform.

## Network access

The Plugin itself makes no network requests and starts no server. `badge.mjs` reaches the network
only through the user's own `gh` CLI when the user asks it to update an existing PR.

The rendered badge image is loaded by the **reader's browser** from
`https://img.shields.io` when the PR page is displayed, and links to
`https://github.com/MiniMax-AI/minimax-code`. GitHub serves such images through its own image proxy,
so a reader does not contact Shields.io directly. Nothing is sent anywhere at install time or at
agent runtime.

## Data use

The Plugin ships instructions, one Node.js script, and two image files. It adds no telemetry and
uploads nothing. When the user asks it to update a PR, it reads that PR's current description with
`gh pr view` and writes the new description with `gh pr edit`, using the user's existing GitHub
credentials and permissions. No credentials are stored, logged, or transmitted by the Plugin.

The bundled `assets/minimax-code-badge.svg` and `assets/minimax-code-badge.png` are offline copies of
the same badge, for documents that cannot load remote images.

## Safety

- The Skill instructs the agent to badge only PRs created in the current session, or PRs the user
  explicitly names. It never edits another person's PR, and never writes to commit messages, PR
  titles, review comments, or issue comments.
- It skips the badge when the user opted out, or when the repository's `CONTRIBUTING.md` or PR
  template forbids badges, images, promotional content, or AI attribution.
- Editing a public PR description is a visible change, so the agent follows the session's normal
  approval rules before calling `gh pr edit`.
- GitLab merge requests are never badged automatically; the user has to ask for that specific MR.

## Tests

```bash
node --test "$SKILL_DIR/scripts/badge.test.mjs"
```

17 tests, all using local fake data. The `--pr` tests run against a fake `gh` executable that reads
and writes a JSON file, so the suite never contacts GitHub.

## Design notes

The mechanism follows the public DeepSeek Harness badge Skill (`@deepseek-ai/dsh-skill-badge`): one
Skill instruction, one fixed Markdown block, and bundled images, with no model tools, no platform
API, and no hooks. The idempotent writer is the part this Plugin adds on top.

## License

Apache-2.0. See [LICENSE](LICENSE).
