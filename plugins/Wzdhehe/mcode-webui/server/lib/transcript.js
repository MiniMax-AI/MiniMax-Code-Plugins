// webui/server/lib/transcript.js
// v2 (2026-09-20 webui-manual-audit): mcode runtime-DB transcript reader +
//   webui chat-line mapper, extracted from routes/export.js#_readMcodeTranscript
//   so POST /api/sessions/switch can backfill history without duplicating the
//   schema-probing logic. Two exports matter:
//
//   readMcodeTranscript(mcodeSid, opts) — read-only probe of the runtime DB,
//     returns { messages, ok, reason?, source?, error? }. The default probe
//     list is byte-for-byte the legacy 3-candidate set export.js used (same
//     SQL, same row mapping, same fail-soft reasons) so wiring export.js to
//     this module changes zero export behavior.
//
//   messagesToChatLines(messages, opts) — the INVERSE of the webui chat line
//     grammar (export.js#_parseChatLines / public/app/render.js#parseChatLines
//     parse lines→messages; we map messages→lines). Only shapes both parsers
//     round-trip confidently are emitted; anything ambiguous is skipped, not
//     invented (see _AMBIGUOUS_INDENT_RE).
//
//   loadTranscriptChatLines(mcodeSid, opts) — read (legacy + v2 data_json
//     probes) then map, with the switch-path caps applied (last 400 lines /
//     200KB total, whichever binds first).

import { existsSync } from "node:fs";
import { MCODE_RUNTIME_DB } from "./config.js";
import { getMcodeBetterSqlite3 } from "./db.js";

// ============================================================
// Probe candidates — the mcode schema is unstable, try a handful
// of likely shapes. If none match, fail-soft with a reason.
// ============================================================

// v2 (2026-09-20 webui-manual-audit): LEGACY set — extracted VERBATIM from
//   routes/export.js (same SQL strings, same order). export.js keeps this
//   default so its behavior (and its tests) are untouched.
export const LEGACY_TRANSCRIPT_PROBES = [
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, content, tool_calls_json FROM local_runtime_message_rows WHERE session_id = ? ORDER BY seq ASC, ts ASC, rowid ASC",
    kind: "legacy-cols",
    mapRow: _mapLegacyRow,
  },
  {
    table: "local_runtime_messages",
    sql:
      "SELECT role, content, tool_calls_json FROM local_runtime_messages WHERE session_id = ? ORDER BY seq ASC, ts ASC, rowid ASC",
    kind: "legacy-table",
    mapRow: _mapLegacyRow,
  },
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, content FROM local_runtime_message_rows WHERE session_id = ? ORDER BY rowid ASC",
    kind: "legacy-cols-min",
    mapRow: _mapLegacyRow,
  },
];

// v2 (2026-09-20 webui-manual-audit): the schema the runtime DB ACTUALLY
//   carries today (probed against a live ~/.minimax/v2/sqlite/runtime-state
//   .sqlite): local_runtime_message_rows(id, session_id, msg_id, role,
//   turn_id, created_at_ms, data_json, source, source_context_json) where
//   data_json = {msg_id, timestamp, role, msg_type, msg_content,
//   thinking_content, tool_calls: [{tool_name, tool_call_id,
//   tool_call_status, tool_call_args, tool_call_result_data}], ...}.
//   The legacy probes all miss on it ("no such column: content"), which is
//   why export's enrichment was silently dead — this probe revives reads for
//   the switch path. NOT part of the default set: export.js must not change
//   behavior, so only callers that opt in (switch backfill) append it.
export const V2_DATA_JSON_PROBES = [
  {
    table: "local_runtime_message_rows",
    sql:
      "SELECT role, data_json FROM local_runtime_message_rows WHERE session_id = ? ORDER BY created_at_ms ASC, rowid ASC",
    kind: "v2-data-json",
    mapRow: _mapV2DataJsonRow,
  },
];

