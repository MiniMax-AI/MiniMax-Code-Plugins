import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import {
  deferred,
  eventPayload,
  installPanelDom,
  installServer,
  overviewPayload,
  sessionSummary,
  snapshotState,
  statsPayload,
  tick,
} from './panel-dom.mjs';

/**
 * The browser half of the panel, executed.
 *
 * Everything here drives the real `web/js/` modules — the same files the browser
 * loads, through the same `fetch` seam `api.js` already uses. Nothing is mocked
 * below the network: a scenario decides what the server answers, and the panel
 * decides what that means.
 *
 * The six race fixes this covers were verified by reverting each one in a scratch
 * copy and watching the matching test fail; the names below say which test catches
 * which revert, because a guard whose only evidence is "the panel seemed right" is
 * the kind that comes back one refactor later.
 */

const WEB = new URL('../web/js/', import.meta.url);
const { state } = await import(new URL('state.js', WEB));
const flow = await import(new URL('flow.js', WEB));
const { wire } = await import(new URL('wire.js', WEB));

let dom;
let server;
let restoreState;

beforeEach(() => {
  dom = installPanelDom();
  restoreState = snapshotState(state);
});

afterEach(() => {
  server?.restore();
  restoreState();
  dom.restore();
});

/** The three requests every overview makes, answered the boring way. */
function baseRoutes(overrides = {}) {
  return {
    '/api/sessions': () => ({ body: { sessions: [sessionSummary('A'), sessionSummary('B')] } }),
    '/api/timeline': () => ({ body: { points: [], truncated: false } }),
    '/api/overview': ({ query }) => ({ body: overviewPayload(query.id) }),
    '/api/events': ({ query }) => ({ body: eventPayload(query.id) }),
    ...overrides,
  };
}

const record = (rowId, index) => ({
  rowId, index, role: 'user', inputKind: 'human', content: `row ${rowId}`, turnId: 'turn-1',
});

/* -------------------------------------------------- 1. the selection epoch -- */

test('a response for the session the reader left does not repaint the screen', async () => {
  // Reverting fix 1 — dropping `if (epoch !== selectionEpoch) return` — makes the
  // first selection's late overview overwrite the second one's title and session id.
  const first = deferred();
  const second = deferred();
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => (query.id === 'A' ? first.promise : second.promise),
  }));

  const openingA = flow.selectSession('A');
  const openingB = flow.selectSession('B');

  second.resolve({ body: overviewPayload('B') });
  await tick();
  first.resolve({ body: overviewPayload('A') });
  await tick();
  await Promise.all([openingA, openingB]);

  assert.equal(state.sessionId, 'B');
  assert.equal(dom.text('session-title'), 'session B');
});

test('a page that lands after the reader clicked elsewhere is discarded', async () => {
  // Reverting fix 1 — dropping the page token / epoch check and the signal that makes
  // the request cancellable — lets a page fetched for the session just left append
  // its records to the session being opened.
  const superseded = deferred();
  const openingB = deferred();
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => (query.id === 'A' ? { body: overviewPayload('A') } : openingB.promise),
    '/api/events': ({ query }) => (query.id === 'A'
      ? superseded.promise
      : { body: eventPayload('B', { events: [record(100, 0)], total: 1 }) }),
  }));

  flow.selectSession('A');
  await tick();
  const selectingB = flow.selectSession('B');
  await tick();

  // Session A's page answers late: after the click, before B's own first page.
  superseded.resolve({ body: eventPayload('A', { events: [record(1, 0)], total: 1 }) });
  await tick();
  assert.deepEqual(state.events.map((event) => event.rowId), [],
    "the abandoned session's records were applied to the screen");

  openingB.resolve({ body: overviewPayload('B') });
  await selectingB;
  assert.deepEqual(state.events.map((event) => event.rowId), [100]);
});

/* ------------------------------------------ 2. last click wins the first page -- */

test('the session clicked last cancels the abandoned page and loads its own', async () => {
  // Reverting fix 2 — not abandoning the in-flight page on a new selection — leaves
  // the reader's superseded request running against a screen that has moved on, and
  // its slot busy until the next reset happens to release it. The epoch guard would
  // still ignore the answer; the point is that the request should not still be out.
  const abandoned = deferred();
  const openingB = deferred();
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => (query.id === 'A' ? { body: overviewPayload('A') } : openingB.promise),
    '/api/events': ({ query }) => (query.id === 'A'
      ? abandoned.promise
      : { body: eventPayload('B', { events: [record(100, 0)], total: 1 }) }),
  }));

  flow.selectSession('A');
  await tick();
  const pageA = server.calls.find((call) => call.pathname === '/api/events' && call.query.id === 'A');
  assert.ok(pageA, "session A never asked for a page of records");

  // Not awaited: B is parked on its own overview, which is the window in which the
  // superseded request has to have been cancelled by the click rather than by the
  // reset that follows it.
  const selectingB = flow.selectSession('B');
  await tick();
  assert.equal(pageA.signal?.aborted, true, 'the superseded page was left running');

  openingB.resolve({ body: overviewPayload('B') });
  await selectingB;

  assert.equal(state.sessionId, 'B');
  assert.deepEqual(state.events.map((event) => event.rowId), [100]);
});

