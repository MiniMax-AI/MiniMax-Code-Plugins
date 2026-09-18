#!/usr/bin/env node
// html2video-for-mcode · 放映页: preview/play/index.html + 逐张"真实时序"快照。
// 用法: node preview-page.mjs <项目目录> [--open] [--no-script]
//
// 定位: **用浏览器把 HTML 画面放一遍**。只做四件事 —— 翻页、重播动画、动效/关动效对照、总览;
// 口播文案是锦上添花(可关), 不做计时器/进度条/播放器那套 UI(要看时间就直接看成片)。
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
import { safeId, safeRel, validateScriptPaths } from './tools.mjs';
import { NOFX_CSS } from './nofx-css.mjs';
import { KITS, kitStatuses } from './css-kit.mjs';

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

function firstTag(html, name) {
  const m = html.match(new RegExp(`<${name}\\b[^>]*>`, 'i'));
  return m ? { tag: m[0], index: m.index } : null;
}

function setAttr(tag, name, value) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  if (re.test(tag)) return tag.replace(re, `${name}="${value}"`);
  return tag.replace(/\s*\/?>$/, m => ` ${name}="${value}"${m.endsWith('/>') ? '/>' : '>'}`);
}

function addStyleDecl(tag, decl) {
  if (!decl) return tag;
  const m = tag.match(/\bstyle\s*=\s*"([^"]*)"/i);
  if (!m) return setAttr(tag, 'style', decl);
  return tag.replace(m[0], `style="${m[1].trim().replace(/;?$/, ';')}${decl}"`);
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
  const m = t.tag.match(/\bclass\s*=\s*"([^"]*)"/i);
  let tag;
  if (m) {
    if (/\bno-fx\b/.test(m[1])) return html;
    tag = t.tag.replace(m[0], `class="${m[1].trim()} no-fx"`);
  } else {
    tag = setAttr(t.tag, 'class', 'no-fx');
  }
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

// ─────────────────────────── 放映页 ───────────────────────────