// Row mapper for the legacy probes — exact copy of export.js's original
// normalization (role defaults to "system", content coerced to string,
// tool_calls_json parsed as array when possible).
function _mapLegacyRow(r) {
  const role = (r && r.role) ? String(r.role).toLowerCase() : "system";
  const content = (r && typeof r.content === "string") ? r.content : "";
  let tool_calls = null;
  if (r.tool_calls_json) {
    try {
      const parsed = JSON.parse(r.tool_calls_json);
      if (Array.isArray(parsed)) tool_calls = parsed;
    } catch {
      /* malformed — ignore */
    }
  }
  const m = { role, content };
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

// tool_call_status enum as observed in the live DB (38662 rows at 2, 1660 at
// 3; the 3-family result texts are tool failures like "Could not find the
// exact text…"). Mapped conservatively: unknown ints emit NO status line —
// the frontend then renders its own "pending" default instead of us
// inventing a wrong verdict.
function _v2ToolStatus(n) {
  if (n === 2) return "completed";
  if (n === 3) return "failed";
  return null;
}

// tool_call_result_data is a JSON string shaped like the acp tool_update
// rawOutput: {"content":[{"type":"text","text":"…"}]}. Extract the text
// parts joined with "\n" — mirrors routes' outText extraction in
// server/lib/mcode-acp.js (tool_update handler). Non-string / malformed
// results yield "" (conservative: no output lines).
function _v2ResultText(raw) {
  if (!raw) return "";
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return "";
    }
  }
  if (!parsed || !Array.isArray(parsed.content)) return "";
  return parsed.content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// Row mapper for the v2 data_json probe. Normalizes to the same
// {role, content, tool_calls} message shape the legacy probes produce, plus
// two switch-only extras (thinking, per-call status/result) that the
// chat-line mapper consumes. Unrecognized roles are dropped (not coerced to
// system — export's coercion stays in the legacy mapper only).
function _mapV2DataJsonRow(r) {
  let d = null;
  if (r && typeof r.data_json === "string" && r.data_json) {
    try {
      d = JSON.parse(r.data_json);
    } catch {
      d = null;
    }
  } else if (r && r.data_json && typeof r.data_json === "object") {
    d = r.data_json;
  }
  if (!d) return null;
  const role = (r && r.role ? String(r.role) : (d.role ? String(d.role) : "")).toLowerCase();
  if (role !== "user" && role !== "assistant" && role !== "system") return null;
  const content = typeof d.msg_content === "string" ? d.msg_content : "";
  const thinking = typeof d.thinking_content === "string" ? d.thinking_content : "";
  let tool_calls = null;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) {
    const calls = [];
    for (const tc of d.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      const name = tc.tool_name || tc.name;
      if (!name || typeof name !== "string") continue; // no name → cannot build a "→ name" header
      let args = tc.tool_call_args !== undefined ? tc.tool_call_args : tc.arguments;
      if (args && typeof args === "object") {
        try { args = JSON.stringify(args); } catch { args = ""; }
      }
      calls.push({
        name,
        arguments: typeof args === "string" ? args : "",
        status: _v2ToolStatus(tc.tool_call_status),
        result: _v2ResultText(tc.tool_call_result_data),
      });
    }
    if (calls.length > 0) tool_calls = calls;
  }
  const m = { role, content };
  if (thinking) m.thinking = thinking;
  if (tool_calls) m.tool_calls = tool_calls;
  return m;
}

// ============================================================
// readMcodeTranscript — read-only probe loop (sync: better-sqlite3 is sync,
// the switch hot path must not gain an awaitable).
// Gate order matches export.js's original exactly:
//   no sid → bad sid → db missing → better-sqlite3 missing → probe loop.
// ============================================================
export function readMcodeTranscript(mcodeSid, opts = {}) {
  const dbPath = opts.dbPath || MCODE_RUNTIME_DB;
  const getDb = opts.getDb || getMcodeBetterSqlite3;
  const probes =
    Array.isArray(opts.probes) && opts.probes.length > 0
      ? opts.probes
      : LEGACY_TRANSCRIPT_PROBES;
  if (!mcodeSid) return { messages: [], ok: false, reason: "no_mcode_sid" };
  if (!/^mvs_[a-f0-9]{32}$/.test(mcodeSid)) {
    return { messages: [], ok: false, reason: "bad_mcode_sid" };
  }
  if (!existsSync(dbPath)) {
    return { messages: [], ok: false, reason: "mcode_db_not_found" };
  }
  const Db = getDb();
  if (!Db) {
    return { messages: [], ok: false, reason: "better_sqlite3_not_loaded" };
  }
  let db;
  try {
    db = new Db(dbPath, { readonly: true });
    for (const c of probes) {
      try {
        const rows = db.prepare(c.sql).all(mcodeSid);
        if (Array.isArray(rows) && rows.length > 0) {
          const msgs = rows
            .map((r) => c.mapRow(r))
            .filter(Boolean)
            .filter((m) => m.content || m.thinking || (m.tool_calls && m.tool_calls.length));
          db.close();
          // `source` keeps the probe's TABLE name (export.js surfaces it in
          // _meta as the enrichment source); `probe` names the shape for logs.
          return { messages: msgs, ok: true, source: c.table, probe: c.kind };
        }
      } catch {
        // table missing or schema mismatch — try next
      }
    }
    db.close();
    return { messages: [], ok: false, reason: "no_matching_table" };
  } catch (e) {
    if (db) try { db.close(); } catch {}
    return { messages: [], ok: false, reason: "db_error", error: e.message };
  }
}

