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

test('corrupt artifact lines are surfaced, and an all-corrupt read is not an empty session', async () => {
  // The server now preserves `malformedLines` even when the artifact yielded no events,
  // and the panel has to render it. Before, the client read the SQLite field for this
  // and ignored the artifact one, so a fully corrupt file produced an empty stream with
  // no sign that anything had been lost.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [record(1, 0)], source: 'jsonl', total: null, malformedLines: 7 }) }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /7 行无法解析/u);
  assert.match(dom.text('data-notices'), /messages\.jsonl 回退/u);
});

test('a fallback read that returned nothing still says the artifact was damaged', async () => {
  // Zero events, and that is the point: the page is empty because every line failed to
  // parse, which is a different fact from "this session has no records".
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [], source: 'jsonl', total: null, malformedLines: 12 }) }
      : { body: eventPayload('B') }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /12 行无法解析/u);
  assert.match(dom.text('data-notices'), /messages\.jsonl 回退/u);
});

test('the notice survives a record page that carried nothing', async () => {
  // The record page is where the flag used to be read from alone. That works right up to
  // the moment the record page is the thing that went wrong — an empty page, or one that
  // failed — and then the notice vanishes while the totals above it still read as zero.
  // Both routes compute the same verdict, so the panel takes it from either.
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { stats: statsPayload(query.id, { turns: 0, steps: 0, events: 0, recordsUnavailable: true }) }),
    }),
    '/api/events': ({ query }) => ({ body: eventPayload(query.id, { events: [], source: 'sqlite', total: 0 }) }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /记录未找到/u);
});

test('an axis read from the artifact says why it has no bars', async () => {
  // Four points, all of them user inputs: an artifact records no durations, so the axis
  // draws markers and nothing else. That picture is the picture of a run where the model
  // never answered, and it sits directly above the same session's records.
  server = installServer(baseRoutes({
    '/api/timeline': () => ({ body: { points: [{ at: 1, role: 'user', injected: false }], source: 'jsonl', truncated: false } }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /时间轴读取自 messages\.jsonl/u);
  assert.match(dom.text('data-notices'), /不代表模型没有运行/u);
});

test('an axis from the projection raises no such notice', async () => {
  // The control. A line that fires for every axis would be noise, and "no bars" is the
  // normal appearance of a session that made no timed calls at all.
  server = installServer(baseRoutes({
    '/api/timeline': () => ({ body: { points: [{ at: 1, role: 'user', injected: false }], source: 'sqlite', truncated: false } }),
  }));

  await flow.selectSession('A');
  assert.doesNotMatch(dom.text('data-notices'), /时间轴读取自/u);
});

test('an axis read from the artifact does not leave it on the next session', async () => {
  // B's axis is held open on purpose. The next fetch overwrites the field anyway, so a
  // test that simply waits for B to load cannot tell a reset from an overwrite — and the
  // window between the switch and the answer is the one a reader actually sees.
  const held = deferred();
  server = installServer(baseRoutes({
    '/api/timeline': ({ query }) => (query.id === 'A'
      ? { body: { points: [], source: 'jsonl', truncated: false } }
      : held.promise),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /时间轴读取自/u);

  const openingB = flow.selectSession('B');
  await tick();
  assert.doesNotMatch(dom.text('data-notices'), /时间轴读取自/u,
    'the notice for the session just left is still on screen');
  held.resolve({ body: { points: [], source: 'sqlite', truncated: false } });
  await openingB;
});

test('a session with no records anywhere says so instead of reading as empty', async () => {
  // The emptiest session in the list is not the emptiest session on the machine. This
  // one has a row and no records behind it in either place a record could be, so every
  // number the panel draws over it is zero — correct, and read as an answer.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [], source: 'sqlite', total: 0, recordsUnavailable: true }) }
      : { body: eventPayload('B', { events: [record(1, 0)] }) }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /记录未找到/u);
  assert.match(dom.text('data-notices'), /不表示这次运行什么都没做/u);
});

test('an ordinary empty session raises no such notice', async () => {
  // The control. Without it the line above would pass on a session that merely has no
  // records, which is the opposite finding and the reason the field exists.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [], source: 'sqlite', total: 0 }) }
      : { body: eventPayload('B', { events: [record(1, 0)] }) }),
  }));

  await flow.selectSession('A');
  assert.doesNotMatch(dom.text('data-notices'), /记录未找到/u);
});

