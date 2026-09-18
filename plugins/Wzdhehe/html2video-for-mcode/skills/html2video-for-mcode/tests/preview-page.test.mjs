// 放映页(preview-page): 快照时序注入 + no-fx 兜底 + 自包含 + 路径收监
// 这是"用户自己在浏览器里先放映一遍"的交付物, 也是"元素永久不可见"那类静默故障的目视闸门。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, mkproj, tmpdir, SCRIPTS } from './helpers.mjs';

const mod = await import('file://' + path.join(SCRIPTS, 'preview-page.mjs').replace(/\\/g, '/'));
const { stageVars, injectHtmlVars, addNoFx, addBaseHref, injectStyle, buildPlayPage, stagesFromHtml, fallbackStages } = mod;
const { NOFX_CSS } = await import('file://' + path.join(SCRIPTS, 'nofx-css.mjs').replace(/\\/g, '/'));
const { CHART_CSS } = await import('file://' + path.join(SCRIPTS, 'chart-css.mjs').replace(/\\/g, '/'));
const { TABLE_CSS } = await import('file://' + path.join(SCRIPTS, 'table-css.mjs').replace(/\\/g, '/'));

const SLIDE = `<!doctype html>
<html lang="zh-CN" data-theme="a">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="tokens.css">
</head>
<body><div class="stage"><p class="fx-up" data-stage="1">文案</p><p class="fx-fade" data-stage="2">展开</p></div></body>
</html>
`;

