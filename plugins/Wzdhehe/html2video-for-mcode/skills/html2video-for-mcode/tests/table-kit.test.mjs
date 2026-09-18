// 表格工具箱: 原语必须真在生成的 tokens.css 里, 且可读性硬指标不能被改回去。
// 覆盖过的真问题: 表格文字用 caption(24px) 在手机上读不清; 行高压到 68px; 涨跌色自造色。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, tmpdir } from './helpers.mjs';
import { TABLE_CSS, hasTableKit } from '../scripts/table-css.mjs';

const proj = tmpdir();
const r = runSkill('init-project.mjs', [proj, '--topic', 'T']);
assert.equal(r.status, 0, r.stderr);
const css = fs.readFileSync(path.join(proj, 'slides', 'tokens.css'), 'utf8');

describe('表格工具箱 · 模板内容', () => {
  test('四种形态的原语都在(.tbl 数据表 / .kv 规格表 / .matrix 对比矩阵 / .rank 排名表)', () => {
    for (const sel of ['.tbl {', '.kv {', '.matrix {', '.rank {']) {
      assert.ok(css.includes(sel), `缺 ${sel}`);
    }
    assert.match(css, /\.tbl tbody tr\s*\{[^}]*height:\s*72px/, '数据表行高必须 ≥72px');
    assert.match(css, /\.rank td\s*\{[^}]*height:\s*72px/, '排名表行高必须 ≥72px');
  });

  test('主数据用正文号(视频在手机上要读得清), 表头才降到 caption', () => {
    for (const sel of ['.tbl {', '.kv {', '.matrix {', '.rank {']) {
      const i = css.indexOf(sel);
      assert.match(css.slice(i, css.indexOf('}', i)), /font-size:\s*var\(--fs-body\)/, `${sel} 主数据必须是 --fs-body`);
    }
    assert.match(css, /\.tbl th\s*\{[^}]*font-size:\s*var\(--fs-caption\)/, '表头用 caption');
  });

  test('涨跌走令牌, 高亮/合计各有语义类', () => {
    assert.match(css, /\.tbl \.up\s*\{[^}]*var\(--up\)/);
    assert.match(css, /\.tbl \.down\s*\{[^}]*var\(--down\)/);
    assert.match(css, /\.tbl tr\.key td\s*\{/, '缺高亮行 .key');
    assert.match(css, /\.tbl tr\.sum td\s*\{/, '缺合计行 .sum');
    assert.match(css, /\.tbl \.num\s*\{[^}]*text-align:\s*right[^}]*tabular-nums/, '数值列必须右对齐 + 等宽数字');
  });

  test('只画横线(不画竖线/斑马纹): 表格原语里不得出现 border-left/right 或 nth-child 斑马纹', () => {
    const block = css.slice(css.indexOf('── 表格原语'), css.indexOf('依次入场容器'));
    assert.ok(!/border-(left|right)\s*:/.test(block), '表格原语不该画竖线');
    assert.ok(!/nth-child\((odd|even)\)/.test(block), '表格原语不该有斑马纹');
  });
});

describe('表格工具箱 · 老项目升级', () => {
  test('--upgrade-css 会补表格原语, 且幂等', () => {
    const old = tmpdir();
    fs.mkdirSync(path.join(old, 'slides'), { recursive: true });
    fs.writeFileSync(path.join(old, 'slides', 'tokens.css'), ':root { --accent: #111; }\n');
    assert.equal(hasTableKit(':root { --accent: #111; }'), false);
    const r1 = runSkill('init-project.mjs', [old, '--upgrade-css']);
    assert.equal(r1.status, 0, r1.stderr);
    const after = fs.readFileSync(path.join(old, 'slides', 'tokens.css'), 'utf8');
    assert.match(after, /\.tbl tbody tr\s*\{/);
    assert.match(after, /\.matrix th\s*\{/);
    const r2 = runSkill('init-project.mjs', [old, '--upgrade-css']);
    assert.equal(fs.readFileSync(path.join(old, 'slides', 'tokens.css'), 'utf8'), after, '第二次跑不得再追加');
    assert.ok(r2.stdout.includes('无需升级'));
  });

  test('TABLE_CSS 自身通过 hasTableKit 判定(防止判定与内容脱节)', () => {
    assert.equal(hasTableKit(TABLE_CSS), true);
  });
});
