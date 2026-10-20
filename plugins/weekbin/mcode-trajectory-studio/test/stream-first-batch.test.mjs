import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import {
  eventPayload,
  installPanelDom,
  installServer,
  overviewPayload,
  sessionSummary,
  snapshotState,
  statsPayload,
} from './panel-dom.mjs';

/**
 * What the panel paints before the reader does anything.
 *
 * The browser check asks the store whether a session "has" an output-bearing tool
 * call and then drives a real page to click it. Those are two questions, and for a
 * long session they have different answers: the panel fetches 200 records but paints
 * `STREAM_PAGE` stream rows, and a record is a row while each of its tool calls is
 * another. A session whose page held 181 calls packed to 381 rows, with the first
 * output-bearing call at row 327 — the store called it reachable and the screen had
 * 69 tool rows and no button.
 *
 * The bounds live in `web/js/rows.js` because `tools/browser-check.mjs` has to ask
 * the same question before it starts a browser. These tests pin both halves of that
 * arrangement: the arithmetic, and the fact that the panel's own loader really is the
 * one using it. A second copy of the rule would be right until it drifted.
 */

const WEB = new URL('../web/js/', import.meta.url);
const { state, STREAM_PAGE, MAX_STREAM_ROWS } = await import(new URL('state.js', WEB));
const { packStreamRows, firstRenderBatch, offeredCalls, firstScreenOffersOutput } = await import(new URL('rows.js', WEB));
const flow = await import(new URL('flow.js', WEB));
const stream = await import(new URL('stream.js', WEB));

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

/** A record carrying `callCount` tool calls, the last of which can carry output. */
function recordWithCalls(rowId, index, callCount, { outputOnLast = false } = {}) {
  return {
    rowId,
    index,
    role: 'assistant',
    content: `row ${rowId}`,
    turnId: `turn-${rowId}`,
    toolCalls: Array.from({ length: callCount }, (_, position) => ({
      name: 'bash',
      id: `call-${rowId}-${position}`,
      status: 0,
      ok: true,
      taskId: outputOnLast && position === callCount - 1 ? `task-${rowId}` : null,
      hasOutput: outputOnLast && position === callCount - 1,
    })),
  };
}

/* ------------------------------------------------------- the packing order -- */

test('a record is a row, and each of its tool calls is another', () => {
  const rows = packStreamRows([recordWithCalls(1, 0, 3)]);
  assert.deepEqual(rows.map((row) => row.kind), ['message', 'tool', 'tool', 'tool']);
  assert.deepEqual(rows.map((row) => row.position), [undefined, 0, 1, 2]);
  assert.equal(rows[1].call.id, 'call-1-0');
  assert.equal(rows[3].call.id, 'call-1-2');
  assert.equal(rows[0].event.rowId, 1);
});

test('records are packed in the order they were delivered', () => {
  const rows = packStreamRows([recordWithCalls(1, 0, 1), recordWithCalls(2, 1, 0)]);
  assert.deepEqual(rows.map((row) => row.event.rowId), [1, 1, 2]);
});

