---
name: tool-discovery-pattern
description: |
  Design a tool that an LLM agent can reliably discover, search, and invoke — with proper schema, defer_loading, two-dimensional type classification, OpenAI protocol compatibility, and a tool-suggestion approval flow.
  USE WHEN: writing a new tool for an agent, designing the JSON schema for a tool, deciding between Function / Freeform / Namespace, fixing MCP tools that don't work with OpenAI models, building a tool-search index, designing a "request plugin install" flow, or any task involving "make my tool actually get picked up by the agent".
  TRIGGER PHRASES: "tool discovery", "tool search", "tool spec", "DiscoverableTool", "defer_loading", "tool_suggestion", "request_plugin_install", "MCP tool", "Dynamic tool", "JSON schema for tool", "responses API tool", "ResponsesApiFunctionTool", "ResponsesApiCustomTool", "ResponsesApiNamespace".
  SKIP WHEN: writing a Skill (use `skill-auto-select`), building a plugin manifest (use `plugin-author-helper`), single-use CLI script (not a tool).
license: Apache-2.0
compatibility: Requires MiniMax Code with Agent Plugins 1.0 support.
metadata:
  author: antianqi
  version: "0.1.0"
  inspired-by: https://github.com/openai/codex/tree/main/codex-rs/tools/ (P-107-114)
  changes-from-v0.0.0: "Initial design distilled from P-107-114 deep-dive (Phase 2 Week 6)."
---

# Tool Discovery Pattern

Design a tool that an LLM agent can discover, search, decide to use, and invoke.
Mirrors the design of `codex-rs/tools/`.

## When to use

Activate when designing:

- A new tool's JSON schema.
- The choice between Function (structured) / Freeform (custom) / Namespace (container) tool types.
- A search index over a large tool catalog.
- A "request plugin install" suggestion flow.
- Schema compatibility with OpenAI models.

## When NOT to use

- Skill authoring → use `skill-auto-select`.
- Plugin manifest authoring → use `plugin-author-helper`.
- Single-use scripts → not a tool.

## Process

### 1. Two-dimensional type classification

```rust
pub enum DiscoverableToolType { Connector, Plugin }
pub enum DiscoverableToolAction { Install, Enable }

pub enum DiscoverableTool {
    Connector(Box<AppInfo>),
    Plugin(Box<DiscoverablePluginInfo>),
}
```

**Any discoverable item is the cartesian product of (Type) × (Action)**. Adopt this
orthogonal taxonomy so a single `request_plugin_install(Connector, Install, ...)`
and `request_plugin_install(Plugin, Enable, ...)` work the same way.

### 2. Pick the right tool shape

For OpenAI Responses API, three shapes:

| Shape | When to use |
|---|---|
| `ResponsesApiFunctionTool` | Structured input schema, typed args. |
| `ResponsesApiCustomTool` | Freeform input, agent decides. |
| `ResponsesApiNamespace` | Container of multiple tools (e.g. all functions). |

Use Namespace to group related tools so the model sees one entry, not ten.

### 3. Write the 7-type JSON schema

OpenAI Structured Outputs supports exactly these `type` values:

```text
string | number | boolean | integer | object | array | null
```

Plus these composition keywords:

```text
anyOf | oneOf | allOf
$ref | enum | const | properties | required | description
```

Support both single-type (`"string"`) and multi-type (`["string", "null"]`) via:

```rust
pub enum JsonSchemaType {
    Single(JsonSchemaPrimitiveType),
    Multiple(Vec<JsonSchemaPrimitiveType>),
}
```

**Do not** support the full JSON Schema spec. Stick to the OpenAI subset.

### 4. Use BTreeMap for stable output

For any user-visible schema, use `BTreeMap<String, T>` not `HashMap`. Stable iteration order = stable JSON output = no spurious git diffs.

### 5. Adopt the defer_loading pattern

If you have many tools, expose them through a search index with `defer_loading: true`:

```text
[searchable] tools are exposed as Namespace entries containing:
  - name (short)
  - description (1-line)
  - defer_loading: true   ← schema is loaded only when the agent decides to use it
```

The agent sees a lightweight description, and the full `input_schema` is fetched only
on actual invocation. This prevents schema bloat from filling the context.

### 6. Apply the OpenAI compatibility fix

OpenAI models REQUIRE the `properties` field on any object schema. Many MCP servers
omit it. Patch it on load:

```rust
if obj.get("properties").is_none_or(Value::is_null) {
    obj.insert("properties".into(), Value::Object(Map::new()));
}
```

