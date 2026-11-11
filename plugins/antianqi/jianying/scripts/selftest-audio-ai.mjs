#!/usr/bin/env node
/**
 * jianying 插件：音频 AI 效果类 op 的自检（降噪 / 人声美化 / 变声）
 *   走插件自己的 draft_patch 动词（不是直连官方管道）⇒ 证明"新接进去的 op"在我们这条路上也真生效
 *   判据 = 语义：回读草稿，materials.realtime_denoises / vocal_beautifys / audio_effects 里出现新条目
 *   ★ 负向注入：改动之前这些集合必须是空的（否则探针没有判别力）
 *
 * 用法: node scripts/selftest-audio-ai.mjs
 * 需要: JYAI_HOME 指向 JYAI 仓库；剪映 11.6 在运行；JYAI_TEST_DRAFT 指向一个带音频的草稿
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
const DRAFT = process.env.JYAI_TEST_DRAFT || '';

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
const readDraft = async (sid) => {
  const r = await call('draft_read', { sessionId: sid });
  try { return JSON.parse(r.text).draft; } catch { return null; }
};
const counts = (d) => ({
  denoise: d?.materials?.realtime_denoises?.length ?? 0,
  beautify: d?.materials?.vocal_beautifys?.length ?? 0,
  effect: d?.materials?.audio_effects?.length ?? 0,
});
const segOf = (d) => (d?.tracks || []).flatMap((t) => t.segments || [])[0];

console.log('=== 音频 AI 效果自检（降噪 / 人声美化 / 变声）===\n');
if (!DRAFT) {
  console.log('  [SKIP] 需要 JYAI_TEST_DRAFT —— 指向一个带音频的剪映草稿目录。');
  console.log('  例（PowerShell）: $env:JYAI_TEST_DRAFT = "<草稿库>\\<草稿名>"');
  process.exit(0);
}

const open = await call('draft_open', { draft: DRAFT, copy: true });
if (open.failed) { console.error('打开草稿失败：\n' + (open.text + open.stderr).slice(0, 400)); process.exit(3); }
const sid = open.json.sessionId;

const d0 = await readDraft(sid);
const seg = segOf(d0);
const c0 = counts(d0);
check('① 拿到草稿并定位到第一个段', !!seg?.id, seg?.id);
check('★ ② 负向：改动前这三类 material 都是空的（探针有判别力）',
  c0.denoise === 0 && c0.beautify === 0 && c0.effect === 0,
  `denoise=${c0.denoise} beautify=${c0.beautify} effect=${c0.effect}`);

// ③ 降噪（video.denoiseOn，不是 audio.denoiseOn）
const dn = await call('draft_patch', { op: 'video.denoiseOn', sessionId: sid, params: { segmentId: seg.id, isDenoise: true } });
const d1 = await readDraft(sid);
const c1 = counts(d1);
const dnMat = d1?.materials?.realtime_denoises?.[0];
check('③ 降噪 video.denoiseOn 落进草稿', !dn.failed && c1.denoise > c0.denoise,
  dn.failed ? (dn.text + dn.stderr).replace(/\s+/g, ' ').slice(0, 120) : `realtime_denoises ${c0.denoise}→${c1.denoise} 引擎=${dnMat?.sami_name} is_denoise=${dnMat?.is_denoise}`);
check('③b 降噪参数落到 material（isDenoise→is_denoise）', dnMat?.is_denoise === true,
  `is_denoise=${dnMat?.is_denoise} denoise_mode=${dnMat?.denoise_mode} denoise_rate=${dnMat?.denoise_rate}`);

// ④ 人声美化
const vb = await call('draft_patch', { op: 'audio.setVocalBeautify', sessionId: sid, params: { segmentId: seg.id, enable: true } });
const d2 = await readDraft(sid);
const c2 = counts(d2);
const vbMat = d2?.materials?.vocal_beautifys?.[0];
check('④ 人声美化 audio.setVocalBeautify 落进草稿', !vb.failed && c2.beautify > c1.beautify,
  vb.failed ? (vb.text + vb.stderr).replace(/\s+/g, ' ').slice(0, 120) : `vocal_beautifys ${c1.beautify}→${c2.beautify}`);
check('④b 人声美化 enable 参数落到 material', vbMat?.enable === true, `enable=${vbMat?.enable} type=${vbMat?.type}`);

// ⑤ 变声
const ve = await call('draft_patch', { op: 'audio.setVoiceEffect', sessionId: sid, params: { segmentId: seg.id } });
const d3 = await readDraft(sid);
const c3 = counts(d3);
check('⑤ 变声 audio.setVoiceEffect 落进草稿', !ve.failed && c3.effect > c2.effect,
  ve.failed ? (ve.text + ve.stderr).replace(/\s+/g, ' ').slice(0,120) : `audio_effects ${c2.effect}→${c3.effect}`);

// ⑥ 段上确实挂上了引用（extra_material_refs 变了）
const refsBefore = (d0?.tracks || []).flatMap((t) => t.segments || []).find((s) => s.id === seg.id)?.extra_material_refs?.length ?? 0;
const refsAfter = (d3?.tracks || []).flatMap((t) => t.segments || []).find((s) => s.id === seg.id)?.extra_material_refs?.length ?? 0;
check('⑥ 段上 extra_material_refs 增加了（效果真的挂到段上）', refsAfter > refsBefore, `${refsBefore} → ${refsAfter}`);

console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
process.exit(FAIL === 0 ? 0 : 1);