// ============================================================
// messagesToChatLines — the INVERSE of the webui chat-line grammar.
//
// Line grammar emitted (must stay parseable by BOTH
// export.js#_parseChatLines and public/app/render.js#parseChatLines):
//   user       "› " + text        (newlines collapsed to spaces — the live
//                                 writer chat.js:50 keeps raw newlines, but
//                                 both parsers read ONE array element = ONE
//                                 line, so collapsing is what round-trips)
//   thinking   "▲ " + text        (collapsed; emitted before the ● line,
//                                 matching the live stream order ▲-then-●)
//   assistant  "● " + text        (collapsed; same as chat.js:122-133 does
//                                 for the final answer)
//   system     "○ " + text        (collapsed)
//   tool       "→ " + name [+ "  " + argsJSON]   (two-space separator,
//                                 exactly like mcode-acp.js:364), followed by
//                                 indented block lines:
//                                   "  [completed]" / "  [failed]"
//                                   "  " + resultTextLine
//                                 Result lines that would be REPARSED as a
//                                 different shape (a full "[…]" status line,
//                                 "! error", "@ path") are skipped, not
//                                 re-encoded — conservative per the audit
//                                 fix contract: never invent a shape.
//
// Caps (switch hot path — the SSE state push carries cs.chat wholesale):
//   keep the LAST maxLines lines, then drop from the front while the total
//   UTF-8 byte size exceeds maxBytes. A single line that alone exceeds
//   maxBytes is byte-truncated with an explicit " …[truncated]" marker —
//   the alternative (dropping the whole tail) would empty the chat.
// ============================================================

// Stripped indented forms that parseChatLines would classify as status /
// error / location instead of output text. Emitting them verbatim would
// silently change their meaning on re-parse.
const _AMBIGUOUS_INDENT_RE = /^\[[^\]]*\]$|^!\s|^@\s/;

// Collapse newlines the way the live writers do (chat.js:122
// `r.answer.replace(/\n+/g, " ").trim()`); \r included for CRLF transcripts.
function _oneLine(s) {
  return String(s == null ? "" : s).replace(/\r?\n+/g, " ").trim();
}

// Byte length in UTF-8 (ASCII fast path — the common case for JSON args).
function _bytes(s) {
  return /[^\x00-\x7F]/.test(s) ? Buffer.byteLength(s, "utf8") : s.length;
}

function _byteTruncate(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Cut on a UTF-8 character boundary, then append the marker.
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf8");
}

