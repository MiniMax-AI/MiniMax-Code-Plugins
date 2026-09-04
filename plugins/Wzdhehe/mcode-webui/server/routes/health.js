// webui/server/routes/health.js
// GET /api/health — basic service info.

import {
  PORT,
  MAX_CONCURRENT,
  MCODE_CMD,
  DEFAULT_MODEL,
  DEFAULT_WORKSPACE,
} from "../lib/config.js";

export function handleHealth(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      port: PORT,
      defaultModel: DEFAULT_MODEL,
      defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD,
      mcodeVersion: "0.1.2",
      maxConcurrent: MAX_CONCURRENT,
    }),
  );
}
