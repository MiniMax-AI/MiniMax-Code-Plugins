#!/usr/bin/env node
/**
 * talk-cut 应用器：把 plan 里的 dropRanges 真的剪进草稿
 *
 * ★ 剪"中间一段"的正确链（实测，2026-10-21）：
 *     ① segment.split  {segmentId, splitTime: t1}   → 切成两段，【后半段拿新 id】
 *        ※ split 会让【后面的段整体后移】⇒ 所以必须【从后往前】处理多个区间
 *     ② segment.split  {segmentId: 前半id, splitTime: t0} → 前半再切两半
 *     ③ segment.delete {segmentId: 中间段id}         → 时间线缩短 (t1 - t0)
 *
 * 用法:
 *   node scripts/talk-cut-apply.mjs --plan <plan.json> --draft "<草稿名>" [--apply]
 *     --apply  真的改草稿（默认只演练，只打印每一步计划）
 *   草稿名可以是绝对路径。
 *   ★ --sessionId <ve-session-N>：复用【别人】开好的会话（编排器 run_pipeline 就是这么接的）
 *     —— 不自己 draft_open、不自己 draft_commit（落盘归编排器的 draft_commit 步骤管）。
 *     不给 --sessionId 时行为不变（自己开、自己落盘）。
 *
 * ★★★ 判据纪律（2026-10-24 重写，实测踩坑换来的）：
 *   ① 【同源】：改前改后必须读同一份草稿。
 *      踩过的坑：会话快照（运行时展开形态，段 50+ 键）与磁盘回落（精简形态，段 11 键）
 *      是两个东西；官方 readFile 在路径解析不出 workspace 时还会【静默返回剪映当前打开的
 *      另一份草稿】⇒ 拿两种形态混着比总时长，比出来的是误导。
 *      ⇒ 本脚本【全程只用会话快照】：第一次 patch 之后快照就存在了，之后所有读都同源。
 *   ② 【有区分力】：判据 = "剪完后再看，同轨道上【不再有任何段完整覆盖这个区间】"。
 *      阳性前提：剪之前该区间确实被某个段完整覆盖（否则无从下手）。
 *      阴性对照：演练模式（没 --apply）下这个判据【必然不成立】—— 脚本会当场自证。
 *   ③ 【失败报红】：判定不通过 ⇒ 退出码非 0 ⇒ 上游编排器会把它当失败步骤，不假装成功。
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
const SID = arg('--sessionId', null);
const APPLY = has('--apply');
if (!PLAN || (!DRAFT && !SID)) {
  console.error('用法: node talk-cut-apply.mjs --plan <plan.json> --draft "<草稿名>" [--apply] [--sessionId <ve-session-N>]');
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
    out.push({ track: t.type, trackId: t.id, id: s.id, start: s.target_timerange?.start || 0, dur: s.target_timerange?.duration || 0,
               keys: Object.keys(s).length });
  }
  return out;
};
const totalUs = (segs) => segs.reduce((a, s) => Math.max(a, s.start + s.dur), 0);
/* ★ 某一轨道上【所有段的时长之和】（判据用：与位移无关）
   —— 官方删除片段时会【把后面的段左移补空】⇒ "该区间不再被覆盖"会误判（后面的段又盖上来了），
      而"这一轨的时长总量少了多少"不受位移影响。 */
const trackSumUs = (segs, trackId) => segs.filter((s) => s.trackId === trackId).reduce((a, s) => a + s.dur, 0);
/* 形态指纹：同一段在"精简形态"下只有 11 个键，"运行时展开形态"有 50+ 个 */
const formOf = (segs) => (segs[0] ? (segs[0].keys > 20 ? 'expanded' : 'compact') : 'unknown');
/** 完整覆盖 [t0,t1] 的段 */
const covering = (segs, t0, t1) => segs.find((s) => s.start <= t0 + 1 && s.start + s.dur >= t1 - 1);

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const drops = (plan.dropRanges || []).slice().sort((a, b) => b.startMs - a.startMs);   // ★ 从后往前
console.log('=== talk-cut 应用 ===');
console.log(`  计划: ${drops.length} 个待删区间 · 总时长 ${(plan.stats.totalMs / 1000).toFixed(1)}s`);
console.log('  模式: %s', APPLY ? '★ 真改草稿' : '演练（只打印）');
console.log('  草稿: %s\n', DRAFT || '(复用会话，不指定)');

