#!/usr/bin/env node
// html2video-for-mcode · 画面采集: HTML → 终态 PNG(still) / 逐帧 PNG 序列(motion)
// 用法: node capture.mjs <项目目录> [--mode still|motion] [--ids 01,03] [--dsf 1-4] [--no-subs] [--allow-stale-css]
// 依赖: 项目目录或其上层 node_modules 里有 playwright, 且已装 chromium。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flagValue, loadPackage, positionalDir, requireFreshCss, safeId, safeOut, safeRel, subPillCss, subScale, subtitleKeyframes, subtitleWindows, validateScriptPaths, validateTimingsIds } from './tools.mjs';
import { startVetoProxy } from './url-policy.mjs';

const argv = process.argv.slice(2);
const dir = positionalDir(argv);
// 参数先验后用: 写错的 --mode/--dsf 以前会一路带到 playwright(page.setViewportSize(scale=NaN) /
// 走错分支静默出静态图), 报错点离真正的原因很远 —— 这里是"离用户最近"的地方, 直接说清。
const mode = flagValue(argv, '--mode', 'still');
if (mode !== 'still' && mode !== 'motion') {
  console.error(`✗ --mode ${JSON.stringify(mode)} 非法: 只能是 still(终态图) 或 motion(逐帧序列)`);
  process.exit(1);
}
const DSF_RAW = flagValue(argv, '--dsf', '1');
const dsf = Number(DSF_RAW);
if (!Number.isInteger(dsf) || dsf < 1 || dsf > 4) {
  console.error(`✗ --dsf ${JSON.stringify(DSF_RAW)} 非法: 取 1–4 的整数(deviceScaleFactor, 2 = 2 倍图; 过大在 4K 画布上会爆内存)`);
  process.exit(1);
}
const SUBS = !argv.includes('--no-subs'); // 字幕默认烧录
const idsFilter = flagValue(argv, '--ids', '') ? flagValue(argv, '--ids', '').split(',').map(s => s.trim()) : null;

// 入口闸门: tokens.css 受管块落后就停 —— 旧 CSS 会照常出图, 全程不报错(见 tools.mjs 的说明)
requireFreshCss(dir, { who: 'capture', allowStale: argv.includes('--allow-stale-css') });

const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
validateScriptPaths(script, dir); // script.json 是 agent 可编辑文件: id/html 等派生路径先收监再使用
const timingsPath = path.join(dir, 'build', 'timings.json');
if (!fs.existsSync(timingsPath)) {
  console.error('✗ 缺 build/timings.json — 先运行 plan-timings.mjs');
  process.exit(1);
}
const timings = JSON.parse(fs.readFileSync(timingsPath, 'utf8'));
validateTimingsIds(timings);

// 画布值会进 playwright viewport(与 preview-page 的 CSS/JS、build-video 的 ffmpeg filter 同一信任级),
// 先验后用; 放在 playwright 加载之前 —— 无 playwright 的 CI 上这道门也测得到(第八轮复查 F3)
const cvW = Number(script.width ?? 1920), cvH = Number(script.height ?? 1080);
if (!Number.isInteger(cvW) || cvW < 16 || cvW > 16384 || !Number.isInteger(cvH) || cvH < 16 || cvH > 16384) {
  console.error(`✗ script.width/height 非法: ${JSON.stringify(script.width)} × ${JSON.stringify(script.height)} — 需要 16–16384 的整数(与 preview-page / build-video 同一道门)`);
  process.exit(1);
}

const slides = script.slides.filter(s => !idsFilter || idsFilter.includes(s.id));
const firstId = script.slides[0]?.id;   // 封面图取自成片第 1 段(与 --ids 无关)
if (!slides.length) { console.error('✗ 没有匹配的 slide'); process.exit(1); }
// 部分匹配不再静默少做(2026-09-28 Mavis 交接): --ids 里没命中的 id 点名告警 + 打印本次实际
// 生效列表。顺带覆盖 PowerShell 裸逗号列表吃前导零的形态(03,05 → 3,5 匹配不上零填充 id)。
if (idsFilter) {
  const hitIds = new Set(slides.map(s => s.id));
  const miss = idsFilter.filter(id => !hitIds.has(id));
  if (miss.length) console.warn(`⚠ --ids 里没有对应 slide 的 id, 已忽略: ${miss.join(', ')}(注意 PowerShell 裸写 03,05 会被当数字数组吃掉前导零 —— 加引号 --ids "03,05" 或逐个传)`);
  console.log(`本次处理: ${[...hitIds].join(', ')}`);
}

