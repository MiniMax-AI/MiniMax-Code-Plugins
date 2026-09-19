#!/usr/bin/env node
// html2video-for-mcode · 语音识别(ASR):直接调 MiniMax REST 接口, 任何 Agent 环境都能用
// 只需要与 mmx-cli 同一把 API Key(不走 mcode connector, 也不依赖本机 whisper)。
//
// 用法:
//   node asr.mjs <项目目录>                     转写 asr/part-*.mp3, 与 checklist 的预期文本比对并回填
//   node asr.mjs <项目目录> --verify-timing     用段/字级时间戳实测每句开口时刻, 对比 timings.json(比静音检测更准)
//   node asr.mjs --file <音频> [--format json|verbose_json|srt|vtt] [--timestamp word] [--language zh]
//            [--out <项目内相对路径>](落盘转写结果; 已存在需 --force; 绝对路径/越出项目目录一律拒绝)
//
// Key 来源(按序): --api-key sk-xxx → 环境变量 MINIMAX_API_KEY
// 区域(按序): --base-url → 环境变量 MINIMAX_BASE_URL → MINIMAX_REGION(cn=api.minimaxi.com / global=api.minimax.io)
// 端点安全: Key 只发上面两个官方域; 其他 --base-url/MINIMAX_BASE_URL 一律拒绝, 自建网关需显式 --allow-any-endpoint。
// 接口约束(官方文档): wav/aiff/flac/m4a/mp3/aac/opus/ogg; 时长 ≤500s; 大小 ≤50MB。
//   超限时本脚本会用 ffmpeg 自动转成单声道 16k mp3 再传(识别率不受影响)。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { flagValue, positionals, requireTool, safeId, safeOut, validateTimingsIds } from './tools.mjs';
import { assertAsrEndpoint, PolicyError } from './url-policy.mjs';

const argv = process.argv.slice(2);
// 位置参数与取值型 flag 的清单统一在 tools.mjs(单一来源): 每个脚本自己维护一份就会漂
// (2026-09-18 复查: 三个脚本各有一份, 而 tools 那份还误把布尔开关当取值型)
const positional = positionals(argv);
// 项目目录要早定义: --file 单文件模式在上面就分流了, 而工具发现(requireTool)要用它
const dir = path.resolve(positional[0] ?? '.');

const KEY = flagValue(argv, '--api-key') || process.env.MINIMAX_API_KEY || '';
const REGION = process.env.MINIMAX_REGION || 'cn';
// 端点白名单: API Key 只发官方 MiniMax 域; 换端点必须显式 --allow-any-endpoint(危险项)。
// 防的是环境变量/提示词把 MINIMAX_BASE_URL 偷换成收集器后凭证外发。
let BASE;
try {
  BASE = assertAsrEndpoint(flagValue(argv, '--base-url') || process.env.MINIMAX_BASE_URL
    || (REGION === 'global' ? 'https://api.minimax.io' : 'https://api.minimaxi.com'),
  { allowAny: argv.includes('--allow-any-endpoint') });
} catch (e) {
  if (e instanceof PolicyError) {
    console.error(`✗ ASR 端点被拒绝: ${e.message}\n  这把 Key 只允许发往官方端点。自定义网关请确认安全后显式加 --allow-any-endpoint`);
    process.exit(1);
  }
  throw e;
}
const LANG = flagValue(argv, '--language', '');          // zh / yue / en ... 空=混合识别
const FORMAT = flagValue(argv, '--format', 'json');
const TS = flagValue(argv, '--timestamp', '');           // '' | sentence | word

if (!KEY) {
  console.error([
    '✗ 缺 API Key(ASR 需要与 mmx-cli 同一把 Key)。三选一:',
    '  1) export MINIMAX_API_KEY=sk-xxx      (推荐, 只存在环境里)',
    '  2) node asr.mjs <项目> --api-key sk-xxx',
    '  3) 海外套餐加 MINIMAX_REGION=global(或 --base-url https://api.minimax.io)',
    '  查额度与身份: mmx quota / mmx auth status',
  ].join('\n'));
  process.exit(2);
}

