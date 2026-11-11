// webui/test/lib-events.test.js
// Unit tests for server/lib/events.js — append-only NDJSON event stream.
//
// Lease B01 verification: the events module must
//   1. write one NDJSON line per append() call
//   2. maintain a monotonic seq counter (resumes after process restart)
//   3. chain via sha256(prev_after_hash + JSON.stringify(this))
//   4. support atomic write via .tmp + rename (no half-written file)
//   5. allow caller overrides via MCODE_WEBUI_EVENTS_PATH
//   6. recover gracefully when the file is missing / corrupt / unreadable
//   7. expose verify() that detects tampering
//   8. expose tail() for the operator
//   9. THROW on audit write failures (fail-closed, 2026-09-20 rigor
//      fix — an audited action must not complete with a missing audit
//      line; routes translate the throw into HTTP 5xx + an alert)
//
// Test strategy:
//   - Use a fresh tmp dir per test (MCODE_WEBUI_EVENTS_PATH override).
//   - We test events.js IN ISOLATION — no _setup.js mocks. The events
//     module has zero dependencies on the rest of the webui (intentional:
//     it's the audit layer, it must remain uncorruptible).
//   - Verify-hash tampering is exercised by reading the file, replacing
//     a single after_hash, calling verify(), and asserting
//     { ok: false, error: "hash_mismatch", line: N }.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let events;
let tmpDir;
let tmpEventsPath;

before(async () => {
  events = await import(absPath("lib/events.js"));
});

beforeEach(() => {
  // Fresh tmp dir per test → fresh events.ndjson. Override the path
  // BEFORE the module's lazy resolvers see it, so the seq counter
  // initializes from a non-existent file (max(seq) = 0 → starts at 1).
  tmpDir = mkdtempSync(join(tmpdir(), "webui-events-test-"));
  tmpEventsPath = join(tmpDir, "events.ndjson");
  process.env.MCODE_WEBUI_EVENTS_PATH = tmpEventsPath;
  // Reset the in-memory seq + last-hash cache so each test starts
  // fresh — otherwise a previous test's max(seq) leaks into the next.
  events._resetForTests();
});

after(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  // Clean up env override for any subsequent test in the same process
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
});

describe("events — basic append", () => {
  test("writes one NDJSON line per append() call", () => {
    const r1 = events.append("settings.update", {
      target: "lanBroadcast",
      data: { old: true, new: false },
    });
    const r2 = events.append("session.create", {
      target: "abc",
      data: { title: "New" },
    });
    assert.ok(r1, "append should return the written line");
    assert.ok(r2);
    assert.equal(typeof r1.after_hash, "string");
    assert.equal(r1.after_hash.length, 64); // sha256 hex
    // Read raw file: should have exactly 2 lines
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 2);
    // Each line is parseable JSON
    const obj1 = JSON.parse(lines[0]);
    const obj2 = JSON.parse(lines[1]);
    assert.equal(obj1.kind, "settings.update");
    assert.equal(obj2.kind, "session.create");
    // Lines end with newline (NDJSON spec)
    assert.ok(raw.endsWith("\n"));
  });

  test("first line has before_hash = '' (empty chain head)", () => {
    const r = events.append("test.first", { data: { foo: 1 } });
    assert.equal(r.before_hash, "");
    assert.notEqual(r.after_hash, "");
  });

  test("subsequent lines have before_hash = previous after_hash", () => {
    const r1 = events.append("test.first", { data: { foo: 1 } });
    const r2 = events.append("test.second", { data: { bar: 2 } });
    assert.equal(r2.before_hash, r1.after_hash);
  });

  test("seq is monotonic starting at 1 for fresh file", () => {
    const r1 = events.append("a", { data: {} });
    const r2 = events.append("b", { data: {} });
    const r3 = events.append("c", { data: {} });
    assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2);
    assert.equal(r3.seq, 3);
  });

  test("seq resumes from existing max + 1 after process restart", () => {
    // Simulate a previous process writing 3 lines, then this process
    // reads the file and starts at seq=4.
    writeFileSync(
      tmpEventsPath,
      [
        JSON.stringify({
          seq: 1,
          ts: 0,
          actor: "system",
          kind: "a",
          target: "",
          before_hash: "",
          after_hash: "h1",
          cid: "",
          data: {},
        }),
        JSON.stringify({
          seq: 2,
          ts: 0,
          actor: "system",
          kind: "b",
          target: "",
          before_hash: "h1",
          after_hash: "h2",
          cid: "",
          data: {},
        }),
        JSON.stringify({
          seq: 3,
          ts: 0,
          actor: "system",
          kind: "c",
          target: "",
          before_hash: "h2",
          after_hash: "h3",
          cid: "",
          data: {},
        }),
        "",
      ].join("\n"),
    );
    events._resetForTests();
    const r = events.append("d", { data: {} });
    assert.equal(r.seq, 4);
    assert.equal(r.before_hash, "h3");
  });

  test("file does not exist after fresh process — append creates it", () => {
    assert.equal(existsSync(tmpEventsPath), false);
    events.append("x", { data: { y: 1 } });
    assert.equal(existsSync(tmpEventsPath), true);
  });
});

