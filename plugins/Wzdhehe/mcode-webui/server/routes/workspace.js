// webui/server/routes/workspace.js
// POST /api/workspace, GET /api/workspace/browse

import { handleWorkspaceChange, browseWorkspace } from "../lib/workspace.js";

export async function handleWorkspace(req, res, ctx) {
  let body = "";
  for await (const chunk of req) body += chunk;
  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    payload = {};
  }
  const result = handleWorkspaceChange(ctx.cs, ctx.cid, payload);
  res.writeHead(
    result.ok
      ? 200
      : result.error && result.error.includes("不存在")
        ? 400
        : 200,
    { "Content-Type": "application/json; charset=utf-8" },
  );
  return res.end(JSON.stringify(result));
}

export function handleWorkspaceBrowse(req, res, _ctx) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawPath = url.searchParams.get("path");
  const result = browseWorkspace(rawPath);
  res.writeHead(result.ok ? 200 : 400, {
    "Content-Type": "application/json; charset=utf-8",
  });
  return res.end(JSON.stringify(result));
}
