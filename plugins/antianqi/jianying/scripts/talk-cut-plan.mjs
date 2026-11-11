#!/usr/bin/env node
/**
 * talk-cut 规划器：转写稿(SRT) → 保留区间表
 *
 * 这是"口播剪辑"的【经验层】：判断哪句是水词、哪里是长停顿、哪句是重复。
 * ★ 官方 ASR(AnalyzeAsset) 在 agent runtime 里、我们拿不到（见 §74.4），
 *   所以本脚本吃的是【用户提供的 SRT / 转写稿】。
 *
 * 用法:
 *   node scripts/talk-cut-plan.mjs --srt <file.srt> [--out <plan.json>]
 *        [--filler-ms 700] [--dup-sim 0.72] [--keep-repeats]
 *
 * 判定分三级（保守优先）：
 *   drop   整条只由水词/标点组成 ⇒ 建议整句删
 *   review 句中有实词但夹水词      ⇒ 标出水词位置，建议人工确认
 *   keep   正常内容
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const SRT = arg('--srt', null);
if (!SRT) { console.error('用法: node talk-cut-plan.mjs --srt <file.srt> [--out plan.json]'); process.exit(2); }
const OUT = arg('--out', null);
const FILLER_MS = Number(arg('--filler-ms', 700));      // 长停顿阈值
const DUP_SIM = Number(arg('--dup-sim', 0.72));        // 重复判定相似度
const KEEP_REPEATS = has('--keep-repeats');
const DUP_WINDOW = Number(arg('--dup-window', 3));   // 重复检测窗口（往前看几条）

/* 默认水词表（中文口播）：可 --filler-file 覆盖 */
const DEFAULT_FILLERS = [
  '嗯', '呃', '额', '啊', '哦', '噢', '唉', '欸', '诶', '唔',
  '那个', '这个', '就是', '然后', '所以说', '怎么说', '对吧', '是吧', '你知道',
  '怎么说呢', '对不对', '好不好', '行不行', 'emmm', 'umm', 'ah', 'eh', 'hmm', 'uh',
];
const FILLER_FILE = arg('--filler-file', null);
const FILLERS = FILLER_FILE
  ? fs.readFileSync(FILLER_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  : DEFAULT_FILLERS;

/* ---------------- SRT 解析 ---------------- */
function tsToMs(s) {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4].padEnd(3, '0'));
}
function parseSrt(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let idx = -1;
    let ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    if (ti > 0 && /^\d+$/.test(lines[0])) { idx = +lines[0]; ti = ti; }
    const [a, z] = lines[ti].split('-->');
    const startMs = tsToMs(a), endMs = tsToMs(z);
    if (startMs === null || endMs === null) continue;
    const body = lines.slice(ti + 1).join(' ').trim();
    cues.push({ index: idx >= 0 ? idx : cues.length + 1, startMs, endMs, text: body });
  }
  return cues;
}

/* ---------------- 文本工具 ---------------- */
const PUNCT = /[\s,，。！？、；：""''（）()《》<>\-—…·.!?;:"']/g;
const norm = (s) => s.replace(PUNCT, '');
function bigrams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (t.length === 1) set.add(t);
  return set;
}
function jaccard(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function findFillers(text) {
  const hits = [];
  for (const f of FILLERS) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(f, from);
      if (i < 0) break;
      hits.push({ text: f, at: i });
      from = i + f.length;
    }
  }
  hits.sort((a, b) => a.at - b.at);
  // 去掉被更长水词覆盖的短命中
  const kept = [];
  for (const h of hits) {
    if (kept.some((k) => h.at >= k.at && h.at < k.at + k.text.length)) continue;
    kept.push(h);
  }
  return kept;
}

/* ---------------- 主流程 ---------------- */
const raw = fs.readFileSync(SRT, 'utf8');
const cues = parseSrt(raw);
if (!cues.length) { console.error('SRT 里没解析出任何字幕条目'); process.exit(3); }

const outCues = [];
const dropRanges = [];
const dupOf = [];
const gaps = [];

