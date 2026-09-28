/**
 * Data flow and navigation.
 *
 * This is the only module that both loads data and renders surfaces, so it is the
 * single place the dependency points "up" into the surfaces. Surfaces never import
 * back: they announce an intent (`intents.js`) that `controller.js` binds to the
 * actions here. The module graph is therefore acyclic — no surface can reach this
 * file, directly or indirectly.
 */

import { el, state, EVENT_PAGE } from './state.js';
import { api } from './api.js';
import { banner } from './banner.js';
import { renderSessions, revealAncestors, scrollSelectedIntoView } from './sidebar.js';
import { renderStats } from './stats.js';
import { renderCapability } from './capability.js';
import { renderOverview } from './timeline.js';
import { renderStream, appendStreamRows, updateStreamCount } from './stream.js';
import { openInspector, closeInspector, renderInspector } from './inspector.js';

export async function loadSessions() {
  const payload = await api('/api/sessions?limit=300');
  state.sessions = payload.sessions ?? [];
  renderSessions();
}

/* ------------------------------------------------- who the screen belongs to -- */

/**
 * Which selection the screen currently belongs to, and which page request is
 * allowed to write into it.
 *
 * Every await in this file is a chance for the reader to click somewhere else, so
 * every response is checked against these before it touches the DOM. A page that
 * describes session A must not be appended to session B merely because it arrived
 * late: the last click decides what is on screen, not whichever response happened
 * to land last. An epoch alone would be enough for that, but a page that is already
 * known to be unwanted is better dropped outright — otherwise its slot stays busy
 * and the session it was fetched for never loads its own first page.
 */
let selectionEpoch = 0;
let pageToken = 0;
/** The page request holding the loading slot, so a superseded one can be dropped. */
let inFlightPage = null;

/** Claim the screen for a new selection. Returns the epoch to check against later. */
function beginSelection() {
  selectionEpoch += 1;
  abandonInFlightPage();
  return selectionEpoch;
}

/**
 * Free the loading slot and stop believing whatever request held it.
 *
 * The slot is freed here rather than in the abandoned request's own `finally`:
 * that request is not coming back on our schedule, and waiting for it is exactly
 * what used to leave a session switched to mid-load painted empty, with no error
 * and nothing to retry until the reader scrolled.
 */
function abandonInFlightPage() {
  pageToken += 1;
  state.loadingEvents = false;
  const page = inFlightPage;
  inFlightPage = null;
  page?.abort();
}

export async function selectSession(sessionId) {
  const previousId = state.sessionId;
  const epoch = beginSelection();
  state.sessionId = sessionId;
  state.selected = null;
  closeInspector();
  revealAncestors(sessionId);
  renderSessions();
  try {
    await loadOverview(epoch);
  } catch (error) {
    // A newer selection now owns the screen and is reporting its own outcome;
    // putting this one's rollback on top of it would undo the reader's last click.
    if (epoch !== selectionEpoch) return;
    // The id is set before the fetch so the sidebar and header move with the click
    // instead of a round-trip later. If that fetch then fails, the chrome would
    // name session B while the records on screen are session A's, which reads as
    // corrupted data rather than as a failed request. So put the selection back on
    // the session whose records are actually loaded, and let the caller say why.
    state.sessionId = previousId;
    await loadOverview().catch(() => { /* the caller reports the failure */ });
    throw error;
  }
}

let loadingDepth = 0;
export function setLoading(on) {
  loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
  el('main').dataset.loading = loadingDepth > 0 ? 'true' : 'false';
}

export async function loadOverview(epoch = selectionEpoch) {
  setLoading(true);
  try {
    return await loadOverviewInner(epoch);
  } finally {
    setLoading(false);
  }
}

