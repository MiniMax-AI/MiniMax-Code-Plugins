/**
 * Trajectory Studio client — entry point.
 *
 * Information architecture — each surface owns one question and does not repeat
 * another surface's answer:
 *
 *   Agent 与能力  what was this session configured with (model, tools, skills, prompt)
 *   统计条        what are the session totals (turns, wall-clock, tokens, failures)
 *   时间轴        where in time did things happen (navigation and zoom only)
 *   轨迹流        what happened, one scannable line per message and per tool call
 *   检查器        the full detail of exactly one selected row
 *
 * The timeline draws measured tool spans; the stream carries the same tasks joined
 * by tool call ID. Neither repeats the other's text.
 *
 * This file only boots. The surfaces live in `./js/`:
 *
 *   state / bus / format / icons / results                     leaves
 *   api / storage / theme / banner / intents                   foundations
 *   sidebar / capability / stats / timeline / stream / inspector   surfaces
 *   flow / controller / wire                                   orchestration
 *
 * Surfaces announce intents; `controller.js` binds them to the actions in
 * `flow.js`. Nothing imports a surface's caller, so the graph stays acyclic.
 */

import { state, el } from './js/state.js';
import { api, UnauthorizedPanelError } from './js/api.js';
import { banner } from './js/banner.js';
import { applyTheme, readTheme } from './js/theme.js';
import { hydrateSidebarState } from './js/storage.js';
import { installController } from './js/controller.js';
import { wire } from './js/wire.js';
import { loadAgents, loadSessions, selectSession } from './js/flow.js';

async function boot() {
  applyTheme(readTheme());
  hydrateSidebarState();
  // Bind intents before anything can emit one.
  installController();
  wire();
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  try {
    const meta = await api('/api/meta');
    el('source-line').textContent = meta.sqliteAvailable
      ? `只读 SQLite · FTS ${meta.ftsAvailable ? '可用' : '不可用'}`
      : 'SQLite 不可用 · 回退 JSONL';
    if (!meta.sqliteAvailable) banner('SQLite 投影不可读，已回退到 messages.jsonl，计时字段会缺失。');
    for (const warning of meta.warnings ?? []) banner(warning);
    await loadAgents();
    await loadSessions();
    const first = state.sessionId ?? state.sessions[0]?.sessionId;
    if (first) await selectSession(first);
    document.body.dataset.state = 'ready';
  } catch (error) {
    document.body.dataset.state = 'error';
    banner(
      error instanceof UnauthorizedPanelError
        // The capability lives in the fragment, so a truncated or hand-copied URL
        // is the likely cause — say that instead of "HTTP 403".
        ? '面板凭据无效：请用 agent 返回的完整 URL 打开（必须包含 `#t=…` 片段），该片段是本次进程的访问凭据。'
        : `初始化失败：${error.message}`,
    );
  }
}

boot();

/**
 * A fragment-only navigation does not re-run this module.
 *
 * That matters because the capability lives in the fragment: opening the bare URL
 * and then pasting the full URL into the same tab is a same-document navigation, so
 * `boot()` never runs again and the page keeps showing the credential error. Reload
 * once the page is in an error state and the fragment has changed, and the panel
 * recovers without the user having to know why.
 */
window.addEventListener('hashchange', () => {
  if (document.body.dataset.state === 'error') window.location.reload();
});
