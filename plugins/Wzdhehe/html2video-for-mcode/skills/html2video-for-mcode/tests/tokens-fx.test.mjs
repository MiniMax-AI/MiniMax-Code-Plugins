// 模板自检: 生成出来的 tokens.css 里, 每个"入场类" fx 的关键帧都必须声明 opacity。
// 背景: [data-stage] 的基础态是 opacity:0, 入场靠 animation 的 both 填充把 opacity 抬回 1;
// 关键帧若不碰 opacity, 该元素入场后永远不可见(2026-09-18 实测踩过 fx-grow-x/y 与 fx-spotlight)。
// 这条规则以前只写在 check-slides 的逐张检查里 —— 只有用户刚好用到那个类才报; 这里对模板本身断言。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, tmpdir } from './helpers.mjs';

function parseFx(css) {
  const classes = new Map(); // .fx-name → { anim, infinite }
  for (const m of css.matchAll(/\.(fx-[a-z-]+)\s*\{([^}]*)\}/g)) {
    const decl = m[2];
    const a = /animation\s*:\s*([^;}]+)/.exec(decl);
    if (!a) continue; // 容器类(如 .fx-stagger)不算
    classes.set(m[1], { anim: a[1].trim().split(/\s+/)[0], infinite: /\binfinite\b/.test(a[1]) });
  }
  // 关键帧体要按括号配对取(单行写法 @keyframes x { from {…} to {…} } 不能靠"行尾 }"切)
  const kf = new Map(); // 关键帧名 → 是否声明了 opacity
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 0, end = -1;
    for (let j = m.index + m[0].length - 1; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { end = j; break; }
    }
    if (end < 0) continue;
    kf.set(m[1], /(^|[;{\s])opacity\s*:/.test(css.slice(m.index + m[0].length, end)));
    re.lastIndex = end;
  }
  return { classes, kf };
}

describe('模板 tokens.css: 入场类必须能从 opacity:0 抬回来', () => {
  const proj = tmpdir();
  const r = runSkill('init-project.mjs', [proj, '--topic', 'T']);
  assert.equal(r.status, 0, r.stderr);
  const css = fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8');
  const { classes, kf } = parseFx(css);

  test('解析到了 fx 类与关键帧(防止正则失效后测试假绿)', () => {
    assert.ok(classes.size >= 10, `只解析到 ${classes.size} 个 fx 类`);
    assert.ok(kf.size >= 8, `只解析到 ${kf.size} 组关键帧`);
  });

  test('非无限(入场)动画的关键帧都声明了 opacity', () => {
    const bad = [];
    for (const [cls, { anim, infinite }] of classes) {
      if (infinite) continue;                  // 氛围类不承载入场, 不受基础态影响
      if (!kf.has(anim)) { bad.push(`${cls} → 找不到关键帧 ${anim}`); continue; }
      if (!kf.get(anim)) bad.push(`${cls} → @keyframes ${anim} 没有 opacity(该元素会永远隐形)`);
    }
    assert.deepEqual(bad, []);
  });

  test('no-fx 规则含 opacity 重置(只关动画不管基础态 = 整片空白)', () => {
    assert.match(css, /\.no-fx\s+\[data-stage\][^{]*\{[^}]*opacity\s*:\s*1\s*!important/);
  });

  test('.fx-stagger 入场规则全部排除 [data-stage](2026-09-18 实测: nth-child 延迟特异度更高, 会覆盖子元素自己的时刻)', () => {
    // 根因: .fx-stagger > *:nth-child(n) 的特异度(0,2,0) > .fx-up 等(0,1,0), 且写在文件末尾 →
    // 容器内带 data-stage 的子元素会被 stagger 的 --stagger-base 时刻接管(实测提前 3 秒冒头)。
    // 注意排除 .no-fx 前缀的重置规则 —— 它们本就该作用于所有子元素(含带 data-stage 的, 那是"关动画")
    // 看整行选择器: no-fx 重置写成多选择器(.no-fx [data-stage], .no-fx .fx-stagger > * {),
    // 从 .fx-stagger 处起匹配拿不到前缀, 所以按行判定
    const staggerRules = [...css.matchAll(/\.fx-stagger\s*>\s*([^{]+)\{/g)]
      .filter(m => {
        const lineStart = css.lastIndexOf('\n', m.index) + 1;
        return !css.slice(lineStart, m.index + m[0].length).includes('.no-fx');
      })
      .map(m => m[1].trim());
    assert.ok(staggerRules.length >= 9, `应解析到 9 条入场 stagger 规则, 实际 ${staggerRules.length}: ${staggerRules.join(' | ')}`);
    const bad = staggerRules.filter(sel => !sel.includes(':not([data-stage])'));
    assert.deepEqual(bad, [], '每条入场 stagger 选择器都必须带 :not([data-stage])');
  });
});

describe('init-project --upgrade-css: 老项目补 no-fx 规则', () => {
  const stale = () => {
    const proj = tmpdir();
    fs.mkdirSync(path.join(proj, 'slides'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'slides', 'tokens.css'), ':root { --accent: #111; }\n');
    fs.writeFileSync(path.join(proj, 'script.json'), '{"slides":[]}');
    return proj;
  };

  test('缺规则 → 追加, 且不碰其他文件', () => {
    const proj = stale();
    const r = runSkill('init-project.mjs', [proj, '--upgrade-css']);
    assert.equal(r.status, 0, r.stderr);
    const css = fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8');
    assert.match(css, /\.no-fx\s+\[data-stage\][^{]*\{[^}]*opacity\s*:\s*1\s*!important/);
    assert.ok(css.startsWith(':root { --accent: #111; }'), '原有内容必须在前');
    assert.equal(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'), '{"slides":[]}', 'script.json 不得被动');
    assert.ok(!fs.existsSync(path.join(proj, 'slides', '_template.html')), '不得生成新文件');
  });

  test('幂等: 再跑一次不重复追加', () => {
    const proj = stale();
    runSkill('init-project.mjs', [proj, '--upgrade-css']);
    const once = fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8');
    const r = runSkill('init-project.mjs', [proj, '--upgrade-css']);
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8'), once);
    assert.ok(r.stdout.includes('无需升级'));
  });

  test('没有 tokens.css → 退出 1', () => {
    const r = runSkill('init-project.mjs', [tmpdir(), '--upgrade-css']);
    assert.equal(r.status, 1);
  });
});
