#!/usr/bin/env node
// html2video-for-mcode · 官方站点取图: 用 Playwright 打开官网, 列出候选图并下载
// 这是 image-sources.md 里成功率最高的路径 B(官方 logo / 产品图 / hero 图), 之前只有描述没有工具。
//
// 用法:
//   node fetch-official-images.mjs <网址> [--list]                        列出候选(默认动作)
//   node fetch-official-images.mjs <网址> --get 1,3,5 [--out-dir assets]  按序号下载
//   node fetch-official-images.mjs <网址> --min 800                       只看宽度 ≥800px 的
//   node fetch-official-images.mjs <网址> --min 800x600                   宽度与高度都要够(横扁图不能用)
//   node fetch-official-images.mjs <网址> --json                          输出 JSON(供程序处理)
//   node fetch-official-images.mjs --url <图片URL>[,<URL>...] [--out-dir assets]
//                                                                         直接下载给定图片 URL
//   (内置浏览器 inspect 官网 DOM 拿到零散图片 URL 时用 --url: 走同一套 host/重定向/大小/文件名
//    校验, 且**不需要 playwright** —— 站点要登录/滚动加载、脚本打不开时, 这是唯一落盘手段)
//   本地页(file://)加 --allow-file; 覆盖已存在文件 / out-dir 出项目 加 --force
//
// 纪律(与 image-sources.md 一致): 只取官方域名的资源; 列出的每一项都要人眼过一遍
// (主体是否居中/有无水印/比例是否合适), 选中的落盘 assets/ 并登记 MANIFEST.md。
//
// 网络安全(全部在打开浏览器之前校验, 负向路径无需 playwright):
//   - 只允许 http(s) 公网页面; file:// 本地页需显式 --allow-file(离线场景)
//   - 拦内网/本地/元数据地址(loopback、169.254.x、私网段、无点主机名等, 见 url-policy.mjs)
//   - 下载逐跳过同一策略(maxRedirects=0 手动跟, ≤5 跳), 响应有大小上限(默认 30MB)
//   - 落盘必须在工作目录内(--out-dir 越界需 --force), 不覆盖已存在文件(需 --force)
import fs from 'node:fs';
import { assertContained, canonicalPath as canonical, loadPackage, inside, positionals } from './tools.mjs';
import path from 'node:path';
import { assertFetchableUrl, assertRedirectTarget, assertResolvedHost, sanitizeFilename, imageNameFromUrl, MAX_REDIRECTS, PolicyError } from './url-policy.mjs';

