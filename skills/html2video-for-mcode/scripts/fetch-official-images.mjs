#!/usr/bin/env node
// html2video-for-mcode · 官方站点取图: 用 Playwright 打开官网, 列出候选图并下载
// 这是 image-sources.md 里成功率最高的路径 B(官方 logo / 产品图 / hero 图), 之前只有描述没有工具。
//
// 用法:
//   node fetch-official-images.mjs <网址> [--list]                        列出候选(默认动作)
//   node fetch-official-images.mjs <网址> --get 1,3,5 [--out-dir assets]  按序号下载
//   node fetch-official-images.mjs <网址> --min 800                       只看宽度 ≥800px 的
//   node fetch-official-images.mjs <网址> --json                          输出 JSON(供程序处理)
//
// 纪律(与 image-sources.md 一致): 只取官方域名的资源; 列出的每一项都要人眼过一遍
// (主体是否居中/有无水印/比例是否合适), 选中的落盘 assets/ 并登记 MANIFEST.md。
import fs from 'node:fs';
import { loadPackage } from './tools.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--get', '--out-dir', '--min']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}
const flag = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const url = positional[0];
if (!url || !/^https?:|^file:/.test(url)) {
  console.error('用法: node fetch-official-images.mjs <网址> [--list|--get 1,3] [--out-dir assets] [--min 800] [--json]');
  process.exit(1);
}
const MIN = parseInt(flag('--min', '0'), 10) || 0;
const OUT_DIR = path.resolve(flag('--out-dir', 'assets'));

const playwright = await loadPackage('playwright', { projectDir: process.cwd() });
if (!playwright) { console.error('✗ 未找到 playwright(已按 项目目录 / 调用目录 / npm 全局 逐个找过)。先执行: npm i playwright && npx playwright install chromium'); process.exit(1); }

const browser = await playwright.chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();
try {
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

  // 去重 + 尺寸过滤 + 官方域名标注
  const seen = new Set();
  const candidates = [];
  const pageHost = (() => { try { return new URL(url).host; } catch { return ''; } })();
  for (const it of items) {
    if (seen.has(it.src)) continue;
    seen.add(it.src);
    let host = '', ext = '';
    try { const u = new URL(it.src); host = u.host; ext = (u.pathname.match(/\.(png|jpe?g|webp|avif|svg|gif)$/i) || [''])[0].toLowerCase(); } catch { /* ignore */ }
    const offsite = pageHost && host && !host.endsWith(pageHost.replace(/^www\./, '')) && !pageHost.endsWith(host.replace(/^www\./, ''));
    const bigEnough = !MIN || it.w >= MIN || (it.w === 0 && ext === '.svg'); // svg 无自然宽度, 不按宽度筛
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
    fs.mkdirSync(OUT_DIR, { recursive: true });
    let ok = 0;
    for (const n of picks) {
      const c = candidates[n - 1];
      const name = (c.alt ? c.alt.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 30) : `official-${String(n).padStart(2, '0')}`) + (c.ext.startsWith('.') ? c.ext : '.png');
      const out = path.join(OUT_DIR, name);
      try {
        if (c.src.startsWith('file:')) {
          fs.copyFileSync(new URL(c.src), out); // 本地页面(file://)直拷, 便于离线/内网场景
        } else {
          const res = await context.request.get(c.src, { timeout: 30000 });
          if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
          fs.writeFileSync(out, await res.body());
        }
        console.log(`  ✓ ${path.relative(process.cwd(), out)}  (${(fs.statSync(out).size / 1024).toFixed(0)}KB)`);
        ok++;
      } catch (e) { console.error(`  ✗ [${n}] 下载失败: ${e.message}`); }
    }
    console.log(`\n已下载 ${ok}/${picks.length} 张 → ${path.relative(process.cwd(), OUT_DIR)}`);
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