describe('预览放映页 · 纯函数', () => {
  test('stageVars: 秒 → 整数毫秒, 负数归零, 非数值跳过', () => {
    assert.equal(stageVars({ 1: 0, 2: 4.8655 }, { w: 1920, h: 1080 }),
      '--t1:0ms;--t2:4866ms;--stage-w:1920px;--stage-h:1080px');
    assert.equal(stageVars({ 2: -3 }, {}), '--t2:0ms');
    assert.equal(stageVars({ 2: 'x' }, {}), '');
  });

  test('injectHtmlVars: 写进 <html> 的 style(等价 capture 的 documentElement 注入)', () => {
    const out = injectHtmlVars(SLIDE, '--t2:4866ms');
    assert.match(out, /<html lang="zh-CN" data-theme="a" style="--t2:4866ms">/);
    assert.ok(out.includes('<link rel="stylesheet" href="tokens.css">'), '正文不得被改动');
  });

  test('injectHtmlVars: 已有 style 时合并而不是覆盖', () => {
    const html = '<html style="color:red">';
    assert.equal(injectHtmlVars(html, '--t1:0ms'), '<html style="color:red;--t1:0ms">');
  });

  test('addNoFx: 无 class 时新增, 有 class 时追加, 重复调用不叠加', () => {
    assert.match(addNoFx(SLIDE), /<html lang="zh-CN" data-theme="a" class="no-fx">/);
    const once = addNoFx('<html class="deck">');
    assert.equal(once, '<html class="deck no-fx">');
    assert.equal(addNoFx(once), once);
  });

  test('addBaseHref: 插在 <head> 之后、link 之前(base 必须早于相对 URL)', () => {
    const out = addBaseHref(SLIDE, '../../slides/');
    assert.ok(out.indexOf('<base href="../../slides/">') < out.indexOf('href="tokens.css"'), 'base 必须排在相对链接前面');
  });

  test('injectStyle: 插到 </head> 前(tokens.css 之后, 后写覆盖)', () => {
    const out = injectStyle(SLIDE, '.no-fx [data-stage]{opacity:1 !important}');
    assert.ok(out.indexOf('tokens.css') < out.indexOf('.no-fx [data-stage]'));
    assert.ok(out.indexOf('.no-fx [data-stage]') < out.indexOf('</head>'));
  });

  test('buildPlayPage: 自包含(无外链/无外站脚本)且含全部张次', () => {
    const page = buildPlayPage({
      topic: 'T', slides: [
        { id: '01', name: '01.html', copy: '01.html', copyNofx: '01.nofx.html', clauses: [{ stage: 1, text: '甲' }] },
        { id: '02', name: '02.html', copy: '02.html', copyNofx: '02.nofx.html', clauses: [] },
      ], cssNote: '注意 X',
    });
    assert.ok(!/https?:/.test(page), '不得引用任何外部 URL(离线双击可用)');
    assert.ok(!/<script[^>]+src=/i.test(page), '不得外链脚本');
    assert.ok(page.indexOf('01.html') < page.indexOf('02.html'), '张次顺序保持');
    assert.ok(page.includes('01.nofx.html'), '关动效副本要在模型里');
    assert.ok(page.includes('注意 X'), 'tokens.css 落后时应把提示带给用户');
  });

  test('buildPlayPage: 不做播放器那套 UI(没有计时器/进度条/常驻动画循环)', () => {
    const page = buildPlayPage({ topic: 'T', slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [] }] });
    assert.ok(!page.includes('id="clock"'), '不要走秒的计时器');
    assert.ok(!page.includes('id="bar"'), '不要时间轴进度条');
    assert.ok(!page.includes('setInterval'), '不要常驻定时循环');
    assert.ok(!/requestAnimationFrame\((loop|tick|frame)/.test(page), '不要常驻 rAF 动画循环 —— 双缓冲换帧的一次性 rAF 等帧不算');
    assert.ok(!/配音/.test(page), '页面不得出现"配音"字样 —— 此前把"关动效对照"写成"关配音画对比", 让人以为在管音频');
  });

  test('buildPlayPage: 随窗口自适应(视口栏 / dvh / 窄屏媒体查询 / 触屏滑动)', () => {
    const page = buildPlayPage({ topic: 'T', slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [] }] });
    assert.match(page, /name="viewport"[^>]*width=device-width/, '手机需要视口声明');
    assert.ok(page.includes('100dvh'), '用动态视口高度, 免得手机上被地址栏切掉');
    assert.match(page, /@media \(max-width:860px\)/, '窄窗口要有独立布局(面板收到底部)');
    assert.ok(page.includes('(pointer:coarse)'), '触屏要有触摸条而不是键盘提示');
    assert.match(page, /class="kbd-hints"/, '键盘提示必须是类(内联样式会盖住媒体查询, 手机上就藏不掉)');
    assert.ok(!page.includes('style="display:flex'), '键盘提示不得用内联 display');
    assert.ok(page.includes('touchstart') && page.includes('touchend'), '触屏要能左右滑翻页');
  });

  test('buildPlayPage: 口播 UI 三态(有/未对时/不出)', () => {
    const withNarr = buildPlayPage({ topic: 'T', timing: true, slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [{ stage: 1, text: '甲' }] }] });
    assert.ok(withNarr.includes('id="panel"') && withNarr.includes('本张口播文案'));
    assert.ok(!withNarr.includes('(未对时)'));
    const noTiming = buildPlayPage({ topic: 'T', timing: false, slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [{ stage: 1, text: '甲' }] }] });
    assert.ok(noTiming.includes('本张口播文案(未对时)'), '没对时要说清楚');
    const off = buildPlayPage({ topic: 'T', narration: false, slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [] }] });
    assert.ok(!off.includes('id="panel"'), '没有口播内容就不该有面板');
    assert.match(off, /<body class="narr-off">/);
    assert.ok(!off.includes('data-act="narr"'), '触摸条也不该留口播按钮');
  });

  test('stagesFromHtml / fallbackStages: 没对时时按 HTML 里用到的 stage 等间隔排', () => {
    assert.deepEqual(stagesFromHtml(SLIDE), [1, 2]);
    assert.deepEqual(stagesFromHtml('<p data-stage="2"></p><p data-stage="2"></p>'), [2]);
    assert.deepEqual(fallbackStages(SLIDE), { 1: 0.3, 2: 1.3 });
    assert.deepEqual(fallbackStages('<p data-stage="3"></p>'), { 3: 0.3 });
    assert.deepEqual(fallbackStages('<p>无 stage</p>'), {});
  });
});

