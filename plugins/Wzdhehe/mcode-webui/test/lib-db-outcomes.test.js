// webui/test/lib-db-outcomes.test.js
// PR#55 review pt 4 regression tests — deleteMcodeSessionFromDb must
// NEVER report success after an arbitrary SQL/IO error. Pinned contract:
//
//   ok:true  + outcome:"deleted"          rows were removed
//   ok:true  + outcome:"already_absent"   tx committed, nothing matched
//                                         (tables absent OR zero rows)
//   ok:false + reason:"unsupported_schema" table exists without the
//                                         session_id key column (rolled back)
//   ok:false + reason:"db_error"          lock / prepare / run / IO
//                                         failure (rolled back)
//
// Fixture strategy mirrors test/lib-db.test.js (real sqlite3 CLI builds
// the fixture db; the real mcode-bundled better-sqlite3 loads through
// db.js's own resolver), gated on the same honest environment
// preconditions so the suites skip — never fail — on hosts without
// either piece (e.g. windows CI runners).
//
// Audit hygiene: MCODE_WEBUI_EVENTS_PATH is redirected to a temp file
// so these tests never append to the real ~/.mcode-webui/events.ndjson
// (node --test runs each file in its own process, so the module-scope
// env set below cannot leak into other test files).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const absPath = (rel) =>
  pathToFileURL(join(import.meta.dirname, "..", "server", rel)).href;

const SQLITE3_BIN = process.env.SQLITE3_BIN || "sqlite3";

const db = await import(absPath("lib/db.js"));