async function loadOverviewInner(epoch) {
  const query = state.sessionId ? `?id=${encodeURIComponent(state.sessionId)}` : '';
  const payload = await api(`/api/overview${query}`);
  // The reader may have clicked another session while this was in flight. This
  // payload describes the one they left, so it must not repaint the one they are on.
  if (epoch !== selectionEpoch) return;
  if (!payload.session) {
    el('session-title').textContent = '没有可用会话';
    el('session-meta').textContent = '';
    el('stats').textContent = '';
    el('stream').textContent = '';
    el('overview').textContent = '';
    return;
  }
  state.sessionId = payload.session.sessionId;
  state.tasks = payload.tasks ?? [];
  state.turns = new Map((payload.turns ?? []).map((turn) => [turn.turnId, turn]));
  state.turnOrder = (payload.turns ?? []).map((turn) => turn.turnId);

  // The header and the sidebar highlight must agree with what is on screen, so the
  // selected session is force-included in the list even when the fetch limit, the
  // search box or an agent filter would have excluded it.
  if (!state.sessions.some((session) => session.sessionId === state.sessionId)) {
    const raw = await api(`/api/sessions?limit=1&id=${encodeURIComponent(state.sessionId)}`).catch(() => null);
    if (epoch !== selectionEpoch) return;
    const extra = raw?.sessions?.find((session) => session.sessionId === state.sessionId);
    if (extra) state.sessions.unshift(extra);
  }

  renderStats(payload.stats);
  renderCapability(payload.agent);
  revealAncestors(state.sessionId);
  renderSessions();
  scrollSelectedIntoView();

  // The axis needs the whole session; the stream needs only its first page. Fetch
  // them together so the first paint has both.
  const [, timeline] = await Promise.all([
    refreshEvents(epoch),
    api(`/api/timeline?id=${encodeURIComponent(state.sessionId)}`)
      .then((page) => page.points ?? [])
      .catch(() => []),
  ]);
  if (epoch !== selectionEpoch) return;
  renderOverview(timeline, state.tasks);
}

/**
 * Fetch one page of records from the server and append it.
 *
 * The stream used to request 1000 records with full content on every switch — up to
 * 6 MB for a large session — to render the first 150. Now only what will be shown is
 * fetched, and the rest arrives as the reader scrolls.
 *
 * A page applies only while it still describes what is on screen. The reader can
 * switch sessions or change the detail level while it is in flight, and a page
 * fetched for the view they left has no business being appended to the view they
 * are on — so it is discarded rather than applied late.
 */
export async function loadEvents({ reset = false } = {}) {
  if (reset) {
    // A reset replaces everything on screen with the beginning of this session, so
    // a page still in flight describes a view that no longer exists. Dropping it
    // here — before the guard below, which would otherwise refuse the fetch and
    // leave the new session painted empty with no error and nothing to retry — is
    // what makes a reset actually reset.
    abandonInFlightPage();
    state.events = [];
    state.eventKeys = new Set();
    state.streamRows = [];
    state.filteredRows = null;
    state.renderedRows = 0;
    state.lastTurn = undefined;
    state.nextOffset = 0;
    state.eventsTotal = 0;
    state.eventsDroppedOversized = 0;
  }
  if (state.loadingEvents || state.nextOffset === null) return false;

  const epoch = selectionEpoch;
  const sessionId = state.sessionId;
  const offset = state.nextOffset;
  const controller = new AbortController();
  const token = ++pageToken;
  inFlightPage = controller;
  state.loadingEvents = true;
  try {
    const detail = state.detailLevel === 'full' ? '&detailLevel=full' : '';
    const payload = await api(
      `/api/events?id=${encodeURIComponent(sessionId)}&offset=${offset}&limit=${EVENT_PAGE}${detail}`,
      { signal: controller.signal },
    );
    // Superseded while in flight: a newer selection, or a reset that took this slot.
    // Either way the answer belongs to a view that is gone.
    if (token !== pageToken || epoch !== selectionEpoch) return false;
    const delivered = payload.events ?? [];
    const incoming = unseenRecords(delivered);
    for (const event of incoming) {
      state.events.push(event);
      state.streamRows.push({ kind: 'message', event });
      for (const [position, call] of (event.toolCalls ?? []).entries()) {
        state.streamRows.push({ kind: 'tool', event, call, position });
      }
    }
    // The cursor is only meaningful when the page carried records. A page that
    // delivered none has nothing more to give, so stop here rather than leaving a
    // cursor that would re-request the same offset. This counts what the server
    // delivered, not what survived the dedupe: a page the cursor has already moved
    // past must still advance the cursor, or the rest of the session is unreachable.
    state.nextOffset = delivered.length > 0 ? (payload.nextOffset ?? null) : null;
    state.eventsTotal = payload.total ?? state.events.length;
    state.eventsSource = payload.source ?? 'sqlite';
    // Accumulated, not assigned: the count arrives only on the pages that dropped a
    // line, and a later clean page must not erase what an earlier one reported.
    state.eventsDroppedOversized += payload.droppedOversized ?? 0;
    state.filteredRows = null;
    return incoming.length > 0;
  } catch (error) {
    // An abort here is this module's own cancellation — a session switch or a reset
    // already replaced what the reader is looking at — so it is not a failed load
    // and must not be reported as one.
    if (controller.signal.aborted) return false;
    throw error;
  } finally {
    // Only the request that still owns the slot may release it; an abandoned one
    // settling later must not unblock a page that has not arrived yet.
    if (token === pageToken) {
      state.loadingEvents = false;
      inFlightPage = null;
    }
  }
}