describe('预览放映页 · 落到磁盘', () => {
  const build = (proj, { tokens, timings } = {}) => {
    mkproj(proj, {
      slides: [{ id: '01', layout: 'statement', html: '01-title.html', audio: '01.mp3', title: '开场', clauses: [{ stage: 1, text: '第一句。' }, { stage: 2, text: '第二句。' }] }],
      ...(tokens ? { tokens } : {}),
    });
    fs.writeFileSync(path.join(proj, 'slides', '01-title.html'), SLIDE);
    if (timings) {
      fs.writeFileSync(path.join(proj, 'build', 'timings.json'), JSON.stringify({
        fps: 30, slides: [{ id: '01', duration: 6.3, stages: { 1: 0, 2: 4.8655 }, clauses: [{ stage: 1, start: 0, text: '第一句。' }, { stage: 2, start: 4.87, text: '第二句。' }] }],
      }));
    }
    return proj;
  };

  test('生成放映页 + 两份快照, 副本带真实时序', () => {
    const proj = build(tmpdir(), { timings: true });
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(proj, 'preview', 'play');
    for (const f of ['index.html', '01-title.html', '01-title.nofx.html']) assert.ok(fs.existsSync(path.join(out, f)), `缺 ${f}`);
    const copy = fs.readFileSync(path.join(out, '01-title.html'), 'utf8');
    assert.ok(copy.includes('style="--t1:0ms;--t2:4866ms;'), '注入实测延迟(tokens.css 占位值是 800ms)');
    assert.ok(copy.includes('<base href="../../slides/">'));
    assert.ok(copy.includes('请勿编辑'), '副本要标明是快照');
    assert.ok(fs.readFileSync(path.join(proj, 'slides', '01-title.html'), 'utf8').includes('data-theme="a"'), '原文件不得被改写');
    assert.ok(r.stdout.includes('4866') || r.stdout.includes('末层'), '应打印注入结果');
  });

  test('老项目 tokens.css 落后 → 副本兜底注入当前版并如实警告', () => {
    const proj = build(tmpdir(), { timings: true });
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(proj, 'preview', 'play');
    const nofx = fs.readFileSync(path.join(out, '01-title.nofx.html'), 'utf8');
    const copy = fs.readFileSync(path.join(out, '01-title.html'), 'utf8');
    assert.ok(/class="[^"]*no-fx/.test(nofx), '副本根元素要带 no-fx');
    assert.ok(nofx.includes('opacity: 1 !important'), '旧 tokens.css 下必须兜底注入 opacity 重置, 否则对照是空白');
    assert.ok(!copy.includes('no-fx 规则'), '动效副本不得注入 no-fx 规则(它只在关动效副本里有意义)');
    assert.ok(copy.includes('图表工具箱'), '图表工具箱落后时动效副本也要兜底(否则旧规则把新版画法渲染坏)');
    assert.ok(r.stderr.includes('no-fx'), '应在终端说明 tokens.css 落后');
  });

  test('新 tokens.css(三段工具箱都当前) → 不注入, 保持纯快照', () => {
    const tokens = `:root{--accent:#111}\n${NOFX_CSS}\n${CHART_CSS}\n${TABLE_CSS}\n`;
    const proj = build(tmpdir(), { tokens, timings: true });
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    const outDir = path.join(proj, 'preview', 'play');
    assert.ok(!fs.readFileSync(path.join(outDir, '01-title.nofx.html'), 'utf8').includes('兜底注入'));
    assert.ok(!fs.readFileSync(path.join(outDir, '01-title.html'), 'utf8').includes('兜底注入'));
    assert.ok(!r.stderr.includes('落后'));
  });

  test('没有 timings.json → 照常出页, 但明确警告时序不是成片的', () => {
    const proj = build(tmpdir());
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('timings.json'), '应提示先跑 plan-timings');
    const page = fs.readFileSync(path.join(proj, 'preview', 'play', 'index.html'), 'utf8');
    assert.ok(page.includes('等间隔'), '页面上要说清动画是按等间隔预览的');
    assert.ok(page.includes('未对时'), '口播标题要标未对时');
  });

  test('--no-script: 不加载口播 UI, 但时序提示照留(它讲的是画面)', () => {
    const proj = build(tmpdir());
    const r = runSkill('preview-page.mjs', [proj, '--no-script']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('关(--no-script)'));
    const page = fs.readFileSync(path.join(proj, 'preview', 'play', 'index.html'), 'utf8');
    assert.ok(!page.includes('id="panel"'));
    assert.ok(!page.includes('data-act="narr"'));
    assert.ok(page.includes('等间隔'), '口播关了, 动画时序的提示仍要有');
  });

  test('script.json 没有 clauses → 口播 UI 自动不加载', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', layout: 'statement', html: '01-title.html', audio: '01.mp3', clauses: [] }] });
    fs.writeFileSync(path.join(proj, 'slides', '01-title.html'), SLIDE);
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('本片没有 clauses'));
    assert.ok(!fs.readFileSync(path.join(proj, 'preview', 'play', 'index.html'), 'utf8').includes('id="panel"'));
  });

  test('slides[].html 越界 → 退出 1, 项目外不落任何文件', () => {
    const proj = build(tmpdir(), { timings: true });
    const outside = tmpdir();
    const canary = path.join(outside, 'canary.txt');
    fs.writeFileSync(canary, 'SAFE');
    const j = JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'));
    j.slides[0].html = '../../' + path.basename(outside) + '/pwn.html';
    fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify(j));
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 1, '越界必须被 safeRel 拦下');
    assert.equal(fs.readFileSync(canary, 'utf8'), 'SAFE');
    assert.ok(!fs.existsSync(path.join(outside, 'pwn.html')));
  });

  test('部分张还没写 → 跳过并警告, 其余照常出页(与 capture 的惯例一致)', () => {
    const proj = build(tmpdir(), { timings: true });
    const j = JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'));
    j.slides.push({ id: '02', layout: 'bullets', html: '02-bullets.html', audio: '02.mp3', clauses: [{ stage: 1, text: '还没写。' }] });
    fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify(j));
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('跳过 02'), '应点名跳过哪张');
    assert.ok(fs.existsSync(path.join(proj, 'preview', 'play', '01-title.html')), '已写的张照常出');
    assert.ok(!fs.existsSync(path.join(proj, 'preview', 'play', '02-bullets.html')));
  });

  test('一张可放映的都没有 → 退出 1', () => {
    const proj = build(tmpdir(), { timings: true });
    fs.rmSync(path.join(proj, 'slides', '01-title.html'));
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('可放映'));
  });

  test('缺 script.json → 退出 1', () => {
    const r = runSkill('preview-page.mjs', [tmpdir()]);
    assert.equal(r.status, 1);
  });
});

