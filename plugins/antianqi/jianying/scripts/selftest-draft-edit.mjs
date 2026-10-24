#!/usr/bin/env node
/**
 * jianying 插件：改草稿链路的端到端自检
 *   draft_open（副本）→ draft_read（拿 segmentId）→ draft_patch（改）→ draft_commit（落盘 + 真草稿 sha 断言）
 *   → 读回落盘后的草稿 → verify_diff（语义：改动真的落盘了吗）→ render_frames → verify_diff（画面 + 噪声校准）
 *
 * ★ 2026-10-21 重写要点（三个上一版假绿/缺陷）：
 *  1. 上一版的"改前帧"借的是【别的跑】留下的旧目录（out/p1-e2e-clean）⇒ 基线不是这次跑出来的。
 *     现在全部基线都【本次自产】。
 *  2. 上一版拿 `video.setVolume`（纯音频改动）去判"画面改动可见"⇒ 期望本身就错。
 *     现在主判据是【语义】：落盘后的草稿里 volume 字段确实变了（确定性，不依赖像素）。
 *  3. 官方渲染器【同态重渲染就有噪声】（实测 17/108 帧变、最差 MAD 123.55）⇒ 裸 MAD 阈值 0.5
 *     没有判别力。现在 verify_diff 支持 noiseDir 做噪声校准，并用"负向注入"证明这条判据
 *     既不会把噪声当改动、也不会把真改动当噪声。
 *
 * 用法: node scripts/selftest-draft-edit.mjs
 * 需要: JYAI_HOME 指向 JYAI 仓库；剪映在运行；有一个带视频片段的草稿
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
// ★ 草稿路径不写死任何人的盘符：必须由调用方用 JYAI_TEST_DRAFT 指定。
//   没给就明确 SKIP（而不是拿作者机器上的路径当默认值）。
const DRAFT = process.env.JYAI_TEST_DRAFT || '';
const WORK = path.join(JYAI, 'out', 'p67', 'draft-edit-test');

let PASS = 0, FAIL = 0;
const check = (n, ok, d) => {
  if (ok) { PASS++; console.log(`  [PASS] ${n}${d ? '  — ' + d : ''}`); }
  else { FAIL++; console.log(`  [FAIL] ${n}${d ? '  — ' + d : ''}`); }
};

// ---- 通过插件自带的 MCP 客户端调动词（与 mcode 加载插件时同一套动词）----
function call(verb, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, 'run-verb.mjs'), verb, JSON.stringify(args)],
      { env: { ...process.env, JYAI_HOME: JYAI }, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => {
      let j = null; try { j = JSON.parse(so); } catch { /* 不是 JSON ⇒ 原样 */ }
      resolve({ code, json: j, text: so, stderr: se });
    });
  });
}

// ---- ffmpeg（用来合成"噪声帧"与"真改动帧"，做负向注入）----
function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  return cmd;
}
const FFMPEG = which('ffmpeg');
function sh(args) {
  return new Promise((resolve) => {
    const c = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let se = '';
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => resolve({ code, stderr: se }));
  });
}
// 把 srcDir 的帧整体做一次亮度偏移，输出到 dstDir（用同一批 PNG，保持尺寸一致）
async function shiftFrames(srcDir, dstDir, brightness) {
  fs.rmSync(dstDir, { recursive: true, force: true });
  fs.mkdirSync(dstDir, { recursive: true });
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.png')).sort();
  for (const f of files) {
    await sh(['-y', '-v', 'error', '-i', path.join(srcDir, f), '-vf', `eq=brightness=${brightness}`,
      '-frames:v', '1', path.join(dstDir, f)]);
  }
  return files.length;
}

console.log('=== 改草稿链路端到端自检 ===\n');
if (!DRAFT) {
  console.log('  [SKIP] 需要 JYAI_TEST_DRAFT —— 指向一个带视频片段的剪映草稿目录。');
  console.log('  例（PowerShell）: $env:JYAI_TEST_DRAFT = "<草稿库>\\<草稿名>"');
  console.log('  需要剪映 11.6 在运行；本自检不修改真草稿（只在副本上操作）。');
  process.exit(0);
}
console.log('  草稿:', DRAFT, '\n');

fs.mkdirSync(WORK, { recursive: true });

// ① draft_open（副本）
const open = await call('draft_open', { draft: DRAFT, copy: true });
check('① draft_open 开副本', open.code === 0 && !!open.json?.sessionId,
  open.json ? `sessionId=${open.json.sessionId} dir=${open.json.dir}` : open.text.slice(0, 160));
