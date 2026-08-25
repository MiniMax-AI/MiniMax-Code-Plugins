---
name: plugin-author-helper
description: |
  Design, validate, and ship a marketplace Plugin (or Skill bundle) with proper manifest format, multi-ecosystem compatibility, version pinning, manifest fallback, install idempotency, and three-layer startup sync.
  USE WHEN: writing a new Plugin manifest, picking manifest format (Legacy vs AgentPlugin), adding `skills` / `mcp_servers` / `apps` / `hooks` / `interface` fields, validating a plugin before publish, designing marketplace install/remove/upgrade flows, or any task involving "make my plugin actually work in Codex".
  TRIGGER PHRASES: "plugin manifest", "PluginManifest", "marketplace", "agent plugin", ".agents/plugins/marketplace.json", "manifest fallback", "idempotency key", "plugin author", "plugin publish", "plugin version", "startup sync", "lock file".
  SKIP WHEN: writing a single skill (use `skill-auto-select`), pure MCP server (use `mcp-server` directly), one-off tool without packaging.
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/core-plugins/ (P-93/94/95/99)
  changes-from-v0.0.0: "Initial design distilled from P-93/94/95/99 deep-dive (Phase 1 Week 4)."
---

# Plugin Author Helper

Design, validate, and ship a Plugin that fits into the Codex (or compatible) Plugin
ecosystem. Mirrors the design of `codex-rs/core-plugins/`.

## When to use

Activate when:

- Writing a new `plugin.json` / `marketplace.json` manifest.
- Choosing between manifest formats (Legacy vs AgentPlugin).
- Validating a plugin before publish.
- Designing install / remove / upgrade / sync flows.
- Picking a plugin scope (User / System / Admin / Plugin) and pinning a version.

## When NOT to use

- Single skill authoring → use `skill-auto-select`.
- Pure MCP server (no Skill bundle) → use the `mcp-server` crate's own conventions.
- One-off tool scripts → don't package.

## Host runtime requirements

This Skill describes **how to design** a Plugin (manifest, idempotency, scope).
It does **not** cause the agent to install, modify, or publish anything on its own.
Specifically, the agent MUST NOT, on the strength of this Skill alone:

- Run `npm install` / `npm link` / any package manager command for the user.
- Write or overwrite files in `~/.minimax/.../plugins/`, `~/.codex/.../`,
  `~/.config/`, or any other user-level config directory.
- Hit a marketplace endpoint (download, install, upgrade) on the user's behalf.
- Trigger a plugin sync that reaches the network (3-layer fallback in Codex is a
  Codex-runtime concept; MiniMax Code may or may not have an equivalent).

All of the above require **explicit user confirmation** in the host's normal
permission flow (`approval_policy`, `ask` mode, or whatever the host uses).
This Skill is for **designing** the manifest / sync flow, not for **executing** it.
The agent that *runs* the install / sync must follow the host's user-confirmation
policy, **not** the patterns in this Skill.

## Process

### 1. Pick the manifest format

Codex supports two manifest formats:

| Format | Path | Notes |
|---|---|---|
| `Legacy` | `.claude-plugin/marketplace.json` / `.cursor-plugin/marketplace.json` | Older ecosystems. |
| `AgentPlugin` | `.agents/plugins/marketplace.json` / `.agents/plugins/api_marketplace.json` | Current Codex format. |

If the plugin should be cross-ecosystem (OpenAI + Claude + Cursor), ship both manifests and let the loader pick whichever it finds first.

### 2. Write the 8-field PluginManifest

```rust
struct RawPluginManifest {
    name: String,                                  // required
    version: Option<String>,                       // semver recommended
    description: Option<String>,                  // one-line
    keywords: Vec<String>,                         // tags
    skills: Option<RawPluginManifestPaths>,        // "./skills/<id>/SKILL.md" (./... required)
    mcp_servers: Option<RawPluginManifestMcpServers>, // MCP config
    apps: Option<String>,                          // apps connector
    hooks: Option<RawPluginManifestHooks>,         // 9 hook trigger points
    interface: Option<RawPluginManifestInterface>, // UI (display_name, icon, brand_color)
}
```

**Hard limits**:

- `MAX_DEFAULT_PROMPT_COUNT: 3` — at most 3 default prompts in `interface`.
- `MAX_DEFAULT_PROMPT_LEN: 128` — each prompt ≤ 128 chars.
- All paths in `skills` MUST use the `./...` syntax (`./skills/<id>/SKILL.md`) and resolve under the plugin root.

### 3. Provide a manifest fallback

If the main manifest is missing or malformed, fall back to a known-good shape. The
fallback typically contains just `name` + `version` + a minimal `skills` list.

### 4. Use a 3-letter marketplace name taxonomy

Pick a short, descriptive name with one of these prefixes:

| Prefix | Meaning |
|---|---|
| `openai-curated` | OpenAI-curated official |
| `openai-api-curated` | OpenAI API curated |
| `openai-bundled` | Bundled with Codex |
| `openai-bundled-alpha` | Bundled alpha |
| `openai-primary-runtime` | Primary runtime |

