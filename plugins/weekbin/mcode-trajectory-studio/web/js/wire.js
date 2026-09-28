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
    renderSessions();
  });

  el('search').addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter' || !state.search.trim()) return;
    try {
      const payload = await api(`/api/search?q=${encodeURIComponent(state.search.trim())}&limit=100`);
      if (payload.sessions?.length) {
        state.sessions = payload.sessions;
        state.collapsed.clear();
        writeCollapsed();
        renderSessions();
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
