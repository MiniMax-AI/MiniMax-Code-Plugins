# skill-bridge

> Convert openclaw (and similar) skills into mavis/mcode-compatible skills or plugins.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](package.json)

## Why

`openclaw` (and other agent frameworks) and `mavis` / `mcode` don't share a skill format. The hard parts are:

1. **Schema gap** — openclaw skills are 2-field frontmatter; mavis needs `descriptions.zh-Hans`, `displayNames`, `metadata`, locale keys.
2. **Encoding gap** — openclaw wrote Chinese as GBK and filenames as mojibake. mavis requires UTF-8.
3. **Path gap** — openclaw skills hardcode `C:\Users\Administrator\.openclaw\workspace\...` and `/tmp/CLI-Anything/...`. mavis needs parameterized paths.
4. **Platform gap** — openclaw assumes `bash` / `pip install -e .` / `python3` in PATH. mavis (especially on Windows) needs PowerShell equivalents.
5. **Discovery gap** — openclaw's staging directory is not in mavis's skill scan path. Copying files there does nothing.

**skill-bridge** turns "copy the folder and pray" into a deterministic pipeline: detect → analyze → classify → transform → lint.

## Install

```bash
# from a clone of this repo
npm install
npm link            # so `mcode-skill-bridge` is on PATH
# OR via mcode plugin install (after this is published):
#   mcode plugin add https://github.com/antianqi/skill-bridge
```

Requires **Node.js 22.19+ or 24+** (matches the mcode engine).

## Quick start

```bash
# 1. Look at one openclaw skill
mcode-skill-bridge analyze /path/to/openclaw/skills/task-tracker

# 2. See what tier it falls into
mcode-skill-bridge classify /path/to/openclaw/skills/task-tracker

# 3. Convert to a mavis-compatible skill
mcode-skill-bridge convert /path/to/openclaw/skills/task-tracker \
    --out ~/.minimax/agents/mavis/skills/task-tracker
```

After step 3, restart mavis (or start a new session) and the converted skill shows up in `<available_skills>`.

## How it works

```
input SKILL.md
   │
   ▼
[detect]     GBK vs UTF-8; restore mojibake if needed
   │
   ▼
[analyze]    parse frontmatter, scan hardcoded paths, scan external commands
   │
   ▼
[classify]   pure-translate | pure-wrapped-fix | wrapped-* | abandon
   │
   ▼
[transform]  write new SKILL.md (+ optional references/) to mavis schema
   │
   ▼
[lint]       run the official skill-creator lint on the output
   │
   ▼
output: mavis-compatible skill
```

### The three tiers

| Tier | What it is | Output in v0.1 |
|---|---|---|
| `pure-translate` | Pure instruction, ASCII-clean, no hardcoded paths | A `SKILL.md` with enriched frontmatter only |
| `pure-wrapped-fix` | Pure instruction but with hardcoded paths or GBK | A `SKILL.md` with paths parameterized + encoding fixed + Windows notes added |
| `wrapped-*` | Needs an external CLI/API (Python, ComfyUI, Douyin, …) | **Not supported in v0.1.** v0.2 will emit a plugin skeleton. |

## What's in v0.1

- ✅ `lib/detect.js` — UTF-8 / GBK detection via `iconv-lite` + heuristic mojibake detection
- ✅ `lib/paths.js` — 6 hardcoded path patterns → `${OPENCLAW_HOME}`, `${OPENCLAW_WORKSPACE}`, `${SCRATCH}`, `${DATA_DIR}`
- ✅ `lib/analyze.js` — YAML frontmatter parse, hardcoded-path scan, external-command scan
- ✅ `lib/classify.js` — 4-question decision tree
- ✅ `lib/transform-skill.js` — frontmatter enrichment, body path rewriting, 500-line body splitter, Windows notes injection
- ✅ `lib/lint.js` — wraps the official `~/.minimax/.builtin-skills/skill-creator/scripts/lint-skill.js` (handles the `.js`-as-ESM quirk)
- ✅ `index.js` — CLI with `detect` / `analyze` / `classify` / `convert` / `lint`
- ✅ `skills/SKILL.md` — discoverable LLM entry (so a Mavis session can use it without remembering the CLI)
- ✅ 29 unit + integration tests
- ✅ 3 working demos (see `examples/output/`)

