// webui/server/routes/settings.js
// GET/POST /api/settings

import {
  getLanBroadcast,
  setLanBroadcast,
  getSettingsSnapshot,
} from "../lib/settings.js";

export function handleGetSettings(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify(getSettingsSnapshot()));
}

export async function handlePostSettings(req, res, _ctx) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    payload = {};
  }
  let changed = false;
  if (
    typeof payload.lanBroadcast === "boolean" &&
    payload.lanBroadcast !== getLanBroadcast()
  ) {
    setLanBroadcast(payload.lanBroadcast);
    changed = true;
  }
  const snap = getSettingsSnapshot();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ...snap, changed }));
}
