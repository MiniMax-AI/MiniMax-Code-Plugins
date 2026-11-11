#!/usr/bin/env node
// html2video-for-mcode · 生成项目骨架
// 用法: node init-project.mjs <项目目录> [--topic "主题名"] [--force] [--upgrade-css] [--check-css]
// 目标目录已存在且非空时拒绝执行(会重置 script.json 等 5 个生成文件), 需显式 --force。
// --upgrade-css: 不生成任何文件, 只把已有项目 tokens.css 里的 tokens 受管区(技能生成的整段主体:
//   主题令牌 / --fs-* / fx 关键帧与工具类 / .fx-stagger, 三个工具箱子块嵌在其中)更新到技能当前版本
//   —— 按内容 rev 原地替换, 幂等可重复跑, 写前备份 tokens.css.bak。区外规则**按条判定**: 逐字来自
//   模块原文的旧副本会被清掉(它们按层叠会压过受管区), 你自己的规则(含文件尾的覆写)保留不动。
// --check-css: 只检查不修改 —— 受管区落后/缺失/重复/定界符被改坏/区外残留副本时逐项报出并以退出码 1 结束。
import fs from 'node:fs';
import path from 'node:path';
import { KIT_REV, TOKENS_ID, wrapTokens, applyKitUpgrade, kitStatuses, MAX_SCAN_BYTES } from './css-kit.mjs';
import { generateTokensCss, TOKENS_REV } from './tokens-template.mjs';
import { VALUE_FLAGS, flagValue, positionalDir, safeOut } from './tools.mjs';