## What's NOT in v0.1

- ❌ `wrapped-*` → plugin skeleton generation (planned for v0.2)
- ❌ GBK **filename** restoration (we warn, we don't rename)
- ❌ npm publish (planned for v0.2)
- ❌ Reverse tool (mavis → openclaw)
- ❌ Auto-registration into mavis's scan path (you have to restart the session)

## Try the demos

```bash
git clone https://github.com/antianqi/skill-bridge
cd skill-bridge
npm install
npm run demo:all
# inspect the output
ls examples/output/task-tracker
cat examples/output/task-tracker/SKILL.md
cat examples/output/task-tracker/conversion-report.md
```

The three demos cover the main pure-tier shapes:

| Demo | What it stresses |
|---|---|
| `task-tracker` | Chinese name in source, hardcoded `${OPENCLAW_WORKSPACE}` path, no external deps |
| `investor-brand-kit` | CJK body with rich content, no path/encoding issues (pure-translate) |
| `self-improving-agent` | 600+ line body → automatically split into `references/` |

## CLI reference

```
mcode-skill-bridge detect <file>            Detect encoding of a SKILL.md
mcode-skill-bridge analyze <file-or-dir>    Analyze (frontmatter, paths, external cmds)
mcode-skill-bridge classify <file-or-dir>   Classify into pure / wrapped / abandon
mcode-skill-bridge convert <file-or-dir>    Convert and write to --out
mcode-skill-bridge lint <skill-dir>         Lint a converted skill

Options:
  --out <dir>       Output directory (default: ./out/<name>)
  --force           Overwrite existing output
  --no-lint         Skip lint after convert
  --scope <s>       user | agent | project (informational)
  --json            Machine-readable output
```

## Project layout

```
skill-bridge/
├── plugin.json              # mcode plugin manifest
├── index.js                 # CLI entry
├── package.json
├── lib/                     # pure ESM modules
│   ├── detect.js
│   ├── paths.js
│   ├── analyze.js
│   ├── classify.js
│   ├── transform-skill.js
│   └── lint.js
├── skills/
│   └── SKILL.md             # discoverable LLM entry
├── references/              # human docs
│   ├── compatibility-matrix.md
│   ├── path-patterns.md
│   └── encoding-tables.md
├── examples/
│   ├── input/               # original openclaw skills (CC0 from openclaw)
│   └── output/              # converted mavis skills
└── tests/
    ├── detect.test.mjs
    ├── paths.test.mjs
    ├── classify.test.mjs
    ├── transform-skill.test.mjs
    └── cli.test.mjs
```

## Method — how we decided what's a "compatible skill"

See [`references/compatibility-matrix.md`](references/compatibility-matrix.md) for the full mapping of all 36 openclaw skills into the three tiers.

The high-level rule:

> If the skill is a self-contained instruction (you can read it and act on it without installing anything else), it is `pure`. Otherwise, it is `wrapped`. If it depends on openclaw-specific runtime (e.g. the openclaw TUI, a specific Python venv, a non-replicable hard-coded directory), it is `abandon`.

## Roadmap

- **v0.2** — `wrapped-*` tier: generate a real mavis plugin (`plugin.json` + `index.js`) for skills that need external CLIs/APIs
- **v0.3** — Web UI via the `visual-page` skill, history-aware incremental conversion
- **v0.4** — Reverse tool: mavis skill → openclaw-compatible bundle

## Contributing

1. Fork the repo.
2. Add a fixture under `tests/fixtures/` for the new edge case.
3. Add a test under `tests/`.
4. Open a PR. CI will run `npm test`.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- The mavis skill schema and lint rules are owned by MiniMax.
- The three demo skills (`task-tracker`, `investor-brand-kit`, `self-improving-agent`) are adapted from the openclaw workspace with the author's permission.
- Built by [antianqi](https://github.com/antianqi).
