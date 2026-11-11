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
// ★ 路线定义（要知道每条路线【要哪些输入】、哪些必须问用户）
const PROFILES = (() => {
  const p = path.join(HERE, '..', 'references', 'pipeline-profiles.json');
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')).profiles || []); } catch { return []; }
})();
// ★ 诉求 → 参数（机器可读）⇒ 判决能直接带出"参数怎么填"
const IMAP = (() => {
  const p = path.join(HERE, '..', 'references', 'intent-map.json');
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')).intents || []); } catch { return []; }
})();

/** 这条路线要哪些输入？哪些【必须问用户】？（依据 pipeline-profiles.json 的 inputs 声明） */
function inputsOfRoute(routeId) {
  const prof = PROFILES.find((p) => p.id === routeId);
  const inputs = prof?.inputs || [];
  return {
    inputs: inputs.map((i) => ({ name: i.name, kind: i.kind, desc: i.desc, required: i.required !== false, from: i.from, note: i.note || null })),
    mustAsk: inputs.filter((i) => i.required !== false && i.from === 'user')
      .map((i) => ({ name: i.name, desc: i.desc, note: i.note || null })),
  };
}

/** 从 intent-map 里找出这句话对应的参数（并按路线/动词里实际的参数名改名） */
function paramsFromMap(query, routeId, skillId) {
  const q = String(query || '');
  // ★ 判决是【路线】时：参数落在该路线里那个动词的参数名上
  //   （grade_apply 用 spec，make_film 用 grade —— 两者形状相同）
  if (routeId) {
    const prof = PROFILES.find((p) => p.id === routeId);
    if (!prof) return null;
    const target = prof.steps.find((s) => s.verb === 'grade_apply') ? 'spec'
      : prof.steps.find((s) => s.verb === 'make_film') ? 'grade' : null;
    if (!target) return null;
    const hit = IMAP.find((e) => e.utterance && q.includes(e.utterance) && e.params);
    if (!hit) return null;
    const p = hit.params || {};
    return { param: target, from: hit.utterance, value: p.spec || p.grade || p };
  }
  // ★ 判决是【skill】时：从 intent-map 里找同一诉求 ⇒ 直接给出那个动词的参数
  if (skillId) {
    const hit = IMAP.find((e) => e.utterance && q.includes(e.utterance) && e.params
      && Array.isArray(e.skills) && e.skills.includes(skillId));
    if (!hit) return null;
    const p = hit.params || {};
    return { param: 'spec', verb: hit.verb, from: hit.utterance, value: p.spec || p.grade || p };
  }
  return null;
}

/** 关键词权重：长词更具体 ⇒ 权重更高；单字（如"审"）几乎没区分度
 *  ★ 权重必须【随长度增长】（原来 ≥3 字一律 3 分 ⇒ 与这条注释自相矛盾）：
 *    一句话命中"加字幕再出片"(6 字) 应当比命中"加字幕"(3 字)+"字幕"(2 字) 更像【路线】意图 ——
 *    后者只是前者的子串片段。实测：加了字幕+出片这两条路线时，权重封顶 ⇒ 通用 skill 词把路线抢走了。 */
function weight(kw) {
  const n = String(kw || '').length;
  if (n >= 3) return Math.min(8, n);
  return n;                       // 1 字 → 1 分；2 字 → 2 分
}

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

/**
 * ★ 判决模式：要么给出【明确判决】（走哪条链/路线 + 依据），要么【明确拒答】。
 *   —— classify() 是"检索线索 + 候选排序"；decide() 是"要不要拍板"。
 *
 * 拒答的两种情况：
 *   ① 最高分不够（连一个长词都没命中）⇒ 根本没线索
 *   ② 前两名分差太小（两个候选都很像）⇒ 有线索但分不清 ⇒ 也不能拍板
 *
 * ⇒ 宁可拒答，也不要拍一个错板：拍错板的代价是"整条链跑偏"，拒答的代价只是"多问一句"。
 */