// Same gating as lib-db.test.js: (a) a working sqlite3 CLI to build
// fixtures, (b) a CONSTRUCTIBLE better-sqlite3 through db.js's resolver
// (a bare module require is a false positive — the native binding loads
// lazily, so we probe a real Database construction).
const SQLITE3_CLI_OK = (() => {
  try {
    const r = spawnSync(SQLITE3_BIN, ["--version"], {
      stdio: "ignore",
      timeout: 2000,
      windowsHide: true,
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
})();
const BETTER_SQLITE3_OK = (() => {
  const Mod = db.getMcodeBetterSqlite3();
  if (!Mod) return false;
  try {
    const probe = new Mod(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();
const DB_FIXTURE_SKIP = !SQLITE3_CLI_OK
  ? "skipped: sqlite3 CLI not available on this runner"
  : BETTER_SQLITE3_OK
    ? false
    : "skipped: no loadable better-sqlite3 (mcode not installed / ABI mismatch on this runner)";

const VALID_SID = "mvs_deadbeef00000000000000000000aaaa";
const OTHER_SID = "mvs_0000000000000000000000000000bb00";

// Redirect the audit stream BEFORE any delete call can append to it.
const EVENTS_TMP = join(tmpdir(), `webui-db-outcomes-events-${process.pid}.ndjson`);
writeFileSync(EVENTS_TMP, "");
process.env.MCODE_WEBUI_EVENTS_PATH = EVENTS_TMP;

// Helper: run SQL against a fixture db via the sqlite3 CLI; throws with
// stderr if the fixture build fails (a broken fixture must fail the
// suite loudly, not silently pass).
const sql = (dbPath, stmt) => {
  const r = spawnSync(SQLITE3_BIN, [dbPath, stmt], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}\nSQL: ${stmt}`);
  return r.stdout.trim();
};

// Helper: parse the redirected events file into {kind} records.
const readEvents = () =>
  readFileSync(EVENTS_TMP, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

// Two tables are enough to pin the semantics; the rest of the delete
// list exercises the confirmed-missing-table skip path.
const SESSIONS_DDL = `
  CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, data TEXT);
`;

describe("deleteMcodeSessionFromDb — outcome: deleted (real delete)", { skip: DB_FIXTURE_SKIP }, () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webui-db-out-del-"));
    dbPath = join(tmpDir, "del.db");
    sql(dbPath, SESSIONS_DDL);
    sql(
      dbPath,
      `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`,
    );
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns {ok:true, outcome:'deleted'} and the row is gone", () => {
    assert.equal(
      sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
      "1",
      "row should exist before delete",
    );
    const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
    assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
    assert.equal(r.outcome, "deleted");
    assert.ok(Array.isArray(r.log) && r.log.length > 0, "log should be non-empty");
    assert.ok(
      r.log.some((e) => e.startsWith("local_runtime_sessions:")),
      `log should mention local_runtime_sessions: ${r.log.join(",")}`,
    );
    assert.ok(r.totalRowsDeleted >= 1, "totalRowsDeleted should be >= 1");
    assert.equal(
      typeof r.tablesAbsent,
      "number",
      "tablesAbsent (confirmed missing tables) should be reported",
    );
    assert.equal(
      sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
      "0",
      "row should be gone after delete",
    );
    // Audit parity: the outcome event carries the explicit outcome.
    const outcomeEv = readEvents().filter((e) => e.kind === "session.delete").pop();
    assert.ok(outcomeEv, "session.delete outcome event should be audited");
    assert.equal(outcomeEv.data.outcome, "deleted");
  });
});

describe("deleteMcodeSessionFromDb — outcome: already_absent", { skip: DB_FIXTURE_SKIP }, () => {
  test("all delete-list tables missing → ok:true, outcome:'already_absent', full tablesAbsent count", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webui-db-out-absent-"));
    try {
      const dbPath = join(tmpDir, "absent.db");
      sql(dbPath, "CREATE TABLE unrelated (x INT)");
      const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
      assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
      assert.equal(r.outcome, "already_absent");
      assert.ok(Array.isArray(r.log) && r.log.length === 0, "log should be empty");
      assert.equal(r.totalRowsDeleted, 0);
      assert.equal(
        r.tablesAbsent,
        db.MCODE_SESSION_DELETE_TABLES.length,
        "every delete-list table should be counted as confirmed absent",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("tables present but zero rows for sid → ok:true, outcome:'already_absent', other rows untouched", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webui-db-out-zero-"));
    try {
      const dbPath = join(tmpDir, "zero.db");
      sql(dbPath, SESSIONS_DDL);
      sql(
        dbPath,
        `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${OTHER_SID}', 'keep-me')`,
      );
      const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
      assert.equal(r.ok, true, `expected ok=true, got: ${JSON.stringify(r)}`);
      assert.equal(r.outcome, "already_absent");
      assert.equal(r.totalRowsDeleted, 0);
      assert.equal(
        r.tablesAbsent,
        db.MCODE_SESSION_DELETE_TABLES.length - 1,
        "only the one existing table is present — the rest count absent",
      );
      assert.equal(
        sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${OTHER_SID}'`),
        "1",
        "other session's row must survive",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("deleteMcodeSessionFromDb — unsupported schema aborts + rolls back (no fake success)", { skip: DB_FIXTURE_SKIP }, () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "webui-db-out-schema-"));
    dbPath = join(tmpDir, "schema.db");
    // local_runtime_sessions is FIRST in the delete list and holds the
    // row; local_runtime_messages (later in the list) exists WITHOUT a
    // session_id column → the tx must abort AFTER the first delete and
    // roll it back.
    sql(dbPath, SESSIONS_DDL);
    sql(
      dbPath,
      `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`,
    );
    sql(dbPath, "CREATE TABLE local_runtime_messages (id INTEGER PRIMARY KEY, body TEXT)");
  });

  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("keyless table → {ok:false, reason:'unsupported_schema'} AND the earlier delete is rolled back", () => {
    const eventsBefore = readEvents().length;
    const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
    assert.equal(r.ok, false, `keyless table must NOT report success: ${JSON.stringify(r)}`);
    assert.equal(r.reason, "unsupported_schema");
    assert.equal(r.table, "local_runtime_messages");
    assert.match(r.error, /session_id/);
    // Rollback proof: the row deleted earlier inside the tx survives.
    assert.equal(
      sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
      "1",
      "row deleted before the schema failure must be ROLLED BACK",
    );
    // No outcome audit event for a rolled-back delete (intent only).
    const newEvents = readEvents().slice(eventsBefore);
    assert.deepEqual(
      newEvents.map((e) => e.kind),
      ["session.delete.intent"],
      "a rolled-back delete must not emit a session.delete outcome event",
    );
  });

  test("dry-run preview surfaces the same failure instead of undercounting", () => {
    const r = db.deleteMcodeSessionFromDb(VALID_SID, {
      MCODE_RUNTIME_DB: dbPath,
      dryRun: true,
    });
    assert.equal(r.ok, false, `preview must not fake success either: ${JSON.stringify(r)}`);
    assert.match(r.error, /session_id/);
  });
});

describe("deleteMcodeSessionFromDb — lock conflict aborts (no fake success)", { skip: DB_FIXTURE_SKIP }, () => {
  test("SQLITE_BUSY from a concurrent writer → {ok:false, reason:'db_error'}, row survives, then clean retry succeeds", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "webui-db-out-lock-"));
    const Mod = db.getMcodeBetterSqlite3();
    let blocker;
    try {
      const dbPath = join(tmpDir, "lock.db");
      sql(dbPath, SESSIONS_DDL);
      sql(
        dbPath,
        `INSERT INTO local_runtime_sessions (session_id, data) VALUES ('${VALID_SID}', 'fake-data')`,
      );
      // Hold the write lock from a second connection for the whole
      // delete attempt (busy_timeout in db.js waits 5s, then fails).
      blocker = new Mod(dbPath);
      blocker.exec("BEGIN IMMEDIATE");
      blocker
        .prepare("INSERT INTO local_runtime_sessions (session_id, data) VALUES (?, 'blocker')")
        .run(OTHER_SID);

      const t0 = Date.now();
      const r = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
      const waitedMs = Date.now() - t0;
      assert.equal(r.ok, false, `lock conflict must NOT report success: ${JSON.stringify(r)}`);
      assert.equal(r.reason, "db_error");
      assert.match(String(r.code || ""), /SQLITE_BUSY|SQLITE_LOCKED/, `code: ${r.code}`);
      assert.ok(waitedMs >= 4000, `should have honored busy_timeout (waited ${waitedMs}ms)`);
      assert.equal(
        sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
        "1",
        "row must survive the failed delete",
      );

      // Release and verify a clean retry succeeds — the failed attempt
      // must leave no open transaction or poisoned state behind.
      blocker.exec("ROLLBACK");
      blocker.close();
      blocker = null;
      const retry = db.deleteMcodeSessionFromDb(VALID_SID, { MCODE_RUNTIME_DB: dbPath });
      assert.equal(retry.ok, true, `retry after lock release should succeed: ${JSON.stringify(retry)}`);
      assert.equal(retry.outcome, "deleted");
      assert.equal(
        sql(dbPath, `SELECT COUNT(*) FROM local_runtime_sessions WHERE session_id='${VALID_SID}'`),
        "0",
        "row should be gone after the clean retry",
      );
    } finally {
      if (blocker)
        try {
          blocker.close();
        } catch {}
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
