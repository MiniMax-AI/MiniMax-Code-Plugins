/**
 * The axis said the session was empty while two other answers said it was not.
 *
 * Five surfaces read a session's records. Four of them fall back to the session's own
 * `messages.jsonl` when the projection has no rows for it; the timeline did not. On a
 * session whose records were on disk and not indexed:
 *
 *   trajectory_get    source: jsonl, returned: 3
 *   trajectory_turns  source: jsonl, total: 1
 *   /api/timeline     points: 0, truncated: false
 *
 * `truncated: false` is the strongest claim this Plugin can make that a list is
 * complete. So the panel listed a reader a session's records and its turns from one
 * source while its axis said, confidently, that the session had no timed activity at
 * all — and nothing in the reply distinguished that from an idle session.
 *
 * The fallback draws input markers and no model bars, because a `messages.jsonl`
 * records no durations. That is honest and it is *also* a picture of a run where the
 * model never answered, which is why the reply now names its source and the panel says
 * what the missing bars mean.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createRequestHandler } from '../server/http.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-timeline-fallback-home';
const PORT = 4803;
const TOKEN = 'timeline-token';

const USERS = 2;
const ASSISTANTS = 2;

/** A session row and its `messages.jsonl`, with **no** indexed message rows. */
async function onDisk(t, { id = 'sess-art', indexed = 0 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-timeline-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id, title: 'Fresh', updatedAtMs: NOW });
  for (let i = 0; i < indexed; i += 1) {
    projection.row({
      sessionId: id, msgId: `p${i}`, role: i % 2 ? 'assistant' : 'user',
      turnId: 't1', createdAtMs: NOW + i, data: { msg_content: `indexed ${i}` },
    });
  }
  projection.close();
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '20', `10-00-00-000-${id}`);
  await mkdir(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < USERS; i += 1) {
    lines.push(JSON.stringify({
      message_id: `u${i}`, turn_id: 't1',
      // Inside `message`, which is where the runtime writes it — checked against 613
      // real artifact files, every one of which nests it. A top-level copy is a shape
      // the runtime never produces, and it makes a working read look broken.
      message: { role: 'user', timestamp: NOW + i * 1000, content: `asked ${i}` },
    }));
  }
  for (let i = 0; i < ASSISTANTS; i += 1) {
    lines.push(JSON.stringify({
      message_id: `a${i}`, turn_id: 't1',
      message: { role: 'assistant', timestamp: NOW + (USERS + i) * 1000, content: `answered ${i}` },
    }));
  }
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

async function timeline(store, id) {
  const res = {
    status: null, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
  const handler = createRequestHandler({
    store, homeDir: FIXTURE_HOME, getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
  });
  await handler({
    method: 'GET',
    url: `/api/timeline?id=${id}`,
    headers: { host: `127.0.0.1:${PORT}`, 'x-trajectory-token': TOKEN },
    socket: { localPort: PORT, remoteAddress: '127.0.0.1' },
  }, res);
  assert.equal(res.status, 200, `/api/timeline did not answer 200: ${res.body}`);
  return JSON.parse(res.body);
}

/* ---------------------------------------------------------- the defect itself -- */

test('the axis falls back to the artifact instead of reporting an empty session', async (t) => {
  const store = await onDisk(t);
  const axis = await timeline(store, 'sess-art');

  assert.equal(axis.points.length, USERS + ASSISTANTS,
    'the axis came back empty for a session whose records and turns were both listed');
  assert.equal(axis.source, 'jsonl', 'the reply does not say where its points came from');
});

test('the fallback points carry the times the file recorded', async (t) => {
  const store = await onDisk(t);
  const axis = await timeline(store, 'sess-art');

  // Without this the axis would be a row of unplaceable points, and the panel filters
  // `Number.isFinite(point.at)` — so it would render nothing and say nothing.
  assert.deepEqual(axis.points.map((point) => point.at),
    [NOW, NOW + 1000, NOW + 2000, NOW + 3000]);
  // The roles come from the file too, which is what makes a user turn draw at all.
  assert.deepEqual(axis.points.map((point) => point.role),
    ['user', 'user', 'assistant', 'assistant']);
});

test('a point from the artifact claims no duration it was never given', async (t) => {
  const store = await onDisk(t);
  const axis = await timeline(store, 'sess-art');

  // The tempting shortcut is to borrow a duration from somewhere so the bars have a
  // width. A `messages.jsonl` recorded none, and a bar with an invented width is a
  // measurement of nothing drawn to scale.
  for (const point of axis.points) {
    assert.equal(point.durationMs, null, 'a duration was invented for a record that had none');
    assert.equal(point.thinkingMs, null);
  }
});

/* ------------------------------------------------------------------ controls -- */

test('an indexed session keeps the projection and says so', async (t) => {
  const store = await onDisk(t, { indexed: 4 });
  const axis = await timeline(store, 'sess-art');

  // The fixture has to have both sources, or the fallback could answer this wrongly.
  assert.equal(axis.source, 'sqlite', 'the axis left the projection for an indexed session');
  assert.equal(axis.points.length, 4);
  assert.equal(axis.points.every((point) => typeof point.at === 'number'), true);
});

test('a session with nothing readable reports nothing, and still says where from', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-timeline-none-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-none', title: 'Nothing', updatedAtMs: NOW });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const axis = await timeline(store, 'sess-none');
  // Empty is the honest answer here, and `source` keeps it distinguishable from the
  // case above rather than leaving two different findings with one shape.
  assert.deepEqual(axis.points, []);
  assert.equal(axis.truncated, false);
  assert.equal(axis.source, 'sqlite');
});