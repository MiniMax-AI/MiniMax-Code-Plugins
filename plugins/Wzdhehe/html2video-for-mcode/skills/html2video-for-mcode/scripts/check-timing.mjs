#!/usr/bin/env node
// html2video-for-mcode · 对时校验: 用静音检测实测每句口播的真实开口时刻, 与 plan-timings 的字数估算对比。
// 用法: node check-timing.mjs <项目目录> [--calibrate]
//   默认只输出对比表; --calibrate 把实测边界写回 build/timings.json 的 clauses[].start 与 stages{}。
// 原理: TTS 在句间(。!?;)会留 0.2s+ 的停顿 → ffmpeg silencedetect 找句间静音 → 边界后即下一句开口。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { positionalDir, requireTool, safeId, safeOut, safeRel, validateScriptPaths, validateTimingsIds } from './tools.mjs';

const argv = process.argv.slice(2);
const dir = positionalDir(argv);
const CALIBRATE = argv.includes('--calibrate');
const LEAD = 0.2;
const NOISE = '-38dB', MIN_SIL = 0.18; // 句间停顿检测阈值

process.env.KIT_PROJECT_DIR = dir;
const FFMPEG = requireTool('ffmpeg', dir);

const timingsPath = safeOut(dir, 'build', 'timings.json');   // 写回走收监(读不到时下面会报缺文件)
if (!fs.existsSync(timingsPath)) { console.error('✗ 缺 build/timings.json — 先运行 plan-timings.mjs'); process.exit(1); }
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
validateTimingsIds(timings);
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
validateScriptPaths(script, dir);

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
  const meas = new Array(nBound).fill(null);   // 精确模式自己一份
  if (gaps.length === totalMarks - 1 || gaps.length === totalMarks) {
    let cum = 0, gi = 0;
    for (let k = 0; k < nBound; k++) {
      cum += marks[k]; // 第 k 边界 = 前 k 句累积标点数对应的那个停顿
      const idx = Math.min(cum - 1, gaps.length - 1);
      if (idx >= gi) { meas[k] = gaps[idx].end; gi = idx + 1; }
    }
    if (meas.every(v => v != null)) return { method: 'exact', meas };
  }
  // 最近邻: **重新分配**, 绝不从上面那份里继承已填值 —— 继承的话写回的就是"精确 + 最近邻"的
  // 混合值, 而 method 只报 nearest, 属于谎报方法(2026-09-18 复查 D1: 精确模式失败即走到此处)。
  const near = new Array(nBound).fill(null);
  const est = clauses.slice(1).map(c => c.start);
  let lastUsed = -1;
  for (let k = 0; k < nBound; k++) {
    let best = -1, bestD = Infinity;
    for (let g = lastUsed + 1; g < gaps.length; g++) {
      const d = Math.abs(gaps[g].end - est[k]);
      if (d < bestD && d <= 1.0) { bestD = d; best = g; }
    }
    if (best > -1) { near[k] = gaps[best].end; lastUsed = best; }
  }
  // 只有**每条边界都有实测**才叫 nearest(可写回); 有缺口的报 sparse, 只展示不写回
  return { method: near.every(v => v != null) ? 'nearest' : 'sparse', meas: near };
}

const report = [];
let calibratable = 0;
for (const t of timings.slides) {
  if (!t.clauses || t.clauses.length < 2) continue;
  const tid = safeId(t.id);
  const audioPath = safeRel(path.join(dir, 'audio'), script.slides.find(s => s.id === tid)?.audio ?? `${tid}.mp3`, { where: `slides[${tid}].audio` });
  if (!fs.existsSync(audioPath)) { console.warn(`- 跳过 ${tid}: 缺音频`); continue; }
  const gaps = detectGaps(audioPath, t.tts);
  const { method, meas } = matchBoundaries(gaps, t.clauses);
  // complete = 这份实测**整份可信**(exact/nearest 两条路都是全命中才返回); sparse 有缺口,
  // 只展示不写回 —— 半份实测混着估算写进 timings.json 会让下游拿到自相矛盾的时刻。
  const complete = (method === 'exact' || method === 'nearest') && meas.length > 0 && meas.every(v => v != null);
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
const methodLabel = { exact: '精确(标点对齐)', nearest: '最近邻(全命中)', sparse: '静音段不足(未写回)', none: '-' };
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
  else console.log('已按实测校准(仅精确/最近邻全命中的 slide; 有缺口的只展示不写回)。');
}
if (CALIBRATE) {
  // 一张都没有全命中时不要动文件: 内容没变也该保持字节不变(重排 + 补行尾会让 diff 与
  // "文件有没有被改"这件事说谎; 2026-09-18 复查 D1)
  if (!calibratable) {
    console.log(`没有一张 slide 的句边界被全部实测到, 未改动 ${timingsPath}(见上面的匹配方法与"(未测)"项)`);
    process.exit(0);
  }
  fs.writeFileSync(timingsPath, JSON.stringify(timings, null, 2) + '\n');
  console.log(`✓ 已写回 ${timingsPath} (校准 ${calibratable}/${report.length} 张, 仅全部句边界都有实测的 slide; 方法 exact/nearest 才算全命中)。下一步: 删 build/frames/ 后重跑 capture --mode motion 与 build-video。`);
}