This matches the OpenAI Agents SDK behavior. Always apply on the host side, never
ask the upstream server to fix it.

### 7. Truncate descriptions at char boundaries

For agent plugins, cap descriptions at 1 KB:

```rust
const MAX_MCP_TOOL_DESCRIPTION_BYTES: usize = 1_000;
take_bytes_at_char_boundary(description, limit)
```

Use **byte** boundary, not char. Char truncation can split a multi-byte UTF-8
codepoint and produce invalid strings.

### 8. Provide a tool-search tool

Expose a top-level `tool_search` tool:

```rust
pub const TOOL_SEARCH_TOOL_NAME: &str = "tool_search";
pub const TOOL_SEARCH_DEFAULT_LIMIT: usize = 8;
```

The tool takes a query string and returns a list of `LoadableToolSpec` entries with
`defer_loading: true`. Each returned entry is wrapped in a `Namespace` with
`DEFAULT_FUNCTION_NAMESPACE`.

### 9. Provide a `request_plugin_install` tool

When the agent encounters a tool it doesn't have, it should be able to suggest installing it:

```rust
pub struct RequestPluginInstallArgs {
    pub tool_type: DiscoverableToolType,    // Connector | Plugin
    pub action_type: DiscoverableToolAction, // Install | Enable
    pub tool_id: String,
    pub suggest_reason: String,              // mandatory: WHY does the agent need this?
}

pub struct RequestPluginInstallResult {
    pub completed: bool,
    pub user_confirmed: bool,
    pub tool_name: String,
    // ...
}
```

The approval is tagged with `codex_approval_kind = "tool_suggestion"` so the UI
can present it as a suggestion, not a regular command approval. The
`persist: "always"` flag means once the user accepts, it's always allowed.

The `suggest_reason` field is **mandatory** — the agent must explain why it needs
this tool, not silently suggest. This prevents runaway tool installations.

### 10. Mark namespace descriptions

If a Namespace has an empty description, fill it in with a default:

```rust
if namespace.description.trim().is_empty() {
    namespace.description = default_namespace_description(&namespace.name);
}
```

Don't ship a tool with an empty description.

## Output contract

A tool that follows this design:

- Has a 7-type JSON schema (no exotic types).
- Has a BTreeMap-ordered schema.
- Uses Namespace to group related tools.
- Has `defer_loading: true` when surfaced through search.
- Has `properties` always present in object schemas.
- Description is ≤ 1KB for agent plugin tools, truncated at byte boundaries.
- Has a top-level `tool_search` tool for search.
- Has a `request_plugin_install` tool with mandatory `suggest_reason`.

## Common pitfalls

- **Empty `description`** → LLM can't decide if this tool fits. Always fill in (use `default_namespace_description` if needed).
- **Schema with non-OpenAI types** (`"date"`, `"uri"`, `"regex"`, ...) → rejected by model. Stay in the 7-type subset.
- **Object schema missing `properties`** → OpenAI rejects. Always patch.
- **`HashMap` schema** → unstable JSON output. Use `BTreeMap`.
- **`defer_loading: false` for hundreds of tools** → context explodes. Search index + defer is the answer.
- **`request_plugin_install` without `suggest_reason`** → runaway installation. Require the field.
- **Approval tagged as plain command** → wrong UI. Use `codex_approval_kind = "tool_suggestion"`.
- **Char-boundary truncation** → splits UTF-8. Use `take_bytes_at_char_boundary`.

## Example — minimal tool manifest

```json
{
  "name": "list_pipelines",
  "description": "List all data pipelines in the warehouse, optionally filtered by status.",
  "input_schema": {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "enum": ["running", "paused", "failed", "all"],
        "default": "all"
      }
    },
    "required": []
  },
  "defer_loading": true
}
```

## Verification checklist

- [ ] All object schemas have a `properties` field.
- [ ] All type fields are in the 7-type subset.
- [ ] All enums are arrays of strings.
- [ ] Schemas use `BTreeMap` not `HashMap`.
- [ ] Tools exposed through search are in Namespaces with `defer_loading: true`.
- [ ] `request_plugin_install` requires `suggest_reason` and tags `tool_suggestion` approval.
- [ ] Agent plugin tool descriptions are ≤ 1KB, truncated at byte boundaries.
- [ ] Empty `description` is auto-filled with `default_namespace_description`.
- [ ] `tool_search` tool is exposed at the top level.
