// ★ 意图路由自检：在带标注的测试集上量准确率（top-1 / top-3），低于阈值 ⇒ 判失败
//   ★ 阈值【留余量】：实测 31/31，但阈值定 80%/90% ⇒ 以后改词掉几个点不会立刻红
//     （定成 100% 就是拿测试集过拟合 ⇒ 换一批真实说法就崩）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// ★ Windows 上动态 import 绝对路径必须转成 file:// URL
const { classify } = await import(pathToFileURL(path.join(HERE, 'classify-intent.mjs')).href);
const SET = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'references', 'intent-testset.json'), 'utf8'));

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
  return {
    ok: acc1 >= MIN_TOP1 && acc3 >= MIN_TOP3,
    acc1, acc3, confRate, total: cases.length, misses,
    top1, top3, confident, minTop1: MIN_TOP1, minTop3: MIN_TOP3,
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
