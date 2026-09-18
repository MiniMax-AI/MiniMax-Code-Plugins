#!/usr/bin/env node
// html2video-for-mcode · 生成项目骨架
// 用法: node init-project.mjs <项目目录> [--topic "主题名"] [--force] [--upgrade-css] [--check-css]
// 目标目录已存在且非空时拒绝执行(会重置 script.json 等 5 个生成文件), 需显式 --force。
// --upgrade-css: 不生成任何文件, 只把已有项目 tokens.css 里的三个工具箱(no-fx / 图表 / 表格)
//   受管块更新到技能当前版本 —— 按内容 rev 原地替换, 幂等可重复跑, 写前备份 tokens.css.bak,
//   受管块之外的规则(含你在文件尾的覆写)一概不动。
// --check-css: 只检查不修改 —— 受管块落后/缺失时逐项报出并以退出码 1 结束(供 check 前 CI/自查用)。
import fs from 'node:fs';
import path from 'node:path';
import { NOFX_CSS } from './nofx-css.mjs';
import { CHART_CSS } from './chart-css.mjs';
import { TABLE_CSS } from './table-css.mjs';
import { KIT_REV, wrapKit, applyKitUpgrade, kitStatuses, MAX_SCAN_BYTES } from './css-kit.mjs';

const argv = process.argv.slice(2);
const dirArg = argv.find(a => !a.startsWith('--'));
if (!dirArg) {
  console.error('用法: node init-project.mjs <项目目录> [--topic "主题名"] [--force] [--upgrade-css] [--check-css]');
  process.exit(1);
}
const topicIdx = argv.indexOf('--topic');
const topic = topicIdx > -1 ? argv[topicIdx + 1] : '';
// topic 会插进模板 HTML 的 .brand 角标, 插入点单独转义(script.json / notes.md 用原文, 不转义)
const escapeHtml = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const topicHtml = escapeHtml(topic);
const dir = path.resolve(dirArg);