/* ------------------------------------------------- 3. reset abandons first -- */

test('a reset abandons the superseded page instead of letting it apply', async () => {
  // Reverting fix 3 — abandoning only *after* the "a page is already loading" guard —
  // makes the reset a no-op, so the superseded page then paints a session that no
  // longer exists.
  const superseded = deferred();
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? superseded.promise
      : { body: eventPayload('B', { events: [record(100, 0)], total: 1 }) }),
  }));

  state.sessionId = 'A';
  const inFlight = flow.loadEvents();
  await tick();
  assert.equal(state.loadingEvents, true);

  state.sessionId = 'B';
  await flow.loadEvents({ reset: true });

  superseded.resolve({ body: eventPayload('A', { events: [record(1, 0)], total: 1 }) });
  await tick();
  await inFlight;

  assert.deepEqual(state.events.map((event) => event.rowId), [100]);
});

/* ----------------------------------------------- 4. a failed "load more" page -- */

test('a page that fails mid-scroll is reported instead of rejected into the void', async () => {
  // Reverting fix 4 — removing the catch around the scroll handler's `loadEvents` —
  // turns this into an unhandled rejection and leaves the stream silently stopped.
  server = installServer(baseRoutes({
    '/api/events': () => ({ status: 500, body: { error: 'read_failed' } }),
  }));
  wire();

  state.sessionId = 'A';
  state.nextOffset = 0;
  state.filteredRows = [];
  state.renderedRows = 0;
  const host = dom.el('stream');
  host.scrollTop = 5000;
  host.clientHeight = 100;
  host.scrollHeight = 1000;

  await host.dispatch('scroll');

  assert.match(dom.text('banner'), /加载更多记录失败/u);
  assert.match(dom.text('banner'), /read_failed/u);
  assert.equal(state.loadingMore, false);
});

/* ------------------------------------------- 5. the sidebar rolls back on fail -- */

test('a session whose overview fails puts the selection back on the loaded session', async () => {
  // Reverting fix 5 — dropping the rollback in `selectSession`'s catch — leaves the
  // header naming session B while every record on screen is session A's.
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => (query.id === 'B'
      ? { status: 500, body: { error: 'session_not_found' } }
      : { body: overviewPayload('A') }),
  }));

  await flow.selectSession('A');
  assert.equal(state.sessionId, 'A');

  await assert.rejects(() => flow.selectSession('B'), /session_not_found/u);

  assert.equal(state.sessionId, 'A');
  assert.equal(dom.text('session-title'), 'session A');
  assert.deepEqual(state.events.map((event) => event.rowId), [1]);
});

/* ------------------------------------------------------- 6. the page dedupe -- */

test('a record already held is not taken from a second page', async () => {
  // This one also pins the page token. Reverting only the token/epoch check, and
  // leaving the AbortSignal in place, fails here and nowhere else: the other race
  // tests supersede a page whose request is still in flight, so the abort alone
  // catches them and the check looks redundant until this one goes.
  // Reverting fix 6 — dropping the `eventKeys` check — renders row 2 twice, which is
  // a line the reader cannot account for in a session transcript.
  const pages = [
    { body: eventPayload('A', { events: [record(1, 0), record(2, 1)], total: 3, nextOffset: 2 }) },
    { body: eventPayload('A', { events: [record(2, 1), record(3, 2)], total: 3, nextOffset: null }) },
  ];
  server = installServer(baseRoutes({
    '/api/events': ({ offset }) => pages[offset === 0 ? 0 : 1],
  }));

  state.sessionId = 'A';
  await flow.loadEvents();
  await flow.loadEvents();

  assert.deepEqual(state.events.map((event) => event.rowId), [1, 2, 3]);
  assert.equal(state.nextOffset, null);
});

/* ================================================= what the panel discloses == */

test('a partially loaded session never presents its page as the whole session', async () => {
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [record(1, 0)], total: 20, nextOffset: 1 }) }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  assert.equal(dom.text('record-count'), '已加载 1 / 20 行');
  assert.match(dom.text('data-notices'), /已加载 1 \/ 20 条记录/u);
  assert.equal(dom.el('data-notices').hidden, false);
});

