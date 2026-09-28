/**
 * The inspector: the full detail of exactly one selected row.
 *
 * Three tabs — 概要 / 载荷·结果 / 计时 — each answering a different question about the
 * same record. Payload and result share one tab because the question that matters is
 * "what was sent, and what came back", which should not need a click back and forth.
 *
 * There is no Schema tab: the runtime does not persist a tool's input schema in the
 * session data, so a tab for it could only ever say "unavailable". An empty surface
 * is worse than no surface.
 */

import { el, state } from './state.js';
import { fmtMs, fmtTokens, fmtClock, fmtFull, textNode, prettyJson } from './format.js';
import { parseResult, failureExcerpt } from './results.js';

function statRow(list, key, value) {
  list.append(textNode('dt', '', key));
  list.append(textNode('dd', '', value === null || value === undefined ? '—' : String(value)));
}

function selectedPayload() {
  const selected = state.selected;
  if (!selected) return null;
  const event = state.events.find((item) => item.index === selected.eventIndex);
  if (!event) return null;
  const call = selected.kind === 'tool' ? event.toolCalls?.[selected.position] ?? null : null;
  return { event, call };
}

export function openInspector(selection) {
  state.selected = selection;
  refreshSelectionHighlight();
  el('inspector').setAttribute('data-open', 'true');
  document.body.dataset.inspector = 'true';
  renderInspector();
}

export function closeInspector() {
  el('inspector').setAttribute('data-open', 'false');
  document.body.dataset.inspector = 'false';
  state.selected = null;
  refreshSelectionHighlight();
}

/** Toggle the selected styling in place instead of re-rendering the whole stream. */
function refreshSelectionHighlight() {
  for (const node of el('stream').querySelectorAll('.srow[aria-selected]')) node.removeAttribute('aria-selected');
  const selected = state.selected;
  if (!selected) return;
  for (const node of el('stream').querySelectorAll(`[data-event-index="${CSS.escape(String(selected.eventIndex))}"]`)) {
    if (selected.kind === 'tool') {
      if (node.dataset.position === String(selected.position)) node.setAttribute('aria-selected', 'true');
    } else if (node.classList.contains('srow-message')) {
      node.setAttribute('aria-selected', 'true');
    }
  }
}

export function renderInspector() {
  const payload = selectedPayload();
  const body = el('ins-body');
  body.textContent = '';
  if (!payload) {
    el('ins-title').textContent = '检查器';
    el('ins-sub').textContent = '';
    body.append(textNode('p', 'muted', '点击轨迹流中的任意一行查看详情。'));
    return;
  }
  const { event, call } = payload;

  el('ins-title').textContent = call ? `工具调用 · ${call.name ?? 'tool'}` : `记录 #${event.index}`;
  el('ins-sub').textContent = `${event.turnId ?? '无轮次'} · ${fmtClock(event.createdAtMs)}`;

  for (const tab of el('ins-tabs').querySelectorAll('.ins-tab')) {
    tab.classList.toggle('is-on', tab.dataset.tab === state.tab);
  }

  const tab = ['summary', 'payload', 'timing'].includes(state.tab) ? state.tab : 'summary';
  if (tab === 'summary') renderSummaryTab(body, event, call);
  else if (tab === 'payload') renderPayloadAndResultTab(body, event, call);
  else renderTimingTab(body, event, call);
}

