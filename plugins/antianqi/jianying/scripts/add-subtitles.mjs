#!/usr/bin/env node
/**
 * 字幕轨落稿器：SRT / plan → 草稿里的"带时码的文字"（剪映里的字幕轨）
 *
 * ★ 实测契约（2026-10-21，桥的归一化函数 oC_ 明确支持）：
 *     text.add { content, startTime, duration, trackIndex, needInsertTargetTrack }
 *       · content  ：字幕文本（也接受 segInfo.material.content）
 *       · startTime ：起始（微秒），缺省 0
 *       · duration  ：时长（微秒），缺省 3_000_000
 *       · trackIndex：目标轨索引（缺省 0）
 *       · needInsertTargetTrack：true(缺省)=官方新建一条 text 轨；false=塞进 trackIndex 指定的既有轨
 *     ★ 坑：needInsertTargetTrack=false 且 trackIndex 指向【非 text 轨】⇒ 段会被塞进那条 video 轨
 *       ⇒ 所以第一条用 true（让官方建轨），读回那条 text 轨的【下标】，后面的都用 false + 那个下标
 *     实测：text.add {content:'第一句字幕', startTime:1000000, duration:2500000}
 *           ⇒ 落成 text 轨 1 段，target_timerange = {start:1000000, duration:2500000} ✓
 *
 * 用法:
 *   node scripts/add-subtitles.mjs --srt <file.srt> --draft "<草稿名>" [--apply] [--style-size N]
 *   node scripts/add-subtitles.mjs --plan <plan.json> --draft "<草稿名>" [--apply]
 *     --apply  真的改草稿（默认只演练）
 *   ★ --sessionId <ve-session-N>：复用【别人】开好的会话（编排器 run_pipeline 就是这么接的）
 *     —— 不自己 draft_open、不自己 draft_commit（落盘归编排器的 draft_commit 步骤管）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const SRT = arg('--srt', null);
const PLAN = arg('--plan', null);
const DRAFT = arg('--draft', null);
const SID = arg('--sessionId', null);
const APPLY = has('--apply');
if ((!SRT && !PLAN) || (!DRAFT && !SID)) {
  console.error('用法: node add-subtitles.mjs (--srt <file.srt> | --plan <plan.json>) --draft "<草稿名>" [--apply] [--sessionId <ve-session-N>]');
  process.exit(2);
}

function call(verb, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, 'run-verb.mjs'), verb, JSON.stringify(args)],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => {
      let j = null; try { j = JSON.parse(so); } catch { /* not JSON */ }
      resolve({ code, json: j, text: so, stderr: se, failed: code !== 0 || j?.isError === true });
    });
  });
}

/* ---------- SRT 解析（与 talk-cut-plan 同一套口径） ---------- */
const tsToMs = (s) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(String(s).trim());
  if (!m) return null;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + Math.round(+m[4] / 10);
};
function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split('-->');
    const startMs = tsToMs(a), endMs = tsToMs(z);
    if (startMs === null || endMs === null) continue;
    cues.push({ index: cues.length + 1, startMs, endMs, text: lines.slice(ti + 1).join(' ').trim() });
  }
  return cues;
}

/* ---------- 取字幕源 ---------- */
let cues = [];
if (PLAN) {
  const p = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  cues = (p.cues || []).map((c) => ({ index: c.index, startMs: c.startMs, endMs: c.endMs, text: c.text }));
} else {
  cues = parseSrt(fs.readFileSync(SRT, 'utf8'));
}
cues = cues.filter((c) => c.text && c.endMs > c.startMs);

console.log('=== 字幕落稿 ===');
console.log(`  字幕条数: ${cues.length}`);
console.log(`  时间跨度: ${(cues[0]?.startMs / 1000 || 0).toFixed(2)}s ~ ${((cues.at(-1)?.endMs || 0) / 1000).toFixed(2)}s`);
console.log(`  模式: ${APPLY ? '★ 真改草稿' : '演练（只打印）'}`);
console.log(`  草稿: ${DRAFT || (SID ? '(复用会话，不指定)' : '')}\n`);
if (!cues.length) { console.log('没有可用的字幕条'); process.exit(0); }

if (!APPLY) {
  for (const c of cues) {
    console.log(`  #${c.index}  ${(c.startMs / 1000).toFixed(2)}s +${((c.endMs - c.startMs) / 1000).toFixed(2)}s  ${c.text}`);
  }
  console.log('\n（演练模式，未改草稿。加 --apply 真改）');
  process.exit(0);
}

/* ---------- 真改 ---------- */
/* ★ 会话来源：① 复用别人开好的（--sessionId）② 自己开一个
   —— 编排器走 ①：不然会跟编排器的 session 抢，两个进程各改各的。 */
