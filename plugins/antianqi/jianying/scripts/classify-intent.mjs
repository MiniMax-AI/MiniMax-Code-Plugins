// ★ 意图分类器：给一句人话 ⇒ 给出【该走哪条链/哪条路线】的候选建议
//
//   ★ 定位要诚实：它是【检索线索 + 候选排序】，不是判决。
//     真正选链的仍然是模型按各 Skill 的 description 判断（§104 已把触发词撞车清零）。
//     这个脚本的价值：① 给模型一个可执行的候选 ② 给测试集一个可量化的准确率
//   ★ 绝不硬猜：没有命中就明说"没有明确线索"。
//
//   用法：node scripts/classify-intent.mjs "把这个草稿调暖再出片"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTES = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'references', 'intent-routes.json'), 'utf8'));

/** 关键词权重：长词更具体 ⇒ 权重更高；单字（如"审"）几乎没区分度 */
function weight(kw) { return kw.length >= 3 ? 3 : kw.length === 2 ? 2 : 1; }

/** 给一句人话打分 ⇒ 排序后的候选 */
export function classify(query, opts = {}) {
  const q = String(query || '');
  const cands = [];
  for (const r of ROUTES.routes || []) {
    const matched = [];
    let score = 0;
    for (const kw of r.keywords || []) {
      if (!kw) continue;
      if (q.includes(kw)) { matched.push(kw); score += weight(kw); }
    }
    if (!matched.length) continue;
    cands.push({
      id: r.id, kind: r.kind, skill: r.skill || null, route: r.route || null,
      utterance: r.utterance, score, matched,
    });
  }
  // ★ 同分时优先 route 级（"调完色直接出成片" 是【路线】意图，比泛泛的"pipeline"更具体）
  cands.sort((a, b) => b.score - a.score
    || (a.kind === b.kind ? 0 : a.kind === 'route' ? -1 : 1)
    || String(a.id).localeCompare(String(b.id)));
  const top = cands[0];
  const min = opts.minScore ?? 3;          // 至少一个长词，或两个短词
  const confident = !!top && top.score >= min;
  return {
    query: q,
    confident,
    candidates: cands.slice(0, 5),
    note: confident
      ? `建议走 ${top.kind === 'route' ? `路线 ${top.route}` : `skill ${top.skill}`}`
        + `（命中 ${top.matched.join('、')}）；★ 这是候选建议，最终由模型按各 Skill 的 description 判断。`
      : '没有明确线索（最高分 ' + (top ? top.score : 0) + ' < 阈值 ' + min + '）'
        + ' ⇒ 不要硬猜：按各 Skill 的 description 自己判断，或问用户。',
  };
}

/* ── CLI ── */
const isMain = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const q = process.argv.slice(2).join(' ');
  if (!q) { console.error('用法：node classify-intent.mjs "<一句人话>"'); process.exit(2); }
  console.log(JSON.stringify(classify(q), null, 2));
}