const playwright = await loadPackage('playwright', { projectDir: dir });
if (!playwright) {
  console.error('✗ 未找到 playwright(已按 项目目录 / 调用目录 / npm 全局 逐个找过)。在项目目录执行:\n  npm i playwright\n  npx playwright install chromium');
  process.exit(1);
}

// 等字体 + 图片就绪: 样式表 <link> load → 每个 @font-face load() → fonts.ready → 图片 → 2×rAF。8s 硬上限。
async function waitAssets(page) {
  await page.evaluate(() => new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, 8000);
    const raf = () => new Promise(r => requestAnimationFrame(() => r()));
    (async () => {
      try {
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
        await Promise.all(links.map(l => new Promise(r => {
          if (l.sheet) return r();
          l.addEventListener('load', r, { once: true });
          l.addEventListener('error', r, { once: true });
        })));
        await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));
        await document.fonts.ready;
        const imgs = [...document.images].filter(i => !i.complete);
        if (imgs.length) await Promise.race([
          Promise.all(imgs.map(i => new Promise(r => {
            i.addEventListener('load', r, { once: true });
            i.addEventListener('error', r, { once: true });
          }))),
          new Promise(r => setTimeout(r, 4000)),
        ]);
        await raf(); await raf();
      } catch { /* 尽力而为 */ }
      done();
    })();
  }));
}

// 渲染 Chromium 也进否决隧道(2026-09-28 第 23 轮收口): slide HTML 理论上本地生成、外链由
// check-slides 的 error 闸门拦 —— 但闸门不是连接期; 万一被绕过, 私网/元数据地址在这里被
// 建连期否决(公共外网照常可达, file:// 页不经代理)。
const veto = await startVetoProxy();
const browser = await playwright.chromium.launch({ headless: true, proxy: { server: `http://127.0.0.1:${veto.port}` } });
const context = await browser.newContext({
  viewport: { width: script.width ?? 1920, height: script.height ?? 1080 },
  deviceScaleFactor: dsf,
});
fs.mkdirSync(safeOut(dir, 'preview'), { recursive: true });

// ── 封面图(1.6.0): 第 1 张另出一张"标题全露、无字幕"的终态图 preview/cover.png ──
// 用途: build-video 把它内嵌为 attached_pic(文件管理器/播放器/多数 IM 的缩略图都读它),
// 并导出 out/cover.png 供平台手动上传;首段还用它做 0.25s 溶解过渡, 免得成片首帧是黑的。
async function captureCover(page, { sid, firstId }) {
  if (sid !== firstId) return false;
  await page.evaluate(() => {
    // 封面必须无字幕(平台自己会叠字): 显式写内联隐藏, 不依赖动画 —— captureSubStills 的
    // 钉死会把字幕动画整个撤掉, 靠 currentTime=0 藏字幕对已钉元素无效(2026-09-22 实测封面烙图)
    document.querySelectorAll('.kit-sub').forEach(el => { el.style.animation = 'none'; el.style.opacity = '0'; });
    document.getAnimations().forEach(a => {
      try { a.finish(); } catch { /* 无限氛围动画 finish 会抛, 忽略 */ }   // 基底走终态
    });
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: safeOut(dir, 'preview', 'cover.png') });
  return true;
}