for (let i = 0; i < cues.length; i++) {
  const c = cues[i];
  const content = norm(c.text);
  const fh = findFillers(c.text);
  const reasons = [];

  // ① 长停顿（相对上一条）
  if (i > 0) {
    const gap = c.startMs - cues[i - 1].endMs;
    if (gap >= FILLER_MS) {
      gaps.push({ startMs: cues[i - 1].endMs, endMs: c.startMs, ms: gap, afterCue: cues[i - 1].index });
      reasons.push(`长停顿 ${gap}ms`);
    }
  }

  // ② 重复（与最近 DUP_WINDOW 条比 —— 口播里"重录"常常隔一句，不只相邻）
  if (i > 0 && !KEEP_REPEATS) {
    let bestSim = 0, bestJ = -1;
    for (let k = Math.max(0, i - DUP_WINDOW); k < i; k++) {
      const sim = jaccard(c.text, cues[k].text);
      if (sim > bestSim) { bestSim = sim; bestJ = k; }
    }
    if (bestSim >= DUP_SIM) {
      reasons.push(`与第${cues[bestJ].index}条重复（相似度 ${bestSim.toFixed(2)}）`);
      dupOf.push({ cue: c.index, ofCue: cues[bestJ].index, similarity: +bestSim.toFixed(3) });
    }
  }

  // ③ 水词
  if (fh.length) reasons.push(`含水词：${fh.map((f) => f.text).join('、')}`);

  // 判定
  let verdict = 'keep';
  const onlyFiller = fh.length > 0 && content.replace(new RegExp(FILLERS.map(escapeRe).join('|'), 'g'), '').length === 0;
  if (onlyFiller && fh.length) {
    verdict = 'drop';
    reasons.unshift('整条只有水词');
  } else if (reasons.length) {
    verdict = 'review';
  }

  // 词级水词时间（按字符比例估算）
  const fillerSpans = fh.map((f) => {
    const ratio = c.text.length ? f.at / c.text.length : 0;
    const span = c.text.length ? f.text.length / c.text.length : 0;
    return { text: f.text, at: f.at,
             startMs: Math.round(c.startMs + (c.endMs - c.startMs) * ratio),
             endMs: Math.round(c.startMs + (c.endMs - c.startMs) * (ratio + span)) };
  });

  outCues.push({ index: c.index, startMs: c.startMs, endMs: c.endMs, text: c.text,
                 verdict, reasons, fillerSpans });
  if (verdict === 'drop') dropRanges.push({ startMs: c.startMs, endMs: c.endMs, reason: reasons.join(' / ') });
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* 合并保留区间（把 drop 区间从总区间里挖掉） */
function mergeRanges(rs) {
  const s = rs.slice().sort((a, b) => a.startMs - b.startMs);
  const out = [];
  for (const r of s) {
    if (out.length && r.startMs <= out[out.length - 1].endMs) {
      out[out.length - 1].endMs = Math.max(out[out.length - 1].endMs, r.endMs);
    } else out.push({ ...r });
  }
  return out;
}
const totalStart = cues[0].startMs, totalEnd = cues[cues.length - 1].endMs;
const keepRanges = [];
let cur = totalStart;
for (const d of dropRanges.slice().sort((a, b) => a.startMs - b.startMs)) {
  if (d.startMs > cur) keepRanges.push({ startMs: cur, endMs: d.startMs });
  cur = Math.max(cur, d.endMs);
}
if (cur < totalEnd) keepRanges.push({ startMs: cur, endMs: totalEnd });

const droppedMs = dropRanges.reduce((a, r) => a + (r.endMs - r.startMs), 0);
const plan = {
  schema: 'jianying.talk-cut.plan.v1',
  source: path.resolve(SRT),
  params: { fillerMs: FILLER_MS, dupSim: DUP_SIM, keepRepeats: KEEP_REPEATS, fillers: FILLERS },
  stats: {
    cues: cues.length,
    totalMs: totalEnd - totalStart,
    drop: outCues.filter((c) => c.verdict === 'drop').length,
    review: outCues.filter((c) => c.verdict === 'review').length,
    keep: outCues.filter((c) => c.verdict === 'keep').length,
    droppedMs,
    droppedRatio: +((droppedMs / Math.max(1, totalEnd - totalStart))).toFixed(4),
  },
  cues: outCues,
  dropRanges,
  keepRanges,
  gaps,
  duplicates: dupOf,
};

console.log('=== talk-cut 规划 ===');
console.log(`  字幕条数 ${plan.stats.cues} · 总时长 ${(plan.stats.totalMs / 1000).toFixed(1)}s`);
console.log(`  drop ${plan.stats.drop} · review ${plan.stats.review} · keep ${plan.stats.keep}`);
console.log(`  建议删除 ${(droppedMs / 1000).toFixed(2)}s（${(plan.stats.droppedRatio * 100).toFixed(1)}%）`);
console.log(`  长停顿 ${gaps.length} 处 · 重复 ${dupOf.length} 处`);
for (const c of outCues.filter((x) => x.verdict !== 'keep').slice(0, 12)) {
  console.log(`   [${c.verdict.toUpperCase()}] #${c.index} ${(c.startMs / 1000).toFixed(1)}s  ${c.reasons.join(' / ')}`);
}
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(plan, null, 2), 'utf8');
  console.log('\n# -> ' + OUT);
} else {
  console.log('\n（加 --out <plan.json> 保存计划）');
}
