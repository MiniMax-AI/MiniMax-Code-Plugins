[English](README.md) | **中文**

# HTML 2 Video for mcode

把一句主题、一份大纲或一篇定稿脚本,变成**带口播的成片 MP4**:HTML 幻灯片(分步入场动画)+ TTS 配音 + 烧录字幕,并用 ASR 反向校验"配音是否真的念的是脚本里的话"。

为 MiniMax Code(mcode)定制,也能在其他 Agent 环境里通过 `mmx-cli` 运行。

## 用户能得到什么

用大白话提需求,拿到一条可直接发布的视频:

> 帮我把这份大纲做成一条 60 秒的中文口播视频:三张关键数字、结尾一句行动号召,用深色科技主题,加中文字幕。

产物:

```
my-video/
├── slides/            8 张 HTML + tokens.css(13 套主题、17 种版式配方)
├── audio/             8 段 TTS 音频
├── build/timings.json 实测时长 + 每个视觉层的入场时刻
├── preview/*.png      终态预览帧
├── preview/play/      自包含放映页(不编码也能先过一遍)
└── out/
    ├── final.mp4      ★ 交付成片(1920×1080 或 1080×1920,H.264 + AAC)
    ├── subs.srt       供平台上传的字幕
    └── slide-*.mp4    逐张分段
```

## 流水线

一个技能驱动 12 个脚本,外加八个内部模块(路径收监 / URL 策略 / `no-fx` 规则 / 图表 CSS / 表格 CSS / **受管 CSS 区**——rev 定界 + 原地替换 / 生成物模板与内容指纹 / 扫描上限,都在 `skills/html2video-for-mcode/scripts/` 下):

| 阶段 | 做什么 |
|---|---|
| 1. 开工对齐 | 询问语言(中文/英语/粤语)、风格与品牌色、字幕(不要/单语/双语)、画布(16:9 或 9:16)、时长、音色、素材边界 |
| 2. 信息搜集 | 事实性题材先核查并记录来源,再动笔 |
| 3. 脚本 | 每张 slide 的口播拆成逐句 clauses;每张至少两个信息层、分属不同动画 stage(先后顺序自由) |
| 4. TTS | 配音合成(mcode connector,其他环境用 `mmx-cli`),随后用 ffprobe 实测每段时长 |
| 5. 对时 | 每张时长、每层入场时刻**全部由实测音频推出**,不手写任何秒数 |
| 6. 配图 | 官方素材优先、图片框原语、合规清单登记 |
| 7. HTML | 分步入场动画绑定实测时刻;17 种版式配方 |
| 8. 渲染 | 确定性逐帧步进捕获(动画真正进视频)、ffmpeg 合成与字幕、可选 BGM。真正编码前先用 `preview-page.mjs` 出的放映页在浏览器里过一遍 |
| 9. 校验 | ASR 转写与脚本比对;对比度、主题、渲染前静态闸门 |

## 几个关键设计

- **时序不靠手写**:每张时长与每个动画的入场时刻都来自实测音频,所以"配音念完了画面还在等"在结构上就不可能发生。
- **每张至少两个信息层**,分属不同动画 stage(哪层先入场是判断题 —— 大数字、设问、图都可以先出),不会出现"只有一行大字"的页面;入场顺序是**静态检查**出来的,不靠运气。
- **动画真的进视频**:捕获用逐帧步进而不是录屏,入场动画是渲染出来的,不是冻结在终态。
- **渲染有闸门**:静态检查会拒绝未定义 CSS 变量、图片缺失、外链资源、入场动画缺动画类的页面,也会拒绝"关键帧从不把 `opacity: 0` 基础态抬回来"的入场动画(那类元素会在成片里静默隐形)—— 这些正是"视频看着坏了但每个脚本都报成功"的元凶。
- **受监管题材走合规流程**:财经 / 医疗 / 法律 / 政务类片子开工就问免责声明与出处标注,每个数字钉住口径(口径 + 币种 + 时点),涨跌色按受众市场翻转(A 股 / 港股是红涨绿跌)—— 见 `references/compliance.md`。
- **图表纯 CSS/SVG 自绘,动效可一键关**:不引图表库、不用 canvas(离线取不到,canvas 动画也逐帧 seek 不到);根元素(或任意容器,单张生效)加 `no-fx` 即可关掉全部入场与氛围动效,渲染自动走静态帧、时长不变。图表工具箱还把数据可视化的底线写进模板:条形用动画 `width` 生长(缩放会把数字压扁)、柱高相对绘图区算(保证与数值一致)、网格与柱高共用一把尺子、图表避开字幕带。表格有四种形态(`.tbl` 数据表 / `.kv` 规格表 / `.matrix` 对比矩阵 / `.rank` 排名表),字号与行高按"手机上也要看清"定死。

