/**
 * How records become the rows the reader sees, in one place.
 *
 * Leaf module — imports only `state.js`, so it is safe to load from a browser page
 * *and* from a Node process. That matters more than it looks: `tools/browser-check.mjs`
 * has to answer "will this session show a captured output without the reader scrolling?"
 * before it drives a browser, and an answer computed from a second copy of the
 * packing rule is an answer about the copy.
 *
 * The panel's `loadEvents` pushes one row per record plus one row per tool call, and
 * `appendStreamRows` renders a bounded batch of them. Anything that reasons about
 * "what is on screen" — the browser check, and the tests that pin it — must go
 * through these two functions rather than restating the arithmetic.
 */

import { STREAM_PAGE, MAX_STREAM_ROWS } from './state.js';

/**
 * Pack fetched records into render rows: one message row per record, then one tool
 * row per call, in the order the record carried them.
 *
 * @param {Array<object>} events Records as delivered, in render order.
 * @returns {Array<{kind: 'message'|'tool', event: object, call?: object, position?: number}>}
 */
export function packStreamRows(events) {
  const rows = [];
  for (const event of events ?? []) {
    rows.push({ kind: 'message', event });
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      rows.push({ kind: 'tool', event, call, position });
    }
  }
  return rows;
}

/**
 * The rows the panel renders before the reader does anything at all.
 *
 * `appendStreamRows` is the definition: from a reset it renders up to `STREAM_PAGE`
 * rows, and never past `MAX_STREAM_ROWS`. A row outside this window is still in the
 * transcript and still reachable through the "load more" control — it is simply not
 * painted yet, and a question about the first screen has to answer for the first
 * screen.
 *
 * @param {Array<object>} rows Packed rows.
 * @returns {Array<object>} The rows rendered without scrolling.
 */
export function firstRenderBatch(rows) {
  const total = Math.min(rows.length, MAX_STREAM_ROWS);
  return (rows ?? []).slice(0, Math.min(total, STREAM_PAGE));
}

/**
 * The tool rows in `rows` whose background task recorded output the panel can fetch.
 *
 * `taskId` and `hasOutput` are what `inspector.js` keys the "view task output" button
 * on, so this is the same test the inspector's own markup applies — asked here so the
 * browser check can select a session without driving a page to find out.
 *
 * @param {Array<object>} rows Packed rows.
 * @returns {Array<object>} The output-bearing tool rows.
 */
export function offeredCalls(rows) {
  return (rows ?? []).filter((row) => row.kind === 'tool' && (row.call.taskId || row.call.hasOutput));
}

/**
 * Whether a reader would see the captured-output button without scrolling.
 *
 * Not the same question as "does this page contain one", which is what the check
 * originally asked and what made it fail: on a 200-record page the answer was yes
 * (27 of 181 calls) and the first screen said no (0 of 69 rows).
 *
 * @param {Array<object>} events Records as delivered.
 * @returns {boolean}
 */
export function firstScreenOffersOutput(events) {
  return offeredCalls(firstRenderBatch(packStreamRows(events ?? []))).length > 0;
}
