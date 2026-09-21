// webui/server/lib/upload.js
// Multipart/form-data parser (zero deps) for /api/upload.
//
// PR #55 review point 3 — "Uploads are unbounded": the old parser
// buffered the ENTIRE multipart body in memory (Buffer.concat over all
// chunks) and wrote the file with a single synchronous writeFileSync,
// with no request / file / quota limit anywhere. A hostile client could
// OOM the server just by POSTing a large body.
//
// This version is a bounded streaming state machine:
//   - body bytes flow through a Transform chunk by chunk; only the file
//     part's bytes are pushed onward into a WriteStream on a temp file,
//     so resident memory is O(chunk + boundary length), never O(body).
//   - three limits are enforced DURING the stream (an over-limit is
//     rejected the moment the (N+1)-th byte is seen, not after the body
//     is read to the end): total request bytes, single-file bytes, and
//     upload-directory quota.
//   - the file lands at its final name only via rename() after the
//     closing boundary + a clean stream end; any failure/abort unlinks
//     the temp file, so no half-written artifact survives.
//
// Backpressure: req.pipe(parser).pipe(writeStream) — if the disk write
// is slow, the writeStream's "drain" resumes the parser, which resumes
// the request. On abort we unpipe the request and leave it paused
// (bounded memory; the route answers 413 and Node tears the socket
// down because the request was never fully consumed).

import { extname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  createWriteStream,
} from "node:fs";
import { Transform } from "node:stream";
import { UPLOAD_DIR } from "./config.js";

// ============================================================
// Limits
// ============================================================
// Defaults and rationale:
//   - maxRequest 50 MiB: one request carries one file plus multipart
//     framing; 2x the file cap leaves headroom for a trailing field.
//   - maxFile 25 MiB: uploads feed the agent chat (images, documents,
//     logs). 25 MiB comfortably covers real attachments while keeping
//     a hostile single file from claiming the disk.
//   - quota 200 MiB: ~8 max-size files retained in the upload dir
//     before the oldest must be cleaned — friendly to small hosts.
// Overrides follow the existing MCODE_WEBUI_* env-knob convention
// (see server/lib/config.js). config.js is intentionally NOT touched:
// these knobs live next to their only consumer and are resolved lazily
// per call (same pattern as events.js#_eventsPath), so operators and
// tests can adjust them without re-importing the module.
const DEFAULT_MAX_REQUEST = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE = 25 * 1024 * 1024;
const DEFAULT_QUOTA = 200 * 1024 * 1024;

// Cap on one part's header block (the bytes between a boundary and its
// \r\n\r\n). Not operator-facing: it is a parser-internal guard against
// an endless "headers with no blank line" stream.
const HEADER_CAP = 16 * 1024;

// Cap on transport padding allowed after a boundary marker (RFC 2046
// permits LWSP; real senders emit none). Parser-internal guard: keeps a
// hostile padding run from growing the hold buffer unboundedly.
const PAD_LIMIT = 64;

function _envPositiveInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveUploadLimits() {
  return {
    maxRequest: _envPositiveInt(
      "MCODE_WEBUI_UPLOAD_MAX_REQUEST",
      DEFAULT_MAX_REQUEST,
    ),
    maxFile: _envPositiveInt("MCODE_WEBUI_UPLOAD_MAX_FILE", DEFAULT_MAX_FILE),
    quota: _envPositiveInt("MCODE_WEBUI_UPLOAD_QUOTA", DEFAULT_QUOTA),
  };
}

// Error factory. `code` is consumed by routes/upload.js to pick the
// HTTP status (400 malformed / 413 over-limit / 500 otherwise) and is
// echoed in the JSON body so the client sees WHICH limit fired.
export function uploadError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Sum of file sizes currently sitting in the upload dir. Best-effort:
// a missing dir reads as 0 (server.js mkdirs it at boot); a file that
// disappears mid-scan just stops counting. Concurrent uploads can
// overshoot the quota by one file (usage is snapshotted at request
// start, enforced again per byte during the stream) — the server is a
// single-user local tool, so a transient one-file overshoot is the
// right trade vs. locking the directory.
export function dirUsageBytes(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    try {
      total += statSync(join(dir, ent.name)).size;
    } catch {
      /* raced unlink — don't count it */
    }
  }
  return total;
}

// ============================================================
// Streaming multipart parser
// ============================================================
// States: preamble → afterMark → headers → bodyFile|bodySkip →
//         afterMark → ... → done
//
//   preamble  : discard everything before the first "--boundary"
//   afterMark : right after a boundary; expect optional transport
//               padding, then \r\n (another part follows) or "--"
//               (final boundary — everything after is epilogue)
//   headers   : accumulate one part's header block up to \r\n\r\n
//   bodyFile  : the FIRST filename-bearing part — bytes are pushed
//               onward (to the temp WriteStream) and counted against
//               the file + quota limits until the closing boundary
//   bodySkip  : any other part (fields, later files) — drained, not
//               stored; only the request limit applies
const HEADER_SEP = Buffer.from("\r\n\r\n");