// 超限自动转码成单声道 16k mp3(500s/50MB 硬限制)
function prepareForUpload(file) {
  const st = fs.statSync(file);
  const FFMPEG = requireTool('ffmpeg', dir);
  const p = spawnSync(requireTool('ffprobe', dir), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', windowsHide: true });
  const dur = parseFloat((p.stdout || '').trim());
  if (st.size <= 50 * 1024 * 1024 && (!Number.isFinite(dur) || dur <= 500)) return { file, tmp: null };
  const tmp = path.join(path.dirname(file), `.asr-${path.basename(file, path.extname(file))}.16k.mp3`);
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '128k', tmp], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) { console.error(`✗ 转码失败: ${file}`); process.exit(1); }
  console.log(`  (超限已转码: ${path.basename(file)} → 单声道 16k)`);
  return { file: tmp, tmp };
}

async function transcribe(file, { format = FORMAT, ts = TS, language = LANG } = {}) {
  const { file: up, tmp } = prepareForUpload(file);
  try {
    const fd = new FormData();
    fd.append('model', 'asr-1.0');
    fd.append('response_format', format);
    if (ts) fd.append('timestamp_level', ts);
    fd.append('file', new Blob([fs.readFileSync(up)], { type: 'audio/mpeg' }), path.basename(up));
    const headers = { Authorization: `Bearer ${KEY}` };
    if (language) headers.language = language; // 'zh' 强制普通话; 'yue' 确认粤语
    let res;
    try {
      res = await fetch(`${BASE}/v1/speech_to_text`, { method: 'POST', headers, body: fd, signal: AbortSignal.timeout(180000) });
    } catch (e) {
      throw new Error(`网络请求失败(${BASE}): ${e.message}\n  → 检查网络/代理; 海外套餐加 MINIMAX_REGION=global`);
    }
    const raw = await res.text();
    if (!res.ok) {
      let hint = '';
      if (res.status === 401) hint = ' → Key 与 region 是否匹配?(国内用 cn, 海外用 global)';
      if (res.status === 402) hint = ' → 额度不足, mmx quota 看余额';
      if (res.status === 429) hint = ' → 限流, sleep 10–30s 后重试';
      if (res.status === 422) hint = ' → 音频含敏感内容';
      throw new Error(`HTTP ${res.status}${hint}\n${raw.slice(0, 300)}`);
    }
    if (format === 'srt' || format === 'vtt') return { text: raw, raw };
    const j = JSON.parse(raw);
    return { text: j.text ?? '', duration: j.duration, segments: j.segments, n_speakers: j.n_speakers, raw: j };
  } finally {
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp);
  }
}