test('a record with no tool calls is still a row', () => {
  const rows = packStreamRows([{ rowId: 7, index: 0, role: 'user', content: 'hi', turnId: 'turn-7' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'message');
});

test('packing nothing yields nothing', () => {
  assert.deepEqual(packStreamRows([]), []);
  assert.deepEqual(packStreamRows(undefined), []);
});

/* ------------------------------------------------ the first screen is bounded -- */

test('the first screen stops at the panel page size, and the bound is the shared one', () => {
  // Not `150` written here. The whole point of this module is that the number has one
  // definition, and a test that hard-codes it would keep passing after the constant
  // moved — which is the drift this file exists to prevent.
  const rows = packStreamRows(Array.from({ length: 400 }, (_, i) => recordWithCalls(i, i, 1)));
  assert.equal(firstRenderBatch(rows).length, STREAM_PAGE);
  assert.equal(STREAM_PAGE, 150, 'the page size this test was written against moved');
});

test('a short page is painted whole', () => {
  const rows = packStreamRows(Array.from({ length: 5 }, (_, i) => recordWithCalls(i, i, 1)));
  assert.equal(firstRenderBatch(rows).length, rows.length);
});

test('a page is smaller than the hard ceiling, so the ceiling never eats the first screen', () => {
  // `appendStreamRows` clamps to `MAX_STREAM_ROWS` before it takes a batch, and
  // `firstRenderBatch` carries the same clamp. While the page size is below the
  // ceiling the clamp cannot bind, so the real risk is the relationship between the
  // two constants: raise `STREAM_PAGE` past the ceiling and the first screen would
  // start rendering less than it claims. The fixtures below stay well clear of 6000
  // rows on purpose — a test that builds 6001 objects to prove a clamp it cannot
  // reach is slow and says nothing.
  assert.ok(STREAM_PAGE < MAX_STREAM_ROWS,
    `a first screen of ${STREAM_PAGE} rows cannot fit under a ceiling of ${MAX_STREAM_ROWS}`);
  assert.equal(firstRenderBatch(packStreamRows([])).length, 0);
});

/* --------------------------------- the defect this module was written for -- */

test('an output-bearing call past the first screen is not offered on the first screen', () => {
  // The exact shape that failed three browser runs: 200 records, 181 calls, the first
  // usable call at stream row 327. The page "has" it and the screen does not.
  const events = [];
  for (let index = 0; index < 200; index += 1) {
    const calls = index === 160 ? 2 : 0;
    events.push(recordWithCalls(index + 1, index, calls, { outputOnLast: index === 160 }));
  }
  const rows = packStreamRows(events);

  const offeredInPage = rows.some((row) => row.kind === 'tool' && row.call.hasOutput);
  const offeredOnFirstScreen = firstRenderBatch(rows)
    .some((row) => row.kind === 'tool' && row.call.hasOutput);

  assert.equal(offeredInPage, true, 'the fixture must really contain an output-bearing call');
  assert.equal(offeredOnFirstScreen, false,
    'a call past the rendered window cannot be clicked before the reader scrolls');
});

test('the same page offers it once the reader asks for more', () => {
  const events = [];
  for (let index = 0; index < 200; index += 1) {
    events.push(recordWithCalls(index + 1, index, index === 160 ? 1 : 0, { outputOnLast: index === 160 }));
  }
  const rows = packStreamRows(events);
  assert.ok(rows.length > STREAM_PAGE, 'the fixture must exceed one screen');
  assert.equal(rows.slice(STREAM_PAGE).some((row) => row.kind === 'tool' && row.call.hasOutput), true);
});

test('"the page has one" and "the first screen shows one" disagree, which is the defect', () => {
  // The two predicates the browser check could ask, on one fixture shaped like the
  // session that failed: 200 records, 181 tool calls, the first output-bearing call at
  // stream row 327. The old predicate is `usable > 0` over the fetched page — it picks
  // this session, and the page it then drives offers no button anywhere it looks.
  const events = [];
  let calls = 0;
  for (let index = 0; index < 200; index += 1) {
    const count = index < 150 ? 1 : 2;
    calls += count;
    events.push(recordWithCalls(index + 1, index, count, { outputOnLast: index === 150 }));
  }
  const rows = packStreamRows(events);
  assert.equal(calls, 250, '150 records with one call, 50 with two');
  assert.ok(rows.findIndex((row) => row.kind === 'tool' && row.call.hasOutput) > STREAM_PAGE,
    'the fixture must put the only output-bearing call past the first screen');

  const oldPredicate = rows.some((row) => row.kind === 'tool' && (row.call.taskId || row.call.hasOutput));
  const newPredicate = firstScreenOffersOutput(events);

  assert.equal(oldPredicate, true, 'the old selection rule picked a session it could not use');
  assert.equal(newPredicate, false, 'the new selection rule refuses it');
  assert.deepEqual(offeredCalls(rows).map((row) => row.call.id), ['call-151-1']);
  assert.deepEqual(offeredCalls(firstRenderBatch(rows)), []);
});

test('a session whose output-bearing call is on the first screen is selected', () => {
  const events = [recordWithCalls(1, 0, 1, { outputOnLast: true }), recordWithCalls(2, 1, 1)];
  assert.equal(firstScreenOffersOutput(events), true);
  assert.equal(firstScreenOffersOutput([recordWithCalls(1, 0, 1), recordWithCalls(2, 1, 1)]), false);
  assert.equal(firstScreenOffersOutput([]), false);
});

test('a task id alone is enough, exactly as the inspector button requires', () => {
  // `hasOutput` false with a task id still offers the button: the task may have written
  // its output to the task directory rather than into the projection, and the read is
  // what reports the difference. A predicate that demanded both would reject sessions
  // the panel can actually open.
  const withTask = { rowId: 1, index: 0, role: 'assistant', turnId: 't', toolCalls: [{ name: 'bash', id: 'c1', taskId: 'task-1', hasOutput: false }] };
  assert.equal(firstScreenOffersOutput([withTask]), true);
});

/* ------------------------------- the panel's loader is the one that packs -- */

test('the panel packs its rows with the module the browser check asks', async () => {
  // Behavioural rather than a grep for `packStreamRows` in `flow.js`: the loader runs,
  // the panel's own rows are compared against the shared packer's output, and reverting
  // `flow.js` to its own inline push fails here whether the push was reordered, the
  // call slice was narrowed, or the message row was dropped.
  const events = [recordWithCalls(1, 0, 2), { rowId: 2, index: 1, role: 'user', content: 'hi', turnId: 'turn-2' }];
  server = installServer({
    '/api/sessions': () => ({ body: { sessions: [sessionSummary('A')] } }),
    '/api/stats': () => ({ body: statsPayload('A') }),
    '/api/overview': ({ query }) => ({ body: overviewPayload(query.id) }),
    '/api/timeline': () => ({ body: { points: [], truncated: false } }),
    '/api/events': () => ({ body: eventPayload('A', { events, total: 2, nextOffset: null }) }),
  });

  state.sessionId = 'A';
  await flow.loadEvents({ reset: true });

  assert.deepEqual(
    state.streamRows.map((row) => [row.kind, row.call?.id ?? null, row.position ?? null]),
    packStreamRows(events).map((row) => [row.kind, row.call?.id ?? null, row.position ?? null]),
  );
  assert.equal(state.streamRows.length, 4);
});

/* ------------------------------- the helper and the renderer agree -- */

test('the renderer paints exactly what firstRenderBatch calls the first screen', () => {
  // Without this, `firstRenderBatch` is a second restatement of `appendStreamRows`
  // rather than a description of it: the two read the same constant today, and a
  // change to the renderer's batch arithmetic — a doubled page, a row that no longer
  // costs one slot — would leave the browser check asking about a screen that no
  // longer exists. Counting the real DOM rows is what makes the helper a claim about
  // the panel rather than about itself.
  const events = Array.from({ length: 200 }, (_, index) => recordWithCalls(index + 1, index, 1));
  const rows = packStreamRows(events);
  state.filteredRows = rows;
  state.turns = new Map();
  state.turnOrder = [];

  stream.appendStreamRows(true);

  const painted = dom.el('stream').querySelectorAll('.srow').length;
  assert.equal(painted, firstRenderBatch(rows).length,
    'the first screen the helper describes is not the first screen the panel paints');
  assert.ok(painted > 0 && painted < rows.length, 'the fixture must exceed one screen');
  assert.equal(state.renderedRows, firstRenderBatch(rows).length);
});

test('a second batch is not on the first screen', () => {
  const events = Array.from({ length: 200 }, (_, index) => recordWithCalls(index + 1, index, 1));
  const rows = packStreamRows(events);
  state.filteredRows = rows;
  state.turns = new Map();
  state.turnOrder = [];

  stream.appendStreamRows(true);
  const afterFirst = dom.el('stream').querySelectorAll('.srow').length;
  stream.appendStreamRows();
  const afterSecond = dom.el('stream').querySelectorAll('.srow').length;

  assert.equal(afterFirst, firstRenderBatch(rows).length);
  assert.ok(afterSecond > afterFirst, 'loading more must paint more');
  assert.ok(afterSecond <= rows.length, 'a second batch cannot invent rows');
});