const argv = process.argv.slice(2);
// 位置参数与取值型 flag 的清单统一在 tools.mjs: --json 曾在这里被当作取值型, 于是
// `--json <网址>` 会把网址吃掉、位置参数成空 → 报用法错误(2026-09-18 复查 D3 的成因)。
const positional = positionals(argv);
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const FORCE = argv.includes('--force');
const ALLOW_FILE = argv.includes('--allow-file');
const MAX_BYTES = Math.max(1, parseFloat(flag('--max-mb', '30')) * 1024 * 1024);
const URLS = (flag('--url', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const url = positional[0];
if (!URLS.length && (!url || !/^(https?|file):/.test(url))) {
  console.error('用法: node fetch-official-images.mjs <网址> [--list|--get 1,3] [--out-dir assets] [--min 800] [--max-mb 30] [--allow-file] [--force] [--json]\n    或: node fetch-official-images.mjs --url <图片URL>[,<URL>...] [--out-dir assets] [--max-mb 30] [--force]');
  process.exit(1);
}
if (!URLS.length) {
  try {
    assertFetchableUrl(url, { allowFile: ALLOW_FILE, where: '页面 URL' });
  } catch (e) {
    if (e instanceof PolicyError) { console.error(`✗ ${e.message}`); process.exit(1); }
    throw e;
  }
}
// --min 支持三种写法: 800(宽≥800) / 800x600(宽高都够) / x600(只限高)
const MIN_RAW = String(flag('--min', '0') ?? '0').trim().toLowerCase();
const MIN_M = /^(\d*)(?:x(\d+))?$/.exec(MIN_RAW);
if (!MIN_M || MIN_RAW === '' || (!MIN_M[1] && !MIN_M[2])) {
  console.error(`✗ --min 写法不对: ${MIN_RAW}(支持 800 / 800x600 / x600; 只写数字=只限宽)`);
  process.exit(1);
}
const MIN = parseInt(MIN_M[1] || '0', 10) || 0;
const MIN_H = parseInt(MIN_M[2] || '0', 10) || 0;
// 落盘收监: 默认 assets/ 必须在当前工作目录(项目根)内; 越界要显式 --force。
// 比较用规范化路径(二审 P2): macOS 上 /var 与 /private/var 是同一目录的两种写法,
// 纯字符串比较会把"项目内的合法路径"误判成越界(官方 CI 的 macOS 环境实测踩到)。
const OUT_DIR = path.resolve(flag('--out-dir', 'assets'));
const CWD_REAL = canonical(process.cwd()), OUT_REAL = canonical(OUT_DIR);
if (!inside(CWD_REAL, OUT_REAL) && OUT_REAL !== CWD_REAL) {
  if (!FORCE) {
    console.error(`✗ --out-dir 越出当前工作目录: ${OUT_DIR}\n  默认只写项目内(README 的"写入都在项目目录"承诺)。确需外部位置请加 --force`);
    process.exit(1);
  }
  console.warn(`⚠ --force: 下载将写到工作目录之外 ${OUT_DIR}`);
}

// ── 单张图片 URL 直下模式(内置浏览器 inspect 出零散 URL 时用; 不需要 playwright) ──
// 与 --get 同一套纪律: 逐跳复核 host 策略、响应大小上限、文件名清洗、已存在不覆盖。
// 顺序: 跟完重定向拿到响应头 → 按 content-type 定文件名 → **查重** → 才读 body 落盘
// (否则"已存在"会白下一遍, 网络抖动时还会把"已存在"报成"下载失败")。
async function openUrl(src) {
  let current = src, res = null;
  const seen = new Set([src]);   // 见过就说明在绕圈(A→B→A 这种 ping-pong 靠单步自比较抓不到)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertFetchableUrl(current, { allowFile: false, where: `下载(第 ${hop + 1} 跳)` });
    await assertResolvedHost(current, { where: `下载(第 ${hop + 1} 跳)` });
    res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': 'html2video-for-mcode/image-fetch' } });
    if (res.status === 0) throw new Error(`重定向响应读不出状态(跨域重定向常见): ${current}\n     改用图片最终地址(内置浏览器里右键复制图片地址)再试`);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`HTTP ${res.status} 无 Location`);
      const next = new URL(loc, current).href;
      if (next === current) throw new Error(`重定向指向自身(死循环): ${current}`);
      if (seen.has(next)) throw new Error(`重定向绕圈(来回跳): ${[...seen].join(' → ')} → ${next}\n     多半是站点把不存在的图片转到了错误页`);
      seen.add(next);
      current = next;
      continue;
    }
    break;
  }
  if (!res || res.status >= 300) throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳, 最后停在: ${current}(多半是站点把不存在的图片转到了错误页)`);
  if (res.status >= 400) throw new Error(`HTTP ${res.status} ${current}`);
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > MAX_BYTES) throw new Error(`响应 ${(declared / 1048576).toFixed(0)}MB 超过上限 ${Math.round(MAX_BYTES / 1048576)}MB(--max-mb 可调)`);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//.test(type) && !/octet-stream/.test(type)) console.warn(`  ⚠ content-type 不是图片(${type || '未知'})—— 人眼确认一下再登记`);
  return { res, type };
}

if (URLS.length) {
  // 建目录这一步也要收监: 叶子文件已经过了 assertContained, 但"先 mkdir 再写叶子"之间隔着一次
  // 目录创建 —— OUT_DIR 的某个目录段是指向项目外的链接时, mkdir 本身就已经在项目外动手了
  fs.mkdirSync(assertContained(CWD_REAL, OUT_DIR, { where: '输出目录' }), { recursive: true });
  let ok = 0;
  for (const src of URLS) {
    if (!/^https?:/.test(src)) { console.error(`  ✗ 跳过(只收 http(s)): ${src}`); continue; }
    try {
      const { res, type } = await openUrl(src);
      // 逐文件收监: OUT_DIR 本身过了 canonical 比较, 但它里面的目录段可能是符号链接(复查 B4)
      const out = assertContained(CWD_REAL, path.join(OUT_DIR, imageNameFromUrl(src, type)), { where: '下载落盘' });
      if (fs.existsSync(out) && !FORCE) { console.error(`  ✗ 已存在, 不覆盖: ${path.relative(process.cwd(), out)}(要覆盖加 --force)`); continue; }
      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length) throw new Error('响应为空(0 字节)—— 多半是 404 错误页或防盗链, 别写空文件');
      if (body.length > MAX_BYTES) throw new Error(`响应 ${(body.length / 1048576).toFixed(0)}MB 超过上限 ${Math.round(MAX_BYTES / 1048576)}MB(--max-mb 可调)`);
      fs.writeFileSync(out, body);
      console.log(`  ✓ ${path.relative(process.cwd(), out)}  (${(body.length / 1024).toFixed(0)}KB, ${type || '未知类型'})`);
      ok++;
    } catch (e) {
      if (e instanceof PolicyError) console.error(`  ✗ ${src}\n     ${e.message}`);
      else console.error(`  ✗ ${src}\n     下载失败: ${e.message}`);
    }
  }
  console.log(`\n已下载 ${ok}/${URLS.length} 张 → ${path.relative(process.cwd(), OUT_DIR)}`);
  console.log('下一步(必做): ① node scripts/prep-image.mjs --check <图...>  ② 人眼确认主体居中无水印  ③ 登记 assets/MANIFEST.md(来源 = 图片所在官方页 URL)');
  process.exit(ok ? 0 : 1);
}

const playwright = await loadPackage('playwright', { projectDir: process.cwd() });
if (!playwright) { console.error('✗ 未找到 playwright(已按 项目目录 / 调用目录 / npm 全局 逐个找过)。先执行: npm i playwright && npx playwright install chromium'); process.exit(1); }

const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
// 逐请求拦截(二审 P1: 策略必须落在**真实请求边界**上): 页面导航、Chromium 自己跟随的 30x
// 重定向、以及页面的每一个子资源请求, 都要先过字符串策略, 再做 DNS 解析复核 —— 只查"最初输入的
// URL"等于没覆盖真正的连接点。带缓存避免同一域名反复解析。
const dnsCache = new Map();
await context.route('**/*', async route => {
  const u = route.request().url();
  try {
    assertFetchableUrl(u, { allowFile: ALLOW_FILE, where: '页面请求' });
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    if (host && host.includes('.')) {
      if (!dnsCache.has(host)) dnsCache.set(host, assertResolvedHost(u, { where: '页面请求' }).then(() => null, e => e));
      const err = await dnsCache.get(host);
      if (err) throw err;
    }
    await route.continue();
  } catch (e) {
    if (e instanceof PolicyError) { console.warn(`  ⚠ 已拦截请求: ${String(u).slice(0, 90)} — ${e.message}`); await route.abort(); }
    else await route.continue();
  }
});
try {
  await assertResolvedHost(url, { where: '页面 URL' });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500); // 让懒加载图片冒出来
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);

  // 候选来源: <img>/<picture><source> + 元素的计算样式 background-image(官网 hero 常用背景图)
  const items = await page.evaluate(() => {
    const out = [];
    const push = (rawSrc, el) => {
      if (!rawSrc) return;
      let abs;
      try { abs = new URL(rawSrc.split(',')[0].trim().split(' ')[0], location.href).href; } catch { return; }
      if (!abs || abs.startsWith('data:') || abs.startsWith('blob:')) return;
      const img = el && el.tagName === 'IMG' ? el : el?.closest?.('picture')?.querySelector('img');
      out.push({
        src: abs,
        w: img?.naturalWidth || 0, h: img?.naturalHeight || 0,
        alt: (el?.getAttribute?.('alt') || '').slice(0, 60),
        kind: 'img',
      });
    };
    document.querySelectorAll('img, picture > source').forEach(el => push(el.getAttribute('src') || el.getAttribute('srcset'), el));
    document.querySelectorAll('body *').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) push(bg.slice(bg.indexOf('url(') + 4, bg.lastIndexOf(')')).replace(/["']/g, ''), el);
    });
    return out;
  });

  // 去重 + 尺寸过滤 + 官方域名标注 + host 策略过滤(候选 src 由页面控制, 同样只收公网 http(s)/放行的 file:)
  const seen = new Set();
  const candidates = [];
  const pageHost = (() => { try { return new URL(url).host; } catch { return ''; } })();
  for (const it of items) {
    if (seen.has(it.src)) continue;
    seen.add(it.src);
    let host = '', ext = '';
    try { const u = new URL(it.src); host = u.host; ext = (u.pathname.match(/\.(png|jpe?g|webp|avif|svg|gif)$/i) || [''])[0].toLowerCase(); } catch { /* ignore */ }
    let srcPolicy = 'ok';
    try {
      assertFetchableUrl(it.src, { allowFile: ALLOW_FILE, where: '候选图' });
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      srcPolicy = e.reason; // 内网/file/坏协议的 src 不进候选(下载时也过同一策略, 双保险)
    }
    if (srcPolicy !== 'ok') continue;
    const offsite = pageHost && host && !host.endsWith(pageHost.replace(/^www\./, '')) && !pageHost.endsWith(host.replace(/^www\./, ''));
    const vec = it.w === 0 && ext === '.svg';   // svg 无自然宽度, 不按像素筛
    // --min 800 只限宽; --min 800x600 宽高都要够(横版视频里"够宽但很扁"的图没法用)
    const bigEnough = vec || ((!MIN || it.w >= MIN) && (!MIN_H || it.h >= MIN_H));
    if (!bigEnough) continue;
    candidates.push({ ...it, host, ext: ext || '(无扩展名)', offsite });
  }

  if (!candidates.length) { console.log('没找到符合条件的图片(试试去掉 --min, 或换页面 / 产品页 / 新闻页)'); await context.close(); await browser.close(); process.exit(0); }

  if (flag('--json')) { console.log(JSON.stringify(candidates, null, 2)); await context.close(); await browser.close(); process.exit(0); }

  console.log(`候选图 ${candidates.length} 张(页面 ${pageHost || url}):\n`);
  candidates.forEach((c, i) => {
    const size = c.w ? `${c.w}×${c.h}` : '矢量/未知';
    const warn = c.offsite ? '  ⚠ 非本站域名, 确认是否官方 CDN' : '';
    console.log(`  [${i + 1}] ${size.padEnd(12)} ${c.ext.padEnd(6)} ${c.host}${warn}\n       ${c.alt ? c.alt + ' — ' : ''}${c.src.slice(0, 120)}`);
  });

  const get = flag('--get');
  if (get) {
    const picks = get.split(',').map(x => parseInt(x.trim(), 10)).filter(n => n >= 1 && n <= candidates.length);
    if (!picks.length) { console.error('✗ --get 的序号不在范围内'); process.exit(1); }
    fs.mkdirSync(assertContained(CWD_REAL, OUT_DIR, { where: '输出目录' }), { recursive: true });
    let ok = 0;
    for (const n of picks) {
      const c = candidates[n - 1];
      const name = sanitizeFilename(c.alt, { maxLen: 30, fallback: `official-${String(n).padStart(2, '0')}` }) + (c.ext.startsWith('.') ? c.ext : '.png');
      const out = assertContained(CWD_REAL, path.join(OUT_DIR, name), { where: '下载落盘' });
      if (fs.existsSync(out) && !FORCE) { console.error(`  ✗ [${n}] 已存在, 不覆盖: ${out}(要覆盖加 --force)`); continue; }
      try {
        if (c.src.startsWith('file:')) {
          fs.copyFileSync(new URL(c.src), out); // 本地页面(file://, 需 --allow-file)直拷
        } else {
          // 手动跟重定向: 每一跳都重新过 host 策略, 不让重定向绕开内网拦截
          let current = c.src;
          let res = null;
          for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            assertFetchableUrl(current, { allowFile: false, where: `下载(第 ${hop + 1} 跳)` });
            await assertResolvedHost(current, { where: `下载(第 ${hop + 1} 跳)` });
            res = await context.request.get(current, { timeout: 30000, maxRedirects: 0 });
            if (res.status() >= 300 && res.status() < 400) {
              const loc = res.headers()['location'];
              if (!loc) throw new Error(`HTTP ${res.status()} 无 Location`);
              current = new URL(loc, current).href;
              continue;
            }
            break;
          }
          if (!res || res.status() >= 300) throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`);
          if (res.status() >= 400) throw new Error(`HTTP ${res.status()}`);
          const declared = parseInt(res.headers()['content-length'] || '0', 10);
          if (declared > MAX_BYTES) throw new Error(`响应 ${ (declared / 1048576).toFixed(0)}MB 超过上限 ${Math.round(MAX_BYTES / 1048576)}MB(--max-mb 可调)`);
          const body = await res.body();
          if (body.length > MAX_BYTES) { throw new Error(`响应 ${(body.length / 1048576).toFixed(0)}MB 超过上限 ${Math.round(MAX_BYTES / 1048576)}MB(--max-mb 可调)`); }
          fs.writeFileSync(out, body);
        }
        console.log(`  ✓ ${path.relative(process.cwd(), out)}  (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
        ok++;
      } catch (e) { console.error(`  ✗ [${n}] 下载失败: ${e.message}`); }
    }
    console.log(`\n已下载 ${ok}/${picks.length} 张 → ${path.relative(process.cwd(), OUT_DIR)}`);
    // 退出码按成功率给: 全失败还退 0 的话, 上游脚本会把"一张都没落盘"当成功继续往下跑
    if (!ok) { console.error(`✗ ${picks.length} 张全部下载失败 —— 检查上面的原因(host 策略 / 网络 / --max-mb)`); process.exit(1); }
    if (ok < picks.length) console.warn(`⚠ 部分失败: ${picks.length - ok} 张没下来(见上面的原因); 已落盘的可以继续用`);
    console.log('下一步(必做): ① node scripts/prep-image.mjs --check <图...>  ② 人眼确认主体居中无水印  ③ 登记 assets/MANIFEST.md(来源就是本 URL)');
  } else {
    console.log('\n选好后: node scripts/fetch-official-images.mjs <网址> --get 1,3 --out-dir assets');
    console.log('下载前先人眼过一遍: 主体居中 / 无水印无无关 logo / 比例接近 / 分辨率够(image-sources.md §2)。');
  }
} catch (e) {
  console.error(`✗ 取图失败: ${e.message}\n  → 检查网址是否可达; 若站点需要交互(登录/滚动加载), 用内置浏览器手动取。`);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