## 安装

**作为插件(MiniMax Code)**:使用本仓库的 `plugins/Wzdhehe/html2video-for-mcode`,合并后也可从社区目录安装。

**作为独立技能(任意 AgentSkills 宿主)**:

```bash
cp -r html2video-for-mcode ~/.claude/skills/          # 或 ~/.openclaw/skills/
# 项目级安装
cp -r html2video-for-mcode <你的项目>/.claude/skills/
# 或直接从 GitHub 安装
npx skills add Wzdhehe/html2video-for-mcode
```

然后把两个依赖装到**你的视频项目里**(不是技能目录里):

```bash
cd <你的视频项目>
npm i playwright && npx playwright install chromium
# ffmpeg: winget install Gyan.FFmpeg / brew install ffmpeg / apt install ffmpeg
#         或: npm i ffmpeg-static ffprobe-static
```

## 依赖要求

- **Node.js 18+**(纯 ESM,无构建步骤)。
- **ffmpeg / ffprobe**:在 `PATH` 上,或项目里装 `ffmpeg-static` / `ffprobe-static`。脚本按 `PATH → 项目 node_modules → 技能上两级 → 常见安装位置` 探测。
- **Playwright Chromium**:截图用。装在视频项目里即可 —— 脚本会从项目目录、工作目录、npm 全局逐个解析。
- **配音**:三选一 —— mcode 平台 connector、`mmx-cli`(`npm i -g mmx-cli && mmx auth login --api-key sk-...`)、或你自己的 TTS(把音频写到 `audio/<id>.mp3`)。
- 可选:`MINIMAX_API_KEY`,用于 `scripts/asr.mjs` 把配音转写回来与脚本比对(数字、专名、语种)。

## 快速开始

```bash
node <skill>/scripts/init-project.mjs ./my-video --topic "我的主题"
# 填 research/notes.md 与 script.json(clauses = 每句口播一行)
# 合成 audio/01.mp3 … audio/08.mp3
node <skill>/scripts/plan-timings.mjs ./my-video     # 实测音频 → timings.json
node <skill>/scripts/check-slides.mjs ./my-video     # 渲染前静态闸门
node <skill>/scripts/capture.mjs ./my-video --mode still
node <skill>/scripts/preview-page.mjs ./my-video --open   # 放映页: 用户自己先过一遍
node <skill>/scripts/capture.mjs ./my-video --mode motion
node <skill>/scripts/build-video.mjs ./my-video --asr
```

工作流全文(7 阶段、6 个确认闸门)在 `SKILL.md`;`references/` 放着编写规范、配图 SOP、TTS/对时说明与渲染内幕。

`preview-page.mjs` 生成一个自包含的**放映页** `preview/play/index.html`(双击即看,不需要起服务),
它只干一件事:**把 HTML 画面放一遍** —— `←` `→`(或触屏左右滑)翻页、`O` 总览、
`X` 切到同张的 `no-fx` 副本(切过去画面**变空**就说明有关键帧没把 `opacity:0` 的基础态抬回来)。
动效开时箭头是**逐级入场**(按 → 先出下一级,出完才翻页),不等计时器;`T` 现场对比**硬切 / 交叉溶解**
(切页方式渲染前就能定)。两个开关都在底栏。
**刻意不做计时器、进度条、跟读高亮** —— 要看时间或节奏就直接看成片。口播文案面板按数据自动决定:
有文案就列出(`P` 可开/关),没有就整个不出,`--no-script` 也能强制不要 —— 口播还没做时照样能先看画面。
布局一路适配到手机(面板收成可收起的底部抽屉,出现触摸按钮)。副本按 `timings.json` **注入实测延迟**,
所以浏览器里看到的时序就是成片时序(直接打开 `slides/*.html` 不是:那些文件里是占位延迟;没有 timings 时
页面按等间隔预览并在顶部如实标注)。

## 支持平台