class MultipartParser extends Transform {
  constructor({ boundary, maxRequest, maxFile, quotaAvailable }) {
    super();
    this._dashBoundary = Buffer.from("--" + boundary);
    this._crlfBoundary = Buffer.from("\r\n--" + boundary);
    this._maxRequest = maxRequest;
    this._maxFile = maxFile;
    this._quotaAvailable = quotaAvailable;
    this._buf = Buffer.alloc(0);
    this._state = "preamble";
    this._total = 0;
    this._fileBytes = 0;
    this._fileHandled = false;
  }

  _transform(chunk, _enc, cb) {
    try {
      this._total += chunk.length;
      if (this._total > this._maxRequest) {
        return cb(
          uploadError(
            `request body exceeds limit: ${this._total} > ${this._maxRequest} bytes ` +
              `(adjust MCODE_WEBUI_UPLOAD_MAX_REQUEST to allow more)`,
            "UPLOAD_REQ_TOO_LARGE",
          ),
        );
      }
      this._buf = this._buf.length
        ? Buffer.concat([this._buf, chunk])
        : chunk;
      this._drain();
      cb();
    } catch (e) {
      cb(e);
    }
  }

  _flush(cb) {
    // A clean stream must end in the "done" state (final boundary
    // seen). Anything else is a truncated body — same rejection the
    // old scanner produced for unterminated parts.
    if (this._state !== "done") {
      return cb(
        uploadError(
          "truncated multipart body (no final boundary)",
          "UPLOAD_MALFORMED",
        ),
      );
    }
    cb();
  }

  // Keep at most `keep` trailing bytes: a boundary split across chunk
  // edges completes once more data arrives, so the partial suffix must
  // stay buffered while the definitely-not-boundary prefix is dropped.
  _trimKeep(keep) {
    if (this._buf.length > keep) {
      this._buf = this._buf.slice(this._buf.length - keep);
    }
  }

  _countFileBytes(out) {
    this._fileBytes += out.length;
    if (this._fileBytes > this._maxFile) {
      throw uploadError(
        `file exceeds size limit: ${this._fileBytes} > ${this._maxFile} bytes ` +
          `(adjust MCODE_WEBUI_UPLOAD_MAX_FILE to allow more)`,
        "UPLOAD_FILE_TOO_LARGE",
      );
    }
    if (this._fileBytes > this._quotaAvailable) {
      throw uploadError(
        `upload directory quota exceeded: needs ${this._fileBytes} bytes ` +
          `but only ${this._quotaAvailable} remain of the configured quota ` +
          `(free space in the upload dir or adjust MCODE_WEBUI_UPLOAD_QUOTA)`,
        "UPLOAD_QUOTA_EXCEEDED",
      );
    }
  }

  // Verdict of the bytes that must follow a boundary candidate
  // (RFC 2046 §5.1.1): optional transport padding, then CRLF (another
  // part follows) or "--" (final). Used both by the afterMark state and
  // by the body scanners to reject content that merely LOOKS like a
  // boundary (e.g. file content containing "\r\n--<boundary>X").
  //   "sep"     — CRLF follows: a real part separator
  //   "final"   — "--" follows: the closing boundary
  //   "garbage" — something else follows: NOT a delimiter
  //   "need"    — not enough bytes buffered yet to decide
  // Padding beyond PAD_LIMIT counts as garbage: real senders emit none
  // (the limit exists only so a hostile padding run cannot grow the
  // hold buffer unboundedly).
  _afterMarkVerdict(buf, from) {
    let q = from;
    const padLimit = from + PAD_LIMIT;
    while (q < buf.length && (buf[q] === 0x20 || buf[q] === 0x09)) {
      q++;
      if (q > padLimit) return "garbage";
    }
    if (buf.length - q < 2) return "need";
    if (buf[q] === 0x2d && buf[q + 1] === 0x2d) return "final";
    if (buf[q] === 0x0d && buf[q + 1] === 0x0a) return "sep";
    return "garbage";
  }

  // Flush `end` bytes of definite non-delimiter content from the head
  // of the buffer. In bodyFile the bytes are also counted and pushed
  // onward (to the temp WriteStream); the scanner states call this with
  // their own semantics via `isFile`.
  _flushHead(end, isFile) {
    if (end <= 0) return true;
    const out = this._buf.slice(0, end);
    this._buf = this._buf.slice(end);
    if (isFile) {
      this._countFileBytes(out);
      if (out.length > 0 && !this.push(out)) return false; // backpressure
    }
    return true;
  }

