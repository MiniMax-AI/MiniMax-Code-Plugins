// webui/server/lib/slash.js
// Gate-bearing shell over the interaction/feedback subsystem split. See
// BORROW-dsh-deepseek-harness-2026-08-28 § 3 (Subsystem split) and lease
// B04 for the rationale.
//
// ROUTES MUST IMPORT FROM HERE, NOT from interaction/commands.js.
//   (2026-09-20 rigor fix: routes/chat.js used to import the raw
//   dispatcher directly, which made the B03 authorize() gate and the
//   write-ahead audit below dead code in production. interaction/
//   commands.js is the UNGATED implementation — only this shell may
//   import its dispatchers, so the gate sits before every mutation.)
//
// The 6 modules in interaction/ and feedback/ own the seams; this
// shell glues their public surface and adds the security invariants
// (gate + audit) that must not be bypassed by import-site choice.
//
// B01: the destructible commands (/clear /new) live in interaction/
// commands.js (B04's scope). B01 cannot modify that file. We wrap
// the two public dispatchers here to add an audit append() around
// each call. The wrapper records intent (cmd + cid) BEFORE the
// dispatch and lets the underlying handler do the mutation; if the
// handler returns `{ handled: false }` (i.e. not a webui command),
// no audit event is written.
//
// B03: per-request authorize() gate. The /clear and /new commands
//   destroy chat history — AP10's root-cause fix requires a user
//   confirmation before mutation. We catch the cmd here (in the
//   shell that B03 owns), call authorize("slash.clear", ctx), and:
//     - approved  → delegate to the interaction/ handler
//     - declined  → append a "● 已取消" note to chat and return
//                  {handled:true, continueMcode:false} so the caller
//                  doesn't forward to mcode
//   This places the gate BEFORE the actual mutation in interaction/
//   commands.js without requiring changes to that file (B04's scope).

import { append as _eventsAppend } from "./events.js";
import { authorize } from "./authorize.js";
import {
  matchSlash as _matchSlash,
  handleLocalSlash as _handleLocalSlashImpl,
  handleCmdCommand as _handleCmdCommandImpl,
} from "./interaction/commands.js";

// B03 helper: check whether this cmd triggers the destructive gate.
//   textPath: handleLocalSlash receives a content string and uses
//     matchSlash() to derive the cmd.
//   buttonPath: handleCmdCommand receives the cmd directly (with or
//     without leading "/").
function _destructiveCmd(cmdName) {
  return cmdName === "clear" || cmdName === "new";
}

// B03 helper: append a decline note to the chat so the user gets
//   visible feedback when they (or the 5-min timeout) blocked the
//   destructive command. Mirrors the production handlers' style of
//   pushing a string into cs.chat. NOTE (2026-09-20 rigor fix): this
//   helper deliberately does NOT import state-bus to push a state
//   frame — the note rides the next per-cid push (handleSend pushes
//   before dispatch; the underlying handlers push after mutation).
//   The ack'd HTTP response has already returned by then (both
//   /api/send and /api/cmd are fire-and-forget), so there is no
//   route-level push after handleLocalSlash / handleCmdCommand
//   returns, contrary to what an earlier revision of this comment
//   claimed.
function _appendDeclineNote(cs, cid, cmd, decidedBy) {
  if (!cs) return;
  const note = `● 已取消 /${cmd} (授权未通过: ${decidedBy})`;
  cs.chat = [...(cs.chat || []), note];
  // Reference cid so eslint --unused-vars passes; cid is part of the
  //   public API contract even though this particular helper doesn't
  //   use it (the route uses cid to scope the state push).
  void cid;
}

export function matchSlash(content) {
  return _matchSlash(content);
}

