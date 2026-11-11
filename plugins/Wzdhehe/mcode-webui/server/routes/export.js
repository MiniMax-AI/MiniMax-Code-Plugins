// webui/server/routes/export.js
// Lease C06: GET /api/sessions/:id/export?format=md|json[&download=true]
//
// Sources:
//   - Primary: webui's `.webui-sessions.json` (loadSessions), which stores
//     the in-memory chat as `["› user", "● assistant", "→ tool {input}", …]`
//     line-prefix strings. We parse these into a structured
//     `[{role, content, tool_calls?}]` view for export.
//   - Secondary (best-effort): mcode's `runtime-state.sqlite`
//     `local_runtime_message_rows` table. If the db is unreadable / the
//     table is missing / the schema differs, we set `_meta.mcode_unavailable`
//     and continue with the webui source — never block export.
//
// Gates:
//   - format validation → 400 { error: "unsupported format" }
//   - session lookup → 404 { error: "session not found" }
//   - B03 authorize gate: `session.export` action. UI gets a
//     `needs_authorization` SSE modal; decline → 403. Tests drive the
//     decision via test/_setup.js#withDecisions (no auto-approve —
//     removed in the 2026-09-20 rigor fix).
//
// Output:
//   - format=json → application/json
//   - format=md   → text/markdown
//   - ?download=true → Content-Disposition: attachment; filename="<slug>-<ts>.<ext>"

import { loadSessions } from "../lib/sessions.js";
// v2 (2026-09-20 webui-manual-audit): _readMcodeTranscript's core moved to
// lib/transcript.js so POST /api/sessions/switch can share the exact same
// table-probing + fail-soft logic. Default probe set there is the legacy
// 3-candidate list carried over VERBATIM (same SQL, same row mapping, same
// reason strings) — export behavior is unchanged. existsSync /
// MCODE_RUNTIME_DB / getMcodeBetterSqlite3 are no longer imported here
// because only the extracted reader used them.
import { readMcodeTranscript } from "../lib/transcript.js";
import { authorize } from "../lib/authorize.js";
import { pushAlert } from "../lib/alerts.js";
import {
  serializeMessages,
  serializeSession,
  slugifyTitle,
  fileTimestamp,
} from "../lib/markdown.js";
// B01: append session.export events. Fail-closed since the 2026-09-20
// rigor fix — a failed audit write 5xx's the request + alerts.
import { append as _eventsAppend } from "../lib/events.js";

const VALID_FORMATS = new Set(["md", "json"]);

// Look up a session by id (webui id) or by mcodeSessionId.
function _findSession(id) {
  const all = loadSessions();
  let idx = all.findIndex((s) => s && s.id === id);
  let matchKind = idx >= 0 ? "webuiId" : null;
  if (idx < 0) {
    idx = all.findIndex((s) => s && s.mcodeSessionId === id);
    if (idx >= 0) matchKind = "mcodeSessionId";
  }
  if (idx < 0) return null;
  return { item: all[idx], matchKind, all };
}

