# HTML 设计与内容量规范

## 核心原则:每张 slide 是"一句主张 + 一组展开"

成片最常见的两个败笔,都在authoring阶段就能拦住:

1. **只有标题没有展开** —— 观众 7 秒只看到一行大字,信息量为零。
2. **文字一次性全糊上屏** —— 没有节奏,口播念到后半句时视觉早已无话可说。

解法是强制的三层结构:**标题层 + 展开层 + 视觉锚点(可选),三层分属不同 stage**。口播与画面是同一句话的两个声部。

**层的入场顺序不固定 —— 由叙事决定,标题先行只是默认。** 判据是强同步原则:哪个层被哪句口播提到,就挂在那个 stage。完全合法的变体:

- **大数字先入,标题后出**(stat-highlight 的默认形态):口播第一句就砸数字,数字 s1、说明与标题 s2;
- **设问先出,答案再出**:问题大字 s1 → 答案/数据 s2 → 标题收拢 s3;
- **图先入,文字后落**:主体图 s1 → 关键词标注 s2(图片类题材常用)。

要拦的从来不是"标题不先行",而是**只有一层**:整张停在标题/单块内容上、没有第二个信息层推进。

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

- 除 title-hero/closing 外,**画面视觉块 ≥2 个且分属不同 stage**;"光标题 + 页码"直接打回。**层的先后顺序自由**(数字可以先于标题、设问可以先于答案),错的是"只有一个层",不是"标题不在 s1"。
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

⚠ **字幕安全区(1080 高度下)**:字幕胶囊占**底部 84–168px、居中约 73% 宽**(字号 40px + 上下 padding 12px,距底 7.8%);**这一带不要放正文、数值、图表或图注** —— 否则成片里字幕会直接压在内容上,两个都读不清(2026-09-18 由视觉验收抓到:示例页把图注排在底部,字幕盖上去成了"文字重影")。做法:版面容器 `padding-bottom: 190px` 起步,底部只留 brand/slide-num。

## 素材获取(Phase 3 · Gate 3)

流程:列需求清单(哪几张要图、要什么)→ 按下面的优先级取材 → 合规自查 → 落盘 `assets/` 并登记 `MANIFEST.md` → **Gate 3 给用户过**。

**获取优先级(逐级降级,不硬找):**

1. **官方渠道(首选)**:logo 用官方 brand kit 或 simple-icons(可直接 curl);产品截图截官方 help/文档;数据用官方报告。合规性最强,事实性题材尽量停在这级。
2. **内置浏览器 / Playwright 访问官网提取(2026-09 实测推荐)**:用 agent 的内置浏览器或 Playwright 打开官网/官方新闻页,inspect DOM 提取 `<img>`/`<source>` 资源(校验 src 是官方 CDN 域名,再 `fetch-official-images.mjs --url <URL> --out-dir assets` 落盘 —— 同一套 host/大小/文件名校验)。实测中国 AI 公司题材 6/6 全相关,远好于搜索引擎图搜。开工对齐时用户选了"只用官方素材/纯排版"则整级跳过。
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

以下片段基于 tokens.css + 每张自己的 `<style>`(布局骨架 `.layout/.cols/.cards/.num/.cap` 这类每张内联自定,不来自 tokens.css);只列 `<main>` 内部结构;外层 `.stage`、`.brand`、`.slide-num` 照 `_template.html`。

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
| table | 多行对比 | 标题(s1) + ≥3 行数据表,数值右对齐(s2)。**用 `.tbl` 原语;五种形态与纪律见"表格工具箱"** | 25–40 | 2 句 |
| timeline | 发展历程 | 标题(s1) + ≥4 个时间点(横轴 + 标签)(s2) | 25–40 | 2 句 |
| roadmap | 阶段规划 | 标题(s1) + 3–4 列(NOW/NEXT/LATER 之类)(s2) | 22–35 | 2 句 |
| comparison | 前后 / 优劣对照 | 标题(s1) + 左右两栏加竖分隔(s2) | 22–35 | 2 句 |
| flow-diagram | 流程 / 链路 | 标题(s1) + 3–5 个节点 + 箭头(s2) | 22–35 | 2 句 |
| terminal | 命令行演示 | 标题(s1) + 终端窗口(灯头 + ≥3 行)(s2) | 25–40 | 2 句 |
| big-quote | 大引语转场 | 引语大字(s1) + 署名(s2) | 20–32 | 2 句 |