if (!open.json?.sessionId) { console.log(open.text.slice(0, 400) + '\n' + open.stderr.slice(0, 400)); process.exit(1); }
const sid = open.json.sessionId;
const copyDir = open.json.dir;
// ★ 副本草稿文件在【任何改动之前】的 sha ⇒ 用来断言"落盘后文件真的变了"（而不是只看了个非空）
const copyFile = path.join(copyDir, 'draft_content.json');
const sha0 = (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(copyFile)).digest('hex'); } catch { return null; } })();

// ①b ★ 读【副本的草稿文件】（磁盘，自动解密）⇒ 落盘前的基线
const readBefore = await call('draft_read', { path: path.join(copyDir, 'draft_content.json') });
let beforeDraft = null;
try { beforeDraft = JSON.parse(readBefore.text).draft; } catch { /* ignore */ }
const beforeDraftFileDisk = path.join(WORK, 'before-draft-disk.json');
if (beforeDraft) fs.writeFileSync(beforeDraftFileDisk, JSON.stringify(beforeDraft), 'utf8');
check('①b 读副本草稿（磁盘，自动解密）', readBefore.code === 0 && !!beforeDraft,
  beforeDraft ? `tracks=${(beforeDraft.tracks || []).length} → ${beforeDraftFileDisk}` : readBefore.text.slice(0, 160));

// ② draft_read 拿片段
//   ★ 原来传 scope:'segments' —— 该入参已在审计里删掉（后端不支持分段读）；
//   ★ 后来又改成了空参数 ⇒ draft_read 根本不知道读哪 ⇒ 现在必须带 sessionId
const read = await call('draft_read', { sessionId: sid });
check('② draft_read 读结构', read.code === 0, read.code === 0 ? `${read.text.length} 字符` : read.text.slice(0, 200));
let segIds = [];
let trackIds = [];
try {
  const j = JSON.parse(read.text);
  const sum = j.summary || {};
  for (const tr of (sum.tracks || [])) {
    if (tr.id) trackIds.push(tr.id);
    for (const sg of (tr.segments || [])) if (sg.id) segIds.push(sg.id);
  }
  if (!segIds.length) {
    const d = j.draft || j;
    for (const tr of (d.tracks || [])) {
      if (tr.id) trackIds.push(tr.id);
      for (const sg of (tr.segments || [])) if (sg.id) segIds.push(sg.id);
    }
  }
} catch (e) { console.log('  (解析失败: ' + e.message + ')'); }
check('②b 读到 segmentId / trackId', segIds.length > 0 || trackIds.length > 0,
  `segment ${segIds.length} 个 · track ${trackIds.length} 个${segIds.length ? '：' + segIds.slice(0, 2).join(', ') : ''}`);

// ③ 阴性：缺必填参数必须被【本地】拦下（不白跑官方）
const bad = await call('draft_patch', { op: 'video.add', sessionId: sid, params: {} });
check('★ ③ 缺必填参数被本地拦下', bad.code !== 0 && /缺少必填参数/.test(bad.text + bad.stderr),
  (bad.text + bad.stderr).split('\n').slice(0, 2).join(' / '));

// ④ 阴性：未知 op 必须被 schema 拦下
const badop = await call('draft_patch', { op: 'segment.mov', sessionId: sid, params: {} });
check('★ ④ 未知 op 被 schema 拦下', badop.code !== 0 && /不合法|未知|not allowed/i.test(badop.text + badop.stderr),
  (badop.text + badop.stderr).split('\n').slice(0, 2).join(' / '));

// ⑤ 真实改：给一个片段调音量（有 segmentId 时），否则用 track.mute / canUndo
// ⑤0 ★★ 暖机 patch：先让会话快照存在（快照 = 运行时展开形态）
//    ⇒ 后面"改前"从快照取，"改后"也从快照取 ⇒ 两边【同形态】⇒ 逐段字段差才有意义
//    （踩过的坑：改前取磁盘（精简形态，段 11 键）、改后取快照（展开形态，段 50+ 键）
//     ⇒ volume 只在展开形态里存在 ⇒ 判据【无法判定】，永远判不成）
const warm = await call('draft_patch', { op: 'undoRedo.canUndo', sessionId: sid, params: {} });
const readBeforeSession = await call('draft_read', { sessionId: sid });
let beforeDraftSession = null;
try { beforeDraftSession = JSON.parse(readBeforeSession.text).draft; } catch { /* ignore */ }
const beforeDraftFile = path.join(WORK, 'before-draft.json');
if (beforeDraftSession) fs.writeFileSync(beforeDraftFile, JSON.stringify(beforeDraftSession), 'utf8');
check('⑤0 暖机 patch + 取"改前"快照（同形态基线）',
  warm.code === 0 && readBeforeSession.code === 0 && !!beforeDraftSession,
  beforeDraftSession ? `快照=${warm.json?.snapshotSaved ? '已存' : '未存'} tracks=${(beforeDraftSession.tracks || []).length}` : readBeforeSession.text.slice(0, 160));

