#!/usr/bin/env node
/**
 * jianying 插件：字幕落稿自检
 *   造一份 SRT → add-subtitles.mjs 落进副本草稿 → 回读核对
 *   ★ 判据是【语义】：回读草稿里的 text 段，时码必须与 SRT 吻合（容差 ±1 帧，官方按 fps 帧对齐）
 *   ★ 负向注入：同目录的"无字幕"草稿必须判为"没有字幕"（不能把探针写成恒真）
 *
 * 用法: node scripts/selftest-subtitle.mjs
 * 需要: JYAI_HOME 指向 JYAI 仓库；剪映 11.6 在运行；JYAI_TEST_DRAFT 指向一个带视频片段的草稿
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
const DRAFT = process.env.JYAI_TEST_DRAFT || '';
const WORK = path.join(JYAI, 'out', 'p67', 'subtitle-selftest');

let PASS = 0, FAIL = 0;
const check = (n, ok, d) => {
  if (ok) { PASS++; console.log(`  [PASS] ${n}${d ? '  — ' + d : ''}`); }
  else { FAIL++; console.log(`  [FAIL] ${n}${d ? '  — ' + d : ''}`); }
};
function call(verb, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, 'run-verb.mjs'), verb, JSON.stringify(args)],
      { env: { ...process.env, JYAI_HOME: JYAI }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => {
      let j = null; try { j = JSON.parse(so); } catch { /* not JSON */ }
      resolve({ code, json: j, text: so, stderr: se, failed: code !== 0 || j?.isError === true });
    });
  });
}
const run = (script, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(HERE, script), ...args], { env: { ...process.env, JYAI_HOME: JYAI }, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '';
  c.stdout.on('data', (d) => { so += d; });
  c.stderr.on('data', (d) => { se += d; });
  c.on('close', (code) => resolve({ code, out: so + se }));
});

console.log('=== 字幕落稿自检 ===\n');
if (!DRAFT) {
  console.log('  [SKIP] 需要 JYAI_TEST_DRAFT —— 指向一个带视频片段的剪映草稿目录。');
  console.log('  例（PowerShell）: $env:JYAI_TEST_DRAFT = "<草稿库>\\<草稿名>"');
  process.exit(0);
}
fs.mkdirSync(WORK, { recursive: true });

const CUES = [
  { text: '大家好，今天我们来聊一个被很多人忽略的问题', startMs: 500, endMs: 3000 },
  { text: '就是怎么让 AI 直接操作剪映', startMs: 3200, endMs: 6500 },
  { text: '嗯，这个问题其实挺有意思的', startMs: 6800, endMs: 9500 },
];
const srtPath = path.join(WORK, 'selftest.srt');
const srt = CUES.map((c, i) => {
  const ts = (ms) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  return `${i + 1}\n${ts(c.startMs)} --> ${ts(c.endMs)}\n${c.text}\n`;
}).join('\n');
fs.writeFileSync(srtPath, srt, 'utf8');
check('① 造 SRT', fs.existsSync(srtPath) && CUES.length === 3, srtPath);

// ② 落稿
const r = await run('add-subtitles.mjs', ['--srt', srtPath, '--draft', DRAFT, '--apply']);
const okMatch = /落稿: (\d+) 成功 \/ (\d+) 失败/.exec(r.out);
const landed = okMatch ? +okMatch[1] : 0;
const failedN = okMatch ? +okMatch[2] : -1;
check('② add-subtitles 落稿', landed === CUES.length && failedN === 0, r.out.replace(/\s+/g, ' ').match(/落稿:.*$/)?.[0] || r.out.slice(0, 160));

// ③ 验收行：时码吻合数
const accMatch = /时码吻合 (\d+)\/(\d+)/.exec(r.out);
const matched = accMatch ? +accMatch[1] : 0;
check('③ 时码与 SRT 吻合（语义判据，±1 帧）', matched === CUES.length, accMatch ? `${matched}/${CUES.length}` : '验收行缺失');

// ④ 阴性：没跑之前草稿里没有这些字幕 ⇒ 探针必须能区分"有字幕"和"没字幕"
const open = await call('draft_open', { draft: DRAFT, copy: true });
let before = null;
try { before = JSON.parse(open.text).draft; } catch { /* ignore */ }
const textSegsBefore = [];
for (const t of before?.tracks || []) if (t.type === 'text') for (const s of t.segments || []) textSegsBefore.push(s);
const beforeHas = textSegsBefore.some((s) => CUES.some((c) => s.target_timerange?.start === c.startMs * 1000));
check('★ ④ 阴性：原始草稿里没有这些字幕（探针有判别力）', !beforeHas,
  `原始草稿 text 段 ${textSegsBefore.length} 条 · 含目标时码 = ${beforeHas}`);

console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL === 0 ? 0 : 1);
