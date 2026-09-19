#!/usr/bin/env node
// html2video-for-mcode · 主题对比度校验(WCAG 2.1)
// 用法: node check-theme.mjs <项目目录|tokens.css 路径>
// 判据: accent-ink/accent ≥3:1(强调色只用于大字与图形), fg/bg ≥4.5:1,
//       muted/bg ≥3:1(次级文本 ≥24px 属大字), 字幕 fg 对"胶囊合成到背景后"的颜色 ≥4.5:1。
// 有 ✗ 时退出码 1 —— 新增或修改主题必须过这道闸。
import fs from 'node:fs';
import path from 'node:path';

const arg = process.argv.slice(2).find(a => !a.startsWith('--')) ?? '.';
const file = arg.endsWith('.css') ? path.resolve(arg) : path.join(path.resolve(arg), 'slides', 'tokens.css');
if (!fs.existsSync(file)) { console.error(`✗ 找不到 ${file}`); process.exit(1); }
const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释, 避免注释里的色值干扰

function parseBlock(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc + '\\s*\\{([^}]*)\\}', 'g');
  const out = {};
  let m, found = false;
  // 收集所有同名块并按顺序合并: 项目在 tokens.css 末尾追加的品牌色覆写要能覆盖主题自带值
  while ((m = re.exec(css))) {
    found = true;
    for (const decl of m[1].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim();
      if (k.startsWith('--')) out[k] = decl.slice(i + 1).trim();
    }
  }
  return found ? out : null;
}

function color(v) {
  if (!v) return null;
  v = v.trim();
  let m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return [17 * parseInt(m[1][0], 16), 17 * parseInt(m[1][1], 16), 17 * parseInt(m[1][2], 16), 1];
  m = v.match(/^#([0-9a-f]{6})/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}
const lum = c => {
  const f = x => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg, bg) => (fg[3] >= 1 ? fg : [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1));

const base = parseBlock(':root');
if (!base) { console.error('✗ tokens.css 里找不到 :root 块'); process.exit(1); }
const themeNames = [...new Set(['a', ...[...css.matchAll(/\[data-theme="([^"]+)"\]\s*\{/g)].map(m => m[1])])];

const CHECKS = [
  { label: 'accent-ink / accent', fg: '--accent-ink', bg: '--accent', err: 3.0, warn: 4.5, note: '强调色上的文字(仅大字/图形)' },
  { label: 'fg / bg', fg: '--fg', bg: '--bg', err: 4.5, warn: 7.0, note: '正文' },
  { label: 'muted / bg', fg: '--muted', bg: '--bg', err: 3.0, warn: 4.5, note: '次级文本(≥24px)' },
  { label: 'fg-3 / bg', fg: '--fg-3', bg: '--bg', err: 2.0, warn: 3.0, note: '三级文本/图注' },
  { label: 'sub-fg / 字幕底', fg: '--sub-fg', bg: '--sub-bg', err: 4.5, warn: 7.0, note: '字幕(胶囊合成到背景后)', composite: true },
];

let fail = 0, warnCount = 0;
console.log(`校验 ${path.relative(process.cwd(), file)} · ${themeNames.length} 套主题\n`);
for (const name of themeNames) {
  // 主题 a 的底来自 :root, 但项目仍可在 tokens.css 里追加 [data-theme="a"] 覆写品牌色 —— 也要合并
  const ov = parseBlock(`[data-theme="${name}"]`) ?? {};
  const t = { ...base, ...ov };
  const bg = color(t['--bg']) ?? color(base['--bg']);
  const rows = [];
  for (const c of CHECKS) {
    const fg = color(t[c.fg]), rawBg = color(t[c.bg]);
    if (!fg || !rawBg) { rows.push(`  ${c.label.padEnd(18)} —(缺令牌)`); continue; }
    const cmpBg = c.composite ? blend(rawBg, bg) : rawBg;
    const r = ratio(fg, cmpBg);
    const mark = r < c.err ? '✗' : r < c.warn ? '⚠' : '✓';
    if (mark === '✗') fail++;
    if (mark === '⚠') warnCount++;
    rows.push(`  ${mark} ${c.label.padEnd(18)} ${r.toFixed(2)}:1   ${c.note}`);
  }
  console.log(`── ${name} ${'─'.repeat(Math.max(0, 34 - name.length))}`);
  console.log(rows.join('\n'));
}
console.log(`\n✗ ${fail} 项不达标, ⚠ ${warnCount} 项偏弱。`);
if (fail) {
  console.error('不达标的项: accent 上的文字请改用大字/图形, 或调整 --accent-ink; 字幕对比不足请加深 --sub-bg(深色主题可加 --sub-ring 做视觉分隔)。');
  process.exit(1);
}
console.log('全部通过 ✓');