test('a session with no records does not leave it on the next one', async () => {
  // Unlike the corruption counters, this is not accumulated — but the reset is what
  // keeps that true, and a reset that missed it would tell the reader that every
  // session they open afterwards has lost its records.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [], source: 'sqlite', total: 0, recordsUnavailable: true }) }
      : { body: eventPayload('B', { events: [record(1, 0)] }) }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /记录未找到/u);
  await flow.selectSession('B');
  assert.doesNotMatch(dom.text('data-notices'), /记录未找到/u);
});

test('tasks the overview did not carry are surfaced', async () => {
  // `tasksOmitted` is measured against the session's real count, and the panel is the
  // only surface that can tell the reader the task list it is looking at is short.
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { tasksOmitted: 743, tasksTotal: 1243, tasksTruncated: true }),
    }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /743 个后台任务未随本页返回/u);
});

test('a complete task list raises no omission notice', async () => {
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { tasksOmitted: 0, tasksTotal: 12, tasksTruncated: false }),
    }),
  }));

  await flow.selectSession('A');
  assert.doesNotMatch(dom.text('data-notices'), /后台任务未随本页返回/u);
});

test('a damaged session does not leave its damage on the next one', async () => {
  // The corruption and omission counts accumulate across pages, so they are exactly the
  // kind of value that leaks into the following session if the reset misses one. A
  // reader who opened a damaged session and then a healthy one would be told the
  // healthy one is damaged too.
  server = installServer(baseRoutes({
    '/api/events': ({ query }) => (query.id === 'A'
      ? { body: eventPayload('A', { events: [record(1, 0)], source: 'jsonl', total: null, malformedLines: 9 }) }
      : { body: eventPayload('B', { events: [record(1, 0)] }) }),
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, query.id === 'A'
        ? { tasksOmitted: 500, tasksTotal: 900, tasksTruncated: true }
        : { tasksOmitted: 0, tasksTotal: 3, tasksTruncated: false }),
    }),
  }));

  await flow.selectSession('A');
  assert.match(dom.text('data-notices'), /9 行无法解析/u);

  await flow.selectSession('B');
  assert.doesNotMatch(dom.text('data-notices'), /9 行无法解析/u);
  assert.doesNotMatch(dom.text('data-notices'), /后台任务未随本页返回/u);
  assert.doesNotMatch(dom.text('data-notices'), /messages\.jsonl 回退/u);
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

/* ----------------------------------------------------- search reports itself -- */

/**
 * A capped search page is a subset, and the panel used to render it as the answer.
 *
 * It asked for `limit=100` with no cursor and no count, so a query matching 633 of a
 * machine's sessions came back as a hundred rows and the panel said nothing. Worse,
 * a query that matched *nothing* left the previous list on screen entirely — so
 * "no match" and "the search did not run" were the same picture, and neither said so.
 *
 * The route now carries `total` and honours `offset`; these are the panel-side halves
 * of that, driven through the same `wire.js` the browser loads.
 */
const searchRoutes = (search) => baseRoutes({ '/api/search': search });

/**
 * Type into the search box the way a person does.
 *
 * `wire()` reads `state.search`, not the element's value — the `input` listener is what
 * copies one into the other — so setting `.value` and pressing Enter would exercise a
 * handler that returns early on an empty query and pass for the wrong reason.
 */
async function type(query) {
  dom.el('search').value = query;
  await dom.el('search').dispatch('input');
  await dom.el('search').dispatch('keydown', { key: 'Enter' });
}

test('a search that matched nothing says so instead of leaving the old list up', async () => {
  server = installServer(searchRoutes(() => ({ body: { sessions: [], total: 0, searchFailed: false } })));
  wire();
  await flow.loadSessions();
  assert.equal(state.sessions.length, 2, 'the panel did not load before the search ran');

  await type('nothing-matches-this');

  assert.match(dom.text('banner'), /没有匹配/u);
  assert.equal(state.sessions.length, 2, 'a failed search must not clear the loaded list');
});

test('a truncated search says how many matched and how many are shown', async () => {
  server = installServer(searchRoutes(() => ({ body: { sessions: [sessionSummary('A')], total: 633, searchFailed: false } })));
  wire();
  await type('mavis');

  assert.match(dom.text('banner'), /633/u, 'the panel hid that 632 matches were not on screen');
  assert.match(dom.text('banner'), /1/u);
  assert.equal(state.sessions.length, 1, 'the results did not replace the list');
});

