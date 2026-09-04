// webui/server/routes/upload.js
// POST /api/upload — multipart file save

import { saveMultipartUpload } from "../lib/upload.js";

export async function handleUpload(req, res, _ctx) {
  const ctype = (req.headers["content-type"] || "").toLowerCase();
  if (!ctype.startsWith("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "multipart required" }));
  }
  try {
    const saved = await saveMultipartUpload(req);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({ ok: true, path: saved.path, name: saved.name }),
    );
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}