// --from <file.json>: 不打网络, 直接用已有转写结果(JSON: { "part-01-1.mp3": "文本", ... }
// 或 { "part-01-1": "文本" })做比对与回填 —— 例如你在别的环境用 whisper 转写完再进来核对。
const FROM = (() => {
  const f = flagValue(argv, '--from');
  if (!f) return null;
  if (!fs.existsSync(f)) { console.error(`✗ 找不到 --from 文件: ${f}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
})();
const fromLookup = name => {
  if (!FROM) return null;
  const base = name.replace(/\.[^.]+$/, '');
  return FROM[name] ?? FROM[base] ?? FROM[path.basename(name)] ?? FROM[path.basename(base)] ?? null;
};

// ── 文本比对:数字必须一致(硬要求), 出现繁体字/相似度过低则判不通过 ──
const norm = s => String(s || '').replace(/[\s，。、；：！？,.;:!?"'“”‘’()（）\-—…]/g, '');
// 常见"仅繁体"用字(简体写法不同者)。启发式:命中任意一个即提示人工复核 ——
// 我们的口播稿一律简体, 识别结果出现繁体通常意味着音色实际输出粤语/其他语种。
const TRAD_ONLY = '們來從這個時後裡為與對發現經濟億萬說國學會語寫讀聽東車馬門開關長張聲畫點無龍書當雖應該積極幾號樣麼將帶鐵銀錢樂藥歡機場頭題類數體腦鋼護讓認識記計討論詞課實寶確網絡線組織統較轉輪農業產業務員團圖園圓遠邊過進運遊達適選遺醫鐘錯鏡陽陰隨險隱雙雜難靈靜頁順預領頻願風飛飯飲館駕騎驗黨讀寫個們';
function checkText(expected, got, lang = 'zh') {
  const e = norm(expected), g = norm(got);
  const digits = [...new Set((expected.match(/\d+(\.\d+)?%?/g) || []))];
  const missingDigits = digits.filter(d => !g.includes(d));
  const issues = [];
  if (missingDigits.length) issues.push(`数字对不上: ${missingDigits.join(' ')}`);
  let langBad = false;
  if (lang === 'zh') {
    // 期望普通话: 出现"仅繁体"用字通常意味着音色实际输出粤语/其他语种
    const trad = [...new Set([...g].filter(c => TRAD_ONLY.includes(c)))];
    if (trad.length) { issues.push(`疑似非普通话(出现繁体字 ${trad.slice(0, 4).join('')})`); langBad = true; }
  } else if (lang === 'en') {
    // 期望英语: 转写里混入成片中文说明是语种错了
    const cjk = [...new Set([...g].filter(c => /[\u4e00-\u9fff]/.test(c)))];
    if (cjk.length) { issues.push(`疑似非英语(出现中文字符 ${cjk.slice(0, 4).join('')})`); langBad = true; }
  }
  // 相似度: 1 - 编辑距离/最长长度
  const m = e.length, n = g.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...Array(n).fill(0)];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (e[i - 1] === g[j - 1] ? 0 : 1));
    prev = cur;
  }
  const sim = m && n ? 1 - prev[n] / Math.max(m, n) : 0;
  if (sim < 0.5) issues.push(`相似度过低 ${sim.toFixed(2)}`);
  else if (sim < 0.7) issues.push(`相似度偏低 ${sim.toFixed(2)}`);
  const hard = missingDigits.length > 0 || langBad || sim < 0.5;
  return { sim, issues, verdict: hard ? '✗' : (sim < 0.7 ? '⚠' : '✓') };
}

// ── 模式 1: 单文件转写 ──
if (flagValue(argv, '--file')) {
  const f = flagValue(argv, '--file');
  if (!fs.existsSync(f)) { console.error(`✗ 不存在: ${f}`); process.exit(1); }
  // --out 收监 + 不覆盖(1.7.5 复查③): 此前是任意路径裸写、静默覆盖。校验必须放在 transcribe
  // 之前 —— 路径非法/覆盖拒绝不该等一次网络请求之后才报(测试也因此不需要网络)。
  const outRaw = flagValue(argv, '--out');
  let outPath = null;
  if (outRaw) {
    if (path.isAbsolute(outRaw)) { console.error(`✗ --out 必须是项目目录内的相对路径(收到绝对路径): ${outRaw}`); process.exit(1); }
    outPath = safeOut(dir, outRaw);
    if (fs.existsSync(outPath) && !argv.includes('--force')) {
      console.error(`✗ --out 已存在, 不覆盖: ${path.relative(dir, outPath)}(要覆盖加 --force)`);
      process.exit(1);
    }
  }
  let r;
  try { r = await transcribe(f); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  if (outPath) fs.writeFileSync(outPath, FORMAT === 'srt' || FORMAT === 'vtt' ? r.text : (r.raw ? JSON.stringify(r.raw, null, 2) : r.text));
  if (FORMAT === 'srt' || FORMAT === 'vtt') console.log(r.text);
  else console.log(r.text + (r.duration ? `\n(duration ${r.duration}s${r.n_speakers ? `, ${r.n_speakers} speakers` : ''})` : ''));
  process.exit(0);
}

// ── 模式 2/3: 项目目录 ──
const asrDir = path.join(dir, 'asr');
if (!fs.existsSync(asrDir)) { console.error(`✗ 找不到 ${asrDir} — 先跑 build-video.mjs <项目> --asr 生成按句切分的音频`); process.exit(1); }
const timingsPath = path.join(dir, 'build', 'timings.json');
const timings = fs.existsSync(timingsPath) ? JSON.parse(fs.readFileSync(timingsPath, 'utf8')) : null;
if (timings) validateTimingsIds(timings);

// 模式 3: 用 ASR 时间戳实测句开口, 校对比 timings 估算
if (argv.includes('--verify-timing') && timings) {
  let drift = 0, n = 0, worst = null;
  console.log('ASR 实测句开口(字/段级时间戳) vs plan-timings 估算:\n');
  for (const t of timings.slides) {
    if (!Array.isArray(t.clauses) || t.clauses.length < 2) continue;
    const tid = safeId(t.id);
    const audio = path.join(dir, 'audio', `${tid}.mp3`);
    if (!fs.existsSync(audio)) { console.warn(`- 跳过 ${t.id}: 缺音频`); continue; }
    const r = await transcribe(audio, { format: 'verbose_json', ts: 'word' });
    const units = r.segments || [];
    const rows = [];
    for (let k = 1; k < t.clauses.length; k++) {
      const needle = norm(t.clauses[k].text).slice(0, 4); // 用该句前 4 字做锚
      const hit = units.find(u => norm(u.text).includes(needle));
      const est = t.clauses[k].start;
      if (hit) { drift += Math.abs(hit.start - est); n++; if (!worst || Math.abs(hit.start - est) > Math.abs(worst.diff)) worst = { id: t.id, k: k + 1, diff: +(hit.start - est).toFixed(2) }; }
      rows.push(`    第${k + 1}句开口 估算 ${est}s | ASR 实测 ${hit ? hit.start.toFixed(2) + 's' : '(锚点没找到, 换更长的锚词)'} | 差 ${hit ? (hit.start - est).toFixed(2) : '-'}s`);
    }
    console.log(`  ${t.id}:`);
    console.log(rows.join('\n'));
  }
  if (n) console.log(`\n平均偏差 ${(drift / n).toFixed(2)}s, 最大 ${worst ? worst.id + ' 第' + worst.k + '句 ' + worst.diff + 's' : '-'}`);
  console.log('偏差普遍 >0.3s 时: 用 check-timing.mjs --calibrate(静音法)或用本结果手工改 timings.json 的 clauses[].start。');
  process.exit(0);
}

// 模式 2: 批量转写 + 与 checklist 对比回填
const parts = fs.readdirSync(asrDir).filter(f => /^part-.*\.(mp3|wav|m4a|aac|opus|ogg)$/i.test(f)).sort();
if (!parts.length) { console.error(`✗ ${asrDir} 里没有 part-* 音频`); process.exit(1); }
// 项目语种: script.json 的 lang 决定默认识别语言(zh 强制普通话 / en / yue ...), 也决定语种校验策略
const scriptJsonPath = path.join(dir, 'script.json');
const projectLang = fs.existsSync(scriptJsonPath) ? (JSON.parse(fs.readFileSync(scriptJsonPath, 'utf8')).lang ?? 'zh') : 'zh';
const useLang = LANG || projectLang;
const ckPath = safeOut(dir, 'asr', 'checklist.md');
let ck = fs.existsSync(ckPath) ? fs.readFileSync(ckPath, 'utf8') : '';
const results = [];
for (const p of parts) {
  const f = path.join(asrDir, p);
  try {
    const r = FROM ? { text: fromLookup(p) ?? '' } : await transcribe(f, { language: useLang });
    const rowRe = new RegExp(`\\|\\s*asr/${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|`);
    const mm = ck.match(rowRe);
    const expected = mm ? mm[2].trim() : '';
    const verdict = expected ? checkText(expected, r.text, projectLang) : null;
    results.push({ p, text: r.text, expected, verdict });
    if (mm) {
      // 函数替换: 转写文本里的 $& / $1 否则会被当替换模式展开, 弄脏 checklist 行
      ck = ck.replace(rowRe, () => `| asr/${p} |${mm[1]}|${mm[2]}| ${r.text} | ${verdict ? verdict.verdict + (verdict.issues.length ? ' ' + verdict.issues.join('; ') : '') : ''} |`);
    }
    console.log(`${verdict ? verdict.verdict : '·'} ${p}  ${r.text}${verdict && verdict.issues.length ? '\n    ⚠ ' + verdict.issues.join('; ') : ''}`);
  } catch (e) {
    console.error(`✗ ${p}: ${e.message}`);
    results.push({ p, error: e.message });
  }
}
if (ck) { fs.writeFileSync(ckPath, ck); console.log(`\n已回填 asr/checklist.md(转写 + 判定)`); }
const bad = results.filter(r => r.verdict?.verdict === '✗').length;
const warn = results.filter(r => r.verdict?.verdict === '⚠').length;
// 请求失败(鉴权/限流/网络)此前只记进 results 不进统计 → "1 通过 / 0 不通过 / 退出 0" 把闸门放过去了
// (二审 P2): 它们必须单独计数、不算通过, 且整轮非零退出
const errored = results.filter(r => r.error);
console.log(`\n完成: ${results.length - bad - warn - errored.length} 通过 / ${warn} 待复核 / ${bad} 不通过${errored.length ? ` / ${errored.length} 请求失败` : ''}`);
if (bad || errored.length) {
  if (bad) console.error('不通过项: 数字或语种不符 —— 改口播或重做该段 TTS, 重跑 plan-timings 与该张渲染。');
  if (errored.length) console.error(`请求失败 ${errored.length} 段(鉴权/限流/网络): ${errored.map(r => r.p).join(' ')} — 这些段没有校验结论, 修好网络或 Key 后重跑; 不能当通过。`);
  process.exit(1);
}
