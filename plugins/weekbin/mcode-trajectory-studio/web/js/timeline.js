/**
 * The three-lane timeline.
 *
 * The axis is built from the compact timeline projection, not from the paged stream
 * records, so the overview always covers the whole session even while the stream is
 * still loading. Tool spans are measured (from task rows); gaps between records are
 * derived, and the two are visually distinct and labelled.
 */

import { el, state, LANE_ROW_PX, MAX_LANE_ROWS } from './state.js';
import { fmtClock, fmtMs, textNode } from './format.js';
import { banner } from './banner.js';
import { locateRow, locateToolCall } from './intents.js';

function buildAxis(points, tasks) {
  const timed = points.filter((point) => Number.isFinite(point.at));
  if (timed.length === 0) return null;

  const inputItems = [];
  const modelItems = [];
  const toolItems = [];

  for (const point of timed) {
    if (point.role === 'user') {
      inputItems.push({ start: point.at, end: point.at + 1, point, injected: point.injected });
      continue;
    }
    const duration = point.durationMs;
    if (duration && duration > 0) {
      modelItems.push({
        start: point.at - duration,
        end: point.at,
        duration,
        point,
        thinking: Math.min(point.thinkingMs ?? 0, duration),
      });
    }
  }

  for (const task of tasks) {
    if (!Number.isFinite(task.createdAtMs)) continue;
    const end = [task.endedAtMs, task.updatedAtMs, task.createdAtMs].find((value) => Number.isFinite(value)) ?? task.createdAtMs;
    toolItems.push({
      start: task.createdAtMs,
      end: Math.max(end, task.createdAtMs + 1),
      task,
      measured: true,
      failed: task.status === 'failed',
      running: task.status === 'running',
    });
  }

  // Gaps between a finished record and the next model call are time the model was
  // not running. Labelled as derived because only task-backed calls are measured.
  const ordered = [...timed].sort((a, b) => a.at - b.at);
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const gapStart = current.at;
    const gapEnd = next.at - (next.durationMs ?? 0);
    if (gapEnd - gapStart > 250) {
      toolItems.push({ start: gapStart, end: gapEnd, derived: true, measured: false });
    }
  }

  const all = [...inputItems, ...modelItems, ...toolItems];
  const min = Math.min(...all.map((item) => item.start));
  const max = Math.max(...all.map((item) => item.end));
  return { inputItems, modelItems, toolItems, min, max: Math.max(max, min + 1) };
}

function packRows(items) {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const rowEnds = [];
  for (const item of sorted) {
    let row = rowEnds.findIndex((end) => end <= item.start);
    if (row === -1) {
      if (rowEnds.length < MAX_LANE_ROWS) {
        rowEnds.push(item.end);
        row = rowEnds.length - 1;
      } else {
        row = MAX_LANE_ROWS - 1;
        rowEnds[row] = Math.max(rowEnds[row], item.end);
      }
    } else {
      rowEnds[row] = item.end;
    }
    item.row = row;
  }
  return Math.max(1, rowEnds.length);
}

export function renderOverview(points, tasks) {
  state.timeline = points ?? [];
  state.axis = buildAxis(state.timeline, tasks);
  state.view = { start: 0, end: 1 };
  drawOverview();
}

