# HTML 设计与内容量规范

## 核心原则:每张 slide 是"一句主张 + 一组展开"

成片最常见的两个败笔,都在authoring阶段就能拦住:

1. **只有标题没有展开** —— 观众 7 秒只看到一行大字,信息量为零。
2. **文字一次性全糊上屏** —— 没有节奏,口播念到后半句时视觉早已无话可说。

解法是强制的三层结构:**标题层(stage 1)先出 → 展开层(stage 2)在口播展开句开口时入 → 视觉锚点(stage 3,可选)压轴**。口播与画面是同一句话的两个声部。

## 内容量表(硬规则)

中文口播 ≈ 4.8 字/秒(speed 1.0),每张目标 6–10s。**英语按 ~14 字符/秒(约 150 词/分)**——下表字数是中文口径;英语项目按"词"折半看:每张 14–26 词、硬上限 34 词(plan-timings 会按 `lang` 自动切换基准与预警区间)。

| 版式 | 用途 | 画面必含(缺一即违规) | 口播字数 | clauses 结构 |
|---|---|---|---|---|
| title-hero | 开场主张 | 大标题 + 副题一行 + logo/主题角标 | 12–20 | 1 句 |
| statement | 单点断言 | 断言大字(s1) + 支撑小字(s2) + 视觉锚点(s3 可选) | 18–28 | 2 句 |
| bullets | 并列要点 | 标题(s1) + 3–4 条要点,每条 ≤14 字(s2) | 25–40 | 2 句 |
| compare | 前后对比 | 标题(s1) + 左右两栏各 ≥1 项 + 分隔(s2) | 22–35 | 2 句 |
| data-viz | 数据说服 | 标题(s1) + ≥2 个数字卡/图表(s2) | 25–40 | 2 句 |
| code | 演示调用 | 标题(s1) + 代码块 ≥3 行 + 高亮注释(s2) | 25–40 | 2 句 |
| quote | 引语转场 | 引语大字(s1) + 署名/头衔(s2) | 20–32 | 2 句 |
| closing | 收束 | 一句收束 + logo/CTA | 12–20 | 1 句 |

判定规则(写给执行者,自查用):

- 除 title-hero/closing 外,**画面视觉块 ≥2 个且分属不同 stage**;"光标题 + 页码"直接打回。
- **强同步原则(2026-09 实测教训):每个 stage 的视觉锚点(大数字/关键词/主体图)必须写在触发它的那句口播里,不要放在上一句。**反例:口播第一句就是"三亿人在用",但"3 亿"数字卡挂在 stage 2——观众听到"三亿"时画面没反应,数字卡进场时口播已讲到下一句,体感就是"动画对不上"。正例:第一句只铺垫("它有三个你可能用过的产品"),"3 亿"作为第二句开头,数字卡挂 stage 2 → 声画同时砸出"3 亿",强同步。
- 口播 clauses 与 stage 的映射:**stage k 的视觉在 clause k 开口时入场**。stage 数 ≈ clause 数;多出的视觉层用 script.json 的 `stageTimes` 显式给时刻。
- 单张口播硬上限 60 字;超了说明这张在干两张的活,拆。字幕场景下单句建议 ≤18 字(capture 烧录字幕单行展示);双语时第二行(text2)≤60 字符。
- 数字、专有名词在口播里用中文读法(“九亿”而非“900000000”),画面上才出现阿拉伯数字。(英语项目相反:口播写英文数字读法 “nine hundred million”,画面用 900M。)
- 双语字幕(可选):每句给 `text2` 即自动两行(主行中文 + 次行小字号);text2 是同一句的翻译,不要重排语序。

## 分步入场系统(怎么写 HTML)

tokens.css 已内置,规则只有四条:

1. 要入场的块:`data-stage="1|2|3"` + fx 工具类(`fx-up/fx-fade/fx-grow/fx-draw`)。
2. **不写任何延迟秒数**。`--t1/--t2/--t3` 由渲染管线按 TTS 实测时长注入;浏览器里直接打开时用 tokens 里的占位默认值(0/0.8/2.0s)。
3. 同层错峰(如三条 bullets 依次出现):内联 `style="animation-delay:calc(var(--t2) + 150ms)"`,第二块 +300ms,以此类推。
4. 氛围动画(`fx-pulse` 等无限循环)只能用于装饰(光晕、呼吸点),**不加 data-stage、不承载信息**——它们不参与时长计算,静止截图中可能停在任意相位。