test('a search that fits on one page is not announced as truncated', async () => {
  // The control for the case above: a banner on every search would be noise, and the
  // point of `total` is that it lets the panel stay quiet when the page *is* the answer.
  server = installServer(searchRoutes(() => ({ body: { sessions: [sessionSummary('A')], total: 1, searchFailed: false } })));
  wire();
  await type('mavis');

  assert.doesNotMatch(dom.text('banner'), /1/u, 'a complete page drew a truncation notice');
});

test('a search that failed is reported as failed, not as no match', async () => {
  server = installServer(searchRoutes(() => ({ body: { sessions: [], total: 0, searchFailed: true } })));
  wire();
  await type('mavis');

  assert.match(dom.text('banner'), /搜索未能执行/u);
  // The failure text quotes the no-match wording on purpose — "this is not 没有匹配结果"
  // — so the two banners cannot be told apart by looking for a phrase. They differ in
  // which one *starts* with, which is what the reader actually sees first.
  assert.ok(
    !dom.text('banner').startsWith('没有匹配的会话'),
    `a failed search was reported as an absence: ${dom.text('banner')}`,
  );
});

test('a search request that throws is reported rather than swallowed', async () => {
  server = installServer(searchRoutes(() => { throw new Error('panel-search-boom'); }));
  wire();
  await type('mavis');

  assert.match(dom.text('banner'), /panel-search-boom/u);
});

/* ------------------------------------------- the sidebar admits it is a slice -- */

/**
 * The sidebar loaded 300 sessions and said nothing about the rest.
 *
 * `flow.loadSessions` asks for `limit=300` — on the machine this was measured on, 300
 * of 614, so more than half the history was simply absent from the screen with nothing
 * to say so. The search branch already discloses its own cap; the browsing page did not,
 * and "I can't find last month's session" reads the same either way.
 *
 * `total` comes from the route counting the same filter the page read, so a filtered
 * sidebar cannot mistake its filter for the cap.
 */
const listRoute = (total, rows) => baseRoutes({
  '/api/sessions': () => ({ body: { sessions: rows, total } }),
});

const loadSidebar = async (total, rows) => {
  server = installServer(listRoute(total, rows));
  await flow.loadSessions();
};

test('a capped session list says how much of the machine it left out', async () => {
  await loadSidebar(614, [sessionSummary('A'), sessionSummary('B')]);
  assert.equal(state.sessions.length, 2);
  assert.equal(dom.el('session-truncation').hidden, false, 'a two-row list over 614 sessions drew no notice');
  assert.match(dom.text('session-truncation'), /614/u);
  assert.match(dom.text('session-truncation'), /2/u);
});

test('a list that is the whole machine stays quiet', async () => {
  // The control for the case above: a notice on every load is noise, and the point of
  // carrying `total` is that the panel can tell the two apart.
  await loadSidebar(2, [sessionSummary('A'), sessionSummary('B')]);
  assert.equal(dom.el('session-truncation').hidden, true, 'a complete list still drew a truncation notice');
});

test('a route with no total says nothing rather than guessing', async () => {
  // An older server, or a route that forgot the field. Absent is not "truncated" —
  // claiming 2 of an unknown number would be inventing a measurement.
  await loadSidebar(undefined, [sessionSummary('A')]);
  assert.equal(dom.el('session-truncation').hidden, true, 'an absent total was read as a short list');
});

test('a search replaces the list and retires the sidebar notice', async () => {
  // The stale-notice case: after a search the sidebar holds search results, so the
  // "300 of 614" sentence is describing a list that is no longer on screen.
  server = installServer(baseRoutes({
    '/api/sessions': () => ({ body: { sessions: [sessionSummary('A')], total: 614 } }),
    '/api/search': () => ({ body: { sessions: [sessionSummary('B')], total: 1, searchFailed: false } }),
  }));
  wire();
  await flow.loadSessions();
  assert.equal(dom.el('session-truncation').hidden, false);

  await type('mavis');
  assert.equal(dom.el('session-truncation').hidden, true,
    'the browsing notice survived a search and now describes the wrong list');
});

/* ------------------------------------------ the panel answers the file question -- */

test('the statistics bar says how many turns changed files', async () => {
  // The bar answered fourteen session totals and said nothing about files, so the reader
  // who opened the panel to find out whether a run touched their repository had nothing
  // to read. This is the same fact `trajectory_summary` now publishes for a model; two
  // surfaces answering one question must not answer it differently.
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { stats: statsPayload(query.id, { changedTurns: 41, changesAvailable: true }) }),
    }),
  }));

  await flow.selectSession('A');

  const cards = [...dom.el('stats').querySelectorAll('.stat')]
    .map((node) => [node.querySelector('.k')?.textContent, node.querySelector('.v')?.textContent]);
  assert.deepEqual(cards.find(([key]) => key === '改动轮次'), ['改动轮次', '41']);
});

