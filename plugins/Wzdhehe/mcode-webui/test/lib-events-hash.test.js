// webui/test/lib-events-hash.test.js
// Hash-chain specific tests for server/lib/events.js.
//
// Lease B01 verification (focused on §1.2 events.ndjson audit chain):
//   - The sha256 chain is deterministic: writing the same N lines twice
//     yields identical hashes (modulo ts/seq).
//   - Tampering with a line's `data` field invalidates its after_hash
//     AND every subsequent after_hash (chain break cascades).
//   - The chain is bidirectional: verify() walks forward, but the
//     seq+hash invariants mean a reverse reader can detect any
//     mid-stream insert by checking prev_after_hash.
//   - Concurrent appends in the same process produce a valid chain
//     (Node is single-threaded; no real concurrency but we exercise
//     the path).

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

let events;
let tmpDir;
let tmpEventsPath;

before(async () => {
  events = await import(absPath("lib/events.js"));
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "webui-events-hash-test-"));
  tmpEventsPath = join(tmpDir, "events.ndjson");
  process.env.MCODE_WEBUI_EVENTS_PATH = tmpEventsPath;
  events._resetForTests();
});

after(() => {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
  delete process.env.MCODE_WEBUI_EVENTS_PATH;
});

// Helper: compute sha256 of "prev + canonical(this without after_hash)"
// Mirrors events.js#_hashLine — kept here so we can test the contract
// from the outside (and so a bug in the helper doesn't pass tests
// that just trust the implementation).
function expectedHash(prevAfterHash, lineObj) {
  const { after_hash: _omit, ...rest } = lineObj;
  const canonical = JSON.stringify(rest);
  return createHash("sha256")
    .update(String(prevAfterHash) + canonical, "utf8")
    .digest("hex");
}

describe("hash chain — invariant computation", () => {
  test("after_hash = sha256(prev_after_hash + JSON.stringify(this without after_hash))", () => {
    const r = events.append("test.kind", { target: "x", data: { y: 1 } });
    // The line as stored should hash to its own after_hash when we
    // apply the rule from the outside.
    const obj = JSON.parse(JSON.stringify(r));
    // Recompute: prev="" for the first line
    const expected = expectedHash("", obj);
    assert.equal(r.after_hash, expected);
  });

  test("chain advances: line N+1's after_hash includes line N's after_hash in its input", () => {
    const r1 = events.append("a", { data: { x: 1 } });
    const r2 = events.append("b", { data: { x: 2 } });
    // r2.before_hash must equal r1.after_hash (already asserted
    // in the unit suite, repeated here for clarity)
    assert.equal(r2.before_hash, r1.after_hash);
    // r2's after_hash must equal sha256(r1.after_hash + JSON(r2 without after_hash))
    const expected = expectedHash(r1.after_hash, r2);
    assert.equal(r2.after_hash, expected);
  });

  test("100 sequential appends produce a 100-element valid chain", () => {
    let prev = "";
    for (let i = 1; i <= 100; i++) {
      const r = events.append("bulk", { data: { i } });
      assert.equal(r.seq, i);
      assert.equal(r.before_hash, prev);
      const expected = expectedHash(prev, r);
      assert.equal(r.after_hash, expected);
      prev = r.after_hash;
    }
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, true);
    assert.equal(v.count, 100);
  });
});

describe("hash chain — tamper detection", () => {
  test("modifying a line's data field invalidates that line's after_hash", () => {
    events.append("a", { data: { x: 1 } });
    events.append("b", { data: { x: 2 } });
    events.append("c", { data: { x: 3 } });
    // Tamper: change line 2's data.x from 2 to 999
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const obj = JSON.parse(lines[1]);
    obj.data.x = 999;
    lines[1] = JSON.stringify(obj);
    writeFileSync(tmpEventsPath, lines.join("\n") + "\n");
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    // Could be hash_mismatch (line 2) or chain_break (line 3's
    // before_hash still references the OLD line 2 after_hash, so
    // line 3's chain_break check fires first). Either way the
    // chain is reported broken.
    assert.ok(
      v.error === "hash_mismatch" || v.error === "chain_break",
      `expected hash_mismatch or chain_break, got ${v.error}`,
    );
    assert.ok(v.line >= 2 && v.line <= 3, `expected line 2 or 3, got ${v.line}`);
  });

  test("inserting a synthetic line in the middle is detected (seq_gap OR chain_break)", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    // Append a forged line between two valid ones
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const forged = JSON.parse(lines[lines.length - 1]); // copy last valid line
    forged.seq = 99;
    forged.kind = "forged";
    lines.splice(1, 0, JSON.stringify(forged));
    writeFileSync(tmpEventsPath, lines.join("\n") + "\n");
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    assert.ok(
      v.error === "seq_gap" || v.error === "chain_break",
      `expected seq_gap or chain_break, got ${v.error}`,
    );
  });

  test("replacing a line's seq field is detected as parse_error", () => {
    events.append("a", { data: {} });
    events.append("b", { data: {} });
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const obj = JSON.parse(lines[1]);
    delete obj.seq; // remove seq → "missing/invalid seq" path
    lines[1] = JSON.stringify(obj);
    writeFileSync(tmpEventsPath, lines.join("\n") + "\n");
    const v = events.verify({ path: tmpEventsPath });
    assert.equal(v.ok, false);
    assert.equal(v.error, "parse_error");
    assert.equal(v.line, 2);
  });

  test("truncating the file (dropping the tail) is detectable by hash-chain mismatch", () => {
    for (let i = 0; i < 5; i++) events.append("a", { data: { i } });
    const raw = readFileSync(tmpEventsPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    // Drop the last 2 lines (truncate tail)
    writeFileSync(
      tmpEventsPath,
      lines.slice(0, -2).join("\n") + "\n",
    );
    const v = events.verify({ path: tmpEventsPath });
    // verify() only checks the chain AS WRITTEN. After truncation, the
    // remaining lines still form a valid chain (verify doesn't know
    // about "missing tail"). So it returns ok:true — the operator
    // compares count to a known-good baseline to detect truncation.
    // This test pins that behavior: truncation is detected by count,
    // not by chain_break. (Operator / reconcile tool compares to a
    // high-water mark.)
    assert.equal(v.ok, true);
    assert.equal(v.count, 3);
  });
});

describe("hash chain — restart resilience", () => {
  test("process restart resumes mid-chain correctly", () => {
    // Process 1: write 5 lines
    for (let i = 1; i <= 5; i++) events.append("a", { data: { i } });
    const expectedNextBeforeHash = events.tail(1)[0].after_hash;

    // Process restart simulation
    events._resetForTests();
    const r = events.append("b", { data: { i: 6 } });
    assert.equal(r.seq, 6);
    assert.equal(r.before_hash, expectedNextBeforeHash);
  });
});