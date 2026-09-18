#!/usr/bin/env node
// html2video-for-mcode · 放映页: preview/play/index.html + 逐张"真实时序"快照。
// 用法: node preview-page.mjs <项目目录> [--open] [--no-script]
//
// 定位: **用浏览器把 HTML 画面放一遍**。只做四件事 —— 翻页(动效开 = 逐级入场)、动效开/关对照、口播开/关、总览;
// 口播文案是锦上添花(可关), 不做计时器/进度条/播放器那套 UI(要看时间就直接看成片)。
// 换帧用双缓冲 iframe: 新帧在隐藏帧里加载完才对调显示, 不闪白; UI 文案随 script.lang 中英双语。
//
// 为什么不是"直接双击 slides/*.html": 动画延迟(--t1/--t2/--t3)与画布尺寸是渲染管线按
// timings.json 注入的(tokens.css 里只有占位默认值 --t2:800ms), 直接打开看到的是"所有动画
// 挤在 2 秒内"的假象。本脚本把注入值原样写进副本的 <html style>, 于是浏览器里的播放时序
// = 成片时序, 且副本带 <base href> 指回 slides/, 主题与素材照常解析。
// 另出一份加了 no-fx 的副本, 页面按 X 即可对照"关掉动效后画面是否还完整" —— 这是
// "元素永久不可见 / 关动效反而更空"那类静默故障的 5 秒自检, 不必等 3–6 分钟的 motion 编码。
//
// 口播 UI 按数据决定加不加载: 没有 clauses → 完全不出; 有 clauses没对时 → 只列文案;
// --no-script 强制不出。布局随窗口自适应(窄窗口/手机口播面板收成底部抽屉, 触屏可左右滑动翻页)。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeId, safeRel, safeOut, validateScriptPaths } from './tools.mjs';
import { NOFX_CSS } from './nofx-css.mjs';
import { KITS, kitStatuses, MAX_SCAN_BYTES } from './css-kit.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ─────────────────────────── 纯函数(供 tests/ 单测) ───────────────────────────

// 与 capture.mjs 的注入保持同一语义: 秒 → 整数毫秒, 负数归零。属性名 --t<stage>。
export function stageVars(stages = {}, { w, h } = {}) {
  const out = [];
  for (const k of Object.keys(stages).sort()) {
    const v = Number(stages[k]);
    if (!Number.isFinite(v)) continue;
    out.push(`--t${Number(k)}:${Math.max(0, Math.round(v * 1000))}ms`);
  }
  if (Number.isFinite(w)) out.push(`--stage-w:${w}px`);
  if (Number.isFinite(h)) out.push(`--stage-h:${h}px`);
  return out.join(';');
}