export function buildPlayPage({
  topic = '', lang = 'zh', slides = [], cssNote = '', generatedAt = '',
  narration = true,    // 是否加载口播文案 UI(没有 clauses 或 --no-script 时为 false)
  timing = false,      // 是否有对时数据(只影响标题上的"(未对时)"标注)
  fallbackNote = '',   // "还没对时/等间隔预览"的如实说明(与口播 UI 无关, 画面上也要说清)
} = {}) {
  const model = slides.map(s => ({
    id: s.id, name: s.name, title: s.title ?? '',
    src: s.copy, nofx: s.copyNofx,
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
<title>放映页 · ${esc(topic) || 'html2video'} · html2video-for-mcode</title>
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
  #fit{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center center}
  #frame{width:1920px;height:1080px;border:0;display:block;background:#fff}
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
  #touchbar{display:none;gap:6px;width:100%}
  #touchbar button{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;color:var(--c-fg);background:#1a1d26;
    border:1px solid var(--c-line);border-radius:8px;padding:8px 4px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #touchbar button:active{background:#252a38}
  /* ── 总览 ── */
  #overlay{position:fixed;inset:0;background:rgba(6,7,10,.975);padding:28px;overflow:auto;display:none;z-index:9}
  #overlay.show{display:block}
  #overlay h2{margin:0 0 16px;font-size:15px;color:var(--c-dim);font-weight:600}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:14px}
  #grid figure{margin:0;border:1px solid var(--c-line);border-radius:10px;overflow:hidden;background:#000;cursor:pointer}
  #grid figure:hover{border-color:var(--c-acc)}
  #grid img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
  #grid .ph{width:100%;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:var(--c-dim);font-size:12px}
  #grid figcaption{padding:8px 10px;font-size:12px;color:var(--c-dim)}
  #grid figcaption b{color:var(--c-fg);font-weight:600;margin-right:6px}
  /* ── 窄窗口 / 手机: 口播文案收到底部当抽屉, 键盘提示换成触摸按钮 ── */
  @media (max-width:860px), (pointer:coarse){
    footer .kbd-hints{display:none}
    #touchbar{display:flex}
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
    <span class="topic" title="${esc(topic)}">${esc(topic) || '放映页'}</span>
    <span class="chip" id="pageno">1 / ${slides.length}</span>
    <button class="chip" id="mode" type="button" title="动效 / 关动效 对照(快捷键 X)">动效</button>
    <span class="grow"></span>
  </header>
  ${notice}
</div>
<main>
  <div id="stage"><div id="fit"><iframe id="frame" title="slide" scrolling="no" frameborder="0"></iframe></div><div id="hit"></div></div>
  ${narration ? `<aside id="panel">
    <h2>本张口播文案${timing ? '' : '(未对时)'}</h2>
    <ol id="clauses"></ol>
    ${cssWarn}
  </aside>` : ''}
</main>
<footer>
  <span class="kbd-hints">
    <span><kbd>←</kbd><kbd>→</kbd> 翻页</span>
    <span><kbd>R</kbd> 重播</span>
    <span><kbd>X</kbd> 动效 / 关动效 对照</span>
    ${narration ? '<span><kbd>P</kbd> 口播文案 开 / 关</span>' : ''}
    <span><kbd>O</kbd> 总览</span>
    <span><kbd>F</kbd> 全屏</span>
  </span>
  <span class="gen">快照生成于 ${esc(generatedAt)} · 画面与成片同源(无声、无字幕)</span>
  <span id="touchbar">
    <button type="button" data-act="prev" title="上一张">‹</button>
    <button type="button" data-act="replay" title="重播入场动画">↻ 重播</button>
    <button type="button" data-act="nofx" title="动效 / 关动效 对照">动效</button>
    ${narration ? '<button type="button" data-act="narr" title="口播文案 开 / 关">口播</button>' : ''}
    <button type="button" data-act="overview" title="总览">总览</button>
    <button type="button" data-act="next" title="下一张">›</button>
  </span>
</footer>
<div id="overlay"><h2>总览 · 点任意一张跳转(缩略图来自 preview/*.png)</h2><div id="grid"></div></div>
<script>
var S = ${json};
var i = 0, nofx = false;

function el(id){ return document.getElementById(id); }
function cur(){ return S[i]; }

function layout(){
  var st = el('stage'); if (!st) return;
  var r = st.getBoundingClientRect();
  if (!r.width || !r.height) return;
  var k = Math.min(r.width / 1920, r.height / 1080) * 0.98;
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

function render(){
  var s = cur();
  el('pageno').textContent = (i + 1) + ' / ' + S.length;
  el('mode').textContent = nofx ? '关动效' : '动效';
  el('mode').className = 'chip' + (nofx ? ' on' : '');
  el('frame').src = nofx ? s.nofx : s.src;   // 换 src = 重新加载 = 动画从 0 开始
  paintPanel(); layout();
}

function go(n){ i = Math.max(0, Math.min(S.length - 1, n)); render(); }

function toggleNarr(){
  if (!el('panel')) return;                    // 本片就没有口播 UI(没 clauses 或 --no-script)
  document.body.classList.toggle('narr-off');  // 只是 display:none, 所以还能切回来
  setTimeout(layout, 30);
}

function buildGrid(){
  var g = el('grid'); g.innerHTML = '';
  S.forEach(function(s, n){
    var f = document.createElement('figure');
    var img = document.createElement('img');
    img.src = '../' + s.id + '.png';
    img.alt = s.id;
    img.onerror = function(){ var p = document.createElement('div'); p.className = 'ph'; p.textContent = '无缩略图(preview/' + s.id + '.png)'; img.replaceWith(p); };
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
  prev: function(){ go(i - 1); },
  next: function(){ go(i + 1); },
  replay: function(){ render(); },
  nofx: function(){ nofx = !nofx; render(); },
  narr: toggleNarr,
  overview: function(){ buildGrid(); el('overlay').classList.add('show'); }
};
Array.prototype.forEach.call(document.querySelectorAll('#touchbar button'), function(b){
  b.onclick = function(){ (ACT[b.getAttribute('data-act')] || function(){})(); };
});
el('mode').onclick = ACT.nofx;

// 触屏: 左右滑翻页(画面本身是纯 CSS, 不需要交互, 所以盖一层透明接收层)
(function(){
  var hit = el('hit'); if (!hit) return;
  var x0 = 0, y0 = 0;
  hit.addEventListener('touchstart', function(e){ var t = e.changedTouches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
  hit.addEventListener('touchend', function(e){
    var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) go(i + (dx < 0 ? 1 : -1));
  }, { passive: true });
})();

document.addEventListener('keydown', function(e){
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { go(i + 1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(i - 1); e.preventDefault(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(S.length - 1);
  else if (e.key === 'r' || e.key === 'R') render();
  else if (e.key === 'x' || e.key === 'X') ACT.nofx();
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
  const outDir = path.join(dir, 'preview', 'play');
  fs.mkdirSync(outDir, { recursive: true });

  // 项目 tokens.css 落后于技能当前版本(缺 no-fx / 图表 / 表格任一段)时给副本兜底注入当前版,
  // 并在页面与终端如实说明 —— 否则"关动效对照"会把画面锁在入场前的透明态, 旧图表规则也会
  // 把新版画法(如 .chart-ticks)渲染坏。注入的 <style> 排在 tokens.css 之后, 后写覆盖。
  const tokensPath = path.join(slidesDir, 'tokens.css');
  const tokensCss = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, 'utf8') : '';
  const kitIssues = kitStatuses(tokensCss)
    .map((st, i) => ({ ...st, css: KITS[i].css }))
    .filter(st => st.status !== 'ok');
  const nofxIssue = kitIssues.find(k => k.id === 'nofx');
  const chartTable = kitIssues.filter(k => k.id !== 'nofx');
  const ctCss = chartTable.map(k => k.css).join('\n\n');
  const ctLabel = chartTable.map(k => k.label).join(' · ');
  const cssNote = kitIssues.length
    ? `本项目 tokens.css 落后于技能当前版(缺: ${kitIssues.map(k => k.label).join(' · ')}) —— 快照已兜底注入当前版;想让成片与项目文件也用上, 跑 init-project --upgrade-css`
    : '';

  const rows = [];
  let fallbackUsed = false;
  for (const s of script.slides) {
    const sid = safeId(s.id);
    // 安全性照旧收监(越界仍退出 1); 但"这张还没写"按 capture 的惯例跳过并警告 ——
    // 写到第 3 张就想先放映看看是常态, 不该因为后面几张还没写就整个出不来。
    const relHtml = s.html ?? `${sid}.html`;
    const srcPath = safeRel(slidesDir, relHtml, { where: `slides[${sid}].html` });
    if (!fs.existsSync(srcPath)) { console.warn(`- 跳过 ${sid}: 缺 slides/${relHtml}`); continue; }
    const html = fs.readFileSync(srcPath, 'utf8');
    const base = path.basename(srcPath);
    const t = timings?.slides?.find(x => x.id === s.id);

    // 有对时 → 用实测延迟; 没有(口播还没做) → 按 HTML 里实际用到的 stage 等间隔错开,
    // 至少能看清入场顺序(占位值会把动画全挤在 2 秒内, 那才是看不懂的)。
    let stages = t?.stages ?? {};
    let fallback = false;
    if (!Object.keys(stages).length) { stages = fallbackStages(html); fallback = Object.keys(stages).length > 0; }
    if (fallback) fallbackUsed = true;
    const decl = stageVars(stages, { w: script.width ?? 1920, h: script.height ?? 1080 });

    let copy = addBaseHref(injectHtmlVars(html, decl), '../../slides/');
    copy = `<!-- html2video-for-mcode 放映页快照 · 由 scripts/preview-page.mjs 生成, 请勿编辑;\n     真实文件: slides/${base}(改完 slides 请重跑 preview-page.mjs) -->\n` + copy;
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
    (!hasTimings || fallbackUsed) ? '动画按等间隔 0.3/1.3/2.3s 预览入场顺序, 不是成片时序(缺 build/timings.json)' : '',
    narration && !timing ? '口播还没对时: 只列文案' : '',
  ].filter(Boolean).join(' · ');

  const page = buildPlayPage({
    topic: script.topic ?? '', lang: script.lang ?? 'zh', slides: rows, cssNote,
    narration, timing, fallbackNote,
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
  console.log(`  操作: ← → 翻页 · R 重播 · X 动效/关动效对照${narration ? ' · P 口播文案开/关' : ''} · O 总览 · F 全屏;触屏左右滑翻页`);

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
