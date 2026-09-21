// webui/server/lib/events.js
// Append-only NDJSON event stream + sha256 hash chain.
//
// Lease B01 — implements the verifiability criterion:
//   - Every state-changing action (settings toggle, session create/delete/switch,
//     slash governance commands, db-level session delete) writes one NDJSON line
//     to ~/.mcode-webui/events.ndjson (path overridable via MCODE_WEBUI_EVENTS_PATH).
//   - Each line carries `before_hash` (== `prev_after_hash`) and `after_hash`
//     where `after_hash = sha256(prev_after_hash + JSON.stringify(this))`.
//   - The first line's `before_hash` is "" (the empty string). The chain
//     is verifiable in either direction (forward or reverse read) per
//     ORD-007 推衍链健全性与镜像 (math skeleton §1.2).
//
// Why a separate module (not inlined into each write site):
//   - One atomic write implementation (.tmp + rename, mode 0600)
//   - One process-level monotonic seq counter (lazy init from existing max)
//   - One `verify()` function the operator / reconcile batch can run later
//
// Math backbones (sih-math 2026-09-13 mapping):
//   - PROB-018 双重有损链与信息不增(DPI) — append-only NDJSON is forward+reverse
//     read-invariant; reading never introduces ambiguity.
//   - ORD-023 抽象重写系统与确定性范式 — append is a convergent rewrite step;
//     idempotent replay of one event yields zero net change.
//   - ORD-007 推衍链健全性与镜像 — sha256(prev+this) is the chain.
//
// File location: ~/.mcode-webui/events.ndjson by default. Override via
// MCODE_WEBUI_EVENTS_PATH for tests (the verify() / seq-init code only
// reads the file path from the resolved setting, never from process.env
// directly, so tests can swap it before any event is written).

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const EVENTS_DIR_DEFAULT = join(homedir(), ".mcode-webui");
const EVENTS_PATH_DEFAULT = join(EVENTS_DIR_DEFAULT, "events.ndjson");

// _eventsPath — lazy resolver. Tests can set MCODE_WEBUI_EVENTS_PATH before
// the first append() call without re-importing the module (same pattern as
// settings.js#_settingsPath).
function _eventsPath() {
  return process.env.MCODE_WEBUI_EVENTS_PATH || EVENTS_PATH_DEFAULT;
}

// _ensureDir — best-effort mkdir of the parent directory. Settings.js uses
// the same best-effort pattern (settings.js#ensureDir lines 126-134); we
// mirror it here so a permission error doesn't take the server down — the
// append() call will simply fail and the caller decides what to do.
function _ensureDir() {
  try {
    mkdirSync(dirname(_eventsPath()), { recursive: true });
  } catch (e) {
    // Best-effort: log + continue. The actual write below will throw a
    // clearer error if the dir is truly inaccessible.
    console.warn(
      `[webui] events mkdir ${dirname(_eventsPath())} failed: ${e.message}`,
    );
  }
}

// _seqStart — process-level monotonic seq. Lazy init reads the existing
// file's max(seq) + 1 on first append() call. If the file is missing or
// corrupt, start at 1. This makes a fresh process resume numbering rather
// than restart at 1 (which would collide with older lines).
//
// Note: this is in-process memory; two webui processes writing to the same
// events.ndjson would race. That's by design — the server is single-process
// today (one mcode webui per host). If that changes, swap for flock or
// rename-to-tmp-then-rename-back (which is what writeAtomic does for the
// file itself, so each line is atomic but counter increments are not).
let _seqCounter = 0;
let _seqInitialized = false;

function _nextSeq() {
  if (!_seqInitialized) {
    _seqInitialized = true;
    let max = 0;
    try {
      if (existsSync(_eventsPath())) {
        const raw = readFileSync(_eventsPath(), "utf8");
        // Forward scan for max(seq). Defensive against corrupt lines (skip).
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const s = Number(obj && obj.seq);
            if (Number.isFinite(s) && s > max) max = s;
          } catch {
            // skip malformed line — verify() will flag it later
          }
        }
      }
    } catch {
      // ignore — start at 1
    }
    _seqCounter = max + 1;
  }
  return _seqCounter++;
}

// _lastAfterHash — cached tail of the hash chain. Reset on process start
// (we re-read from disk lazily). Held in memory so we don't have to
// re-scan the file on every append (which is O(n) per call).
let _lastAfterHash = "";
let _lastHashInitialized = false;