let patchOp = null, patchParams = null;
if (segIds.length) { patchOp = 'video.setVolume'; patchParams = { segmentId: segIds[0], volume: 0.2 }; }
else if (trackIds.length) { patchOp = 'track.mute'; patchParams = { trackId: trackIds[0] }; }
else { patchOp = 'undoRedo.canUndo'; patchParams = {}; }
const patched = await call('draft_patch', { op: patchOp, sessionId: sid, params: patchParams });
check(`⑤ draft_patch（${patchOp}）`, patched.code === 0,
  patched.code === 0 ? `baseRevision=${patched.json?.baseRevision} 快照=${patched.json?.snapshotSaved ? '已存' : '未存'}` : (patched.text + patched.stderr).split('\n').slice(0, 2).join(' / '));

// ⑥ 落盘 + 真草稿 sha 断言
const commit = await call('draft_commit', { sessionId: sid, realDraft: DRAFT });
check('⑥ draft_commit 落盘 + 真草稿零改动', commit.code === 0 && commit.json?.realDraftUnchanged === true,
  commit.code === 0 ? `encrypted=${commit.json.encrypted} cipherType=${commit.json.cipherType} relocated=${commit.json.relocated} realDraftUnchanged=${commit.json.realDraftUnchanged}` : (commit.text + commit.stderr).split('\n').slice(0, 2).join(' / '));

// ⑥b ★ 落盘后副本的草稿文件必须【真的变了】（sha 不同）—— 不许只看"文件存在且非空"
if (commit.code === 0 && copyDir) {
  const sha1 = (() => { try { return crypto.createHash('sha256').update(fs.readFileSync(copyFile)).digest('hex'); } catch { return null; } })();
  check('⑥b 落盘后草稿文件真的变了（sha 不同）', !!sha1 && !!sha0 && sha1 !== sha0,
    `before=${String(sha0).slice(0, 12)} after=${String(sha1).slice(0, 12)}`);
}

// ⑥c ★ 读回【已落盘】的副本草稿 ⇒ 语义基线（改后）
//   ★ 但要注意【形态】：磁盘上的草稿是"精简形态"（段 11 键），而落盘时写进去的是
//     【会话快照】= "运行时展开形态"（段 50+ 键）⇒ 拿磁盘改前比磁盘改后 ⇒ 两种形态混比
//   ⇒ 改前也取【会话快照】里的那份（展开形态）⇒ 两边同形态，判据才有意义
const readAfter = await call('draft_read', { sessionId: sid });
let afterDraft = null;
try { afterDraft = JSON.parse(readAfter.text).draft; } catch { /* ignore */ }
const afterDraftFile = path.join(WORK, 'after-draft.json');
if (afterDraft) fs.writeFileSync(afterDraftFile, JSON.stringify(afterDraft), 'utf8');
check('⑥c 读回落盘后的草稿（会话快照＝展开形态）', readAfter.code === 0 && !!afterDraft,
  afterDraft ? `tracks=${(afterDraft.tracks || []).length} → ${afterDraftFile}` : readAfter.text.slice(0, 160));

// ⑦ ★★ 主判据（语义）：改动真的落到草稿文件里了吗？
//   ★ 改前/改后都取【会话快照】⇒ 同形态 ⇒ 逐段字段差可比
if (beforeDraftSession && afterDraft) {
  const expect = patchOp === 'video.setVolume' ? { segmentFieldChanged: 'volume' } : { segmentsDelta: 0 };
  const v = await call('verify_diff', {
    checks: ['timeline'], beforeDraft: beforeDraftFile, afterDraft: afterDraftFile, expect,
  });
  let vj = null; try { vj = JSON.parse(v.text); } catch { /* ignore */ }
  const tl = vj?.checks?.timeline || {};
  check('★★ ⑦ 语义判据：改动确实落盘（逐段字段差）',
    v.code === 0 && vj?.verdict === 'PASS' && (tl.segmentDiffs || []).length > 0,
    `verdict=${vj?.verdict} 段数Δ=${tl.segmentsDelta} 时长Δ=${tl.durationDeltaUs} 段字段差=${(tl.segmentDiffs || []).length}`
    + (tl.segmentDiffs?.[0]?.fields?.volume ? ` volume: ${JSON.stringify(tl.segmentDiffs[0].fields.volume.before)} → ${JSON.stringify(tl.segmentDiffs[0].fields.volume.after)}` : '')
    + (vj?.problems?.length ? ` problems=${JSON.stringify(vj.problems)}` : ''));
  // ★ 负向注入：把 expect 换成"不该变的字段变了" ⇒ 必须 FAIL（证明这条判据不是恒真）
  const neg = await call('verify_diff', {
    checks: ['timeline'], beforeDraft: beforeDraftFile, afterDraft: afterDraftFile,
    expect: { segmentFieldUnchanged: 'volume' },
  });
  let nj = null; try { nj = JSON.parse(neg.text); } catch { /* ignore */ }
  check('★ ⑦b 负向注入：expect 说 volume 不该变 ⇒ 必须 FAIL', neg.code !== 0 && nj?.verdict === 'FAIL',
    `verdict=${nj?.verdict} problems=${JSON.stringify(nj?.problems)}`);
} else {
  console.log('  [SKIP] ⑦ 语义判据（没拿到改前/改后草稿）');
}

