// html2video-for-mcode · no-fx 规则的唯一来源。
// init-project 把它写进 tokens.css; preview-page 在"老项目 tokens.css 里没有这段"时兜底注入,
// 否则放映页的"关动效对照"会把画面锁在入场前的透明态(看起来像整片空白)。
// 两处共用一份文本, 避免 CSS 漂移。

export const NOFX_CSS = `/* 一键关全部动效: <html class="no-fx"> 或 .stage.no-fx。
   注意必须同时把 [data-stage] 的基础态 opacity:0 拉回来 —— 入场效果靠 animation 的 both
   填充从 0 拉到 1, 只关动画不管基础态 = 元素全部隐形(2026-09-18 实测踩过)。
   关掉后 motion 捕获自动退化为静态帧, 成片照常出; 字幕(.kit-sub)不受影响。 */
.no-fx [class*="fx-"], .no-fx .fx-stagger > *, .no-fx .fx-shimmer::after { animation: none !important; }
.no-fx [data-stage], .no-fx .fx-stagger > * {
  opacity: 1 !important; transform: none !important; filter: none !important; clip-path: none !important;
}
.no-fx .fx-draw { stroke-dasharray: none !important; stroke-dashoffset: 0 !important; }`;

// 判定标准落在"承重"的那条规则上: 只关动画、没把 opacity 抬回来的旧版一律算没有。
export function hasNofxRules(css) {
  return /\.no-fx\s+\[data-stage\][^{]*\{[^}]*opacity\s*:\s*1\s*!important/.test(String(css ?? ''));
}
