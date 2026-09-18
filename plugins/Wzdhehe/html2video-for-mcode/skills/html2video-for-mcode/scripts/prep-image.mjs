#!/usr/bin/env node
// html2video-for-mcode · 配图准备工具(选图 SOP 的执行辅助) — 只用 ffprobe/ffmpeg, 不依赖 Python
// 用法:
//   node prep-image.mjs --check <图1> [图2 ...]            看尺寸/比例/裁切风险, 给人做取舍
//   node prep-image.mjs --crop <in> <out> [--ratio 16:9] [--anchor bottom|top|center]
// 裁切硬限制(与 image-sources.md 的 SOP 一致): 主体必须完整可见、裁掉面积 ≤20%、输出严格目标比例。
// 优先靠换图/换版式解决, 本工具只是最后的兜底手段。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireTool } from './tools.mjs';

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--ratio', '--anchor']); // 这些 flag 后面跟一个值, 值不算位置参数
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}
const flag = (name, dflt) => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : dflt; };

// 按当前工作目录找项目内的 ffmpeg-static / ffprobe-static(二审 P2: README 明说支持装在视频项目里)
const FFMPEG = requireTool('ffmpeg', process.cwd());
const FFPROBE = requireTool('ffprobe', process.cwd());
const win = { encoding: 'utf8', windowsHide: true };

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], win);
  const m = (r.stdout || '').trim().match(/(\d+),(\d+)/);
  return m ? { w: +m[1], h: +m[2] } : null;
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
const ratioLabel = (w, h) => { const g = gcd(w, h); return `${w / g}:${h / g} (${(w / h).toFixed(2)})`; };

if (argv.includes('--check') || (!argv.includes('--crop') && positional.length)) {
  const files = positional;
  if (!files.length) { console.error('用法: node prep-image.mjs --check <图1> [图2 ...]'); process.exit(1); }
  let risk = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`✗ 不存在: ${f}`); process.exitCode = 1; continue; }
    const s = probe(f);
    if (!s) { console.error(`✗ 读不出尺寸: ${f}`); process.exitCode = 1; continue; }
    const r = s.w / s.h;
    const ratio = 16 / 9;
    const notes = [];
    if (Math.abs(r - ratio) < 0.06) notes.push('比例≈16:9, 可直接套 .img-frame 默认框');
    else if (r > ratio) {
      // 比 16:9 更宽 → 裁宽度
      notes.push(`偏宽: 保持高度裁宽度 ${(100 * (1 - (s.h * ratio) / s.w)).toFixed(0)}% 可到 16:9`);
    } else {
      // 比 16:9 更高(窄) → 裁高度
      notes.push(`偏高(窄): 保持宽度裁高度 ${(100 * (1 - (s.w / ratio) / s.h)).toFixed(0)}% 可到 16:9`);
    }
    if (s.w < 1200) notes.push('分辨率 <1200px, 上屏会软 — 建议换更大的图');
    if (Math.abs(r - ratio) >= 0.06) { notes.push('⚠ 主体若在边缘, 先换图(搜「全景/全貌/正面/远景」), 不要硬裁'); risk++; }
    console.log(`${path.basename(f)}\n  尺寸 ${s.w}×${s.h} · 比例 ${ratioLabel(s.w, s.h)}\n  ${notes.join('\n  ')}`);
    console.log('  下一步: 肉眼确认主体位置 → 主体在边缘就换图; 居中可小裁, 或改用 .img-frame.contain 留白\n');
  }
  if (risk) console.log(`提示: ${risk} 张存在裁切风险 —— 按 references/image-sources.md 的 SOP 优先重搜素材。`);
  process.exit(process.exitCode ?? 0);
}

if (argv.includes('--crop')) {
  const [src, dst] = positional;
  if (!src || !dst) { console.error('用法: node prep-image.mjs --crop <in> <out> [--ratio 16:9] [--anchor bottom|top|center] [--force]'); process.exit(1); }
  const FORCE = argv.includes('--force');
  if (fs.existsSync(dst) && !FORCE) { console.error(`✗ 输出已存在, 不覆盖: ${dst}(要覆盖加 --force)`); process.exit(1); }
  const [rw, rh] = (flag('--ratio', '16:9')).split(':').map(Number);
  const anchor = flag('--anchor', 'center');
  if (!rw || !rh) { console.error('✗ --ratio 形如 16:9'); process.exit(1); }
  const s = probe(src);
  if (!s) { console.error(`✗ 读不出尺寸: ${src}`); process.exit(1); }
  const target = rw / rh, cur = s.w / s.h;

  // 目标裁切框: 比目标更宽 → 裁宽; 比目标更高(窄) → 裁高。绝不放大补边。
  let cw, ch, x, y;
  if (cur > target) { ch = s.h; cw = Math.round(s.h * target); }
  else { cw = s.w; ch = Math.round(s.w / target); }
  if (cw > s.w || ch > s.h) { console.error('✗ 该比例需要放大补边, 裁不出来 —— 改用 .img-frame.contain 留白'); process.exit(1); }
  const cutFrac = 1 - (cw * ch) / (s.w * s.h);
  if (cutFrac > 0.2) {
    console.error(`✗ 需裁掉 ${(cutFrac * 100).toFixed(0)}% 面积(硬限制 ≤20%)——按 SOP 先换图或用 .img-frame.contain 留白, 不要硬裁`);
    process.exit(1);
  }
  x = Math.round((s.w - cw) / 2);
  y = anchor === 'top' ? 0 : anchor === 'bottom' ? s.h - ch : Math.round((s.h - ch) / 2);
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', `crop=${cw}:${ch}:${x}:${y}`, dst], win);
  if (r.status !== 0) { console.error('✗ 裁切失败:\n' + (r.stderr || '')); process.exit(1); }
  const out = probe(dst);
  console.log(`✓ ${path.basename(dst)}  ${s.w}×${s.h} → ${out.w}×${out.h} (${ratioLabel(out.w, out.h)}), 裁掉 ${(cutFrac * 100).toFixed(1)}% 面积, 锚点 ${anchor}`);
  console.log('  裁完必须肉眼核对主体完整可见 —— 宁可改用 .img-frame + --img-pos, 也不要裁到主体。');
  process.exit(0);
}

console.error('用法:\n  node prep-image.mjs --check <图...>\n  node prep-image.mjs --crop <in> <out> [--ratio 16:9] [--anchor bottom|top|center]');
process.exit(1);
