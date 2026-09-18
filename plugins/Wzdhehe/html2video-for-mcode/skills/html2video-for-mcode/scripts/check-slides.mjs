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
//   5b. fx 类的关键帧不含 opacity —— 同上, 基础态 opacity:0 抬不回来, 元素永远隐形
//      (只做 transform/描边的动画必须显式写 opacity:1; 2026-09-18 实测踩过)
//   6. 整片级领域自查 —— 命中多个财经/投研关键词却全片没有免责或出处行 → 提示(不是错误),
//      提醒确认领域与免责口径(见 references/compliance.md); 用户明确不要免责时可忽略
import fs from 'node:fs';
import path from 'node:path';
import { safeId, safeRel, inside } from './tools.mjs';

// tokens.css 里的 @keyframes 名 → 是否声明了 opacity(用来判断"动画能否把基础态抬回可见")
function opacityAwareKeyframes(css) {
  const map = new Map();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    // 从头扫到配平的右花括号, 拿到该关键帧块
    let i = m.index + m[0].length - 1, depth = 0, end = i;
    for (; end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') { depth--; if (depth === 0) break; }
    }
    map.set(m[1], /opacity\s*:/.test(css.slice(i, end)));
  }
  return map;
}
// .fx-x { animation: <kf-name> ... } → fx 类名到关键帧名的映射
function fxClassKeyframes(css) {
  const map = new Map();
  for (const m of css.matchAll(/\.(fx-[\w-]+)\s*(?:,[^{]*)?\{([^}]*)\}/g)) {
    const anim = /animation\s*:\s*([\w-]+)/.exec(m[2]);
    if (anim) map.set(m[1], anim[1]);
  }
  return map;
}

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
// fx 类 → 关键帧名, 以及关键帧是否声明 opacity(供 5b 检查: 动画必须能把基础态 opacity:0 抬回 1)
const fxKeyframes = fxClassKeyframes(tokensCss);
const kfOpacity = opacityAwareKeyframes(tokensCss);
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
const deckText = [];   // 整片文本(HTML 去标签 + 口播稿), 用于第 6 项领域自查

for (const s of slides) {
  const file = safeRel(slidesDir, s.html ?? `${safeId(s.id)}.html`, { where: `slides[${s.id}].html` });
  if (!fs.existsSync(file)) {
    // 未写的 slide 只是"还没做", 截图时本就会跳过 —— 记提示而不是错误, 避免把告警训成噪音
    report.push({ id: s.id, level: 'warn', msg: `未写: ${path.relative(dir, file)}(截图时会跳过)` });
    warns++;
    continue;
  }
  const html = fs.readFileSync(file, 'utf8');
  const localDefs = new Set([...html.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
  deckText.push({ id: s.id, text: html.replace(/<[^>]*>/g, ' ') });

  // 1. 未定义变量(只报没有 fallback 的)
  for (const m of html.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
    const name = m[1], hasFallback = !!m[2];
    if (hasFallback || defined.has(name) || localDefs.has(name) || RUNTIME_VARS.has(name)) continue;
    report.push({ id: s.id, level: 'error', msg: `变量 ${name} 未定义且无 fallback → 该声明会失效(文字可能直接隐形)` });
    errors++;
  }

  // 2. 图片: 文件必须存在; SVG 建议 inline(引用必须落在项目目录内, 防二阶越界读)
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/g)) {
    const src = m[1];
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) continue; // 外链单独在下面报
    const resolved = path.resolve(path.dirname(file), src);
    if (path.isAbsolute(src) || !inside(dir, resolved)) {
      report.push({ id: s.id, level: 'error', msg: `图片引用越出项目目录: ${src} — 素材必须先落 assets/ 再引用` });
      errors++;
      continue;
    }
    if (!fs.existsSync(resolved)) {
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

  // 5b. fx 类的关键帧不改 opacity → 基础态 opacity:0 抬不回来, 元素永远隐形
  for (const m of html.matchAll(/<[^>]*\bdata-stage\s*=\s*["'][^"']*["'][^>]*>/g)) {
    const tag = m[0];
    const cls = /class\s*=\s*["']([^"']*)["']/.exec(tag);
    if (!cls) continue;
    if (/\bfx-stagger\b/.test(cls[1])) continue;
    for (const c of cls[1].split(/\s+/).filter(x => x.startsWith('fx-'))) {
      const kf = fxKeyframes.get(c);
      if (!kf) continue;                       // 未在 tokens.css 定义(环境类/氛围类), 交给别的检查
      const aware = kfOpacity.get(kf);
      if (aware === false) {
        report.push({ id: s.id, level: 'error', msg: `.${c} 的关键帧 ${kf} 没声明 opacity, 而 [data-stage] 基础态是 opacity:0 → 该元素入场后永远不可见; 在关键帧里补 opacity:1` });
        errors++;
      }
    }
  }
}

// 6. 受监管领域自查(整片级): 像财经/投研内容却没见免责或出处标注 → 提示, 不是错误
for (const s of slides) {
  const cls = (s.clauses ?? []).map(c => `${c.text ?? ''} ${c.text2 ?? ''}`).join(' ');
  if (cls.trim()) deckText.push({ id: s.id, text: cls });
}
const FIN_WORDS = ['投资建议', '股价', '涨跌', '涨停', '跌停', '营收', '净利润', '毛利率', '市值', '市盈率',
  '招股', '财报', '年报', '季报', '基金', '收益率', '汇率', 'A股', '港股', '美股', '募资', '估值', '分红'];
const hits = new Map();   // 词 → 首次出现的 slide id
for (const { id, text } of deckText) {
  for (const w of FIN_WORDS) if (!hits.has(w) && text.includes(w)) hits.set(w, id);
}
const hasDisclaimerLine = deckText.some(({ text }) => /不构成|仅供参考|风险提示|免责/.test(text));
const deckNotes = [];
if (hits.size >= 2 && !hasDisclaimerLine) {
  const words = [...hits.keys()];
  deckNotes.push(`像财经/投研内容(命中 ${words.slice(0, 5).join('、')}${words.length > 5 ? ' 等' : ''}, 见 ${hits.get(words[0])} 等张), 但整片没找到免责/出处行 — 若题材受监管(财经/医疗/法律/政策/营销宣称), 结尾补 .disclaimer 行、确认涨跌色(A股=红涨绿跌)、并给数字补口径+币种+时点, 见 references/compliance.md; 用户已明确说不要免责则忽略本条`);
  warns++;
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
  for (const n of deckNotes) console.log(`⚠ 整片: ${n}`);
}
console.log(`\n静态检查: ${slides.length} 张 · ✗ ${errors} 项错误 / ⚠ ${warns} 项提示`);
if (errors) {
  console.error('错误项会让画面对但"看不见/缺内容": 未定义变量补定义或加 fallback; 图片补齐或改 inline SVG; 外链改本地。');
  process.exit(1);
}
console.log('可以进入截图(无阻塞项)✓');
