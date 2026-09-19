#!/usr/bin/env node
// html2video-for-mcode · 实测对时: script.json + audio/*.mp3 → build/timings.json
// 这是全流水线时长的唯一事实来源。用法: node plan-timings.mjs <项目目录> [--pacing=<属性值>]
// 语种由 script.json 的 lang 决定(zh 默认 / en / yue / 其他 BCP-47), 影响语速基准与字幕行宽阈值。
// timings.json 每个 slide 含 clauses[]: 每句口播的估算开口时刻/时长, 供字幕、ASR 按句切分、对时校准共用。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { positionalDir, probeDuration, requireTool, safeId, safeOut, safeRel, validateScriptPaths } from './tools.mjs';

// 语种相关的计量基准。中文按"字", 英文按"字符"(含词间节奏, 与音节时长大致成正比)。
// pacing = 每单位每秒的常见语速; subMax = 字幕单行建议上限; pace 区间用于语速异常预警。
const LANG_CFG = {
  zh: { unit: '字', pacing: 4.8, paceMin: 3, paceMax: 6.5, subMax: 18, word: null },
  yue: { unit: '字', pacing: 4.8, paceMin: 3, paceMax: 6.5, subMax: 18, word: null },
  en: { unit: '字符', pacing: 14, paceMin: 9, paceMax: 18, subMax: 42, word: 'words' },
};
const langCfg = code => LANG_CFG[code] ?? { unit: '字符', pacing: 14, paceMin: 8, paceMax: 20, subMax: 42, word: null };

const argv = process.argv.slice(2);
const dir = positionalDir(argv);
const LEAD = 0.2; // 视觉比语音提前出现秒数(广播惯例, 观感同步)

process.env.KIT_PROJECT_DIR = dir;
const FFPROBE = requireTool('ffprobe', dir);

const scriptPath = path.join(dir, 'script.json');
if (!fs.existsSync(scriptPath)) { console.error(`✗ 找不到 ${scriptPath}`); process.exit(1); }
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
validateScriptPaths(script, dir); // script.json 是 agent 可编辑文件: id/audio 派生路径先收监
const fps = script.fps ?? 30;
const LANG = script.lang ?? 'zh';
const CFG = langCfg(LANG);
const pacingArg = argv.find(a => a.startsWith('--pacing='));
const pacing = pacingArg ? parseFloat(pacingArg.slice(9)) : CFG.pacing;
// 试听时与用户定的语速(1.6.0): script.speed 此前是纯声明、没有任何脚本读它 → "语速偏慢"只能靠人耳发现。
// 现在拿它当期望值: 实测语速(字数÷实测音频时长)偏离 期望基准×speed 超过 20% 就告警, 越界也告警。
const SPEED = (() => {
  const v = script.speed;
  const n = Number(typeof v === 'object' && v !== null ? v.default : v);
  return Number.isFinite(n) && n > 0 ? n : 1.0;
})();

const probeDur = file => probeDuration(FFPROBE, file);   // 探测收进 tools.mjs 单一实现(第十三轮 review 去重)
const charCount = s => String(s ?? '').replace(/\s+/g, '').length;
const r3 = x => Math.round(x * 1000) / 1000;