function _getLastAfterHash() {
  if (!_lastHashInitialized) {
    _lastHashInitialized = true;
    let last = "";
    try {
      if (existsSync(_eventsPath())) {
        const raw = readFileSync(_eventsPath(), "utf8");
        // Reverse scan is cheaper: just find the last non-empty line and
        // read its after_hash. Empty file → "".
        const lines = raw.split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          if (!lines[i]) continue;
          try {
            const obj = JSON.parse(lines[i]);
            last = String((obj && obj.after_hash) || "");
            break;
          } catch {
            // skip — verify() will report
          }
        }
      }
    } catch {
      // ignore — treat as empty chain
    }
    _lastAfterHash = last;
  }
  return _lastAfterHash;
}

function _setLastAfterHash(h) {
  _lastAfterHash = String(h || "");
}

// _sha256Hex — small wrapper so the algorithm choice is in one place.
// We use the empty string as the head chain (no magic sentinel). Per
// spec: `after_hash = sha256(prev_after_hash + JSON.stringify(this))`.
// When prev_after_hash === "", the input is just the JSON of this line,
// which is still well-defined (sha256("") = "e3b0c4...").
function _sha256Hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

// _hashLine — compute the after_hash for a fully-formed event object
// (excluding its own after_hash, which would be circular). We canonicalize
// by re-serializing with the same key order used by _buildLine below, so
// verify() can reproduce the hash byte-for-byte.
function _hashLine(prevAfterHash, lineObj) {
  // lineObj at this point has after_hash = ""; we need to hash a version
  // WITHOUT after_hash (it's defined by this hash). Use the canonical form.
  const { after_hash: _omit, ...rest } = lineObj;
  const canonical = JSON.stringify(rest);
  return _sha256Hex(prevAfterHash + canonical);
}

// _buildLine — assembles the NDJSON record. Field order matters for hash
// stability (we hash a JSON.stringify of the object, and Node's JSON keeps
// insertion order for string keys — verified by reading Node docs and
// testing with v22+). The schema:
//
// {
//   "seq": <monotonic int>,
//   "ts": <ms epoch>,
//   "actor": <string>,       // "user" | "system" | "llm" — caller decides
//   "kind": <string>,        // e.g. "settings.update"
//   "target": <string>,      // field path / object acted on
//   "before_hash": <prev tail after_hash, "" if first>,
//   "after_hash": <sha256 hex, set last after hash compute>,
//   "cid": <string>,         // webui tab id (may be "" if N/A)
//   "data": <object>         // event-specific payload (old/new values etc.)
// }
function _buildLine({ actor, kind, target, cid, data }) {
  const ts = Date.now();
  const seq = _nextSeq();
  const beforeHash = _getLastAfterHash();
  const partial = {
    seq,
    ts,
    actor: actor || "system",
    kind: String(kind || ""),
    target: String(target || ""),
    before_hash: beforeHash,
    after_hash: "", // placeholder; filled after hash
    cid: cid || "",
    data: data && typeof data === "object" ? data : {},
  };
  const afterHash = _hashLine(beforeHash, partial);
  return { ...partial, after_hash: afterHash };
}