```html
<!-- kpi-grid: 指标卡 + 语义色涨跌(涨跌一律走 --up/--down, 财经题材按受众翻转这两个即可, 见 compliance.md)
     注意: 布局几何内联在容器 style 里, 不要用没定义过的 .grid/.g4 之类的类(会静默竖排) -->
<div class="fx-stagger" style="--stagger-base:var(--t2);display:grid;grid-template-columns:repeat(4,1fr);gap:var(--sp-4)">
  <div class="card"><p class="eyebrow">REVENUE</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">1248K</div>
    <p style="color:var(--up)">↑ 38% YoY</p></div>
  <div class="card"><p class="eyebrow">RETENTION</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">74%</div>
    <p style="color:var(--warn)">→ 持平</p></div>
  <div class="card"><p class="eyebrow">NPS</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">62</div>
    <p style="color:var(--up)">↑ 9 pts</p></div>
  <div class="card"><p class="eyebrow">CHURN</p>
    <div style="font-size:var(--fs-h2);font-family:var(--font-display)">3.1%</div>
    <p style="color:var(--down)">↓ 0.4 pts</p></div>
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

<!-- timeline: 横轴 + 时间点; 整轴 fx-fade, 每个时间点在容器 fx-stagger 里逐个上浮(口播点到哪个年份, 哪个冒出来) -->
<div class="fx-fade" data-stage="2" style="display:flex;gap:var(--sp-4);margin-top:var(--sp-5)">
  <div class="fx-stagger" style="--stagger-base:var(--t2);display:flex;gap:var(--sp-4);width:100%">
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2021</p><p>成立</p></div>
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2023</p><p>首个产品</p></div>
    <div style="flex:1;border-top:3px solid var(--accent);padding-top:var(--sp-3)">
      <p class="eyebrow">2026</p><p>上市</p></div>
  </div>
</div>

<!-- roadmap: NOW/NEXT/LATER 三列(阶段规划)。当前阶段用 .card-accent 突出; 4 列时 repeat(4,1fr) 并把要点字号压到 var(--fs-tiny) -->
<div class="fx-stagger" style="--stagger-base:var(--t2);display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-4);margin-top:var(--sp-5)">
  <div class="card card-accent">
    <p class="eyebrow" style="color:var(--accent)">NOW · 2026 Q3</p>
    <p style="margin-top:var(--sp-2)">开放平台公测</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">长上下灰度放量</p>
  </div>
  <div class="card">
    <p class="eyebrow" style="color:var(--fg-3)">NEXT · Q4</p>
    <p style="margin-top:var(--sp-2)">多模态 API 定价</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">企业私有化版本</p>
  </div>
  <div class="card">
    <p class="eyebrow" style="color:var(--fg-3)">LATER · 2027</p>
    <p style="margin-top:var(--sp-2)">Agent 应用商店</p>
    <p style="margin-top:var(--sp-1);color:var(--muted)">海外节点</p>
  </div>
</div>

<!-- comparison: 左右两栏 + 竖分隔线 -->
<div style="display:grid;grid-template-columns:1fr 1px 1fr;gap:var(--sp-5);align-items:center">
  <div class="fx-grow" data-stage="2">
    <p class="eyebrow">三年前</p><h3>像高中生</h3><p style="color:var(--muted)">会聊天,常出错</p></div>
  <div style="background:var(--line);height:70%"></div>
  <div class="fx-grow" data-stage="2" style="animation-delay:calc(var(--t2) + 200ms)">
    <p class="eyebrow">今天</p><h3>像研究员</h3><p style="color:var(--muted)">可托付研究级任务</p></div>
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

# 图表工具箱(data-viz 的画法)

图表**全部自绘**,三条底线不变:

1. **禁外链图表库**(Chart.js / ECharts 等 CDN):离线沙箱取不到、违反禁外链铁律,而且 canvas 动画逐帧 seek 不到(会渲染成静止/空白)。
2. **数值必须来自 research/notes.md 里已核实的口径** —— 图表是"把核实过的数字画出来",不是装饰;画不了的口径(缺时点/混币种)先回 Phase 0。
3. **禁止用 AI 生图当图表**(`image generate` 只限抽象概念图):数据图形必须可追溯到来源,生成图不可核查。

图表原语与动效都在 `tokens.css` 里(`.chart*` 与 `fx-grow-w/h · fx-sweep · fx-count · fx-dot`)。**老项目先跑 `node scripts/init-project.mjs <项目> --upgrade-css` 补上**(幂等),否则新配方会静默半死:条形不生长、环形不扫出、数字不滚动。

## 优雅的六条纪律(比加特效重要)

1. **同类同色 + 一条强调**:同一序列的条/柱**同一个颜色**,要突出的那条用 `--accent`(`.chart-bar` 默认),其余加 `.dim`(自动 `color-mix` 弱化成同色系)。彩虹色条形图是最典型的"业余感"来源。**弱化条上的数值不要用白字**——半透明填充配白字读不出来(实测被视觉验收判为"读不清");要么靠 `.chart-bar.dim .chart-val` 自动改用墨色,要么把数值放条外:`<span class="chart-val out chart-num">`(轨道之后,右对齐,墨色)。
2. **别把数字放进被缩放的元素里**:`fx-grow-x` 用 `scaleX`,条内数字会被**横向拉扁**(实测);带标签的条用 `fx-grow-w`(动画 `width`,不变形)。数值一律套 `.chart-num`(等宽 + `tabular-nums`),多位数字滚动时才不抖。
3. **有基线、有细网格**:柱状图靠 `.chart-plot-cell` 的底边做基线(柱子必须待在 plot 容器里 —— 百分比高度若相对整列算,超出剩余空间会被 `flex-shrink` 压回去,**柱高就不再等于数值**,实测 84% 与 72% 画成一样高)+ 网格画在绘图区里、**且要在页面上看得见**(用 `--line-strong`; 网格线若太浅、或只在被柱子盖住的地方显影, 读者读不出刻度, 实测被判 fail),顶边线即轴上限。**柱状图的目标值写在标题行 note 里就行** —— 顶部再画一条虚线会跟最高的柱顶数值标签挤在一起, 被读成负号(实测被判缺陷);bullet 那种轨道图才用 `.chart-target` 竖刻度线。横向条形图给每条轨道加 `.chart-track.grid`(共享 25/50/75% 竖刻度),轨道左缘自带零轴竖线。**行用 `.chart-row` 的 grid 三列(标签/轨道/数值位)定宽** —— 否则"有条外数值的行"轨道会被挤窄,同一张图里出现两把尺子、条长不可比(实测被视觉验收抓到)。轴标签用 `--fs-tiny` + `--fg-3`。图表的精致度大半来自这些"看不见的线"。
4. **一张图只讲一件事**:用 `.chart-note` 把那句话写在标题行右侧(「同比 +38%」「距目标 0.2pp」),别让观众自己算。
5. **零值和极小值要保底**:给 `.chart-bar` 加 `min-height:4px`(或让 `.chart-target` 虚线兜住),否则"0"看起来像"没数据"。
6. **图注写口径与时点**(`.chart-cap`):受监管题材必写(见 compliance.md),其他题材也建议 —— 数字的可信度来自"什么时候、怎么算的"。
7. **标题固定在安全区顶部同一位置, 图表块在剩余空间居中**:图表块应占住安全区(1080 高度下可用约 825px),做法:`h1` 之前留固定上边距、用 `.layout{display:flex;flex-direction:column}` + 图表块外面套一层 `flex:1;display:flex;align-items:center` —— 这样每页标题的 y 位置一致(连播时标题不跳), 图表又在剩余空间里居中(实测两页标题差 170px 会被判 fail)。条形行距/条高可以放大(条高用 `--bar-h`,56–64px 更好看)。上半部挤满、下半部大片空白,成片里就是"整页失衡"(视觉验收实测两次判到)。
9. **柱高必须由数值算出来, 轴从 0 起**:凭手感写 `height:58%` 会让柱高与标注数字不成比例 —— 这不是审美问题, 是**数据失真**(截断纵轴是同一类错)。做法:先定轴上限(如 4.0%),柱高 = 数值 ÷ 轴上限(3.1/4.0 = 77.5%),并把轴上限写进标题或 note("轴 0–4.0%"), 并在左侧用 `.chart-ticks` 标出刻度数值 —— 只写"轴 0–4.0%"却没有任何刻度, 观众无法核验柱高(实测被判为缺陷)。视觉验收实测:三根柱的画法与标注对不上,直接被判 fail。
8. **数值对齐到同一列**:同一张图的所有数值右对齐在同一列(都用 `.chart-val.out`);条内白字只用"只有一条强调条、不与其它行并列"的情形,否则四条数值会分成两列,一眼看出没对齐(视觉验收实测)。

其余照旧:颜色走令牌(涨跌 `var(--up)/var(--down)`,财经按受众翻转),网格 `var(--line)`,数值 `var(--fg)`,图例 `--muted`。**动效是图表的一部分**,且**全套可一键关**(见"动效开关")。

## 动效选型(逐帧 seek 确定性不变,仍是纯 @keyframes)

| 图形 | 用哪个 | 为什么 |
|---|---|---|
| 条形(带标签) | `fx-grow-w` + 内联 `--w:86%` | 动画 `width`,数字不被拉扁 |
| 条形(纯色块) | `fx-grow-x` | transform 更省,反正没文字 |
| 柱状(标签在柱外) | `fx-grow-y` | 标签是兄弟节点,不受缩放影响 |
| 柱状(标签在柱内) | `fx-grow-h` + 内联 `--h:70%` | 同上,避免数字被拉扁 |
| 折线 | `fx-draw`(元素自设 `stroke-dasharray:800`)+ `fx-dot` 落点 | 描边画入天然可 seek;数据点逐个弹出 |
| 环形 / 仪表 | `fx-sweep` + 内联 `--p-to:62` | 锥面渐变随注册属性逐帧重算,**真的扫出来**(不必用 `fx-pop` 硬弹) |
| 大数字 | `fx-count` + 内联 `--n-to:924` | 纯 CSS 计数器滚动;**只支持整数**(小数请拆字段或保持静态) |

错峰一律 `--fx-delay:calc(var(--t2) + N×120ms)`(数据条之间 120–150ms 最好看,超过 200ms 观众会等)。

## 配方

```html
<!-- ① 横向条形图(排名/对比首选): 标签在条外, 数值统一右对齐到同一列(都用 .chart-val.out); 关键一条用默认色, 其余 .dim;
     行宽 = 数值 ÷ 轴上限(这里轴上限 ≈ 2.16 亿 = 1.86/0.86, 所以 1.17→54%、0.67→31%、0.22→10.2%), 别凭手感写百分比;
     一句话用 .chart-note 挂在标题行; 图注写口径+时点 -->