const argv = process.argv.slice(2);
const hasPositional = argv.some((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
const dirArg = hasPositional ? positionalDir(argv, { dflt: '' }) : '';
if (!dirArg) {
  console.error('用法: node init-project.mjs <项目目录> [--topic "主题名"] [--force] [--upgrade-css] [--check-css]');
  process.exit(1);
}
// --topic 是取值型 flag: 取它的值时不能把值本身当位置参数(否则会在 cwd 下静默建出以主题命名的骨架)
const topic = flagValue(argv, '--topic', '');
// topic 会插进模板 HTML 的 .brand 角标, 插入点单独转义(script.json / notes.md 用原文, 不转义)
const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const topicHtml = escapeHtml(topic);
const dir = path.resolve(dirArg);


const TEMPLATE_HTML = `<!doctype html>
<!-- 版式示例: statement · 复制改内容, 其他版式片段见 references/authoring.md -->
<html lang="zh-CN" data-theme="a">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="tokens.css">
<style>
  .layout { position: absolute; inset: 0; display: flex; flex-direction: column;
    justify-content: safe center; padding: 120px 160px 190px; gap: var(--sp-6); }
  .layout h1 { font-family: var(--font-display); font-size: var(--fs-display);
    font-weight: 700; line-height: 1.18; max-width: 1400px; }
  .layout .sub { font-size: var(--fs-h3); color: var(--muted); max-width: 1200px; }
  .layout figure { margin-top: var(--sp-4); }
</style>
</head>
<body>
<div class="stage">
  <span class="brand">A · ${topicHtml || '主题名'}</span>
  <main class="layout">
    <p class="kicker fx-fade" data-stage="1">SECTION · 小节名</p>
    <h1 class="fx-up" data-stage="1">一句话断言,<span class="accent">关键词</span>点亮。</h1>
    <p class="fx-fade" data-stage="2">一两句展开: 补充语境或给出解释, 别只有标题。</p>
    <figure class="fx-grow" data-stage="3">
      <!-- 视觉锚点: 数据卡 / 图片(.img-frame) / 引语块, 见 authoring.md -->
      <div class="card" style="display:inline-block;">
        <div class="gradient-text" style="font-family:var(--font-display); font-size:var(--fs-h1);">9亿</div>
        <div style="font-size:var(--fs-caption); color:var(--muted);">周活跃用户</div>
      </div>
    </figure>
  </main>
  <span class="slide-num">02 / 08</span>
</div>
</body>
</html>
`;

const scriptJson = {
  _readme: 'html2video-for-mcode 脚本契约。clauses 每个元素=一句口播; stage=这句开口时该入场的视觉层(1/2/3); 可选 text2=双语字幕第二行。tail=收尾留白秒数(默认0.8)。改口播必须过 Gate 1, 之后从 Phase 2 重跑。可选顶层 bgm: "assets/bgm.mp3" 或 {file,volume:0.12,fadeIn:1.5,fadeOut:2.5}。width/height 决定画布: 1920×1080 横屏 / 1080×1920 竖屏。lang 决定口播语种与音色: zh(默认)/en/yue/其他 BCP-47 — 语种必须与音色匹配, 且影响语速基准与字幕行宽校验。speed=试听时与用户定的语速(Gate 4 可复核); transition=切页方式: cut 硬切(默认, 段间不经过黑场) 或 {type:"xfade",duration:0.4} 交叉溶解。',
  topic,
  lang: "zh",
  voice: 'Chinese (Mandarin)_Gentleman',
  speed: { default: 1.1, first: 1.05, last: 1.05 },
  transition: { type: 'cut' },
  fps: 30, width: 1920, height: 1080,
  slides: [
    { id: '01', layout: 'title-hero', html: '01-title.html', audio: '01.mp3', title: '', clauses: [{ stage: 1, text: '' }] },
    { id: '02', layout: 'statement', html: '02-statement.html', audio: '02.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '03', layout: 'bullets', html: '03-bullets.html', audio: '03.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '04', layout: 'compare', html: '04-compare.html', audio: '04.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '05', layout: 'data-viz', html: '05-data.html', audio: '05.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '06', layout: 'code', html: '06-code.html', audio: '06.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '07', layout: 'quote', html: '07-quote.html', audio: '07.mp3', title: '', clauses: [{ stage: 1, text: '' }, { stage: 2, text: '' }] },
    { id: '08', layout: 'closing', html: '08-closing.html', audio: '08.mp3', title: '', clauses: [{ stage: 1, text: '' }] },
  ],
};

// 覆盖保护(必须在建目录之前检查, 否则会把自建的空子目录当成"非空"): 目标目录已存在且
// 非空 → 拒绝。init 会重置 script.json / notes.md 等 5 个文件, 误跑到已开工的项目上会毁掉
// 全部进度, 所以必须显式 --force。
const FORCE = argv.includes('--force');
const GENERATED = ['script.json', 'slides/tokens.css', 'slides/_template.html', 'assets/MANIFEST.md', 'research/notes.md'];

// --upgrade-css / --check-css: 只管 tokens.css 里三个工具箱受管块的新旧, 不生成/不重置任何文件。
// 老项目缺 no-fx 规则时 <html class="no-fx"> 会静默失效(只关动画不把 opacity 抬回来, 页面反而空白);
// 缺图表/表格工具箱时新配方会静默半死(条形不生长 / 环形不扫出 / 数字不滚动)。
// 判定按内容 rev(见 css-kit.mjs), 不再是"文件里出现过标记字符串就算有" —— 那种判定在项目补过
// 一次后就永远报"无需升级", 源头后续改动再也传不下去(2026-09-18 排查定案的根因)。
if (argv.includes('--upgrade-css') || argv.includes('--check-css')) {
  // 落盘收监(与 capture/build-video 同一道): slides/ 这一段**本身**可能是指向项目外的符号链接,
  // 那样 tokens.css(以及 .bak)就会写到项目外, 而命令照报成功(2026-09-18 复查 B4)
  const cssPath = safeOut(dir, 'slides', 'tokens.css');
  if (!fs.existsSync(cssPath)) { console.error(`✗ 找不到 ${cssPath}`); process.exit(1); }
  const css = fs.readFileSync(cssPath, 'utf8');
  if (css.length > MAX_SCAN_BYTES) { console.error(`✗ tokens.css 有 ${Math.round(css.length / 1e4) / 100}MB, 超过 ${MAX_SCAN_BYTES / 1e6}MB 上限拒绝扫描(正常项目 ≈15KB; 构造的超大输入会让受管块定位二次方变慢)`); process.exit(1); }

  if (argv.includes('--check-css')) {
    const st = kitStatuses(css, { expected: { text: generateTokensCss(), rev: TOKENS_REV } });
    const bad = st.filter(s => s.status !== 'ok');
    if (!bad.length) {
      console.log(`✓ tokens.css 已是最新(tokens rev ${TOKENS_REV.slice(0, 8)} / kit rev ${KIT_REV.slice(0, 8)})`);
      // ok 但带说明的项也打出来: "老格式(裸文本)"、"区外有你自己的覆写"这类信息不影响渲染,
      // 但决定了下次升级会不会动你的文件; 藏起来只会让人以为工具没看这块(2026-09-18 复查)。
      for (const s of st.filter(x => x.detail)) console.log(`  提示 ${s.label}: ${s.detail}`);
      process.exit(0);
    }
    for (const s of bad) console.error(`✗ ${s.label}: [${s.status}] ${s.detail}`);
    console.error('  → node scripts/init-project.mjs <项目目录> --upgrade-css(原地替换受管区, 不动区外的规则)');
    process.exit(1);
  }

  const { css: next, actions, normalizedLineEndings } = applyKitUpgrade(css, { tokensText: generateTokensCss(), tokensRev: TOKENS_REV });
  if (!actions.length) { console.log(`无需升级: ${cssPath} 已是最新(tokens rev ${TOKENS_REV.slice(0, 8)})`); process.exit(0); }
  const bakPath = safeOut(dir, 'slides', 'tokens.css.bak');   // .bak 也要收监: 它是同一个目录段下的叶子文件
  if (fs.existsSync(bakPath)) console.warn('⚠ 已存在 tokens.css.bak, 将被本次升级前的备份覆盖(旧备份会丢, 需要留就先改名)');
  fs.writeFileSync(bakPath, css);   // 覆盖前备份: 升级只应动受管块, 万一不对可整文件回退
  fs.writeFileSync(cssPath, next);
  for (const a of actions) console.log(`✓ ${a.label}: ${a.reason}`);
  if (normalizedLineEndings) console.log('  行尾已统一为 LF(与 rev 哈希同一标准; CSS 语义不变)');
  console.log(`  备份 → ${cssPath}.bak;受管块之外的内容(含你的覆写)未动`);
  // 升级只改 tokens.css —— 已渲染产物里还是旧 CSS 的画面, 必须点名要重跑什么(流程审计 P3)
  console.log('  ⚠ 已生成的 preview/*.png 与 build/frames 仍是旧 CSS 画面: 受影响张重跑 capture(--mode still + --mode motion), 放映页重跑 preview-page.mjs, 再 build-video');
  process.exit(0);
}

if (fs.existsSync(dir)) {
  const existing = fs.readdirSync(dir).filter(e => !GENERATED.includes(e));
  const wouldOverwrite = GENERATED.filter(f => fs.existsSync(path.join(dir, f)));
  if ((existing.length || wouldOverwrite.length) && !FORCE) {
    console.error(`✗ 目标目录已存在且非空: ${dir}\n  init 会重置这些文件(其余不动): ${GENERATED.join(' · ')}`);
    if (wouldOverwrite.length) console.error(`  其中已存在、将被覆盖的: ${wouldOverwrite.join(' · ')}`);
    console.error('  确认要重新初始化请加 --force');
    process.exit(1);
  }
  if (FORCE && wouldOverwrite.length) console.warn(`⚠ --force: 将覆盖 ${wouldOverwrite.length} 个生成文件(其余内容不动): ${wouldOverwrite.join(' · ')}`);
}

// 先把项目根建出来(它就是本次要创建的东西), 之后的每个派生写点才有一个"真实存在"的根可比对:
// safeOut 比对的是"最深已存在祖先的 realpath 是否仍在根内", 根不存在时会拿父目录去比 → 全部误判越界。
// 有了根之后, 骨架写点与 --upgrade-css 走同一道收监: --force 重建一个 slides 是指向项目外的
// junction 的目录时, 不会再把生成物写到项目外(2026-09-18 复查: 这条此前只有升级路径收监了)。
fs.mkdirSync(dir, { recursive: true });
for (const d of ['research', 'assets', 'slides', 'audio', 'preview', 'out', 'build', 'asr']) {
  fs.mkdirSync(safeOut(dir, d), { recursive: true });
}
fs.writeFileSync(safeOut(dir, 'slides', 'tokens.css'),
  '/* 生成物: 下面的 tokens 受管区由 init-project.mjs 生成, 升级走 --upgrade-css 原地替换;\n' +
  '   你自己的规则写到受管区之外(文件末尾), 升级不会碰 */\n' +
  wrapTokens(generateTokensCss(), TOKENS_REV) + '\n');
fs.writeFileSync(safeOut(dir, 'slides', '_template.html'), TEMPLATE_HTML);
fs.writeFileSync(safeOut(dir, 'script.json'), JSON.stringify(scriptJson, null, 2) + '\n');
fs.writeFileSync(safeOut(dir, 'assets', 'MANIFEST.md'),
  `# 素材清单\n\n| 文件 | 内容 | 来源 | 许可 |\n|---|---|---|---|\n\n<!-- 每个素材一行; 来源必须可核查。禁止使用凭空生成的 logo/截图/头像。选图 SOP 见 references/image-sources.md -->\n`);
fs.writeFileSync(safeOut(dir, 'research', 'notes.md'),
  `# 调研笔记${topic ? ` · ${topic}` : ''}\n\n## 核心事实\n<!-- 硬规则(见 references/research.md): 关键数字≥2 个独立来源; 一手优先; 标注口径与日期; 查不到出处的不进脚本 -->\n| 事实 | 数值/表述 | 来源(URL/文档) | 口径日期 | 等级(一手/二手/弱) | 第二来源 |\n|---|---|---|---|---|---|\n\n## 不确定项(不进脚本)\n\n## 不该进脚本的内容(传闻/争议/无法核实)\n\n`);

console.log(`已生成项目骨架: ${dir}`);
console.log(`
下一步:
1. 填 research/notes.md(事实性题材必须先搜集, 过 Gate 0)
2. 逐张填 script.json 的 clauses(内容量规则见 references/authoring.md, 过 Gate 1)
3. 做 TTS 到 audio/<id>.mp3, 然后:
   node scripts/plan-timings.mjs "${dir.replace(/\\/g, '/')}"
4. 每张 HTML 参照 slides/_template.html 写到 slides/(主题见 tokens.css 顶部注释), 然后:
   node scripts/check-theme.mjs "${dir.replace(/\\/g, '/')}"            # 主题对比度校验
   node scripts/capture.mjs "${dir.replace(/\\/g, '/')}" --mode still    # Gate 4 终态预览
   node scripts/capture.mjs "${dir.replace(/\\/g, '/')}" --mode motion   # 动画帧
   node scripts/build-video.mjs "${dir.replace(/\\/g, '/')}" --asr`);
