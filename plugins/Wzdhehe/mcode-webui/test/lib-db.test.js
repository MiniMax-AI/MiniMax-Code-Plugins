// webui/test/lib-db.test.js
// Unit tests for server/lib/db.js — deleteMcodeSessionFromDb.
//
// Why this test exists: deleteMcodeSessionFromDb is the mcode-side session
// deleter (when webui DELETE /api/sessions/:id cascades to mcode's runtime db).
// It uses lazy require of mcode's better-sqlite3 and runs SQL against 9 tables.
// If a table is missing in a future mcode version, the loop should swallow
// the error (not throw) — this is the bug we want to pin.
//
// Test strategy: NO mock.module. db.js uses lazy require for better-sqlite3
// (auto-finds mcode's bundled copy). For the "happy path" case, we create a
// temp sqlite db with all the expected tables, then call deleteMcodeSessionFromDb.
// We also test invalid-sid early return and non-existent db file.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) => pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

// Find sqlite3 binary. On this host: C:\Users\<you>\anaconda3\Library\bin\sqlite3.exe
// On CI: system PATH
const SQLITE3_BIN = process.env.SQLITE3_BIN || "sqlite3";

const db = await import(absPath("lib/db.js"));

const VALID_SID = "mvs_deadbeef00000000000000000000aaaa";

describe("deleteMcodeSessionFromDb — input validation", () => {
  test("returns { ok: false, reason: 'not_mcode_sid' } for empty string", () => {
    const r = db.deleteMcodeSessionFromDb("", { MCODE_RUNTIME_DB: "/tmp/x.db" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_mcode_sid");
  });

  test("returns { ok: false, reason: 'not_mcode_sid' } for sid without mvs_ prefix", () => {
    const r = db.deleteMcodeSessionFromDb("deadbeef00000000000000000000aaaa", {
      MCODE_RUNTIME_DB: "/tmp/x.db",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_mcode_sid");
  });

  test("returns { ok: false, reason: 'not_mcode_sid' } for short sid", () => {
    // regex requires at least 16 hex chars
    const r = db.deleteMcodeSessionFromDb("mvs_abc", { MCODE_RUNTIME_DB: "/tmp/x.db" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_mcode_sid");
  });

  test("returns { ok: false, reason: 'not_mcode_sid' } for sid with non-hex chars", () => {
    // 'l' and 'u' are NOT in [a-f0-9] — must be rejected
    const r = db.deleteMcodeSessionFromDb(
      "mvs_full11112222333344445555666677778888",
      { MCODE_RUNTIME_DB: "/tmp/x.db" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_mcode_sid");
  });

  test("returns { ok: false, reason: 'mcode_db_not_found' } for non-existent db path", () => {
    const r = db.deleteMcodeSessionFromDb(VALID_SID, {
      MCODE_RUNTIME_DB: "C:\\nonexistent\\path\\that\\does\\not\\exist\\x.db",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mcode_db_not_found");
  });
});

describe("MCODE_SESSION_DELETE_TABLES", () => {
  test("is an array of expected mcode session tables", () => {
    assert.ok(Array.isArray(db.MCODE_SESSION_DELETE_TABLES));
    assert.ok(db.MCODE_SESSION_DELETE_TABLES.length >= 5);
    // Spot-check a few key tables
    assert.ok(db.MCODE_SESSION_DELETE_TABLES.includes("local_runtime_sessions"));
    assert.ok(db.MCODE_SESSION_DELETE_TABLES.includes("local_runtime_session_fts_keys"));
  });
});

describe("deleteMcodeSessionFromDb — happy path (real sqlite3)", () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webui-db-test-"));
    dbPath = join(tmpDir, "test.db");
    // Create a sqlite db with all expected tables. Use spawnSync since
    // we're on a system that has sqlite3 (REFACTORING.md §3.4).
    const createSql = `
      CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE local_runtime_sessions_fts (session_id TEXT);
      CREATE TABLE local_runtime_session_fts_keys (session_id TEXT);
      CREATE TABLE local_runtime_session_locks (session_id TEXT);
      CREATE TABLE local_runtime_session_projection_watermarks (session_id TEXT);
      CREATE TABLE local_runtime_session_asset_index_state (session_id TEXT);
      CREATE TABLE local_runtime_session_agent_state (session_id TEXT);
      CREATE TABLE local_runtime_workspace_indexing_sessions (session_id TEXT);
      CREATE TABLE local_runtime_session_assets (session_id TEXT);
    `;
    const r = spawnSync(SQLITE3_BIN, [dbPath, createSql], { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(
        `sqlite3 create failed: ${r.stderr}\n` +
          `Set SQLITE3_BIN env to a sqlite3 binary path`,
      );
    }
    // Insert a row in local_runtime_sessions for our sid
    const insertSql = `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`;
    const r2 = spawnSync(SQLITE3_BIN, [dbPath, insertSql], { encoding: "utf8" });
    if (r2.status !== 0) {
      throw new Error(`sqlite3 insert failed: ${r2.stderr}`);
    }
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("deletes the row from local_runtime_sessions and returns {ok:true, log}", () => {
    // Verify row exists before
    const before = spawnSync(
      SQLITE3_BIN,
      [dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`],
      { encoding: "utf8" },
    );
    assert.equal(before.stdout.trim(), "1", "row should exist before delete");

    // Delete via the function
    const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
    assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
    assert.ok(Array.isArray(r.log), "log should be an array");
    assert.ok(
      r.log.some((entry) => entry.startsWith("local_runtime_sessions:")),
      `log should mention local_runtime_sessions: ${r.log.join(",")}`,
    );

    // Verify row is gone
    const after = spawnSync(
      SQLITE3_BIN,
      [dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`],
      { encoding: "utf8" },
    );
    assert.equal(after.stdout.trim(), "0", "row should be gone after delete");
  });
});

describe("deleteMcodeSessionFromDb — table-missing case (does not throw)", () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webui-db-test2-"));
    dbPath = join(tmpDir, "test2.db");
    // Create a db with NO tables. The function should iterate through
    // MCODE_SESSION_DELETE_TABLES and try DELETE FROM each — all should
    // fail with "no such table" and be swallowed.
    const r = spawnSync(SQLITE3_BIN, [dbPath, "CREATE TABLE unrelated (x INT)"], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`sqlite3 create failed: ${r.stderr}`);
    }
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns {ok:true, log:[]} when no expected tables exist", () => {
    // Should not throw, should return ok with empty log (no rows changed)
    const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
    assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
    assert.ok(Array.isArray(r.log));
    // No row counts > 0 since tables don't exist → log is empty
    assert.equal(r.log.length, 0, `log should be empty, got: ${r.log.join(",")}`);
  });
});