<div class="chart" style="margin-top:var(--sp-5)">
  <div class="chart-head">
    <span class="chart-title">2026 Q2 各产品线营收</span>
    <span class="chart-note">A 产品同比 +38%</span>
  </div>
  <div class="chart-row">
    <span class="chart-lbl">产品 A</span>
    <div class="chart-track">
      <div class="chart-bar fx-grow-w" data-stage="2" style="--w:86%"><span class="chart-val chart-num">1.86 亿</span></div>
    </div>
  </div>
  <div class="chart-row">
    <span class="chart-lbl">产品 B</span>
    <div class="chart-track grid">
      <div class="chart-bar dim fx-grow-w" data-stage="2" style="--w:54%;--fx-delay:calc(var(--t2) + 120ms)"></div>
    </div>
    <span class="chart-val out chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">1.17 亿</span>
  </div>
  <p class="chart-cap">口径: 集团合并报表 · 单位: 人民币 · 截至 2026-06-30</p>
</div>

<!-- ② 柱状图(≤5 个时点): .chart-plot.grid 给细网格, 数值放柱外, 逐个错峰 -->
<div class="chart" style="margin-top:var(--sp-5)">
  <!-- 柱高 = 数值 ÷ 轴上限, 轴必须从 0 起: 3.1/3.5/3.8 对 4.0% 轴 → 77.5% / 87.5% / 95%。
       把轴上限写进标题或 note, 别让读者猜比例尺(凭手感写百分比 = 数据失真) -->
  <div class="chart-head"><span class="chart-title">付费转化率 · 周(轴 0–4.0%)</span><span class="chart-note">目标 4.0%</span></div>
  <div style="display:flex;gap:var(--sp-3);align-items:flex-start">
    <div class="chart-ticks" style="--cols-h:300px"><span>4%</span><span>3%</span><span>2%</span><span>1%</span><span>0</span></div>
  <div class="chart-cols" style="--cols-h:300px">
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:77.5%">
          <span class="chart-val chart-num fx-fade" data-stage="2">3.1%</span>
          <div class="chart-bar dim fx-grow-y" data-stage="2"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2">W08</span>
    </div>
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:87.5%">
          <span class="chart-val chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">3.5%</span>
          <div class="chart-bar dim fx-grow-y" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 120ms)">W10</span>
    </div>
    <div class="chart-col">
      <div class="chart-plot-cell grid">
        <div class="chart-bar-wrap" style="height:95%">
          <span class="chart-val chart-num fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)">3.8%</span>
          <div class="chart-bar fx-grow-y" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)"></div>
        </div>
      </div>
      <span class="chart-lbl fx-fade" data-stage="2" style="--fx-delay:calc(var(--t2) + 240ms)">W12</span>
    </div>
  </div>
  </div>
  <p class="chart-cap">口径: 注册后 7 日内付费 · 来源: 内部指标平台 · 截至 2026-08-15</p>