describe('预览放映页 · 竖版画布与 iframe 安全(2026-09-18 流程/安全审计补)', () => {
  const SLIDES_ARG = [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [] }];

  test('buildPlayPage: 画布参数化 — 竖版尺寸/缩放除数/缩略图比例都按 1080×1920', () => {
    const page = buildPlayPage({ topic: 'T', canvas: { w: 1080, h: 1920 }, slides: SLIDES_ARG.map(s => ({ ...s })) });
    assert.ok(page.includes('width:1080px;height:1920px'), '舞台与 iframe 要用竖版尺寸');
    assert.ok(page.includes('r.width / 1080, r.height / 1920'), '缩放除数要按竖版算');
    assert.ok(page.includes('aspect-ratio:1080/1920'), '总览缩略图比例要跟画布');
    assert.ok(!page.includes('aspect-ratio:16/9'), '不得残留横屏写死比例');
  });

  test('iframe src 一律加 ./ 前缀: javascript: 文件名不会被当 scheme 在放映页同源执行', () => {
    const page = buildPlayPage({ topic: 'T', slides: SLIDES_ARG.map(s => ({ ...s })) });
    assert.match(page, /src\s*=\s*'\.\/'\s*\+\s*src/, '必须强制相对解析(赋值统一走 ./ + src 变量)');
  });

  test('竖版项目落盘: script.json 1080×1920 → index.html 用竖版画布', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', layout: 'statement', html: '01-title.html', audio: '01.mp3', title: '竖版', clauses: [{ stage: 1, text: '一句。' }] }] });
    const j = JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'));
    j.width = 1080; j.height = 1920;
    fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify(j));
    fs.writeFileSync(path.join(proj, 'slides', '01-title.html'), SLIDE);
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    const page = fs.readFileSync(path.join(proj, 'preview', 'play', 'index.html'), 'utf8');
    assert.ok(page.includes('width:1080px;height:1920px'), '放映页要按竖版渲染, 否则 Gate 4 画面被切掉近半');
  });
});