For your own marketplace, use `<author>-<purpose>` (e.g. `acme-data-pipelines`).

### 5. Use idempotency keys for create operations

```rust
pub struct CreateProjectParams {
    pub name: String,
    pub idempotency_key: String,   // ← critical
    // ...
}

pub struct CreatedProject {
    pub project: StoredProject,
    pub created: bool,              // true = new, false = idempotent hit
}
```

**Always require `idempotency_key`** on create / install endpoints. The same key + same payload returns the existing object with `created: false`. Different key + same name creates a new object (no conflict).

### 6. Three-state updates: `Option<Option<T>>`

For partial-update APIs:

- `None` — "do not touch this field".
- `Some(None)` — "set this field to null/empty".
- `Some(Some(value))` — "set this field to value".

This is the only correct encoding for "no change vs explicit clear" in JSON.

### 7. Report moved vs unchanged

```rust
pub enum ProjectMoveOutcome { Moved, Unchanged }
```

Reorder APIs should return whether the operation actually moved anything. UI uses this to skip re-renders on no-ops.

### 8. Use a `BTreeMap` for metadata

Stable iteration order = stable output. Don't use `HashMap` for user-visible metadata.

### 9. Three-layer startup sync

When the marketplace needs to refresh plugins at every Codex startup, use this 3-layer fallback:

```text
1) GitHub API  →  GET /repos/openai/plugins/git/refs/codex/curated-sync
                  compare SHA against .tmp/plugins.sha
                  if changed, download + extract
2) Backend archive fallback  →  GET /backend-api/plugins/export/curated
3) Git clone  →  git clone https://github.com/openai/plugins.git --branch refs/codex/curated-sync
```

Each layer has a 30s timeout. Use a lock file (`.tmp/plugins.sync.lock`) to prevent
concurrent syncs from multiple Codex processes. Use a SHA cache (`.tmp/plugins.sha`)
to skip work when nothing changed. Stale temp dirs (older than 10 min) are auto-cleaned.

### 10. Decide a scope per skill within the plugin

Each skill in your plugin should be `User` (user-installed) / `System` (bundled) / `Plugin` (this plugin) scoped. Document the scope in the frontmatter `metadata.scope` field.

## Output contract

A plugin that follows this design:

- Has both `plugin.json` (AgentPlugin) AND a fallback manifest.
- Has `name` / `version` / `description` / `keywords` / `skills` / `mcp_servers` / `apps` / `hooks` / `interface` set.
- Default prompts ≤ 3 entries, each ≤ 128 chars.
- All skill paths use the `./...` syntax.
- Has a marketplace name following the prefix taxonomy.
- All create / install endpoints require an `idempotency_key`.
- Uses `BTreeMap` for any user-visible metadata.
- If a startup sync is needed, it uses a 3-layer fallback with a lock file and SHA cache.

## Common pitfalls

- **No idempotency key** → user retries after a network blip create duplicates. Always require it.
- **`HashMap` for metadata** → JSON output flickers on every render. Use `BTreeMap`.
- **Two syncs in parallel** → file corruption. Lock file mandatory.
- **Forgetting fallback layer** → GitHub outage takes down all installs. Always have the archive + clone as backups.
- **Default prompts > 3** or > 128 chars → silently truncated. Stay under the limit.
- **Skill paths not starting with `./`** → resolution fails. Always use `./skills/.../SKILL.md`.
- **`Option<T>` instead of `Option<Option<T>>`** → cannot distinguish "no change" from "set to null".

## Example — minimal plugin manifest

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0/plugin.schema.json",
  "name": "acme-data-pipelines",
  "version": "0.1.0",
  "description": "Data pipeline skills for ETL, schema validation, and warehouse sync.",
  "keywords": ["data", "etl", "pipeline"],
  "skills": "./skills/*/SKILL.md",
  "mcp_servers": {
    "warehouse": {
      "transport": "stdio",
      "command": "./bin/warehouse-mcp"
    }
  },
  "interface": {
    "display_name": "ACME Data Pipelines",
    "brand_color": "#0066cc"
  }
}
```

## Verification checklist

- [ ] Manifest has all 8 fields; `name` is set.
- [ ] Default prompts ≤ 3 entries, each ≤ 128 chars.
- [ ] All skill paths use the `./...` syntax.
- [ ] Manifest fallback present.
- [ ] Marketplace name follows the prefix taxonomy.
- [ ] All create / install endpoints require an `idempotency_key`.
- [ ] Partial updates use `Option<Option<T>>` for 3-state.
- [ ] Reorder APIs return `Moved` / `Unchanged`.
- [ ] User-visible metadata uses `BTreeMap` not `HashMap`.
- [ ] If startup sync is used: 3-layer fallback, lock file, SHA cache, 30s timeout, 10-min stale cleanup.
