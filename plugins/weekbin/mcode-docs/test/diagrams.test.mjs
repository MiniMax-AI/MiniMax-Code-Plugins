import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 架构图的机械回归。
//
// 图是文档里最容易悄悄坏掉的部分：改了一张忘了改另一张、语言混进另一版、
// 挪动坐标把箭头指到别的框上——这些都不会让 HTML 校验失败，只会让人读错。
// 这里钉住的是「可判定」的那几类；图的语义正确性由 verify/domains/architecture.mjs
// 逐条钉源码证据，不在此重复。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const PAGES = ['site/index.html', 'site/index.en.html'];

const figures = (html) => html.match(/<figure class="diagram">[\s\S]*?<\/figure>/g) ?? [];
// 只取 figure 内的 svg：页面另有 7 个 aria-hidden 的装饰图标，
// 它们本就没有 <title>，混进来会让可访问性与配平检查失去意义。
const svgs = (html) => figures(html).map((f) => f.match(/<svg\b[\s\S]*?<\/svg>/g)?.[0]).filter(Boolean);

/** 极简的标签配平检查：只认我们真的会写出来的标签，不做通用 XML 解析。 */
function tagsBalanced(svg) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  const VOID = new Set(['defs', 'path', 'rect', 'line', 'circle', 'use', 'stop', 'marker', 'ellipse', 'polyline', 'polygon']);
  for (const m of svg.matchAll(re)) {
    const [, closing, name, attrs, selfClose] = m;
    if (VOID.has(name) || selfClose === '/' || (attrs || '').trim().endsWith('/')) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

test('两站各 3 张架构图，数量一致', () => {
  const counts = PAGES.map((p) => figures(read(p)).length);
  assert.equal(counts[0], 3, `${PAGES[0]} 有 ${counts[0]} 张`);
  assert.equal(counts[1], counts[0], '两站图数必须一致');
});

test('两站图的结构逐一对应：同序、同 viewBox、同节点数、同连线数', () => {
  const [zh, en] = PAGES.map((p) => svgs(read(p)).map((s) => ({
    viewBox: s.match(/viewBox="([^"]+)"/)?.[1],
    rects: (s.match(/<rect\b/g) ?? []).length,
    texts: (s.match(/<text\b/g) ?? []).length,
    edges: (s.match(/class="dg-edge/g) ?? []).length,
  })));
  assert.equal(zh.length, en.length);
  for (let i = 0; i < zh.length; i++) {
    assert.deepEqual(en[i], zh[i], `第 ${i + 1} 张图两站结构不一致`);
  }
});

test('每张图都有可访问名称：role="img" 与 <title>', () => {
  for (const p of PAGES) {
    for (const svg of svgs(read(p))) {
      assert.match(svg, /role="img"/, `${p} 缺 role="img"`);
      assert.match(svg, /<title>[^<]+<\/title>/, `${p} 缺非空 <title>`);
    }
  }
});

test('图内标签配平（未闭合会让整张图在浏览器里静默消失）', () => {
  for (const p of PAGES) {
    for (const [i, svg] of svgs(read(p)).entries()) {
      assert.ok(tagsBalanced(svg), `${p} 第 ${i + 1} 张图标签未配平`);
    }
  }
});

test('图内不写死颜色，一律走语义类名由主题令牌接管', () => {
  for (const p of PAGES) {
    for (const svg of svgs(read(p))) {
      assert.ok(!/fill="#|stroke="#|fill="rgb|stroke="rgb/.test(svg), `${p} 出现硬编码颜色`);
      // currentColor 只允许出现在 marker 的箭头上（它跟随 currentColor 上下文）
      const cc = (svg.match(/currentColor/g) ?? []).length;
      assert.ok(cc <= 2, `${p} currentColor 出现 ${cc} 次，疑似漏改类名`);
    }
  }
});

test('中文站图内不夹带英文整句，反之亦然（只允许标识符类英文）', () => {
  // 标识符（API 名、路径、变量）本来就该是英文，这里只抓「整句英文/中文」。
  const SENTENCE = /[A-Za-z][A-Za-z ,.'()]{28,}/;
  const CJK_SENTENCE = /[一-鿿]{16,}/;
  // 必须逐个 <text> 判定：把节点拼起来再匹配，会被我自己的分隔符
  // 把相邻节点连成「长句」，误报一片。
  for (const [page, re, what] of [
    ['site/index.html', SENTENCE, '英文整句'],
    ['site/index.en.html', CJK_SENTENCE, '中文整句'],
  ]) {
    for (const [i, svg] of svgs(read(page)).entries()) {
      for (const m of svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) {
        const t = m[1].trim();
        if (!re.test(t)) continue;
        // 标识符/代码片段允许：API 名、路径、函数签名、命令行。
        // 判据是「含代码标点」——散文不会有 ({= : / 这类结构符号。
        const identifierish = /[(){}=:/]/.test(t) || !/\s\S+\s\S/.test(t);
        assert.ok(identifierish, `${page} 第 ${i + 1} 张图混入${what}：${t.slice(0, 60)}`);
      }
    }
  }
});

test('图组件样式齐备：结构类与文字类都定义了', () => {
  const css = read('site/assets/style.css');
  for (const cls of [
    '.diagram', '.dg-node', '.dg-node-core', '.dg-node-seam', '.dg-node-muted',
    '.dg-t', '.dg-t-sub', '.dg-t-core', '.dg-t-mono', '.dg-edge', '.dg-edge-core',
    '.dg-band', '.dg-band-label',
  ]) {
    assert.ok(css.includes(cls), `style.css 缺 ${cls}`);
  }
  // 暗色不另写覆盖：靠令牌本身切换，图内不该出现按主题分叉的硬规则
  assert.ok(!/html\[data-theme="dark"\]\s+\.dg-/.test(css), '图样式不应按主题分叉写死');
});

test('图数量变化时 npm test 会抓到（防止只改了一张站）', () => {
  const zh = figures(read(PAGES[0])).length;
  const en = figures(read(PAGES[1])).length;
  assert.equal(zh, en);
  assert.ok(zh >= 1, '一张图都没有，说明插入被回滚了');
});