describe('预览放映页 · 逐级步进(动效开)+ 无重播(2026-09-18 实测反馈)', () => {
  const ARG = [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [], steps: [1, 2] }];

  test('开关移到底栏且写明状态(动效开/关 · 口播开/关), 顶部不再有动效开关;重播已移除', () => {
    const page = buildPlayPage({ topic: 'T', slides: ARG.map(s => ({ ...s })) });
    assert.ok(!page.includes('id="mode"'), '顶部动效开关要移掉(实测反馈: 与底栏开关重复)');
    assert.match(page, /data-act="nofx"[^>]*id="fxbtn"[^>]*>动效开</, '底栏动效开关, 默认态写"动效开"');
    assert.match(page, /data-act="narr"[^>]*id="narrbtn"[^>]*>口播开</, '底栏口播开关, 默认态写"口播开"');
    assert.ok(page.includes('paintToggles'), '开关文案要随状态重绘(动效关/口播关)');
    assert.ok(!page.includes('data-act="replay"'), '不得再有重播按钮');
    assert.ok(!/<kbd>R<\/kbd>/.test(page), '不得再有 R 键提示');
    assert.ok(page.includes('逐级入场 / 翻页'), '键盘提示要说明逐级行为');
    assert.match(page, /#touchbar button\[data-act="prev"\]/, '前后箭头要有加大样式');
    const noNarr = buildPlayPage({ topic: 'T', narration: false, slides: ARG.map(s => ({ ...s })) });
    assert.ok(!noNarr.includes('id="narrbtn"'), '没有口播 UI 就不该有口播开关');
  });

  test('UI 双语: lang=en → 整套英文文案, 页面不残留中文 UI 字样(2026-09-18 实测反馈)', () => {
    const en = buildPlayPage({ topic: 'T', lang: 'en', slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [{ stage: 1, text: 'Hi' }], steps: [1, 2] }] });
    assert.match(en, /<html lang="en">/);
    assert.match(en, /id="fxbtn"[^>]*>Motion on</, '动效开关英文');
    assert.match(en, /id="narrbtn"[^>]*>Narration on</, '口播开关英文');
    assert.ok(en.includes('Narration for this slide'), '口播面板标题英文');
    assert.ok(en.includes('>Overview<'), '总览按钮英文');
    assert.ok(en.includes('No thumbnail (preview/'), '缩略图缺失占位英文');
    assert.ok(en.includes('reveal level / slide'), '键盘提示英文(断言可见文本; 代码注释里的中文不算)');
    assert.ok(!en.includes('>动效开<') && !en.includes('>口播开<'), '按钮不得残留中文');
    assert.ok(!en.includes('本张口播文案') && !en.includes('快照生成于') && !en.includes('无缩略图'), '面板/页脚/占位不得残留中文');
    const zh = buildPlayPage({ topic: 'T', lang: 'zh', slides: [{ id: '01', name: 'a.html', copy: 'a.html', copyNofx: 'a.nofx.html', clauses: [{ stage: 1, text: '甲' }] }] });
    assert.ok(zh.includes('>动效开</button>') && zh.includes('>口播开</button>'), '中文默认不变');
  });

  test('双缓冲换帧: 两张叠放 iframe, load 后等两帧 rAF 才对调 —— 单 iframe 改 src 换页会闪白(实测反馈)', () => {
    const page = buildPlayPage({ topic: 'T', slides: ARG.map(s => ({ ...s })) });
    assert.ok(page.includes('id="frame"') && page.includes('id="frameB"'), '要有一前一后两张 iframe');
    assert.match(page, /#fit iframe\{[^}]*position:absolute/, '两张 iframe 必须叠放, 隐藏帧加载完再显示');
    assert.match(page, /#fit iframe\.show\{opacity:1\}/, '默认 opacity:0, 显示态由 .show 控制');
    assert.ok(page.includes("back.addEventListener('load'"), '新帧要等 load 事件(文档就绪)才换');
    assert.match(page, /raf\(function\(\)\{ raf\(function\(\)\{ if \(g === gen\)/, 'load 后还要等两帧 rAF(新文档首帧已画)才对调, 否则仍会闪');
    assert.match(page, /src\s*=\s*'\.\/'\s*\+\s*src/, "换帧也必须走 './' + src 强制相对解析(javascript: 文件名不得当 scheme 执行)");
  });

  test('多级张的模型带 steps, 快照副本头部带步进脚本(?s=k 重设各级延迟)', () => {
    const page = buildPlayPage({ topic: 'T', slides: ARG.map(s => ({ ...s })) });
    assert.ok(page.includes('"steps":[1,2]'), '模型要带逐级序列');
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', layout: 'statement', html: '01-title.html', audio: '01.mp3', clauses: [{ stage: 1, text: '第一句。' }, { stage: 2, text: '第二句。' }] }] });
    fs.writeFileSync(path.join(proj, 'slides', '01-title.html'), SLIDE);   // SLIDE 用了 stage 1/2
    const r = runSkill('preview-page.mjs', [proj]);
    assert.equal(r.status, 0, r.stderr);
    const copy = fs.readFileSync(path.join(proj, 'preview', 'play', '01-title.html'), 'utf8');
    assert.ok(copy.includes('逐级步进'), '副本要带步进脚本说明');
    assert.ok(/var used=\[1,2\]/.test(copy), '步进脚本要写入该张用到的 stage 序列');
    assert.ok(copy.indexOf('逐级步进') < copy.indexOf('tokens.css'), '脚本必须在样式表之前(动画启动前执行)');
    assert.ok(fs.readFileSync(path.join(proj, 'preview', 'play', 'index.html'), 'utf8').includes('"steps":[1,2]'));
  });

  test('行为级: ?s=1 隐藏二级 · ?s=2&anim=1 当场入场 · 回退不重播(需 Playwright,缺则 skip)', async t => {
    const { loadPackage } = await import('file://' + path.join(SCRIPTS, 'tools.mjs').replace(/\\/g, '/'));
    const playwright = await loadPackage('playwright');
    if (!playwright) return t.skip('无 playwright');
    let browser;
    try { browser = await playwright.chromium.launch({ headless: true }); }
    catch { return t.skip('chromium 未安装'); }
    try {
      // 必须用 init-project 的完整 tokens(fx 类/[data-stage] 基础态都在里面);
      // mkproj 的极简 tokens 没有这些规则, 元素根本不参与动画 —— 首版就错在这里
      const proj = tmpdir();
      assert.equal(runSkill('init-project.mjs', [proj, '--topic', 'T']).status, 0);
      fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify({ topic: 't', fps: 30, width: 1920, height: 1080, slides: [{ id: '01', layout: 'statement', html: '01-title.html', audio: '01.mp3', clauses: [{ stage: 1, text: '一。' }, { stage: 2, text: '二。' }] }] }, null, 2));
      fs.writeFileSync(path.join(proj, 'slides', '01-title.html'), SLIDE);
      assert.equal(runSkill('preview-page.mjs', [proj]).status, 0);
      const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const url = s => 'file:///' + path.join(proj, 'preview', 'play', '01-title.html').replace(/\\/g, '/') + s;
      const op = sel => p.evaluate(x => { const e = document.querySelector(x); return e ? getComputedStyle(e).opacity : null; }, sel);
      await p.goto(url('?s=1&anim=1')); await p.waitForTimeout(1500);
      assert.equal(await op('[data-stage="1"]'), '1', '第 1 级可见');
      assert.equal(await op('[data-stage="2"]'), '0', '第 2 级必须还在等(不能自己出来)');
      await p.goto(url('?s=2&anim=1')); await p.waitForTimeout(1200);
      assert.equal(await op('[data-stage="2"]'), '1', '按下一步后第 2 级当场入场');
      await p.goto(url('?s=2')); await p.waitForTimeout(250);
      assert.equal(await op('[data-stage="2"]'), '1', '回退/跳转态直接终态, 不用等动画');
      await p.goto(url('?s=1&anim=1')); await p.waitForTimeout(250);
      assert.equal(await op('[data-stage="2"]'), '0', '回到 ?s=1 二级重新隐藏');
    } finally {
      await browser.close();   // 断言失败也必须关掉浏览器, 否则事件循环挂着 node --test 永不退出(实测踩过)
    }
  });
});