let sid = SID;
let copyDir = null;
if (sid) {
  console.log('  复用会话 %s（不自己开、不自己落盘）\n', sid);
} else {
  const open = await call('draft_open', { draft: DRAFT, copy: true });
  if (open.failed) { console.error('打开草稿失败：\n' + (open.text + open.stderr).slice(0, 400)); process.exit(3); }
  sid = open.json.sessionId;
  copyDir = open.json.dir;
  console.log(`  副本: ${copyDir}\n`);
}

let textTrackIndex = -1;     // 已存在的 text 轨下标（第一条落进后确定）
let ok = 0, fail = 0;

for (const c of cues) {
  // ★ 实测：needInsertTargetTrack=true 时，官方会把段插进 trackIndex 指向的那条轨
  //   （哪怕它是 video 轨！）⇒ 所以 trackIndex 必须指向一条【text 轨】。
  //   没有 text 轨时（第一条）就让官方新建（needInsertTargetTrack=true + trackIndex=0 之外的
  //   行为由官方决定），落完后读回 text 轨下标，后续都往那条轨里塞
  //   （needInsertTargetTrack=false + 该下标 ⇒ 实测两条同轨 ✓）。
  const params = textTrackIndex >= 0
    ? { content: c.text, startTime: c.startMs * 1000, duration: (c.endMs - c.startMs) * 1000,
        trackIndex: textTrackIndex, needInsertTargetTrack: false }
    : { content: c.text, startTime: c.startMs * 1000, duration: (c.endMs - c.startMs) * 1000,
        trackIndex: 0, needInsertTargetTrack: true };
  const r = await call('draft_patch', { op: 'text.add', sessionId: sid, params });
  if (r.failed) {
    fail++;
    console.log(`  [FAIL] #${c.index} ${(c.startMs / 1000).toFixed(2)}s "${c.text.slice(0, 24)}" → ${(r.text + r.stderr).replace(/\s+/g, ' ').slice(0, 120)}`);
    continue;
  }
  ok++;
  if (textTrackIndex < 0) {
    const rr = await call('draft_read', { sessionId: sid });
    let j = null; try { j = JSON.parse(rr.text); } catch { /* ignore */ }
    const tracks = j?.draft?.tracks || [];
    const ti = tracks.findIndex((t) => t.type === 'text');
    if (ti >= 0) textTrackIndex = ti;
  }
  console.log(`  [OK] #${c.index} ${(c.startMs / 1000).toFixed(2)}s +${((c.endMs - c.startMs) / 1000).toFixed(2)}s  "${c.text.slice(0, 28)}"`);
}

console.log(`\n  落稿: ${ok} 成功 / ${fail} 失败   text 轨下标 = ${textTrackIndex}`);

/* ---------- 验收：回读并核对时码（语义判据，容差 = 1 帧） ---------- */
const rr = await call('draft_read', { sessionId: sid });
let j = null; try { j = JSON.parse(rr.text); } catch { /* ignore */ }
const draft = j?.draft;
const textSegs = [];
for (const t of draft?.tracks || []) if (t.type === 'text') for (const s of t.segments || []) textSegs.push(s);
const fps = draft?.fps || 30;
const frameUs = Math.round(1e6 / fps);          // 官方按帧对齐 ⇒ 允许 ±1 帧
const mism = [];
for (const c of cues) {
  const wantStart = c.startMs * 1000, wantDur = (c.endMs - c.startMs) * 1000;
  const hit = textSegs.find((s) => Math.abs((s.target_timerange?.start ?? -1) - wantStart) <= frameUs
    && Math.abs((s.target_timerange?.duration ?? -1) - wantDur) <= frameUs);
  if (!hit) mism.push(c.index);
}
console.log(`  验收: 草稿里 text 段 ${textSegs.length} 条 · 时码吻合 ${cues.length - mism.length}/${cues.length}（容差 ±1 帧 = ${frameUs}µs，fps=${fps}）`);
if (mism.length) console.log(`  ★ 时码不吻合的字幕条: ${mism.join(', ')}`);

/* ---------- 落盘 ---------- */
if (SID) {
  // ★ 复用会话时【不落盘】：落盘是编排器 draft_commit 步骤的事（它还要做真草稿 sha 护栏）
  console.log('  # 落盘: 跳过（复用会话模式 ⇒ 由编排器的 draft_commit 步骤落盘）');
} else {
  const commit = await call('draft_commit', { sessionId: sid, realDraft: DRAFT });
  if (commit.failed) { console.error('落盘失败：\n' + (commit.text + commit.stderr).slice(0, 300)); process.exit(4); }
  console.log(`  # 落盘: ${(commit.text + commit.stderr).replace(/\s+/g, ' ').slice(0, 200)}`);
}

process.exit(ok === cues.length && mism.length === 0 ? 0 : 1);
