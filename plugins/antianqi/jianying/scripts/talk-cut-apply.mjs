#!/usr/bin/env node
/**
 * talk-cut 应用器：把 plan 里的 dropRanges 真的剪进草稿
 *
 * ★ 剪"中间一段"的正确链（实测，2026-10-21）：
 *     ① segment.split  {segmentId, splitTime: t1}   → 切成两段，【后半段拿新 id】
 *        ※ split 会让【后面的段整体后移】⇒ 所以必须【从后往前】处理多个区间
 *     ② segment.split  {segmentId: 前半id, splitTime: t0} → 前半再切两半
 *     ③ segment.delete {segmentId: 中间段id}         → 时间线缩短 (t1 - t0)
 *   实测：时间线 9033333 → 8033333 us（正好剪掉 1 秒）✓
 *
 * 用法:
 *   node scripts/talk-cut-apply.mjs --plan <plan.json> --draft "<草稿名>" [--apply]
 *     --apply  真的改草稿（默认只演练，只打印每一步计划）
 *   草稿名可以是绝对路径。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const PLAN = arg('--plan', null);
const DRAFT = arg('--draft', null);
const APPLY = has('--apply');
if (!PLAN || !DRAFT) {
  console.error('用法: node talk-cut-apply.mjs --plan <plan.json> --draft "<草稿名>" [--apply]');
  process.exit(2);
}

/* ---- 走插件自带的 MCP 客户端（与 mcode 加载插件时同一套动词）---- */
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

const segsOf = (summary) => {
  const out = [];
  for (const t of (summary?.tracks || [])) for (const s of (t.segments || [])) {
    out.push({ track: t.type, id: s.id, start: s.target_timerange?.start || 0, dur: s.target_timerange?.duration || 0 });
  }
  return out;
};
const totalUs = (segs) => segs.reduce((a, s) => Math.max(a, s.start + s.dur), 0);

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const drops = (plan.dropRanges || []).slice().sort((a, b) => b.startMs - a.startMs);   // ★ 从后往前
console.log('=== talk-cut 应用 ===');
console.log(`  计划: ${drops.length} 个待删区间 · 总时长 ${(plan.stats.totalMs / 1000).toFixed(1)}s`);
console.log('  模式: %s', APPLY ? '★ 真改草稿' : '演练（只打印）');
console.log('  草稿: %s\n', DRAFT);

if (!drops.length) { console.log('没有要删的区间（plan 里 dropRanges 为空）'); process.exit(0); }

const open = await call('draft_open', { draft: DRAFT, copy: true });
if (open.failed) { console.error('打开草稿失败：\n' + (open.text + open.stderr).slice(0, 400)); process.exit(3); }
const sid = open.json.sessionId;
const copyDir = open.json.dir;
console.log('# session', sid, '\n');

let readRes = await call('draft_read', { scope: 'segments', sessionId: sid });
let segs = segsOf(readRes.json?.summary);
const len0 = totalUs(segs);
console.log('# 初始: %d 段 · 时间线 %d us\n', segs.length, len0);

const done = [];
for (const d of drops) {
  const t0 = d.startMs * 1000, t1 = d.endMs * 1000;   // ms → us
  const cover = segs.find((s) => s.start <= t0 + 1 && s.start + s.dur >= t1 - 1);
  if (!cover) { console.log('  [SKIP] 区间 %d..%d us 找不到覆盖它的段', t0, t1); continue; }
  const planText = `split(${cover.id.slice(0, 8)}, ${t1}) → split(front, ${t0}) → delete(mid)`;
  if (!APPLY) { console.log('  [DRY] %d..%d us  ← %s', t0, t1, planText); done.push({ t0, t1, dry: true }); continue; }

  // ① split @ t1
  let r = await call('draft_patch', { op: 'segment.split', sessionId: sid, params: { segmentId: cover.id, splitTime: t1 } });
  if (r.failed) { console.log(`  [FAIL] split@${t1}：${(r.text + r.stderr).slice(0, 160)}`); continue; }
  readRes = await call('draft_read', { scope: 'segments', sessionId: sid });
  segs = segsOf(readRes.json?.summary);
  const front = segs.find((s) => s.id === cover.id);
  console.log(`  ① split@${t1} → ${segs.length} 段`, segs.map((s) => `${s.id.slice(0, 6)}@${s.start}+${s.dur}`).join(' '));
  if (!front) { console.log('  [FAIL] split 后找不到前半段'); continue; }

  // ② split @ t0
  r = await call('draft_patch', { op: 'segment.split', sessionId: sid, params: { segmentId: front.id, splitTime: t0 } });
  if (r.failed) { console.log(`  [FAIL] split@${t0}：${(r.text + r.stderr).slice(0, 160)}`); continue; }
  readRes = await call('draft_read', { scope: 'segments', sessionId: sid });
  segs = segsOf(readRes.json?.summary);
  console.log(`  ② split@${t0} → ${segs.length} 段`, segs.map((s) => `${s.id.slice(0, 6)}@${s.start}+${s.dur}`).join(' '));
  const mid = segs.find((s) => s.id !== front.id && s.start >= t0 - 1 && s.start + s.dur <= t1 + 1 && s.dur > 0);
  if (!mid) { console.log(`  [FAIL] 找不到中间段（期望 start>=${t0 - 1} 且 start+dur<=${t1 + 1}）`); continue; }

  // ③ delete 中间段
  r = await call('draft_patch', { op: 'segment.delete', sessionId: sid, params: { segmentId: mid.id } });
  if (r.failed) { console.log('  [FAIL] delete：%s', (r.text + r.stderr).slice(0, 160)); continue; }
  readRes = await call('draft_read', { scope: 'segments', sessionId: sid });
  segs = segsOf(readRes.json?.summary);
  console.log('  [OK] 剪掉 %d..%d us（%d us）· 现在 %d 段 / 时间线 %d us',
    t0, t1, t1 - t0, segs.length, totalUs(segs));
  done.push({ t0, t1, ok: true });
}

readRes = await call('draft_read', { scope: 'segments', sessionId: sid });
segs = segsOf(readRes.json?.summary);
const len1 = totalUs(segs);
const cut = drops.reduce((a, d) => a + (d.endMs - d.startMs) * 1000, 0);
if (!APPLY) {
  console.log(`\n# 演练结束：没改草稿（时间线仍 ${len1} us）。加 --apply 真改。`);
} else {
  console.log(`\n# 结果: ${segs.length} 段 · 时间线 ${len1} us（初始 ${len0} us）· 应缩短 ${cut} us`);
  const expect = len0 - cut;
  console.log(`# 时间线判定: ${len1 === expect ? 'OK' : `✗ 实际 ${len1}`}（期望 ${expect}）`);
}

if (APPLY && done.length) {
  const cm = await call('draft_commit', { sessionId: sid, realDraft: DRAFT });
  console.log('# 落盘: %s', cm.failed ? ('FAIL ' + (cm.text + cm.stderr).slice(0, 200))
    : `encrypted=${cm.json.encrypted} cipherType=${cm.json.cipherType} relocated=${cm.json.relocated} realDraftUnchanged=${cm.json.realDraftUnchanged}`);
  console.log('# 副本目录: %s', copyDir);
}
