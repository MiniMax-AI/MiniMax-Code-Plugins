/**
 * The trajectory stream.
 *
 * One scannable line per message and per tool call, in insert order, grouped by
 * turn. Rows are cached and paged: `applyFilters` never rebuilds the DOM, and
 * appends only ever add the next batch, because rebuilding was what was slow — not
 * matching.
 */

import { el, state, STREAM_PAGE, MAX_STREAM_ROWS } from './state.js';
import { fmtMs, fmtTokens, oneLine, textNode, payloadPreview } from './format.js';
import { parseResult, toolFailed } from './results.js';
import { openInspector, selectSession } from './intents.js';

/** Flatten events into scannable rows: one per message, one per tool call. */
function buildStream(events) {
  const rows = [];
  for (const event of events) {
    rows.push({ kind: 'message', event });
    for (const [position, call] of (event.toolCalls ?? []).entries()) {
      rows.push({ kind: 'tool', event, call, position });
    }
  }
  return rows;
}

/** Everything a row can be matched against, as one lowercase string. */
function rowHaystack(row) {
  const parts = row.kind === 'tool'
    ? [row.call.name, row.call.description, row.call.args, row.call.result, row.call.agentName]
    : [row.event.content, row.event.thinking, row.event.originType, row.event.turnId, row.event.source];
  return parts.filter((part) => typeof part === 'string' && part).join(' ').toLowerCase();
}

function rowMatchesFilter(row) {
  switch (state.rowFilter) {
    case 'human': return row.kind === 'message' && row.event.role === 'user' && row.event.inputKind === 'human';
    case 'injected': return row.kind === 'message' && row.event.inputKind === 'injected';
    case 'tools': return row.kind === 'tool';
    case 'failed': return row.kind === 'tool' && toolFailed(row.call);
    default: return true;
  }
}

/** Filter over the cached rows. Rebuilding the DOM is what was slow, not matching. */
function applyFilters() {
  const rows = state.streamRows ?? (state.streamRows = buildStream(state.events));
  const needle = state.textQuery.toLowerCase();
  state.filteredRows = rows.filter((row) => {
    if (!rowMatchesFilter(row)) return false;
    if (state.turnQuery && !String(row.event.turnId ?? '').includes(state.turnQuery)) return false;
    if (needle && !rowHaystack(row).includes(needle)) return false;
    return true;
  });
  state.renderedRows = 0;
  state.lastTurn = undefined;
}

function turnHeader(turnId) {
  const summary = turnId ? state.turns.get(turnId) : null;
  const ordinal = turnId ? state.turnOrder.indexOf(turnId) : -1;
  const head = textNode('div', 'turn-head');
  // Humans count turns; the runtime's turn id is a hash. Lead with the number and
  // keep the id as secondary text rather than the other way round.
  head.append(textNode('span', 'th-ordinal', ordinal >= 0 ? `第 ${ordinal + 1} 轮` : '未分轮'));
  head.append(textNode('span', 'th-id', turnId ? String(turnId) : '(无轮次)'));
  if (summary) head.append(textNode('span', '', `${summary.count} 条`));
  const agg = textNode('div', 'th-agg');
  if (summary) {
    agg.append(textNode('span', '', `LLM ${fmtMs(summary.llmMs)}`));
    agg.append(textNode('span', '', `out ${fmtTokens(summary.outputTokens)} tok`));
  }
  head.append(agg);
  return head;
}

