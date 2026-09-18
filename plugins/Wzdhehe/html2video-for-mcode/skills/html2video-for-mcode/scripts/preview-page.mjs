#!/usr/bin/env node
// html2video-for-mcode · 放映页: preview/play/index.html + 逐张"真实时序"快照。
// 用法: node preview-page.mjs <项目目录> [--open]
//
// 为什么不是"直接双击 slides/*.html": 动画延迟(--t1/--t2/--t3)与画布尺寸是渲染管线按
// timings.json 注入的(tokens.css 里只有占位默认值 --t2:800ms), 直接打开看到的是"所有动画
// 挤在 2 秒内"的假象。本脚本把注入值原样写进副本的 <html style>, 于是浏览器里的播放时序
// = 成片时序, 且副本带 <base href> 指回 slides/, 主题与素材照常解析。
// 另出一份加了 no-fx 的副本, 放映页按 X 键即可对照"关掉动效后画面是否还完整" —— 这是
// "元素永久不可见 / 关动效反而更空"那类静默故障的 5 秒自检, 不必等 3–6 分钟的 motion 编码。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safeId, safeRel, validateScriptPaths } from './tools.mjs';
import { NOFX_CSS, hasNofxRules } from './nofx-css.mjs';

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

// 兜底: 老项目 tokens.css 里没有 no-fx 规则时, 只给"关动效副本"补上(排在 tokens.css 之后)
export function injectStyle(html, css) {
  const block = `<style>/* preview-page 兜底注入: 本项目 tokens.css 缺 no-fx 规则 */\n${css}\n</style>\n`;
  const i = html.search(/<\/head>/i);
  return i < 0 ? block + html : html.slice(0, i) + block + html.slice(i);
}

// ─────────────────────────── 放映页 ───────────────────────────