// _writeAtomic — single-line append via .tmp + rename. The atomic
// guarantee requires the rename pattern (POSIX rename is atomic within
// a filesystem). We do NOT use fs.appendFileSync(O_APPEND) because:
//   1. POSIX O_APPEND guarantees atomicity for the line, but Node's
//      appendFileSync can still fail in the middle of a multi-byte UTF-8
//      character (rare, but possible if EOL splits a codepoint).
//   2. We want a single audit file to be readable while the server is
//      running (tail -f); .tmp + rename gives us that without the brief
//      inode-swap window where tail might see an empty file.
//
// For an append-only log, "atomic" means: the file always contains a
// prefix of lines in valid form. Each append() therefore writes:
//     <existing content> + <new line>      to /path/events.ndjson.tmp
//     rename .tmp → events.ndjson           (atomic inode swap)
//
// This rewrites the whole file per append. For our scale (KB-scale,
// settings + session events, thousands not millions of lines) this is
// fine — Node's fs.readFileSync + writeFileSync on a few-KB file is
// sub-millisecond. If volume grows past MB, swap to a fd-based appender
// (openSync in 'a' mode + flock) but lose the per-line atomicity guarantee.
function _writeAtomic(line) {
  _ensureDir();
  const path = _eventsPath();
  const newLine = line.endsWith("\n") ? line : line + "\n";
  // Read existing content (if any) to preserve the chain. A read
  // failure (perms, racing unlink) is FATAL for the append — we must
  // NOT fall through and write "new line only": that silently
  // truncates the audit chain, and a truncated chain that keeps
  // accepting writes is exactly the fail-open condition the 2026-09-20
  // audit flagged. Fail-closed: propagate so the caller aborts the
  // gated action (routes translate this to HTTP 5xx + an alert).
  let existing = "";
  try {
    if (existsSync(path)) {
      existing = readFileSync(path, "utf8");
    }
  } catch (e) {
    console.error(
      `[webui] events read ${path} for atomic append failed: ${e.message} — aborting append (fail-closed, no truncation)`,
    );
    throw e;
  }
  const content = existing + newLine;
  // Write the combined content to .tmp, then rename atomically.
  let fd;
  try {
    fd = openSync(path + ".tmp", "w", 0o600);
  } catch (e) {
    // Some FS / Windows ignore 0o600; fall back to plain writeFileSync
    writeFileSync(path + ".tmp", content, { encoding: "utf8", mode: 0o600 });
    renameSync(path + ".tmp", path);
    return;
  }
  try {
    writeFileSync(fd, Buffer.from(content, "utf8"));
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
  try {
    renameSync(path + ".tmp", path);
  } catch (e) {
    console.error(`[webui] events rename ${path} failed: ${e.message}`);
    throw e;
  }
}

// append — public API. Writes one NDJSON line with sha256 chain.
//
// Signature:
//   append(kind, fields, opts?) → returns the written line object
//     - kind: string, e.g. "settings.update", "session.create"
//     - fields: { target?, cid?, actor?, payload? } — target/cid default
//       to "" / "" respectively; actor defaults to "user". payload
//       is the object that becomes the line's `data` field.
//
// Reserved top-level keys in `fields` (extracted before payload merge):
//   - target, cid, actor — promoted to top-level line fields
//   - kind — already supplied as the first arg, ignored if duplicated
//   - seq, ts, before_hash, after_hash — always set by the framework,
//     never accept caller values
//
// Everything else in `fields` is silently dropped. Callers that want
// ad-hoc keys in the data field MUST put them inside `payload`. This
// strict shape prevents caller typo bugs (e.g. `taret:` instead of
// `target:`) from silently landing in `line.data`.
//
// Error model (fail-closed, 2026-09-20 rigor fix):
//   - If the write fails (disk full, permission denied, unreadable
//     prior content), append() THROWS after logging. Audit capability
//     is a precondition for completing audited actions, not an
//     optional decoration: a governance action that completes while
//     its audit trail is missing is exactly the fail-open condition
//     this module exists to prevent. Callers translate the throw into
//     HTTP 5xx + an alerts-channel signal (see routes/* and
//     authorize.js).
//   - verify() / tail() remain non-throwing read-only diagnostics;
//     a broken chain is reported as data, not as an exception.
//
// Thread-safety / concurrency:
//   - Two simultaneous append() calls in the same process are NOT
//     racy because Node is single-threaded — _seqCounter and
//     _lastAfterHash are read+updated synchronously before the async
//     fs.writeFileSync returns. Each line sees its predecessor's hash.
export function append(kind, fields = {}, opts = {}) {
  const target = (fields && fields.target) || opts.target || "";
  const cid = (fields && fields.cid) || opts.cid || "";
  const actor = (fields && fields.actor) || opts.actor || "user";
  // Payload is whatever the caller put in `payload` (preferred) or
  // `data` (legacy alias) — explicit key, not "everything else".
  let payload = {};
  if (fields && typeof fields === "object") {
    if (typeof fields.payload === "object" && fields.payload !== null) {
      payload = fields.payload;
    } else if (typeof fields.data === "object" && fields.data !== null) {
      // Back-compat: callers who write { data: {...} } (no top-level
      // target/cid/actor) get that object as payload. We treat `data`
      // AS the payload only when it's clearly the payload (no other
      // meta keys mixed in).
      const hasMetaKeys =
        fields.target !== undefined ||
        fields.cid !== undefined ||
        fields.actor !== undefined;
      if (!hasMetaKeys) {
        payload = fields.data;
      }
    }
  }
  let line;
  try {
    line = _buildLine({
      actor,
      kind,
      target,
      cid,
      data: payload,
    });
    _writeAtomic(JSON.stringify(line));
  } catch (e) {
    // Fail-closed: log loudly and rethrow. The in-memory chain tail is
    // NOT advanced (the line never landed on disk), so a later append
    // after recovery re-chains from the true on-disk state only if the
    // caches are reset; verify() remains the operator's ground truth.
    console.error(
      `[webui] events append kind=${kind} failed: ${e.message} (fail-closed, rethrowing)`,
    );
    throw e;
  }
  _setLastAfterHash(line.after_hash);
  return line;
}

// verify — read the whole file, walk forward, recompute each line's
// after_hash, compare to what's stored. Returns:
//   { ok: true, count }              — chain intact
//   { ok: false, error, line?, ... } — first broken line found
//
// The error codes mirror what an operator needs to debug:
//   - "missing_file" — events.ndjson doesn't exist (fresh server, OK)
//   - "parse_error"  — a line is not valid JSON (corruption)
//   - "seq_gap"      — seqs not strictly monotonic (insert / delete)
//   - "hash_mismatch" — recomputed hash != stored hash (tamper / bit rot)
//   - "chain_break"  — before_hash != previous line's after_hash (split)
//
// verify() never throws. Always returns a structured result.
export function verify(opts = {}) {
  const path = opts.path || _eventsPath();
  if (!existsSync(path)) {
    return { ok: true, count: 0, note: "file_missing" };
  }
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, error: "read_failed", message: e.message };
  }
  const lines = raw.split("\n");
  let prevAfter = "";
  let prevSeq = 0;
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue; // skip blank lines (trailing newline)
    count++;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        error: "parse_error",
        line: i + 1,
        message: e.message,
      };
    }
    const seq = Number(obj && obj.seq);
    const storedBefore = String((obj && obj.before_hash) || "");
    const storedAfter = String((obj && obj.after_hash) || "");
    if (!Number.isFinite(seq) || seq <= 0) {
      return {
        ok: false,
        error: "parse_error",
        line: i + 1,
        message: "missing/invalid seq",
      };
    }
    if (prevSeq > 0 && seq !== prevSeq + 1) {
      return {
        ok: false,
        error: "seq_gap",
        line: i + 1,
        expected: prevSeq + 1,
        actual: seq,
      };
    }
    if (storedBefore !== prevAfter) {
      return {
        ok: false,
        error: "chain_break",
        line: i + 1,
        expected_before: prevAfter,
        actual_before: storedBefore,
      };
    }
    // Recompute: take the line without its own after_hash, sha256 with prevAfter.
    const { after_hash: _omit, ...rest } = obj;
    const expected = _sha256Hex(prevAfter + JSON.stringify(rest));
    if (expected !== storedAfter) {
      return {
        ok: false,
        error: "hash_mismatch",
        line: i + 1,
        expected_after: expected,
        actual_after: storedAfter,
      };
    }
    prevSeq = seq;
    prevAfter = storedAfter;
  }
  return { ok: true, count, tail: prevAfter };
}