/** Append the next batch of rows. Rows already in the DOM are never rebuilt. */
export function appendStreamRows(reset = false) {
  const host = el('stream');
  const rows = state.filteredRows ?? [];
  if (reset) {
    host.textContent = '';
    state.renderedRows = 0;
    state.lastTurn = undefined;
  }
  const total = Math.min(rows.length, MAX_STREAM_ROWS);
  const end = Math.min(total, state.renderedRows + STREAM_PAGE);
  if (state.renderedRows >= end) return false;

  const fragment = document.createDocumentFragment();
  for (let index = state.renderedRows; index < end; index += 1) {
    const row = rows[index];
    const turnId = row.event.turnId ?? null;
    if (turnId !== state.lastTurn) {
      state.lastTurn = turnId;
      fragment.append(turnHeader(turnId));
    }
    fragment.append(row.kind === 'tool' ? renderToolRow(row) : renderMessageRow(row));
  }
  // The sentinel is replaced on every append so it stays last.
  el('stream-more')?.remove();
  host.append(fragment);
  state.renderedRows = end;

  if (end < total) {
    const more = textNode('button', 'stream-more', `加载更多（已显示 ${end} / ${total} 行）`);
    more.id = 'stream-more';
    more.type = 'button';
    more.addEventListener('click', () => appendStreamRows());
    host.append(more);
  } else if (rows.length > MAX_STREAM_ROWS) {
    host.append(textNode('p', 'muted small stream-end',
      `仅渲染前 ${MAX_STREAM_ROWS} 行。请用筛选缩小范围。`));
  } else {
    host.append(textNode('p', 'muted small stream-end', `已显示全部 ${total} 行`));
  }
  return true;
}

export function renderStream() {
  applyFilters();
  appendStreamRows(true);
  updateStreamCount();
}

/**
 * The record count, and how much of the session it covers.
 *
 * `streamRows` holds one row per message *and* per tool call, so it is not a record
 * count at all — and it holds only the pages that have been loaded. The server's
 * count for the whole session is `eventsTotal`. A session of 20 records with 7 of
 * them loaded used to read "7 行", which is a partial page presented as the whole
 * session; when the two differ the label has to carry both.
 */
export function updateStreamCount() {
  const label = el('record-count');
  if (!label) return;
  const loaded = state.events?.length ?? 0;
  const rows = state.streamRows?.length ?? 0;
  const shown = state.filteredRows?.length ?? 0;
  const total = state.eventsTotal;
  let scope;
  if (typeof total === 'number' && total > loaded) {
    scope = `已加载 ${loaded} / ${total} 行`;
  } else if (typeof total !== 'number' && loaded > 0 && state.nextOffset !== null) {
    // No count arrived with the page — the JSONL fallback sends none — so the honest
    // claim is "this much, so far", not a number that looks like a session size.
    scope = `已加载 ${loaded} 行（总数未知）`;
  } else {
    scope = `${loaded} 行`;
  }
  label.textContent = shown === rows ? scope : `${scope}（筛选后 ${shown} 行）`;
  label.title = typeof total === 'number'
    ? `服务端统计该会话共 ${total} 条记录`
    : '服务端未给出该会话的记录总数';
}

function markSelected(node, isTool, position) {
  const selected = state.selected;
  if (!selected) return;
  if (node.dataset.eventIndex !== String(selected.eventIndex)) return;
  if (isTool) {
    if (node.dataset.position === String(position)) node.setAttribute('aria-selected', 'true');
    return;
  }
  if (selected.kind === 'message') node.setAttribute('aria-selected', 'true');
}