</div>

<!-- ③ 折线图(>5 个时点): inline SVG, 描边画入 + 数据点逐个弹出; 面积用同色低透明度渐变 -->
<svg class="fx-draw" data-stage="2" viewBox="0 0 900 380" style="width:100%;height:auto" fill="none">
  <defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/>
    <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
  </linearGradient></defs>
  <path d="M40,330 L215,290 L390,300 L565,180 L740,120 L875,88" stroke="var(--line)" stroke-width="1"/>
  <path d="M40,330 L215,290 L390,300 L565,180 L740,120 L875,88 L875,360 L40,360 Z" fill="url(#g1)"/>
  <polyline points="40,330 215,290 390,300 565,180 740,120 875,88"
    stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="800"/>
  <g fill="var(--accent)">
    <circle class="fx-dot" data-stage="2" cx="565" cy="180" r="9" style="--fx-delay:calc(var(--t2) + 500ms)"/>
    <circle class="fx-dot" data-stage="2" cx="875" cy="88" r="9" style="--fx-delay:calc(var(--t2) + 800ms)"/>
  </g>
  <text x="875" y="60" text-anchor="end" fill="var(--fg)" font-size="26" class="chart-num">96.4</text>
</svg>
<!-- fx-draw 的 dasharray 要 ≥ 线长; 数据点用 fx-dot(自带轻微过冲弹入)。**标记规则要统一**: 要么每个点都标、要么只标末点(带数值);
     只给中间某个点标点、又没有对应数值, 视觉验收会读成"没标全"。
     ⚠ SVG 的 viewBox 宽高比要和容器一致, 否则 preserveAspectRatio 会把图形缩到中间一小块(实测: 半个版面里图形只占 40%);
     满宽用 width:100%;height:auto; 半宽/固定高就要把 viewBox 改成接近容器的比例, 别靠 height 硬压 -->

