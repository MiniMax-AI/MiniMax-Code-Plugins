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
import { textNode } from './format.js';
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
/**
 * Warnings already put on screen, so a re-read does not repeat them.
 *
 * The server appends a warning as a read happens — an unreadable row, a capped
 * task index, a timeline cut at its cap. `/api/meta` is where they surface, and it
 * used to be read once during boot, before any of them existed, so a warning raised
 * by the first session the reader opened was never shown to anyone.
 */
const seenWarnings = new Set();

/**
 * Re-read the server's warning list and show what is new.
 *
 * Best effort by design: this is a report *about* a read that already succeeded, so a
 * failure to fetch it must not turn a working session into an error. The specific
 * conditions each surface can hit also arrive as structured fields — `unreadableRows`
 * on the statistics, `pageBytesTruncated` on the event page, `truncated` on the
 * timeline — so this is the backstop for the ones that have no field of their own.
 */
async function reportServerWarnings() {
  try {
    const meta = await api('/api/meta');
    for (const warning of meta?.warnings ?? []) {
      if (seenWarnings.has(warning)) continue;
      seenWarnings.add(warning);
      banner(warning);
    }
  } catch {
    // The read this report is about did not fail, so neither does its report.
  }
}
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
  reportServerWarnings();
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
  // Rows the fold could not read are excluded from every total the stats bar shows,
  // so the bar is describing fewer records than the stream lists until this is said.
  const unreadable = Number(payload.stats?.unreadableRows);
  state.unreadableRows = Number.isFinite(unreadable) && unreadable > 0 ? unreadable : 0;
  // A notice about the session just left must not outlive it: the axis is about to be
  // fetched again below, and until it answers the panel knows nothing about this one.
  state.timelineTruncated = false;
  state.timelineFailed = null;

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
    fetchTimeline(epoch),
  ]);
  if (epoch !== selectionEpoch) return;
  renderOverview(timeline, state.tasks);
  // The axis answer arrives after the stream's own notices have been painted, so the
  // disclosure strip is redrawn once it is in.
  renderDisclosure();
}

/**
 * The axis, plus what it failed to be.
 *
 * The request used to be `.then((page) => page.points ?? []).catch(() => [])`, which
 * made a capped axis and an axis whose request failed indistinguishable from a
 * session with no activity — the most confident wrong answer this panel can give,
 * because an empty axis looks like an answer. Both the server's `truncated` flag and
 * the failure are recorded before the points are handed on, so the reader is told
 * which of the two happened.
 */
async function fetchTimeline(epoch) {
  try {
    const page = await api(`/api/timeline?id=${encodeURIComponent(state.sessionId)}`);
    if (epoch !== selectionEpoch) return [];
    state.timelineTruncated = page?.truncated === true;
    state.timelineFailed = null;
    return page?.points ?? [];
  } catch (error) {
    if (epoch !== selectionEpoch) return [];
    state.timelineTruncated = false;
    state.timelineFailed = error?.message ?? String(error);
    return [];
  }
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
    state.eventsTotal = null;
    state.eventsDroppedOversized = 0;
    state.eventsOmitted = 0;
    state.eventsTruncated = false;
    state.eventsPageBytesTruncated = false;
    state.eventsFailed = null;
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
    // `null` is not zero: it is the server declining to say how big the session is,
    // which the JSONL fallback always does. Rendering it as a count would claim the
    // loaded page is the whole session.
    state.eventsTotal = typeof payload.total === 'number' ? payload.total : null;
    state.eventsSource = payload.source ?? 'sqlite';
    // Accumulated, not assigned: the count arrives only on the pages that dropped a
    // line, and a later clean page must not erase what an earlier one reported.
    state.eventsDroppedOversized += payload.droppedOversized ?? 0;
    // Same reasoning for the rest of the page's report. `truncated` is the record
    // list being cut to the response budget, `omitted` is how many records that cut
    // cost, and `pageBytesTruncated` is the page byte budget stopping the read
    // earlier than the record count — a different cut with the same consequence, and
    // `omitted: 0, truncated: true` alone reads as a contradiction.
    const omitted = Number(payload.omitted);
    if (Number.isFinite(omitted) && omitted > 0) state.eventsOmitted += omitted;
    if (payload.truncated === true) state.eventsTruncated = true;
    if (payload.pageBytesTruncated === true) state.eventsPageBytesTruncated = true;
    // `source: 'error'` arrives with the reason beside it rather than as an empty
    // page: the reader is looking at a session the server could not read.
    state.eventsFailed = typeof payload.error === 'string' ? payload.error : null;
    state.filteredRows = null;
    renderDisclosure();
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
  renderDisclosure();
  if (state.eventsSource === 'jsonl') {
    banner('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时与任务关联可能缺失。');
  }
  if (state.eventsDroppedOversized > 0) {
    banner(`messages.jsonl 中有 ${state.eventsDroppedOversized} 行超过单行上限，已丢弃。`);
  }
}