function renderMessageRow(row) {
  const event = row.event;
  const injected = event.inputKind === 'injected';
  const node = textNode('div', `srow srow-message${injected ? ' is-injected' : ''}${event.role === 'user' ? ' is-user' : ''}`);
  node.dataset.eventIndex = String(event.index);
  node.dataset.rowId = String(event.rowId ?? event.index);
  markSelected(node, false);

  const badge = textNode('div', 'srow-badge');
  if (event.role === 'user') {
    badge.append(textNode('span', `badge ${injected ? 'badge-injected' : 'badge-human'}`, injected ? '注入' : 'INPUT'));
    if (injected && event.originType) badge.append(textNode('span', 'badge-note', oneLine(event.originType, 26)));
  } else {
    badge.append(textNode('span', 'badge badge-assistant', 'ASSISTANT'));
  }
  node.append(badge);

  const body = textNode('div', 'srow-body');
  const text = typeof event.content === 'string' ? event.content.trim() : '';
  const thinking = typeof event.thinking === 'string' ? event.thinking.trim() : '';
  const names = (event.toolCalls ?? []).map((call) => call.name).filter(Boolean);
  if (text) {
    const line = textNode('div', 'srow-text', oneLine(text, 400));
    line.title = text.slice(0, 2000);
    body.append(line);
  } else if (thinking) {
    const line = textNode('div', 'srow-text is-thinking', `[思考] ${oneLine(thinking, 400)}`);
    line.title = thinking.slice(0, 2000);
    body.append(line);
  } else if (names.length) {
    body.append(textNode('div', 'srow-text is-dim', `(仅工具调用: ${names.join(', ')})`));
  } else if (event.kind) {
    body.append(textNode('div', 'srow-text is-dim', event.kind));
  } else {
    body.append(textNode('div', 'srow-text is-dim', '(空记录)'));
  }

  // Marker chips sit inline on the same line rather than in a second row, so every
  // stream row keeps the same one-line rhythm.
  if (event.kind === 'compaction') body.append(textNode('span', 'tool-tag is-compact', '压缩'));
  if (event.kind === 'compaction_failed') body.append(textNode('span', 'tool-tag is-fail', '压缩失败'));
  if (event.hasThinking && text) body.append(textNode('span', 'tool-tag is-think', '思考'));
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  if (event.requestDurationMs) meta.append(textNode('span', '', fmtMs(event.requestDurationMs)));
  if (event.thinkingDurationMs) meta.append(textNode('span', 'is-think', `思${fmtMs(event.thinkingDurationMs)}`));
  if (event.usage?.outputTokens) meta.append(textNode('span', 'is-dim', `${fmtTokens(event.usage.outputTokens)} tok`));
  node.append(meta);

  node.addEventListener('click', () => openInspector({ kind: 'message', eventIndex: event.index }));
  return node;
}

function renderToolRow(row) {
  const { call, event, position } = row;
  const failed = toolFailed(call);
  const parsed = parseResult(call.result);

  const node = textNode('div', `srow srow-tool${failed ? ' is-fail' : ''}${parsed.severity === 'hard' ? ' is-hard' : ''}`);
  node.dataset.eventIndex = String(event.index);
  node.dataset.position = String(position);
  node.dataset.rowId = String(event.rowId ?? event.index);
  node.dataset.toolCallId = call.id ?? '';
  markSelected(node, true, position);

  const badge = textNode('div', 'srow-badge');
  badge.append(textNode('span', 'badge badge-tool', 'TOOL'));
  node.append(badge);

  // Every part is a direct child of the flex body, so the row stays one line and the
  // result text is what absorbs the remaining width.
  const body = textNode('div', 'srow-body');
  body.append(textNode('span', 'tool-name', call.name ?? 'tool'));
  const payload = payloadPreview(call.args) || call.description;
  if (payload) {
    body.append(textNode('span', 'tool-arrow', '▸'));
    const payloadNode = textNode('span', 'tool-payload', oneLine(payload, 150));
    payloadNode.title = typeof call.args === 'string' ? call.args.slice(0, 2000) : '';
    body.append(payloadNode);
  }
  if (parsed.text) {
    body.append(textNode('span', 'tool-arrow', '⇉'));
    const resultNode = textNode('span', `tool-result${parsed.failed ? ' is-fail' : ''}`, oneLine(parsed.text, 200));
    resultNode.title = parsed.text.slice(0, 2000);
    body.append(resultNode);
  }
  if (parsed.signal) {
    body.append(textNode('span', `sig sig-${parsed.severity}`, `⚠ ${parsed.signal}`));
  }
  node.append(body);

  const meta = textNode('div', 'srow-meta');
  meta.append(call.durationMs !== null
    ? textNode('span', '', fmtMs(call.durationMs))
    : textNode('span', 'is-dim', '—'));
  if (call.agentName) meta.append(textNode('span', 'is-sub', `↳ ${call.agentName}`));
  if (call.childSessionId) {
    const drill = document.createElement('button');
    drill.type = 'button';
    drill.className = 'mini-btn';
    drill.textContent = '子会话 ↗';
    drill.title = call.childSessionId;
    drill.addEventListener('click', (clickEvent) => {
      clickEvent.stopPropagation();
      selectSession(call.childSessionId);
    });
    meta.append(drill);
  }
  node.append(meta);

  node.addEventListener('click', () => openInspector({ kind: 'tool', eventIndex: event.index, position }));
  return node;
}