  _drain() {
    for (;;) {
      switch (this._state) {
        case "preamble": {
          // Discard everything before the first boundary. Candidates
          // are verified so preamble junk like "--boundaryX" doesn't
          // masquerade as the opening delimiter.
          let p = 0;
          for (;;) {
            const i = this._buf.indexOf(this._dashBoundary, p);
            if (i === -1) {
              this._trimKeep(this._dashBoundary.length - 1);
              return;
            }
            const v = this._afterMarkVerdict(
              this._buf,
              i + this._dashBoundary.length,
            );
            if (v === "need") {
              // Hold from the candidate; drop the preamble before it.
              this._flushHead(i, false);
              return;
            }
            if (v === "garbage") {
              p = i + 1;
              continue;
            }
            this._flushHead(i, false);
            // Buffer now starts AT the candidate — step past the mark
            // so afterMark sees the bytes that follow it.
            this._buf = this._buf.slice(this._dashBoundary.length);
            this._state = "afterMark";
            break;
          }
          break;
        }
        case "afterMark": {
          const v = this._afterMarkVerdict(this._buf, 0);
          if (v === "need") return; // wait for more bytes
          if (v === "final") {
            this._state = "done";
            this._buf = Buffer.alloc(0);
            return;
          }
          if (v === "sep") {
            // Consume padding + CRLF.
            let p = 0;
            while (
              p < this._buf.length &&
              (this._buf[p] === 0x20 || this._buf[p] === 0x09)
            ) {
              p++;
            }
            this._buf = this._buf.slice(p + 2);
            this._state = "headers";
            break;
          }
          throw uploadError(
            "malformed multipart: garbage after boundary",
            "UPLOAD_MALFORMED",
          );
        }
        case "headers": {
          const i = this._buf.indexOf(HEADER_SEP);
          if (i === -1) {
            if (this._buf.length > HEADER_CAP) {
              throw uploadError(
                `part header block exceeds ${HEADER_CAP} bytes`,
                "UPLOAD_MALFORMED",
              );
            }
            return; // header block still streaming in
          }
          if (i > HEADER_CAP) {
            throw uploadError(
              `part header block exceeds ${HEADER_CAP} bytes`,
              "UPLOAD_MALFORMED",
            );
          }
          const headerStr = this._buf.slice(0, i).toString("utf8");
          this._buf = this._buf.slice(i + HEADER_SEP.length);
          const headers = {};
          for (const line of headerStr.split("\r\n")) {
            const c = line.indexOf(":");
            if (c > 0) {
              headers[line.slice(0, c).trim().toLowerCase()] = line
                .slice(c + 1)
                .trim();
            }
          }
          const cd = headers["content-disposition"] || "";
          const filenameMatch = cd.match(/filename="([^"]+)"/i);
          if (filenameMatch && !this._fileHandled) {
            this._fileHandled = true;
            this.emit("file-start", filenameMatch[1], headers);
            this._state = "bodyFile";
          } else {
            this._state = "bodySkip";
          }
          break;
        }
        case "bodyFile":
        case "bodySkip": {
          const isFile = this._state === "bodyFile";
          let p = 0;
          for (;;) {
            const i = this._buf.indexOf(this._crlfBoundary, p);
            if (i === -1) {
              // No delimiter candidate: every byte except a possible
              // partial-delimiter suffix is definite content — flush it
              // and keep the suffix buffered.
              const keep = this._crlfBoundary.length - 1;
              if (this._buf.length > keep) {
                if (!this._flushHead(this._buf.length - keep, isFile)) return;
              }
              return;
            }
            const v = this._afterMarkVerdict(
              this._buf,
              i + this._crlfBoundary.length,
            );
            if (v === "need") {
              // Candidate not yet verifiable (split across chunk
              // edges): hold from the candidate, flush before it.
              if (!this._flushHead(i, isFile)) return;
              return;
            }
            if (v === "garbage") {
              p = i + 1; // content merely LOOKS like a boundary
              continue;
            }
            // Confirmed delimiter: flush the final content chunk, then
            // let afterMark consume padding + CRLF / "--" itself.
            // (flushHead already advanced the buffer to the candidate,
            // so the slice is relative to the CURRENT buffer head.)
            if (!this._flushHead(i, isFile)) return;
            if (isFile) this.emit("file-end", this._fileBytes);
            this._buf = this._buf.slice(this._crlfBoundary.length);
            this._state = "afterMark";
            break;
          }
          break;
        }
        case "done":
          return;
        default:
          throw uploadError("parser reached unknown state", "UPLOAD_MALFORMED");
      }
    }
  }
}