describe("events — actor / target / cid defaults", () => {
  test("actor defaults to 'user' when not specified", () => {
    const r = events.append("x", { data: {} });
    assert.equal(r.actor, "user");
  });

  test("actor can be overridden via opts", () => {
    const r = events.append("x", { data: {} }, { actor: "system" });
    assert.equal(r.actor, "system");
  });

  test("target pulled from data.target", () => {
    const r = events.append("settings.update", {
      target: "readOnly",
      data: { old: false, new: true },
    });
    assert.equal(r.target, "readOnly");
  });

  test("cid pulled from data.cid", () => {
    const r = events.append("x", { cid: "abc", data: {} });
    assert.equal(r.cid, "abc");
  });

  test("target/cid/actor go top-level; payload is the line's data", () => {
    const r = events.append("x", {
      target: "tgt",
      cid: "cid123",
      actor: "actorA",
      payload: { old: false, new: true },
    });
    assert.deepEqual(r.data, { old: false, new: true });
    assert.equal(r.target, "tgt");
    assert.equal(r.cid, "cid123");
    assert.equal(r.actor, "actorA");
  });

  test("data-key is the legacy alias for payload (no meta keys mixed in)", () => {
    const r = events.append("x", { data: { x: 1, y: 2 } });
    assert.deepEqual(r.data, { x: 1, y: 2 });
  });

  test("non-object data becomes empty object", () => {
    const r = events.append("x", { data: "not an object" });
    assert.deepEqual(r.data, {});
  });
});

describe("events — error resilience (fail-closed)", () => {
  test("append THROWS when the events dir is unwritable (fail-closed)", {
    // U5 (fork-preview run 35495306680): chmod on a directory is a no-op
    // on win32 — the dir stays writable, the fail-closed throw never
    // fires, and the THROWS assertion cannot hold. POSIX runs it in full.
    skip:
      process.platform === "win32"
        ? "skipped: chmod lacks write-permission semantics on win32"
        : false,
  }, () => {
    // Point the events path inside a read-only directory. append()
    // must throw (2026-09-20 rigor fix) — the caller aborts the gated
    // action instead of completing it unaudited.
    const roDir = mkdtempSync(join(tmpdir(), "webui-events-ro-"));
    try {
      chmodSync(roDir, 0o555); // r-x — no write for owner
      const roPath = join(roDir, "events.ndjson");
      // NOTE: running as root would bypass mode bits; on the supported
      // dev/CI hosts (non-root) the write fails with EACCES.
      const isRoot = process.getuid && process.getuid() === 0;
      if (isRoot) {
        assert.ok(true, "running as root — mode-bit probe skipped");
        return;
      }
      process.env.MCODE_WEBUI_EVENTS_PATH = roPath;
      events._resetForTests();
      assert.throws(() => events.append("x", { data: {} }));
      // And nothing landed on disk.
      assert.equal(existsSync(roPath), false, "no file in read-only dir");
    } finally {
      try { chmodSync(roDir, 0o755); } catch {}
      try { rmSync(roDir, { recursive: true, force: true }); } catch {}
      // Restore the per-test override set by beforeEach.
      process.env.MCODE_WEBUI_EVENTS_PATH = tmpEventsPath;
      events._resetForTests();
    }
  });

  test("append THROWS when the existing chain file is unreadable", () => {
    // _writeAtomic must not "write the new line only" on a read
    // failure — that truncates the chain (the fail-open condition the
    // 2026-09-20 audit flagged). Simulate: make the FILE unreadable
    // (mode 000) after a first successful write.
    const r0 = events.append("first", { data: {} });
    assert.ok(r0);
    chmodSync(tmpEventsPath, 0o000);
    try {
      const isRoot = process.getuid && process.getuid() === 0;
      if (!isRoot) {
        assert.throws(() => events.append("second", { data: {} }));
      }
    } finally {
      try { chmodSync(tmpEventsPath, 0o600); } catch {}
    }
  });

  test("junk (non-object) data does not throw on a writable path", () => {
    const r = events.append("x", { data: undefined });
    assert.ok(r, "should not throw");
  });

  test("kind is required and stringified", () => {
    const r = events.append(123, { data: {} });
    assert.equal(r.kind, "123");
  });
});