test('a fully loaded session is reported as a count, not as a partial one', async () => {
  server = installServer(baseRoutes({
    '/api/events': () => ({ body: eventPayload('A', { events: [record(1, 0)], total: 1 }) }),
  }));

  await flow.selectSession('A');

  assert.equal(dom.text('record-count'), '1 行');
  assert.doesNotMatch(dom.text('data-notices'), /已加载/u);
  assert.equal(dom.el('data-notices').hidden, true);
});

test('a timeline cut at the cap says the axis is not the whole session', async () => {
  server = installServer(baseRoutes({
    '/api/timeline': () => ({ body: { points: [{ rowId: 1, at: 1, role: 'user' }], truncated: true } }),
  }));

  await flow.selectSession('A');

  assert.match(dom.text('data-notices'), /时间轴已按点数上限裁剪/u);
});

test('a timeline that fails is an error notice, not an empty axis', async () => {
  server = installServer(baseRoutes({
    '/api/timeline': () => ({ status: 500, body: { error: 'timeline_failed' } }),
  }));

  await flow.selectSession('A');

  assert.match(dom.text('data-notices'), /时间轴加载失败：timeline_failed/u);
  assert.match(dom.text('data-notices'), /不代表该会话没有活动/u);
});

test('an intact timeline raises no notice at all', async () => {
  server = installServer(baseRoutes());
  await flow.selectSession('A');
  assert.equal(dom.el('data-notices').hidden, true);
});

test('a page cut by the response budget says how much of it was dropped', async () => {
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? {
        body: eventPayload('A', {
          events: [record(1, 0)], total: 20, nextOffset: 1, truncated: true, omitted: 7,
        }),
      }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  const notices = dom.text('data-notices');
  assert.match(notices, /7 条记录因单次响应体积上限未随本页返回/u);
  assert.match(notices, /不是整个会话/u);
});

test('a page stopped early by the byte budget is reported as its own cut', async () => {
  // `truncated: true, omitted: 0` describes a page that returned *less* than it read,
  // which is the contradiction `pageBytesTruncated` exists to resolve.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? {
        body: eventPayload('A', {
          events: [record(1, 0)], total: 20, nextOffset: 1, truncated: true, omitted: 0, pageBytesTruncated: true,
        }),
      }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  const notices = dom.text('data-notices');
  assert.match(notices, /本页因响应体积上限提前停止读取/u);
  assert.doesNotMatch(notices, /记录列表按响应体积上限被裁剪/u);
});

test('oversized JSONL lines keep their banner and gain a standing notice', async () => {
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [record(1, 0)], source: 'jsonl', total: null, droppedOversized: 3 }) }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  assert.match(dom.text('banner'), /3 行超过单行上限，已丢弃/u);
  assert.match(dom.text('data-notices'), /3 行超过单行上限，已丢弃/u);
  assert.match(dom.text('data-notices'), /已回退到 messages\.jsonl/u);
});

test('a session with no server count is never rendered as if it had one', async () => {
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? {
        body: eventPayload('A', {
          events: [record(1, 0), record(2, 1)], source: 'jsonl', total: null, nextOffset: 2,
        }),
      }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  assert.equal(dom.text('record-count'), '已加载 2 行（总数未知）');
  assert.match(dom.text('data-notices'), /服务端未给出该会话的记录总数/u);
});

test('rows the statistics fold could not read are surfaced', async () => {
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { stats: statsPayload(query.id, { unreadableRows: 4 }) }),
    }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /4 行记录不是合法 JSON，已从上述统计中排除/u);

  const without = installPanelDom();
  try {
    const clean = installServer(baseRoutes());
    await flow.selectSession('A');
    assert.doesNotMatch(without.text('data-notices'), /不是合法 JSON/u);
    clean.restore();
  } finally {
    without.restore();
  }
});

test('a record read that failed outright is surfaced with the server\'s reason', async () => {
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [], source: 'error', error: 'event_read_failed', total: null, nextOffset: null }) }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');

  assert.match(dom.text('data-notices'), /记录读取失败：event_read_failed/u);
});

/* ------------------------------------------------------ the panel still loads -- */

test('the modules import and drive without a browser present', async () => {
  // A smoke check on the harness itself: if the stub stopped covering what the
  // client does, the tests above would fail for the wrong reason and this is the
  // cheapest place to notice that the surface has moved.
  server = installServer(baseRoutes());
  await flow.loadSessions();
  assert.equal(state.sessions.length, 2);
  await flow.selectSession('A');
  assert.equal(state.turns.size, 0);
  assert.match(dom.text('stream'), /已显示全部 1 行/u);
  assert.match(dom.text('stream'), /hi/u);
});
