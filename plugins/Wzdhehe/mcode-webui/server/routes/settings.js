// webui/server/routes/settings.js
// GET/POST /api/settings
//
// v0.5.ap: lanBroadcast toggle
// v1.0.1: readOnly / tokenEnabled / resetToken / acknowledgeToken.
//   Rotation broadcasts an SSE event so other clients can update their
//   localStorage.

import {
  getLanBroadcast,
  getReadOnly,
  getSettingsSnapshot,
  getTokenAcknowledged,
  getTokenEnabled,
  getTokenRotatedAt,
  getQuotaEnabled,
  rotateToken,
  setLanBroadcast,
  setQuotaEnabled,
  setReadOnly,
  setTokenAcknowledged,
  setTokenEnabled,
  setTokenPlanApiKey,
} from "../lib/settings.js";
import { setTokenAuthEnabled } from "../lib/auth.js";
import { broadcastTokenRotated, pushStateFor } from "../lib/state-bus.js";

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

  // lanBroadcast — back-compat boolean
  if (
    typeof payload.lanBroadcast === "boolean" &&
    payload.lanBroadcast !== getLanBroadcast()
  ) {
    setLanBroadcast(payload.lanBroadcast);
    changed = true;
  }

  // readOnly
  if (
    typeof payload.readOnly === "boolean" &&
    payload.readOnly !== getReadOnly()
  ) {
    setReadOnly(payload.readOnly);
    changed = true;
  }

  // tokenEnabled — also toggles the in-memory auth flag
  if (
    typeof payload.tokenEnabled === "boolean" &&
    payload.tokenEnabled !== getTokenEnabled()
  ) {
    setTokenEnabled(payload.tokenEnabled);
    setTokenAuthEnabled(payload.tokenEnabled);
    changed = true;
  }

  // resetToken — generate a new token, broadcast SSE notification, do
  // NOT return the new value in the HTTP body. Pre-fix: the response
  // included `currentToken: newToken` so the operator's browser could
  // auto-update its localStorage. Post-fix (round 8): the new value
  // is delivered out-of-band — printed to server stdout + written to
  // ~/.mcode-webui/settings.json. The operator reads it from one of
  // those locations and re-opens the webui URL with the new token.
  // This is the deliberate UX trade-off for closing the cross-origin
  // bootstrap-token leak (hetaoBackend 2026-09-01): the auto-update
  // path is gone, replaced by an explicit re-open step.
  if (payload.resetToken === true) {
    let newToken;
    try {
      newToken = rotateToken();
      tokenRotated = true;
      changed = true;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    // Broadcast a notification (no token payload — see state-bus.js
    // round 8 changes). Connected clients use it as a signal to
    // clear localStorage + show "token rotated, please reload" toast.
    // The auth module's expectedToken is updated synchronously by
    // rotateToken() → syncAuthToken(), so any new requests will use
    // the new value immediately (a request with the OLD token gets
    // 401, prompting the operator to re-open with the new token).
    try { broadcastTokenRotated(newToken); } catch {}
    try { pushStateFor("__broadcast__"); } catch {}

    // Return immediately. No `currentToken` field — the operator gets
    // the new value from stdout / settings.json, not from this response.
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      ok: true,
      changed: true,
      tokenRotated: true,
      // round 8: the new token is NOT in this response. The operator
      // must re-open the webui URL with the new token (printed to
      // server stdout on rotation + persisted to settings.json).
      hint: "token rotated; read the new value from server stdout or ~/.mcode-webui/settings.json",
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
    setTokenAcknowledged(payload.acknowledgeToken);
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
    setQuotaEnabled(payload.quotaEnabled);
    changed = true;
  }
  if (typeof payload.tokenPlanApiKey === "string") {
    const trimmed = payload.tokenPlanApiKey.trim();
    // Only write if the value actually changed (avoids unnecessary
    // disk writes on every settings save).
    if (trimmed.length > 0) {
      setTokenPlanApiKey(trimmed);
      changed = true;
    } else {
      // Explicit clear via the key field (alternative to disabling
      // via quotaEnabled, which also clears).
      // Read-modify-write to keep the path simple; we don't track
      // the masked value, so we always clear if the field is empty.
      setTokenPlanApiKey("");
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
