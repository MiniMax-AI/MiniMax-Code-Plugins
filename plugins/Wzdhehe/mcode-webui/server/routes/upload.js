// webui/server/routes/upload.js
// POST /api/upload — multipart file save

import { saveMultipartUpload } from "../lib/upload.js";
import { pushAlert } from "../lib/alerts.js";
// B01: append-only audit for upload events. We log the saved file's
// basename (not full path — that leaks the absolute upload dir, which
// is implementation detail), original filename, and the mtime-derived
// saved name. We never log file content (binary, large, sensitive).
// Write-ahead (2026-09-20 rigor fix): an intent line lands BEFORE
// saveMultipartUpload() writes the file; the outcome upload.create
// line lands after. Both fail closed — 5xx + alert, no silent gap.
import { append as _eventsAppend } from "../lib/events.js";
import { basename } from "node:path";

// _auditFail — mirror of routes/sessions.js#_auditFail: HTTP 5xx +
// one alert on the anomaly channel.
function _auditFail(res, e, what) {
  try {
    pushAlert({
      level: "error",
      msg: `audit write failed (${what}): ${e && e.message ? e.message : String(e)}`,
      src: "upload",
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

// PR #55 review point 3 — "Uploads are unbounded": the route used to
// answer 500 for EVERY saveMultipartUpload failure, including the new
// limit rejections (which are client errors, not server faults). Map
// lib/upload.js error codes to honest statuses and echo the code in
// the JSON body so the client sees which limit fired:
//   400 — malformed multipart / aborted stream / no file part
//   413 — request / file / quota limit exceeded
//   500 — anything else (disk I/O, audit, unknown)
const STATUS_BY_CODE = {
  UPLOAD_MALFORMED: 400,
  UPLOAD_ABORTED: 400,
  UPLOAD_REQ_TOO_LARGE: 413,
  UPLOAD_FILE_TOO_LARGE: 413,
  UPLOAD_QUOTA_EXCEEDED: 413,
};

function _writeUploadError(res, req, e) {
  // Client may have torn the connection down mid-upload (that is the
  // point of aborting an over-limit stream) — writing a response to a
  // dead socket is pointless, skip it.
  if (!res || res.destroyed || (res.socket && res.socket.destroyed)) {
    return undefined;
  }
  const status = (e && STATUS_BY_CODE[e.code]) || 500;
  const headers = { "Content-Type": "application/json" };
  if (status === 413) {
    // The request body was NOT fully consumed (the parser aborted
    // mid-stream by design). Tell the client this connection is done
    // so Node tears the socket down after the response instead of
    // waiting on a body that will never finish.
    headers["Connection"] = "close";
  }
  res.writeHead(status, headers);
  res.end(
    JSON.stringify({
      ok: false,
      error: e && e.message ? e.message : String(e),
      code: (e && e.code) || "UPLOAD_FAILED",
    }),
    () => {
      if (status === 413 && req && !req.readableEnded && !req.destroyed) {
        // Post-response socket hygiene: closing a socket that still has
        // UNREAD request bytes in its kernel receive buffer makes the
        // TCP stack emit an RST that can overtake (and destroy) the
        // 413 response we just queued. Draining the rest of the body
        // with a discarding listener lets the response land and the
        // connection wind down cleanly. The over-limit DECISION was
        // already made mid-stream; this drain neither buffers anything
        // (chunks are discarded one at a time) nor gates anything.
        req.on("data", () => {});
        req.resume();
      }
    },
  );
  return undefined;
}

export async function handleUpload(req, res, _ctx) {
  const ctype = (req.headers["content-type"] || "").toLowerCase();
  if (!ctype.startsWith("multipart/form-data")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "multipart required" }));
  }
  // Write-ahead intent: record that an upload is about to persist a
  // file BEFORE the multipart body is parsed + written. Failure →
  // 5xx + alert with nothing on disk.
  try {
    _eventsAppend("upload.create.intent", {
      target: "",
      cid: (_ctx && _ctx.cid) || "",
      actor: "user",
      payload: {
        contentType: ctype.slice(0, 128),
      },
    });
  } catch (e) {
    return _auditFail(res, e, "upload.create.intent");
  }
  try {
    const saved = await saveMultipartUpload(req);
    // B01: record successful upload. We use basename(saved.path) — the
    // full path is implementation detail; the basename is enough to
    // identify the file. Since the streaming parser (PR #55 review
    // point 3) the helper also returns the byte count, so the size
    // field the original comment left null is now populated.
    try {
      _eventsAppend("upload.create", {
        target: saved.name,
        cid: (_ctx && _ctx.cid) || "",
        actor: "user",
        payload: {
          path: basename(saved.path),
          originalName: saved.name,
          size: typeof saved.size === "number" ? saved.size : null,
        },
      });
    } catch (e) {
      // Outcome failure — file already landed on disk. 5xx + alert so
      // the operator sees the unaudited artifact instead of a 200.
      return _auditFail(res, e, "upload.create");
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(
      JSON.stringify({
        ok: true,
        path: saved.path,
        name: saved.name,
        size: typeof saved.size === "number" ? saved.size : null,
      }),
    );
  } catch (e) {
    // B01: record failed upload too — the failure pattern is useful
    // diagnostic (e.g. "user keeps sending corrupted multipart" surfaces
    // as a stream of upload.fail events). This is a diagnostics line,
    // not an enforcement line: loud-continue to the status-mapped
    // response below (do not touch `res` here — the _writeUploadError
    // call immediately after owns the response).
    try {
      _eventsAppend("upload.fail", {
        cid: (_ctx && _ctx.cid) || "",
        actor: "user",
        payload: {
          error: e && e.message ? e.message : String(e),
          code: (e && e.code) || "UPLOAD_FAILED",
        },
      });
    } catch (auditErr) {
      try {
        pushAlert({
          level: "error",
          msg: `audit write failed (upload.fail): ${auditErr.message}`,
          src: "upload",
        });
      } catch {}
      console.error("[webui] audit write failed (upload.fail):", auditErr);
    }
    return _writeUploadError(res, req, e);
  }
}
