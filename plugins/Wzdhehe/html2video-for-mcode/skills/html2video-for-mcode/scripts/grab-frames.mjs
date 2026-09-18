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
import { safeId, safeOut, findTool, validateTimingsIds } from './tools.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const dir = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const at = Math.min(1, Math.max(0, Number(flag('--at', '0.93'))));
const both = argv.includes('--both');

const timingsPath = path.join(dir, 'build', 'timings.json');
if (!fs.existsSync(timingsPath)) { console.error(`✗ 缺 ${timingsPath} — 先跑 plan-timings.mjs 与 build-video.mjs`); process.exit(1); }
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
validateTimingsIds(timings);
const final = path.join(dir, 'out', 'final.mp4');
if (!fs.existsSync(final)) { console.error(`✗ 还没有 ${final} — 先跑 build-video.mjs`); process.exit(1); }
const FFMPEG = findTool('ffmpeg', dir);
if (!FFMPEG) { console.error('✗ 找不到 ffmpeg(按 PATH → 项目 node_modules → 常见安装位置找过; 可 npm i ffmpeg-static)'); process.exit(1); }

const onlyIds = flag('--ids', '') ? new Set(flag('--ids', '').split(',').map(s => safeId(s.trim()))) : null;

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
  const out = path.join(outDir, `frame-${sh.id}-${sh.tag}.png`);   // id 已过 safeId 白名单, 无路径注入
  const r = spawnSync(FFMPEG, ['-y', '-ss', sh.t.toFixed(2), '-i', final, '-frames:v', '1', out], { encoding: 'utf8', windowsHide: true });
  const ok = fs.existsSync(out) && fs.statSync(out).size > 1000;
  console.log(`${ok ? '✓' : '✗'} ${sh.id} @${sh.t.toFixed(2)}s (${sh.tag}) → ${path.relative(dir, out)}`);
  if (!ok) { bad++; console.log('    ', (r.stderr || '').split('\n').slice(-3).join(' ')); }
}
console.log(`\n共 ${shots.length} 帧 → ${path.relative(dir, outDir)}(逐张看: 图注/字幕有没有打架、末级元素是否都在、收尾静止够不够)`);
process.exit(shots.length && bad ? 1 : 0);
