// webui/server/routes/settings.js
// GET/POST /api/settings
//
// v0.5.ap: lanBroadcast toggle
// v1.0.1: readOnly / tokenEnabled / resetToken / acknowledgeToken.
//   Rotation broadcasts an SSE event so other clients can update their
//   localStorage.

import {
  getLanBroadcast,
  getLanBind,
  getReadOnly,
  getSettingsSnapshot,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenRotatedAt,
  getTrustedOrigins,
  getQuotaEnabled,
  rotateToken,
  sanitizeTrustedOrigins,
  setLanBroadcast,
  setLanBind,
  setQuotaEnabled,
  setReadOnly,
  setTokenAcknowledged,
  setTokenEnabled,
  setTokenPlanApiKey,
  setTrustedOrigins,
} from "../lib/settings.js";
import { setTokenAuthEnabled } from "../lib/auth.js";
import { broadcastTokenRotated, pushStateFor } from "../lib/state-bus.js";
import { authorize } from "../lib/authorize.js";
import { pushAlert } from "../lib/alerts.js";
// B01: settings.update / token.reset events (fail-closed since the
// 2026-09-20 rigor fix — see lib/settings.js header).
import { append as _eventsAppend } from "../lib/events.js";

// _auditFail — shared failure sink: HTTP 5xx + alert on the anomaly
// channel. Mirrors routes/sessions.js#_auditFail.
function _auditFail(res, e, what) {
  try {
    pushAlert({
      level: "error",
      msg: `audit write failed (${what}): ${e && e.message ? e.message : String(e)}`,
      src: "settings",
    });
  } catch {}
  console.error(`[webui] audit write failed (${what}):`, e);
  if (res && !res.headersSent) {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: false,
      error: "audit write failed",
      detail: what,
    }));
  }
  return undefined;
}

export function handleGetSettings(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(getSettingsSnapshot()));
}

