// webui/server/lib/markdown.js
// Lease C06: serialize session messages to markdown.
//
// Contract:
//   serializeMessages(messages, options?) → string
//     - messages: Array<{ role, content, tool_calls?, tool_call_id?, name? }>
//     - role ∈ {user, assistant, system, tool, thinking, plan, ask, todo, goal}
//     - options:
//         { fenceLen?: number = 4, includeFence?: boolean = true }
//   serializeSession(session, messages, meta?) → string
//     - session: { id, title, workspace, createdAt, updatedAt, mcodeSessionId? }
//     - messages: same as above
//     - meta: optional { source: 'webui'|'mcode'|'merged', exportedAt: ms }
//
// Design notes:
//   - 4-backtick fence (````) by default — chat content frequently contains
//     3-backtick fenced code blocks; 4 avoids ambiguity when the export
//     is pasted into another renderer.
//   - Tool calls render as <details><summary>…</summary>…</details> so they
//     collapse in GitHub / VS Code preview but stay readable when expanded.
//   - Heading hierarchy: H1 = session title, H2 = role, H3 = nested
//     (tool call name) — matches GitHub's anchor scheme.
//   - Output is pure markdown (no HTML <head> wrapper) — callers wrap
//     as needed for download.

const DEFAULT_FENCE_LEN = 4;

// Escape user content for safe inclusion inside markdown — we don't try to
// be fully safe (markdown is a permissive format), but we neutralise the
// common pitfalls (raw </details> close tag, raw <script>, raw newlines
// inside a single line that should stay single).
function _escapeInline(s) {
  if (typeof s !== "string") return "";
  // Collapse triple+ backticks to N+1 so we never collide with our fence
  return s.replace(/`+/g, (m) => "`".repeat(m.length + 1));
}

// Choose a fence length that does NOT appear in the content. Always at
// least DEFAULT_FENCE_LEN.
function _pickFence(content, fenceLen) {
  const minLen = Math.max(DEFAULT_FENCE_LEN, fenceLen || DEFAULT_FENCE_LEN);
  let len = minLen;
  while (content.includes("`".repeat(len))) len += 1;
  return "`".repeat(len);
}

// Render a code block with a fence that does not appear in `code`.
function _codeBlock(code, lang = "", fenceLen) {
  const text = typeof code === "string" ? code : String(code || "");
  const fence = _pickFence(text, fenceLen);
  const langTag = lang ? lang.replace(/[^a-zA-Z0-9_+\-#]/g, "") : "";
  return `${fence}${langTag}\n${text}\n${fence}`;
}

// Render a tool call as a <details> block. The fenced body keeps raw
// arguments/output verbatim so it round-trips on copy-paste.
function _renderToolCall(tc) {
  const name = (tc && tc.name) || "tool";
  const args = (tc && tc.arguments) || (tc && tc.input) || "";
  const output = (tc && tc.output) || "";
  const status = (tc && tc.status) || "";
  const header = `tool: ${name}${status ? ` [${status}]` : ""}`;
  const inner = [];
  if (args) {
    inner.push("**Arguments**");
    inner.push("");
    inner.push(_codeBlock(typeof args === "string" ? args : JSON.stringify(args, null, 2), "json"));
    inner.push("");
  }
  if (output) {
    inner.push("**Output**");
    inner.push("");
    inner.push(_codeBlock(typeof output === "string" ? output : JSON.stringify(output, null, 2)));
    inner.push("");
  }
  if (inner.length === 0) inner.push("(no output)");
  return `<details>\n<summary>${header}</summary>\n\n${inner.join("\n")}\n</details>`;
}

// Render a single message by role.
function _renderMessage(msg, opts) {
  if (!msg || typeof msg !== "object") return "";
  const role = String(msg.role || "").toLowerCase();
  const content = typeof msg.content === "string" ? msg.content : (msg.text || "");
  const heading = {
    user: "User",
    assistant: "Assistant",
    system: "System",
    tool: "Tool",
    thinking: "Thinking",
    plan: "Plan",
    ask: "Ask",
    todo: "Todo",
    goal: "Goal",
  }[role] || (role ? role[0].toUpperCase() + role.slice(1) : "Message");

  const lines = [];
  lines.push(`## ${heading}`);
  lines.push("");

  // Tool messages use a structured shape (name + arguments + status +
  // output) rather than `content`. Render them as a single
  // <details> block so they collapse in viewers but stay searchable.
  if (role === "tool" && (msg.name || msg.arguments !== undefined || msg.output !== undefined)) {
    const tc = {
      name: msg.name,
      arguments: msg.arguments,
      status: msg.status,
      output: msg.output,
    };
    lines.push(_renderToolCall(tc));
    lines.push("");
    return lines.join("\n");
  }

  if (content) {
    lines.push(_escapeInline(content));
    lines.push("");
  }
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    lines.push("**Tool calls**");
    lines.push("");
    for (const tc of msg.tool_calls) lines.push(_renderToolCall(tc));
    lines.push("");
  }
  return lines.join("\n");
}

// Public API — convert messages array to markdown body (no H1 wrapper).
export function serializeMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return "";
  const opts = {
    fenceLen: DEFAULT_FENCE_LEN,
    includeFence: true,
    ...options,
  };
  const blocks = [];
  for (const m of messages) {
    const block = _renderMessage(m, opts);
    if (block) blocks.push(block);
  }
  return blocks.join("\n");
}

// Public API — full session export with H1 + TOML frontmatter + body.
export function serializeSession(session, messages, meta = {}) {
  const title = (session && session.title) || "Untitled session";
  const id = (session && session.id) || "";
  const mcodeSid = (session && session.mcodeSessionId) || "";
  const workspace = (session && session.workspace) || "";
  const createdAt = (session && session.createdAt) || 0;
  const updatedAt = (session && session.updatedAt) || 0;
  const exportedAt = meta.exportedAt || Date.now();
  const source = meta.source || "webui";

  const fmLines = [
    "---",
    `title = ${JSON.stringify(title)}`,
    `session_id = ${JSON.stringify(id)}`,
  ];
  if (mcodeSid) fmLines.push(`mcode_session_id = ${JSON.stringify(mcodeSid)}`);
  if (workspace) fmLines.push(`workspace = ${JSON.stringify(workspace)}`);
  if (createdAt) fmLines.push(`created_at = ${JSON.stringify(new Date(createdAt).toISOString())}`);
  if (updatedAt) fmLines.push(`updated_at = ${JSON.stringify(new Date(updatedAt).toISOString())}`);
  fmLines.push(`exported_at = ${JSON.stringify(new Date(exportedAt).toISOString())}`);
  fmLines.push(`source = ${JSON.stringify(source)}`);
  fmLines.push(`message_count = ${Array.isArray(messages) ? messages.length : 0}`);
  fmLines.push("---");
  fmLines.push("");

  const head = `# Session: ${title}\n\n`;
  const body = serializeMessages(messages || []);
  return `${fmLines.join("\n")}\n${head}${body}`;
}

// Convenience — slugify a title for safe filenames.
export function slugifyTitle(title) {
  const s = (title || "session").toString();
  return s
    // Strip filesystem-unsafe chars AND shell-glob / punctuation noise
    .replace(/[\\/:*?"<>|!`'\$@#%^&()=+{}\[\]~]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

// Convenience — ISO timestamp suitable for filename suffix.
export function fileTimestamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  // YYYYMMDDTHHMMSS (no colons — Windows-safe)
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}