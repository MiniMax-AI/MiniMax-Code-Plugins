# Contributing to Mcode-webui plugin

This is the packaged plugin view of the project. The full
contribution guide lives in the **source repo**:

**[github.com/Wzdhehe/mcode-webui → CONTRIBUTING.md](https://github.com/Wzdhehe/mcode-webui/blob/main/CONTRIBUTING.md)**

## Quick reference

| Need to … | Read |
|-----------|------|
| Add a route, event, or UI panel | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Update a config / env var | [server/lib/config.js](server/lib/config.js) + [docs/API.md](docs/API.md) |
| Bump the version | `package.json` (root + plugin copy) + `plugin.json` |
| Update capability list | [docs/CAPABILITIES.md](docs/CAPABILITIES.md) + `plugin.json#extensions.capabilities` |
| Change a security disclosure | [references/SECURITY-NOTES.md](references/SECURITY-NOTES.md) (the single source of truth) |

## Sync rule

The plugin tree here (`server/`, `public/`, `test/`, `docs/`) is a
**real copy** of the source-repo root. When you change a file at
the root, mirror the same change here in the same commit, or run
`npm run package:plugin` at the source repo to regenerate the
plugin tree.

## Submitting to the community registry

The official
[MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
repo accepts plugin submissions as folders under
`plugins/<author>/<plugin-name>/`. The `plugins/Wzdhehe/mcode-webui/`
tree in this repo is the unit of submission — fork the registry,
copy this folder in, open a PR.

The official gate is `npm run check` at the registry root. This
repo ships a mirror (`npm run validate:plugin`) that runs the same
checks locally before you push.