function drawOverview() {
  const host = el('overview');
  host.textContent = '';
  const axis = state.axis;
  if (!axis) {
    host.append(textNode('p', 'muted small', '没有可用的时间戳。'));
    el('overview-hint').textContent = '';
    return;
  }

  const { min, max } = axis;
  const total = max - min;
  const view = state.view;
  const viewStart = min + total * view.start;
  const viewEnd = min + total * view.end;
  const viewSpan = Math.max(1, viewEnd - viewStart);
  const pctOf = (value) => ((value - viewStart) / viewSpan) * 100;
  const inView = (item) => item.end >= viewStart && item.start <= viewEnd;

  const rulerRow = textNode('div', 'ov-row-grid ov-ruler-row');
  rulerRow.append(textNode('div', 'ov-lane-label', ''));
  const ruler = textNode('div', 'ov-ruler');
  for (let index = 0; index <= 6; index += 1) {
    const tick = textNode('div', 'ov-tick', fmtClock(viewStart + (viewSpan * index) / 6));
    tick.style.left = `${(index / 6) * 100}%`;
    // Keep the end labels inside the track: a centred label at 0% or 100% sticks out
    // past the edge and would force a horizontal scrollbar.
    if (index === 0) tick.style.transform = 'translateX(0)';
    else if (index === 6) tick.style.transform = 'translateX(-100%)';
    ruler.append(tick);
  }
  rulerRow.append(ruler);
  host.append(rulerRow);

  const lanes = [
    { key: 'input', label: 'INPUT', items: axis.inputItems, className: (item) => `ov-input${item.injected ? ' is-injected' : ''}` },
    { key: 'model', label: 'MODEL', items: axis.modelItems, className: () => 'ov-model' },
    { key: 'tool', label: 'TOOLS', items: axis.toolItems, className: (item) => `ov-tool${item.derived ? ' is-derived' : ''}${item.failed ? ' is-err' : ''}${item.running ? ' is-running' : ''}` },
  ];

  for (const lane of lanes) {
    const visible = lane.items.filter(inView);
    const rowCount = packRows(visible);
    const grid = textNode('div', 'ov-row-grid ov-lane');
    grid.dataset.lane = lane.key;
    grid.append(textNode('div', 'ov-lane-label', lane.label));

    const track = textNode('div', 'ov-lane-track');
    track.style.height = `${rowCount * LANE_ROW_PX}px`;

    for (const item of visible) {
      const start = Math.max(item.start, viewStart);
      const end = Math.min(item.end, viewEnd);
      const block = textNode('div', `ov-block ${lane.className(item)}`);
      block.style.left = `${pctOf(start)}%`;
      block.style.width = `${Math.max(0, pctOf(end) - pctOf(start))}%`;
      block.style.top = `${item.row * LANE_ROW_PX}px`;

      if (lane.key === 'model' && item.duration) {
        if (item.thinking > 0) {
          const segment = textNode('i', 'ov-seg think');
          segment.style.width = `${(item.thinking / item.duration) * 100}%`;
          block.append(segment);
        }
        const output = item.duration - item.thinking;
        if (output > 0) {
          const segment = textNode('i', 'ov-seg out');
          segment.style.width = `${(output / item.duration) * 100}%`;
          block.append(segment);
        }
      }

      block.title = lane.key === 'tool' && item.task
        ? `${item.task.kind} · ${item.task.status} · ${fmtMs(item.end - item.start)}\n${item.task.description ?? ''}\n点击定位到轨迹流`
        : lane.key === 'tool'
          ? `等待 / 工具执行（推导自记录间隔）· ${fmtMs(item.end - item.start)}`
          : lane.key === 'input'
            ? `${item.injected ? '注入上下文' : '人类输入'} · ${fmtClock(item.point.at)}（点击定位到轨迹流）`
            : `MODEL · ${fmtMs(item.duration)}（思考 ${fmtMs(item.thinking)}）· ${fmtClock(item.point.at)}（点击定位到轨迹流）`;

      block.addEventListener('click', (event) => {
        event.stopPropagation();
        if (lane.key === 'tool' && item.task?.toolCallId) locateToolCall(item.task.toolCallId);
        else if (lane.key === 'tool') banner('这是推导出的等待区间，没有对应的单条记录。');
        else locateRow(item.point.rowId);
      });
      track.append(block);
    }
    if (visible.length === 0) track.append(textNode('p', 'ov-empty muted small', '该通道在当前时间窗内无记录'));
    grid.append(track);
    host.append(grid);
  }

  const zoomed = view.end - view.start < 0.999;
  const stacked = axis.toolItems.some((item) => item.row > 0);
  el('overview-hint').textContent =
    `INPUT（人类 ${axis.inputItems.filter((item) => !item.injected).length} / 注入 ${axis.inputItems.filter((item) => item.injected).length}）` +
    ` · MODEL ${axis.modelItems.length}` +
    ` · TOOLS（实测 ${axis.toolItems.filter((item) => item.measured).length} / 推导 ${axis.toolItems.filter((item) => item.derived).length}）` +
    ` · 全跨度 ${fmtMs(total)} · 窗口 ${fmtMs(viewSpan)}` +
    (zoomed ? ' · 已缩放（双击重置）' : ' · 滚轮缩放，拖拽平移') +
    // A lane growing taller is not a second category — it is concurrency, and saying
    // so avoids the obvious misreading.
    (stacked ? ' · 同一通道出现多行表示这些调用在时间上重叠（并行执行），不是分类' : '');
}

export function bindTimelineControls() {
  const host = el('overview');
  let drag = null;
  const trackWidth = () => host.querySelector('.ov-lane-track')?.getBoundingClientRect().width ?? 0;

  host.addEventListener('wheel', (event) => {
    if (!state.axis || !event.target.closest('.ov-lane-track')) return;
    event.preventDefault();
    const track = host.querySelector('.ov-lane-track');
    const rect = track.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const factor = event.deltaY > 0 ? 1.25 : 0.8;
    const view = state.view;
    const width = Math.min(1, (view.end - view.start) * factor);
    const anchor = view.start + (view.end - view.start) * at;
    let start = anchor - width * at;
    let end = start + width;
    if (start < 0) { start = 0; end = width; }
    if (end > 1) { end = 1; start = Math.max(0, 1 - width); }
    state.view = { start, end };
    drawOverview();
  }, { passive: false });

  host.addEventListener('pointerdown', (event) => {
    if (!state.axis || event.button !== 0) return;
    drag = { x: event.clientX, view: { ...state.view } };
    host.setPointerCapture(event.pointerId);
  });

  host.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const width = drag.view.end - drag.view.start;
    const delta = (event.clientX - drag.x) / Math.max(1, trackWidth());
    const start = Math.min(Math.max(0, drag.view.start - delta * width), 1 - width);
    state.view = { start, end: start + width };
    drawOverview();
  });

  const stopDrag = (event) => {
    if (!drag) return;
    drag = null;
    try { host.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  };
  host.addEventListener('pointerup', stopDrag);
  host.addEventListener('pointercancel', stopDrag);
  host.addEventListener('dblclick', () => {
    if (!state.axis) return;
    state.view = { start: 0, end: 1 };
    drawOverview();
  });
}