if (!drops.length) { console.log('没有要删的区间（plan 里 dropRanges 为空）'); process.exit(0); }

/* ★ 会话来源：① 复用别人开好的（--sessionId）② 自己开一个
   —— 编排器走 ①：不然会跟编排器的 session 抢，两个进程各改各的。 */
let sid = SID;
let copyDir = null;
if (sid) {
  console.log('# 复用会话 %s（不自己开、不自己落盘）\n', sid);
} else {
  const open = await call('draft_open', { draft: DRAFT, copy: true });
  if (open.failed) { console.error('打开草稿失败：\n' + (open.text + open.stderr).slice(0, 400)); process.exit(3); }
  sid = open.json.sessionId;
  copyDir = open.json.dir;
  console.log('# session', sid, '\n');
}

/** 读当前草稿（会话快照优先 ⇒ 同源；还没有快照时才是磁盘回落） */
async function readNow() {
  const r = await call('draft_read', { sessionId: sid });
  if (r.failed) return { segs: [], source: 'read-failed', id: null, mismatch: false, text: (r.text + r.stderr).slice(0, 200) };
  return { segs: segsOf(r.json?.summary), source: r.json?.summary?.source || '?',
           id: r.json?.summary?.draftId || null, mismatch: r.json?.summary?.draftIdMismatch === true };
}

let cur = await readNow();
// ★ 同源校验：同一个会话里读到的草稿 id 必须一致（变了 ⇒ 我们在剪两份不同的草稿）
let curId = cur.id;
const idChanged = (r) => curId && r.id && r.id !== curId;
console.log('# 初始视图: %d 段 · 时间线 %d us · 形态 %s · 来源 %s · 草稿 id %s\n',
  cur.segs.length, totalUs(cur.segs), formOf(cur.segs), cur.source, cur.id || '(未知)');