const rows = [];
const warns = [];
for (const s of script.slides) {
  const audioPath = safeRel(path.join(dir, 'audio'), s.audio ?? `${safeId(s.id)}.mp3`, { where: `slides[${s.id}].audio` });
  if (!fs.existsSync(audioPath)) { console.error(`✗ 缺音频 ${audioPath} — 先完成 Phase 2 TTS`); process.exit(1); }
  const tts = probeDur(audioPath);
  if (tts == null) { console.error(`✗ ffprobe 读不出时长: ${audioPath}`); process.exit(1); }

  const total = s.clauses.reduce((n, c) => n + charCount(c.text), 0);
  if (total === 0) warns.push(`${s.id}: clauses 为空, 将整张静止`);

  // 第 k 句开口时刻 ≈ 实测时长 × (前 k-1 句字数占比); stage 取该层最早一句, 再提前 LEAD
  const clauses = [];
  const stageTime = {};
  let cum = 0;
  for (const c of s.clauses) {
    const start = total > 0 ? (tts * cum) / total : 0;
    clauses.push({ stage: c.stage ?? null, start: r3(start), chars: charCount(c.text), text: c.text, ...(c.text2 ? { text2: c.text2 } : {}) });
    const t = Math.max(0, start - LEAD);
    if (c.stage != null) stageTime[c.stage] = c.stage in stageTime ? Math.min(stageTime[c.stage], t) : t;
    cum += charCount(c.text);
  }
  clauses.forEach((c, i) => { c.dur = r3((clauses[i + 1]?.start ?? tts) - c.start); });
  Object.assign(stageTime, s.stageTimes ?? {}); // 显式 stageTimes 覆盖优先

  const tail = s.tail ?? 0.8;
  const duration = Math.ceil((tts + tail) * fps) / fps; // 对齐帧网格
  const wps = tts > 0 ? total / tts : 0;

  if (wps > 0 && (wps < CFG.paceMin || wps > CFG.paceMax)) warns.push(`${s.id}: 语速 ${wps.toFixed(1)} ${CFG.unit}/s (${LANG} 常见 ${CFG.paceMin}–${CFG.paceMax}) — 检查 speed 或字数, 或用 --pacing 重估`);
  // 与 script.speed 对账(1.6.0): 期望 = 基准 × speed; 实测偏离 >20% 说明该段 TTS 没用这个 speed
  const expect = CFG.pacing * SPEED;
  if (wps > 0 && Math.abs(wps - expect) > expect * 0.2) {
    warns.push(`${s.id}: 实测语速 ${wps.toFixed(1)} ${CFG.unit}/s 与 script.speed=${SPEED} 的期望 ${expect.toFixed(1)} 差 ${(Math.abs(wps - expect) / expect * 100).toFixed(0)}% — 该段 TTS 可能没用这个 speed(试听定的是 ${SPEED}), 或字数估算错了; 复核后重做该段 TTS 或改 script.speed`);
  }
  if (duration > 15) warns.push(`${s.id}: ${duration.toFixed(1)}s 超过 15s — 建议拆成两张`);
  const stages = Object.keys(stageTime).map(Number);
  const last = stages.length ? Math.max(...stages) : 0;
  if (last > 0 && duration - (stageTime[last] ?? 0) < 1.2) warns.push(`${s.id}: 最后一个 stage 在 ${stageTime[last].toFixed(1)}s, 距收尾不足 1.2s — 观众看不清, 建议 tail 加大或精简口播`);
  for (const c of clauses) {
    const n = charCount(c.text);
    if (n > CFG.subMax) warns.push(`${s.id} 第 ${clauses.indexOf(c) + 1} 句 ${n} ${CFG.unit} > ${CFG.subMax}, 字幕会换行 — 建议拆句`);
    if (c.text2 && c.text2.length > 60) warns.push(`${s.id} 第 ${clauses.indexOf(c) + 1} 句双语第二行 ${c.text2.length} 字符 > 60 — 建议精简译文`);
  }

  rows.push({
    id: s.id, tts: r3(tts), duration: r3(duration),
    chars: total, wps: +wps.toFixed(2), stages: stageTime, clauses,
    script: s.clauses.map(c => c.text).join(''),
  });
}

const totalDur = rows.reduce((n, r) => n + r.duration, 0);
fs.mkdirSync(safeOut(dir, 'build'), { recursive: true });
fs.writeFileSync(safeOut(dir, 'build', 'timings.json'),
  JSON.stringify({ fps, lang: LANG, pacing, lead: LEAD, total: r3(totalDur), slides: rows }, null, 2) + '\n');

const unitLabel = `量(${CFG.unit})`;
console.table(rows.map(({ id, tts, duration, chars, wps, stages }) =>
  ({ id, 'TTS(s)': tts, '成片(s)': duration, [unitLabel]: chars, [`${CFG.unit}/s`]: wps, 'stage时刻': JSON.stringify(stages) })));
console.log(`总时长: ${totalDur.toFixed(1)}s · 语言 ${LANG}(${CFG.unit}基准 ${pacing}/${CFG.unit}·s⁻¹ · script.speed=${SPEED}) → build/timings.json`);
if (SPEED < 0.8 || SPEED > 1.4) warns.unshift(`script.speed = ${SPEED} 超出常规区间 0.8–1.4 — 确认是不是写错(或 TTS 调用与它不一致)`);
if (warns.length) { console.warn('\n⚠ 警告:'); for (const w of warns) console.warn('  - ' + w); }
console.log('\n下一步可选: node scripts/check-timing.mjs <项目目录>  用静音检测实测每句开口时刻, 对比/校准估算。');
