// webui/test/lib-upload.test.js
// Unit tests for server/lib/upload.js — the bounded streaming multipart
// parser written for PR #55 review point 3 ("Uploads are unbounded").
//
// What these tests pin:
//   1. Zero regression on the happy path: a normal multipart POST with
//      one file resolves {path, name, size} and the exact bytes land on
//      disk under a generated (non-client-controlled) name.
//   2. Bounded streaming: an over-limit request/file/quota is rejected
//      MID-STREAM — the source stream's consumption counter stops far
//      below the offered body size, proving the parser never buffered
//      (or even read) the whole body before deciding.
//   3. All three limits: request total, single file, directory quota.
//   4. Failure hygiene: any abort/failure leaves NO temp or half-written
//      file behind (dir listing is empty afterwards).
//   5. Parser robustness: boundaries split across chunk edges, binary
//      content containing boundary-like prefixes, transport padding,
//      multi-part bodies where only the FIRST file part is stored.
//
// No mock.module: upload.js does real fs work against a mkdtemp'd
// UPLOAD_DIR (redirected via env BEFORE the dynamic import — same
// pattern as test/integration/router-boot.test.js U1). Limits are read
// lazily per call from the environment, so each test sets its own.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(__dirname, "..", "server");
const absPath = (rel) => pathToFileURL(join(SERVER_DIR, rel)).href;

// Redirect the upload dir BEFORE lib/upload.js (→ lib/config.js) is
// imported — config.js caches UPLOAD_DIR at module load.
const TMP_ROOT = mkdtempSync(join(tmpdir(), "mcode-webui-upload-lib-"));
const UPLOAD_DIR = join(TMP_ROOT, "uploads");
process.env.MCODE_WEBUI_UPLOAD_DIR = UPLOAD_DIR;

const uploadMod = await import(absPath("lib/upload.js"));

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
const BOUNDARY = "testboundary7f3a";

// Build a full multipart body. parts: [{name, filename?, content,
// contentType?, extraHeader?}] — filename present ⇒ file part.
function multipartBody(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let hd = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) hd += `; filename="${p.filename}"`;
    hd += "\r\n";
    if (p.contentType) hd += `Content-Type: ${p.contentType}\r\n`;
    if (p.extraHeader) hd += `${p.extraHeader}\r\n`;
    chunks.push(Buffer.from(hd + "\r\n"));
    chunks.push(Buffer.isBuffer(p.content) ? p.content : Buffer.from(p.content));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// Fake IncomingMessage: a Readable with a `headers` property that
// counts how many bytes actually LEFT the source (`stream.emitted`).
// After the parser aborts mid-stream and unpipes, `emitted` freezes —
// that frozen number is the "did not read the whole body" evidence.
function fakeReq(body, opts = {}) {
  const chunkSize = opts.chunkSize || 65536;
  const boundary = opts.boundary || BOUNDARY;
  const stream = new Readable({
    read() {
      if (this._pos >= body.length) {
        this.push(null);
        return;
      }
      const end = Math.min(this._pos + chunkSize, body.length);
      const c = body.slice(this._pos, end);
      this._pos = end;
      this.emitted += c.length;
      this.push(c);
    },
  });
  stream._pos = 0;
  stream.emitted = 0;
  stream.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
  return stream;
}