禁令:入场效果不要用 transition(管线逐帧 seek 不到 transition 状态);不要用 JS 定时器编排(setTimeout 驱动的分层,帧步进模式下不会发生);字体不要引外部 Google Fonts(离线环境直接方框),用 tokens.css 的系统字体栈。

### 写 HTML 的三条硬检查(写完立刻跑 `node <技能>/scripts/check-slides.mjs <项目>`)

这三条都是 2026-09 实测踩过的静默故障 —— 画面明显不对,但流水线一路报成功:

1. **变量必须先定义,或带 fallback**。`background: linear-gradient(135deg, var(--coral-a), var(--coral-b))` 里只要有一个变量没定义,整条声明计算为 `none`;若该元素又用了 `-webkit-text-fill-color: transparent`(渐变数字的常规写法),**文字会彻底隐形且不报错**。从别的单页 HTML 抄配色时最容易踩:抄来的变量名(如 `--coral-*`)不在 tokens.css 里。要么在项目 tokens.css 补定义,要么写 `var(--coral-a, #ED3366)` 给默认值。
2. **图片用相对路径且文件必须存在**;`.svg` 建议 **inline 进 HTML**。实测 file:// 下 `<img src="x.svg">` 能正常加载(400px),所以 broken 图标通常不是协议问题,而是 SVG 本身:XML 有误、依赖外部资源/Web 字体、缺 width/height、或下载失败存成了 HTML。inline 一次解决全部。
3. **不要把外部单页的配色/变量整套抄进来**。可抄版式结构,配色必须落到 tokens 变量(`--accent` / `--good` / `--grad` …);硬编码 hex/rgb 换主题时会串色。

## 主题与视觉基调

`<html data-theme="...">`:

- **a · 米白+暖橙**(默认,通用商务):bg `#FAFAF7`,accent `#FF5B2E`,衬线大标题。讲述、观点、人物向。
- **b · 深色+绿**(科技感):bg `#0E0F12`,accent `#10A37F`,高对比数据。产品、AI、开发者向。
- **c · 黑白+蓝**(极简高端):bg `#FFFFFF`,accent `#1F6FEB`。财务、报告、严肃向。

字号纪律:一张 slide 上最多两个层级同屏(标题 + 一个次级);正文 ≥30px,再小就是给审查者找茬。安全边距:内容离边缘 ≥96px(brand/slide-num 除外)。

## 素材获取(Phase 3 · Gate 3)

流程:列需求清单(哪几张要图、要什么)→ 按下面的优先级取材 → 合规自查 → 落盘 `assets/` 并登记 `MANIFEST.md` → **Gate 3 给用户过**。

**获取优先级(逐级降级,不硬找):**

1. **官方渠道(首选)**:logo 用官方 brand kit 或 simple-icons(可直接 curl);产品截图截官方 help/文档;数据用官方报告。合规性最强,事实性题材尽量停在这级。
2. **内置浏览器 / Playwright 访问官网提取(2026-09 实测推荐)**:用 agent 的内置浏览器或 Playwright 打开官网/官方新闻页,inspect DOM 提取 `<img>`/`<source>` 资源(校验 src 是官方 CDN 域名再下载)。实测中国 AI 公司题材 6/6 全相关,远好于搜索引擎图搜。开工对齐时用户选了"只用官方素材/纯排版"则整级跳过。
3. **纯排版降级(永远可用的兜底)**:大字 + 数字卡 + 配色 + 版式本身的表现力。宁缺毋假——没有合适素材就用这级,画面依然成立。

> ⚠ **image-downloader(Bing 搜图)默认不用。** 2026-09-17 实测:中文 AI 公司题材 5/5 关键词返回的全部是无关图(Bing 端返回"猜你喜欢"推荐卡,脚本正则照单全收)。除非题材是英文大众品牌且愿意逐张人工筛,否则不要走这条路。

**合规自查(每个素材过一遍):**

- 无水印。有水印的候选:换一张,或裁到水印外;裁不掉就不用。
- 商标/logo 只在"谈论该品牌"的合理引用语境使用,不做装饰滥用。
- 照片须来自可授权来源(官方新闻图、CC 授权、免费图库);查不到授权的明星/人物照宁可用纯文字引语卡。
- 截图注明出处(官方文档名 + 日期)。

**登记与使用:**