Windows / macOS / Linux。脚本全部是 Node ESM,不依赖特定 shell。Windows 上建议用 Git Bash 或 WSL 而非 PowerShell(非 ASCII 路径 + 复杂参数组合容易出问题);ffmpeg 与 Chromium 路径自动探测。

## 网络访问

**只有你主动执行的那一步才会联网**:

- `scripts/asr.mjs` —— HTTPS `POST` 到 `https://api.minimaxi.com/v1/speech_to_text`(海外套餐设 `MINIMAX_REGION=global` 时走 `https://api.minimax.io`)。仅在你运行时。**API Key 只发这两个官方域**:其他 `--base-url` / `MINIMAX_BASE_URL` 取值会在发起请求之前被拒绝,确需自定义网关要显式加 `--allow-any-endpoint`(自担风险)。
- `scripts/fetch-official-images.mjs` —— 打开**你传入的**网址(官方网站,或加 `--allow-file` 的本地 `file://` 页面)以列出并下载候选配图;也可以 `--url <图片URL>` 直接下载你指定的图片(内置浏览器取图那条路走的就是它,不需要 Playwright)。**请求之前先过目标校验**:loopback、链路本地(含云元数据 `169.254.169.254`)、私网与 CGNAT 段、无点主机名、带内嵌凭据的 URL、非 HTTP(S) 协议一律拒绝;重定向**逐跳**复用同一策略;响应大小有上限(默认 30MB,`--max-mb` 可调)。
- 配音合成经由 mcode connector 或 `mmx-cli`,它们会访问 MiniMax。
- 其余全部离线:对时、静态检查、截图、编码、主题对比度校验。

无遥测、无埋点、无隐藏端点、无安装器、无原生二进制。

## 数据使用

- 你写的口播文本会送到你选择的语音服务;产物音频只在你运行 `scripts/asr.mjs` 时才送到 ASR 服务。
- 抓取的素材下载到项目的 `assets/` 目录,并需在 `assets/MANIFEST.md` 登记来源与许可。
- **写入只发生在你传入的项目目录内。** `script.json` 派生出的每个路径(slide 的 `id` / `html` / `audio`、`bgm.file`)都先过校验:id 必须匹配 `^[A-Za-z0-9_-]{1,64}$`,路径必须 resolve 在项目目录内,符号链接逃逸同样拒绝 —— 手改或被注入的 `script.json` 无法让流水线读写或递归删除项目目录之外的东西。
- **不会静默覆盖任何东西。** `init-project.mjs` 对非空目标目录直接拒绝(重新初始化需 `--force`,且只重置它自己生成的 5 个文件);`fetch-official-images.mjs` 与 `prep-image.mjs` 覆盖已存在文件需 `--force`,下载默认收在工作目录内。`--upgrade-css` 更新 tokens.css 里**唯一的 tokens 受管区**(技能生成的整段主体:主题令牌 / `--fs-*` 字号 / fx 关键帧与工具类 / `.fx-stagger`,三个工具箱子块嵌在其中)时按 rev 原地替换。区外还留着的旧副本**按条清理**:逐字来自模块原文的规则会被删掉(它们在层叠上会压过受管区),你自己的规则(包括紧挨副本的一两条覆写)保留并报出;写前先备份 `tokens.css.bak`。你自己的规则要写在**受管区之后**,否则受管区的值优先。`--check-css` 只查不改。
- **不存储、不内嵌任何凭据**:ASR 脚本运行时从 `MINIMAX_API_KEY` 或 `--api-key` 读取,且从不写出到任何文件。
- `KIT_PROJECT_DIR` 是内部变量,由 CLI 入口自动设置,让共用助手能定位项目目录;用户永远不需要自己设置。

## 验证

技能自带可执行测试(`skills/html2video-for-mcode/tests/`,纯 `node:test`,无额外依赖):

```bash
# MiniMax-Code-Plugins monorepo(插件 PR 语境), 在仓库根执行:
node --test "plugins/Wzdhehe/html2video-for-mcode/skills/html2video-for-mcode/tests/*.test.mjs"
# 本技能仓的独立 clone, 在仓库根执行:
node --test "tests/*.test.mjs"
```