const done = [];
const failed = [];
for (const d of drops) {
  const t0 = d.startMs * 1000, t1 = d.endMs * 1000;   // ms → us
  const planText = (c) => `split(${String(c.id).slice(0, 8)}, ${t1}) → split(front, ${t0}) → delete(mid)`;

  // ① 阳性前提：待剪区间在时间线上确实被某个段完整覆盖
  let cover = covering(cur.segs, t0, t1);
  if (!cover) {
    console.log('  [SKIP] 区间 %d..%d us 在时间线上找不到完整覆盖它的段 ⇒ 这一刀无从下手（不算剪掉）', t0, t1);
    failed.push({ t0, t1, why: 'no-cover-segment' });
    continue;
  }
  const cutUs = t1 - t0;
  const trackBefore = trackSumUs(cur.segs, cover.trackId);
  if (!APPLY) {
    // ★ 阴性对照：什么都没剪 ⇒ "这一轨的时长总量没少" ⇒ 判据必然不成立 ⇒ 判据有区分力
    console.log('  [DRY] %d..%d us  ← %s', t0, t1, planText(cover));
    console.log('         阴性对照：演练没动草稿 ⇒ 这一轨时长总量仍为 %d us（判据现在【不成立】⇒ 判据能区分）', trackBefore);
    done.push({ t0, t1, dry: true });
    continue;
  }

  // ② split @ t1 —— ★ 必须"段数增加"才算这一刀生效（官方 accepted 不算数）
  //    如果段数没增加 ⇒ 这个 id 运行时认不出来（我们读到的和它要改的不是同一份草稿）
  //    ⇒ 此时会话快照已经存在了（patch 总会写快照）⇒ 用快照里的覆盖段重试一次。
  let sp = await call('draft_patch', { op: 'segment.split', sessionId: sid, params: { segmentId: cover.id, splitTime: t1 } });
  if (sp.failed) {
    console.log(`  [FAIL] split@${t1}：${(sp.text + sp.stderr).slice(0, 160)}`);
    failed.push({ t0, t1, why: 'split1-failed' });
    continue;
  }
  const nBefore = cur.segs.length;
  cur = await readNow();
  if (idChanged(cur)) {
    console.log('  [FAIL] 读到的草稿 id 变了（%s → %s）⇒ 我们在剪两份不同的草稿 ⇒ 停手', curId, cur.id);
    failed.push({ t0, t1, why: 'draft-id-changed' });
    break;
  }
  if (cur.segs.length <= nBefore) {
    const cover2 = covering(cur.segs, t0, t1);
    if (!cover2 || cover2.id === cover.id) {
      console.log('  [FAIL] split@%d 后段数没增加（%d 段）且换不到别的覆盖段 ⇒ 这一刀没生效', t1, cur.segs.length);
      failed.push({ t0, t1, why: 'split1-noop' });
      continue;
    }
    console.log('  · 换覆盖段重试：%s → %s', String(cover.id).slice(0, 8), String(cover2.id).slice(0, 8));
    cover = cover2;
    sp = await call('draft_patch', { op: 'segment.split', sessionId: sid, params: { segmentId: cover.id, splitTime: t1 } });
    if (sp.failed) {
      console.log(`  [FAIL] split@${t1}（重试）：${(sp.text + sp.stderr).slice(0, 160)}`);
      failed.push({ t0, t1, why: 'split1-retry-failed' });
      continue;
    }
    cur = await readNow();
    if (idChanged(cur)) {
      console.log('  [FAIL] 重试后读到的草稿 id 变了 ⇒ 停手');
      failed.push({ t0, t1, why: 'draft-id-changed' });
      break;
    }
    if (cur.segs.length <= nBefore) {
      console.log('  [FAIL] split@%d 重试后段数仍没增加 ⇒ 这一刀没生效', t1);
      failed.push({ t0, t1, why: 'split1-retry-noop' });
      continue;
    }
  }
  console.log(`  ① split@${t1} → ${cur.segs.length} 段`, cur.segs.map((s) => `${String(s.id).slice(0, 6)}@${s.start}+${s.dur}`).join(' '));

  // ③ split @ t0
  const front = cur.segs.find((s) => s.id === cover.id);
  if (!front) {
    console.log('  [FAIL] split 后找不到前半段（%s）', String(cover.id).slice(0, 8));
    failed.push({ t0, t1, why: 'front-not-found' });
    continue;
  }
  let sp2 = await call('draft_patch', { op: 'segment.split', sessionId: sid, params: { segmentId: front.id, splitTime: t0 } });
  if (sp2.failed) {
    console.log(`  [FAIL] split@${t0}：${(sp2.text + sp2.stderr).slice(0, 160)}`);
    failed.push({ t0, t1, why: 'split2-failed' });
    continue;
  }
  cur = await readNow();
  console.log(`  ② split@${t0} → ${cur.segs.length} 段`, cur.segs.map((s) => `${String(s.id).slice(0, 6)}@${s.start}+${s.dur}`).join(' '));

  // ④ 找中间段（被挖掉的那一段）—— ★ 必须【同轨道】（别的轨道上也有段会落在这个时间窗里）
  const mid = cur.segs.find((s) => s.id !== front.id && s.start >= t0 - 1 && s.start + s.dur <= t1 + 1 && s.dur > 0
    && s.trackId === cover.trackId);
  if (!mid) {
    console.log(`  [FAIL] 找不到中间段（期望 start>=${t0 - 1} 且 start+dur<=${t1 + 1} 且同轨道）`);
    failed.push({ t0, t1, why: 'mid-not-found' });
    continue;
  }

  // ⑤ delete 中间段
  const del = await call('draft_patch', { op: 'segment.delete', sessionId: sid, params: { segmentId: mid.id } });
  if (del.failed) {
    console.log('  [FAIL] delete：%s', (del.text + del.stderr).slice(0, 160));
    failed.push({ t0, t1, why: 'delete-failed' });
    continue;
  }
  cur = await readNow();
  if (idChanged(cur)) {
    console.log('  [FAIL] 删除后读到的草稿 id 变了 ⇒ 停手');
    failed.push({ t0, t1, why: 'draft-id-changed' });
    break;
  }

  // ★★ 生效判据：这一轨的【时长总量】少了恰好 (t1-t0)
  //   （不用"区间不再被覆盖"：官方删除片段会把后面的段左移补空 ⇒ 区间又被盖上了 ⇒ 那是误判）
  const trackAfter = trackSumUs(cur.segs, cover.trackId);
  const shrunk = trackBefore - trackAfter;
  if (shrunk !== cutUs) {
    console.log('  [FAIL] 剪完 %d..%d us 后这一轨的时长总量只少了 %d us（应为 %d us）⇒ 这一刀没生效（官方 accepted 不算数）',
      t0, t1, shrunk, cutUs);
    failed.push({ t0, t1, why: 'track-duration-unchanged' });
    continue;
  }
  console.log('  [OK] 剪掉 %d..%d us（%d us）· 这一轨时长总量 %d → %d us（正好少 %d）· 现在 %d 段',
    t0, t1, cutUs, trackBefore, trackAfter, shrunk, cur.segs.length);
  done.push({ t0, t1, ok: true });
}