// Parse the webui chat line-prefix format into structured messages.
// Recognised prefixes (in priority order):
//   › user text                  → user
//   ● assistant text             → assistant
//   ▲ thinking text              → thinking
//   → toolName  {args}           → tool (header; following indented lines = output)
//   ○ system / [error] / ! text  → system
//   ✓/✔ done · ✗/✘ failed · ○ pending → todo (single items as system)
//   Plan / Ask / Goal blocks     → plan/ask/goal (parsed heuristically)
//
// Unknown lines attach to the previous message's content (continuation).
function _parseChatLines(lines) {
  const messages = [];
  let current = null;
  let currentTool = null;

  const flushCurrent = () => {
    if (current) {
      messages.push(current);
      current = null;
    }
  };

  const flushTool = () => {
    if (currentTool) {
      messages.push(currentTool);
      currentTool = null;
    }
  };

  // Flush any pending tool, then any pending current message. Used when
  // a new block boundary appears (new user / assistant / thinking / etc).
  const flush = () => {
    flushTool();
    flushCurrent();
  };

  for (const raw of lines) {
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;

    // Plan block
    if (/^Plan\s*[:：]\s*.+/i.test(line.trim())) {
      flush();
      current = { role: "plan", content: line.trim() };
      continue;
    }

    // Ask / Goal block
    if (/^[\u25ce]\s*Ask\b/i.test(line.trim()) || /^Ask\b\s*[:：]?/i.test(line.trim())) {
      flush();
      current = { role: "ask", content: line.trim() };
      continue;
    }
    if (/^[\u25ce]\s*Goal\b/i.test(line.trim())) {
      flush();
      current = { role: "goal", content: line.trim() };
      continue;
    }

    // User
    const userMatch = line.match(/^[›>]\s+(.*)$/);
    if (userMatch) {
      flush();
      current = { role: "user", content: userMatch[1] };
      continue;
    }

    // Assistant
    const assistantMatch = line.match(/^[●•]\s+(.*)$/);
    if (assistantMatch) {
      flush();
      current = { role: "assistant", content: assistantMatch[1] };
      continue;
    }

    // Thinking
    const thinkMatch = line.match(/^[▲]\s+(.*)$/);
    if (thinkMatch) {
      if (current && current.role === "thinking") {
        current.content = current.content ? current.content + "\n" + thinkMatch[1] : thinkMatch[1];
      } else {
        flush();
        current = { role: "thinking", content: thinkMatch[1] };
      }
      continue;
    }

    // Tool call header
    const toolMatch = line.match(/^→\s+(\S+?)(?:\s{2}(.+))?$/);
    if (toolMatch) {
      flush();
      currentTool = {
        role: "tool",
        name: toolMatch[1],
        arguments: toolMatch[2] || "",
        status: "",
        output: [],
      };
      continue;
    }

    // If we're inside a tool call, indented lines belong to it
    if (currentTool) {
      const indented = line.match(/^[\s]{2,}(\S.*)$/);
      if (indented) {
        const stripped = indented[1];
        const statusMatch = stripped.match(/^\[([^\]]+)\]$/);
        if (statusMatch) {
          currentTool.status = statusMatch[1];
        } else if (/^!\s+/.test(stripped)) {
          currentTool.output.push("ERROR: " + stripped.replace(/^!\s+/, ""));
        } else {
          currentTool.output.push(stripped);
        }
        continue;
      }
      // Non-indented line — close the tool call so the new line can be
      // classified by the outer branches below.
      flushTool();
    }

    // System messages (○ / [error] / [warning] / [system] / ! )
    if (/^[○◯]\s+/.test(line) || /^\[(error|warning|info|system)\]/i.test(line.trim()) || /^!\s+/.test(line)) {
      flush();
      const text = line.replace(/^[○◯!\s]+/, "");
      current = { role: "system", content: text || line.trim() };
      continue;
    }

    // Todo item — keep with previous todo block if any
    const todoMatch = line.match(/^([✓✔✗✘×○◌◯])\s+(.+)$/);
    if (todoMatch && !/Questionnaire|requires.*user input|requires.*interactive/i.test(todoMatch[2])) {
      if (current && current.role === "todo") {
        current.content = current.content ? current.content + "\n" + line : line;
      } else {
        flush();
        current = { role: "todo", content: line };
      }
      continue;
    }

    // Continuation of current message
    if (current) {
      current.content = current.content ? current.content + "\n" + line : line;
    }
  }
  // End of input: flush whatever is still open.
  flushTool();
  flushCurrent();

  // Convert tool messages: gather output lines into a single output field
  return messages.map((m) => {
    if (m.role === "tool" && Array.isArray(m.output) && m.output.length > 0) {
      return {
        role: "tool",
        name: m.name,
        arguments: m.arguments,
        status: m.status || null,
        output: m.output.join("\n"),
      };
    }
    return m;
  });
}

// Best-effort: read mcode session transcript from runtime-state.sqlite.
// Returns { messages, ok } — ok=false means we set _meta.mcode_unavailable.
// v2 (2026-09-20 webui-manual-audit): body extracted to lib/transcript.js
// (readMcodeTranscript) — legacy probe set only, so this stays a pass-through
// and export behavior is byte-identical to the inline version.
function _readMcodeTranscript(mcodeSid) {
  return readMcodeTranscript(mcodeSid);
}

// Merge webui messages + mcode transcript. Strategy: webui is authoritative
// for the user-visible chat; mcode is best-effort enrichment (token usage,
// full tool call payloads). When both exist for the same turn, mcode wins
// for tool_calls because the webui stores arguments as a flat text line.
function _mergeMessages(webuiMsgs, mcodeMsgs) {
  if (!mcodeMsgs || mcodeMsgs.length === 0) return webuiMsgs;
  // Simple merge: append any mcode messages whose role+content prefix is
  // not already present in webui (avoids double-listing the same turn).
  const seen = new Set();
  for (const m of webuiMsgs) {
    if (m && m.content) seen.add(m.role + "|" + m.content.slice(0, 64));
  }
  const extras = mcodeMsgs.filter((m) => {
    if (!m || !m.content) return false;
    return !seen.has(m.role + "|" + m.content.slice(0, 64));
  });
  return [...webuiMsgs, ...extras];
}

// Sanitize a filename for Content-Disposition.
function _safeFilename(name) {
  return (name || "session").replace(/[\r\n"]/g, "");
}

// Decide download filename + extension.
function _downloadFilename(session, format) {
  const slug = slugifyTitle(session.title || "session");
  const ts = fileTimestamp(session.updatedAt || Date.now());
  const ext = format === "md" ? "md" : "json";
  return `${slug}-${ts}.${ext}`;
}

// Write a JSON response. Used for error paths so the front-end can
// distinguish them from a successful markdown body.
function _jsonError(res, status, error, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, error, ...extra }));
}