// ── 字幕时间轴(二审 P1): 字幕是"全时长百分比动画", 而逐帧只覆盖动画窗, 其余靠 tpad 冻尾帧 ——
// 动画窗之后的字幕变化永远进不了画面(实测: SRT 第 4 句在 5.3s, 6.0s 的帧还显示第 2 句);
// 静态/no-fx 路径更是一帧都不带字幕(finish() 把字幕动画跳到 opacity:0)。
// 解法: 帧序列之外, 再为每个"帧覆盖不到的字幕窗口"截一张**终态基底 + 该句字幕**的静态图,
// 由 build-video 按窗口时长把它们拼在帧序列之后(清单见 build/substills/<id>.json)。
// 每张的字幕静帧都是**派生数据**: 重截该张时先整目录清掉, 否则旧句子会阴魂不散 ——
// `--no-subs`、删掉 clauses、句子变少时, 残留的 s<k>.png 会被 build-video 拼回成片
// (2026-09-18 复查实测: 只作废 build/frames 不够)。
function invalidateSubStills(sid) {
  fs.rmSync(safeOut(dir, 'build', 'substills', sid), { recursive: true, force: true });
  fs.rmSync(safeOut(dir, 'build', 'substills', sid + '.json'), { force: true });   // 清单一起清, 免得陈旧清单配新图
}

