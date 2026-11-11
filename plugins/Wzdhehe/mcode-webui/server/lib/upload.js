// webui/server/lib/upload.js
// Multipart/form-data parser (zero deps) for /api/upload.

import { extname, join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { UPLOAD_DIR } from "./config.js";

// ============================================================
// Multipart upload parser (minimal, no deps)
// ============================================================
function splitMultipart(buf, boundary) {
  const parts = [];
  const start = buf.indexOf(boundary) + boundary.length;
  let pos = start;
  while (pos < buf.length) {
    const next = buf.indexOf(boundary, pos);
    if (next === -1) break;
    const block = buf.slice(pos, next - 2); // strip trailing \r\n before next boundary
    const headerEnd = block.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      pos = next + boundary.length;
      continue;
    }
    const headerStr = block.slice(0, headerEnd).toString("utf8");
    const body = block.slice(headerEnd + 4);
    const headers = {};
    for (const line of headerStr.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0)
        headers[line.slice(0, i).trim().toLowerCase()] = line
          .slice(i + 1)
          .trim();
    }
    parts.push({ headers, body });
    pos = next + boundary.length;
  }
  return parts;
}

export function saveMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers["content-type"] || "";
    const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return reject(new Error("no boundary"));
    const boundary = "--" + (m[1] || m[2]);
    let buf = Buffer.alloc(0);
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        buf = Buffer.concat(chunks);
        const parts = splitMultipart(buf, boundary);
        for (const part of parts) {
          const cd = part.headers["content-disposition"] || "";
          const filenameMatch = cd.match(/filename="([^"]+)"/i);
          if (!filenameMatch) continue;
          const origName = filenameMatch[1];
          const ext = extname(origName) || "";
          const safeName = `${Date.now()}-${createHash("md5").update(origName).digest("hex").slice(0, 6)}${ext}`;
          const fullPath = join(UPLOAD_DIR, safeName);
          writeFileSync(fullPath, part.body);
          return resolve({ path: fullPath, name: origName });
        }
        reject(new Error("no file part"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