function renderSummaryTab(body, event, call) {
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '概要'));
  const dt = document.createElement('dl');
  dt.className = 'kv';
  statRow(dt, '层级', call
    ? `${event.role === 'assistant' ? 'Assistant Message' : event.role} › Tool Call ${call.position ?? ''}`
    : event.role);
  statRow(dt, '状态', call
    ? (call.ok === false ? `失败（状态码 ${call.status}）` : call.taskStatus === 'failed' ? '任务失败' : call.ok ? '完成' : '未知')
    : (event.finishReason ?? (event.requestDurationMs ? '完成' : '—')));
  statRow(dt, '输入类型', event.inputKind === 'injected' ? `注入上下文 (${event.originType ?? 'harness'})` :
    event.inputKind === 'human' ? '人类输入' : '—');
  statRow(dt, 'source', event.source);
  statRow(dt, 'turn_id', event.turnId);
  statRow(dt, 'msg_id', event.msgId);
  if (call) {
    statRow(dt, 'call_id', call.id);
    statRow(dt, '任务 ID', call.taskId);
    statRow(dt, '子代理', call.agentName);
    statRow(dt, '子会话', call.childSessionId);
  }
  section.append(dt);
  body.append(section);

  if (event.usage) {
    const usage = textNode('section', 'ins-section');
    usage.append(textNode('h4', '', 'Token 用量'));
    const ud = document.createElement('dl');
    ud.className = 'kv';
    statRow(ud, '输入', event.usage.inputTokens);
    statRow(ud, '输出', event.usage.outputTokens);
    statRow(ud, '缓存读取', event.usage.cacheReadTokens);
    statRow(ud, '总计', event.usage.totalTokens);
    statRow(ud, '上下文窗口', event.usage.contextWindowTokens);
    usage.append(ud);
    body.append(usage);
  }

  if (event.contextUsage?.components) {
    const ctx = textNode('section', 'ins-section');
    ctx.append(textNode('h4', '', `上下文分解 · 已用 ${fmtTokens(event.contextUsage.usedTokens)}` +
      `${event.contextUsage.totalCountSource ? ` (${event.contextUsage.totalCountSource})` : ''}`));
    const cd = document.createElement('dl');
    cd.className = 'kv';
    for (const part of event.contextUsage.components) statRow(cd, part.kind, fmtTokens(part.tokens));
    ctx.append(cd);
    body.append(ctx);
  }

  if (event.metadata) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '压缩元数据'));
    section.append(textNode('pre', 'block', JSON.stringify(event.metadata, null, 2)));
    body.append(section);
  }
}

/**
 * Payload and result in one view.
 *
 * They were separate tabs, which forced a click back and forth to answer the only
 * question that matters — what was sent, and what came back.
 */
function renderPayloadAndResultTab(body, event, call) {
  renderPayloadTab(body, event, call);
  renderResultTab(body, event, call);
}

function renderPayloadTab(body, event, call) {
  if (call) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '工具入参'));
    if (call.args === null || call.args === undefined) {
      section.append(textNode('p', 'muted small', '入参为空。'));
    } else {
      section.append(textNode('pre', 'block', prettyJson(call.args)));
    }
    if (call.description) {
      section.append(textNode('h4', '', '任务描述'));
      section.append(textNode('pre', 'block', call.description));
    }
    body.append(section);
    if (event.thinking) {
      const thinking = textNode('section', 'ins-section');
      thinking.append(textNode('h4', '', '同轮思考'));
      thinking.append(textNode('pre', 'block', event.thinking));
      body.append(thinking);
    }
    return;
  }

  if (event.thinking) {
    const section = textNode('section', 'ins-section');
    section.append(textNode('h4', '', '思考'));
    section.append(textNode('pre', 'block', event.thinking));
    body.append(section);
  }
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '正文'));
  section.append(textNode('pre', 'block', event.content || '（无正文）'));
  body.append(section);
}

function renderResultTab(body, event, call) {
  if (!call) {
    body.append(textNode('p', 'muted small', '该记录不是工具调用。选中轨迹流里的 TOOL 行可查看结果。'));
    return;
  }
  const parsed = parseResult(call.result);
  if (!parsed.text && call.ok === false) {
    body.append(textNode('p', 'muted small', '调用标记为失败，但运行时未落盘结果文本。'));
    return;
  }
  if (!parsed.text) {
    body.append(textNode('p', 'muted small', '没有结果文本。'));
    return;
  }

  if (parsed.failed) {
    const alert = textNode('section', `ins-section ins-alert${parsed.severity === 'hard' ? ' is-hard' : ''}`);
    alert.append(textNode('h4', '', `失败证据 · ${parsed.signal}`));
    const evidence = document.createElement('dl');
    evidence.className = 'kv';
    statRow(evidence, '运行时错误标记', parsed.isError ? 'is_error: true' : '—');
    statRow(evidence, '退出码', parsed.exitCode === null ? '未报告' : String(parsed.exitCode));
    statRow(evidence, '调用状态码', call.status);
    statRow(evidence, '判级', parsed.severity === 'hard'
      ? '硬失败（Traceback / stderr / 运行时报错）'
      : '软失败（命令非零退出，常见于 grep 无匹配等，请自行判断）');
    alert.append(evidence);
    alert.append(textNode('pre', 'block', failureExcerpt(parsed.text)));
    body.append(alert);
  }

  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', `完整结果（${parsed.text.length} 字符）`));
  section.append(textNode('pre', 'block', parsed.text));
  body.append(section);

  if (parsed.details) {
    const details = textNode('section', 'ins-section');
    details.append(textNode('h4', '', '附带细节'));
    details.append(textNode('pre', 'block', JSON.stringify(parsed.details, null, 2)));
    body.append(details);
  }
}

