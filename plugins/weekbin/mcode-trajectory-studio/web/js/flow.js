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

export async function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.selected = null;
  closeInspector();
  revealAncestors(sessionId);
  renderSessions();
  await loadOverview();
}

let loadingDepth = 0;
export function setLoading(on) {
  loadingDepth = Math.max(0, loadingDepth + (on ? 1 : -1));
  el('main').dataset.loading = loadingDepth > 0 ? 'true' : 'false';
}

export async function loadOverview() {
  setLoading(true);
  try {
    return await loadOverviewInner();
  } finally {
    setLoading(false);
  }
}

async function loadOverviewInner() {
  const query = state.sessionId ? `?id=${encodeURIComponent(state.sessionId)}` : '';
  const payload = await api(`/api/overview${query}`);
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
    refreshEvents(),
    api(`/api/timeline?id=${encodeURIComponent(state.sessionId)}`)
      .then((page) => page.points ?? [])
      .catch(() => []),
  ]);
  renderOverview(timeline, state.tasks);
}

/**
 * Fetch one page of records from the server and append it.
 *
 * The stream used to request 1000 records with full content on every switch — up to
 * 6 MB for a large session — to render the first 150. Now only what will be shown is
 * fetched, and the rest arrives as the reader scrolls.
 */
export async function loadEvents({ reset = false } = {}) {
  if (reset) {
    state.events = [];
    state.streamRows = [];
    state.filteredRows = null;
    state.renderedRows = 0;
    state.lastTurn = undefined;
    state.nextOffset = 0;
    state.eventsTotal = 0;
    state.eventsDroppedOversized = 0;
  }
  if (state.loadingEvents || state.nextOffset === null) return false;
  state.loadingEvents = true;
  try {
    const detail = state.detailLevel === 'full' ? '&detailLevel=full' : '';
    const payload = await api(
      `/api/events?id=${encodeURIComponent(state.sessionId)}&offset=${state.nextOffset}&limit=${EVENT_PAGE}${detail}`);
    const incoming = payload.events ?? [];
    for (const event of incoming) {
      state.events.push(event);
      state.streamRows.push({ kind: 'message', event });
      for (const [position, call] of (event.toolCalls ?? []).entries()) {
        state.streamRows.push({ kind: 'tool', event, call, position });
      }
    }
    // The cursor is only meaningful when the page carried records. A page that
    // delivered none has nothing more to give, so stop here rather than leaving a
    // cursor that would re-request the same offset.
    state.nextOffset = incoming.length > 0 ? (payload.nextOffset ?? null) : null;
    state.eventsTotal = payload.total ?? state.events.length;
    state.eventsSource = payload.source ?? 'sqlite';
    // Accumulated, not assigned: the count arrives only on the pages that dropped a
    // line, and a later clean page must not erase what an earlier one reported.
    state.eventsDroppedOversized += payload.droppedOversized ?? 0;
    state.filteredRows = null;
    return incoming.length > 0;
  } finally {
    state.loadingEvents = false;
  }
}

export async function refreshEvents() {
  await loadEvents({ reset: true });
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