// Stable saved-name scheme, unchanged from the pre-streaming parser:
// the client-supplied filename never reaches the filesystem — only a
// generated `${epoch}-${md6}${ext}` name does.
function _safeName(origName) {
  const ext = extname(origName) || "";
  return `${Date.now()}-${createHash("md5").update(origName).digest("hex").slice(0, 6)}${ext}`;
}

// dirUsageBytes is snapshotted once per request; `available` is what
// this upload may add. Zero available → refuse before reading a byte.
export function saveMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers["content-type"] || "";
    const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) {
      return reject(
        uploadError(
          "multipart boundary missing from content-type",
          "UPLOAD_MALFORMED",
        ),
      );
    }
    const boundary = m[1] || m[2];

    const limits = resolveUploadLimits();
    const usage = dirUsageBytes(UPLOAD_DIR);
    const available = Math.max(0, limits.quota - usage);
    if (available <= 0) {
      return reject(
        uploadError(
          `upload directory quota exhausted: ${usage} bytes already stored ` +
            `of a ${limits.quota} byte quota (free space in the upload dir ` +
            `or adjust MCODE_WEBUI_UPLOAD_QUOTA)`,
          "UPLOAD_QUOTA_EXCEEDED",
        ),
      );
    }

    // Best-effort mkdir (server.js preflights this at boot; the guard
    // only matters when the lib is exercised standalone, e.g. tests).
    try {
      mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch {
      /* a real write failure surfaces via the WriteStream below */
    }

    // Temp file first, final name only after a fully clean stream:
    // an aborted over-limit upload never leaves a half-written file
    // under its final name (and the temp itself is unlinked).
    const tmpPath = join(
      UPLOAD_DIR,
      `.upload-${process.pid}-${randomBytes(5).toString("hex")}.part`,
    );
    // The temp file is created with an EAGER synchronous open and the
    // WriteStream is handed the fd. createWriteStream's lazy async
    // open would race fail(): unlink could run before the open syscall
    // created the file, and the late open would then materialize an
    // orphan empty .part AFTER cleanup (observed under load). With the
    // eager fd the file exists exactly from here until unlinked — the
    // only later filesystem effect is the happy-path rename.
    let fd;
    try {
      fd = openSync(tmpPath, "w");
    } catch (e) {
      return reject(
        uploadError(`cannot create temp upload file: ${e.message}`, "UPLOAD_IO_ERROR"),
      );
    }
    const ws = createWriteStream(tmpPath, { fd, autoClose: true });
    const parser = new MultipartParser({
      boundary,
      maxRequest: limits.maxRequest,
      maxFile: limits.maxFile,
      quotaAvailable: available,
    });

    let origName = null;
    let finalPath = null;
    let fileSize = 0;
    let settled = false;

    parser.on("file-start", (name) => {
      origName = name;
      finalPath = join(UPLOAD_DIR, _safeName(name));
    });
    parser.on("file-end", (n) => {
      fileSize = n;
    });

    function fail(e) {
      if (settled) return;
      settled = true;
      try {
        req.unpipe(parser);
      } catch {}
      try {
        parser.destroy();
      } catch {}
      try {
        ws.destroy();
      } catch {}
      try {
        unlinkSync(tmpPath);
      } catch {}
      reject(e);
    }

    parser.on("error", fail);
    ws.on("error", (e) =>
      fail(
        uploadError(`failed writing upload: ${e.message}`, "UPLOAD_IO_ERROR"),
      ),
    );
    req.on("error", (e) =>
      fail(
        uploadError(`request stream failed: ${e.message}`, "UPLOAD_ABORTED"),
      ),
    );
    req.on("aborted", () =>
      fail(uploadError("request aborted by client", "UPLOAD_ABORTED")),
    );

    // "close" (not "finish"): the fd is provably released here, which
    // makes unlink/rename safe on every platform (Windows refuses both
    // on open files). Reaching close un-failed means the parser ended
    // cleanly — a truncation already surfaced as a parser error.
    ws.on("close", () => {
      if (settled) {
        // Backstop: fail() already unlinked the temp name, but on
        // Windows the unlink may have been refused while the fd was
        // still open — retry now that it is closed.
        try {
          unlinkSync(tmpPath);
        } catch {}
        return;
      }
      settled = true;
      if (!origName) {
        try {
          unlinkSync(tmpPath);
        } catch {}
        return reject(
          uploadError("no file part", "UPLOAD_MALFORMED"),
        );
      }
      try {
        renameSync(tmpPath, finalPath);
      } catch (e) {
        try {
          unlinkSync(tmpPath);
        } catch {}
        return reject(
          uploadError(
            `failed finalizing upload: ${e.message}`,
            "UPLOAD_IO_ERROR",
          ),
        );
      }
      resolve({ path: finalPath, name: origName, size: fileSize });
    });

    req.pipe(parser).pipe(ws);
  });
}