export async function handlePostSettings(req, res, ctx) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    payload = {};
  }
  if (payload === null || typeof payload !== "object") payload = {};

  let changed = false;
  let tokenRotated = false;

  // Fail-closed wrapper: settings setters now write write-ahead
  // intent + outcome audit events (lib/settings.js); events.js#append
  // THROWS on failure. An audit failure mid-POST surfaces as 5xx +
  // alert instead of a silent partial success. Fields processed
  // before the failure keep their state (documented no-rollback
  // semantics; the response makes the boundary visible).
  const _guard = (what, fn) => {
    try {
      return fn();
    } catch (e) {
      _auditFail(res, e, what);
      return null;
    }
  };

  // lanBroadcast — back-compat boolean
  if (
    typeof payload.lanBroadcast === "boolean" &&
    payload.lanBroadcast !== getLanBroadcast()
  ) {
    const stop = _guard("settings.update.lanBroadcast", () =>
      setLanBroadcast(payload.lanBroadcast),
    );
    if (stop === null) return undefined;
    changed = true;
  }

  // v2 security fix (PR #55 review point 2): lanBind — persisted opt-in
  //   for binding 0.0.0.0. Takes effect on the next boot (socket binds
  //   are boot-time state); the response snapshot discloses this via
  //   bindRestartPending + lanExposureNotice.
  if (
    typeof payload.lanBind === "boolean" &&
    payload.lanBind !== getLanBind()
  ) {
    const stop = _guard("settings.update.lanBind", () =>
      setLanBind(payload.lanBind),
    );
    if (stop === null) return undefined;
    changed = true;
  }

  // v2 security fix (PR #55 review point 1): trustedOrigins — explicit
  //   cross-origin allowlist for the CORS gate. Invalid batches are
  //   rejected 400 BEFORE any state changes (fail-closed: a malformed
  //   allowlist must never partially widen the trust surface).
  if (Array.isArray(payload.trustedOrigins)) {
    const next = sanitizeTrustedOrigins(payload.trustedOrigins);
    if (!next.ok) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: next.error }));
    }
    const current = getTrustedOrigins();
    const same =
      current.length === next.value.length &&
      current.every((o, i) => o === next.value[i]);
    if (!same) {
      const stop = _guard("settings.update.trustedOrigins", () =>
        setTrustedOrigins(next.value),
      );
      if (stop === null) return undefined;
      changed = true;
    }
  }

  // readOnly
  if (
    typeof payload.readOnly === "boolean" &&
    payload.readOnly !== getReadOnly()
  ) {
    const stop = _guard("settings.update.readOnly", () =>
      setReadOnly(payload.readOnly),
    );
    if (stop === null) return undefined;
    changed = true;
  }

  // tokenEnabled — also toggles the in-memory auth flag
  if (
    typeof payload.tokenEnabled === "boolean" &&
    payload.tokenEnabled !== getTokenEnabled()
  ) {
    const stop = _guard("settings.update.tokenEnabled", () => {
      setTokenEnabled(payload.tokenEnabled);
      setTokenAuthEnabled(payload.tokenEnabled);
    });
    if (stop === null) return undefined;
    changed = true;
  }

  // resetToken — generate a new token, broadcast SSE, return the new value
  if (payload.resetToken === true) {
    // B03: token rotation is destructive — every remote client loses
    //   its HEADERS / localStorage credential and must re-handshake.
    //   Gate with authorize('token.reset', ctx) so the operator must
    //   click a confirmation in the settings card before the rotation
    //   fires. Decline / timeout leaves the current token intact.
    const authResult = await authorize("token.reset", {
      cid: ctx && ctx.cid ? ctx.cid : null,
      rotationTrigger: "settings_card",
    });
    if (!authResult.approved) {
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({
        ok: false,
        error: "authorize declined",
        decidedBy: authResult.decidedBy,
        decidedAt: authResult.decidedAt,
      }));
    }
    // Write-ahead flow intent: durable record of the approved rotation
    // BEFORE rotateToken() touches state. rotateToken() writes its own
    // token.rotate.intent + settings.update outcome lines (lib layer);
    // this one anchors the authorize decision to the flow.
    try {
      _eventsAppend("token.reset.intent", {
        target: "currentToken",
        cid: ctx && ctx.cid ? ctx.cid : "",
        actor: "user",
        payload: {
          rotationTrigger: "settings_card",
          decidedBy: authResult.decidedBy,
        },
      });
    } catch (e) {
      return _auditFail(res, e, "token.reset.intent");
    }
    let newToken;
    try {
      newToken = rotateToken();
      tokenRotated = true;
      changed = true;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    // Broadcast the new token to all currently-connected SSE clients.
    // We push BOTH the dedicated auth.token_rotated event (so clients
    // can update their HEADERS + localStorage immediately, before the
    // state push arrives) AND the full state push (which includes
    // currentToken + tokenRotatedAt in the JSON body). The auth
    // module's expectedToken is updated synchronously by rotateToken()
    // → syncAuthToken(), so any new requests will use the new value
    // immediately.
    try { broadcastTokenRotated(newToken); } catch {}
    try { pushStateFor("__broadcast__"); } catch {}

    // Flow outcome. Failure → 5xx + alert: the rotation itself
    // succeeded (token is live, clients were notified), but the audit
    // chain has a gap the operator must see.
    try {
      _eventsAppend("token.reset.done", {
        target: "currentToken",
        cid: ctx && ctx.cid ? ctx.cid : "",
        actor: "user",
        payload: {
          rotationTrigger: "settings_card",
          rotatedAt: getTokenRotatedAt(),
        },
      });
    } catch (e) {
      return _auditFail(res, e, "token.reset.done");
    }

    // Return immediately with the new token (don't fall through to
    // the generic snapshot — the client just rotated, give them the
    // fresh value so their localStorage can sync).
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      changed: true,
      tokenRotated: true,
      currentToken: newToken,
      tokenAcknowledged: false,
      tokenRotatedAt: getTokenRotatedAt(),
    }));
  }

  // acknowledgeToken — operator confirms they've saved the token.
  // The server then stops including currentToken in subsequent
  // GET /api/settings responses.
  if (
    typeof payload.acknowledgeToken === "boolean" &&
    payload.acknowledgeToken !== getTokenAcknowledged()
  ) {
    const stop = _guard("settings.update.acknowledgeToken", () =>
      setTokenAcknowledged(payload.acknowledgeToken),
    );
    if (stop === null) return undefined;
    changed = true;
  }

  // v2026-08-28 modacker: Token Plan (套餐用量) feature.
  // - `quotaEnabled` (bool): master switch
  // - `tokenPlanApiKey` (string): Subscription Key from platform,
  //   stored in plain text in settings.json (same trust model as
  //   currentToken). Empty string clears it.
  if (
    typeof payload.quotaEnabled === "boolean" &&
    payload.quotaEnabled !== getQuotaEnabled()
  ) {
    const stop = _guard("settings.update.quotaEnabled", () =>
      setQuotaEnabled(payload.quotaEnabled),
    );
    if (stop === null) return undefined;
    changed = true;
  }
  if (typeof payload.tokenPlanApiKey === "string") {
    const trimmed = payload.tokenPlanApiKey.trim();
    // Only write if the value actually changed (avoids unnecessary
    // disk writes on every settings save).
    if (trimmed.length > 0) {
      const stop = _guard("settings.update.tokenPlanApiKey", () =>
        setTokenPlanApiKey(trimmed),
      );
      if (stop === null) return undefined;
      changed = true;
    } else {
      // Explicit clear via the key field (alternative to disabling
      // via quotaEnabled, which also clears).
      // Read-modify-write to keep the path simple; we don't track
      // the masked value, so we always clear if the field is empty.
      const stop = _guard("settings.update.tokenPlanApiKey", () =>
        setTokenPlanApiKey(""),
      );
      if (stop === null) return undefined;
      changed = true;
    }
  }

  // Push the new state so all connected clients see the toggle change.
  // Cheap (a few hundred bytes JSON per client).
  if (changed) {
    try { pushStateFor("__broadcast__"); } catch {}
  }
  // Note: if the client just toggled Token Plan, they'll also need a
  // /api/usage call to re-evaluate cs.usage.hidden. The frontend
  // handles that as part of saving the settings card.

  const snap = getSettingsSnapshot();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ...snap, changed, tokenRotated }));
}