export async function handleLocalSlash(content, cs, cid) {
  const m = _matchSlash(content);
  // B03 gate: /clear and /new — destructive. Await user confirmation
  //   BEFORE delegating to interaction/commands.js (where the actual
  //   cs.chat mutation happens).
  if (m && _destructiveCmd(m.cmd)) {
    const authResult = await authorize("slash.clear", {
      cid,
      cmd: m.cmd,
      chatLen: (cs && cs.chat || []).length,
      sessionId: (cs && cs.sessionId) || null,
      mcodeSessionId: (cs && cs.mcodeSessionId) || null,
      source: "local_slash",
    });
    if (!authResult.approved) {
      _appendDeclineNote(cs, cid, m.cmd, authResult.decidedBy);
      return { handled: true, continueMcode: false };
    }
    // Write-ahead audit (2026-09-20 rigor fix): durable intent line
    // BEFORE the chat mutation. append() is fail-closed — a failed
    // write propagates to the caller (routes/chat.js → HTTP 5xx +
    // alert) with cs.chat untouched. We deliberately do NOT catch
    // and decline-note here: an unaudited destructive command must
    // abort loudly, not "succeed" silently on a broken audit disk.
    _eventsAppend("slash.clear.intent", {
      target: (cs && cs.sessionId) || "(no-session)",
      cid,
      actor: "user",
      payload: {
        source: "local_slash",
        cmd: m.cmd,
        chatLenBefore: ((cs && cs.chat) || []).length,
        authorize: { decidedBy: authResult.decidedBy, decidedAt: authResult.decidedAt },
      },
    });
    // Delegate; then record the outcome AFTER the mutation (also
    // fail-closed / propagating — same rationale as the intent).
    const result = await _handleLocalSlashImpl(content, cs, cid);
    _eventsAppend("chat.clear", {
      target: (cs && cs.sessionId) || "(no-session)",
      cid,
      actor: "user",
      payload: {
        source: "local_slash",
        cmd: m.cmd,
        chatLenBefore: ((cs && cs.chat) || []).length,
        authorize: { decidedBy: authResult.decidedBy, decidedAt: authResult.decidedAt },
      },
    });
    return result;
  }
  // Non-destructive paths (status / help / usage / goal / etc.):
  //   unchanged from B01 — no gate, no extra audit.
  return _handleLocalSlashImpl(content, cs, cid);
}

export async function handleCmdCommand(cmd, cs, cid) {
  const name = typeof cmd === "string" && cmd.startsWith("/") ? cmd.slice(1) : cmd;
  // B03 gate: same destructive set as handleLocalSlash. The /api/cmd
  //   path is button-driven (UI panel buttons); the gate fires for
  //   every clear/new click.
  if (_destructiveCmd(name)) {
    const authResult = await authorize("slash.clear", {
      cid,
      cmd: name,
      chatLen: (cs && cs.chat || []).length,
      sessionId: (cs && cs.sessionId) || null,
      mcodeSessionId: (cs && cs.mcodeSessionId) || null,
      source: "cmd_button",
    });
    if (!authResult.approved) {
      _appendDeclineNote(cs, cid, name, authResult.decidedBy);
      return { handled: true, continueMcode: false };
    }
    // Write-ahead intent — see handleLocalSlash for the rationale.
    _eventsAppend("slash.clear.intent", {
      target: (cs && cs.sessionId) || "(no-session)",
      cid,
      actor: "user",
      payload: {
        source: "cmd_button",
        cmd: name,
        chatLenBefore: ((cs && cs.chat) || []).length,
        authorize: { decidedBy: authResult.decidedBy, decidedAt: authResult.decidedAt },
      },
    });
    const result = await _handleCmdCommandImpl(cmd, cs, cid);
    // Outcome — AFTER the mutation, fail-closed (propagates).
    _eventsAppend("chat.clear", {
      target: (cs && cs.sessionId) || "(no-session)",
      cid,
      actor: "user",
      payload: {
        source: "cmd_button",
        cmd: name,
        chatLenBefore: ((cs && cs.chat) || []).length,
        authorize: { decidedBy: authResult.decidedBy, decidedAt: authResult.decidedAt },
      },
    });
    return result;
  }
  return _handleCmdCommandImpl(cmd, cs, cid);
}