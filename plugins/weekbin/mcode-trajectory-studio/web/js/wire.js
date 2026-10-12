/**
 * Event wiring: every DOM listener in one place, so the surfaces stay pure
 * renderers and the flow module stays free of `addEventListener`.
 */

import { el, state } from './state.js';
import { api } from './api.js';
import { banner } from './banner.js';
import { writeCollapsed } from './storage.js';
import { toggleTheme } from './theme.js';
import { visibleSessions, renderSessions } from './sidebar.js';
import { renderStream, appendStreamRows, updateStreamCount } from './stream.js';
import { bindTimelineControls } from './timeline.js';
import { closeInspector, renderInspector } from './inspector.js';
import { loadOverview, refreshEvents, loadEvents, debounce } from './flow.js';

export function wire() {
  bindTimelineControls();

  // The control follows the state, not the other way round, so the initial view
  // cannot disagree with `state.detailLevel`. An earlier revision had the checkbox
  // `checked` in the markup while the state defaulted to `summary`, so the panel
  // fetched content the toggle said it was not fetching.
  el('full-detail').checked = state.detailLevel === 'full';

  el('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    // The results on screen answered the term that was submitted. Once the reader
    // edits the box, they no longer describe what is being asked for, so the
    // sidebar must not keep showing them as though they did.
    state.searchedTerm = null;
    renderSessions();
  });

  el('search').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !state.search.trim()) return;
    const term = state.search.trim();
    try {
      const payload = await api(`/api/search?q=${encodeURIComponent(term)}&limit=100`);
      // An empty list is "nothing matched" or "the query never ran", and the panel
      // would otherwise leave the previous results up and say nothing at all.
      //
      // Three ways the query can produce nothing, and the reader's next move differs
      // for each: a failed query is worth retrying, an index that does not carry the
      // searched fields is not, and neither is an absence of matches. The first two
      // arrive as an empty `sessions` array too, so the flags are what separate them.
      if (payload.searchUnsearchable) {
        state.searchedTerm = null;
        banner('此运行时的会话索引不包含全文检索所需的字段，本次查询没有执行。');
        return;
      }
      if (payload.searchFailed) {
        state.searchedTerm = null;
        banner('搜索未能执行：全文查询失败，这不是「没有匹配结果」。');
        return;
      }
      if (!payload.sessions?.length) {
        // The third of the same pair: a query that matched nothing used to leave the
        // old list on screen, so "no match" and "the search did not run" were the
        // same picture.
        //
        // The list on screen stays the browsing page, so the marker goes with it: the
        // sidebar must not go on treating those rows as the answer to this term.
        // (Clearing the list instead would contradict an existing contract — a search
        // that matches nothing does not discard what was already loaded.)
        state.searchedTerm = null;
        banner('没有匹配的会话。');
        return;
      }
      state.sessions = payload.sessions;
      // Marked so `visibleSessions` treats these rows as the server's answer rather
      // than as material to re-match: the server searches agent, status, session
      // type and purpose too, and the client has no equivalent of those fields.
      state.searchedTerm = term;
      state.collapsed.clear();
      writeCollapsed();
      // The sidebar's own truncation notice describes the *browsing* page, and after a
      // search the list is neither that page nor the whole machine — leaving it up would
      // claim 300 of 614 over a hundred search results. The banner below is what now
      // describes the list on screen.
      const notice = el('session-truncation');
      notice.textContent = '';
      notice.hidden = true;
      renderSessions();
      // The list is capped and these queries are not selective — an agent name or a
      // common word matches most of the machine — so a hundred rows is a subset of
      // the matches, not the matches.
      if (typeof payload.total === 'number' && payload.total > payload.sessions.length) {
        banner(`匹配到 ${payload.total} 个会话，此处只显示最新的 ${payload.sessions.length} 个。`);
      }
    } catch (error) {
      banner(`搜索失败：${error.message}`);
    }
  });

  el('agent-select').addEventListener('change', (event) => {
    state.agentFilter = event.target.value;
    renderSessions();
  });

  el('collapse-all').addEventListener('click', () => {
    const keys = [...new Set(visibleSessions().map((session) => session.groupKey ?? `path:${session.workspaceDir ?? ''}`))];
    const allCollapsed = keys.length > 0 && keys.every((key) => state.collapsed.has(key));
    for (const key of keys) {
      if (allCollapsed) state.collapsed.delete(key);
      else state.collapsed.add(key);
    }
    writeCollapsed();
    renderSessions();
  });

  el('stream').parentElement.addEventListener('click', (event) => {
    const button = event.target.closest('.chip[data-filter]');
    if (!button) return;
    for (const chip of el('stream').parentElement.querySelectorAll('.chip[data-filter]')) {
      chip.classList.toggle('is-on', chip === button);
    }
    state.rowFilter = button.dataset.filter ?? 'all';
    renderStream();
  });

  // Loading the next batch as the reader approaches the bottom keeps the initial
  // paint small without hiding anything.
  el('stream').addEventListener('scroll', async () => {
    const host = el('stream');
    if (state.loadingMore) return;
    if (host.scrollTop + host.clientHeight < host.scrollHeight - 320) return;
    state.loadingMore = true;
    try {
      // Render what is already loaded first, and only then ask the server for more,
      // so scrolling stays responsive while a large session streams in.
      if ((state.renderedRows ?? 0) < (state.filteredRows?.length ?? 0)) {
        appendStreamRows();
      } else if (state.nextOffset !== null && !state.textQuery && !state.turnQuery) {
        await loadEvents();
        appendStreamRows();
      }
      updateStreamCount();
    } catch (error) {
      // A page that fails mid-scroll is a dead end the reader has to be told about:
      // left uncaught it is an unhandled rejection, and the stream just stops
      // growing with no explanation.
      banner(`加载更多记录失败：${error.message}`);
    } finally {
      state.loadingMore = false;
    }
  });

  const debouncedFilters = debounce(() => {
    renderStream();
  });
  el('turn-jump').addEventListener('input', (event) => {
    state.turnQuery = event.target.value.trim();
    debouncedFilters();
  });
  el('text-filter').addEventListener('input', (event) => {
    state.textQuery = event.target.value.trim();
    debouncedFilters();
  });

  el('failure-jump').addEventListener('click', () => {
    const button = el('stream').parentElement.querySelector('.chip[data-filter="failed"]');
    if (button && !button.classList.contains('is-on')) button.click();
    const first = el('stream').querySelector('.srow-tool.is-fail');
    if (first) {
      first.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // The first failure may sit beyond the rendered batch; load until it appears.
      let guard = 0;
      while (guard < 40 && !el('stream').querySelector('.srow-tool.is-fail')
        && (state.renderedRows ?? 0) < (state.filteredRows?.length ?? 0)) {
        appendStreamRows();
        guard += 1;
      }
      el('stream').querySelector('.srow-tool.is-fail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      updateStreamCount();
    }
  });

  el('ins-tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.ins-tab');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    renderInspector();
  });

  el('full-detail').addEventListener('change', async (event) => {
    state.detailLevel = event.target.checked ? 'full' : 'summary';
    try {
      await refreshEvents();
    } catch (error) {
      banner(`加载失败：${error.message}`);
    }
  });

  el('reload').addEventListener('click', () => {
    loadOverview().catch((error) => banner(`刷新失败：${error.message}`));
  });

  el('theme-toggle').addEventListener('click', toggleTheme);

  el('ins-close').addEventListener('click', closeInspector);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeInspector();
  });
}