const cut = drops.reduce((a, d) => a + (d.endMs - d.startMs) * 1000, 0);
const okCount = done.filter((x) => x.ok).length;
if (!APPLY) {
  console.log(`\n# 演练结束：没改草稿（时间线仍 ${totalUs(cur.segs)} us）。加 --apply 真改。`);
} else {
  console.log(`\n# 结果: ${cur.segs.length} 段 · 时间线 ${totalUs(cur.segs)} us · 计划剪掉 ${cut} us`);
  console.log(`# 判定: 已验证剪掉 ${okCount}/${drops.length} 个区间 · 失败 ${failed.length} 个`);
  console.log(`#       （判据 = 这一轨的时长总量正好少了 (t1-t0) us；与位移无关；演练模式下必不成立）`);
}

if (failed.length) {
  console.error(`# ✗ 判定失败：${failed.map((f) => `${f.why}${f.t0 !== undefined ? `@${f.t0}..${f.t1}` : ''}`).join(', ')}`);
  process.exit(4);      // ★ 判定没过 ⇒ 非 0 退出 ⇒ 编排器会把它当失败步骤（不假装成功）
}

if (APPLY && done.length) {
  if (SID) {
    // ★ 复用会话时【不落盘】：落盘是编排器 draft_commit 步骤的事（它还要做真草稿 sha 护栏）
    console.log('# 落盘: 跳过（复用会话模式 ⇒ 由编排器的 draft_commit 步骤落盘）');
    console.log('# 副本目录: %s', copyDir || '(复用编排器开的副本)');
  } else {
    const cm = await call('draft_commit', { sessionId: sid, realDraft: DRAFT });
    console.log('# 落盘: %s', cm.failed ? ('FAIL ' + (cm.text + cm.stderr).slice(0, 200))
      : `encrypted=${cm.json.encrypted} cipherType=${cm.json.cipherType} relocated=${cm.json.relocated} realDraftUnchanged=${cm.json.realDraftUnchanged}`);
    console.log('# 副本目录: %s', copyDir);
  }
}