const TOKENS_CSS = `/* html2video-for-mcode 设计令牌 · 由 init-project 生成
   主题切换: <html data-theme="a|b|c|minimal-white|swiss-grid|corporate-clean|editorial-serif|magazine-bold|tokyo-night|catppuccin-mocha|nord|xiaohongshu-white|soft-pastel">

   a / b / c 是初版三主题(向后兼容, 老项目继续有效); 其余 10 套于 2026-09-17 移植自
   html-ppt-skill (MIT, Copyright (c) 2026 lewis) —— 详见技能内 THIRD-PARTY-NOTICES.md。

   约定: 新增或覆写主题必须覆盖全部颜色令牌 + --accent-ink, 并跑
   \`node <技能>/scripts/check-theme.mjs <项目目录>\` 校验对比度(深色主题另需覆写 --sub-bg/--sub-ring)。

   受管块: 下面 >>> html2video:nofx / chart / table <<< 三段(带 rev 定界注释)由技能单源生成,
   不要手工编辑 —— 改了也会在下次 --upgrade-css 时被按源重写; 自己的规则加在文件尾即可(后写覆盖)。
*/
:root {
  /* ── 画布(渲染管线按 script.json 的 width/height 注入真值; 默认横屏 1920×1080) ── */
  --stage-w: 1920px; --stage-h: 1080px;

  /* ── 颜色 · 表面 ── */
  --bg: #FAFAF7; --bg-soft: #F4F3ED;
  --panel: #F1F0EA; --panel-2: #E9E8E0;
  --line: #E3E1D8; --line-strong: #CFCDC0;

  /* ── 颜色 · 文本(三级) ── */
  --fg: #1A1A1A; --muted: #6B6B66; --fg-3: #9A9A92;

  /* ── 颜色 · 强调(accent-ink = 压在 accent 上的文字色, 每条主题必须自带对比度注释) ── */
  --accent: #FF5B2E; --accent-ink: #FFFFFF;  /* on --accent 3.1:1 — 仅可用于大字/图形 */
  --accent-2: #FF8A5C; --accent-3: #D94A20;

  /* ── 颜色 · 语义(数据页涨跌/正负) ── */
  --good: #1AAF6C; --warn: #C98500; --bad: #C13A3A;

  /* ── 涨跌专用(指标卡写 var(--up)/var(--down), 别直接写 good/bad):
     默认 = 欧美读法(绿涨红跌); A股/港股受众在项目 tokens.css 末尾覆写成红涨绿跌:
     :root { --up: #D92B2B; --down: #12A150; }   见 references/compliance.md ── */
  --up: var(--good); --down: var(--bad);

  /* ── 渐变 ── */
  --grad: linear-gradient(135deg, #FF5B2E, #FF8A5C 55%, #D94A20);
  --grad-soft: linear-gradient(135deg, #FBF0E8, #F7E7DA);

  /* ── 字幕(capture 烧录的字幕读这些钩子; 深色主题必须覆写 --sub-bg 与 --sub-ring) ── */
  --sub-bg: rgba(12,12,16,.62); --sub-fg: #FFFFFF; --sub-ring: 0 solid transparent;

  /* ── 圆角 / 阴影 ── */
  --radius: 16px; --radius-sm: 10px; --radius-lg: 24px;
  --shadow: 0 8px 24px rgba(18,24,40,.07), 0 2px 6px rgba(18,24,40,.04);
  --shadow-lg: 0 22px 56px rgba(18,24,40,.13), 0 6px 16px rgba(18,24,40,.06);

  /* ── 字体(全部走本地系统栈, 禁外链; 外链字体在离线沙箱会退化成 FOUT/方框) ── */
  --font-display: "Source Han Serif SC", "Noto Serif CJK SC", "Noto Serif SC", "SimSun", serif;
  --font-body: "Inter", "Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", Consolas, monospace;

  /* ── 字号(7 档 modular scale) ── */
  --fs-display: 92px; --fs-h1: 64px; --fs-h2: 44px; --fs-h3: 34px;
  --fs-body: 30px; --fs-caption: 24px; --fs-tiny: 20px;

  /* ── 间距(8 的倍数) ── */
  --sp-1: 8px; --sp-2: 16px; --sp-3: 24px; --sp-4: 32px;
  --sp-5: 48px; --sp-6: 64px; --sp-7: 96px; --sp-8: 128px;

  /* ── 缓动 / 时长 ── */
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in-out: cubic-bezier(.65, 0, .35, 1);
  --dur-fast: .4s; --dur-mid: .6s; --dur-slow: .9s;

  /* ── stage 延迟: 浏览器里直接打开时的占位值; 渲染管线会按 TTS 实测时长注入真值 ── */
  --t1: 0ms; --t2: 800ms; --t3: 2000ms;
}

/* ══ 主题 b · 深色科技绿(初版) ══ */
[data-theme="b"] {
  --bg: #0E0F12; --bg-soft: #12141A; --panel: #171A1F; --panel-2: #1E2229;
  --line: #262A31; --line-strong: #363B45;
  --fg: #F4F5F3; --muted: #9A9C9F; --fg-3: #6E7276;
  --accent: #10A37F; --accent-ink: #04110C;  /* on --accent 7.4:1 */
  --accent-2: #3DD9AC; --accent-3: #0B7A5F;
  --good: #3DD9AC; --warn: #E0AF68; --bad: #F7768E;
  --grad: linear-gradient(135deg, #10A37F, #3DD9AC 55%, #0B7A5F);
  --grad-soft: linear-gradient(135deg, #171A1F, #1E2229);
  --sub-bg: rgba(0,0,0,.58); --sub-ring: 1px solid rgba(255,255,255,.16);
  --shadow: 0 10px 30px rgba(0,0,0,.45); --shadow-lg: 0 24px 60px rgba(0,0,0,.6);
}

/* ══ 主题 c · 极简蓝(初版) ══ */
[data-theme="c"] {
  --bg: #FFFFFF; --bg-soft: #F7F8FA; --panel: #F5F6F8; --panel-2: #EDEFF3;
  --line: #E5E7EB; --line-strong: #CFD3DA;
  --fg: #111111; --muted: #666666; --fg-3: #9AA0A8;
  --accent: #1F6FEB; --accent-ink: #FFFFFF;  /* on --accent 4.9:1 */
  --accent-2: #5B9BFF; --accent-3: #1550B8;
  --good: #0E9F6E; --warn: #D97706; --bad: #DC2626;
  --grad: linear-gradient(135deg, #1F6FEB, #5B9BFF 55%, #1550B8);
  --grad-soft: linear-gradient(135deg, #F0F4FB, #E4ECF7);
  --shadow: 0 1px 3px rgba(10,37,64,.08), 0 4px 12px rgba(10,37,64,.05);
  --shadow-lg: 0 4px 12px rgba(10,37,64,.1), 0 16px 40px rgba(10,37,64,.08);
}

/* ════════════════════════════════════════════════════════════════
   以下 10 套主题移植自 html-ppt-skill(MIT, © 2026 lewis)
   映射规则: --surface→--panel, --surface-2→--panel-2, --border→--line,
   --border-strong→--line-strong, --text-1→--fg, --text-2→--muted, --text-3→--fg-3;
   外链字体(Playfair/Space Grotesk 等)一律改映射到我们的本地字体栈。
   每套的 --accent-ink 后保留原作者实测的对比度数值。
   ════════════════════════════════════════════════════════════════ */

/* 商务汇报 · 极简白, 克制高级 */
[data-theme="minimal-white"] {
  --bg: #FFFFFF; --bg-soft: #FAFAFA; --panel: #FFFFFF; --panel-2: #F5F5F6;
  --line: rgba(17,18,22,.08); --line-strong: rgba(17,18,22,.16);
  --fg: #0C0D10; --muted: #55596A; --fg-3: #9CA1B0;
  --accent: #111216; --accent-ink: #FFFFFF;  /* on --accent 18.7:1 */
  --accent-2: #3B3F4A; --accent-3: #6B6F7A;
  --good: #1AAF6C; --warn: #C98500; --bad: #C13A3A;
  --grad: linear-gradient(135deg, #111216, #3B3F4A);
  --grad-soft: linear-gradient(135deg, #F5F5F6, #FFFFFF);
  --radius: 14px; --radius-sm: 8px; --radius-lg: 22px;
  --shadow: 0 1px 2px rgba(17,18,22,.04), 0 8px 24px rgba(17,18,22,.06);
  --shadow-lg: 0 20px 60px rgba(17,18,22,.1);
  --font-display: var(--font-body);
}

/* 商务汇报 · 瑞士网格(Helvetica 感; .stage 带 12 栏竖线) */
[data-theme="swiss-grid"] {
  --bg: #FFFFFF; --bg-soft: #F4F4F4; --panel: #FFFFFF; --panel-2: #F4F4F4;
  --line: #111111; --line-strong: #111111;
  --fg: #111111; --muted: #444444; --fg-3: #888888;
  --accent: #D6001C; --accent-ink: #FFFFFF;  /* on --accent 5.4:1 */
  --accent-2: #111111; --accent-3: #888888;
  --good: #0F8A2F; --warn: #D38A00; --bad: #D6001C;
  --grad: linear-gradient(135deg, #D6001C, #111111);
  --grad-soft: linear-gradient(135deg, #F4F4F4, #FFFFFF);
  --radius: 0; --radius-sm: 0; --radius-lg: 0;
  --shadow: none; --shadow-lg: none;
  --font-display: var(--font-body);
}
[data-theme="swiss-grid"] .card { border-top: 2px solid var(--fg); border-bottom: 1px solid var(--fg); border-left: none; border-right: none; box-shadow: none; background: var(--bg); }
[data-theme="swiss-grid"] .stage { background-image: linear-gradient(90deg, rgba(0,0,0,.04) 1px, transparent 1px); background-size: calc(100% / 12) 100%; }

/* 商务汇报 · 企业商务(深蓝) */
[data-theme="corporate-clean"] {
  --bg: #FFFFFF; --bg-soft: #F5F7FA; --panel: #FFFFFF; --panel-2: #F0F3F7;
  --line: rgba(10,37,64,.12); --line-strong: rgba(10,37,64,.28);
  --fg: #0A2540; --muted: #425466; --fg-3: #8898AA;
  --accent: #0A2540; --accent-ink: #FFFFFF;  /* on --accent 15.5:1 */
  --accent-2: #1D4ED8; --accent-3: #64748B;
  --good: #0E9F6E; --warn: #D97706; --bad: #DC2626;
  --grad: linear-gradient(135deg, #0A2540, #1D4ED8);
  --grad-soft: linear-gradient(135deg, #F0F4FB, #E4ECF7);
  --radius: 6px; --radius-sm: 4px; --radius-lg: 10px;
  --shadow: 0 1px 3px rgba(10,37,64,.08), 0 4px 12px rgba(10,37,64,.05);
  --shadow-lg: 0 4px 12px rgba(10,37,64,.1), 0 16px 40px rgba(10,37,64,.08);
  --font-display: var(--font-body);
}
[data-theme="corporate-clean"] .kicker { color: var(--accent-2); }

/* 编辑杂志 · 杂志风衬线(原主题给标题配斜体, 中文伪斜体观感差故略去) */
[data-theme="editorial-serif"] {
  --bg: #FAF7F2; --bg-soft: #F3EFE6; --panel: #FFFFFF; --panel-2: #F7F2E8;
  --line: rgba(40,28,18,.12); --line-strong: rgba(40,28,18,.24);
  --fg: #1B1410; --muted: #5C4A3E; --fg-3: #8A7868;
  --accent: #8A2A1C; --accent-ink: #FFFFFF;  /* on --accent 8.6:1 */
  --accent-2: #C97A4A; --accent-3: #1B1410;
  --good: #3F7D4F; --warn: #B07A1F; --bad: #8A2A1C;
  --grad: linear-gradient(135deg, #8A2A1C, #C97A4A);
  --grad-soft: linear-gradient(135deg, #FAF7F2, #F3EFE6);
  --radius: 4px; --radius-sm: 2px; --radius-lg: 8px;
  --shadow: 0 2px 12px rgba(40,28,18,.06); --shadow-lg: 0 20px 50px rgba(40,28,18,.14);
}

/* 编辑杂志 · 大标题(硬阴影 + 衬线巨字) */
[data-theme="magazine-bold"] {
  --bg: #F5EFE2; --bg-soft: #EBE4D2; --panel: #FBF6E8; --panel-2: #EDE5D0;
  --line: rgba(10,10,10,.16); --line-strong: #0A0A0A;
  --fg: #0A0A0A; --muted: #2A2A2A; --fg-3: #6A6458;
  --accent: #EA5A1A; --accent-ink: #0B1024;  /* on --accent 5.4:1 */
  --accent-2: #0A0A0A; --accent-3: #C42A10;
  --good: #2A6A2A; --warn: #EA5A1A; --bad: #C42A10;
  --grad: linear-gradient(135deg, #EA5A1A, #C42A10);
  --grad-soft: linear-gradient(135deg, #FBE4D0, #F5D6C0);
  --radius: 0; --radius-sm: 0; --radius-lg: 2px;
  --shadow: none; --shadow-lg: 6px 6px 0 var(--accent);
}
[data-theme="magazine-bold"] .card { border: 1.5px solid var(--fg); }
[data-theme="magazine-bold"] .divider-accent { height: 6px; width: 90px; }

/* 科技深色 · tokyo-night */
[data-theme="tokyo-night"] {
  --bg: #1A1B26; --bg-soft: #16161E; --panel: #24283B; --panel-2: #2F334D;
  --line: rgba(192,202,245,.12); --line-strong: rgba(192,202,245,.24);
  --fg: #C0CAF5; --muted: #A9B1D6; --fg-3: #565F89;
  --accent: #7AA2F7; --accent-ink: #0B1024;  /* on --accent 7.5:1 */
  --accent-2: #BB9AF7; --accent-3: #7DCFFF;
  --good: #9ECE6A; --warn: #E0AF68; --bad: #F7768E;
  --grad: linear-gradient(135deg, #7AA2F7, #BB9AF7 55%, #F7768E);
  --grad-soft: linear-gradient(135deg, #24283B, #2F334D);
  --sub-bg: rgba(0,0,0,.58); --sub-ring: 1px solid rgba(255,255,255,.16);
  --radius: 12px; --radius-sm: 8px; --radius-lg: 20px;
  --shadow: 0 10px 30px rgba(0,0,0,.45); --shadow-lg: 0 24px 62px rgba(0,0,0,.6);
}

/* 科技深色 · catppuccin mocha */
[data-theme="catppuccin-mocha"] {
  --bg: #1E1E2E; --bg-soft: #181825; --panel: #313244; --panel-2: #45475A;
  --line: rgba(205,214,244,.12); --line-strong: rgba(205,214,244,.24);
  --fg: #CDD6F4; --muted: #A6ADC8; --fg-3: #7F849C;
  --accent: #CBA6F7; --accent-ink: #0B1024;  /* on --accent 9.3:1 */
  --accent-2: #89B4FA; --accent-3: #F5C2E7;
  --good: #A6E3A1; --warn: #F9E2AF; --bad: #F38BA8;
  --grad: linear-gradient(135deg, #CBA6F7, #89B4FA 50%, #94E2D5);
  --grad-soft: linear-gradient(135deg, #313244, #45475A);
  --sub-bg: rgba(0,0,0,.58); --sub-ring: 1px solid rgba(255,255,255,.16);
  --radius: 14px; --radius-sm: 10px; --radius-lg: 22px;
  --shadow: 0 10px 30px rgba(0,0,0,.35); --shadow-lg: 0 24px 60px rgba(0,0,0,.5);
}

/* 科技深色 · nord */
[data-theme="nord"] {
  --bg: #2E3440; --bg-soft: #272B35; --panel: #3B4252; --panel-2: #434C5E;
  --line: rgba(236,239,244,.12); --line-strong: rgba(236,239,244,.24);
  --fg: #ECEFF4; --muted: #D8DEE9; --fg-3: #7B8394;
  --accent: #88C0D0; --accent-ink: #0B1024;  /* on --accent 9.4:1 */
  --accent-2: #81A1C1; --accent-3: #B48EAD;
  --good: #A3BE8C; --warn: #EBCB8B; --bad: #BF616A;
  --grad: linear-gradient(135deg, #88C0D0, #81A1C1 50%, #B48EAD);
  --grad-soft: linear-gradient(135deg, #3B4252, #434C5E);
  --sub-bg: rgba(0,0,0,.58); --sub-ring: 1px solid rgba(255,255,255,.16);
  --radius: 12px; --radius-sm: 8px; --radius-lg: 20px;
  --shadow: 0 10px 30px rgba(0,0,0,.35); --shadow-lg: 0 22px 60px rgba(0,0,0,.5);
}

/* 消费生活 · 小红书白底高级感 */
[data-theme="xiaohongshu-white"] {
  --bg: #FFFDFB; --bg-soft: #FFF6F1; --panel: #FFFFFF; --panel-2: #FFF1EA;
  --line: rgba(60,30,20,.1); --line-strong: rgba(60,30,20,.22);
  --fg: #1A1210; --muted: #4F3A32; --fg-3: #A08D85;
  --accent: #FF2742; --accent-ink: #0B1024;  /* on --accent 5.0:1 */
  --accent-2: #FF7A90; --accent-3: #FFB38A;
  --good: #3BA55C; --warn: #F5A524; --bad: #FF2742;
  --grad: linear-gradient(135deg, #FF2742, #FF7A90 55%, #FFB38A);
  --grad-soft: linear-gradient(135deg, #FFF6F1, #FFEAE0);
  --radius: 20px; --radius-sm: 14px; --radius-lg: 28px;
  --shadow: 0 12px 30px rgba(255,39,66,.08); --shadow-lg: 0 24px 60px rgba(255,39,66,.14);
}

/* 消费生活 · 柔和马卡龙 */
[data-theme="soft-pastel"] {
  --bg: #FDF7FB; --bg-soft: #FBEEF3; --panel: #FFFFFF; --panel-2: #FDF0F5;
  --line: rgba(120,70,110,.12); --line-strong: rgba(120,70,110,.22);
  --fg: #3A1F33; --muted: #6B4D62; --fg-3: #A28A99;
  --accent: #F49BB8; --accent-ink: #0B1024;  /* on --accent 9.2:1 */
  --accent-2: #B5D5F0; --accent-3: #F7D08A;
  --good: #9DD9A3; --warn: #F7D08A; --bad: #EF9A9A;
  --grad: linear-gradient(135deg, #F49BB8, #B5D5F0 55%, #C4A0E8);
  --grad-soft: linear-gradient(135deg, #FBEEF3, #EAF4FC);
  --radius: 24px; --radius-sm: 16px; --radius-lg: 32px;
  --shadow: 0 8px 28px rgba(244,155,184,.18); --shadow-lg: 0 24px 70px rgba(181,213,240,.3);
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: var(--stage-w, 1920px); height: var(--stage-h, 1080px); overflow: hidden; }
.stage {
  position: relative; width: var(--stage-w, 1920px); height: var(--stage-h, 1080px); overflow: hidden;
  background: var(--bg); color: var(--fg); font-family: var(--font-body);
}
.brand {
  position: absolute; top: 44px; left: 64px;
  font-size: var(--fs-tiny); letter-spacing: .14em; color: var(--muted);
}
.slide-num {
  position: absolute; bottom: 40px; right: 64px;
  font-size: var(--fs-tiny); letter-spacing: .1em; color: var(--muted);
}
.accent { color: var(--accent); }
.gradient-text { background: var(--grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; }

/* ── 排版角色 ───────────────────────────────────────────────── */
.kicker { font-size: var(--fs-tiny); font-weight: 600; color: var(--accent); letter-spacing: .08em; }
.eyebrow { font-size: var(--fs-tiny); font-weight: 500; letter-spacing: .16em; color: var(--fg-3); }
.lede { font-size: var(--fs-h3); line-height: 1.55; color: var(--muted); font-weight: 300; max-width: 1400px; }

/* ── 卡片 / 标签 / 分隔 ─────────────────────────────────────── */
.card {
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--sp-4) var(--sp-5); box-shadow: var(--shadow); position: relative; overflow: hidden;
}
.card-soft { background: var(--panel-2); border-color: transparent; box-shadow: none; }
.card-outline { background: transparent; border: 1.5px solid var(--line-strong); box-shadow: none; }
.card-accent { border-top: 3px solid var(--accent); }
.pill {
  display: inline-block; padding: 4px 14px; border-radius: 999px; font-size: var(--fs-tiny);
  font-weight: 500; background: var(--panel-2); color: var(--muted); border: 1px solid var(--line);
}
.pill-accent {
  background: var(--panel-2);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent); border-color: var(--line);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.divider-accent { height: 4px; width: 72px; background: var(--accent); border-radius: 2px; }

/* ── 图片框(硬规则: 图片必须套框, 禁止裸放 <img>) ─────────────
   .img-frame        比例与裁切归框所有; 图片只管填满
   .img-frame.contain 不裁切(截图/图表/logo 必须用这个), 居中留白
   --img-ratio       框比例(默认 16/10); --img-pos 主体位置(如 top 保住头部)
   .img-scrim        底部渐变压暗, 让白字压在照片上仍可读 */
.img-frame {
  position: relative; margin: 0; overflow: hidden; display: block;
  border-radius: var(--radius); box-shadow: var(--shadow); background: var(--panel-2);
  aspect-ratio: var(--img-ratio, 16/10);
}
.img-frame > img { width: 100%; height: 100%; object-fit: cover; object-position: var(--img-pos, center); display: block; }
.img-frame.contain { background: var(--bg-soft); box-shadow: none; border: 1px solid var(--line); }
.img-frame.contain > img { object-fit: contain; }
.img-frame.fill { height: 100%; aspect-ratio: auto; }
.img-scrim { position: absolute; inset: 0; background: linear-gradient(180deg, transparent 42%, rgba(8,10,20,.72)); }
.img-cap { margin: 10px 2px 0; font-size: var(--fs-tiny); line-height: 1.5; color: var(--fg-3); }
.img-tag {
  position: absolute; top: 14px; left: 14px; padding: 5px 14px; border-radius: 999px;
  background: rgba(10,12,20,.55); color: #fff; font-size: var(--fs-tiny); letter-spacing: .06em;
}

/* ── 免责声明 / 出处标注行(受监管题材: 财经/医疗/法律/政策, 见 references/compliance.md)
   小字不抢视觉; 出现在 closing 张并停留 ≥3s; 口播不念、不进字幕; 加了它也不替代核实 */
.disclaimer { font-size: var(--fs-tiny); line-height: 1.6; color: var(--fg-3); max-width: 1240px; }
.disclaimer-box { border-left: 2px solid var(--line-strong); padding-left: var(--sp-3); }

/* ── 分步入场系统 ──────────────────────────────────────────────
   要入场的块: data-stage="1|2|3" + fx-* 工具类, 例:
     <h1 data-stage="1" class="fx-up">大标题</h1>
     <p  data-stage="2" class="fx-fade">展开内容</p>
   延迟由管线按口播实测时长注入 --t1/--t2/--t3, HTML 里不要写死。
   同层内错峰: 用容器 .fx-stagger(基准时刻用 style="--stagger-base:var(--t3)" 指定),
   或内联 style="animation-delay:calc(var(--t2) + 150ms)"
   ⚠ data-stage 必须与 fx-* 类同时用 —— 只有 data-stage 没有动画类, 元素会永远停在 opacity:0;
     容器用 .fx-stagger 时容器自身不要再加 data-stage(子元素自己管入场)。
   氛围动画(无限循环, 不承载信息)不加 data-stage: fx-pulse / fx-shimmer / fx-kenburns */
[data-stage] { opacity: 0; --fx-delay: 0ms; }
[data-stage="1"] { --fx-delay: var(--t1); }
[data-stage="2"] { --fx-delay: var(--t2); }
[data-stage="3"] { --fx-delay: var(--t3); }

/* 入场(有限时长, 可被逐帧 seek)。延迟写进 shorthand 的变量槽 —— 不能用独立的
   animation-delay 声明: 它与下面的 .fx-* 简写同优先级且更靠前, 会被简写重置为 0,
   导致所有 stage 都在 0 秒入场(2026-09-17 实测确认的坑)。inline animation-delay 仍可覆盖(错峰用)。 */
.fx-up    { animation: fx-up    var(--dur-mid)  var(--ease-out) var(--fx-delay, 0ms) both; }
.fx-fade  { animation: fx-fade  var(--dur-fast) var(--ease-out) var(--fx-delay, 0ms) both; }
.fx-grow  { animation: fx-grow  var(--dur-slow) var(--ease-out) var(--fx-delay, 0ms) both; }
.fx-blur  { animation: fx-blur  .8s  var(--ease-out) var(--fx-delay, 0ms) both; }   /* 模糊聚焦 */
.fx-rise  { animation: fx-rise  .9s  var(--ease-out) var(--fx-delay, 0ms) both; }   /* 上浮+微缩放+去模糊 */
.fx-pop   { animation: fx-pop   .7s  cubic-bezier(.22,1.3,.36,1) var(--fx-delay, 0ms) both; } /* 过冲弹入 */
.fx-spotlight { animation: fx-spotlight 1.1s var(--ease-out) var(--fx-delay, 0ms) both; }      /* 圆形揭示 */
.fx-ripple    { animation: fx-ripple    1.2s var(--ease-out) var(--fx-delay, 0ms) both; }      /* 斜角冲开 */
.fx-glitch    { animation: fx-glitch    .8s  steps(5, end) var(--fx-delay, 0ms) both; }        /* 故障切入 */
.fx-draw  { animation: fx-draw 1.2s var(--ease-in-out) var(--fx-delay, 0ms) both; } /* 需元素自设 stroke-dasharray:800 */
.fx-grow-x { transform-origin: left center; animation: fx-grow-x-kf .9s var(--ease-out) var(--fx-delay, 0ms) both; }  /* 图表: 条形从左长出 */
.fx-grow-y { transform-origin: bottom center; animation: fx-grow-y-kf .9s var(--ease-out) var(--fx-delay, 0ms) both; } /* 图表: 柱状从底长出 */

${wrapKit('nofx', NOFX_CSS)}

@keyframes fx-up   { from { opacity: 0; transform: translateY(32px); } to { opacity: 1; transform: none; } }
@keyframes fx-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes fx-grow { from { opacity: 0; transform: scale(.9); } to { opacity: 1; transform: scale(1); } }
@keyframes fx-blur { from { opacity: 0; filter: blur(18px); } to { opacity: 1; filter: none; } }
@keyframes fx-rise { from { opacity: 0; transform: translateY(60px) scale(.97); filter: blur(6px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes fx-pop  { 0% { opacity: 0; transform: scale(.6); } 60% { transform: scale(1.04); } 100% { opacity: 1; transform: scale(1); } }
@keyframes fx-spotlight { from { clip-path: circle(0% at 50% 50%); opacity: 1; } to { clip-path: circle(140% at 50% 50%); opacity: 1; } }
@keyframes fx-ripple    { from { clip-path: circle(0% at 20% 80%); opacity: .4; } to { clip-path: circle(160% at 20% 80%); opacity: 1; } }
@keyframes fx-glitch {
  0% { opacity: 0; transform: translateX(0); clip-path: inset(0 0 0 0); }
  20% { opacity: 1; transform: translateX(-6px); clip-path: inset(20% 0 30% 0); }
  40% { transform: translateX(4px); clip-path: inset(50% 0 10% 0); }
  60% { transform: translateX(-3px); clip-path: inset(10% 0 60% 0); }
  80% { transform: translateX(2px); clip-path: inset(0 0 0 0); }
  100% { opacity: 1; transform: none; }
}
@keyframes fx-draw { from { stroke-dashoffset: 800; opacity: 1; } to { stroke-dashoffset: 0; opacity: 1; } }
/* 注意: 只做 transform 的动画必须显式带上 opacity:1 —— [data-stage] 的基础态是 opacity:0,
   靠动画抬回 1; 关键帧不碰 opacity 的动画会让元素永远隐形(2026-09-18 实测) */
@keyframes fx-grow-x-kf { from { transform: scaleX(0); opacity: 1; } to { transform: scaleX(1); opacity: 1; } }
@keyframes fx-grow-y-kf { from { transform: scaleY(0); opacity: 1; } to { transform: scaleY(1); opacity: 1; } }

/* 氛围(无限循环, 不参与时长计算) */
.fx-pulse { animation: fx-pulse 2.4s var(--ease-in-out) infinite; }
@keyframes fx-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
.fx-shimmer { position: relative; overflow: hidden; }
.fx-shimmer::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(110deg, transparent 40%, rgba(255,255,255,.5) 50%, transparent 60%);
  transform: translateX(-100%); animation: fx-shimmer-kf 2.4s var(--ease-in-out) infinite;
}
@keyframes fx-shimmer-kf { to { transform: translateX(100%); } }
.fx-kenburns { animation: fx-kenburns-kf 14s ease-in-out infinite alternate; }
@keyframes fx-kenburns-kf { from { transform: scale(1) translate(0, 0); } to { transform: scale(1.15) translate(-2%, -1%); } }

${wrapKit('chart', CHART_CSS)}

${wrapKit('table', TABLE_CSS)}

/* 依次入场容器: 子元素逐个上浮, 基准时刻取 --stagger-base(默认 --t2) */
.fx-stagger > * { opacity: 0; animation: fx-rise .65s var(--ease-out) both; }
.fx-stagger > *:nth-child(1) { animation-delay: calc(var(--stagger-base, var(--t2)) + 0ms); }
.fx-stagger > *:nth-child(2) { animation-delay: calc(var(--stagger-base, var(--t2)) + 120ms); }
.fx-stagger > *:nth-child(3) { animation-delay: calc(var(--stagger-base, var(--t2)) + 240ms); }
.fx-stagger > *:nth-child(4) { animation-delay: calc(var(--stagger-base, var(--t2)) + 360ms); }
.fx-stagger > *:nth-child(5) { animation-delay: calc(var(--stagger-base, var(--t2)) + 480ms); }
.fx-stagger > *:nth-child(6) { animation-delay: calc(var(--stagger-base, var(--t2)) + 600ms); }
.fx-stagger > *:nth-child(7) { animation-delay: calc(var(--stagger-base, var(--t2)) + 720ms); }
.fx-stagger > *:nth-child(n+8) { animation-delay: calc(var(--stagger-base, var(--t2)) + 840ms); }
`;