test('a runtime that records no change sets says so rather than showing zero', async () => {
  // A card reading `0` would say the session changed nothing. This runtime has not said
  // that — it has said nothing at all, which is the distinction `recordsUnavailable` was
  // written for on the MCP side and the same rule the bar already follows for TTFT.
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { stats: statsPayload(query.id, { changedTurns: 0, changesAvailable: false }) }),
    }),
  }));

  await flow.selectSession('A');

  const cards = [...dom.el('stats').querySelectorAll('.stat')];
  const card = cards.find((node) => node.querySelector('.k')?.textContent === '改动轮次');
  assert.equal(card.querySelector('.v').textContent, '未记录');
  assert.ok(card.classList.contains('is-na'),
    'an unavailable figure must look unavailable, like TTFT');
});

test('a payload that never published the capability shows no number either', async () => {
  // `changesAvailable` missing is not `false` — it is silence. The first version of this
  // test asked for no card at all, and the implementation answered with a card reading
  // `0`: it treated "the field is absent" as "the count is available". A number with no
  // source behind it is the claim this whole rule exists to prevent, so the rule is
  // narrower than it looks: **only an explicit `true` licenses a figure.**
  // One server, one flag: restoring the first stub to install a second left the panel
  // with no `fetch` at all for the control, which reads as a product failure rather than
  // a broken test.
  let silent = true;
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => {
      const stats = statsPayload(query.id, { changedTurns: 7 });
      if (silent) {
        delete stats.changedTurns;
        delete stats.changesAvailable;
      } else {
        stats.changesAvailable = true;
        stats.changedTurns = 0;
      }
      return { body: overviewPayload(query.id, { stats }) };
    },
  }));

  await flow.selectSession('A');

  const card = [...dom.el('stats').querySelectorAll('.stat')]
    .find((node) => node.querySelector('.k')?.textContent === '改动轮次');
  assert.ok(card, 'the card is still drawn — silence is reported, not hidden');
  assert.equal(card.querySelector('.v').textContent, '未记录');
  assert.ok(card.classList.contains('is-na'));

  // And the control: an explicit true with a zero is a real zero, and must say so.
  silent = false;
  await flow.selectSession('B');
  const zero = [...dom.el('stats').querySelectorAll('.stat')]
    .find((node) => node.querySelector('.k')?.textContent === '改动轮次');
  assert.equal(zero.querySelector('.v').textContent, '0',
    'a counted zero and an uncounted zero must not render the same');
  assert.ok(!zero.classList.contains('is-na'));
});

test('the file card does not call change sets "turns" when they are not the transcript ones', async () => {
  // The card's sub-line called `changedTurns` a turn count, and the runtime writes the
  // change-set table independently of the transcript: on a measured machine 307 of 1,417
  // change sets name a turn no message row carries, and on 7 of 351 sessions this count
  // is *larger* than the session's turn count. A card captioned "轮数" sitting beside a
  // `轮次` card that counts something else is the same contradiction the MCP surface now
  // publishes `unmatchedTurns` to defuse — put back where a reader cannot check it.
  const payloads = {
    A: { changedTurns: 165, changesAvailable: true, unmatchedTurns: 165 },
    B: { changedTurns: 12, changesAvailable: true, unmatchedTurns: 0 },
  };
  server = installServer(baseRoutes({
    '/api/overview': ({ query }) => ({
      body: overviewPayload(query.id, { stats: statsPayload(query.id, payloads[query.id]) }),
    }),
  }));

  const sub = async (id) => {
    await flow.selectSession(id);
    return [...dom.el('stats').querySelectorAll('.stat')]
      .find((node) => node.querySelector('.k')?.textContent === '改动轮次')
      ?.querySelector('.s')?.textContent ?? null;
  };

  const orphan = await sub('A');
  assert.match(orphan, /165/u,
    'the sub-line must carry the count it is qualifying');
  assert.match(orphan, /转录/u,
    `the sub-line must say these are not the transcript's turns: ${orphan}`);

  // The control. A caveat that appears on every card is one a reader stops reading, so
  // the honest session must read as plain. Matched on the caveat's own wording rather
  // than the word 转录, which the plain form legitimately uses too.
  const clean = await sub('B');
  assert.doesNotMatch(clean, /不在转录/u,
    `a session whose change sets all match must not be warned about: ${clean}`);
  assert.match(clean, /12|变更集/u);
});