<!-- ④ 环形: fx-sweep 真扫出(--p-to = 目标百分比), 中心数字 fx-count 滚动(--n-to = 整数) -->
<div class="fx-sweep" data-stage="2" style="--p-to:62;position:relative;width:340px;height:340px;border-radius:50%;
     background:conic-gradient(var(--accent) 0 calc(var(--pv) * 1%), var(--panel-2) 0)">
  <div style="position:absolute;inset:52px;border-radius:50%;background:var(--bg);
              display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">
    <span class="fx-count chart-num" data-stage="2" style="font-size:var(--fs-h1);--n-to:62"></span>
    <span style="color:var(--muted);font-size:var(--fs-tiny)">市场份额(%)</span>
  </div>
</div>
<!-- ⚠ 中心数字交给 fx-count 后不要再手写 "62"(计数器会自己填); 小数(62.4)不支持, 保持静态或拆两段。
     fx-count 在入场前是 opacity:0 —— 否则画面会停在"灰色的 0", 被读成"份额 0%/没数据"(视觉验收实测) -->

<!-- ⑤ bullet(实际 vs 目标, 汇报最实用): 一条轨道 + **目标竖刻度线**(标签贴刻度) + 实际条 + 条外数值
     ⚠ 目标标签别贴轨道右端 —— 会被读成"刻度在最右边"; 也别只给轨道加淡色分界, 看不见等于没有 -->