十四个文件共 238 例:`safe-paths`(恶意 slide id / 路径、canary 完好性、符号链接逃逸 —— 含**悬空**链接必须被拦下,而不是当"不存在"跳过)、`no-clobber`(覆盖拒绝)、`endpoint-allowlist`(Key 不离开官方域,并用本地服务器证明闸门在请求之前)、`fetch-policy`(SSRF、`file://`、重定向与文件名规则、**IPv4-mapped IPv6 十六进制形式**)、`preview-page`(快照注入实测延迟、`base` 顺序、自包含无外链、越界拒绝、无计时器、**竖版画布、iframe 强制相对解析**)、`tokens-fx`(模板里每个入场动画的关键帧必须声明 `opacity`、`no-fx` 必须重置基础态、`--upgrade-css` 幂等)、`chart-kit`(模板里真带着图表工具箱:keyframes / 注册属性 /「关动效 = 终态」不变量)、`table-kit`(表格原语的可读性硬指标:正文号、行高 ≥72px、涨跌走令牌、矩阵高亮列覆盖表头)、`css-kit`(**整段受管区**:陈旧 / 缺失 / 重复 / 定界符被改坏 / 区外还留着旧副本, 五种都要检出并原地修好 —— 区外副本会在层叠上压过受管区, 这正是本轮重写的起因; 项目端覆写按条保留、老格式裸文本原地包裹而不重复、`--check-css` 退出码、CRLF 不误报、病态互踩一次到位、超大输入拒绝 —— 外加复查在新机制自己身上揪出的两个假绿灯: 受管区是最新的、但区外还留着一份**主体副本**时以前报 `ok`(现在按主体形状识别并报 `legacy-outside`); 项目覆写的 `ok` 提示会点名它**在受管区之前还是之后**(之前则层叠上输, 之后才赢))与 `render-smoke`(init → 对时 → 静态闸门 → 截图 → 成片全链,**still 复截后静态回退必须点名警告**,外加**升级前后画面真的变了的像素级证明**)。`review-round2`(输出收监 canary:项目内符号链接不得写到项目外;本地服务器证明被拒目标收到 0 个请求;单引号属性;ASR 请求失败必须计入失败;项目内 ffmpeg 发现)与 `cover-transition`(封面 + `attached_pic` 流 + 首帧非黑 + 硬切/溶解两种模式下切页点均无黑帧且总时长不变)与 `review-round3`(七个功能缺陷:`--calibrate` 不许写回半份实测、`--topic <值> <项目目录>` 不许把值当目录、`--json` 位置无关、`--min WxH`、`--get` 全失败退非零、`capture --mode/--dsf` 与 `grab-frames --at` 在入口拒绝非法值、字幕带闸门只对定位元素生效、`--dry-run` 打完计划必须退 0、裸字符串 `transition` 在闸门与渲染器里同义;以及 check-slides / capture / build-video 的陈旧 CSS 闸门)与 `subtitles-invalidate`(删掉 clauses 或 `--no-subs` 重建后, 成片里不得再有旧字幕 —— 像素级断言);全套用例需要装好 ffmpeg、ffprobe 与 Chromium(`PATH` 上,或本仓/项目 `node_modules` 里 —— `npm i ffmpeg-static ffprobe-static playwright`):缺了它们,需要这些工具的用例会**带着明确原因跳过**(缺工具、文件系统不允许建 junction),不会假装通过;渲染脚本本身则会明确报 `找不到 ffmpeg` 退出,不会假装跑完半条流水线。scoped workflow `.github/workflows/html2video-for-mcode-smoke.yml`(**位于 MiniMax-Code-Plugins monorepo,本独立仓没有 workflow**)会在插件 PR 与 main 上装齐依赖并把全部用例真跑一遍。

## 排错

`SKILL.md` 末尾有一张"症状 → 原因 → 处置"表,覆盖这条流水线真实踩过的坑:配音念完画面还在等、页面只有标题、元素在 0 秒就入场、未定义 CSS 变量导致文字隐形、**元素入场后永远不出现(关键帧没把 `opacity` 抬回来)**、**切了 `no-fx` 画面反而更空**、**双击 `slides/*.html` 发现动画全挤在开头**、**放映页空白/图裂**、图片 broken、深色主题字幕糊底、音色语种不对、拼接后时长不符、**财经片漏了免责声明或涨跌色反了**。

## 许可

MIT —— 见 `LICENSE`。设计系统的一部分(10 套主题、图片框原语、若干入场动画)改编自
[html-ppt-skill](https://github.com/lewislulu/html-ppt-skill)(MIT,Copyright (c) 2026 lewis);
完整声明与上游 MIT 原文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
