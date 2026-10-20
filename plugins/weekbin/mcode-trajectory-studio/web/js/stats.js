/**
 * The statistics bar and the header line.
 *
 * This surface answers "what are the session totals" and nothing else; every card
 * is a folded number from the server, never a client-side sum of what happens to
 * be loaded. TTFT is shown as unavailable rather than estimated.
 */

import { el } from './state.js';
import { fmtMs, fmtTokens, shortId, textNode } from './format.js';

export function renderStats(stats) {
  const host = el('stats');
  host.textContent = '';
  if (!stats) return;
  const cards = [
    ['轮次', stats.turns, '', false],
    ['步骤', stats.steps, '', false],
    ['LLM 耗时', fmtMs(stats.llmMs), '单次请求耗时之和', false],
    ['工具耗时', fmtMs(stats.toolMs), `${stats.backgroundTasks} 个已记录任务`, false],
    ['解码耗时', fmtMs(stats.decodeMs), '近似：LLM − 思考', false],
    ['TTFT', '不可用', '运行时不落盘', true],
    ['思考耗时', fmtMs(stats.thinkingMs), `${stats.thinkingEvents} 条含思考`, false],
    ['输出 token', fmtTokens(stats.decodeTokens), '', false],
    ['输入 token', fmtTokens(stats.inputTokens), '', false],
    ['缓存读取', fmtTokens(stats.cacheReadTokens), '', false],
    ['工具调用', stats.toolCalls, stats.toolFailures ? `${stats.toolFailures} 次失败` : '无失败', false],
    ['压缩', stats.compactions, stats.compactionFailures ? `${stats.compactionFailures} 次失败` : '', false],
    ['子代理', stats.subagentTasks, '', false],
    ['记录数', stats.events, '', false],
  ];
  // File changes, and the reason this card is not simply `stats.changedTurns`.
  //
  // The bar answers "what are the session totals", and until this card it answered
  // fourteen of them while saying nothing about files — so a reader who opened the panel
  // to find out whether a session touched their repository had nothing to read. It also
  // matches what the MCP surface now publishes, so the two answers cannot disagree.
  //
  // `changesAvailable` has to be exactly `true`. Absent is not `false` — it is a server
  // that did not publish the field, and reading a number out of that silence would be a
  // claim with no source behind it. The only way to show a figure here is an explicit
  // "yes, I counted, and the count is zero".
  if (stats.changesAvailable === true) {
    // The sub-line must not call these "轮" without qualification. They are change sets,
    // and the runtime writes the change-set table independently of the transcript: on a
    // measured machine 307 of 1,417 change sets name a turn no message row carries, and
    // on 7 of 351 sessions this count is larger than the session's turn count. A card
    // captioned "轮数" beside a `轮次` card that counts something else is the same
    // contradiction the MCP surface now publishes `unmatchedTurns` to defuse, put back
    // into a place a reader cannot check it.
    const unmatched = stats.unmatchedTurns;
    cards.push([
      '改动轮次',
      stats.changedTurns ?? 0,
      typeof unmatched === 'number' && unmatched > 0
        ? `变更集数，其中 ${unmatched} 个不在转录轮次中`
        : '变更集数（对应转录轮次）',
      false,
    ]);
  } else {
    cards.push(['改动轮次', '未记录', '此运行时不记录文件改动', true]);
  }
  for (const [key, value, sub, isNa] of cards) {
    const card = textNode('div', `stat${isNa ? ' is-na' : ''}`);
    card.append(textNode('div', 'k', key));
    card.append(textNode('div', 'v', String(value)));
    if (sub) card.append(textNode('div', 's', sub));
    host.append(card);
  }

  const sources = (stats.sources || []).map((entry) => `${entry.source}:${entry.count}`).join('  ');
  el('session-meta').textContent =
    `${shortId(stats.sessionId)} · ${stats.agent ?? '?'} · ${stats.sessionKind} · 来源 ${sources || '—'} · ` +
    `${stats.workspaceDir ?? ''}${stats.children ? ` · ${stats.children} 个子会话` : ''}`;
  el('session-title').textContent = stats.title || '(无标题)';

  const jump = el('failure-jump');
  if (stats.toolFailures > 0) {
    jump.hidden = false;
    jump.textContent = `⚠ ${stats.toolFailures} 处失败（定位）`;
  } else {
    jump.hidden = true;
  }
}
