#!/usr/bin/env node
// html2video-for-mcode · 对时校验: 用静音检测实测每句口播的真实开口时刻, 与 plan-timings 的字数估算对比。
// 用法: node check-timing.mjs <项目目录> [--calibrate]
//   默认只输出对比表; --calibrate 把实测边界写回 build/timings.json 的 clauses[].start 与 stages{}。
// 原理: TTS 在句间(。!?;)会留 0.2s+ 的停顿 → ffmpeg silencedetect 找句间静音 → 边界后即下一句开口。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireTool } from './tools.mjs';

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const CALIBRATE = argv.includes('--calibrate');
const LEAD = 0.2;
const NOISE = '-38dB', MIN_SIL = 0.18; // 句间停顿检测阈值

process.env.KIT_PROJECT_DIR = dir;
const FFMPEG = requireTool('ffmpeg', dir);

const timingsPath = path.join(dir, 'build', 'timings.json');
if (!fs.existsSync(timingsPath)) { console.error('✗ 缺 build/timings.json — 先运行 plan-timings.mjs'); process.exit(1); }
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));

function detectGaps(file, tts) {
  const r = spawnSync(FFMPEG, ['-i', file, '-af', `silencedetect=noise=${NOISE}:d=${MIN_SIL}`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const text = (r.stderr || '') + (r.stdout || '');
  const starts = [...text.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const ends = [...text.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const gaps = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i], e = ends[i] ?? tts;
    if (s > 0.15 && e < tts - 0.15) gaps.push({ start: s, end: e });
  }
  return gaps;
}

// 句间边界匹配: 静音段里混着句内逗号停顿, 不能假设段数=句数-1。
// 精确模式: 句读标点总数-1 == 静音段数 → 按标点累积下标对齐(最可信)。
// 最近邻模式: 否则在估算时刻 ±1s 窗内取最近的静音段末端, 时序单调; 找不到就报未测(宁缺勿错)。
const PAUSE_PUNCT = /[，,、;；:：。！？!?…]/g;
function matchBoundaries(gaps, clauses) {
  const nBound = clauses.length - 1;
  if (nBound <= 0) return { method: 'none', meas: [] };
  const marks = clauses.map(c => (c.text.match(PAUSE_PUNCT) || []).length);
  const totalMarks = marks.reduce((a, b) => a + b, 0);
  const meas = new Array(nBound).fill(null);
  if (gaps.length === totalMarks - 1 || gaps.length === totalMarks) {
    let cum = 0, gi = 0;
    for (let k = 0; k < nBound; k++) {
      cum += marks[k]; // 第 k 边界 = 前 k 句累积标点数对应的那个停顿
      const idx = Math.min(cum - 1, gaps.length - 1);
      if (idx >= gi) { meas[k] = gaps[idx].end; gi = idx + 1; }
    }
    if (meas.every(v => v != null)) return { method: 'exact', meas };
  }
  const est = clauses.slice(1).map(c => c.start);
  let lastUsed = -1;
  for (let k = 0; k < nBound; k++) {
    let best = -1, bestD = Infinity;
    for (let g = lastUsed + 1; g < gaps.length; g++) {
      const d = Math.abs(gaps[g].end - est[k]);
      if (d < bestD && d <= 1.0) { bestD = d; best = g; }
    }
    if (best > -1) { meas[k] = gaps[best].end; lastUsed = best; }
  }
  return { method: gaps.length >= nBound ? 'nearest' : 'sparse', meas };
}

const report = [];
let calibratable = 0;
for (const t of timings.slides) {
  if (!t.clauses || t.clauses.length < 2) continue;
  const audioPath = path.join(dir, 'audio', script.slides.find(s => s.id === t.id)?.audio ?? `${t.id}.mp3`);
  if (!fs.existsSync(audioPath)) { console.warn(`- 跳过 ${t.id}: 缺音频`); continue; }
  const gaps = detectGaps(audioPath, t.tts);
  const { method, meas } = matchBoundaries(gaps, t.clauses);
  const complete = meas.length > 0 && meas.every(v => v != null);
  if (complete) calibratable++;

  const rowsForSlide = t.clauses.slice(1).map((c, k) => ({
    clause: k + 2, est: +c.start.toFixed(2),
    meas: meas[k] == null ? null : +meas[k].toFixed(2),
    diff: meas[k] == null ? null : +(meas[k] - c.start).toFixed(2),
  }));
  report.push({ id: t.id, method, gaps: gaps.length, need: t.clauses.length - 1, rows: rowsForSlide });

  if (CALIBRATE && complete) {
    // 实测边界写回: clauses[].start 与 stage 入场时刻(stage s = 最早属于 s 的句的实测开口 − LEAD)
    t.clauses.forEach((c, i) => { if (i > 0 && meas[i - 1] != null) c.start = Math.round(meas[i - 1] * 1000) / 1000; });
    t.clauses.forEach((c, i) => { c.dur = Math.round(((t.clauses[i + 1]?.start ?? t.tts) - c.start) * 1000) / 1000; });
    const stageTime = {};
    for (const c of t.clauses) {
      if (c.stage == null) continue;
      const v = Math.max(0, c.start - LEAD);
      stageTime[c.stage] = c.stage in stageTime ? Math.min(stageTime[c.stage], v) : v;
    }
    const slide = script.slides.find(s => s.id === t.id);
    Object.assign(stageTime, slide?.stageTimes ?? {}); // 作者显式覆盖仍然优先
    t.stages = stageTime;
  }
}

if (!report.length) { console.log('所有 slide 都只有单句, 无句间边界可校验。'); process.exit(0); }

let drift = 0, driftN = 0, worst = null;
const methodLabel = { exact: '精确(标点对齐)', nearest: '最近邻', sparse: '静音段不足', none: '-' };
console.log('\n对时对比(估算 vs 静音检测实测):');
for (const r of report) {
  console.log(`  ${r.id}: 静音段 ${r.gaps} / 句边界 ${r.need} · 匹配 ${methodLabel[r.method]}`);
  for (const row of r.rows) {
    if (row.diff != null) { drift += Math.abs(row.diff); driftN++; if (!worst || Math.abs(row.diff) > Math.abs(worst.diff)) worst = { ...row, id: r.id }; }
    console.log(`    第${row.clause}句开口 估算 ${row.est}s | 实测 ${row.meas ?? '(未测)'}s | 差 ${row.diff ?? '-'}s`);
  }
}
if (driftN) {
  const avg = (drift / driftN).toFixed(2);
  console.log(`\n平均偏差 ${avg}s, 最大 ${worst ? worst.id + ' 第' + worst.clause + '句 ' + worst.diff + 's' : '-'}`);
  if (!CALIBRATE) console.log('偏差普遍 >0.3s 时, 用 --calibrate 按实测校准后重跑 capture/build-video。');
  else console.log('已按实测校准(仅静音段数完全匹配的 slide)。');
}
if (CALIBRATE) {
  fs.writeFileSync(timingsPath, JSON.stringify(timings, null, 2) + '\n');
  console.log(`✓ 已写回 ${timingsPath} (校准 ${calibratable}/${report.length} 张, 仅全部句边界都有实测的 slide)。下一步: 删 build/frames/ 后重跑 capture --mode motion 与 build-video。`);
}