- `assets/MANIFEST.md` 每个素材一行:文件名 / 内容 / 来源 URL 或渠道 / 许可。Gate 3 连同素材预览一起给用户,明确问"来源与授权没问题吗"。
- **禁止凭空生成 logo、截图、头像、二维码;禁止带水印图入素材。**
- **图片必须套框,禁止裸放 `<img>`**:用 `.img-frame`(比例与裁切归框)/ `.img-frame.contain`(截图、图表、带文字的图必须用,不裁切居中留白)/ `--img-ratio`(框比例,不必强求 16:9)/ `--img-pos: top|center|bottom`(控制主体可见区,**替代硬裁的首选**)/ `.img-scrim`(压暗垫白字)/ `.img-cap`(图注,写在框外)/ `.img-tag`(角标)。选图与裁切的完整 SOP 见 `references/image-sources.md`。
- 图片入 HTML 用相对路径 `../assets/xxx.png`;capture 会等图片加载完(每张上限 4s,加载不动就跳过——所以素材必须先落本地,绝不引外链图)。

## 版式片段(可抄)

以下片段都基于 tokens.css,只列 `<main>` 内部结构;外层 `.stage`、`.brand`、`.slide-num` 照 `_template.html`。

**bullets**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">三大产品线</h1>
  <ul>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2))">ChatGPT — 对话</li>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2) + 150ms)">GPT 系列 — 模型</li>
    <li class="fx-up" data-stage="2" style="animation-delay:calc(var(--t2) + 300ms)">Sora — 视频生成</li>
  </ul>
</main>
```

**compare**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">三年,高中生 → 研究员</h1>
  <div class="cols">
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2))">
      <h2>2023 · GPT-3.5</h2><p>会聊天,常出错</p>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 200ms)">
      <h2>今天 · GPT-5.6</h2><p>可托付研究级任务</p>
    </div>
  </div>
</main>
```

**data-viz**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">九亿人每周在用</h1>
  <div class="cards">
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2))">
      <div class="num">9亿</div><div class="cap">周活跃用户</div>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 180ms)">
      <div class="num">$25B</div><div class="cap">年化营收</div>
    </div>
    <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 360ms)">
      <div class="num">92%</div><div class="cap">财富500强渗透</div>
    </div>
  </div>
</main>
```

**code**
```html
<main class="layout">
  <h1 class="fx-up" data-stage="1">一行调用</h1>
  <pre class="fx-fade" data-stage="2"><code>const answer = await openai.responses.create({
  model: "gpt-5.6",
  input: "帮我总结这份报告",
});
console.log(answer.output_text);</code></pre>
</main>
```

**quote**
```html
<main class="layout">
  <blockquote class="fx-up" data-stage="1">“我们想打造的是比人类更聪明的工具,而不是替代人类。”</blockquote>
  <p class="fx-fade" data-stage="2">— Sam Altman, OpenAI CEO</p>
</main>
```

**title-hero / closing**:大标题居中 + 一行副题/CTA,单 stage 即可;closing 可加 logo `fx-grow`。

布局 CSS(`.layout/.cols/.cards/.num/.cap` 等)每张 slide 内联在 `<style>` 里自定,共用值(色、字号、缓动)必须取 tokens 变量,不许硬编码。

---

# 补充版式(2026-09-17 新增 9 个)

原有 8 个版式名不变(老项目的 `layout` 值继续有效),以下是增量选项。**相邻两张不要用同一版式。**

| 版式 | 用途 | 画面必含(缺一即违规) | 口播字数 | clauses |
|---|---|---|---|---|
| kpi-grid | 一组指标 | 标题(s1) + 3–4 张指标卡,带涨跌与语义色(s2)。**涨跌色用 `var(--up)/var(--down)`,A 股/港股受众要按红涨绿跌覆写(见 compliance.md)** | 25–40 | 2 句 |
| stat-highlight | 一个数字定生死 | 巨数字(≥200px,可用 .gradient-text)(s1) + 一句说明(s2) | 15–28 | 2 句 |
| table | 多行对比 | 标题(s1) + ≥3 行数据表,数值右对齐(s2) | 25–40 | 2 句 |
| timeline | 发展历程 | 标题(s1) + ≥4 个时间点(横轴 + 标签)(s2) | 25–40 | 2 句 |
| roadmap | 阶段规划 | 标题(s1) + 3–4 列(NOW/NEXT/LATER 之类)(s2) | 22–35 | 2 句 |
| comparison | 前后 / 优劣对照 | 标题(s1) + 左右两栏加竖分隔(s2) | 22–35 | 2 句 |
| flow-diagram | 流程 / 链路 | 标题(s1) + 3–5 个节点 + 箭头(s2) | 22–35 | 2 句 |
| terminal | 命令行演示 | 标题(s1) + 终端窗口(灯头 + ≥3 行)(s2) | 25–40 | 2 句 |
| big-quote | 大引语转场 | 引语大字(s1) + 署名(s2) | 20–32 | 2 句 |

```html
<!-- kpi-grid: 指标卡 + 语义色涨跌(涨跌一律走 --up/--down, 财经题材按受众翻转这两个即可, 见 compliance.md) -->
<div class="grid g4 fx-stagger" style="--stagger-base:var(--t2)">
  <div class="card"><p class="eyebrow">REVENUE</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">1248K</div>
    <p style="color:var(--up)">↑ 38% YoY</p></div>
  <div class="card"><p class="eyebrow">RETENTION</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">74%</div>
    <p style="color:var(--warn)">→ 持平</p></div>