// Main handler.
export async function handleExport(req, res, ctx) {
  const cid = (ctx && ctx.cid) || "";
  const pathname = (ctx && ctx.pathname) || (req.url || "").split("?")[0];

  // Extract id from path: /api/sessions/<id>/export
  const id = pathname.slice("/api/sessions/".length).replace(/\/export$/, "");
  if (!id) {
    return _jsonError(res, 400, "id required");
  }

  // Parse query
  let format = "md";
  let download = false;
  try {
    const qIdx = (req.url || "").indexOf("?");
    if (qIdx >= 0) {
      const params = new URLSearchParams(req.url.slice(qIdx + 1));
      format = (params.get("format") || "md").toLowerCase();
      download = params.get("download") === "true";
    }
  } catch {}
  if (!VALID_FORMATS.has(format)) {
    return _jsonError(res, 400, "unsupported format", {
      allowed: Array.from(VALID_FORMATS),
    });
  }

  // B03: per-request authorize. Export is non-destructive but exposes
  // conversation history — same gate class as session.delete per the
  // C06 spec. Tests drive the decision via test/_setup.js#withDecisions.
  let authResult = null;
  try {
    authResult = await authorize("session.export", {
      cid,
      targetSessionId: id,
      format,
      download,
    });
  } catch (e) {
    return _jsonError(res, 500, "authorize error", { detail: e.message });
  }
  if (!authResult || !authResult.approved) {
    if (res.headersSent) return;
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: false,
        error: "authorize declined",
        decidedBy: (authResult && authResult.decidedBy) || "unknown",
        decidedAt: (authResult && authResult.decidedAt) || Date.now(),
      }),
    );
  }

  // Write-ahead audit (2026-09-20 rigor fix): the approved disclosure
  // intent is recorded BEFORE any session content is read / merged.
  // A failed write aborts the export — the conversation history must
  // not leave the server on an unaudited request.
  try {
    _eventsAppend("session.export.intent", {
      target: id,
      cid,
      actor: "user",
      payload: {
        format,
        download,
        decidedBy: authResult.decidedBy,
      },
    });
  } catch (e) {
    try {
      pushAlert({
        level: "error",
        msg: `audit write failed (session.export.intent): ${e.message}`,
        src: "export",
      });
    } catch {}
    console.error("[export] audit intent append failed:", e);
    return _jsonError(res, 500, "audit write failed", {
      detail: "session.export.intent",
    });
  }

  // Resolve session
  const found = _findSession(id);
  if (!found) {
    return _jsonError(res, 404, "session not found");
  }
  const session = found.item;

  // Parse webui chat → structured messages
  const webuiMsgs = _parseChatLines(Array.isArray(session.chat) ? session.chat : []);

  // Best-effort mcode enrichment
  let mcodeMsgs = [];
  let mcodeUnavailable = false;
  let mcodeUnavailableReason = null;
  if (session.mcodeSessionId) {
    const r = _readMcodeTranscript(session.mcodeSessionId);
    if (r.ok) {
      mcodeMsgs = r.messages;
    } else {
      mcodeUnavailable = true;
      mcodeUnavailableReason = r.reason || "unknown";
    }
  } else {
    mcodeUnavailable = true;
    mcodeUnavailableReason = "no_mcode_sid";
  }

  const messages = _mergeMessages(webuiMsgs, mcodeMsgs);

  // Audit (B01) — outcome line, written after the payload is built.
  // Fail-closed (2026-09-20): the export content must not be served
  // on a request whose audit line failed to land — 5xx + alert.
  try {
    _eventsAppend("session.export", {
      target: session.id || id,
      cid,
      actor: "user",
      payload: {
        format,
        download,
        messageCount: messages.length,
        webuiMessageCount: webuiMsgs.length,
        mcodeMessageCount: mcodeMsgs.length,
        mcodeUnavailable,
        mcodeUnavailableReason,
        matchKind: found.matchKind,
      },
    });
  } catch (e) {
    try {
      pushAlert({
        level: "error",
        msg: `audit write failed (session.export): ${e.message}`,
        src: "export",
      });
    } catch {}
    console.error("[export] audit outcome append failed:", e);
    return _jsonError(res, 500, "audit write failed", {
      detail: "session.export",
    });
  }

  // Render
  if (format === "json") {
    const body = {
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        workspace: session.workspace || "",
        createdAt: session.createdAt || 0,
        updatedAt: session.updatedAt || 0,
        mcodeSessionId: session.mcodeSessionId || null,
      },
      messages,
      _meta: {
        source: mcodeMsgs.length > 0 ? "merged" : "webui",
        exportedAt: Date.now(),
        messageCount: messages.length,
        mcode_unavailable: mcodeUnavailable,
        ...(mcodeUnavailable ? { mcode_unavailable_reason: mcodeUnavailableReason } : {}),
      },
    };
    const payload = JSON.stringify(body, null, 2);
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${_safeFilename(_downloadFilename(session, "json"))}"`;
    }
    if (res.headersSent) return;
    res.writeHead(200, headers);
    return res.end(payload);
  }

  // Markdown
  const md = serializeSession(
    session,
    messages,
    {
      source: mcodeMsgs.length > 0 ? "merged" : "webui",
      exportedAt: Date.now(),
    },
  );
  const headers = { "Content-Type": "text/markdown; charset=utf-8" };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${_safeFilename(_downloadFilename(session, "md"))}"`;
  }
  if (res.headersSent) return;
  res.writeHead(200, headers);
  return res.end(md);
}