async function captureSubStills(page, { sid, t, framesCover }) {
  invalidateSubStills(sid);                       // 先清旧图; 本张若无需字幕, 清完即保持空
  if (!SUBS || !Array.isArray(t.clauses) || !t.clauses.length) return 0;
  const stills = [];
  for (let k = 0; k < t.clauses.length; k++) {
    const start = t.clauses[k].start;
    const end = t.clauses[k + 1]?.start ?? t.duration;
    const from = Math.max(start, framesCover);
    if (end - from <= 0.02) continue;                 // 这段已被帧序列覆盖(逐帧 seek 时字幕本身就是对的)
    await page.evaluate(({ k }) => {
      const subs = document.querySelectorAll('.kit-sub');
      // 每张截图共用同一页(逐句字幕图、封面、终态图之间): 每一轮都必须把**全部**字幕重新钉一遍 ——
      // 目标钉满亮、其余钉隐藏。不能只钉目标: 钉 = 停动画 + 写内联样式, 上一轮被钉过的元素已无
      // 动画可拨回 0, 内联样式会漏进后续截图(2026-09-22 实测: 下一张静帧里叠出上一句的深色底板补丁)。
      subs.forEach((el, j) => {
        el.style.animation = 'none';
        el.style.opacity = j === k ? '1' : '0';
      });
      document.getAnimations().forEach(a => {
        try { a.finish(); } catch { /* 无限氛围动画 finish 会抛, 忽略 */ }   // 基底一律终态
      });
    }, { k });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const out = safeOut(dir, 'build', 'substills', sid, `s${k}.png`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    stills.push({ k, start: from, end });
  }
  fs.mkdirSync(safeOut(dir, 'build', 'substills'), { recursive: true });
  fs.writeFileSync(safeOut(dir, 'build', 'substills', sid + '.json'),
    JSON.stringify({ fps: timings.fps ?? 30, duration: t.duration, framesCover, stills }, null, 2));
  return stills.length;
}

let done = 0;
for (const s of slides) {
  const sid = safeId(s.id); // 递归删帧目录/写 preview 都由 id 派生, 在源头再拦一次
  const htmlPath = safeRel(path.join(dir, 'slides'), s.html ?? `${sid}.html`, { where: `slides[${sid}].html` });
  if (!fs.existsSync(htmlPath)) { console.warn(`- 跳过 ${s.id}: 缺 ${htmlPath}`); continue; }
  const t = timings.slides.find(x => x.id === s.id);
  if (!t) { console.warn(`- 跳过 ${s.id}: timings 里无此张`); continue; }

  const page = await context.newPage();
  // 在页面任何样式生效前, 注入: 实测的 stage 延迟(--t1/--t2/--t3)、画布尺寸(--stage-w/h)、字幕缩放(--sub-scale)。
  // HTML/tokens.css 里只写占位默认值, 真值一律由管线给 —— 这样改 TTS 或改画布都不用动 HTML。
  await page.addInitScript(payload => {
    const apply = () => {
      const el = document.documentElement;
      if (!el) return;
      for (const [k, v] of Object.entries(payload.stages)) el.style.setProperty('--t' + k, `${Math.max(0, Math.round(v * 1000))}ms`);
      el.style.setProperty('--stage-w', payload.w + 'px');
      el.style.setProperty('--stage-h', payload.h + 'px');
      el.style.setProperty('--sub-scale', String(payload.subScale));
    };
    apply();
    document.addEventListener('DOMContentLoaded', apply, { once: true });
  }, {
    stages: t.stages ?? {},
    w: script.width ?? 1920,
    h: script.height ?? 1080,
    // 字幕字号随画布宽度缩放, 竖版 (1080 宽) 收窄到 0.75 下限保证可读
    subScale: subScale(script.width),   // 几何唯一来源 tools.subScale(clamp(W/1920, 0.75, 1.25))
  });

  // 字幕(默认开, --no-subs 关): 内容取自 timings.clauses(单一数据源, 不在 HTML 里重写),
  // 显示窗 = 该句开口 → 下句开口。做成百分比关键帧动画: 逐帧 seek 天然工作, still 模式 finish() 后自动隐藏。
  // 必须在 goto 之前 addInitScript 才会生效。
  if (SUBS && Array.isArray(t.clauses) && t.clauses.length) {
    // 胶囊样式整体来自 tools.subPillCss(单一来源): 含 width:max-content —— 没有它,
    // left:50% 的可用宽度只有画布一半, max-width 永远够不到, 字幕提前一半折行(Mavis A/B 实测)
    await page.addInitScript(({ clauses, durMs, css }) => {
      const mount = () => {
        const st = document.createElement('style');
        st.textContent = css;
        (document.head || document.documentElement).appendChild(st);
        const host = document.querySelector('.stage') || document.body;
        // 幂等: 若 mount 因任何原因被触发多次, 先清掉上一次的挂载, 避免字幕元素累积
        document.querySelectorAll('.kit-sub').forEach(el => el.remove());
        clauses.forEach((c, i) => {
          const d = document.createElement('div');
          d.className = 'kit-sub';
          d.style.animation = `kit-sub-${i} ${durMs}ms linear both`;
          const l1 = document.createElement('div');
          l1.textContent = c.text;
          d.appendChild(l1);
          if (c.text2) { // 双语第二行(可选): clause 里给 text2 即自动两行
            const l2 = document.createElement('div');
            l2.className = 'kit-sub-2';
            l2.textContent = c.text2;
            d.appendChild(l2);
          }
          host.appendChild(d);
        });
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
      else mount();
    }, { clauses: t.clauses, durMs: t.duration * 1000, css: subPillCss() + subtitleKeyframes(t.clauses, t.duration) });

    // 字幕窗口自检(与页面关键帧同一来源 tools.subtitleWindows): 任意时刻最多一条字幕可见。
    // 淡入/淡出都收在各自窗口内 —— 真正的重叠只有一种: 上一句窗口过短被 a+0.5 顶出(prevB > a)。
    // (2026-09-22 修: 旧判据拿"已是淡出终点"的 prevB 再叠一次淡出长度, 双重计数 → 恒真误报。)
    const wins = subtitleWindows(t.clauses, t.duration);
    for (let i = 0; i < wins.length; i++) {
      const { a, b, isLast } = wins[i];
      if (!isLast && b - a < 0.6) console.warn(`⚠ ${s.id}: 第 ${i + 1} 句字幕窗口仅 ${(t.duration * (b - a) / 100).toFixed(2)}s, 可能会一闪而过`);
      if (i > 0) {
        const prevB = wins[i - 1].b;
        if (prevB > a + 0.001) {
          console.warn(`⚠ ${s.id}: 第 ${i} 句与第 ${i + 1} 句字幕会同时可见(重叠 ${(t.duration * (prevB - a) / 100).toFixed(2)}s)`);
        }
      }
    }
  } else if (SUBS) {
    console.warn(`⚠ ${s.id}: 本张没有 clauses, 不会烧录字幕 —— 若这条片要有字幕, 回 Phase 2 重跑 plan-timings`);
  }

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded' });
  await waitAssets(page);

  // 图片兜底告警: waitAssets 是"尽力而为", 加载不动的图会让画面出 broken 图标却一路报成功。
  // 这里显式报出来(静态路径缺失查 check-slides.mjs; 这里覆盖"文件在但 SVG/图片本身坏了"的情况)。
  const brokenImgs = await page.evaluate(() =>
    [...document.images].filter(i => !i.complete || i.naturalWidth === 0).map(i => (i.getAttribute('src') || '').slice(0, 60)));
  if (brokenImgs.length) {
    console.warn(`⚠ ${s.id}: ${brokenImgs.length} 张图没渲染出来 → ${brokenImgs.slice(0, 3).join(' | ')}`);
    console.warn('   先跑 check-slides.mjs 定位; SVG 类资源建议 inline 进 HTML(依赖外部资源/XML 有误/缺 width-height 都会 broken)');
  }

  // 布局几何自检(2026-09-22 实测踩坑): 内容总高超过可用区时, 普通 flex center 把溢出推到画布
  // 上方之外裁掉(实测 kicker 被顶到 y≈17px、溢出 ≈125px, 而截图目检被当成"没渲染"放过)。
  // 静态文本查不出"内容太高", 这里实测并点名数字; 骨架 .layout 的 safe center + 上下 padding
  // (见 _template.html)让顶部永不被裁, 但溢出本身仍值得报。
  const geo = await page.evaluate(() => {
    const lay = document.querySelector('.layout') || document.querySelector('.stage');
    if (!lay) return null;
    const kids = [...lay.children].filter(el => {
      const st = getComputedStyle(el);
      return st.position !== 'absolute' && st.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    });
    return {
      scroll: lay.scrollHeight,
      client: lay.clientHeight,
      top: kids.length ? Math.min(...kids.map(el => el.getBoundingClientRect().top)) : null,
    };
  });
  if (geo && (geo.scroll > geo.client + 2 || (geo.top != null && geo.top < 24))) {
    const over = geo.scroll - geo.client;
    console.warn(`⚠ ${s.id}: 布局几何 — 内容总高 ${geo.scroll}px${over > 2 ? ` > 可用 ${geo.client}px(溢出 ≈${over}px, 普通 flex center 会把它推到画布上方裁掉)` : ''}${geo.top != null && geo.top < 24 ? `; 顶部元素被推到 y≈${Math.round(geo.top)}px(贴顶/被裁)` : ''} — 减内容/降字号/缩绘图区; 骨架 .layout 是 safe center + 上下 padding(见 _template.html), 别退回普通 center、也别用 margin-top 推内容(会加进内容总高)`);
  }

  // 帧目录是派生数据: 本次只要产出的是静态图(still 或 无动画), 旧 motion 帧一律作废,
  // 否则 build-video 会优先用残留帧, 把过时动画混进成片(切 no-fx 后重渲染时必踩)
  // safeOut: 输出侧也要防"项目内某段是符号链接"——rmSync(recursive) 会穿透符号链接删到项目外(二审 P1)
  const invalidateFrames = () => fs.rmSync(safeOut(dir, 'build', 'frames', sid), { recursive: true, force: true });

  if (mode === 'still') {
    // 直接跳到所有有限动画的终态(finish), 无限氛围动画保持运行, 截图即终态。
    await page.evaluate(() => {
      document.getAnimations().forEach(a => { try { a.finish(); } catch { /* infinite */ } });
      // 终态图是"无字幕基底"(build-video 拼在第一句开口前): 显式藏字幕 —— 依赖关键帧终值
      // 恰好为 0 太脆(1.9.4 的末句形状曾把最后一句烙进基底), 两端隐藏契约另有 unit 测试背书
      document.querySelectorAll('.kit-sub').forEach(el => { el.style.animation = 'none'; el.style.opacity = '0'; });
    });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: safeOut(dir, 'preview', `${sid}.png`) });
    // 静态路径没有帧序列 → 字幕窗口全部覆盖不到, 逐句出静态图交给 build-video 拼
    const nStill = await captureSubStills(page, { sid, t, framesCover: 0 });
    const cover = await captureCover(page, { sid, firstId });
    invalidateFrames();
    console.log(`✓ ${sid} 终态截图 → preview/${sid}.png${nStill ? ` + 字幕图 ${nStill} 张(静态路径, 由 build-video 拼时段)` : ''}${cover ? ' + 封面 preview/cover.png' : ''}`);
  } else {
    // 逐帧步进: 全部动画暂停在 0, 每帧统一 seek 到 t, 截图。CSS 动画自带 delay, seek 是绝对时间, 时序天然正确。
    await page.evaluate(() => {
      document.getAnimations().forEach(a => { try { a.pause(); a.currentTime = 0; } catch { /* ignore */ } });
    });
    const meta = await page.evaluate(() => {
      let end = 0, count = 0;
      for (const a of document.getAnimations()) {
        count++;
        const el = a.effect?.target;
        if (el?.closest?.('.kit-sub')) continue; // 字幕是全时长百分比动画, 不参与动画窗计算
        let ct; try { ct = a.effect.getComputedTiming(); } catch { continue; }
        if (Number.isFinite(ct.endTime)) end = Math.max(end, ct.endTime / 1000);
      }
      return { count, animEnd: end };
    });
    if (meta.animEnd <= 0.05) {
      // 页面没有任何有限动画: 静态页, 单帧即全部信息, 走 still 路径(字幕同样逐句出图)
      await page.screenshot({ path: safeOut(dir, 'preview', `${sid}.png`) });
      const nStill = await captureSubStills(page, { sid, t, framesCover: 0 });
      const cover = await captureCover(page, { sid, firstId });
      invalidateFrames();
      console.log(`✓ ${sid} 无动画, 静态截图 → preview/${sid}.png${nStill ? ` + 字幕图 ${nStill} 张` : ''}${cover ? ' + 封面 preview/cover.png' : ''}`);
      await page.close(); done++; continue;
    }
    const fps = timings.fps ?? 30;
    const windowS = Math.min(t.duration, meta.animEnd + 0.25); // 动画窗口逐帧, 其余靠字幕图/尾帧补
    const frames = Math.max(1, Math.ceil(windowS * fps));
    const fdir = safeOut(dir, 'build', 'frames', sid);
    fs.rmSync(fdir, { recursive: true, force: true });
    fs.mkdirSync(fdir, { recursive: true });
    const t0 = Date.now();
    for (let i = 0; i < frames; i++) {
      const ms = (i / fps) * 1000;
      await page.evaluate(ms => {
        document.getAnimations().forEach(a => { try { a.currentTime = ms; } catch { /* ignore */ } });
      }, ms);
      await page.screenshot({ path: path.join(fdir, 'f' + String(i).padStart(5, '0') + '.png') });
      if (i > 0 && i % 60 === 0) console.log(`  ${s.id}: ${i}/${frames} 帧 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
    fs.copyFileSync(path.join(fdir, 'f' + String(frames - 1).padStart(5, '0') + '.png'),
      safeOut(dir, 'preview', `${sid}.png`));
    // 动画窗之后的字幕变化: 逐句出静态图(framesCover = 帧序列实际时长, 这批窗口交给它之后的拼接)
    const nStill = await captureSubStills(page, { sid, t, framesCover: frames / fps });
    const cover = await captureCover(page, { sid, firstId });
    console.log(`✓ ${sid} ${frames} 帧 @${fps}fps (动画窗 ${windowS.toFixed(1)}s / 成片 ${t.duration.toFixed(1)}s) → build/frames/${sid}/${nStill ? ` + 字幕图 ${nStill} 张` : ''}${cover ? ' + 封面 preview/cover.png' : ''} + preview/${sid}.png`);
  }
  await page.close();
  done++;
}

await context.close();
await browser.close();
await veto.close();   // 先关浏览器再关代理(关代理会掐掉仍在途的隧道)
console.log(`完成: ${done}/${slides.length} 张 (mode=${mode})`);