function renderTimingTab(body, event, call) {
  const section = textNode('section', 'ins-section');
  section.append(textNode('h4', '', '计时'));
  const dt = document.createElement('dl');
  dt.className = 'kv';
  statRow(dt, '记录时刻', fmtFull(event.createdAtMs));
  statRow(dt, '模型请求耗时', fmtMs(event.requestDurationMs));
  statRow(dt, '思考耗时', fmtMs(event.thinkingDurationMs));
  if (event.requestDurationMs && event.thinkingDurationMs !== null) {
    statRow(dt, '输出耗时(近似)', fmtMs(Math.max(0, event.requestDurationMs - event.thinkingDurationMs)));
  }
  if (call) {
    statRow(dt, '工具耗时(实测)', call.durationMs === null ? '运行时未记录' : fmtMs(call.durationMs));
    statRow(dt, '耗时来源', call.durationMs === null
      ? '该调用不是后台任务，没有独立计时，不做估算'
      : 'local_runtime_background_tasks 的 ended_at_ms − created_at_ms');
  }
  statRow(dt, 'finish_reason', event.finishReason);
  section.append(dt);

  if (event.requestDurationMs) {
    section.append(buildDurationBar(event));
  } else {
    // Say why there is no bar, so an empty area does not read as a broken panel.
    section.append(textNode('p', 'bar-note muted small', call
      ? '这条记录没有模型请求耗时（工具调用本身不产生模型请求），因此没有时长条；工具耗时见上方「工具耗时(实测)」。'
      : '这条记录没有模型请求耗时（运行时未记录 request_duration_ms），因此没有时长条可画。'));
  }
  body.append(section);
}

/**
 * The request-duration bar, with its own legend.
 *
 * Two segments share the axis: thinking, and everything after it. The runtime
 * records the thinking duration but not the first-token instant, so the second
 * segment is derived rather than measured — the legend and the note both say so,
 * and when no thinking duration was recorded the bar is drawn as one honest span
 * instead of inventing a split.
 */
function buildDurationBar(event) {
  const wrap = textNode('div', 'duration-bar');
  const total = event.requestDurationMs;
  const hasThinking = event.thinkingDurationMs !== null && event.thinkingDurationMs !== undefined;
  const recorded = hasThinking ? Math.max(0, event.thinkingDurationMs) : 0;
  const thinking = Math.min(recorded, total);
  const output = Math.max(0, total - thinking);
  // The runtime's two timings disagree on a small share of records: the recorded
  // thinking duration can equal or exceed the whole request. Clamping silently would
  // draw a 0 ms output segment and imply a split that was never measured.
  const overshoot = hasThinking && recorded > total;

  const segments = [];
  if (thinking > 0) segments.push({ cls: 'is-think', ms: thinking, label: '思考段' });
  if (output > 0) segments.push({ cls: 'is-out', ms: output, label: hasThinking ? '输出段' : '全程' });
  if (segments.length === 0) segments.push({ cls: 'is-out is-whole', ms: total, label: '全程' });

  const bar = textNode('div', 'bars');
  for (const segment of segments) {
    const node = textNode('i', `bar-seg ${segment.cls}`);
    node.style.width = `${(segment.ms / total) * 100}%`;
    node.title = `${segment.label} ${fmtMs(segment.ms)}`;
    bar.append(node);
  }
  wrap.append(bar);

  const legend = textNode('div', 'bar-legend');
  for (const segment of segments) {
    const item = textNode('span', 'bar-legend-item');
    item.append(textNode('i', `bar-swatch ${segment.cls.replace(' is-whole', '')}`));
    const approximate = segment.cls.startsWith('is-out') && hasThinking && !overshoot ? '（近似）' : '';
    item.append(textNode('span', '', `${segment.label} ${fmtMs(segment.ms)}${approximate}`));
    legend.append(item);
  }
  legend.append(textNode('span', 'bar-legend-total', `合计 ${fmtMs(total)}`));
  wrap.append(legend);

  let note;
  if (overshoot) {
    note = `运行时为这条记录记下的思考耗时（${fmtMs(recorded)}）不小于请求耗时（${fmtMs(total)}），` +
      '两个数值互相矛盾，因此只按思考段绘制，不推导输出段。';
  } else if (hasThinking) {
    note = '紫色＝思考段（运行时记录）；绿色＝输出段＝请求耗时 − 思考耗时。' +
      '运行时不记录首 token 时刻，所以输出段是推导值，不是实测解码时间。';
  } else {
    note = '本条记录没有思考段（运行时未记录 thinking_duration_ms），整段按请求耗时绘制，不做拆分。';
  }
  wrap.append(textNode('p', 'bar-note muted small', note));
  return wrap;
}