// The limit env vars are resolved lazily per call (see upload.js) —
// set them per test, restore in after().
const LIMIT_VARS = [
  "MCODE_WEBUI_UPLOAD_MAX_REQUEST",
  "MCODE_WEBUI_UPLOAD_MAX_FILE",
  "MCODE_WEBUI_UPLOAD_QUOTA",
];
const savedEnv = {};
before(() => {
  for (const v of LIMIT_VARS) savedEnv[v] = process.env[v];
  mkdirSync(UPLOAD_DIR, { recursive: true });
});
// Every test starts from an empty upload dir — the quota tests count
// bytes on disk, so leftover files from earlier tests would skew them.
beforeEach(() => {
  try {
    rmSync(UPLOAD_DIR, { recursive: true, force: true });
  } catch {}
  mkdirSync(UPLOAD_DIR, { recursive: true });
});
after(() => {
  for (const v of LIMIT_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

function setLimits({ request, file, quota }) {
  if (request !== undefined) process.env.MCODE_WEBUI_UPLOAD_MAX_REQUEST = String(request);
  if (file !== undefined) process.env.MCODE_WEBUI_UPLOAD_MAX_FILE = String(file);
  if (quota !== undefined) process.env.MCODE_WEBUI_UPLOAD_QUOTA = String(quota);
}
function clearLimits() {
  for (const v of LIMIT_VARS) delete process.env[v];
}
function dirFiles() {
  try {
    return readdirSync(UPLOAD_DIR).sort();
  } catch {
    return [];
  }
}

async function rejectsUpload(req, code) {
  await assert.rejects(
    () => uploadMod.saveMultipartUpload(req),
    (e) => {
      assert.equal(e.code, code, `expected code ${code}, got ${e.code} (${e.message})`);
      return true;
    },
  );
}

// -----------------------------------------------------------------------
// resolveUploadLimits — defaults, overrides, garbage
// -----------------------------------------------------------------------
describe("resolveUploadLimits", () => {
  test("defaults when env unset", () => {
    clearLimits();
    const l = uploadMod.resolveUploadLimits();
    assert.equal(l.maxRequest, 50 * 1024 * 1024);
    assert.equal(l.maxFile, 25 * 1024 * 1024);
    assert.equal(l.quota, 200 * 1024 * 1024);
  });

  test("env overrides apply", () => {
    setLimits({ request: 12345, file: 999, quota: 424242 });
    const l = uploadMod.resolveUploadLimits();
    assert.equal(l.maxRequest, 12345);
    assert.equal(l.maxFile, 999);
    assert.equal(l.quota, 424242);
    clearLimits();
  });

  test("garbage / zero / negative fall back to defaults", () => {
    process.env.MCODE_WEBUI_UPLOAD_MAX_REQUEST = "not-a-number";
    process.env.MCODE_WEBUI_UPLOAD_MAX_FILE = "0";
    process.env.MCODE_WEBUI_UPLOAD_QUOTA = "-5";
    const l = uploadMod.resolveUploadLimits();
    assert.equal(l.maxRequest, 50 * 1024 * 1024);
    assert.equal(l.maxFile, 25 * 1024 * 1024);
    assert.equal(l.quota, 200 * 1024 * 1024);
    clearLimits();
  });
});

// -----------------------------------------------------------------------
// dirUsageBytes
// -----------------------------------------------------------------------
describe("dirUsageBytes", () => {
  test("sums file sizes, ignores subdirectories, missing dir reads 0", () => {
    mkdirSync(join(UPLOAD_DIR, "sub"), { recursive: true });
    writeFileSync(join(UPLOAD_DIR, "a.bin"), Buffer.alloc(1000));
    writeFileSync(join(UPLOAD_DIR, "b.bin"), Buffer.alloc(37));
    assert.equal(uploadMod.dirUsageBytes(UPLOAD_DIR), 1037);
    assert.equal(uploadMod.dirUsageBytes(join(TMP_ROOT, "no-such-dir")), 0);
  });
});

// -----------------------------------------------------------------------
// Happy path & parser correctness
// -----------------------------------------------------------------------
describe("saveMultipartUpload — happy path", () => {
  test("single file: resolves path/name/size, exact bytes on disk, generated name", async () => {
    clearLimits();
    const content = Buffer.from("hello upload\n\0binary\xff");
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "notes.txt", content, contentType: "text/plain" },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.ok(saved.path.startsWith(UPLOAD_DIR), "file lands inside UPLOAD_DIR");
    assert.equal(dirname(saved.path), UPLOAD_DIR, "no subdirectory escape");
    assert.equal(saved.name, "notes.txt");
    assert.equal(saved.size, content.length);
    assert.equal(readFileSync(saved.path).toString("hex"), content.toString("hex"));
    // Generated name: epoch-md6 + original extension only.
    assert.match(basename(saved.path), /^\d+-[0-9a-f]{6}\.txt$/);
    assert.equal(dirFiles().length, 1, "exactly one file, no temp leftovers");
  });

  test("client filename never reaches the filesystem (path traversal attempt)", async () => {
    clearLimits();
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "../../evil.sh", content: "x" },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(dirname(saved.path), UPLOAD_DIR);
    assert.match(basename(saved.path), /\.sh$/);
    assert.equal(dirFiles().length, 1);
  });

  test("field part before file part: file still saved", async () => {
    clearLimits();
    const content = Buffer.from("file-bytes");
    const body = multipartBody(BOUNDARY, [
      { name: "caption", content: "just a field" },
      { name: "file", filename: "a.png", content, contentType: "image/png" },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(saved.size, content.length);
    assert.equal(readFileSync(saved.path).toString(), "file-bytes");
  });

  test("boundary split across chunk edges + boundary-like content survives", async () => {
    clearLimits();
    // Content deliberately contains \r\n--, a partial boundary prefix,
    // and a near-complete boundary missing one char.
    const content = Buffer.concat([
      Buffer.from("A\r\n--testboundary7f3\r\n--testboundary7f3aX\r\n--\0"),
      Buffer.from([0, 1, 2, 253, 254, 255]),
      Buffer.from("\r\n--testboundary7f3a2\r\nEND"),
    ]);
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "tricky.bin", content },
    ]);
    // chunkSize 7 is guaranteed to split the boundary markers.
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body, { chunkSize: 7 }));
    assert.equal(saved.size, content.length);
    assert.equal(readFileSync(saved.path).toString("hex"), content.toString("hex"));
  });

  test("quoted boundary parameter in content-type works", async () => {
    clearLimits();
    const b = "quoted-boundary-xyz";
    const body = multipartBody(b, [
      { name: "file", filename: "q.txt", content: "q" },
    ]);
    const req = fakeReq(body, { boundary: `"${b}"` });
    const saved = await uploadMod.saveMultipartUpload(req);
    assert.equal(readFileSync(saved.path).toString(), "q");
  });

  test("transport padding after boundary is tolerated", async () => {
    clearLimits();
    const content = "padded";
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}  \t\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="p.txt"\r\n\r\n`),
      Buffer.from(content),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(readFileSync(saved.path).toString(), content);
  });

  test("multiple file parts: only the FIRST is stored, later ones drained", async () => {
    setLimits({ request: 10 * 1024 * 1024, file: 64 * 1024 });
    const first = Buffer.from("first-file-content");
    // Second file is far over the single-file limit — it must be
    // DRAINED (skipped), not written, so no FILE_TOO_LARGE fires.
    const big2 = Buffer.alloc(300 * 1024, 0x42);
    const body = multipartBody(BOUNDARY, [
      { name: "f1", filename: "one.txt", content: first },
      { name: "f2", filename: "two.txt", content: big2 },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(saved.name, "one.txt");
    assert.equal(readFileSync(saved.path).toString(), "first-file-content");
    assert.equal(dirFiles().length, 1);
    clearLimits();
  });
});

// -----------------------------------------------------------------------
// Malformed input
// -----------------------------------------------------------------------
describe("saveMultipartUpload — malformed bodies", () => {
  test("missing boundary in content-type", async () => {
    clearLimits();
    const req = fakeReq(Buffer.from("anything"));
    req.headers = { "content-type": "multipart/form-data" };
    await rejectsUpload(req, "UPLOAD_MALFORMED");
    assert.equal(dirFiles().length, 0);
  });

  test("no file part (fields only)", async () => {
    clearLimits();
    const body = multipartBody(BOUNDARY, [{ name: "a", content: "b" }]);
    await rejectsUpload(fakeReq(body), "UPLOAD_MALFORMED");
    assert.equal(dirFiles().length, 0, "empty temp must be cleaned");
  });

  test("body with no boundary at all", async () => {
    clearLimits();
    await rejectsUpload(fakeReq(Buffer.from("garbage-no-boundary")), "UPLOAD_MALFORMED");
    assert.equal(dirFiles().length, 0);
  });

  test("truncated body (stream ends mid-file, no closing boundary)", async () => {
    clearLimits();
    const content = Buffer.alloc(1024, 0x61);
    const full = multipartBody(BOUNDARY, [
      { name: "file", filename: "t.bin", content },
    ]);
    // Cut the tail so the file part never closes.
    const truncated = full.slice(0, full.length - 40);
    await rejectsUpload(fakeReq(truncated), "UPLOAD_MALFORMED");
    assert.equal(dirFiles().length, 0, "half-written temp must be unlinked");
  });

  test("oversized part header block rejected", async () => {
    clearLimits();
    const hugeHeader = `X-Filler: ${"a".repeat(20 * 1024)}`;
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "h.txt", content: "h", extraHeader: hugeHeader },
    ]);
    await rejectsUpload(fakeReq(body), "UPLOAD_MALFORMED");
    assert.equal(dirFiles().length, 0);
  });
});

// -----------------------------------------------------------------------
// Limits — the core of review point 3
// -----------------------------------------------------------------------
describe("saveMultipartUpload — request limit", () => {
  test("over-limit request rejected MID-STREAM (source never fully consumed)", async () => {
    const LIMIT = 64 * 1024;
    setLimits({ request: LIMIT, file: 64 * 1024 * 1024, quota: 1024 * 1024 * 1024 });
    // 32 MiB body — far over the 64 KiB request cap. Built as a real
    // buffer; the assertion is that only a tiny prefix ever leaves the
    // source (i.e. the parser aborted instead of buffering it all).
    const filler = Buffer.alloc(32 * 1024 * 1024, 0x7a);
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "huge.bin", content: filler },
    ]);
    const req = fakeReq(body, { chunkSize: 16 * 1024 });
    const t0 = Date.now();
    await rejectsUpload(req, "UPLOAD_REQ_TOO_LARGE");
    const dt = Date.now() - t0;
    // Mid-stream abort evidence. "Consumption" counts bytes that left
    // the source; a bounded overshoot past the limit is inherent pipe
    // plumbing (Readable read-ahead + the pipe write queue + Transform
    // backpressure latency — a real socket's kernel buffers behave the
    // same way). What must hold:
    //   1. the source stopped being consumed FAR below the body size
    //      (a 32 MiB read-then-decide would show emitted ≈ 32 MiB);
    //   2. the overshoot stays within a structural slack, not O(body);
    //   3. the decision was fast — no full-body buffering delay.
    assert.ok(
      req.emitted < body.length / 4,
      `source was consumed too far: ${req.emitted} of ${body.length}`,
    );
    assert.ok(
      req.emitted <= LIMIT + 512 * 1024,
      `consumption ${req.emitted} exceeds cap+structural-slack`,
    );
    assert.ok(dt < 5000, `rejection took ${dt}ms — did it buffer first?`);
    assert.equal(dirFiles().length, 0, "no temp leftover after abort");
    clearLimits();
  });
});

describe("saveMultipartUpload — single-file limit", () => {
  test("over-limit file rejected MID-STREAM with bounded consumption", async () => {
    const FILE_LIMIT = 32 * 1024;
    setLimits({ request: 256 * 1024 * 1024, file: FILE_LIMIT, quota: 1024 * 1024 * 1024 });
    const filler = Buffer.alloc(16 * 1024 * 1024, 0x51); // 16 MiB
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "big.bin", content: filler },
    ]);
    const req = fakeReq(body, { chunkSize: 16 * 1024 });
    await rejectsUpload(req, "UPLOAD_FILE_TOO_LARGE");
    // Same plumbing-slack model as the request-limit test above: the
    // abort decision fires at the (limit+1)-th FILE byte; only in-flight
    // pipe buffering may push consumption past that.
    assert.ok(
      req.emitted <= FILE_LIMIT + 512 * 1024,
      `consumption ${req.emitted} exceeds file-cap+structural-slack`,
    );
    assert.ok(req.emitted < body.length / 4, "source consumed too far");
    assert.equal(dirFiles().length, 0, "half-written temp must be unlinked");
    clearLimits();
  });

  test("file exactly at the limit is accepted (boundary is inclusive)", async () => {
    setLimits({ request: 256 * 1024 * 1024, file: 4096, quota: 1024 * 1024 * 1024 });
    const content = Buffer.alloc(4096, 0x33);
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "exact.bin", content },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(saved.size, 4096);
    clearLimits();
  });
});

describe("saveMultipartUpload — directory quota", () => {
  test("quota already exhausted: rejected before a single byte is read", async () => {
    setLimits({ request: 256 * 1024 * 1024, file: 256 * 1024 * 1024, quota: 2000 });
    writeFileSync(join(UPLOAD_DIR, "prefill.bin"), Buffer.alloc(2000));
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "x.txt", content: "x" },
    ]);
    const req = fakeReq(body);
    await rejectsUpload(req, "UPLOAD_QUOTA_EXCEEDED");
    assert.equal(req.emitted, 0, "body must not be read at all");
    assert.deepEqual(dirFiles(), ["prefill.bin"]);
    clearLimits();
  });

  test("file crossing the remaining quota MID-STREAM is rejected and cleaned", async () => {
    setLimits({ request: 256 * 1024 * 1024, file: 256 * 1024 * 1024, quota: 10 * 1024 });
    writeFileSync(join(UPLOAD_DIR, "prefill2.bin"), Buffer.alloc(6 * 1024));
    // 4 KiB remaining, file is 8 MiB → the quota fires a few KB into the
    // file content, mid-stream. Consumption must stop « the body size
    // (same plumbing-slack model as the request-limit test).
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "over.bin", content: Buffer.alloc(8 * 1024 * 1024, 0x44) },
    ]);
    const req = fakeReq(body, { chunkSize: 16 * 1024 });
    await rejectsUpload(req, "UPLOAD_QUOTA_EXCEEDED");
    assert.ok(
      req.emitted < body.length / 4,
      `consumption ${req.emitted} not bounded`,
    );
    assert.deepEqual(dirFiles(), ["prefill2.bin"], "no new file, no temp");
    clearLimits();
  });

  test("file exactly filling the remaining quota is accepted", async () => {
    setLimits({ request: 256 * 1024 * 1024, file: 256 * 1024 * 1024, quota: 8 * 1024 });
    writeFileSync(join(UPLOAD_DIR, "prefill3.bin"), Buffer.alloc(4 * 1024));
    const body = multipartBody(BOUNDARY, [
      { name: "file", filename: "fit.bin", content: Buffer.alloc(4 * 1024, 0x55) },
    ]);
    const saved = await uploadMod.saveMultipartUpload(fakeReq(body));
    assert.equal(saved.size, 4 * 1024);
    assert.equal(dirFiles().length, 2);
    clearLimits();
  });
});