</div>

<!-- 免责声明行: 受监管题材(财经/医疗/法律/政策)必出; 小字、不抢视觉、停留 ≥3s、口播不念 -->
<p class="disclaimer fx-fade" data-stage="2">
  本视频仅为信息分享,不构成任何投资建议。数据来源:公司 2026 年 Q2 财报(8 月披露),截至 2026-06-30。
</p>

<!-- stat-highlight: 单数字撑满视觉 -->
<div class="fx-pop" data-stage="1" style="font-size:220px;line-height:1;font-weight:900;letter-spacing:-.05em">
  <span class="gradient-text">92</span><span class="gradient-text">%</span>
</div>
<h3 class="fx-fade" data-stage="2" style="margin-top:var(--sp-3)">的准备工作被省掉</h3>

<!-- table: 数值右对齐, 行高要够(1080p 下 ≥72px) -->
<table class="fx-fade" data-stage="2" style="width:100%;border-collapse:collapse;font-size:var(--fs-caption)">
  <thead><tr style="color:var(--fg-3);text-align:left">
    <th style="padding:var(--sp-2) 0">季度</th>
    <th style="text-align:right">营收</th><th style="text-align:right">同比</th></tr></thead>
  <tbody>
    <tr style="border-top:1px solid var(--line)"><td style="padding:var(--sp-3) 0">Q1</td>
      <td style="text-align:right">3.2 亿</td><td style="text-align:right;color:var(--good)">+18%</td></tr>
    <tr style="border-top:1px solid var(--line)"><td style="padding:var(--sp-3) 0">Q2</td>
      <td style="text-align:right">4.1 亿</td><td style="text-align:right;color:var(--good)">+27%</td></tr>
  </tbody>
</table>

<!-- timeline: 横轴 + 时间点, flex 等分 -->
<div class="fx-fade" data-stage="2" style="display:flex;gap:var(--sp-4);margin-top:var(--sp-5)">
  <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
    <p class="eyebrow">2021</p><p>成立</p></div>
  <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
    <p class="eyebrow">2023</p><p>首个产品</p></div>
  <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
    <p class="eyebrow">2026</p><p>上市</p></div>
</div>

<!-- comparison: 左右两栏 + 竖分隔线 -->
<div style="display:grid;grid-template-columns:1fr 1px 1fr;gap:var(--sp-5);align-items:center">
  <div class="fx-grow" data-stage="2">
    <p class="eyebrow">三年前</p><h3>像高中生</h3><p class="dim">会聊天,常出错</p></div>
  <div style="background:var(--line);height:70%"></div>
  <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 200ms)">
    <p class="eyebrow">今天</p><h3>像研究员</h3><p class="dim">可托付研究级任务</p></div>
</div>

<!-- flow-diagram: 节点 + 箭头(用 ▸ 字符, 不引 SVG) -->
<div class="fx-fade" data-stage="2" style="display:flex;align-items:center;gap:var(--sp-3);margin-top:var(--sp-5)">
  <div class="card card-soft">脚本</div><span class="accent" style="font-size:var(--fs-h3)">▸</span>
  <div class="card card-soft">声音</div><span class="accent" style="font-size:var(--fs-h3)">▸</span>
  <div class="card card-accent">成片</div>
</div>

<!-- terminal: 红黄绿灯头 + 等宽字体 -->
<div class="fx-fade" data-stage="2" style="background:#0d1117;border-radius:var(--radius);overflow:hidden">
  <div style="display:flex;gap:8px;padding:14px 18px;background:#161b22">
    <span style="width:14px;height:14px;border-radius:50%;background:#ff5f57"></span>
    <span style="width:14px;height:14px;border-radius:50%;background:#febc2e"></span>
    <span style="width:14px;height:14px;border-radius:50%;background:#28c840"></span>
  </div>
  <pre style="margin:0;padding:var(--sp-4);color:#c9d1d9;font-family:var(--font-mono);font-size:var(--fs-caption);line-height:1.6"><code>$ node build-video.mjs ./proj --asr
