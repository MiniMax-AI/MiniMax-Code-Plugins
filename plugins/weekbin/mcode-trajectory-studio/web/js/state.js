/**
 * Shared client state and the constants every surface is bounded by.
 *
 * Leaf module — imports nothing, so anything in `js/` may import it without a
 * cycle. The single `state` object is mutated in place by the surfaces; readers
 * never hold a copy.
 */

/**
 * The panel's per-process capability, read from the URL fragment.
 *
 * Every API route requires it, and the server never sees the fragment: a fragment
 * is not sent in the request line, so the capability stays out of request logs, out
 * of `Referer` for any asset request, and out of the address the server logs. A URL
 * whose `#t=…` was stripped loads the shell and no data, which is the intended
 * failure — the page explains it rather than retrying.
 *
 * Returned as a header value rather than a query parameter for the same reason: a
 * query parameter would travel to the server on every request.
 */
export function panelToken() {
  const match = /(?:^|[#&])t=([A-Za-z0-9_-]+)/u.exec(window.location.hash);
  return match ? match[1] : null;
}

/** Timeline lane packing. */
const MAX_LANE_ROWS = 8;
const LANE_ROW_PX = 17;
/** Stream rows rendered per batch. The rest load as the reader scrolls. */
const STREAM_PAGE = 150;
/** Records fetched per request. Only what will be rendered is fetched. */
const EVENT_PAGE = 200;
const MAX_STREAM_ROWS = 6000;

const state = {
  sessions: [],
  sessionId: null,
  events: [],
  turns: new Map(),
  tasks: [],
  agent: null,
  // Content-free by default. The plugin's documented posture is that message text,
  // tool arguments and tool results are loaded only when the reader asks for them —
  // `summary` still carries roles, turn ids, timings, token usage and tool names,
  // which is everything the structural views need. `wire.js` drives the toggle from
  // this field so the control and the state cannot disagree.
  detailLevel: 'summary',
  agentFilter: '',
  rowFilter: 'all',
  turnQuery: '',
  textQuery: '',
  selected: null,
  search: '',
  axis: null,
  timeline: [],
  view: { start: 0, end: 1 },
  collapsed: new Set(),
  expanded: new Set(),
  tab: 'summary',
  // Stream is cached and paged: rows are rebuilt only when the session's events
  // change, and only STREAM_PAGE of them enter the DOM at a time.
  streamRows: [],
  filteredRows: null,
  renderedRows: 0,
  lastTurn: undefined,
  loadingMore: false,
  // Records are paged from the server: nextOffset is null once the session is fully
  // loaded, and eventsTotal is the server's count for the whole session.
  nextOffset: 0,
  eventsTotal: 0,
  loadingEvents: false,
  eventsSource: 'sqlite',
  // Artifact lines past the server's per-line cap are dropped at the source; the
  // count comes back with the page so the reader is told the file is short.
  eventsDroppedOversized: 0,
  turnOrder: [],
  theme: 'dark',
};

const el = (id) => document.getElementById(id);

export { MAX_LANE_ROWS, LANE_ROW_PX, STREAM_PAGE, EVENT_PAGE, MAX_STREAM_ROWS, state, el };