export function buildPlayPage({ topic = '', lang = 'zh', slides = [], hasTimings = true, noFxNote = '', generatedAt = '' } = {}) {
  const model = slides.map(s => ({
    id: s.id, name: s.name, title: s.title ?? '',
    src: s.copy, nofx: s.copyNofx,
    dur: Number.isFinite(s.duration) ? s.duration : null,
    lastStage: Number.isFinite(s.lastStage) ? s.lastStage : null,
    clauses: (s.clauses ?? []).map(c => ({ stage: c.stage ?? null, start: c.start ?? null, text: c.text ?? '', text2: c.text2 ?? '' })),
  }));
  const json = JSON.stringify(model).replace(/</g, '\\u003c');
  const warn = hasTimings ? '' :
    '<p class="warn">⚠ 没找到 build/timings.json —— 副本用的是 tokens.css 占位延迟(动画会挤在开头)。先跑 plan-timings.mjs 再重跑本脚本。</p>';
  const nofxWarn = noFxNote ? `<p class="warn">⚠ ${esc(noFxNote)}</p>` : '';

  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>放映页 · ${esc(topic) || 'html2video'} · html2video-for-mcode</title>
<style>
  :root{--c-bg:#0b0c10;--c-panel:#14161c;--c-fg:#e8ebf4;--c-dim:#8b90a0;--c-line:#23252e;--c-acc:#6ea8fe;--c-warn:#ffb454;--c-bad:#ff6b6b}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--c-bg);color:var(--c-fg);overflow:hidden;
    font:14px/1.5 -apple-system,"Segoe UI",system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
  header{display:flex;align-items:center;gap:14px;padding:9px 16px;border-bottom:1px solid var(--c-line);flex:0 0 auto}
  header .topic{font-weight:600}
  header .grow{flex:1}
  header .chip{color:var(--c-dim);font-variant-numeric:tabular-nums;white-space:nowrap}
  header .chip b{color:var(--c-fg)}
  header .chip.bad{color:var(--c-bad)}
  header .chip.on{color:var(--c-warn)}
  main{display:flex;height:calc(100% - 39px - 30px)}
  #stage{position:relative;flex:1;overflow:hidden;background:#000}
  #fit{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center center}
  #frame{width:1920px;height:1080px;border:0;display:block;background:#fff}
  #panel{flex:0 0 320px;border-left:1px solid var(--c-line);background:var(--c-panel);overflow:auto;padding:14px 16px}
  #panel.hide{display:none}
  #panel h2{margin:0 0 10px;font-size:13px;color:var(--c-dim);font-weight:600;letter-spacing:.04em}
  #clauses{list-style:none;margin:0;padding:0}
  #clauses li{padding:8px 10px;border-radius:8px;border:1px solid transparent;color:var(--c-dim);margin-bottom:6px}
  #clauses li.now{color:var(--c-fg);background:#1d2130;border-color:#334}
  #clauses .st{display:inline-block;min-width:22px;margin-right:6px;color:var(--c-acc);font-variant-numeric:tabular-nums;font-size:12px}
  #clauses .t2{display:block;color:var(--c-dim);font-size:12px;margin-top:2px}
  .meta{color:var(--c-dim);font-size:12px;margin:10px 0 0}
  .warn{color:var(--c-warn);font-size:12px}
  footer{height:30px;display:flex;align-items:center;gap:16px;padding:0 16px;border-top:1px solid var(--c-line);color:var(--c-dim);font-size:12px;flex:0 0 auto}
  footer kbd{background:#1d2130;border:1px solid var(--c-line);border-radius:4px;padding:1px 5px;color:var(--c-fg);font-family:inherit}
  #bar{position:relative;height:6px;background:#1a1c24;border-bottom:1px solid var(--c-line)}
  #bar i{position:absolute;top:0;bottom:0;width:1px;background:var(--c-acc);opacity:.55}
  #bar u{position:absolute;top:0;bottom:0;left:0;width:0;background:linear-gradient(90deg,#2b3a5c,#3f5c96)}
  #overlay{position:fixed;inset:0;background:rgba(6,7,10,.975);padding:28px;overflow:auto;display:none}
  #overlay.show{display:block}
  #overlay h2{margin:0 0 16px;font-size:15px;color:var(--c-dim);font-weight:600}
  #grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
  #grid figure{margin:0;border:1px solid var(--c-line);border-radius:10px;overflow:hidden;background:#000;cursor:pointer}
  #grid figure:hover{border-color:var(--c-acc)}
  #grid img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
  #grid .ph{width:100%;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:var(--c-dim);font-size:12px}
  #grid figcaption{padding:8px 10px;font-size:12px;color:var(--c-dim)}
  #grid figcaption b{color:var(--c-fg);font-weight:600;margin-right:6px}
</style>
</head>
<body>
<header>
  <span class="topic">${esc(topic) || '放映页'}</span>
  <span class="chip" id="pageno">1 / ${slides.length}</span>
  <span class="chip" id="mode">动效</span>
  <span class="grow"></span>
  <span class="chip" id="clock">—</span>
</header>
<div id="bar"></div>
<main>
  <div id="stage"><div id="fit"><iframe id="frame" title="slide" scrolling="no" frameborder="0"></iframe></div></div>
  <aside id="panel">
    <h2>本张口播</h2>
    <ol id="clauses"></ol>
    <p class="meta" id="pmeta"></p>
    ${warn}
    ${nofxWarn}
  </aside>
</main>
<footer>
  <span><kbd>←</kbd><kbd>→</kbd> 翻页</span>
  <span><kbd>R</kbd> 重播动画</span>
  <span><kbd>X</kbd> 关配音画对比</span>
  <span><kbd>P</kbd> 提词面板</span>
  <span><kbd>O</kbd> 总览</span>
  <span><kbd>F</kbd> 全屏</span>
  <span style="margin-left:auto">快照生成于 ${esc(generatedAt)} · 画面与成片同源, 无字幕与声音</span>
</footer>
<div id="overlay"><h2>总览 · 点任意一张跳转(缩略图来自 preview/*.png)</h2><div id="grid"></div></div>
<script>
var S = ${json};
var i = 0, nofx = false, shownAt = 0, raf = 0;

function el(id){ return document.getElementById(id); }
function pad(n){ return n < 10 ? '0' + n : '' + n; }
function cur(){ return S[i]; }

function layout(){
  var st = el('stage').getBoundingClientRect();
  var k = Math.min(st.width / 1920, st.height / 1080) * 0.98;
  el('fit').style.transform = 'translate(-50%,-50%) scale(' + k + ')';
}
window.addEventListener('resize', layout);
if (document.addEventListener) document.addEventListener('fullscreenchange', function(){ setTimeout(layout, 60); });

function paintBar(){
  var s = cur(), bar = el('bar');
  bar.innerHTML = '';
  var u = document.createElement('u'); bar.appendChild(u);
  var total = s.dur || (s.lastStage || 1);
  (s.clauses || []).forEach(function(c){
    if (c.start == null) return;
    var t = document.createElement('i');
    t.style.left = Math.max(0, Math.min(100, (c.start / total) * 100)) + '%';
    bar.appendChild(t);
  });
}

function paintPanel(){
  var s = cur();
  var ol = el('clauses'); ol.innerHTML = '';
  (s.clauses || []).forEach(function(c){
    var li = document.createElement('li');
    var st = document.createElement('span'); st.className = 'st';
    st.textContent = c.stage != null ? 'L' + c.stage : '--';
    li.appendChild(st);
    li.appendChild(document.createTextNode(c.text || ''));
    if (c.text2) { var d = document.createElement('span'); d.className = 't2'; d.textContent = c.text2; li.appendChild(d); }
    ol.appendChild(li);
  });
  var meta = [];
  if (s.dur != null) meta.push('成片 ' + s.dur.toFixed(1) + 's');
  if (s.lastStage != null) meta.push('最后一层入场 ≈ ' + s.lastStage.toFixed(1) + 's(动画再跑 0.7–1.2s)');
  if (s.dur != null && s.lastStage != null && s.dur - s.lastStage < 1.2) meta.push('⚠ 收尾静止不足 1.2s');
  el('pmeta').textContent = meta.join(' · ');
}

function tick(){
  var s = cur();
  var t = (performance.now() - shownAt) / 1000;
  var bar = el('bar').querySelector('u');
  var total = s.dur || (s.lastStage || 1);
  if (bar) bar.style.width = Math.max(0, Math.min(100, (t / total) * 100)) + '%';
  var c = el('clock');
  var txt = t.toFixed(1) + 's';
  if (s.dur != null) txt += ' / ' + s.dur.toFixed(1) + 's';
  c.innerHTML = '<b>' + txt + '</b>';
  c.className = 'chip' + (s.dur != null && t > s.dur ? ' bad' : '');
  var list = el('clauses').children;
  for (var n = 0; n < list.length; n++){
    var cl = (s.clauses || [])[n]; if (!cl) continue;
    var nx = (s.clauses[n + 1] || {}).start != null ? s.clauses[n + 1].start : (s.dur || Infinity);
    var on = cl.start != null && t >= cl.start && t < nx;
    if (on !== list[n].classList.contains('now')) list[n].classList.toggle('now', on);
  }
  raf = requestAnimationFrame(tick);
}

function render(){
  var s = cur();
  el('pageno').textContent = (i + 1) + ' / ' + S.length;
  el('mode').textContent = nofx ? '关动效(对照)' : '动效';
  el('mode').className = 'chip' + (nofx ? ' on' : '');
  el('frame').src = nofx ? s.nofx : s.src;   // 换 src = 重新加载 = 动画从 0 开始
  shownAt = performance.now();
  paintBar(); paintPanel(); layout();
}

function go(n){ i = Math.max(0, Math.min(S.length - 1, n)); render(); }

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
    cap.appendChild(document.createTextNode((s.title || s.name) + (s.dur != null ? ' · ' + s.dur.toFixed(1) + 's' : '')));
    f.appendChild(cap);
    f.onclick = function(){ go(n); el('overlay').classList.remove('show'); };
    g.appendChild(f);
  });
}

document.addEventListener('keydown', function(e){
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { go(i + 1); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { go(i - 1); e.preventDefault(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(S.length - 1);
  else if (e.key === 'r' || e.key === 'R') render();
  else if (e.key === 'x' || e.key === 'X') { nofx = !nofx; render(); }
  else if (e.key === 'p' || e.key === 'P') { el('panel').classList.toggle('hide'); setTimeout(layout, 30); }
  else if (e.key === 'o' || e.key === 'O') { buildGrid(); el('overlay').classList.toggle('show'); }
  else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else el('stage').requestFullscreen(); }
  else if (e.key === 'Escape') el('overlay').classList.remove('show');
});

render(); tick();
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
  process.env.KIT_PROJECT_DIR = dir;

  const scriptPath = path.join(dir, 'script.json');
  if (!fs.existsSync(scriptPath)) { console.error(`✗ 找不到 ${scriptPath}`); process.exit(1); }
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  validateScriptPaths(script, dir); // id/html 派生路径收监(与 capture 同一道门)

  const timingsPath = path.join(dir, 'build', 'timings.json');
  const hasTimings = fs.existsSync(timingsPath);
  const timings = hasTimings ? JSON.parse(fs.readFileSync(timingsPath, 'utf8')) : null;
  if (timings) {
    const byId = new Map((timings.slides ?? []).map(t => [t.id, t]));
    const missing = script.slides.filter(s => !byId.has(s.id)).map(s => s.id);
    if (missing.length) console.warn(`⚠ timings.json 里没有 ${missing.join(', ')} —— 这几张用占位延迟`);
  }

  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'preview', 'play');
  fs.mkdirSync(outDir, { recursive: true });

  // 老项目(第 8 轮之前生成的 tokens.css)没有 no-fx 规则: 只给"关动效副本"兜底注入,
  // 并在页面上如实说明 —— 否则 X 键对照会把画面锁在入场前的透明态, 看着像整片空白。
  const tokensPath = path.join(slidesDir, 'tokens.css');
  const tokensCss = fs.existsSync(tokensPath) ? fs.readFileSync(tokensPath, 'utf8') : '';
  const noFxStale = !hasNofxRules(tokensCss);
  const noFxNote = noFxStale
    ? `本项目 slides/tokens.css ${tokensCss ? '没有 no-fx 规则(旧模板生成的)' : '不存在'} —— 关动效副本里已兜底注入。想让 <html class="no-fx"> 对成片也生效, 请用新版 init-project 重生成 tokens.css`
    : '';

  const rows = [];
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
    const stages = t?.stages ?? {};
    const decl = stageVars(stages, { w: script.width ?? 1920, h: script.height ?? 1080 });

    let copy = addBaseHref(injectHtmlVars(html, decl), '../../slides/');
    copy = `<!-- html2video-for-mcode 放映页快照 · 由 scripts/preview-page.mjs 生成, 请勿编辑;\n     真实文件: slides/${base}(改完 slides 请重跑 preview-page.mjs) -->\n` + copy;
    fs.writeFileSync(path.join(outDir, base), copy);
    const nofxName = base.replace(/\.html?$/i, '') + '.nofx.html';
    let nofx = addNoFx(copy);
    if (noFxStale) nofx = injectStyle(nofx, NOFX_CSS);
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
  const page = buildPlayPage({
    topic: script.topic ?? '', lang: script.lang ?? 'zh', slides: rows, hasTimings, noFxNote,
    generatedAt: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`,
  });
  fs.writeFileSync(path.join(outDir, 'index.html'), page);

  console.log(`✓ 放映页 → ${path.relative(process.cwd(), path.join(outDir, 'index.html'))}`);
  console.log(`  快照 ${rows.length} 张 ×2(动效/关动效) → ${path.relative(process.cwd(), outDir)}/${rows[0]?.name ?? '<id>.html'}`);
  if (!hasTimings) console.warn('⚠ 缺 build/timings.json: 快照用的是 tokens.css 占位延迟, 时序不是成片时序 —— 先跑 plan-timings.mjs');
  else console.log(`  已注入实测 stage 延迟: ${rows.map(r => `${r.id}(${r.lastStage != null ? '末层 ' + r.lastStage.toFixed(1) + 's' : '无 stage'})`).join(' ')}`);
  if (noFxStale) console.warn(`⚠ slides/tokens.css ${tokensCss ? '缺 no-fx 规则(旧模板生成的)' : '不存在'} —— 关动效副本已兜底注入; 想让它对成片也生效, 用新版 init-project 重生成 tokens.css`);
  console.log('  快捷键: ← → 翻页 · R 重播 · X 关动效对比 · P 提词面板 · O 总览 · F 全屏');

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