const TEMPLATE_HTML = `<!doctype html>
<!-- 版式示例: statement · 复制改内容, 其他版式片段见 references/authoring.md -->
<html lang="zh-CN" data-theme="a">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="tokens.css">
<style>
  .layout { position: absolute; inset: 0; display: flex; flex-direction: column;
    justify-content: center; padding: 0 160px; gap: var(--sp-6); }
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
  _readme: 'html2video-for-mcode 脚本契约。clauses 每个元素=一句口播; stage=这句开口时该入场的视觉层(1/2/3); 可选 text2=双语字幕第二行。tail=收尾留白秒数(默认0.8)。改口播必须过 Gate 1, 之后从 Phase 2 重跑。可选顶层 bgm: "assets/bgm.mp3" 或 {file,volume:0.12,fadeIn:1.5,fadeOut:2.5}。width/height 决定画布: 1920×1080 横屏 / 1080×1920 竖屏。lang 决定口播语种与音色: zh(默认)/en/yue/其他 BCP-47 — 语种必须与音色匹配, 且影响语速基准与字幕行宽校验。',
  topic,
  lang: "zh",
  voice: 'Chinese (Mandarin)_Gentleman',
  speed: { default: 1.0, first: 0.95, last: 0.95 },
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
  const cssPath = path.join(dir, 'slides', 'tokens.css');
  if (!fs.existsSync(cssPath)) { console.error(`✗ 找不到 ${cssPath}`); process.exit(1); }
  const css = fs.readFileSync(cssPath, 'utf8');
  if (css.length > MAX_SCAN_BYTES) { console.error(`✗ tokens.css 有 ${Math.round(css.length / 1e4) / 100}MB, 超过 ${MAX_SCAN_BYTES / 1e6}MB 上限拒绝扫描(正常项目 ≈15KB; 构造的超大输入会让受管块定位二次方变慢)`); process.exit(1); }

  if (argv.includes('--check-css')) {
    const bad = kitStatuses(css).filter(s => s.status !== 'ok');
    if (!bad.length) { console.log(`✓ tokens.css 工具箱已是最新(kit rev ${KIT_REV.slice(0, 8)})`); process.exit(0); }
    for (const s of bad) console.error(`✗ ${s.label}: ${s.status === 'stale' ? s.detail : `缺这段(${s.detail})`}`);
    console.error('  → node scripts/init-project.mjs <项目目录> --upgrade-css(原地替换受管块, 不动你的其他规则)');
    process.exit(1);
  }

  const { css: next, actions, normalizedLineEndings } = applyKitUpgrade(css);
  if (!actions.length) { console.log(`无需升级: ${cssPath} 工具箱已是最新(kit rev ${KIT_REV.slice(0, 8)})`); process.exit(0); }
  if (fs.existsSync(cssPath + '.bak')) console.warn('⚠ 已存在 tokens.css.bak, 将被本次升级前的备份覆盖(旧备份会丢, 需要留就先改名)');
  fs.writeFileSync(cssPath + '.bak', css);   // 覆盖前备份: 升级只应动受管块, 万一不对可整文件回退
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

for (const d of ['research', 'assets', 'slides', 'audio', 'preview', 'out', 'build', 'asr']) {
  fs.mkdirSync(path.join(dir, d), { recursive: true });
}
fs.writeFileSync(path.join(dir, 'slides', 'tokens.css'), TOKENS_CSS);
fs.writeFileSync(path.join(dir, 'slides', '_template.html'), TEMPLATE_HTML);
fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(scriptJson, null, 2) + '\n');
fs.writeFileSync(path.join(dir, 'assets', 'MANIFEST.md'),
  `# 素材清单\n\n| 文件 | 内容 | 来源 | 许可 |\n|---|---|---|---|\n\n<!-- 每个素材一行; 来源必须可核查。禁止使用凭空生成的 logo/截图/头像。选图 SOP 见 references/image-sources.md -->\n`);
fs.writeFileSync(path.join(dir, 'research', 'notes.md'),
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