/**
 * The records of a page that the panel does not already hold.
 *
 * The server pages by row id with LIMIT/OFFSET, so an overlap should not occur in
 * practice — but the client is not where that should be decided, and a record that
 * arrives twice is a line rendered twice in the reader's copy of the session.
 * Identity is the server's row id, falling back to the record's own index, which is
 * what the JSONL fallback carries since it has no row ids. A record with neither is
 * kept: it cannot be recognised as a repeat, and dropping it would lose a record
 * rather than a duplicate.
 */
function unseenRecords(records) {
  const fresh = [];
  for (const event of records) {
    const key = event.rowId ?? event.index;
    if (key === null || key === undefined) {
      fresh.push(event);
      continue;
    }
    if (state.eventKeys.has(key)) continue;
    state.eventKeys.add(key);
    fresh.push(event);
  }
  return fresh;
}

export async function refreshEvents(epoch = selectionEpoch) {
  await loadEvents({ reset: true });
  // A selection that landed while this was in flight owns the screen now; rendering
  // here would paint it with this reload's notices.
  if (epoch !== selectionEpoch) return;
  renderStream();
  if (state.selected) renderInspector();
  if (state.eventsSource === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时与任务关联可能缺失。');
  }
  if (state.eventsDroppedOversized > 0) {
    banner(`messages.jsonl 中有 ${state.eventsDroppedOversized} 行超过单行上限，已丢弃。`);
  }
}

/**
 * Bring a record into view wherever it sits in the session: keep asking the server
 * for pages until it is loaded, then keep rendering until it is in the DOM.
 */
export async function locateRow(rowId, { silent = false } = {}) {
  let guard = 0;
  while (guard < 60) {
    guard += 1;
    const event = state.events.find((item) => item.rowId === rowId);
    if (event) {
      // A timeline INPUT/MODEL block refers to a record, never to a tool call.
      openInspector({ kind: 'message', eventIndex: event.index });
      return scrollRowIntoView(rowId);
    }
    if (state.nextOffset === null) break;
    await loadEvents();
  }
  if (!silent) banner('未能定位到该记录。');
  return false;
}

export async function locateToolCall(toolCallId, { silent = false } = {}) {
  let guard = 0;
  while (guard < 60) {
    guard += 1;
    for (const event of state.events) {
      const position = (event.toolCalls ?? []).findIndex((call) => call.id === toolCallId);
      if (position >= 0) {
        openInspector({ kind: 'tool', eventIndex: event.index, position });
        return scrollRowIntoView(`call:${toolCallId}`);
      }
    }
    if (state.nextOffset === null) break;
    await loadEvents();
  }
  if (!silent) banner('未能在已加载的记录中找到该工具调用。');
  return false;
}

/** Render further batches until the wanted row is in the DOM, then scroll to it. */
export function scrollRowIntoView(key) {
  const selector = typeof key === 'string' && key.startsWith('call:')
    ? `[data-tool-call-id="${CSS.escape(key.slice(5))}"]`
    : `[data-row-id="${CSS.escape(String(key))}"]`;
  for (let guard = 0; guard < 60; guard += 1) {
    const node = el('stream').querySelector(selector);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateStreamCount();
      return true;
    }
    if ((state.renderedRows ?? 0) >= (state.filteredRows?.length ?? 0)) break;
    appendStreamRows();
  }
  updateStreamCount();
  return false;
}

/** Options come from the data: sub-agent presets differ per install. */
export async function loadAgents() {
  const select = el('agent-select');
  try {
    const payload = await api('/api/agents');
    const current = select.value;
    select.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部';
    select.append(all);
    for (const agent of payload.agents ?? []) {
      const option = document.createElement('option');
      option.value = agent.name;
      option.textContent = `${agent.name} (${agent.count})`;
      select.append(option);
    }
    select.value = current;
  } catch {
    /* the filter stays at 全部 */
  }
}

export function debounce(fn, wait = 140) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