export function decide(query, opts = {}) {
  const r = classify(query, opts);
  const top = r.candidates[0];
  const minScore = opts.minScore ?? 2;        // ★ 一个 2 字特异词（如"字幕""撤销"）就够开板
  // ★★ 分差只跟【不同的目标】比：同一个 skill 的两条条目并列（例如"电影感"与"导个片调个色"
  //   都指向 jianying-cut）⇒ 那不是"分不清"，那是同一个答案 ⇒ 不该因此拒答
  const targetOf = (c) => (c.kind === 'route' ? `route:${c.route}` : `skill:${c.skill}`);
  const rival = r.candidates.find((c) => c !== top && targetOf(c) !== targetOf(top)) || null;
  const second = r.candidates[1] || null;
  const minMargin = opts.minMargin ?? 1;      // ★ 与次优【不同目标】至少要拉开这么多分才敢拍板
  const base = {
    query: String(query || ''),
    candidates: r.candidates.slice(0, 3),
    confidence: top ? top.score : 0,
    top: top ? { id: top.id, kind: top.kind, skill: top.skill, route: top.route, score: top.score, matched: top.matched } : null,
    runnerUp: rival ? { id: rival.id, score: rival.score, matched: rival.matched } : null,
    runnerUpSame: second && rival && second !== rival
      ? { id: second.id, score: second.score, note: '与第一名指向同一个目标 ⇒ 不算竞争者' } : null,
  };
  if (!top || top.score < minScore) {
    return {
      ...base,
      decision: null,
      reason: `没有明确线索（最高分 ${base.confidence} < 阈值 ${minScore}）⇒ 不做判决`,
      action: '按各 Skill 的 description 自己判断，或问用户要具体诉求（要动作、要对象）',
    };
  }
  const margin = rival ? top.score - rival.score : top.score;
  if (margin < minMargin) {
    return {
      ...base,
      decision: null,
      margin,
      reason: `两个候选分差只有 ${margin}（< ${minMargin}）⇒ 有线索但分不清 ⇒ 不做判决`
        + `（第一 ${top.id} ${top.score} 分，第二 ${rival.id} ${rival.score} 分）`,
      action: '把两个候选都给用户看，让用户选（或按各 Skill 的 description 判断）',
    };
  }
  return {
    ...base,
    decision: {
      kind: top.kind,
      skill: top.skill || null,
      route: top.route || null,
      utterance: top.utterance,
    },
    margin,
    evidence: { matched: top.matched, margin, threshold: minScore },
    // ★★ 判决【带出接下来要什么】：① 需要哪些输入 ② 哪些必须问用户 ③ 参数怎么填（能查到的话）
    ...(top.route || top.skill ? (() => {
      const io = top.route ? inputsOfRoute(top.route) : { inputs: [], mustAsk: [] };
      const pm = paramsFromMap(query, top.route, top.skill);
      const mustAsk = io.mustAsk;
      return {
        ...(top.route ? { routeInputs: io.inputs, mustAsk } : { mustAsk }),
        params: pm,
        nextStep: mustAsk.length
          ? `先向用户要：${mustAsk.map((m) => m.name).join('、')}`
            + (pm ? `；${pm.param} 可以按「${pm.from}」填：${JSON.stringify(pm.value)}` : '')
          : (pm ? `参数可以直接带：${pm.param} = ${JSON.stringify(pm.value)}` : '输入齐了，可以直接跑'),
      };
    })() : {}),
    reason: `判决：走 ${top.kind === 'route' ? `路线 ${top.route}` : `skill ${top.skill}`}`
      + `（命中 ${top.matched.join('、')}，${top.score} 分，与次优【不同目标】拉开 ${margin} 分）`,
    action: '按判决走；执行中若发现判决与用户原话不符 ⇒ 停下来问，不要硬跑',
  };
}

if (isMain) {
  const wantDecide = process.argv.includes('--decide');
  // ★ 过滤掉开关本身（不然 "--decide" 会混进 query 文本里影响匹配）
  const q = process.argv.slice(2).filter((a) => a !== '--decide').join(' ');
  if (!q) { console.error('用法：node classify-intent.mjs "<一句人话>" [--decide]'); process.exit(2); }
  console.log(JSON.stringify(wantDecide ? decide(q) : classify(q), null, 2));
}