<div class="chart-row" style="margin-top:var(--sp-4)">
  <span class="chart-lbl">年度目标达成</span>
  <div class="chart-track" style="height:26px">
    <div class="chart-bar fx-grow-w" data-stage="2" style="--w:78%"></div>
    <div class="chart-target" style="left:88%"><span>目标 88%</span></div>
  </div>
  <span class="chart-val out chart-num fx-fade" data-stage="2">78%</span>
</div>

<!-- ⑥ slope(前后对比): 两列点 + 斜线, 比双柱更省版面; 主体用 --accent, 对照组用 --line-strong
     ⚠ 纵坐标按数值比例摆点, 而且**要单独画一条 0 基线**: 让对照组那条线兼任基线, 会出现"1M 画在 2M 之上"(实测被判 fail);
        "1M→2M 的间距"和"2M→10M 的间距"必须与数值差成比例, 否则"涨了 10 倍"在图上读不出来(实测被判 fail);
     对照组要如实画: 两年持平就画**水平线**, 并且**两端都标数值**, 标签别压在另一条线上 —— 只标一端、线却明显倾斜, 会被读成"数据不明/自相矛盾"(实测被视觉验收判 fail) -->
<svg class="fx-draw" data-stage="2" viewBox="0 0 720 320" style="width:100%;height:auto" fill="none">
  <text x="0" y="24" fill="var(--fg-3)" font-size="22">三年前</text>
  <text x="720" y="24" text-anchor="end" fill="var(--fg-3)" font-size="22">今天</text>
  <path d="M60,250 L660,90" stroke="var(--accent)" stroke-width="5" stroke-linecap="round" stroke-dasharray="800"/>
  <path d="M60,150 L660,200" stroke="var(--line-strong)" stroke-width="4" stroke-linecap="round" stroke-dasharray="800"/>
  <circle class="fx-dot" data-stage="2" cx="60" cy="250" r="10" fill="var(--accent)"/>
  <circle class="fx-dot" data-stage="2" cx="660" cy="90" r="10" fill="var(--accent)" style="--fx-delay:calc(var(--t2) + 600ms)"/>
  <circle class="fx-dot" data-stage="2" cx="60" cy="150" r="8" fill="var(--line-strong)"/>
  <circle class="fx-dot" data-stage="2" cx="660" cy="200" r="8" fill="var(--line-strong)" style="--fx-delay:calc(var(--t2) + 600ms)"/>
  <text x="60" y="288" fill="var(--fg)" font-size="24" class="chart-num">62</text>
  <text x="660" y="72" text-anchor="end" fill="var(--accent)" font-size="30" class="chart-num">92</text>
</svg>

<!-- ⑦ sparkline(数字旁的迷你趋势, 不占版面): 只有线, 无坐标轴, 用来暗示趋势 -->
<span style="display:inline-flex;align-items:center;gap:12px">
  <span class="chart-num" style="font-size:var(--fs-h2);color:var(--fg)">96.4</span>
  <svg class="fx-draw" data-stage="2" viewBox="0 0 160 48" style="width:160px;height:48px" fill="none">
    <polyline points="4,40 30,34 56,36 82,22 108,18 134,10 156,6"
      stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="300"/>
    <!-- 颜色跟主体走(--accent); 只有"涨/跌"本身是信息时才用 --up/--down。末端补个小圆点收口 -->
  </svg>
