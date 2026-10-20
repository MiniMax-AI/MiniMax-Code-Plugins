// 图表工具箱: 模板里必须真带着这些规则, 且"关动效 = 终态"这条不变量成立。
// 覆盖过三类静默失败: 缺 keyframes → 条形不生长; 静态默认 ≠ 终值 → 关动效后是空的;
// 柱高相对整列算 → 被 flex-shrink 压回, 柱高不再等于数值。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, tmpdir } from './helpers.mjs';
import { CHART_CSS, hasChartKit } from '../scripts/chart-css.mjs';

const proj = tmpdir();
const r = runSkill('init-project.mjs', [proj, '--topic', 'T']);
assert.equal(r.status, 0, r.stderr);
const css = fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8');

describe('图表工具箱 · 模板内容', () => {
  test('五个新动效类都在, 且关键帧都声明了 opacity(否则入场后永远隐形)', () => {
    for (const cls of ['fx-grow-w', 'fx-grow-h', 'fx-sweep', 'fx-count', 'fx-dot']) {
      assert.ok(css.includes('.' + cls + ' {') || css.includes('.' + cls + '{'), `缺 .${cls}`);
    }
    const names = ['fx-grow-w-kf', 'fx-grow-h-kf', 'fx-sweep-kf', 'fx-count-kf', 'fx-dot-kf'];
    for (const n of names) {
      const i = css.indexOf('@keyframes ' + n);
      assert.ok(i > -1, `缺关键帧 ${n}`);
      const body = css.slice(i, css.indexOf('\n}', i));
      assert.match(body, /opacity\s*:/, `${n} 缺 opacity(该元素会永远隐形)`);
    }
  });

  test('注册属性存在(没有它, 扫出/数字滚动无法被逐帧 seek)', () => {
    assert.match(css, /@property\s+--pv\s*\{\s*syntax:\s*'<number>'/);
    assert.match(css, /@property\s+--cnt\s*\{\s*syntax:\s*'<integer>'/);
  });

  test('静态默认 = 终值(关掉动效后画面停在完成态, 不是空的)', () => {
    assert.match(css, /\.fx-sweep\s*\{[^}]*--pv:\s*var\(--p-to/);
    assert.match(css, /\.fx-count\s*\{[^}]*--cnt:\s*var\(--n-to/);
    assert.match(css, /\.fx-grow-w\s*\{[^}]*width:\s*var\(--w/);
  });

  test('柱状三层结构齐全(绘图区 / 高度基准 / 标签), 网格在绘图区里', () => {
    assert.match(css, /\.chart-plot-cell\s*\{/, '缺 .chart-plot-cell');
    assert.match(css, /\.chart-plot-cell\.grid\s*\{[^}]*repeating-linear-gradient/, '网格必须画在绘图区上(否则与柱高两把尺子)');
    assert.match(css, /\.chart-bar-wrap\s*\{/, '缺 .chart-bar-wrap(柱高的百分比基准)');
    assert.match(css, /\.chart-bar-wrap\s+\.chart-val\s*\{[^}]*position:\s*absolute/, '数值要贴各自柱顶');
    assert.match(css, /\.chart-col\s*\{[^}]*grid-template-rows/, '列必须是 [绘图区 1fr] + [轴标签]');
    assert.match(css, /\.chart-plot-cell\s+\.chart-target\s*\{/, '目标虚线要落在绘图区里(才有 0 与轴上限的参照)');
  });

  test('横向条形的可比性: 行是三列定宽 grid, 数值外置不影响轨道长度', () => {
    assert.match(css, /\.chart-row\s*\{[^}]*grid-template-columns:\s*var\(--lbl-w[^;]*var\(--val-w/, '行必须是定宽三列');
    assert.match(css, /\.chart-val\.out\s*\{/, '缺 .chart-val.out(条外数值)');
    assert.match(css, /\.chart-bar\.dim\s+\.chart-val\s*\{/, '弱化条上的数值要自动改墨色(白字读不出来)');
  });
});

describe('图表工具箱 · 老项目升级', () => {
  test('--upgrade-css 会把图表工具箱补进老 tokens.css, 且幂等', () => {
    const old = tmpdir();
    fs.mkdirSync(path.join(old, 'slides'), { recursive: true });
    fs.writeFileSync(path.join(old, 'slides', 'tokens.css'), ':root { --accent: #111; }\n');
    assert.equal(hasChartKit(':root { --accent: #111; }'), false);
    const r1 = runSkill('init-project.mjs', [old, '--upgrade-css']);
    assert.equal(r1.status, 0, r1.stderr);
    const after = fs.readFileSync(path.join(old, 'slides', 'tokens.css'), 'utf8');
    assert.match(after, /@property\s+--pv/);
    assert.match(after, /fx-sweep-kf/);
    assert.ok(after.startsWith(':root { --accent: #111; }'), '原内容必须在前');
    const r2 = runSkill('init-project.mjs', [old, '--upgrade-css']);
    assert.equal(fs.readFileSync(path.join(old, 'slides', 'tokens.css'), 'utf8'), after, '第二次跑不得再追加');
    assert.ok(r2.stdout.includes('无需升级'));
  });

  test('CHART_CSS 自身通过 hasChartKit 判定(防止判定与内容脱节)', () => {
    assert.equal(hasChartKit(CHART_CSS), true);
  });
});