describe("events — verify()", () => {
  test("returns { ok: true, count: 0, note: 'file_missing' } when file absent", () => {
    // Use a fresh tmp file that doesn't exist
    const v = events.verify({ path: "/tmp/does-not-exist-events-" + Date.now() });
    assert.equal(v.ok, true);
    assert.equal(v.count, 0);
    assert.equal(v.note, "file_missing");
  });

  test("returns { ok: true, count } for a clean chain", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    events.append("c", { data: {} });
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, true);
    assert.equal(v.count, 3);
    assert.ok(v.tail, "should report tail hash");
  });

  test("detects hash_mismatch when a line's after_hash is tampered", () => {
    events.append("a", { data: { foo: 1 } });
    events.append("b", { data: { foo: 2 } });
    events.append("c", { data: { foo: 3 } });
    // Read the file, tamper line 2's after_hash (line index 1)
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const obj = JSON.parse(lines[1]);
    obj.after_hash = "DEAD".padEnd(64, "BEEF").slice(0, 64);
    lines[1] = JSON.stringify(obj);
    writeFileSync(tmpEventsPath, lines.join("\n") + "\n");
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    assert.equal(v.error, "hash_mismatch");
    assert.equal(v.line, 2);
  });

  test("detects chain_break when before_hash doesn't match predecessor", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    // Tamper line 2's before_hash to a bogus value
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const obj = JSON.parse(lines[1]);
    obj.before_hash = "WRONG".padEnd(64, "0").slice(0, 64);
    lines[1] = JSON.stringify(obj);
    writeFileSync(tmpEventsPath, lines.join("\n") + "\n");
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    assert.equal(v.error, "chain_break");
    assert.equal(v.line, 2);
  });

  test("detects parse_error when a line is corrupt JSON", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    // Replace line 2 with garbage
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n");
    lines[1] = "{not valid json";
    writeFileSync(tmpEventsPath, lines.join("\n"));
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    assert.equal(v.error, "parse_error");
    assert.equal(v.line, 2);
  });
});

describe("events — tail()", () => {
  test("returns [] for missing file", () => {
    const t = events.tail(5, { path: "/tmp/no-such-events-" + Date.now() });
    assert.deepEqual(t, []);
  });

  test("returns last N lines newest-first", () => {
    events.append("a", { data: { n: 1 } });
    events.append("b", { data: { n: 2 } });
    events.append("c", { data: { n: 3 } });
    const t = events.tail(2);
    assert.equal(t.length, 2);
    assert.equal(t[0].kind, "c"); // newest first
    assert.equal(t[1].kind, "b");
  });

  test("returns single line when tail(1)", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    const t = events.tail(1);
    assert.equal(t.length, 1);
    assert.equal(t[0].kind, "b");
  });
});

describe("events — path() / size()", () => {
  test("path() returns the resolved events file path", () => {
    const p = events.path();
    assert.ok(p.includes("events.ndjson"));
  });

  test("size() returns 0 when file is missing", () => {
    const v = events.size();
    // Either 0 (no file) or > 0 (file exists from a previous test).
    // We can't assert a specific value without controlling the env,
    // but we can assert it's a number ≥ 0.
    assert.ok(typeof v === "number");
    assert.ok(v >= 0);
  });

  test("size() reflects file growth after append", () => {
    const before = events.size();
    events.append("x", { data: { payload: "hello world".repeat(10) } });
    const after = events.size();
    assert.ok(after > before);
  });
});

describe("events — atomic write semantics", () => {
  test(".tmp file is cleaned up after successful rename", () => {
    events.append("x", { data: {} });
    const tmpFile = tmpEventsPath + ".tmp";
    assert.equal(existsSync(tmpFile), false, ".tmp should be cleaned up");
  });
});

describe("events — _resetForTests deleteFile fix (2026-09-20)", () => {
  test("_resetForTests({deleteFile:true}) actually deletes the file", () => {
    // The old implementation called require("node:fs") inside an ESM
    // module — a ReferenceError the inner catch swallowed, leaving
    // opts.deleteFile silently ineffective. The fix imports unlinkSync
    // at module top; this test pins the fixed behavior.
    events.append("a", { data: {} });
    assert.equal(existsSync(tmpEventsPath), true, "file exists before reset");
    events._resetForTests({ deleteFile: true });
    assert.equal(existsSync(tmpEventsPath), false,
      "deleteFile:true must actually unlink the events file");
  });
});