</span>
```

选型速查:排名/对比 → 横向条形;时间趋势(≤5 点)→ 柱状,(>5 点)→ 折线;占比(≤3 块)→ 环形;实际 vs 目标 → bullet;前后对照 → slope;数字旁的趋势 → sparkline。**一张 slide 只放一个图**(非放两个就必须分主次或拆张),图注永远要写。

⚠ 整块图表(含图注)要落在**字幕安全区之上**:1080 高度下留给字幕的是底部 84–168px,版面容器请留 `padding-bottom: 190px`。

---

# 表格工具箱(数据表的五种形态)

表格是最容易做丑的一类:行高不够、数字不右对齐、涨跌色用错、满屏网格线。原语都在 `tokens.css` 里(`.tbl / .kv / .matrix / .rank`),**老项目先 `node scripts/init-project.mjs <项目> --upgrade-css` 补上**(幂等),否则这些类全不生效。

## 表格纪律(七条)

1. **主数据用正文号、行高 ≥72px**:`.tbl`/`.kv`/`.matrix`/`.rank` 的正文已是 `var(--fs-body)`(1080p 与手机上都读得清),表头才降到 `--fs-caption`;行高已内置 72px —— 别为了多塞一行把字号或行高压掉(实测 24px 表格在手机上看不清)。
2. **一页一表, 最多 6 行**:超了就拆页或只留 top 5 + "其他"。表格页信息密度天然高,再挤就没人看。
3. **数值右对齐 + 等宽**(`.num`/`.val`):小数点对齐是"专业感"的主要来源;数字用 `tabular-nums`,滚动/切换时不会抖。
4. **涨跌色走令牌**(`.up`/`.down` → `var(--up)/var(--down)`):财经题材按受众翻转(A 股/港股红涨绿跌),见 compliance.md;非财经题材也别用绿红以外的自造色。
5. **只画横线,不画竖线,不要斑马纹**:`.tbl` 的表头下边线 + 行间细线就够了;斑马纹和满格线会让画面变脏。
6. **高亮只给一行**(`.key`:左侧 accent 竖条 + 8% 底色),通常就是"我们/当前阶段";合计行用 `.sum`(上边线加粗)。两者不要同时用在多行上。
7. **表注写口径与时点**(用 `.chart-cap` 同一套):和图表一样,数字的可信度来自"什么时候、怎么算的"。

## 五种形态与配方

```html
<!-- ① 数据表(最常用: 多期/多主体对比, 带涨跌) —— 表头弱化, 数值右对齐, 涨跌走令牌 -->
<table class="tbl fx-fade" data-stage="2">
  <thead><tr><th>季度</th><th class="num">营收</th><th class="num">同比</th><th class="num">毛利率</th></tr></thead>
  <tbody>
    <tr><td>2026 Q1</td><td class="num">3.2 亿</td><td class="num up">+18%</td><td class="num">61.4%</td></tr>
    <tr class="key"><td>2026 Q2</td><td class="num">4.1 亿</td><td class="num up">+27%</td><td class="num">63.8%</td></tr>
    <tr><td>2026 Q3</td><td class="num">3.9 亿</td><td class="num down">-4%</td><td class="num">62.1%</td></tr>
    <tr class="sum"><td>合计</td><td class="num">11.2 亿</td><td class="num up">+14%</td><td class="num">62.4%</td></tr>
  </tbody>
</table>
<p class="chart-cap">口径: 集团合并报表 · 单位: 人民币 · 截至 2026-09-30</p>

<!-- ② 规格表(.kv: 无表头, 左标签右值) —— 参数/条款/清单这类"一对一条目"用它, 比两列表格干净 -->
<table class="kv fx-fade" data-stage="2">
  <tr><td>上下文窗口</td><td>10,000,000 token</td></tr>
  <tr><td>单次最长输出</td><td>128,000 token</td></tr>
  <tr><td>定价(输入 / 输出)</td><td>¥0.8 / ¥2.4 每百万 token</td></tr>
  <tr><td>上线时间</td><td>2026-08-15</td></tr>
</table>

