// html2video-for-mcode · 图表动效与图表原语的唯一来源。
// init-project 把它写进 tokens.css 的受管块; `--upgrade-css` 按内容 rev 原地更新(见 css-kit.mjs)。
// 老项目缺这段时新配方会静默半死(条形不生长 / 环形不扫出 / 数字不滚动)。

export const CHART_CSS = `/* ── 图表动效(数据图形专用) ─────────────────────────────────────
   静态默认值一律 = 终值, keyframes 从 0 长到终值 —— 这样关掉动效(no-fx)时画面自然
   停在完成态, 不需要额外复位规则。目标值由内联 --w / --p-to / --n-to 给。
   三个注册属性(@property)让"扫出/宽度生长/数字滚动"都能被逐帧 seek(纯 CSS 动画)。
   为什么不用 scaleX 给带标签的条形: scaleX 会把条内的数字横向拉扁(2026-09-18 实测),
   带标签用 fx-grow-w(动画 width), 只有纯色块才用 fx-grow-x。 */
@property --pv { syntax: '<number>'; initial-value: 0; inherits: false; }
@property --cnt { syntax: '<integer>'; initial-value: 0; inherits: false; }

.fx-grow-w { width: var(--w, 100%); animation: fx-grow-w-kf .9s var(--ease-out) var(--fx-delay, 0ms) both; }
@keyframes fx-grow-w-kf { from { width: 0; opacity: 1; } to { width: var(--w, 100%); opacity: 1; } }

.fx-grow-h { height: var(--h, 100%); animation: fx-grow-h-kf .9s var(--ease-out) var(--fx-delay, 0ms) both; }
@keyframes fx-grow-h-kf { from { height: 0; opacity: 1; } to { height: var(--h, 100%); opacity: 1; } }

/* 环形/仪表: --p-to 是目标百分比(0–100); 锥面渐变随 --pv 逐帧重算 */
.fx-sweep { --pv: var(--p-to, 100); animation: fx-sweep-kf 1.1s var(--ease-out) var(--fx-delay, 0ms) both; }
@keyframes fx-sweep-kf { from { --pv: 0; opacity: 1; } to { --pv: var(--p-to, 100); opacity: 1; } }

.fx-count { --cnt: var(--n-to, 0); counter-reset: fxcount var(--cnt); animation: fx-count-kf 1s var(--ease-out) var(--fx-delay, 0ms) both; }
.fx-count::after { content: counter(fxcount); }
/* 数字滚动: 只支持整数。入场前 opacity:0 —— 否则画面会停在"灰色的 0", 读成"没数据"(2026-09-18 judge 抓到) */
@keyframes fx-count-kf { 0% { --cnt: 0; opacity: 0; } 15% { opacity: 1; } 100% { --cnt: var(--n-to, 0); opacity: 1; } }

/* 数据点: 折线/散点上的小圆点逐个弹出(配合 --fx-delay 错峰) */
.fx-dot { animation: fx-dot-kf .45s cubic-bezier(.22,1.3,.36,1) var(--fx-delay, 0ms) both; }
@keyframes fx-dot-kf { from { opacity: 0; transform: scale(0); } to { opacity: 1; transform: scale(1); } }

/* 图表原语(数据图形统一用它, 别再各写一套内联样式) —— 配色纪律: 同类同色,
   关键一条用 --accent, 其余用弱化的同类色(color-mix); 涨跌用 --up/--down(受众翻转向 compliance.md) */
.chart { display: flex; flex-direction: column; gap: var(--sp-3); }
.chart-head { display: flex; align-items: baseline; gap: var(--sp-3); }
.chart-title { font-size: var(--fs-caption); color: var(--muted); }
.chart-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.chart-note { margin-left: auto; font-size: var(--fs-tiny); color: var(--accent); border: 1px solid var(--line);
  border-radius: 999px; padding: 2px 10px; }
.chart-plot { position: relative; }
.chart-plot.grid { background-image: repeating-linear-gradient(to top, var(--line) 0 1px, transparent 1px 25%); }
/* 用 grid 固定三列(标签 / 轨道 / 数值位) —— 有没有条外数值, 轨道都一样长,
   否则"加了数值的行"轨道会被挤窄, 同一张图里出现两把尺子, 条长失去可比性(2026-09-18 视觉验收抓到) */
.chart-row { display: grid; grid-template-columns: var(--lbl-w, 200px) minmax(0, 1fr) var(--val-w, 96px);
  align-items: center; gap: var(--sp-3); }
.chart-lbl { flex: 0 0 200px; text-align: right; color: var(--muted); font-size: var(--fs-caption); }
.chart-track { position: relative; flex: 1 1 auto; width: 100%; height: var(--bar-h, 34px); background: var(--panel-2);
  border-radius: var(--radius-sm); overflow: hidden; }
/* 纵向细网格: 每条轨道共享 25/50/75% 刻度, 观感上就是"同一把尺子"(比只给浅灰轨道精致) */
.chart-track.grid { background-image: repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px 25%); }
/* 零轴: 轨道左缘一条 1px 竖线, 让"从这里开始量"有明确起点 */
.chart-track::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 1px;
  background: var(--line-strong); opacity: .5; z-index: 1; }
.chart-bar { height: 100%; background: var(--accent); display: flex; align-items: center;
  justify-content: flex-end; padding-right: 12px; overflow: hidden; }
.chart-bar.dim { background: var(--accent);      /* 弱化条用不透明同色系: 半透明会让格子线透出来, 被误读成分段/堆叠 */
  background: color-mix(in srgb, var(--accent) 30%, var(--bg)); }
.chart-bar .chart-val { color: var(--accent-ink); font-size: var(--fs-tiny); white-space: nowrap; }
/* 弱化条(半透明同色系)上压白字读不出来 —— 条内数值自动改墨色; 也可以直接把数值放条外(.out) */
.chart-bar.dim .chart-val { color: var(--fg); }
.chart-val.out { color: var(--fg); font-size: var(--fs-caption); }
.chart-cols { display: flex; align-items: stretch; justify-content: center; gap: var(--sp-4); height: var(--cols-h, 380px); }
/* 三层结构, 每一层的职责单一:
   .chart-col       = [绘图区 1fr] + [轴标签 auto]
   .chart-plot-cell = 绘图区本身: 底边 = 基线, 网格也画在这里(所以网格与柱高同一把尺子)
   .chart-bar-wrap  = 一根柱的高度基准(style="height:77.5%" = 数值 ÷ 轴上限), 数值标签挂它顶上
   ⚠ 柱高必须相对绘图区算: 直接把柱子放进 flex 列按百分比设高, 基准是整列、超出剩余空间会被
   flex-shrink 压回去(实测 84% 与 72% 画成一样高); 网格若铺在整列上、柱区却更矮, 读者按网格
   读出的数值就与标注不符(两条都实测被视觉验收判 fail) */
.chart-col { flex: 0 1 200px; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 8px; }
.chart-plot-cell { position: relative; display: flex; flex-direction: column; justify-content: flex-end;
  min-height: 0; border-bottom: 1px solid var(--line-strong); }
.chart-plot-cell.grid { border-top: 1px solid var(--line-strong);   /* 顶边 = 轴上限, 让"轴 0–X"看得见 */
  background-image: repeating-linear-gradient(to top, var(--line-strong) 0 1px, transparent 1px 25%); }
/* 目标线有两种朝向, 都按比例尺定位:
   ① 柱状图里是横线(bottom:100% = 轴上限); ② bullet 轨道里是**竖线**(left:88% = 目标位),
     标签必须贴在刻度旁边 —— 贴轨道右端会被读成"刻度在最右边"(实测被视觉验收抓到) */
.chart-plot-cell .chart-target { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--line-strong); }
.chart-track .chart-target { position: absolute; top: -5px; bottom: -5px; border-left: 2px dashed var(--fg-3); }
.chart-track .chart-target span { position: absolute; top: -1.5em; right: 4px; white-space: nowrap;
  font-size: var(--fs-tiny); color: var(--fg-3); }
.chart-bar-wrap { position: relative; display: flex; flex-direction: column; justify-content: flex-end; min-height: 0; }
.chart-bar-wrap .chart-val { position: absolute; bottom: 100%; left: 0; right: 0; text-align: center; margin-bottom: 6px; }
.chart-bar-wrap .chart-bar { width: 100%; height: 100%; border-radius: var(--radius-sm) var(--radius-sm) 0 0; padding: 0; }
.chart-col .chart-val { color: var(--fg); align-self: stretch; text-align: center; }  /* 与柱下轴标签同一轴线 */
.chart-col .chart-lbl { flex: 0 0 auto; text-align: center; }
/* 左侧刻度列: 与绘图区等高(底部留出轴标签那一行的高度), 让"轴 0–X%"在图上可核验 */
.chart-ticks { display: flex; flex-direction: column; justify-content: space-between; align-items: flex-end;
  height: calc(var(--cols-h, 380px) - 40px); font-size: var(--fs-tiny); color: var(--fg-3); padding-right: var(--sp-2); }
.chart-target { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--line-strong); }
.chart-target span { position: absolute; right: 0; top: -1.4em; font-size: var(--fs-tiny); color: var(--fg-3); }
.chart-cap { font-size: var(--fs-tiny); color: var(--fg-3); }`;

// 判定落在承重的那条规则上: 没有 fx-sweep 的关键帧, 新配方就会静默失效
export function hasChartKit(css) {
  return /@keyframes\s+fx-sweep-kf\s*\{/.test(String(css ?? '')) && /@property\s+--pv\s*\{/.test(String(css ?? ''));
}
