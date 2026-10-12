/**
 * The panel had two routes describing the same session, and only one of them said.
 *
 * `/api/events` and `/api/overview` both publish a shape derived from the same message
 * rows. `/api/events` carries `recordsUnavailable`; `/api/overview`'s embedded `stats`
 * did not. Measured against a real machine, a session with a row and no records
 * anywhere came back from the overview as:
 *
 *   turns: 0, steps: 0, toolCalls: 0, events: 0        ← no flag
 *
 * while `/api/events` for that same session answered `recordsUnavailable: true`. The
 * panel happened to see a correct account only because it calls both routes — a reader
 * of either route alone did not, and the overview is the one that carries the totals the
 * header is drawn from.
 *
 * Two things make this worth pinning beyond "the field is there": the flag must be
 * computed by the *same* predicate the events route uses (a second, looser judgement is
 * how two surfaces come to disagree), and the panel must read it from the totals as well
 * as from the record page, so the notice survives a failed record page — which is
 * precisely when a reader most needs to be told the zeros mean "not found".
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_WORKSPACE, dropProjectionTable } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createRequestHandler } from '../server/http.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-overview-disclosure-home';
const PORT = 4813;
const TOKEN = 'overview-token';

async function storeWith(t, { rows = 0, changeSets = 0, dropChangeTable = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-overview-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Overview', updatedAtMs: NOW });
  for (let i = 0; i < changeSets; i += 1) {
    projection.turnDiff({
      sessionId: 'sess-a', turnId: `ct${i}`, workspaceDir: FIXTURE_WORKSPACE,
      capturedAtMs: NOW + i, files: [{ file: `a${i}.js`, additions: 1, deletions: 0, status: 'modified', diff: 'x' }],
    });
  }
  for (let i = 0; i < rows; i += 1) {
    projection.row({
      sessionId: 'sess-a', msgId: `m${i}`, role: i % 2 ? 'assistant' : 'user',
      turnId: 't1', createdAtMs: NOW + i, data: { msg_content: `record ${i}` },
    });
  }
  projection.close();
  // Opened *after* the drop: the table has to be gone before the store asks about it,
  // exactly as it is on a runtime that never had one. Dropping it under a live store
  // leaves the connection answering from whatever it already prepared.
  if (dropChangeTable) dropProjectionTable(dbPath, 'local_runtime_turn_diffs');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function apiGet(store, url) {
  const res = {
    status: null, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
  const handler = createRequestHandler({
    store, homeDir: FIXTURE_HOME, getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
  });
  await handler({
    method: 'GET', url,
    headers: { host: `127.0.0.1:${PORT}`, 'x-trajectory-token': TOKEN },
    socket: { localPort: PORT, remoteAddress: '127.0.0.1' },
  }, res);
  assert.equal(res.status, 200, `${url} did not answer 200: ${res.body}`);
  return JSON.parse(res.body);
}

test('the overview says so about the same session the event page does', async (t) => {
  const store = await storeWith(t);
  const overview = await apiGet(store, '/api/overview?id=sess-a');
  const events = await apiGet(store, '/api/events?id=sess-a&limit=10');

  // Both routes, one fact. The comparison is the assertion: two routes that agree are
  // the invariant, and checking either one alone would let the other drift.
  assert.equal(events.recordsUnavailable, true, 'the event page did not disclose it');
  assert.equal(overview.stats.recordsUnavailable, true,
    'the overview published the same zero-fold with nothing beside it');
  // And the totals are still the totals — the flag replaces no number.
  assert.equal(overview.stats.turns, 0);
  assert.equal(overview.stats.toolCalls, 0);
});

test('a session whose records are on disk is not reported as having none', async (t) => {
  // The counterweight to the case above, and the one that decides whether the route
  // consulted the artifact or simply concluded from the row count. A session with no
  // indexed rows whose `messages.jsonl` holds them has readable records; reporting
  // otherwise is the over-claiming failure, and it is the one that would train a reader
  // to ignore the flag.
  const store = await storeWith(t);
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(store.dataDir, 'v2', 'sessions', '2026', '09', '20', '10-00-00-000-sess-a');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'messages.jsonl'), `${JSON.stringify({
    message_id: 'm0', turn_id: 't1',
    message: { role: 'user', timestamp: NOW, content: 'on disk' },
  })}\n`, 'utf8');

  const overview = await apiGet(store, '/api/overview?id=sess-a');
  assert.equal(overview.stats.recordsUnavailable, undefined,
    'readable records on disk were reported as missing');
});

test('an indexed session raises no such notice on either route', async (t) => {
  const store = await storeWith(t, { rows: 4 });
  const overview = await apiGet(store, '/api/overview?id=sess-a');
  const events = await apiGet(store, '/api/events?id=sess-a&limit=10');

  // The control. A disclosure that fires for every session would satisfy the case above
  // while telling the reader nothing — and this is the shape that trains them to ignore it.
  assert.equal(overview.stats.turns, 1);
  assert.equal('recordsUnavailable' in overview.stats, false,
    `an ordinary session published ${JSON.stringify(overview.stats.recordsUnavailable)}`);
  assert.equal(events.recordsUnavailable, undefined);
});
test('the overview carries the file-change count the panel header draws', async (t) => {
  // This file exists because two routes once described one session and only one spoke.
  // The panel's tests run against a fixture payload, which proves the header *reads*
  // `changedTurns` — not that the route *sends* it. A field the panel draws and no
  // route publishes is the same failure one level up, and it is invisible to every
  // fixture-level test.
  const store = await storeWith(t, { changeSets: 3 });
  const body = await apiGet(store, '/api/overview?id=sess-a');
  assert.equal(body.stats.changedTurns, 3);
  assert.equal(body.stats.changesAvailable, true);
});

test('a runtime with no change-set table says so through the route, not by omission', async (t) => {
  const store = await storeWith(t, { dropChangeTable: true });
  const body = await apiGet(store, '/api/overview?id=sess-a');
  assert.ok('changedTurns' in body.stats, 'the field must be present even when it cannot be counted');
  assert.equal(body.stats.changedTurns, 0);
  assert.equal(body.stats.changesAvailable, false,
    'a missing table is not a count of zero — the header draws a number off this flag');
  assert.ok(body.stats.warnings.some((warning) => String(warning).includes('turn_diffs')),
    `the warning must name the table: ${JSON.stringify(body.stats.warnings)}`);
});
