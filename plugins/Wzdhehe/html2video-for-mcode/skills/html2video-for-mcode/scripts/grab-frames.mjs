#!/usr/bin/env node
// html2video-for-mcode · 成片抽帧核对: 按 build/timings.json 算每张绝对起点, 从 out/final.mp4 抽帧
// 这是"still 预览看不出、只有成片里才见"那类问题的最终对账手段 —— 图注落进字幕带被字幕压住、
// 字幕压正文、末级元素没进画面、收尾静止不够, 都只有成片实帧能证明(2026-09-18 实测: 8 张图注
// 全被字幕盖住, still 预览全绿)。上片前逐张过一遍, 比"整片重看"快得多。
//
// 用法:
//   node grab-frames.mjs <项目目录>                # 每张抽 1 帧(默认取末段: 元素已入场 + 字幕在屏)
//   node grab-frames.mjs <项目目录> --ids 05,11    # 只抽指定张
//   node grab-frames.mjs <项目目录> --at 0.5       # 取每张 50% 处(默认 0.93)
//   node grab-frames.mjs <项目目录> --both         # 每张抽 2 帧(中段 + 末段)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTool, flagValue, positionalDir, requireTool, safeId, safeOut, validateTimingsIds } from './tools.mjs';

const argv = process.argv.slice(2);
const dir = positionalDir(argv);
// --at 必须在 (0,1]: 静默 clamp/NaN 会让抽帧点变成 NaN 或 0s, 抽出来的帧看着'有图'却不是该看的那一刻
const AT_RAW = flagValue(argv, '--at', '0.93');
const AT_NUM = Number(AT_RAW);
if (!Number.isFinite(AT_NUM) || AT_NUM <= 0 || AT_NUM > 1) {
  console.error(`✗ --at ${JSON.stringify(AT_RAW)} 非法: 取 (0,1] 的小数(0.93 = 该张 93% 处; 0 或 NaN 会抽到起始帧, 看不到入场结果)`);
  process.exit(1);
}
const at = AT_NUM;
const both = argv.includes('--both');

const timingsPath = path.join(dir, 'build', 'timings.json');
if (!fs.existsSync(timingsPath)) { console.error(`✗ 缺 ${timingsPath} — 先跑 plan-timings.mjs 与 build-video.mjs`); process.exit(1); }
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
validateTimingsIds(timings);
const final = path.join(dir, 'out', 'final.mp4');
if (!fs.existsSync(final)) { console.error(`✗ 还没有 ${final} — 先跑 build-video.mjs`); process.exit(1); }
const FFMPEG = requireTool('ffmpeg', dir);   // 环境错误统一退 2(与 tools.mjs 的约定一致)

const onlyIds = flagValue(argv, '--ids', '') ? new Set(flagValue(argv, '--ids', '').split(',').map(s => safeId(s.trim()))) : null;

const outDir = safeOut(dir, 'build', 'introspect');
fs.mkdirSync(outDir, { recursive: true });

let start = 0;
const shots = [];
for (const s of timings.slides) {
  const sid = safeId(s.id);
  const dur = Number(s.duration);
  if (!Number.isFinite(dur) || dur <= 0) { console.error(`✗ timings 里 ${sid} 的 duration 非法: ${JSON.stringify(s.duration)}`); process.exit(1); }
  if (!onlyIds || onlyIds.has(sid)) {
    if (both) {
      shots.push({ id: sid, t: start + dur * 0.55, tag: 'mid' });
      shots.push({ id: sid, t: Math.max(0, start + dur - 0.3), tag: 'end' });
    } else {
      shots.push({ id: sid, t: start + dur * at, tag: 'end' });
    }
  }
  start += dur;
}

let bad = 0;
for (const sh of shots) {
  // 叶子也要过收监(1.7.5 复查同类收尾, 九轮 review 抓到): id 过了 safeId 只防"路径注入",
  // 防不了预置在 build/introspect/ 里的**文件符号链接**把 ffmpeg -y 的输出引到项目外。
  const out = safeOut(dir, 'build', 'introspect', `frame-${sh.id}-${sh.tag}.png`);
  const r = spawnSync(FFMPEG, ['-y', '-ss', sh.t.toFixed(2), '-i', final, '-frames:v', '1', out], { encoding: 'utf8', windowsHide: true });
  const ok = fs.existsSync(out) && fs.statSync(out).size > 1000;
  console.log(`${ok ? '✓' : '✗'} ${sh.id} @${sh.t.toFixed(2)}s (${sh.tag}) → ${path.relative(dir, out)}`);
  if (!ok) { bad++; console.log('    ', (r.stderr || '').split('\n').slice(-3).join(' ')); }
}
if (!shots.length) { console.error('✗ 一帧都没抽到(检查 --ids 是否写错、或 timings.json 的 slides 是不是空的)'); process.exit(1); }
console.log(`\n共 ${shots.length} 帧 → ${path.relative(dir, outDir)}(逐张看: 图注/字幕有没有打架、末级元素是否都在、收尾静止够不够)`);
process.exit(bad ? 1 : 0);
