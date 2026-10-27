/**
 * A count of a session's assets was reachable; the assets themselves were not.
 *
 * `trajectory_summary` has always reported `assets: N`, and there was no way to ask
 * which N. On a machine with 50 asset-bearing sessions and a largest page of 112
 * rows, the entire list is one 2 ms query — the information was sitting in
 * `local_runtime_session_assets`, indexed, and the only route to it was paging a
 * thousand event records at a time looking for paths that were already columns.
 *
 * The tests here pin the parts that make the list usable rather than merely present:
 * the cursor, the honest distinction between "this session produced nothing" and
 * "this runtime cannot tell", and the nulls the real data is full of.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, FIXTURE_WORKSPACE, dropProjectionTable } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;
const COUNT = 12;

async function seeded(t, { count = COUNT, dropTable = false, nameOf = (i) => `file ${i}` } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assets-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.session({ id: 'sess-empty', title: 'Nothing produced', updatedAtMs: NOW - 10_000 });
  for (let i = 0; i < count; i += 1) {
    projection.asset({
      sessionId: 'sess-a',
      msgId: `m${i}`,
      // Ascending in time, so "oldest first" is a real order rather than insertion luck.
      createdAtMs: NOW - 10_000 + i * 100,
      assetIndex: i,
      path: `${FIXTURE_WORKSPACE}/out/file-${i}.png`,
      name: nameOf(i),
    });
  }
  projection.close();
  if (dropTable) dropProjectionTable(dbPath, 'local_runtime_session_assets');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { store, dbPath, dataDir };
}

const call = (store, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call('trajectory_assets', args);

test('the list answers which files, not only how many', async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a', limit: 3 });
  assert.equal(reply.available, true);
  assert.equal(reply.total, COUNT);
  assert.equal(reply.returned, 3);
  const [first] = reply.assets;
  // The count was already published; the content is the whole reason this tool exists,
  // so pin the fields a reader actually reads.
  assert.match(first.path, /out\/file-0\.png$/u);
  assert.equal(first.name, 'file 0');
  assert.equal(first.role, 'assistant');
  assert.equal(first.sourceTag, 'deliver-assets');
  assert.equal(first.msgId, 'm0');
  // Carried because it is not the same as the row's position: real data delivers one
  // `final.gif` three times, each as `assetIndex` 0 of its own message.
  assert.equal(first.assetIndex, 0);
  assert.equal(typeof first.createdAtMs, 'number');
});

test('paging walks every asset exactly once and then stops', async (t) => {
  const { store } = await seeded(t);
  const seen = [];
  let offset = 0;
  for (;;) {
    const reply = await call(store, { sessionId: 'sess-a', limit: 5, offset });
    seen.push(...reply.assets.map((asset) => asset.name));
    if (reply.nextOffset === null) break;
    assert.equal(reply.nextOffset, offset + reply.returned,
      'the cursor must name the first asset the caller did not receive');
    offset = reply.nextOffset;
  }
  assert.equal(seen.length, COUNT, `the walk delivered ${seen.length} of ${COUNT}`);
  assert.equal(new Set(seen).size, COUNT, 'the walk repeated an asset');
});

test('assets come back oldest first, the order they were produced', async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-a', limit: COUNT });
  const times = reply.assets.map((asset) => asset.createdAtMs);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the list is not in production order');
  assert.equal(reply.assets.at(-1).name, `file ${COUNT - 1}`);
});

test('a session that produced nothing is empty, available and unremarked', async (t) => {
  // The control for the two cases below. "None exist" genuinely deserves a bare empty
  // list, so the disclosure has to be specific to unreadability rather than to
  // emptiness — otherwise every ordinary session carries a scary note.
  const { store } = await seeded(t);
  const reply = await call(store, { sessionId: 'sess-empty' });
  assert.deepEqual(reply.assets, []);
  assert.equal(reply.total, 0);
  assert.equal(reply.nextOffset, null);
  assert.equal(reply.available, true);
  assert.equal(reply.note, undefined, 'a session with no assets is not a degraded read');
});

test('a runtime with no assets table says so instead of reporting none', async (t) => {
  const { store } = await seeded(t, { dropTable: true });
  const reply = await call(store, { sessionId: 'sess-a' });
  assert.deepEqual(reply.assets, [], 'the list is empty either way — that is what makes the note necessary');
  assert.equal(reply.available, false);
  assert.match(reply.note, /not listed|none exist/iu,
    'the note has to separate "cannot be listed" from "this session produced nothing"');
});

test('the summary count and the list agree', async (t) => {
  // Two code paths over one table. If they drift, "112 assets" and a 40-row list stop
  // describing the same session, and the reader has no way to tell which is right.
  const { store } = await seeded(t);
  const stats = store.getStats('sess-a');
  const reply = await call(store, { sessionId: 'sess-a', limit: COUNT });
  assert.equal(stats.assets, reply.total, 'the summary count and the list disagree');
});

test('a list over the byte budget reports what it dropped, and stays pageable', async (t) => {
  // Found by mutation tier C, and it is a **third** shape of uncovered mutation rather
  // than either of the two the corpus already documents. The tiers here are not equivalent
  // — `truncated: false` really is a lie once the bound binds — and they are not testing
  // nothing. They were reporting a pass for a condition **the fixture cannot reach**: the
  // MCP egress budget is 2 MiB, and a fixture of twelve assets with six-character names
  // serialises to a couple of kilobytes, so `bounded.truncated` was already `false` and
  // hardcoding it changed no assertion at all.
  //
  // So this is not a hole in what the tool does; it is a hole in what anything had ever
  // looked at. The budget needs an asset list big enough to cross it, and `name` is free
  // text typed by whoever produced the file, so a name of the per-string maximum is
  // ordinary rather than contrived.
  const CHUNK = 'n'.repeat(20_000);
  const MANY = 120;
  const { store } = await seeded(t, { count: MANY, nameOf: () => CHUNK });
  const reply = await call(store, { sessionId: 'sess-a', limit: MANY });

  assert.equal(reply.truncated, true, 'a list that dropped rows did not say so');
  assert.ok(reply.omitted > 0, 'the rows that were dropped were not counted');
  assert.equal(
    reply.assets.length + reply.omitted,
    MANY,
    'delivered plus omitted must account for the whole page',
  );
  // A list that dropped rows and reported `nextOffset: null` would be the worst of both:
  // honest about the cut and dishonest about how to reach the rest.
  assert.equal(
    typeof reply.nextOffset,
    'number',
    'a page that dropped rows must still publish a way to ask for the rest',
  );
  assert.ok(reply.nextOffset > 0 && reply.nextOffset < MANY, `unexpected cursor: ${reply.nextOffset}`);
});

test('null columns stay null rather than becoming a placeholder', async (t) => {
  // `asset_type` is null for 571 of 746 rows on a real machine. A tool that turned
  // that into `''` or a guessed extension would teach every caller to read a type
  // that is not there.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assets-null-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.asset({ sessionId: 'sess-a', path: `${FIXTURE_WORKSPACE}/out/thing`, name: null, assetType: null });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const [asset] = (await call(store, { sessionId: 'sess-a' })).assets;
  assert.equal(asset.name, null, 'a missing display name was invented');
  assert.equal(asset.assetType, null, 'a missing asset type was invented');
});

test('a path folds to `~` and keeps the part that names the file', async (t) => {
  const { store } = await seeded(t);
  const [asset] = (await call(store, { sessionId: 'sess-a', limit: 1 })).assets;
  assert.ok(!asset.path.startsWith('/'), `the path left the machine verbatim: ${asset.path}`);
  assert.match(asset.path, /^~/u);
  assert.match(asset.path, /out\/file-0\.png$/u, 'folding destroyed the identifying part of the path');
});

test('a credential in a free-text name is redacted before it leaves', async (t) => {
  // The regression that wrote this tool's redaction. `path` folded correctly while
  // `name` shipped `api_key=…` verbatim, because the row was being mapped field by
  // field and the sweep only covered the one field that happened to be a path.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'assets-canary-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Alpha', updatedAtMs: NOW });
  projection.asset({
    sessionId: 'sess-a',
    path: `${FIXTURE_WORKSPACE}/out/report.pdf`,
    name: 'report for api_key=ASSET-CANARY-4f7b',
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const [asset] = (await call(store, { sessionId: 'sess-a' })).assets;
  assert.equal(asset.name.includes('ASSET-CANARY-4f7b'), false, 'the credential in the asset name leaked');
  assert.match(asset.name, /report for/iu, 'redaction removed the whole name rather than the credential');
});

test('omitting the session id uses the most recently updated one', async (t) => {
  const { store } = await seeded(t);
  const reply = await call(store, {});
  assert.equal(reply.sessionId, 'sess-a');
  assert.equal(reply.total, COUNT);
});

test('an unknown session is an error, not an empty list', async (t) => {
  // A typo'd id and a session with no assets are different answers. The assets table
  // is keyed by session id and would return nothing for both.
  const { store } = await seeded(t);
  await assert.rejects(
    () => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] }).call('trajectory_assets', { sessionId: 'no-such-session' }),
    /session_not_found/iu,
  );
});