// 从 slide HTML 里读出用到哪些 stage —— 用于"还没对时"时的等间隔兜底
export function stagesFromHtml(html) {
  const ids = new Set();
  for (const m of String(html ?? '').matchAll(/\bdata-stage\s*=\s*["'](\d+)["']/g)) ids.add(Number(m[1]));
  return [...ids].sort((a, b) => a - b);
}

// 没有 timings.json(口播还没做)时, 按 0.3s 起步、每层 +1s 错开, 让人至少看清入场顺序;
// 页面会明确标注"不是成片时序"。tokens.css 的占位值会把所有动画挤在 2 秒内, 更看不懂。
export function fallbackStages(html, { start = 0.3, step = 1 } = {}) {
  const out = {};
  stagesFromHtml(html).forEach((n, idx) => { out[n] = start + idx * step; });
  return out;
}

// 属性匹配要认双引号/单引号/无引号三种写法(二审 P2): 旧实现只认双引号, 遇到
// <html class='theme' style='--t2:800ms'> 会再插一组重复属性, 浏览器保留**先出现的那组** →
// 实测延迟/画布尺寸全部失效、no-fx 也加不上(实测: 原延迟仍在、没有画布宽、动效关不掉)
const ATTR_RE = name => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
const attrValue = (tag, name) => {
  const m = ATTR_RE(name).exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4]) : null;
};

function firstTag(html, name) {
  const m = html.match(new RegExp(`<${name}\\b[^>]*>`, 'i'));
  return m ? { tag: m[0], index: m.index } : null;
}

function setAttr(tag, name, value) {
  if (attrValue(tag, name) !== null) return tag.replace(ATTR_RE(name), () => `${name}="${value}"`);
  return tag.replace(/\s*\/?>$/, m => ` ${name}="${value}"${m.endsWith('/>') ? '/>' : '>'}`);
}

function addStyleDecl(tag, decl) {
  if (!decl) return tag;
  const cur = attrValue(tag, 'style');
  if (cur === null) return setAttr(tag, 'style', decl);
  return setAttr(tag, 'style', `${cur.trim().replace(/;?$/, ';')}${decl}`);
}

// 把注入值挂在 <html> 上(等价于 capture 的 documentElement.style.setProperty, 优先级最高)
export function injectHtmlVars(html, decl) {
  const t = firstTag(html, 'html');
  if (!t) return html;
  return html.slice(0, t.index) + addStyleDecl(t.tag, decl) + html.slice(t.index + t.tag.length);
}

export function addNoFx(html) {
  const t = firstTag(html, 'html');
  if (!t) return html;
  const cls = attrValue(t.tag, 'class');
  if (cls !== null && /\bno-fx\b/.test(cls)) return html;
  const tag = setAttr(t.tag, 'class', cls === null ? 'no-fx' : `${cls.trim()} no-fx`);
  return html.slice(0, t.index) + tag + html.slice(t.index + t.tag.length);
}

// <base> 必须排在所有相对 URL 之前(slides/ 内含 <link href="tokens.css">, 若排在后面会失效)
export function addBaseHref(html, href) {
  const existing = html.match(/<base\b[^>]*>/i);
  if (existing) return html.replace(existing[0], `<base href="${href}">`);
  const h = firstTag(html, 'head');
  if (!h) return html;
  const at = h.index + h.tag.length;
  return html.slice(0, at) + `\n<base href="${href}">` + html.slice(at);
}

// 兜底: 项目 tokens.css 落后于技能当前版本时, 把缺的那段注入副本(排在 tokens.css 之后, 后写覆盖)
export function injectStyle(html, css, note = '本项目 tokens.css 缺这段规则') {
  const block = `<style>/* preview-page 兜底注入: ${note} */\n${css}\n</style>\n`;
  const i = html.search(/<\/head>/i);
  return i < 0 ? block + html : html.slice(0, i) + block + html.slice(i);
}

// 动效开的**逐级步进**: 往副本 <head> 开头注入一段在 CSS 动画启动前执行的脚本 ——
// ?s=k 表示已揭示到第 k 个用到的 stage: 第 k 级带 &anim=1 时当场入场, 更早的级直接终态
// (-60s 延迟 = 动画早已完成), 更晚的级保持隐藏(+60s 延迟 = 还在等, 等用户按"下一步")。
// 父页只换 iframe src(与快照同一套机制), 不做任何跨文档访问 —— file:// 下 iframe 是独立源。
export function addStepScript(html, stages = []) {
  if (!stages.length) return html;
  const script = `<script>
/* 放映页逐级步进(动效开): 在动画启动前按 ?s=k 重设各级入场延迟 */
(function(){try{
  var q=new URLSearchParams(location.search);var k=parseInt(q.get('s')||'0',10);
  if(!k)return;var anim=q.get('anim')==='1';var used=${JSON.stringify(stages)};
  used.forEach(function(n,idx){var pos=idx+1,v;
    if(pos<k)v='-60000ms';else if(pos===k)v=anim?'0ms':'-60000ms';else v='60000ms';
    document.documentElement.style.setProperty('--t'+n,v);});
}catch(e){}})();
</script>`;
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return script + html;
  return html.slice(0, m.index + m[0].length) + '\n' + script + html.slice(m.index + m[0].length);
}

// ─────────────────────────── 放映页 ───────────────────────────

export function buildPlayPage({
  topic = '', lang = 'zh', slides = [], cssNote = '', generatedAt = '',
  narration = true,    // 是否加载口播文案 UI(没有 clauses 或 --no-script 时为 false)
  timing = false,      // 是否有对时数据(只影响标题上的"(未对时)"标注)
  fallbackNote = '',   // "还没对时/等间隔预览"的如实说明(与口播 UI 无关, 画面上也要说清)
  canvas = { w: 1920, h: 1080 },   // 画布尺寸(竖版 1080×1920): 舞台缩放与缩略图比例都按它算
} = {}) {
  // UI 双语(实测反馈: 英文项目的放映页整套中文按钮)。lang 来自 script.json(en* → 英文, 其余中文)
  const T = String(lang).toLowerCase().startsWith('en') ? {
    title: 'Play', fxOn: 'Motion on', fxOff: 'Motion off', narrOn: 'Narration on', narrOff: 'Narration off',
    overview: 'Overview', panelH: 'Narration for this slide', untimed: '(untimed)',
    fxTitle: 'Motion on / off (key X)', narrTitle: 'Narration on / off (key P)',
    prevTitle: 'Previous level / slide', nextTitle: 'Next level / slide',
    hintStep: 'reveal level / slide', hintFx: 'motion on / off', hintNarr: 'narration on / off',
    hintOv: 'overview', hintFs: 'fullscreen', level: 'step',
    cut: 'Cut', xfade: 'Dissolve', transTitle: 'Slide transition: cut / dissolve (compare, then set script.json transition)', hintTrans: 'slide transition',
    gen: 'Snapshots generated', genNote: 'same source as the final video (no audio, no subtitles)',
    noThumbA: 'No thumbnail (preview/', ovH: 'Overview · click any slide to jump (thumbnails from preview/*.png)',
  } : {
    title: '放映页', fxOn: '动效开', fxOff: '动效关', narrOn: '口播开', narrOff: '口播关',
    overview: '总览', panelH: '本张口播文案', untimed: '(未对时)',
    fxTitle: '动效开 / 动效关(快捷键 X)', narrTitle: '口播开 / 口播关(快捷键 P)',
    prevTitle: '上一级 / 上一张', nextTitle: '下一级 / 下一张',
    hintStep: '逐级入场 / 翻页', hintFx: '动效开 / 动效关', hintNarr: '口播开 / 口播关',
    hintOv: '总览', hintFs: '全屏', level: '级',
    cut: '硬切', xfade: '溶解', transTitle: '切页方式:硬切 / 溶解(现场对比后写进 script.json 的 transition)', hintTrans: '切页方式',
    gen: '快照生成于', genNote: '画面与成片同源(无声、无字幕)',
    noThumbA: '无缩略图(preview/', ovH: '总览 · 点任意一张跳转(缩略图来自 preview/*.png)',
  };
  const model = slides.map(s => ({
    id: s.id, name: s.name, title: s.title ?? '',
    src: s.copy, nofx: s.copyNofx,
    steps: (s.steps && s.steps.length) ? s.steps : [1],   // 动效开时逐级揭示的 stage 序列
    clauses: (s.clauses ?? []).map(c => ({ stage: c.stage ?? null, text: c.text ?? '', text2: c.text2 ?? '' })),
  }));
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  const bodyCls = narration ? '' : 'narr-off';
  const cssWarn = cssNote ? `<p class="warn">⚠ ${esc(cssNote)}</p>` : '';
  const notice = fallbackNote ? `<div id="notice">${esc(fallbackNote)}</div>` : '';

  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${T.title} · ${esc(topic) || 'html2video'} · html2video-for-mcode</title>
<style>
  :root{--c-bg:#0b0c10;--c-panel:#14161c;--c-fg:#e8ebf4;--c-dim:#8b90a0;--c-line:#23252e;--c-acc:#6ea8fe;--c-warn:#ffb454}
  *{box-sizing:border-box}
  html{height:100%}
  body{margin:0;height:100vh;height:100dvh;overflow:hidden;background:var(--c-bg);color:var(--c-fg);
    display:grid;grid-template-rows:auto minmax(0,1fr) auto;
    font:14px/1.5 -apple-system,"Segoe UI",system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
  /* ── 顶栏 ── */
  .top{min-width:0}
  header{display:flex;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--c-line);min-width:0}
  header .topic{font-weight:600;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  header .grow{flex:1 1 0;min-width:0}
  .chip{flex:0 0 auto;color:var(--c-dim);font-variant-numeric:tabular-nums;white-space:nowrap;font:inherit;
    background:none;border:0;padding:2px 0;margin:0}
  button.chip{cursor:pointer;border-radius:6px;padding:2px 8px}
  button.chip:hover{background:#1d2130}
  button.chip.on{color:var(--c-warn)}
  #notice{padding:6px 16px;background:#241f14;color:var(--c-warn);font-size:12px;border-bottom:1px solid var(--c-line)}
  /* ── 舞台 + 口播文案 ── */
  main{display:flex;min-width:0;min-height:0}
  #stage{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;background:#000}
  #fit{position:absolute;left:50%;top:50%;width:${canvas.w}px;height:${canvas.h}px;transform-origin:center center}
  /* 双缓冲: 两张 iframe 叠放, 新帧在隐藏帧里加载完成才对调显示 —— 换页/逐级不再闪白 */
  #fit iframe{position:absolute;left:0;top:0;width:${canvas.w}px;height:${canvas.h}px;border:0;background:#fff;opacity:0}
  #fit iframe.show{opacity:1}
  /* 溶解对比: 新帧淡入盖住旧帧(硬切时无过渡, 与成片一致) */
  body.xfade #fit iframe{transition:opacity .4s linear}
  #hit{position:absolute;inset:0;z-index:2;touch-action:none}   /* 触屏左右滑翻页; 画面是纯 CSS 无需交互 */
  #panel{flex:0 0 clamp(240px,22vw,340px);min-width:0;overflow:auto;overscroll-behavior:contain;
    border-left:1px solid var(--c-line);background:var(--c-panel);padding:14px 16px}
  body.narr-off #panel{display:none}
  #panel h2{margin:0 0 10px;font-size:13px;color:var(--c-dim);font-weight:600;letter-spacing:.04em}
  #clauses{list-style:none;margin:0;padding:0}
  #clauses li{padding:8px 10px;border-radius:8px;border:1px solid transparent;color:var(--c-fg);margin-bottom:6px}
  #clauses .st{display:inline-block;min-width:22px;margin-right:6px;color:var(--c-acc);font-variant-numeric:tabular-nums;font-size:12px}
  #clauses .t2{display:block;color:var(--c-dim);font-size:12px;margin-top:2px}
  .warn{color:var(--c-warn);font-size:12px;margin:8px 0 0}
  /* ── 底栏 ── */
  footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;padding:6px 16px;min-height:30px;
    border-top:1px solid var(--c-line);color:var(--c-dim);font-size:12px}
  footer kbd{background:#1d2130;border:1px solid var(--c-line);border-radius:4px;padding:1px 5px;color:var(--c-fg);font-family:inherit}
  footer .gen{margin-left:auto;opacity:.8}
  .kbd-hints{display:flex;flex-wrap:wrap;gap:6px 16px}   /* 不用内联样式: 否则窄屏媒体查询盖不住它 */
  #touchbar{display:flex;gap:6px;flex-wrap:wrap}
  #touchbar button{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;color:var(--c-fg);background:#1a1d26;
    border:1px solid var(--c-line);border-radius:8px;padding:8px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #touchbar button:active{background:#252a38}
  #touchbar button.on{color:var(--c-warn)}   /* "关"态亮警示色: 一眼看出动效/口播被关了 */
  /* 前后箭头是高频操作, 加大加粗(实测反馈太小) */
  #touchbar button[data-act="prev"],#touchbar button[data-act="next"]{flex:0 0 76px;font-size:24px;font-weight:600}
  /* ── 总览 ── */
  #overlay{position:fixed;inset:0;background:rgba(6,7,10,.975);padding:28px;overflow:auto;display:none;z-index:9}
  #overlay.show{display:block}
  #overlay h2{margin:0 0 16px;font-size:15px;color:var(--c-dim);font-weight:600}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:14px}
  #grid figure{margin:0;border:1px solid var(--c-line);border-radius:10px;overflow:hidden;background:#000;cursor:pointer}
  #grid figure:hover{border-color:var(--c-acc)}
  #grid img{width:100%;aspect-ratio:${canvas.w}/${canvas.h};object-fit:cover;display:block}
  #grid .ph{width:100%;aspect-ratio:${canvas.w}/${canvas.h};display:flex;align-items:center;justify-content:center;color:var(--c-dim);font-size:12px}
  #grid figcaption{padding:8px 10px;font-size:12px;color:var(--c-dim)}
  #grid figcaption b{color:var(--c-fg);font-weight:600;margin-right:6px}
  /* ── 窄窗口 / 手机: 口播文案收到底部当抽屉, 键盘提示换成触摸按钮 ── */
  @media (max-width:860px), (pointer:coarse){
    footer .kbd-hints{display:none}
    #touchbar{width:100%}
  }
  @media (max-width:860px){
    header{padding:8px 12px;gap:8px}
    header .topic{font-size:13px}
    #notice{padding:6px 12px}
    main{flex-direction:column}
    #panel{flex:0 0 auto;max-height:38dvh;border-left:0;border-top:1px solid var(--c-line);padding:10px 12px}
    footer{padding:6px 12px}
    #overlay{padding:16px}
  }
  @media (max-width:560px){
    header .topic{display:none}          /* 标题在浏览器标签上还有, 这里让位给页码与按钮 */
    footer .gen{display:none}
    #touchbar button{font-size:11px;padding:8px 2px}
    #overlay h2{font-size:13px}
  }
</style>
</head>
<body class="${bodyCls}">
<div class="top">
  <header>
    <span class="topic" title="${esc(topic)}">${esc(topic) || T.title}</span>
    <span class="chip" id="pageno">1 / ${slides.length}</span>
    <span class="grow"></span>
  </header>
  ${notice}
</div>
<main>
  <div id="stage"><div id="fit"><iframe id="frame" title="slide" scrolling="no" frameborder="0"></iframe><iframe id="frameB" title="slide" scrolling="no" frameborder="0" aria-hidden="true"></iframe></div><div id="hit"></div></div>
  ${narration ? `<aside id="panel">
    <h2>${T.panelH}${timing ? '' : T.untimed}</h2>
    <ol id="clauses"></ol>
    ${cssWarn}
  </aside>` : ''}
</main>
<footer>
  <span class="kbd-hints">
    <span><kbd>←</kbd><kbd>→</kbd> ${T.hintStep}</span>
    <span><kbd>X</kbd> ${T.hintFx}</span>
    ${narration ? `<span><kbd>P</kbd> ${T.hintNarr}</span>` : ''}
    <span><kbd>O</kbd> ${T.hintOv}</span>
    <span><kbd>F</kbd> ${T.hintFs}</span>
    <span><kbd>T</kbd> ${T.hintTrans}</span>
  </span>
  <span id="touchbar">
    <button type="button" data-act="prev" title="${T.prevTitle}">‹</button>
    <button type="button" data-act="nofx" id="fxbtn" title="${T.fxTitle}">${T.fxOn}</button>
    ${narration ? `<button type="button" data-act="narr" id="narrbtn" title="${T.narrTitle}">${T.narrOn}</button>` : ''}
    <button type="button" data-act="trans" id="transbtn" title="${T.transTitle}">${T.cut}</button>
    <button type="button" data-act="overview" title="${T.overview}">${T.overview}</button>
    <button type="button" data-act="next" title="${T.nextTitle}">›</button>
  </span>
  <span class="gen">${T.gen} ${esc(generatedAt)} · ${T.genNote}</span>
</footer>
<div id="overlay"><h2>${T.ovH}</h2><div id="grid"></div></div>
<script>
var S = ${json};
var T = ${JSON.stringify({ fxOn: T.fxOn, fxOff: T.fxOff, narrOn: T.narrOn, narrOff: T.narrOff, level: T.level, noThumbA: T.noThumbA, cut: T.cut, xfade: T.xfade })};
var i = 0, nofx = false, step = 1, animNext = true, trans = 'cut';   // trans: 'cut' 硬切(默认) / 'xfade' 溶解 —— 现场对比用
// step = 动效开时已揭示到第几个 stage; animNext = 揭示该级时是否当场播入场动画

function el(id){ return document.getElementById(id); }
function cur(){ return S[i]; }

// 双缓冲换帧: 新地址先喂给隐藏帧, load 后再等两帧 rAF(新文档首帧已画)才对调显示 ——
// 单 iframe 直接改 src 会先卸载旧文档(白屏一瞬)再加载新文档, 换页/逐级都会闪白(实测反馈)
var FR = [el('frame'), el('frameB')], front = 0, gen = 0;
function show(src){
  gen++; var g = gen, back = FR[1 - front], prev = FR[front];
  var raf = window.requestAnimationFrame || function(f){ setTimeout(f, 16); };
  back.addEventListener('load', function onl(){
    back.removeEventListener('load', onl);
    if (g !== gen) return;                 // 等待期间又按了下一步: 这次换帧作废
    raf(function(){ raf(function(){ if (g === gen) {
      back.classList.add('show');
      if (trans === 'xfade') {             // 溶解: 新帧淡入盖住旧帧, 旧帧等过渡结束再撤(绝不经过黑场)
        setTimeout(function(){ if (g === gen) prev.classList.remove('show'); }, 400);
      } else { prev.classList.remove('show'); }   // 硬切: 直接换
      front = 1 - front;
    } }); });
  });
  back.src = './' + src;   // './' 前缀: 强制按相对 URL 解析, 防同名 javascript: 文件名在放映页同源执行
}

function layout(){
  var st = el('stage'); if (!st) return;
  var r = st.getBoundingClientRect();
  if (!r.width || !r.height) return;
  var k = Math.min(r.width / ${canvas.w}, r.height / ${canvas.h}) * 0.98;
  el('fit').style.transform = 'translate(-50%,-50%) scale(' + k + ')';
}
window.addEventListener('resize', layout);
window.addEventListener('orientationchange', function(){ setTimeout(layout, 150); });
if (window.ResizeObserver) { try { new ResizeObserver(layout).observe(el('stage')); } catch (e) {} }
document.addEventListener('fullscreenchange', function(){ setTimeout(layout, 60); });

function paintPanel(){
  var ol = el('clauses'); if (!ol) return;
  ol.innerHTML = '';
  (cur().clauses || []).forEach(function(c){
    var li = document.createElement('li');
    var st = document.createElement('span'); st.className = 'st';
    st.textContent = c.stage != null ? 'L' + c.stage : '--';
    li.appendChild(st);
    li.appendChild(document.createTextNode(c.text || ''));
    if (c.text2) { var d = document.createElement('span'); d.className = 't2'; d.textContent = c.text2; li.appendChild(d); }
    ol.appendChild(li);
  });
}

// 底栏开关按当前状态写明"开/关"(实测反馈: 只写"动效/口播"看不出现在是开还是关)
function paintToggles(){
  var b = el('fxbtn'); if (b) { b.textContent = nofx ? T.fxOff : T.fxOn; b.className = nofx ? 'on' : ''; }
  var n = el('narrbtn'); if (n) { var off = document.body.classList.contains('narr-off'); n.textContent = off ? T.narrOff : T.narrOn; n.className = off ? 'on' : ''; }
  var t = el('transbtn'); if (t) t.textContent = trans === 'cut' ? T.cut : T.xfade;
}

// multi = 本张当前可逐级(动效开 + 多级 + 文件名没带 ?/# —— 带 ?/# 的副本拼 ?s= 查询会失效, 只能整张放)
function multi(){ var s = cur(); return !nofx && s.steps && s.steps.length > 1 && !/[?#]/.test(s.src); }

function render(){
  var s = cur();
  document.body.classList.toggle('xfade', trans === 'xfade');
  var lvl = multi() ? (' · ' + T.level + ' ' + step + '/' + s.steps.length) : '';
  el('pageno').textContent = (i + 1) + ' / ' + S.length + lvl;
  var src;
  if (nofx) src = s.nofx;
  else if (multi()) src = s.src + '?s=' + step + (animNext ? '&anim=1' : '');
  else src = s.src;
  show(src);
  paintToggles(); paintPanel(); layout();
}

// 动效开: →/← 先逐级揭示(下一级当场入场、上一级直接终态), 到头/回头才翻页;动效关: 直接翻页。
// 片尾(末张末级)再按 → / 片头(首张第 1 级)再按 ← 都是 no-op —— 旧实现会把末张重置回第 1 级重播、首张跳到末级终态
function next(){
  if (i >= S.length - 1 && (!multi() || step >= cur().steps.length)) return;
  if (multi() && step < cur().steps.length) { step++; animNext = true; }
  else { i = Math.min(S.length - 1, i + 1); enterSlide(true); }
  render();
}
function prev(){
  if (i <= 0 && (!multi() || step <= 1)) return;
  if (multi() && step > 1) { step--; animNext = false; }
  else { i = Math.max(0, i - 1); enterSlide(false); }
  render();
}
// 进入一张: 向前进 = 只出第 1 级(当场入场);往回跳/总览选张 = 直接整张终态
function enterSlide(fwd){
  var s = cur();
  if (fwd) { step = 1; animNext = true; }
  else { step = (s.steps && s.steps.length) ? s.steps.length : 1; animNext = false; }
}
function go(n){ i = Math.max(0, Math.min(S.length - 1, n)); enterSlide(false); render(); }

function toggleNarr(){
  if (!el('panel')) return;                    // 本片就没有口播 UI(没 clauses 或 --no-script)
  document.body.classList.toggle('narr-off');  // 只是 display:none, 所以还能切回来
  paintToggles();
  setTimeout(layout, 30);
}

function buildGrid(){
  var g = el('grid'); g.innerHTML = '';
  S.forEach(function(s, n){
    var f = document.createElement('figure');
    var img = document.createElement('img');
    img.src = '../' + s.id + '.png';
    img.alt = s.id;
    img.onerror = function(){ var p = document.createElement('div'); p.className = 'ph'; p.textContent = T.noThumbA + s.id + '.png)'; img.replaceWith(p); };
    f.appendChild(img);
    var cap = document.createElement('figcaption');
    var b = document.createElement('b'); b.textContent = s.id;
    cap.appendChild(b);
    cap.appendChild(document.createTextNode(s.title || s.name));
    f.appendChild(cap);
    f.onclick = function(){ go(n); el('overlay').classList.remove('show'); };
    g.appendChild(f);
  });
}

var ACT = {
  prev: prev,
  next: next,
  nofx: function(){ nofx = !nofx; render(); },
  trans: function(){ trans = trans === 'cut' ? 'xfade' : 'cut'; render(); },
  narr: toggleNarr,
  overview: function(){ buildGrid(); el('overlay').classList.add('show'); }
};
Array.prototype.forEach.call(document.querySelectorAll('#touchbar button'), function(b){
  b.onclick = function(){ (ACT[b.getAttribute('data-act')] || function(){})(); };
});

// 触屏: 左右滑 = 逐级入场/翻页(与按钮、键盘同一套 next/prev;画面本身是纯 CSS, 盖一层透明接收层)
(function(){
  var hit = el('hit'); if (!hit) return;
  var x0 = 0, y0 = 0;
  hit.addEventListener('touchstart', function(e){ var t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  hit.addEventListener('touchend', function(e){
    var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) next(); else prev(); }
  }, { passive: true });
})();

document.addEventListener('keydown', function(e){
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { next(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { prev(); e.preventDefault(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(S.length - 1);
  else if (e.key === 'x' || e.key === 'X') ACT.nofx();
  else if (e.key === 't' || e.key === 'T') ACT.trans();
  else if (e.key === 'p' || e.key === 'P') toggleNarr();
  else if (e.key === 'o' || e.key === 'O') ACT.overview();
  else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else el('stage').requestFullscreen(); }
  else if (e.key === 'Escape') el('overlay').classList.remove('show');
});

// 窄窗口/手机上画面优先: 口播面板默认收起(点"口播文案"或按 P 展开)
try { if (el('panel') && window.matchMedia('(max-width:860px)').matches) document.body.classList.add('narr-off'); } catch (e) {}

render();
</script>
</body>
</html>
`;
}

// ─────────────────────────── 主流程 ───────────────────────────

function main() {
  const argv = process.argv.slice(2);
  const dir = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
  const OPEN = argv.includes('--open');
  const NO_SCRIPT = argv.includes('--no-script');   // 不加载口播文案 UI(只想看 HTML 画面时)
  process.env.KIT_PROJECT_DIR = dir;

  const scriptPath = path.join(dir, 'script.json');
  if (!fs.existsSync(scriptPath)) { console.error(`✗ 找不到 ${scriptPath}`); process.exit(1); }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  validateScriptPaths(script, dir); // id/html 派生路径收监(与 capture 同一道门)

  const timingsPath = path.join(dir, 'build', 'timings.json');
  const hasTimings = fs.existsSync(timingsPath);
  const timings = hasTimings ? JSON.parse(fs.readFileSync(timingsPath, 'utf8')) : null;

  const slidesDir = path.join(dir, 'slides');
  const outDir = safeOut(dir, 'preview', 'play');
  fs.mkdirSync(outDir, { recursive: true });

  // 项目 tokens.css 落后于技能当前版本(缺 no-fx / 图表 / 表格任一段)时给副本兜底注入当前版,
  // 并在页面与终端如实说明 —— 否则"关动效对照"会把画面锁在入场前的透明态, 旧图表规则也会
  // 把新版画法(如 .chart-ticks)渲染坏。注入的 <style> 排在 tokens.css 之后, 后写覆盖。
  const tokensPath = path.join(slidesDir, 'tokens.css');
  const tokensCss = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, 'utf8') : '';
  // 与 check-slides / init-project 同一道门: 恶意/误写超大 tokens.css 会让受管块扫描二次方变慢(实测 6MB ≈ 129s)
  if (tokensCss.length > MAX_SCAN_BYTES) {
    console.error(`✗ tokens.css 有 ${(tokensCss.length / 1e6).toFixed(1)}MB, 超过 ${MAX_SCAN_BYTES / 1e6}MB 上限, 拒绝扫描(正常 ≈15KB; 与 check-slides / init-project --check-css 同一道门)`);
    process.exit(1);
  }
  const kitIssues = kitStatuses(tokensCss)
    .map((st, i) => ({ ...st, css: KITS[i].css }))
    .filter(st => st.status !== 'ok');
  const nofxIssue = kitIssues.find(k => k.id === 'nofx');
  const chartTable = kitIssues.filter(k => k.id !== 'nofx');
  const ctCss = chartTable.map(k => k.css).join('\n\n');
  const ctLabel = chartTable.map(k => k.label).join(' · ');
  // 页面上用户可见的文字按 script.lang 双语; 终端输出是给 agent 看的, 保持中文
  const isEn = String(script.lang ?? 'zh').toLowerCase().startsWith('en');
  const L = (zh, en) => (isEn ? en : zh);
  const cssNote = kitIssues.length
    ? L(`本项目 tokens.css 落后于技能当前版(缺: ${kitIssues.map(k => k.label).join(' · ')}) —— 快照已兜底注入当前版;想让成片与项目文件也用上, 跑 init-project --upgrade-css`,
        `This project's tokens.css is behind the skill's current version (missing: ${kitIssues.map(k => k.label).join(' / ')}) — snapshots inject the current one as a fallback; run init-project --upgrade-css to upgrade the project itself`)
    : '';

  const rows = [];
  let fallbackUsed = false;
  // 画布值会插进放映页的 CSS 与页面 JS(与 build-video 拼 ffmpeg filter 同一信任级), 先验后用
  const cvW = Number(script.width ?? 1920), cvH = Number(script.height ?? 1080);
  if (!Number.isInteger(cvW) || cvW < 16 || cvW > 16384 || !Number.isInteger(cvH) || cvH < 16 || cvH > 16384) {
    console.error(`✗ script.width/height 非法: ${JSON.stringify(script.width)} × ${JSON.stringify(script.height)} — 需要 16–16384 的整数(误写字符串会直接杀死放映页脚本, 与 build-video 的 clampDim 同一道门)`);
    process.exit(1);
  }
  for (const s of script.slides) {
    const sid = safeId(s.id);
    // 安全性照旧收监(越界仍退出 1); 但"这张还没写"按 capture 的惯例跳过并警告 ——
    // 写到第 3 张就想先放映看看是常态, 不该因为后面几张还没写就整个出不来。
    const relHtml = s.html ?? `${sid}.html`;
    const srcPath = safeRel(slidesDir, relHtml, { where: `slides[${sid}].html` });
    if (!fs.existsSync(srcPath)) { console.warn(`- 跳过 ${sid}: 缺 slides/${relHtml}`); continue; }
    if (path.dirname(relHtml) !== '.') { console.warn(`- 跳过 ${sid}: slides/${relHtml} 在子目录里 — 放映页快照按平铺 slides/ 设计, 子目录副本与 <base> 会错位; 把 HTML 挪到 slides/ 根再跑`); continue; }
    const html = fs.readFileSync(srcPath, 'utf8');
    if (html.length > MAX_SCAN_BYTES) { console.warn(`- 跳过 ${sid}: HTML 超过 ${MAX_SCAN_BYTES / 1e6}MB 上限, 拒绝扫描(正常 ≈10KB)`); continue; }
    const base = path.basename(srcPath);
    const t = timings?.slides?.find(x => x.id === s.id);

    // 有对时 → 用实测延迟; 没有(口播还没做) → 按 HTML 里实际用到的 stage 等间隔错开,
    // 至少能看清入场顺序(占位值会把动画全挤在 2 秒内, 那才是看不懂的)。
    let stages = t?.stages ?? {};
    let fallback = false;
    if (!Object.keys(stages).length) { stages = fallbackStages(html); fallback = Object.keys(stages).length > 0; }
    if (fallback) fallbackUsed = true;
    const decl = stageVars(stages, { w: cvW, h: cvH });

    let copy = addBaseHref(injectHtmlVars(html, decl), '../../slides/');
    copy = `<!-- html2video-for-mcode 放映页快照 · 由 scripts/preview-page.mjs 生成, 请勿编辑;\n     真实文件: slides/${base}(改完 slides 请重跑 preview-page.mjs) -->\n` + copy;
    copy = addStepScript(copy, stagesFromHtml(html));   // 动效开的逐级步进(?s=k 重设各级延迟)
    if (ctCss) copy = injectStyle(copy, ctCss, `图表/表格工具箱(${ctLabel})`);
    fs.writeFileSync(path.join(outDir, base), copy);
    const nofxName = base.replace(/\.html?$/i, '') + '.nofx.html';
    let nofx = addNoFx(copy);
    if (nofxIssue) nofx = injectStyle(nofx, NOFX_CSS, 'no-fx 规则');
    fs.writeFileSync(path.join(outDir, nofxName), nofx);

    const stageVals = Object.values(stages).filter(Number.isFinite);
    rows.push({
      id: sid, name: base, title: s.title ?? s.layout ?? '',
      copy: base, copyNofx: nofxName,
      steps: stagesFromHtml(html),
      duration: t?.duration,
      lastStage: stageVals.length ? Math.max(...stageVals) : null,
      clauses: t?.clauses ?? (s.clauses ?? []).map(c => ({ stage: c.stage ?? null, start: null, text: c.text, text2: c.text2 })),
    });
  }

  const p2 = n => String(n).padStart(2, '0');
  const now = new Date();
  if (!rows.length) { console.error('✗ 一张可放映的 slide 都没有(检查 script.json 的 html 字段与 slides/ 目录)'); process.exit(1); }

  // 口播 UI 三种状态: 有文案+有对时 → 标注正常;有文案没对时 → 标注"未对时";没文案或 --no-script → 不出
  const anyClauses = rows.some(r => r.clauses.length > 0);
  const narration = anyClauses && !NO_SCRIPT;
  const timing = narration && !!timings && rows.some(r => r.clauses.some(c => Number.isFinite(c.start)));
  // 提示与口播无关: 动画时序不是成片的, 这件事看画面的人也必须知道
  const fallbackNote = [
    (!hasTimings || fallbackUsed) ? L('口播还没对时: 入场顺序按等间隔 0.3/1.3/2.3s 估算, 不是成片时序(缺 build/timings.json)',
        'Narration not timed yet: entrance order estimated at 0.3/1.3/2.3s intervals — not the final timing (missing build/timings.json)') : '',
    L('动画为手动逐级步进: 按 → 先出下一级, 出完再翻页(动效关则直接翻页)',
        'Animations step manually: press → to reveal the next level first, then the next slide (motion off = switch slides directly)'),
    narration && !timing ? L('口播还没对时: 只列文案', 'Narration not timed yet: script text only') : '',
  ].filter(Boolean).join(' · ');

  const page = buildPlayPage({
    topic: script.topic ?? '', lang: script.lang ?? 'zh', slides: rows, cssNote,
    narration, timing, fallbackNote,
    canvas: { w: cvW, h: cvH },
    generatedAt: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`,
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), page);

  const modes = !narration ? (NO_SCRIPT ? '关(--no-script)' : '关(本片没有 clauses)') : timing ? '口播文案(有对时)' : '口播文案(未对时)';
  console.log(`✓ 放映页 → ${path.relative(process.cwd(), path.join(outDir, 'index.html'))}`);
  console.log(`  快照 ${rows.length} 张 ×2(动效/关动效) → ${path.relative(process.cwd(), outDir)}/${rows[0]?.name ?? '<id>.html'}`);
  console.log(`  口播 UI: ${modes}`);
  if (!hasTimings) console.warn('⚠ 缺 build/timings.json: 副本按等间隔预览入场顺序, 不是成片时序 —— 先跑 plan-timings.mjs');
  else if (fallbackUsed) console.warn('⚠ 部分张在 timings.json 里没有 stage 数据: 那几张按等间隔预览');
  else console.log(`  已注入实测 stage 延迟: ${rows.map(r => `${r.id}(${r.lastStage != null ? '末层 ' + r.lastStage.toFixed(1) + 's' : '无 stage'})`).join(' ')}`);
  if (kitIssues.length) console.warn(`⚠ slides/tokens.css 落后于技能当前版(缺: ${kitIssues.map(k => k.label).join(' · ')}) —— 副本已兜底注入;想让成片与项目文件也用上, 跑 node scripts/init-project.mjs <项目目录> --upgrade-css`);
  console.log(`  操作: ← → 逐级入场/翻页(动效开)或翻页(动效关) · X 动效开/关${narration ? ' · P 口播开/关' : ''} · O 总览 · F 全屏;触屏左右滑同 ← →`);

  if (OPEN) {
    const target = path.join(outDir, 'index.html');
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    console.log('  已在浏览器打开(若没弹出, 手动双击上面的 index.html)');
  }
}

// 被 tests/ import 时不要跑主流程(只有当脚本直接执行才跑)
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) main();
