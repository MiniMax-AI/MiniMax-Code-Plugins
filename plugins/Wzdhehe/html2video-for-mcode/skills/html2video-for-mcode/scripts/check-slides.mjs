#!/usr/bin/env node
// html2video-for-mcode · 渲染前静态检查: 把"画面静默出错但流水线报成功"这类问题挡在截图之前
// 用法: node check-slides.mjs <项目目录> [--ids 01,02] [--quiet]
//
// 检查项(全部来自实测踩过的坑):
//   1. 未定义的 CSS 变量 —— var(--x) 没有 fallback 且 tokens.css/内联样式都没定义 →
//      整条声明计算为 none; 若同时用了 -webkit-text-fill-color:transparent, 文字会完全隐形
//   2. 图片文件不存在 / 引用了 SVG —— SVG 在 file:// 实测能加载(400px), 但依赖外部资源、
//      XML 有误、缺 width/height 或下载失败存成 HTML 时都会显示 broken 图标, 建议 inline
//   3. 硬编码颜色(#hex / rgb() / hsl()) —— 换主题时会串色, 且说明配色没落到 token
//   4. 外链资源(http/https 的 src/href) —— 离线沙箱会失败 + 引入 FOUT 风险
//   5. data-stage 没配 fx-* 类 —— 元素会永远停在 opacity:0(除非放进 .fx-stagger 容器)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const QUIET = argv.includes('--quiet');
const idsFilter = flag('--ids', '') ? flag('--ids', '').split(',').map(s => s.trim()) : null;

const scriptPath = path.join(dir, 'script.json');
if (!fs.existsSync(scriptPath)) { console.error(`✗ 找不到 ${scriptPath}`); process.exit(1); }
const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
const slidesDir = path.join(dir, 'slides');
const tokensPath = path.join(slidesDir, 'tokens.css');
if (!fs.existsSync(tokensPath)) { console.error(`✗ 找不到 ${tokensPath}`); process.exit(1); }
const tokensCss = fs.readFileSync(tokensPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// tokens.css 里定义的变量
const defined = new Set([...tokensCss.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
// 渲染管线/浏览器在运行时注入或框架自带的变量, 不需要在 tokens.css 里定义
const RUNTIME_VARS = new Set([
  '--t1', '--t2', '--t3', '--fx-delay', '--stagger-base',           // capture 注入 / 入场延迟
  '--stage-w', '--stage-h', '--sub-scale',                          // capture 注入的画布与字幕
  '--sub-bg', '--sub-fg', '--sub-ring',                             // 字幕钩子(有内置默认值)
  '--img-ratio', '--img-pos',                                       // .img-frame 的局部变量(有默认值)
  '--deck-scale', '--logo-size', '--logo-opacity', '--logo-inset-x', '--logo-inset-y', '--logo-print',
]);

const slides = script.slides.filter(s => !idsFilter || idsFilter.includes(s.id));
let errors = 0, warns = 0;
const report = [];

for (const s of slides) {
  const file = path.join(slidesDir, s.html ?? `${s.id}.html`);
  if (!fs.existsSync(file)) {
    // 未写的 slide 只是"还没做", 截图时本就会跳过 —— 记提示而不是错误, 避免把告警训成噪音
    report.push({ id: s.id, level: 'warn', msg: `未写: ${path.relative(dir, file)}(截图时会跳过)` });
    warns++;
    continue;
  }
  const html = fs.readFileSync(file, 'utf8');
  const localDefs = new Set([...html.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));

  // 1. 未定义变量(只报没有 fallback 的)
  for (const m of html.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    const name = m[1], hasFallback = !!m[2];
    if (hasFallback || defined.has(name) || localDefs.has(name) || RUNTIME_VARS.has(name)) continue;
    report.push({ id: s.id, level: 'error', msg: `变量 ${name} 未定义且无 fallback → 该声明会失效(文字可能直接隐形)` });
    errors++;
  }

  // 2. 图片: 文件必须存在; SVG 建议 inline
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
    const src = m[1];
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue; // 外链单独在下面报
    const imgPath = path.resolve(path.dirname(file), src);
    if (!fs.existsSync(imgPath)) {
      report.push({ id: s.id, level: 'error', msg: `图片不存在: ${src}(会渲染成 broken 图标)` });
      errors++;
    } else if (/\.svg$/i.test(src)) {
      report.push({ id: s.id, level: 'warn', msg: `引用了 SVG 文件: ${src} — file:// 下能加载, 但 SVG 若有 XML 错误/依赖外部资源/缺 width-height 就会 broken; 架构图类建议 inline 进 HTML` });
      warns++;
    }
  }

  // 3. 硬编码颜色(排除 tokens 引用本身)
  const hexes = [...html.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  const rgbs = [...html.matchAll(/\b(rgba?|hsla?)\(/g)].map(m => m[1]);
  if (hexes.length || rgbs.length) {
    report.push({ id: s.id, level: 'warn', msg: `硬编码颜色 ${hexes.length + rgbs.length} 处(${[...hexes.slice(0, 3), ...rgbs.slice(0, 2)].join(' ')}…) — 换主题会串色, 请改成 var(--...)` });
    warns++;
  }

  // 4. 外链资源
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)) {
    report.push({ id: s.id, level: 'error', msg: `外链资源: ${m[1].slice(0, 60)} — 离线沙箱取不到, 且字体会 FOUT` });
    errors++;
  }

  // 5. data-stage 没配 fx-* 类(容器 .fx-stagger 除外)
  for (const m of html.matchAll(/<[^>]*\bdata-stage\s*=\s*["'][^"']*["'][^>]*>/g)) {
    const tag = m[0];
    if (/class\s*=\s*["'][^"']*\bfx-/.test(tag)) continue;
    if (/\bfx-stagger\b/.test(tag)) continue;
    report.push({ id: s.id, level: 'warn', msg: `有 data-stage 但没有 fx-* 类: ${tag.slice(0, 70)}… — 元素会永远停在 opacity:0(放进 .fx-stagger 容器可豁免)` });
    warns++;
  }
}

if (!QUIET) {
  const bySlide = new Map();
  for (const r of report) { if (!bySlide.has(r.id)) bySlide.set(r.id, []); bySlide.get(r.id).push(r); }
  for (const s of slides) {
    const rs = bySlide.get(s.id);
    if (!rs) { console.log(`✓ ${s.id}`); continue; }
    console.log(`${rs.some(r => r.level === 'error') ? '✗' : '⚠'} ${s.id}`);
    for (const r of rs) console.log(`    ${r.level === 'error' ? '✗' : '⚠'} ${r.msg}`);
  }
}
console.log(`\n静态检查: ${slides.length} 张 · ✗ ${errors} 项错误 / ⚠ ${warns} 项提示`);
if (errors) {
  console.error('错误项会让画面对但"看不见/缺内容": 未定义变量补定义或加 fallback; 图片补齐或改 inline SVG; 外链改本地。');
  process.exit(1);
}
console.log('可以进入截图(无阻塞项)✓');
