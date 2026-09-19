// html2video-for-mcode · 表格原语的唯一来源。
// init-project 把它写进 tokens.css 的受管块; `--upgrade-css` 按内容 rev 原地更新(见 css-kit.mjs)。
// 为什么要有原语: 以前每种表都靠内联样式各写一套, 行高/对齐/涨跌色各页不一致 ——
// 而表格最容易出的问题正是"行高压不住、数字不右对齐、涨跌色用错"(见 authoring.md 表格纪律)。

export const TABLE_CSS = `/* ── 表格原语(数据表/规格表/对比矩阵/排名表统一用它) ─────────────
   1080p 下远处要读得清: 行高 ≥72px、数值右对齐且等宽、表头弱化、只留横线不画竖线。
   涨跌色一律 var(--up)/var(--down)(财经按受众翻转, 见 compliance.md)。 */
.tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }   /* 主数据用正文号(≥30px): 视频在手机上也要读得清 */
.tbl th { text-align: left; font-weight: 500; color: var(--fg-3); font-size: var(--fs-caption);
  letter-spacing: .04em; padding: 0 0 var(--sp-2); border-bottom: 1px solid var(--line-strong); }
.tbl td { padding: var(--sp-3) var(--sp-4) var(--sp-3) 0; border-bottom: 1px solid var(--line); }
.tbl tr:last-child td { border-bottom: 0; }
.tbl tbody tr { height: 72px; }                       /* 行高保底: 再挤就远处读不出 */
.tbl .num { text-align: right; padding-right: 0; font-family: var(--font-mono);
  font-variant-numeric: tabular-nums; }
.tbl .up { color: var(--up); }
.tbl .down { color: var(--down); }
.tbl .muted { color: var(--muted); }
/* 高亮行(通常是"我们"或当前阶段)与合计行 */
.tbl tr.key td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.tbl tr.key td:first-child { box-shadow: inset 3px 0 0 var(--accent); padding-left: var(--sp-4); }
.tbl tr.sum td { border-top: 1px solid var(--line-strong); font-weight: 600; color: var(--fg); }
/* 无表头规格表: 左标签右值, 只有细线 */
.kv { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.kv td { padding: var(--sp-3) 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.kv td:first-child { color: var(--muted); width: 32%; }
.kv td:last-child { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
/* 对比矩阵: 行是维度、列是方案, 单元格只放勾叉/等级 */
.matrix { width: 100%; border-collapse: collapse; font-size: var(--fs-body); text-align: center; }
.matrix th { color: var(--fg-3); font-size: var(--fs-caption); font-weight: 500; padding: 0 0 var(--sp-2);
  border-bottom: 1px solid var(--line-strong); }
.matrix th:first-child, .matrix td:first-child { text-align: left; }
.matrix td { padding: var(--sp-3) 0; border-bottom: 1px solid var(--line); height: 72px; }
.matrix .yes { color: var(--accent); font-size: var(--fs-h3); }
.matrix .no { color: var(--fg-3); }
/* 高亮列: td 与 th 都要覆盖 —— 只写 td.hi 时表头那格拿不到背景, "我们"那一列看着只亮了一半(2026-09-18 排查抓到) */
.matrix td.hi, .matrix th.hi { background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* 排名表: 名次 + 微缩条 + 数值(表格里的条形, 复用 --w 定长) */
.rank { width: 100%; border-collapse: collapse; font-size: var(--fs-body); }
.rank td { padding: var(--sp-2) var(--sp-3) var(--sp-2) 0; border-bottom: 1px solid var(--line); height: 72px; }
.rank .no { color: var(--fg-3); font-family: var(--font-mono); width: 3em; }
.rank .bar { width: 46%; }
.rank .bar span { display: block; height: 12px; border-radius: 999px; background: var(--accent); }
.rank .bar span.dim { background: color-mix(in srgb, var(--accent) 30%, var(--bg)); }
.rank .val { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }`;

export function hasTableKit(css) {
  return /\.tbl\s+tbody\s+tr\s*\{[^}]*height:\s*72px/.test(String(css ?? '')) && /\.kv\s*\{/.test(String(css ?? ''));
}