// ⑧ 渲染改后帧（本次自产）
const afterDir = path.join(WORK, 'after');
const rend = await call('render_frames', { draft: copyDir, outDir: afterDir });
check('⑧ render_frames 出帧', rend.code === 0, rend.code === 0 ? afterDir : (rend.text + rend.stderr).split('\n').slice(0, 2).join(' / '));

const framesDir = path.join(afterDir, 'frames');
if (fs.existsSync(framesDir) && fs.readdirSync(framesDir).some((f) => f.endsWith('.png'))) {
  // ⑧b ★ 探针自检：同一目录对同一目录 ⇒ 必须 FAIL（判据要有判别力）
  const same = await call('verify_diff', { beforeDir: framesDir, afterDir: framesDir, checks: ['visibility'] });
  let sj = null; try { sj = JSON.parse(same.text); } catch { /* ignore */ }
  check('★ ⑧b 探针自检：同目录对同目录 ⇒ 必须 FAIL', same.code !== 0 && sj?.verdict === 'FAIL',
    `verdict=${sj?.verdict} maxMad=${sj?.checks?.visibility?.maxMad}`);

  // ⑧c ★★ 噪声校准 + 负向注入
  //   官方渲染器同态重渲染就有噪声（实测 17/108 帧变、最差 MAD 123.55）⇒ 裸阈值 0.5 无判别力。
  //   这里用【合成噪声】（整体亮度 −0.01，实测 MAD≈4.0）当噪声基线，
  //   用【大改动】（−0.06，实测 MAD≈16.0）当真改动：
  //   校准后的判据必须 ①把噪声判成"不可见" ②把真改动判成"可见"。
  const noiseDir = path.join(WORK, 'noise-frames');
  const bigDir = path.join(WORK, 'big-frames');
  const n = await shiftFrames(framesDir, noiseDir, -0.01);
  const b = await shiftFrames(framesDir, bigDir, -0.06);
  if (n && b) {
    const vNoise = await call('verify_diff', { beforeDir: framesDir, afterDir: noiseDir, noiseDir, checks: ['visibility'] });
    let nj = null; try { nj = JSON.parse(vNoise.text); } catch { /* ignore */ }
    const nv = nj?.checks?.visibility || {};
    check('★★ ⑧c 噪声校准：同态噪声 ⇒ 必须判「不可见」',
      vNoise.code !== 0 && nj?.verdict === 'FAIL' && nv.calibrated === true,
      `verdict=${nj?.verdict} maxMad=${nv.maxMad} 噪声底=${nv.noiseMad} 判据线=${nv.noiseBar}`);

    const vBig = await call('verify_diff', { beforeDir: framesDir, afterDir: bigDir, noiseDir, checks: ['visibility'] });
    let bj = null; try { bj = JSON.parse(vBig.text); } catch { /* ignore */ }
    const bv = bj?.checks?.visibility || {};
    check('★★ ⑧d 负向注入：真改动（亮度 −0.06）⇒ 必须判「可见」',
      vBig.code === 0 && bj?.verdict === 'PASS' && bv.calibrated === true,
      `verdict=${bj?.verdict} maxMad=${bv.maxMad} 噪声底=${bv.noiseMad} 倍数=${bv.madOverNoise}`);
  } else {
    console.log('  [SKIP] ⑧c 噪声校准（合成帧失败）');
  }
} else {
  console.log('  [SKIP] ⑧b/⑧c（没有帧目录）');
}

console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL === 0 ? 0 : 1);