<!-- ③ 对比矩阵(.matrix: 行是维度、列是方案, 只放勾叉; .hi 高亮"我们"那一列, th/td 均可) -->
<table class="matrix fx-fade" data-stage="2">
  <thead><tr><th>能力</th><th>方案 A</th><th class="hi">方案 B(本方案)</th><th>方案 C</th></tr></thead>
  <tbody>
    <tr><td>离线可用</td><td class="no">✗</td><td class="hi yes">✓</td><td class="no">✗</td></tr>
    <tr><td>成本可控</td><td class="no">✗</td><td class="hi yes">✓</td><td class="yes">✓</td></tr>
    <tr><td>交付周期 ≤ 2 周</td><td class="yes">✓</td><td class="hi no">✗</td><td class="yes">✓</td></tr>
  </tbody>
</table>
<p class="chart-cap">口径: 内部评测 · 2026-09 · 勾叉按"是否满足该维度硬指标"判定</p>

<!-- ④ 排名表(.rank: 名次 + 微缩条 + 数值) —— 表格里嵌条形, 比纯数字一眼看出差距 -->
<table class="rank fx-fade" data-stage="2">
  <tr><td class="no">1</td><td>产品 A</td><td class="bar"><span class="fx-grow-w" data-stage="2" style="--w:100%"></span></td><td class="val">1.86 亿</td></tr>
  <tr><td class="no">2</td><td>产品 B</td><td class="bar"><span class="dim fx-grow-w" data-stage="2" style="--w:63%;--fx-delay:calc(var(--t2) + 120ms)"></span></td><td class="val">1.17 亿</td></tr>
  <tr><td class="no">3</td><td>产品 C</td><td class="bar"><span class="dim fx-grow-w" data-stage="2" style="--w:36%;--fx-delay:calc(var(--t2) + 240ms)"></span></td><td class="val">0.67 亿</td></tr>
</table>
<!-- 微缩条的宽度同样 = 数值 ÷ 轴上限(见"柱高必须由数值算出来"那条) -->

<!-- ⑤ 时间事件表(时间 × 事件两列) —— 比 timeline 版式更适合"事件多、要点长"的题材 -->
<table class="kv fx-fade" data-stage="2">
  <tr><td>2021</td><td>团队成立, 首个原型</td></tr>
  <tr><td>2023</td><td>产品上线, 首批 1 万用户</td></tr>
  <tr><td>2026 Q2</td><td>通过聆讯, 递交港股上市申请</td></tr>
</table>



选型速查:多期/多主体对比 → ① 数据表;一对一条目 → ② 规格表(或 ⑤ 时间事件表);几套方案打勾叉 → ③ 对比矩阵;排名看差距 → ④ 排名表;要合计/小计 → ① + `.sum`;价格/评分分档 → ① 的 `.key` 高亮当前档。**表格和图表不要放同一页**(一页一件事);表格页的口播照旧要"读表",别把表格当背景。

# 动效开关(三种粒度)

| 粒度 | 做法 | 效果 |
|---|---|---|
| **整个项目** | `<html data-theme="..." class="no-fx">`(或 `.stage.no-fx`) | 全部入场/氛围动效关闭,元素直接呈终态;motion 捕获检测不到动画窗,自动按静态帧出片,时长与音画同步不受影响;字幕照常烧录 |
| **单张** | 该张根元素加 `no-fx`(tokens.css 的规则按后代匹配,任何容器加都行) | 只有这张无动效,其余张正常 |
| **单个元素** | 不给它 fx 类和 data-stage | 该元素静态呈现 |

适用:赶时间要快速出片、题材要求克制(政务/法律/讣告类)、或用户明确说"不要动画"。开工对齐时可当作一个问题问出去;默认全开。

**图表动效也在开关范围内**:关掉后条形/柱状直接是终值宽度、环形是完整扇形、数字是最终值(它们的静态默认值就写成终值,所以不需要额外复位规则)。

**交付前验一下**:`preview-page.mjs` 的放映页按 `X` 就是"动效 / 关动效"对照 —— 关掉后**变空**说明有关键帧没把 `opacity:0` 抬回来;两版画面一致才算干净。老项目(本规则加上之前生成的 tokens.css)没有 `no-fx` 规则:先跑 `node scripts/init-project.mjs <项目目录> --upgrade-css` 补上(幂等),否则 `<html class="no-fx">` 会静默失效、页面反而全空。

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