<span style="color:#7ee787">✓ 时长 62.27s / 解码零错</span></code></pre>
</div>

<!-- big-quote: 全幅引语, 衬线加大 -->
<blockquote class="fx-blur" data-stage="1"
  style="font-family:var(--font-display);font-size:var(--fs-h1);line-height:1.3;max-width:1500px">
  “我们想打造的是比人类更聪明的工具,<span class="accent">而不是替代人类</span>。”
</blockquote>
```

---

# 主题速查(受众 → 主题)

| 场景 | 主题 |
|---|---|
| 商务汇报 / 融资 / 财报 | `minimal-white` `swiss-grid` `corporate-clean`(另有初版 `a` 米白暖橙) |
| 财经 / 投研(受监管) | 同上三套(数据密度高、色彩克制);**选定后按 `compliance.md` 处理免责行与涨跌色,别只挑主题就开跑** |
| 编辑 / 杂志 / 讲述 | `editorial-serif` `magazine-bold` |
| 科技 / AI / 开发者(深色) | `tokyo-night` `catppuccin-mocha` `nord`(另有初版 `b` 深色科技绿) |
| 消费 / 小红书 / 生活 | `xiaohongshu-white` `soft-pastel`(另有初版 `c` 极简蓝,白底通用) |

选定主题前先跑 `node <技能>/scripts/check-theme.mjs <项目>`:它会算每套主题的对比度,不过闸的主题不要用(尤其深色主题的字幕胶囊对比)。

## 自定义主色(用户给了品牌色时)

主题的主色是令牌,直接覆写即可 —— 在 **项目自己的** `slides/tokens.css` 末尾追加(改项目副本,不动技能模板):

```css
/* 品牌色覆写: 以 software 主题为底, 只换强调色三兄弟 */
[data-theme="minimal-white"] {
  --accent: #E8582A;          /* 品牌主色 */
  --accent-ink: #FFFFFF;      /* 压在主色上的文字色, 写完必须验 */
  --accent-2: #F08A5C;        /* 渐变/次级用色 */
  --accent-3: #B8431E;        /* 深色态 */
  --grad: linear-gradient(135deg, #E8582A, #F08A5C 55%, #B8431E);
}
```

**硬要求**:改完立刻跑 `node <技能>/scripts/check-theme.mjs <项目>` —— `--accent-ink` 对 `--accent` 必须 ≥3:1(低于 4.5:1 就只能用于大字/图形, 不能放小字)。深色主题另需顺手看一眼 `--sub-bg`(字幕胶囊)是否仍与背景分得开。

# 竖版画布(1080×1920)

`script.json` 的 `width/height` 决定画布,渲染管线会把 `--stage-w/--stage-h` 注入页面,字幕几何随之自动收窄。**但版式必须重排**:横屏的左右分栏到竖屏会挤,改成上下堆叠。

- 内容边距从 96px 提到 ~90px(竖屏更窄,可用区更小)
- 标题字号降到 `--fs-h2`(44px)量级 —— 竖屏里 44px 相当于横屏 ~78px 的观感
- 每屏信息量减一档:横屏 3 条 bullets → 竖屏 2 条
- 图片框用 `--img-ratio:3/4` 或 `1/1`,比 16/9 更贴合竖屏构图
- 字幕位置由 `--stage-h` 自动决定,不用手调

# ⚠ 必知:stage 延迟的实现原理(改动前务必读)

入场延迟**不是**独立的 `animation-delay: var(--tN)` 声明,而是写进 `.fx-*` 的 `animation` shorthand 变量槽:

```css
[data-stage="2"] { --fx-delay: var(--t2); }                                    /* 只设变量 */
.fx-rise { animation: fx-rise .9s var(--ease-out) var(--fx-delay, 0ms) both; } /* 变量进 shorthand */
```

**为什么**:`[data-stage="2"]` 与 `.fx-rise` 同为 (0,1,0) 优先级;若拆成两条声明,文件里更靠后的 `.fx-*` 简写会把 `animation-delay` 重置回 0 —— 所有 stage 都在 0 秒入场,而写了内联 `calc(var(--t2)+150ms)` 的元素又是对的,表现为"一部分元素时序诡异、一部分正常"的难查故障(2026-09-17 实测确认)。

**因此**:①不要手写 `animation-delay: var(--tN)`(改用 `--fx-delay` 或内联 calc);②自定义入场动画时,延迟槽必须写 `var(--fx-delay, 0ms)`;③容器要指定基准时刻用 `style="--stagger-base:var(--t3)"`。
