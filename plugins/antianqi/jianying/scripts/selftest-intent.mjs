// ★ 意图路由自检：在带标注的测试集上量准确率（top-1 / top-3），低于阈值 ⇒ 判失败
//   ★ 阈值【留余量】：实测 31/31，但阈值定 80%/90% ⇒ 以后改词掉几个点不会立刻红
//     （定成 100% 就是拿测试集过拟合 ⇒ 换一批真实说法就崩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ Windows 上动态 import 绝对路径必须转成 file:// URL
const { classify, decide } = await import(pathToFileURL(path.join(HERE, 'classify-intent.mjs')).href);
const SET = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'references', 'intent-testset.json'), 'utf8'));
// ★ 拒答集：没有明确意图的句子 ⇒ 必须【拒答】（"绝不硬猜"这条纪律的守门人）
const REFUSAL = (() => {
  const p = path.join(HERE, '..', 'references', 'intent-refusal-set.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { cases: [] };
})();

const MIN_TOP1 = Number(process.env.JYAI_INTENT_MIN_TOP1 ?? 0.8);
const MIN_TOP3 = Number(process.env.JYAI_INTENT_MIN_TOP3 ?? 0.9);

export function runIntentCheck() {
  const cases = SET.cases || [];
  let top1 = 0, top3 = 0, confident = 0;
  const misses = [];
  for (const c of cases) {
    const r = classify(c.utterance);
    if (r.confident) confident++;
    const want = c.expect.skill || c.expect.route;
    const hit = (x) => x && (x.skill === want || x.route === want);
    const t1 = hit(r.candidates[0]);
    const t3 = r.candidates.slice(0, 3).some(hit);
    if (t1) top1++;
    else misses.push({
      u: c.utterance, want,
      got: r.candidates[0] ? (r.candidates[0].skill || r.candidates[0].route) : null,
      top: r.candidates[0]?.matched,
    });
    if (t3) top3++;
  }
  const n = cases.length || 1;
  const acc1 = top1 / n, acc3 = top3 / n;
  const confRate = confident / n;

  // ★★★ 拒答集：没有明确意图的句子 ⇒ 必须 refuse（confident=false）
  const hardGuesses = [];
  for (const c of REFUSAL.cases || []) {
    const r = classify(c.utterance);
    if (r.confident) {
      hardGuesses.push({
        u: c.utterance, why: c.why,
        got: r.candidates[0] ? (r.candidates[0].route || r.candidates[0].skill) : null,
        top: r.candidates[0]?.matched,
      });
    }
  }

  // ★★★ 判决模式：① 明确句子要给出判决 ② 模糊句子必须【明确拒答】（decision=null）
  let decided = 0, decisionRight = 0, refusedOnClear = 0, decidedOnVague = 0;
  const decideProblems = [];
  for (const c of cases) {
    const d = decide(c.utterance);
    const want = c.expect.skill || c.expect.route;
    if (!d.decision) { refusedOnClear++; decideProblems.push({ u: c.utterance, why: '明确句子却没有判决', reason: d.reason }); continue; }
    decided++;
    // ★ 比较时 skill 与 route 两个维度都要看（route 条目的 skill 是 jianying-pipeline）
    if (d.decision.skill === want || d.decision.route === want) decisionRight++;
    else decideProblems.push({ u: c.utterance, why: `判决错了（期望 ${want}）`, got: d.decision.route || d.decision.skill });
  }
  for (const c of REFUSAL.cases || []) {
    const d = decide(c.utterance);
    if (d.decision) {
      decidedOnVague++;
      decideProblems.push({ u: c.utterance, why: '模糊句子却给了判决（硬猜）', got: d.decision.route || d.decision.skill });
    }
  }
  const decisionOk = refusedOnClear === 0 && decidedOnVague === 0;

  return {
    ok: acc1 >= MIN_TOP1 && acc3 >= MIN_TOP3 && hardGuesses.length === 0 && decisionOk,
    acc1, acc3, confRate, total: cases.length, misses,
    top1, top3, confident, minTop1: MIN_TOP1, minTop3: MIN_TOP3,
    // 拒答
    refusalTotal: (REFUSAL.cases || []).length, hardGuesses,
    // 判决
    decided, decisionRight, refusedOnClear, decidedOnVague, decideProblems, decisionOk,
  };
}

/* ── CLI ── */
const isMain = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const r = runIntentCheck();
  console.log('=== 意图路由自检 ===');
  console.log(`  测试句 ${r.total} 句`);
  console.log(`  top-1 命中 ${r.top1}/${r.total} = ${(r.acc1 * 100).toFixed(1)}%（阈值 ${(r.minTop1 * 100).toFixed(0)}%）`);
  console.log(`  top-3 命中 ${r.top3}/${r.total} = ${(r.acc3 * 100).toFixed(1)}%（阈值 ${(r.minTop3 * 100).toFixed(0)}%）`);
  console.log(`  "有把握"比例 ${r.confident}/${r.total} = ${(r.confRate * 100).toFixed(1)}%`);
  // ★ 拒答集
  console.log(`\n  拒答集 ${r.refusalTotal} 句：硬猜 ${r.hardGuesses.length} 句（必须 0）`);
  if (r.hardGuesses.length) {
    for (const g of r.hardGuesses) {
      console.log(`   · 「${g.u}」(${g.why}) ⇒ 硬猜成 ${g.got}${g.top ? ` 命中词:${g.top.join('、')}` : ''}`);
    }
  }
  // ★ 判决模式
  console.log(`  判决模式：明确句 ${r.decided}/${r.total} 判决（其中对 ${r.decisionRight}）`
    + ` · 明确句被拒 ${r.refusedOnClear} · 模糊句被硬判 ${r.decidedOnVague}（两个都必须 0）`);
  for (const p of r.decideProblems) {
    console.log(`   · 「${p.u}」 ⇒ ${p.why}${p.got ? ` 实际=${p.got}` : ''}${p.reason ? ` ${p.reason}` : ''}`);
  }
  if (r.misses.length) {
    console.log('\n  未命中 top-1 的句子：');
    for (const m of r.misses) {
      console.log(`   · 「${m.u}」 期望 ${m.want}，实际 ${m.got ?? '（无候选）'}${m.top ? ` 命中词:${m.top.join('、')}` : ''}`);
    }
  }
  console.log(`\n=== ${r.ok ? 'PASS' : 'FAIL'} ===`);
  if (!r.ok) {
    console.log(`★ 准确率不达标（top-1 ${(r.acc1 * 100).toFixed(1)}% / top-3 ${(r.acc3 * 100).toFixed(1)}%）`);
    console.log('★ 两条路：① 补同义词（intent-routes.json 的 keywords）② 调阈值（但别调到没意义）');
  }
  process.exit(r.ok ? 0 : 1);
}
