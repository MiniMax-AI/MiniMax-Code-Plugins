#!/usr/bin/env node
// html2video-for-mcode · 实测对时: script.json + audio/*.mp3 → build/timings.json
// 这是全流水线时长的唯一事实来源。用法: node plan-timings.mjs <项目目录> [--pacing=<属性值>]
// 语种由 script.json 的 lang 决定(zh 默认 / en / yue / 其他 BCP-47), 影响语速基准与字幕行宽阈值。
// timings.json 每个 slide 含 clauses[]: 每句口播的估算开口时刻/时长, 供字幕、ASR 按句切分、对时校准共用。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { positionalDir, probeDuration, requireTool, safeId, safeOut, safeRel, subLineCap, validateScriptPaths } from './tools.mjs';

// 语种相关的计量基准。中文按"字", 英文按"字符"(含词间节奏, 与音节时长大致成正比)。
// pacing = 每单位每秒的常见语速; emPer = 单字宽按 em 折算(行宽估算用 —— 行宽公式在
// tools.subLineCap, 字幕胶囊几何的唯一来源也在 tools.SUB_GEOMETRY); pace 区间用于语速异常预警。
// yearGate = 年份逐位读的闸门只对中/粤语面开(第 24 轮: 用 emPer===1 充当语族判别是排版
// 属性代理语义, 未来 emPer:1 的语种会误触); 未知语种 fallback 不开闸。
const LANG_CFG = {
  zh: { unit: '字', pacing: 4.8, paceMin: 3, paceMax: 6.5, emPer: 1, word: null, yearGate: true },
  yue: { unit: '字', pacing: 4.8, paceMin: 3, paceMax: 6.5, emPer: 1, word: null, yearGate: true },
  en: { unit: '字符', pacing: 14, paceMin: 9, paceMax: 18, emPer: 0.44, word: 'words' },
};
const langCfg = code => LANG_CFG[code] ?? { unit: '字符', pacing: 14, paceMin: 8, paceMax: 20, emPer: 0.44, word: null };

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

  // 时间权重按**发音形态**(say ?? text)算 —— 音频念的是 say(第 24 轮: "82.3%"显示 5 字、
  // 发音"百分之八十二点三"8 字, 按显示形态分摊会把长 say 句的开口系统性估早, 字幕窗与
  // ASR 切分跟着偏)。字幕行宽(:93)仍按显示形态 text —— 胶囊几何是屏幕上的事。
  const spokenLen = c => charCount(c.say ?? c.text);
  const total = s.clauses.reduce((n, c) => n + spokenLen(c), 0);
  if (total === 0) warns.push(`${s.id}: clauses 为空, 将整张静止`);

  // 第 k 句开口时刻 ≈ 实测时长 × (前 k-1 句字数占比); stage 取该层最早一句, 再提前 LEAD
  const clauses = [];
  const stageTime = {};
  let cum = 0;
  for (const c of s.clauses) {
    const start = total > 0 ? (tts * cum) / total : 0;
    // say = 发音形态(只喂 TTS/ASR), text = 显示形态(字幕/画面) —— 原样传递给下游; chars = 发音字数(计时簿记)
    clauses.push({ stage: c.stage ?? null, start: r3(start), chars: spokenLen(c), text: c.text, ...(c.text2 ? { text2: c.text2 } : {}), ...(c.say ? { say: c.say } : {}) });
    const t = Math.max(0, start - LEAD);
    if (c.stage != null) stageTime[c.stage] = c.stage in stageTime ? Math.min(stageTime[c.stage], t) : t;
    cum += spokenLen(c);
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
  // 字幕行宽来自 tools.subLineCap(胶囊几何唯一来源; 缩放带钳位, 按宽度线性外推是错的 ——
  // 2026-09-23 复核: 中文 1080≈24 字/行、1920≈33、2560≈35)。折 2 行可读, 折 3 行起才警告。
  const subCap = subLineCap(script.width ?? 1920, CFG.emPer);
  for (const c of clauses) {
    const n = charCount(c.text);
    const lines = Math.ceil(n / subCap);
    if (lines >= 3) warns.push(`${s.id} 第 ${clauses.indexOf(c) + 1} 句 ${n} ${CFG.unit}(行宽 ≈${subCap} ${CFG.unit}/行) 会折 ${lines} 行 — 3 行起可读性差, 建议拆句(≤2 行可接受)`);
    if (c.text2 && c.text2.length > 60) warns.push(`${s.id} 第 ${clauses.indexOf(c) + 1} 句双语第二行 ${c.text2.length} 字符 > 60 — 建议精简译文`);
    // 年份读法闸门(2026-09-28 用户实测: TTS 把 2026年 念成"两千零二十六年"): 显示与发音
    // 分离 —— text 保持 2026年 上字幕, 加 say:'二零二六年' 控制发音。判别只钉无歧义的
    // "四位数字+年"(任意年份都逐位读, 不止 19xx/20xx —— 第 24 轮: 旧正则漏 1897年 这类;
    // 整读/逐位读是意图问题, 2026点 就该整读 —— 其余数字写法走文档纪律)。
    if (CFG.yearGate) {
      const spoken = c.say ?? c.text;
      const ym = /\d{4}\s*年/.exec(spoken);
      if (ym) {
        const digitsRead = ym[0].replace(/\D/g, '').split('').map(d => '零一二三四五六七八九'[+d]).join('');
        warns.push(`${s.id} 第 ${clauses.indexOf(c) + 1} 句 "${ym[0]}" 会被 TTS 按整数读(2026年→"两千零二十六年") — 年份按播报惯例逐位读: text 原样上字幕, 加 say:"${digitsRead}年…"`);
      }
    }
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
