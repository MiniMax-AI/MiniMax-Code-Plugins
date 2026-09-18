---
name: html2video-for-mcode
description: 把脚本/大纲/主题变成带中文口播的成片 MP4(HTML 幻灯片 + TTS + ffmpeg 渲染),为 mcode 环境定制、也可在其他 Agent 环境用 mmx-cli 跑通。当用户想把内容做成视频、html 转 mp4、幻灯片口播视频、slides video、narrated video、一分钟介绍视频、抖音/视频号竖版视频时触发;**只想先看看做好的 HTML 幻灯片、想自己放映一遍或预览动效(口播还没做也行)时同样触发**——技能会生成自包含放映页,不必先花几分钟渲染成片。财经/财报/投研/医疗/政策等**受监管题材**的视频同样触发(需要免责声明与数据口径处理)。也当症状出现时触发——TTS 念完留白过长、画面只有标题没有细节展开、部分元素 0 秒就入场、入场动画没渲染进视频、音画不同步、图片主体被裁到画面外、字幕糊在深色背景上、拼接后总时长不对、字体闪烁或方框、图表或某个元素入场后永远不出现(关键帧没把 opacity 抬回来)、切了 no-fx 画面反而更空、双击 slides/*.html 看动画发现全挤在开头、财经片忘了写免责声明或涨跌色用反。覆盖全流程:开工对齐(领域与免责/风格/字幕/画布/音色/素材边界)→ 信息搜集 → 脚本 → TTS → 实测对时 → 配图 SOP → HTML 分步入场 → 静态闸门与放映页自检 → 逐帧渲染 → ASR 反向校验。工具分两套:mcode 沙箱用 connector__matrix__*(TTS/ASR/音乐),其他环境用 mmx-cli(注意:mmx-cli 无 ASR 与音乐生成,见文末环境对照表)。
---

# HTML 2 Video for mcode:脚本 → 口播成片

把一个主题/大纲变成一条可发布的 MP4(默认 1920×1080,可切 1080×1920 竖版):HTML 幻灯片(分步入场动画)+ 中文 TTS 口播 + ffmpeg 组装 + ASR 反向校验。

## 四条铁律(违反任何一条,产出必然返工)

1. **所有时长只来自 ffprobe 实测,永远不手写。** 每张 slide 的时长 = 该段 TTS 实测时长 + 尾部留白(默认 0.8s)。不估、不凑整、不写死。
2. **TTS 先于 HTML。** 先出音频、实测时长、算好每个视觉层的入场时刻,再写 HTML。动画延迟全部通过 CSS 变量 `--t1/--t2/--t3` 注入,HTML 里不写死秒数。这是消灭"念完留白过长"和"音画不同步"的根本手段。
3. **每个 Gate 等用户确认,不跳步。** Gate 清单见下文工作流。
4. **开工先对齐,不要闷头开跑。** 第一次响应就把下面这批问题一次问清(用户没答的项可用默认值,但**必须先问**),答案即后续所有 Gate 的验收基线:

| 要问的 | 选项 / 默认 |
|---|---|
| **主题与领域** | 题材 + 给谁看 + **属于哪个领域**(财经/商业 · 科技/产品 · 科普/教育 · 品牌/营销 · 文化/历史 · 生活/消费 · 政务/政策),领域决定版式与信息密度;**落在受监管领域(财经投研 / 医疗健康 / 法律 / 政务政策 / 营销效果宣称)必须再问一句"要不要免责声明与数据出处标注"**(默认要)。这一问定三件事:结尾要不要 `.disclaimer` 行、涨跌色要不要按受众翻转、数字要不要带"截至"日期 —— 详见 `references/compliance.md` |
| **语言(必问)** | 口播说什么语言:**中文普通话 `zh`**(默认)/ **英语 `en`** / 粤语 `yue` / 其他 BCP-47。这项决定 4 件事:① 口播稿用哪种语言写;② **音色必须匹配语种**(中文用 `Chinese (Mandarin)_*`、英语用 `English_*`,错配会出怪腔调,写完必须 ASR 验语种);③ 字数/语速基准(中文字/秒 vs 英文词/秒,plan-timings 自动切换);④ ASR 识别语言头(zh 强制普通话,能识破粤语) |
| **风格与配色** | 先按受众给 2–3 个候选主题让用户挑(商务 `minimal-white`/`swiss-grid`/`corporate-clean`;编辑杂志 `editorial-serif`/`magazine-bold`;科技深色 `tokyo-night`/`catppuccin-mocha`/`nord`;消费生活 `xiaohongshu-white`/`soft-pastel`)。**再问一句配色偏好**:直接用主题自带主色,还是有品牌色要指定(给了就按 authoring.md 的"自定义主色"覆写 `--accent` 并跑 check-theme 验对比度) |
| **数据与图表** | 题材里含关键数字、对比、占比或趋势(财报/产品数据/市场对比/进度类)时**必问**:① 有没有值得单独成张的可视化数据;② 要不要图表张、大约几张(默认建议:有硬数据且版式合适 → 1–2 张,纯叙事题材跳过);③ 样式偏好:横向条形 / 柱状 / 环形 / 折线 / 进度条,或"按数据形态让 agent 选"(选型速查见 authoring.md 图表工具箱,全部纯 CSS/SVG、离线可用);④ 图上的数字同受 Gate 0 约束(≥2 独立来源、带口径与时点)。**就算用户没提图表,涉及数据密集的题材也要主动给这个选项** —— 一串可比数字念成 bullets 不如一张图 |
| **字幕** | 不要字幕 / 单语(**与口播同语言**,默认)/ **双语**(主行=口播语言,次行 `text2` = 另一语言,如中文口播配英文字幕)——决定要不要写 text2、要不要 `--no-subs` |
| **画布与平台** | 横屏 1920×1080(默认,适合 B站/官网)或竖版 1080×1920(抖音/视频号/小红书);竖版要换堆叠版式 |
| 时长 | 默认 ~60s(6–10s/张 × 8 张);短视频平台可压到 30s |
| 音色 | 温润男声 / 干练女声 / 其他;给出 3 个候选试听(见 tts-and-timing.md) |
| 素材边界 | 允许网络取官方图 / 只用官方素材 / 纯排版不出图 |

## 目录与工具

技能自带 **11 个命令行脚本 + 6 个内部模块**(直接以本技能目录为路径调用,项目目录作为参数,无需复制;`tests/` 下还有一套 node:test 安全与冒烟测试,从仓库根 `node --test` 自动发现):

| 脚本 | 作用 |
|---|---|
| `scripts/init-project.mjs <项目目录> [--topic "主题名"] [--force] [--upgrade-css] [--check-css]` | 生成项目骨架:目录 + tokens.css + slide 模板 + script.json 契约。**目标目录非空时拒绝执行**(会重置 5 个生成文件),要重新初始化必须显式 `--force`。`--upgrade-css` 把项目 tokens.css 的三个工具箱(no-fx / 图表 / 表格)**受管块**更新到技能当前版——按内容 rev 判定并**原地替换**,不再追加重复段;幂等,写前备份 `tokens.css.bak`,受管块之外的规则(含项目端覆写)不动。`--check-css` 只查不改,落后/缺失逐项报出并退出码 1 |
| `scripts/plan-timings.mjs <项目目录> [--pacing=<每秒字数>]` | ffprobe 实测每段 TTS → 每张时长、各 stage 入场时刻、**每句 clauses 时刻** → `build/timings.json`;`--pacing` 覆写语速基准(语速告警时重估用) |
| `scripts/check-timing.mjs <项目目录> [--calibrate]` | 静音检测实测每句真实开口, 与估算对比;`--calibrate` 按实测校准 timings 后重渲染。静音段数对不上而没校准的张, 用 `asr.mjs --verify-timing` 拿字级时间戳实测句开口 |
| `scripts/check-theme.mjs <项目目录>` | 校验全部主题的 WCAG 对比度(正文/次级/字幕/accent-ink), 不达标退出码 1;新增主题必须过闸 |
| `scripts/check-slides.mjs <项目目录> [--ids 01,02] [--quiet]` | **渲染前静态闸门**:未定义 CSS 变量、缺图/外链资源、`data-stage` 没配 fx 类、fx 关键帧不含 opacity(会永久隐形)、用了无定义的类(静默无样式,提示级)、tokens.css 工具箱落后(提示级)、硬编码颜色、整片级领域自查。有 ✗ 就别截图 |
| `scripts/prep-image.mjs --check <图...>` / `--crop <in> <out> [--ratio 16:9] [--anchor ...] [--force]` | 配图 SOP 的执行辅助:查尺寸与裁切风险;按锚点裁切(强制"裁掉 ≤20%、不放大补边") |
| `scripts/fetch-official-images.mjs <页面URL> [--get 1,3] [--out-dir <目录>] [--min WxH] [--json] [--allow-file] [--max-mb N] [--force]` / `--url <图片URL>[,...]` | 从官方页/本地页面列出并下载候选配图(`--json` 只列候选不下载,`--min` 按尺寸过滤);**站点要登录/滚动加载时,用内置浏览器 inspect 出图片 URL,再用 `--url` 直接落盘(不需 Playwright)**。内网与元数据地址一律拒绝(含 IPv4-mapped IPv6 形式), 每跳重定向复核, 默认写在工作目录内 |
| `scripts/capture.mjs <项目目录> [--mode still\|motion] [--ids 01,02] [--no-subs]` | Playwright 截图。still=终态单帧(会作废该张旧帧目录);motion=逐帧步进入场动画(`--dsf 2` 超采样)。**字幕默认烧录**(内容取自 clauses),`--no-subs` 关闭 |
| `scripts/preview-page.mjs <项目目录> [--open] [--no-script]` | 生成**放映页** `preview/play/index.html`(单文件、零依赖、file:// 双击即看):←→ 或触屏左右滑翻页、R 重播动画、X 动效/关动效对照、P 口播文案开/关、O 总览、F 全屏。**只做"放画面"这件事**:没有计时器/进度条/跟读高亮(要看时间就看成片)。快照按 `timings.json` **注入实测延迟**,所以浏览器里的动画时序 = 成片时序;还没对时则按等间隔预览并如实标注。口播面板按数据自动决定加不加载,窄窗口/手机上收成底部抽屉且默认收起 |
| `scripts/build-video.mjs <项目目录> [--asr] [--dry-run]` | 编码每张 → 拼接 → 音轨对位 → 合成 → 自检 + 出 `out/subs.srt`;`--asr` **按句**切分音频 + 校验清单;`--dry-run` 只打印将要执行的 ffmpeg 命令(排错用) |
| `scripts/asr.mjs <项目目录> [--api-key K] [--verify-timing] [--from <转写>] [--allow-any-endpoint]` | 调 ASR 转写并按句校验音画是否念的是脚本(数字/繁体字不符判 ✗);`--verify-timing` 用字级时间戳实测句开口。Key 只发官方域 |

内部模块(被上面的脚本 import, 不单独运行):`tools.mjs`(ffmpeg/ffprobe 探测 + 路径收监 `safeId/safeRel/inside`)、`url-policy.mjs`(ASR 端点白名单 + SSRF/重定向策略 + 下载文件名)、`nofx-css.mjs`(`no-fx` 规则的唯一来源)、`chart-css.mjs`(图表动效与图表原语的唯一来源)、`table-css.mjs`(表格原语:`.tbl/.kv/.matrix/.rank`)、`css-kit.mjs`(前三个模块的**受管块机制**:rev 定界 + 原地替换 + 落后判定,`--upgrade-css`/`--check-css`/check-slides/preview-page 共用)。三个工具箱以带 rev 定界注释的受管块写进 tokens.css,源模块改动后跑 `--upgrade-css` 即可精确传播到老项目。

环境要求:Node 18+(脚本用 fileURLToPath 保兼容, 不依赖 Node 20.11 的 import.meta.dirname)、`npm i playwright && npx playwright install chromium`(项目目录内)。ffmpeg/ffprobe 自动探测:PATH → node_modules(ffmpeg-static/ffprobe-static)→ 常见安装位置,找不到会给逐条诊断而不是莫名报错。

## 安装到其他 Agent 环境

本技能就是「一个文件夹 + 根目录 SKILL.md」的标准形态(frontmatter 的 `name` / `description` 已按规范写好),放到对应技能目录即可被识别:

```bash
# Claude Code(个人级)/ OpenClaw / 其他兼容 AgentSkills 的工具
cp -r html2video-for-mcode ~/.claude/skills/        # 或 ~/.openclaw/skills/
# 项目级安装
cp -r html2video-for-mcode <你的项目>/.claude/skills/
# 或者把它推到一个 git 仓库后走 skills CLI
npx skills add <repo-url> --skill html2video-for-mcode
```

装完只需再补两件**依赖**(装在你的视频项目里,不是技能目录里):

```bash
cd <你的视频项目目录>
npm i playwright && npx playwright install chromium        # 截图用
# ffmpeg 任选其一: winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg
# 或: npm i ffmpeg-static ffprobe-static
```

**为什么技能装在别处也能跑**:`scripts/tools.mjs` 按「技能自身位置 → 项目目录 → 调用时的工作目录 → npm 全局」逐个锚点解析 `playwright`;ffmpeg/ffprobe 也是四级探测(PATH → 项目 node_modules → 技能上两级 → 常见安装位置)。所以"技能在 `~/.claude/skills/`、依赖装在项目里"是受支持的用法(已实测:技能放到项目树之外仍能出图)。

## 运行环境:两套工具链(同一套脚本,只换工具源)

脚本层(截图 / 渲染 / 合成 / 校验 / 配图)完全环境无关;**只有 TTS、音乐、ASR 三件事依赖平台能力**。

| 能力 | mcode 沙箱(首选) | 其他 Agent 环境(Claude Code / OpenClaw / Cursor 等) |
|---|---|---|
| TTS 合成 | `mcode-tools connector call connector__matrix__batch_text_to_audio --args '{...}'`(≤10 条/批,主用);单条试音用 `connector__matrix__synthesize_speech` | `mmx speech synthesize --text "第一句口播。" --voice <voice_id> --speed 1.0 --out audio/01.mp3`;音色列表 `mmx speech voices` |
| 结果落盘 | `get_asset_url <node_id>` → 下载到 `audio/<id>.mp3` | `--out` 直接写盘 |
| BGM 音乐 | `connector__matrix__batch_text_to_music`(≤5 条/批) | ⚠ **mmx-cli 无音乐生成** → 让用户提供音乐文件(确认授权后登记 MANIFEST),或跳过 BGM |
| ASR 反向校验 | `mcode-tools upload_temp_url` + `connector__matrix__listen_audio` | **`node scripts/asr.mjs <项目目录>`** —— 用同一把 API Key 直调 REST(`/v1/speech_to_text`),不依赖 mcode、也不用装 whisper;**会自动与 checklist 的预期文本比对并回填,数字/繁体字(粤语)不符直接判 ✗**。想用字级时间戳实测句开口:`--verify-timing` |
| 素材配图 | 内置浏览器 inspect 官网 DOM(首选;取到的图片 URL 用 `scripts/fetch-official-images.mjs --url` 落盘)/ 官方 brand kit | 取图路径同左(本环境用 `fetch-official-images`,它自带 Playwright 无头浏览器渲染页面);抽象配图可用 `mmx image generate --prompt "..." --aspect-ratio 16:9 --n 3`(竖版项目用 `9:16`;**仅限抽象概念图,禁止生成 logo / 截图 / 真人头像**),再按 `image-sources.md` 登记 |
| 调研 | `web_search` / `web_fetch`(内置);SPA/JS 渲染页用**内置浏览器**打开取正文(使用纪律见 references/research.md) | `mmx search "关键词"` / `mmx text chat`;SPA 页用项目内 Playwright **无头浏览器**渲染取正文(最小命令见 research.md) |

**mmx-cli 首次配置**(非 mcode 环境):`npm install -g mmx-cli` → `mmx auth login --api-key sk-xxx` → `mmx quota` 验证。401 多半是 region 不匹配:`mmx config set --key region --value cn|global`。脚本侧用 `MINIMAX_API_KEY`(必给)与 `MINIMAX_REGION=cn|global`(可选)对齐同一套身份。

**纪律不因环境而变**:时长仍由 ffprobe 实测、字幕仍来自 `clauses[]`、音色仍要试听并验语种(走上面的 asr.mjs)、Gate 一个都不跳。**搜索与取正文也不限于上表列的工具**:本机装了其他搜索技能/插件(网页搜索、网页阅读类等),或任何无头浏览器(项目内 Playwright 就是),哪个抓得到正文就用哪个 —— 变的只是工具,来源分级、两源交叉、口径标注的纪律一条不能少。

## 工作流(7 阶段 · 6 Gate)

```
开工对齐(铁律 4, 不设 Gate 但必须先做)
Phase 0 信息搜集   → Gate 0 事实清单
Phase 1 脚本设计   → Gate 1 逐张口播稿
Phase 2 TTS + 对时 → Gate 2 试听 + 时长表
Phase 3 素材收集   → Gate 3 素材清单 + 预览 + 合规确认
Phase 4 HTML       → Gate 4 终态截图
Phase 5 渲染 + ASR → Gate 5 成片
Phase 6 交付
```

**顺序是脚手架,不是建议。** 口播稿定了才做 TTS;TTS 时长实测了才动素材和 HTML;素材清单过了 Gate 3 才写进页面;HTML 过了终态截图才渲染。改了口播稿 = 从 Phase 2 重跑(TTS 便宜,重做不贵;带着旧时长硬改才是灾难)。每个 Gate 向用户呈现"验收物清单"里明确的东西,没收到 OK 绝不前进——即使看起来显然,也要确认。

**恢复/继续一个老项目,动工前先做一件事**:`node <技能>/scripts/init-project.mjs <项目目录> --check-css`。工具箱(no-fx/图表/表格)落后就跑 `--upgrade-css`(按 rev 原地替换受管块,不碰你的覆写,自动备份 `.bak`)。**注意升级只改 tokens.css** —— 已生成的 `preview/*.png`、`build/frames/`、`out/*.mp4` 里还是旧 CSS 的画面:受影响张要重跑 capture(still + motion)、重跑 preview-page,再 build-video。判断项目停在哪个 Phase:有 `research/notes.md` 内容→过 Gate 0;`script.json` clauses 已填→Gate 1;`audio/*.mp3` 齐→Gate 2;`assets/` 齐→Gate 3;`slides/*.html` 齐→Gate 4;`build/frames` 或 `out/*.mp4` 在→Gate 5。

### Phase 0 · 信息搜集(条件执行)

**完整方法见 `references/research.md`**(来源分级、query 设计、矛盾处理、notes 模板)。要点:

- 判断标准很简单:成片里会出现具体**数字、日期、名称、引语或归属关系** → 必须搜集。通用/抒情/创意题材可跳过,但"看起来像事实"的句子仍要核实。
- **四条硬规则**:① 关键数字**至少 2 个独立来源**(只有一个就用限定措辞或降级为约数);② **一手优先**(官方公告/财报/技术报告/政府统计),二手转述要回溯原文;③ 标注**口径与日期**(年化还是单季?周活还是月活?币种?);④ **查不到出处或无法判定的,进"不确定项",绝不进口播稿**。
- **正文怎么取**:先 `web_fetch`;SPA/JS 渲染的官网与投资者关系页常只返回空壳,改用 **mcode 内置浏览器**(mcode 环境的宿主能力)或 **Playwright 无头浏览器**(任一环境,项目内已装)渲染后取正文(最小命令见 references/research.md);招股书/财报是 PDF,以 PDF 原文数字为准。新闻稿与媒体转述冲突时以官方原文为准。本机装了其他搜索技能/插件时同样可用——工具开放,纪律不变。
- **受监管领域**(财经/医疗/法律/政策/营销宣称 → 读 `references/compliance.md`)另加三道约束:① 财经数字必须带**口径 + 币种 + 时点**("二季度营收"而不是"目前营收");② 口播**不给操作建议、不预测价格、不用绝对化用语**;③ 免责声明与数据出处(要不要、怎么写、放哪)在 Gate 0 就跟用户敲定,不留到成片阶段返工。
- 输出 `research/notes.md`:每条含 来源 URL + 口径日期 + 等级 + 第二来源;另列"不确定项"与"不该进脚本的内容";受监管题材再记一行**领域 + 免责口径的确认结果**。
- **Gate 0**:事实清单给用户过 —— 重点让用户确认**数字、名称与口径**;受监管题材把免责声明、数据时点、涨跌色一起确认掉。

### Phase 1 · 脚本设计(内容量在这里控制)

在 `script.json` 里逐张填写(契约文件,后续所有脚本都读它):

```json
{
  "topic": "OpenAI 一分钟", "voice": "Chinese (Mandarin)_Gentleman",
  "speed": {"default": 1.0, "first": 0.95, "last": 0.95},
  "fps": 30, "width": 1920, "height": 1080,
  "bgm": "assets/bgm.mp3",
  "slides": [
    {"id": "03", "layout": "bullets", "html": "03-lines.html", "audio": "03.mp3",
     "title": "三大产品线",
     "clauses": [
       {"stage": 1, "text": "三大产品线。"},
       {"stage": 2, "text": "ChatGPT 对话,GPT 系列模型,Sora 视频生成。",
        "text2": "Chat, models, video generation."}
     ]}
  ]
}
```

可选字段:`clauses[].text2` = 双语字幕第二行(不写则纯中文字幕);顶层 `bgm` = `"assets/bgm.mp3"` 或 `{file, volume:0.12, fadeIn:1.5, fadeOut:2.5}`(写了由 build-video 自动循环+淡入淡出垫底)。

**内容量硬规则**(详细版见 `references/authoring.md`):

- 中文口播 ≈ 4.8 字/秒。每张目标 6–10 秒 → 口播 25–48 字;首尾张 12–20 字。单张硬上限 60 字,超了拆两张。
- **每张(除首尾)必须至少两个信息层,映射到不同 stage —— 但层的先后顺序自由**(大数字可以先入、标题后出;设问先出、答案再出;由强同步原则决定:层挂在提到它的那句口播的 stage)。只有标题、没有展开 = 违规,打回。口播也一样:每张至少两句,分别推动不同的层。
- `clauses` 的每个元素是一句口播,`stage` 声明"这句开口时,哪个视觉层该出现"。stage 数 ≈ clause 数,一一对应。
- 版式共 17 种(原 8 + 补充 9:kpi-grid / stat-highlight / table / timeline / roadmap / comparison / flow-diagram / terminal / big-quote),每种画面必含项与字数区间见 `references/authoring.md` 的版式表;**图表(条形/柱状/环形/折线/进度)有纯 CSS/SVG 画法速查,不用外链图表库**。
- **数据密集的题材主动做图**:口播里出现 ≥2 个可比数字、占比或趋势时,优先考虑 `data-viz` 版式 + 图表工具箱,而不是把数字罗成 bullets —— 要不要做、做成什么样式在开工对齐的"数据与图表"里问过;用户当时没提就主动给选项(做图能力是内置的,别让它闲置)。数字必须来自已核实口径(Gate 0),柱高/条长由数值算出(见 authoring.md 九条纪律)。
- 开工对齐时若用户要**双语字幕**,这里就要给每句写 `text2`(同句翻译,不重排语序,≤60 字符)。

**Gate 1**:逐张口播稿 + 版式分配给用户过。**未逐张 OK 不进 Phase 2。**

### Phase 2 · TTS + 实测对时

TTS 走哪套工具见上文"运行环境"对照表(mcode 用 `connector__matrix__*`,其他环境用 `mmx speech synthesize`);命令模板与重试纪律见 `references/tts-and-timing.md`。要点:批量 ≤10 条,部分失败 sleep 10–30s 后**只重试失败项**;首尾张 speed 0.95(但 ≤10 字的短句保持 1.0,见该文件实测坑)。产物落 `audio/<id>.mp3`。

然后对时:

```bash
node <技能目录>/scripts/plan-timings.mjs <项目目录>
```

它会:ffprobe 每段实测时长 → 每张时长 = 实测 + 尾部留白(默认 0.8s,可在 slide 的 `tail` 字段调:紧凑 0.4 / 舒缓 1.2)→ 每个 stage 的入场时刻 = 该句口播按字数占比估算的开口时刻 − 0.2s(视觉略提前于语音,观感同步)→ 每句的开口时刻/时长写入 `clauses[]`(字幕、ASR 按句切分、对时校准共用)→ 写 `build/timings.json`,并输出警告(语速异常、超 15s、末 stage 离收尾太近、单句超 18 字字幕会换行)。

可选但推荐(尤其用户反馈过"音画不同步"时):`node <技能目录>/scripts/check-timing.mjs <项目目录>` 用静音检测实测每句真实开口,输出"估算 vs 实测"对比表;偏差大就 `--calibrate` 校准后删 `build/frames/` 重渲染。注意"体感不同步"也常是设计错位——大数字/主体图必须挂在**提到它的那句**的 stage(强同步原则,见 authoring.md)。

**Gate 2**:全部口播音频逐段试听 + plan-timings 的时长表给用户过。

### Phase 3 · 素材收集(合规在这里把关)

按 `references/image-sources.md` 的配图 SOP 执行(核心原则:**主体不全/半截/比例差的图,先重搜全貌图,别硬裁硬用**),要点:

1. 列需求清单(哪几张要图、要什么)。
2. **优先级:官方渠道(brand kit / simple-icons / 官方文档截图)→ 内置浏览器或 Playwright 打开官网 inspect DOM 取官方资源(实测成功率最高)→ Wikipedia CC → 纯排版降级(数字卡 + 大字 + 引言,不用图)。** 旧 image-downloader(Bing)默认不用:中文冷门题材实测 5/5 返回无关图。
3. 搜图加正向词(全景/全貌/正面/远景),下载前用缩略图筛:主体居中、比例接近、无水印无无关 logo、≥1200px;一张不合适就换,不凑合。
4. 拿到图先跑 `node <技能>/scripts/prep-image.mjs --check <图>` 看尺寸与裁切风险;主体贴边就换图。
5. 每张素材查合规:无水印、商标仅限合理引用语境、照片须可授权来源、截图引用官方文档并注明。
6. 落盘 `assets/`,每个素材一行登记 `assets/MANIFEST.md`(内容/来源/许可)。
7. **禁止凭空生成 logo、截图、头像、二维码;禁止带水印图直接入素材;禁止裸放 `<img>`(必须套 `.img-frame`)。**

**Gate 3**:素材清单表 + 每张素材的预览(缩略图/说明)给用户过,明确问一句"素材来源与授权没问题吗"。**用户过完才写 HTML。**

### Phase 4 · HTML(分步入场在这里实现)

每张一个文件,放 `slides/`,文件名与 script.json 的 `html` 字段一致。约定:

- 根元素 `<html data-theme="...">` 选主题(初版 `a|b|c`,另有 `minimal-white / swiss-grid / corporate-clean / editorial-serif / magazine-bold / tokyo-night / catppuccin-mocha / nord / xiaohongshu-white / soft-pastel`;选主题速查与对比度校验见 authoring.md);引 `tokens.css`;画面容器 `.stage`,含 `.brand` 角标与 `.slide-num` 页码。
- **每个要入场的块加 `data-stage="1|2|3"` + 一个 fx 工具类**(`fx-up/fx-fade/fx-grow/fx-blur/fx-rise/fx-pop/fx-spotlight/fx-ripple/fx-glitch/fx-draw`;氛围类 `fx-pulse/fx-shimmer/fx-kenburns` 不加 data-stage);延迟不用写——管线按 `timings.json` 注入 `--t1/--t2/--t3`。同层错峰用容器 `.fx-stagger`(基准 `style="--stagger-base:var(--t3)"`)或内联 `style="animation-delay:calc(var(--t2) + 150ms)"`。
- ⚠ **`data-stage` 必须与 fx 类同时用**(只有属性没有动画类会永远停在 opacity:0);延迟实现见 authoring.md 的"stage 延迟的实现原理",改动画时不要手写 `animation-delay: var(--tN)`。
- 图片一律套 `.img-frame`(`.contain` 给截图/图表;`--img-ratio` 定比例;`--img-pos` 保主体;图注 `.img-cap` 写在框外)。
- 氛围动画(无限循环的呼吸/漂浮)允许,但不能承载信息、不加 `data-stage`。
- **动效可一键关**:`<html data-theme="..." class="no-fx">` 关整个项目,任何容器加 `no-fx` 关单张,单个元素不给 fx 类即静态。关掉后 motion 捕获自动退化为静态帧出片,时长与音画同步不受影响,字幕照常(详见 authoring.md"动效开关")。
- 禁用 transition 做入场(截图管线 seek 不到),只用 `@keyframes`。禁外部 Google Fonts(离线不稳),用系统字体栈(tokens.css 已配 CJK fallback)。
- 素材只用 Gate 3 已确认的 `assets/` 清单,不新增未审素材。
- 改过项目 `tokens.css`(自定义品牌色、A股涨跌色翻转、字幕钩子 `--sub-bg/--sub-ring`)→ 先跑 `node <技能>/scripts/check-theme.mjs <项目目录>` 验对比度(内置主题未动可跳)。对比度问题拖到 Gate 5 成片才发现是最贵的返工。
- ⚠ **写完 8 张后先跑静态检查再截图**:`node <技能>/scripts/check-slides.mjs <项目目录>` —— 抓未定义 CSS 变量(会导致文字隐形)、图片缺失/外链资源、data-stage 没配 fx 类、硬编码颜色。有 ✗ 就别截图,画面对但"看不见"是最难查的。

写完终态预览(最快路径,给 Gate 4 看):

```bash
node <技能目录>/scripts/capture.mjs <项目目录> --mode still
node <技能目录>/scripts/preview-page.mjs <项目目录> --open   # 放映页: 让用户自己过一遍动效
```

**Gate 4**:`preview/<id>.png` 逐张给用户过(看版式、字压、素材)+ **放映页 `preview/play/index.html` 交用户自己放一遍**(看动效是不是真的都出现了、快慢能不能接受、这张的画面撑不撑得住)。静态图看不出动画——"元素永远不出现""关动效反而空白""列高塌陷"这类故障恰恰只在动起来或切对照时才露头;放映页是 30 秒的自检手段,不必等 3–6 分钟的 motion 编码。时序与口播对轴不在这一步判(放映页刻意不做计时器),以成片和 `timings.json` 为准。**用户过完再进 Phase 5。**

### Phase 5 · 渲染 + ASR 校验

```bash
node <技能目录>/scripts/capture.mjs <项目目录> --mode motion   # 入场动画逐帧进视频
node <技能目录>/scripts/build-video.mjs <项目目录> --asr
```

- `--mode motion`:逐帧步进(暂停全部动画 → 逐帧 seek → 截图 → 编码),动画窗口逐帧渲染、静止段自动补尾帧,时长精确。**字幕默认烧录**(内容取自 clauses、显示窗=该句开口到下句开口,画面底部居中,still 预览里不显示、成片里才有;`--no-subs` 关闭)。成本约 50–200ms/帧,8 张 × 30fps 约 3–6 分钟,预算进超时。赶时间可用 still 模式出片(动画不进视频,只有淡入淡出)。
- ⚠ **still 复截会作废该张帧目录**(capture 的防旧帧污染设计)。Gate 4 之后改了 HTML 想复看 → `capture --mode still --ids <id>` 看效果,**确认后必须对同 ids 重跑 `--mode motion` 再 build-video**;否则该张会退回静态图出片、动画无声丢失(build-video 遇到这种情况会点名 ⚠)。
- build-video 自动:每张编码(统一参数)→ concat 拼接(时长漂移自动回退重编码)→ 音轨按每张实测时长 `apad` 对位 → **BGM 垫底(配了 bgm 才走:循环补满、淡入淡出、人声优先;混音失败自动退回纯人声)** → mux → ffprobe 时长校验 + 全量解码自检,不过关退出码非 0;同时输出 `out/subs.srt`(与烧录字幕同源同窗,中英双语按 clauses 的 text2 自动两行,供平台上传)。
- `--asr`:**按句**切出 `asr/part-<id>-<k>.mp3` + 生成 `asr/checklist.md`。转写与预期文本比对:数字、年份、产品名必须一致;同音字可容忍。**若某段转写混入上一句的开头,说明那句实际开口比估算晚——跑 check-timing 校准。**
  - mcode:`mcode-tools upload_temp_url` 上传后交 `connector__matrix__listen_audio`。
  - **其他环境**:`MINIMAX_API_KEY=sk-xxx node scripts/asr.mjs <项目目录>` —— 直调 REST(同一把 Key),自动比对并回填 checklist;失败项(数字不符/繁体字)会以非 0 退出码报出。想拿更准的开口时刻:`--verify-timing`。
  - 不过关的 slide:改口播或重做该段 TTS → 重跑 plan-timings → 该张重渲染(帧目录删掉对应张即可)。

**Gate 5**:成片 `out/final.mp4` + ASR 校验表给用户过,含字幕可读性检查(静音播放一遍,字幕能否撑起理解)与 BGM 电平(人声是否始终清晰)。

### Phase 6 · 交付

```
out/final.mp4            # 主交付
out/slide-*.mp4          # 单段(可单独发布)
out/subs.srt             # 平台上传用字幕(与烧录字幕同源同窗)
build/timings.json       # 对时的单一事实源(check-timing/asr/preview-page 都读它)
build/audio-timeline.wav # 对位后音轨
preview/*.png  preview/play/index.html   slides/*.html  slides/tokens.css
audio/*.mp3  assets/(含 MANIFEST.md)  research/notes.md  asr/(校验记录)
```

(`slides/tokens.css.bak` 是 `--upgrade-css` 的升级前备份,确认成片无误后可删。)

## 参考文件(按需读,别全读)

- `references/authoring.md` — 17 种版式规范(每种画面必含项)+ 内容量表 + 入场系统用法(含 stage 延迟实现原理)+ **图表工具箱**(图表原语、九条优雅纪律、7 个配方与动效选型)+ **表格工具箱**(四种原语、七条纪律、五种形态)+ 主题速查 + 竖版说明 + 可抄的 HTML 片段
- `references/compliance.md` — 领域与合规(受监管题材必读):领域确认问法、财经口播红线、数字三要件、涨跌色按受众翻转、免责声明写法与位置、医疗/法律/广告法要点、收尾检查清单
- `references/research.md` — 资料搜集(来源分级、交叉验证硬规则、query 设计、矛盾处理、notes 模板)
- `references/image-sources.md` — 配图与素材 SOP(三条取图路径、query 正/反词、两级筛选、图片框用法、裁切硬限制、视觉验证三件套、常见题材索引)
- `references/tts-and-timing.md` — mcode TTS connector 命令、重试纪律、对时算法、留白与语速调校、实测音色表
- `references/render.md` — 渲染原理(为什么逐帧步进、字体怎么等)、字幕系统、BGM 混音、ffmpeg 手工命令、排错表
- `THIRD-PARTY-NOTICES.md` — 第三方组件许可声明(10 套主题与部分 CSS 原语改编自 html-ppt-skill,MIT)

## 常见症状 → 一句话诊断

| 症状 | 根因 | 动作 |
|---|---|---|
| TTS 念完画面还停很久 | 时长是估的不是实测,或 tail 过大 | 重跑 plan-timings;调该张 `tail` |
| 画面只有标题没有展开 | 违反内容量硬规则 | 补展开层 + 对应 clause,回 Phase 1 |
| 动画没进视频 | 用了 still 模式 | motion 模式重出 |
| 音画不同步(体感) | 三选一:手写了动画延迟 / 估算偏差 / 视觉锚点挂错句(强同步原则) | 先删手写延迟;跑 check-timing 拿实测数据,偏差大就 --calibrate;锚点错句则调 stage 映射 |
| 音色语种不对(粤语/繁体) | 平台 voice 标签错位,名称不可信 | Phase 1 试听必须带 ASR 验音(见 tts-and-timing.md 实测音色表) |
| 成片没字幕 | 用了 --no-subs 或 clauses 缺失 | capture 默认烧录;确认 timings.json 有 clauses |
| 要双语字幕 | — | clause 加 `text2`,画面两行 + SRT 双行自动出;第二行建议 ≤60 字符 |
| 想要背景音乐 | — | 顶层 `bgm` 配置,build-video 自动循环+淡入淡出垫底(默认音量 0.12);ASR 校验仍走纯人声轨 |
| 赶时间 / 题材要克制,不要动画 | — | `<html class="no-fx">` 一键关全部动效,或单张容器加 `no-fx`;出片自动走静态帧,时长不变(见 authoring.md) |
| 拼接后总时长不对 | 混用不同编码器参数的段 | 全部段由 build-video 统一编码;已自动回退重编码 |
| 中文方框 | 系统无 CJK 字体 | Linux 装 fonts-noto-cjk;或改用已装字体 |
| 报"找不到 ffprobe/ffmpeg" | 二进制不在 PATH | 脚本已自动探测 PATH→node_modules→常见位置;装 ffmpeg-static 或 winget install Gyan.FFmpeg |
| **一部分元素 0 秒就入场、一部分按时序** | 旧版 tokens.css 的延迟被 `.fx-*` 简写覆盖 | 换用新版 tokens.css(延迟走 `--fx-delay`);原理见 authoring.md |
| 图片主体被裁到画面外 / 图片撑破版式 | 裸放 `<img>`,或 cover 配错比例 | 套 `.img-frame` + `--img-pos` 保主体;截图类改 `.contain`;主体贴边按 SOP 重搜图 |
| 字幕在深色主题下糊在背景里 | 主题没覆写字幕钩子 | 该主题加 `--sub-bg`(更深)+ `--sub-ring: 1px solid rgba(255,255,255,.16)`;跑 check-theme 验 |
| 要出竖版(抖音/视频号) | — | `script.json` 设 `width:1080, height:1920`,版式改堆叠(见 authoring.md 竖版章节) |
| 数字/文字明明写了却看不见 | 未定义 CSS 变量 + `-webkit-text-fill-color: transparent`,整条 background 失效 | 跑 `check-slides.mjs` 定位,补定义或写 `var(--x, 默认值)` |
| 图表/折线/某个元素入场后完全不见 | 该 fx 类的关键帧没声明 opacity —— `[data-stage]` 基础态是 `opacity:0`,只做 transform/描边的动画抬不回来 | 在关键帧的 from/to 里补 `opacity:1`;`check-slides.mjs` 会直接报出来 |
| 切了 `no-fx` 画面反而更空 | 早期模板只关动画、没恢复 `[data-stage]` 的 `opacity:0` 基础态 | 项目 tokens.css 是旧版:`node scripts/init-project.mjs <项目目录> --upgrade-css` 原地更新受管块(幂等);放映页遇到旧 tokens.css 会在副本里兜底注入并明确提示 |
| 技能改了 CSS(或用了新类如 `.chart-ticks`),项目里却不生效 | 项目 tokens.css 的工具箱受管块落后于技能单源(旧判定只看"有没有",补过一次就永远报"无需升级") | `node scripts/init-project.mjs <项目> --check-css` 看状态;`--upgrade-css` 按内容 rev 原地替换受管块(不动你的覆写);check-slides 会在渲染前提示落后 |
| 双击 `slides/*.html` 看动画, 发现全挤在开头 | 动画延迟由管线按 `timings.json` 注入,tokens.css 里只有占位值(`--t2:800ms`) | 别直接开原文件:跑 `preview-page.mjs` 用副本(已注入实测延迟), 或 `--mode motion` 出片 |
| 柱状图柱高与标注数值不符(高柱子被压矮) | 柱子直接放在 flex 列里按百分比设高: 基准是**整列**高度, 超过剩余空间会被 `flex-shrink` 压回去, 静默失真 | 把柱子包进 `.chart-plot-cell`(1fr 行), 百分比就相对绘图区算; 顺带得到基线与各列等高 |
| 折线图缩在版面中间一小块 | SVG 的 `viewBox` 宽高比与容器不一致, `preserveAspectRatio` 把内容等比缩小居中 | 满宽用 `width:100%;height:auto`; 半宽/固定高就把 viewBox 改成接近容器的比例 |
| 图表/图注被字幕压住 | 内容排进了字幕带(底部 84–168px、居中 73% 宽) | 版面容器 `padding-bottom: 190px` 起步; 见 authoring.md 的"字幕安全区" |
| 表格在手机上看不清 | 表格文字用了 caption 号(24px), 或行高被压到 72px 以下 | 用 `.tbl/.kv/.matrix/.rank` 原语:主数据是正文号(30px)、行高内置 72px;见 authoring.md"表格工具箱" |
| 放映页里 iframe 是空白/图裂 | 副本的 `<base href>` 被清掉, 或 slides/ 被移动过 | 重跑 `preview-page.mjs` 重新生成快照;原文件不要手改(副本是快照,改 slides 后必须重跑) |
| 图片显示 broken 图标 | 文件缺失,或 SVG 本身有问题(XML 错/依赖外部资源/缺尺寸) | `check-slides.mjs` 查路径;SVG 改 inline 进 HTML;capture 也会在渲染时点名哪张没加载 |
| 财经片没免责声明 / 涨跌色反了 / 数字被质疑口径 | 开工没确认领域,默认色与默认措辞直接用了 | 读 `references/compliance.md`:结尾补 `.disclaimer` 行(停留 ≥3s)、指标卡改 `var(--up)/var(--down)` 并按受众市场翻转、每个数字补口径+币种+时点 |
| 不知道要不要写免责声明 / 算不算受监管 | 领域没确认 | 开工对齐第一批问题里问"领域 + 要不要免责";财经投研、医疗、法律、政策、营销效果宣称默认要。`check-slides.mjs` 命中财经关键词却没见免责行时会提示 |