// Map one message to raw (uncapped) lines. Returns the lines; shapes we
// cannot map confidently contribute nothing (skipped, not invented).
function _messageToLines(m) {
  const out = [];
  if (!m || typeof m !== "object") return out;
  const role = String(m.role || "").toLowerCase();
  const content = typeof m.content === "string" ? m.content : "";

  if (role === "user") {
    const t = _oneLine(content);
    if (t) out.push(`› ${t}`);
    return out;
  }
  if (role === "system") {
    const t = _oneLine(content);
    if (t) out.push(`○ ${t}`);
    return out;
  }
  if (role !== "assistant") return out; // unknown role → skip

  // thinking first (live stream order: ▲ accumulates, then ● finalizes)
  const think = _oneLine(m.thinking);
  if (think) out.push(`▲ ${think}`);
  const answer = _oneLine(content);
  if (answer) out.push(`● ${answer}`);

  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      if (!tc || typeof tc !== "object") continue;
      // Accept both the v2 normalized shape ({name, arguments}) and an
      // OpenAI-ish {function:{name, arguments}} so legacy tool_calls_json
      // rows map too.
      const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
      const name = tc.name || (fn && fn.name);
      if (!name || typeof name !== "string" || !/\S/.test(name)) continue;
      let args = tc.arguments !== undefined ? tc.arguments : (fn && fn.arguments);
      if (args && typeof args === "object") {
        try { args = JSON.stringify(args); } catch { args = ""; }
      }
      if (typeof args !== "string") args = "";
      args = args.replace(/\r?\n+/g, " ").trim(); // JSON.stringify is 1-line; defensive only
      out.push(args ? `→ ${name}  ${args}` : `→ ${name}`);
      // Status line only when the enum was recognized (2/3) — an unknown
      // status must NOT become an invented verdict.
      if (tc.status === "completed" || tc.status === "failed") {
        out.push(`  [${tc.status}]`);
      }
      // Output lines: from the v2 `result` text (or a legacy `output`
      // string when present). Blank / ambiguous lines are skipped.
      const resultText =
        typeof tc.result === "string" ? tc.result :
        typeof tc.output === "string" ? tc.output : "";
      if (resultText) {
        for (const ln of resultText.split("\n")) {
          if (!ln.trim()) continue; // a bare "  " line terminates the tool block in the frontend parser
          if (_AMBIGUOUS_INDENT_RE.test(ln.trim())) continue; // would re-parse as status/error/path
          out.push(`  ${ln.replace(/\s+$/, "")}`);
        }
      }
      if (tc.error && typeof tc.error === "string") {
        out.push(`  ! ${tc.error.replace(/\r?\n+/g, " ").trim()}`);
      }
    }
  }
  return out;
}

export function messagesToChatLines(messages, opts = {}) {
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 400;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : 200 * 1024;
  const src = Array.isArray(messages) ? messages : [];
  const raw = [];
  let skipped = 0;
  for (const m of src) {
    const lines = _messageToLines(m);
    if (lines.length === 0) skipped++;
    raw.push(...lines);
  }
  // Cap 1 — line count: keep the TAIL (recent history is what the user
  // switched TO see).
  let lines = raw.length > maxLines ? raw.slice(raw.length - maxLines) : raw.slice();
  // A front-truncation can orphan a tool block's indented output lines
  // (their "→ name" header fell off). Both parsers drop such orphans
  // silently; drop them here too so the stored chat has no dead lines.
  while (lines.length > 0 && /^\s{2,}\S/.test(lines[0])) lines.shift();
  // Cap 2 — total bytes: drop from the front while over budget.
  let total = lines.reduce((s, l) => s + _bytes(l), 0);
  while (lines.length > 1 && total > maxBytes) {
    total -= _bytes(lines[0]);
    lines.shift();
  }
  // Last resort: a single surviving line still over budget gets an explicit
  // truncation marker (never a silent full drop — that would read as
  // "switching does nothing", the exact bug this module exists to fix).
  let truncated = false;
  if (lines.length === 1 && _bytes(lines[0]) > maxBytes) {
    const MARKER = " …[truncated]";
    lines = [_byteTruncate(lines[0], maxBytes - _bytes(MARKER)) + MARKER];
    truncated = true;
  } else if (raw.length > 0 && lines.length < raw.length) {
    truncated = true;
  }
  return { lines, skipped, truncated };
}

// ============================================================
// loadTranscriptChatLines — switch-path convenience: legacy + v2 probes,
// then map with the default caps. Never throws (caller still wraps in
// try/catch as belt-and-braces, but a read failure lands here as ok:false).
// ============================================================
export function loadTranscriptChatLines(mcodeSid, opts = {}) {
  const r = readMcodeTranscript(mcodeSid, {
    ...opts,
    probes:
      Array.isArray(opts.probes) && opts.probes.length > 0
        ? opts.probes
        : [...LEGACY_TRANSCRIPT_PROBES, ...V2_DATA_JSON_PROBES],
  });
  if (!r.ok) return { ok: false, lines: [], reason: r.reason, error: r.error };
  const mapped = messagesToChatLines(r.messages, {
    maxLines: opts.maxLines,
    maxBytes: opts.maxBytes,
  });
  return {
    ok: true,
    lines: mapped.lines,
    source: r.source,
    probe: r.probe,
    messageCount: r.messages.length,
    skipped: mapped.skipped,
    truncated: mapped.truncated,
  };
}
