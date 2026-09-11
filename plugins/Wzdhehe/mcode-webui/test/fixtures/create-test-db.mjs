#!/usr/bin/env node
// webui/test/fixtures/create-test-db.mjs
//
// One-shot script: creates a self-contained sqlite3 fixture DB with
// predictable `local_runtime_token_usage` rows for unit tests.
//
// Run:  node test/fixtures/create-test-db.mjs
// Produces: test/fixtures/test.sqlite (overwrites)
//
// The DB lives entirely in test/fixtures/ — it is committed to git so
// tests don't depend on the host having sqlite3 binary at runtime
// (well, we still need it to READ the DB, but the FIXTURE itself is
// just a file, no setup needed per test run).
//
// To regenerate after schema change: run this script and commit the
// new v2/sqlite/runtime-state.sqlite.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Layout mirrors MAVIS_DATA_DIR/v2/sqlite/runtime-state.sqlite so that
// setting process.env.MAVIS_DATA_DIR = test/fixtures makes
// MAVIS_DB_PATH resolve to this file with no symlink trickery.
const DB_DIR = resolve(HERE, 'v2', 'sqlite')
const DB = resolve(DB_DIR, 'runtime-state.sqlite')
const SQLITE3 = process.env.SQLITE3_BIN || 'sqlite3' // PATH default — see config.js#detectSqlite3Bin

// Recreate directory from scratch
import { mkdirSync, rmSync } from 'node:fs'
if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true })
mkdirSync(DB_DIR, { recursive: true })

function sql(sqlText) {
  return execFileSync(SQLITE3, [DB, sqlText], { encoding: 'utf8' })
}

// Schema mirrors mavis runtime-state.sqlite (the real one webui reads).
sql(`
  CREATE TABLE local_runtime_token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    framework_type TEXT,
    model TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0,
    ts INTEGER NOT NULL
  );
  CREATE INDEX idx_lrtu_session_ts ON local_runtime_token_usage(session_id, ts);
`)

// Three sessions for the SUT to look up:
//   SESSION_FULL — 3 rows, varied (tests happy path + per-turn fields)
//   SESSION_EMPTY — 0 rows (tests rows===0 → null)
//   SESSION_DIVZERO — 1 row, all zeros (tests cache hit rate = 0)
//
// mvsSessionId must match /mvs_[a-f0-9]{16,}/i. We use 32 hex chars ONLY
// (no letters outside [a-f] — 'l', 'u' etc. would break the regex).

const ts = 1000
sql(`
  INSERT INTO local_runtime_token_usage (session_id, framework_type, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, ts) VALUES
    ('mvs_feeddead0000000000000000000aaaa', 'pi-agent', 'test', 1000, 500, 200, 50, 100, ${ts + 1}),
    ('mvs_feeddead0000000000000000000aaaa', 'pi-agent', 'test', 2000, 1000, 1500, 100, 200, ${ts + 2}),
    ('mvs_feeddead0000000000000000000aaaa', 'pi-agent', 'test', 5000, 1000, 4000, 200, 500, ${ts + 3}),
    ('mvs_d0de0000000000000000000000abcdef', 'pi-agent', 'test', 0, 0, 0, 0, 0, ${ts + 10}),
    ('mvs_facefacefacefacefacefacefaceface', 'pi-agent', 'test', 100, 50, 80, 10, NULL, ${ts + 20});
`)

console.log('Fixture created at', DB)
console.log('  SESSION_FULL (3 rows, varied):          mvs_feeddead0000000000000000000aaaa')
console.log('  SESSION_DIVZERO (1 row, all zero):      mvs_d0de0000000000000000000000abcdef')
console.log('  SESSION_NULL_REASONING (1 row, NULL reasoning): mvs_facefacefacefacefacefacefaceface')