// tail — peek at the most recent N lines (default 1) for the operator
// or a future reconcile tool. Reads file once, returns newest-first.
// Never throws; returns [] on missing / empty file.
export function tail(n = 1, opts = {}) {
  const path = opts.path || _eventsPath();
  if (!existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l);
  const out = [];
  for (let i = Math.max(0, lines.length - n); i < lines.length; i++) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {
      // skip malformed — verify() will report
    }
  }
  return out.reverse(); // newest first
}

// reset — for tests only. Clears the in-memory seq + last-hash cache and
// optionally deletes the file. NEVER call from production code.
export function _resetForTests(opts = {}) {
  _seqCounter = 0;
  _seqInitialized = false;
  _lastAfterHash = "";
  _lastHashInitialized = false;
  if (opts.deleteFile) {
    // unlinkSync comes from the module-top `node:fs` import. The old
    // implementation called require("node:fs") inside an ESM module —
    // a ReferenceError the try/catch swallowed, silently leaving the
    // file on disk and opts.deleteFile a no-op (2026-09-20 audit).
    try {
      unlinkSync(_eventsPath());
    } catch {}
  }
}

// path — exposed for tests + reconcile. Returns the resolved file path.
export function path() {
  return _eventsPath();
}

// size — convenience: file size in bytes (0 if missing). Used by tests
// that want to assert "append wrote at least 1 byte".
export function size() {
  const p = _eventsPath();
  if (!existsSync(p)) return 0;
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}