/**
 * Everything this view did not read, as lines the reader can act on.
 *
 * The server reports all of it on every page and the panel used to drop all of it,
 * which is how a session that was only half read, cut to a byte budget, capped for
 * drawability, or silently shorter on disk than its statistics describe ends up
 * presented as the whole session. These notices are persistent rather than a banner:
 * a banner auto-hides after a few seconds, which is right for an action that failed
 * and wrong for a fact about the data that never stops being true.
 *
 * Every line is written with `textContent` — a notice quotes a server-supplied
 * message, and this codebase has no markup sink.
 */
function renderDisclosure() {
  const host = el('data-notices');
  if (!host) return;
  const lines = disclosureLines();
  host.textContent = '';
  for (const line of lines) host.append(textNode('p', 'notice-line', line));
  host.hidden = lines.length === 0;
}

function disclosureLines() {
  const lines = [];
  const loaded = state.events?.length ?? 0;
  const total = state.eventsTotal;

  if (state.eventsSource === 'jsonl') {
    lines.push('该会话未进入 SQLite 投影，已回退到 messages.jsonl。计时与任务关联可能缺失。');
  }
  if (typeof total === 'number' && total > loaded) {
    lines.push(`已加载 ${loaded} / ${total} 条记录，其余尚未读取。继续向下滚动才会加载，不是本次视图的全部。`);
  } else if (typeof total !== 'number' && loaded > 0 && state.nextOffset !== null) {
    lines.push('服务端未给出该会话的记录总数；这里只渲染了已加载的部分。');
  }
  if (state.eventsDroppedOversized > 0) {
    lines.push(`messages.jsonl 中有 ${state.eventsDroppedOversized} 行超过单行上限，已丢弃。`);
  }
  const cuts = [];
  if (state.eventsOmitted > 0) cuts.push(`${state.eventsOmitted} 条记录因单次响应体积上限未随本页返回`);
  if (state.eventsPageBytesTruncated) cuts.push('本页因响应体积上限提前停止读取');
  else if (state.eventsTruncated && state.eventsOmitted === 0) cuts.push('记录列表按响应体积上限被裁剪');
  if (cuts.length > 0) lines.push(`${cuts.join('；')}。未返回的记录需继续加载才能看到，本次视图不是整个会话。`);
  if (state.eventsFailed) {
    lines.push(`记录读取失败：${state.eventsFailed}。当前轨迹流不是该会话的完整记录。`);
  }
  if (state.timelineTruncated) {
    lines.push('时间轴已按点数上限裁剪：只绘制了部分记录，不代表整个会话。');
  }
  if (state.timelineFailed) {
    lines.push(`时间轴加载失败：${state.timelineFailed}。当前时间轴是空的，不代表该会话没有活动。`);
  }
  if (state.unreadableRows > 0) {
    lines.push(`有 ${state.unreadableRows} 行记录不是合法 JSON，已从上述统计中排除。`);
  }
  return lines;
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
