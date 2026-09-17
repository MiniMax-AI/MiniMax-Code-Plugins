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
└── out/
    ├── final.mp4      ★ 交付成片(1920×1080 或 1080×1920,H.264 + AAC)
    ├── subs.srt       供平台上传的字幕
    └── slide-*.mp4    逐张分段
```

## 流水线

一个技能驱动 11 个脚本(`skills/html2video-for-mcode/scripts/`):

| 阶段 | 做什么 |
|---|---|
| 1. 开工对齐 | 询问语言(中文/英语/粤语)、风格与品牌色、字幕(不要/单语/双语)、画布(16:9 或 9:16)、时长、音色、素材边界 |
| 2. 信息搜集 | 事实性题材先核查并记录来源,再动笔 |
| 3. 脚本 | 每张 slide 的口播拆成逐句 clauses;每张必须有"标题层 + 展开层" |
| 4. TTS | 配音合成(mcode connector,其他环境用 `mmx-cli`),随后用 ffprobe 实测每段时长 |
| 5. 对时 | 每张时长、每层入场时刻**全部由实测音频推出**,不手写任何秒数 |
| 6. 配图 | 官方素材优先、图片框原语、合规清单登记 |
| 7. HTML | 分步入场动画绑定实测时刻;17 种版式配方 |
| 8. 渲染 | 确定性逐帧步进捕获(动画真正进视频)、ffmpeg 合成与字幕、可选 BGM |
| 9. 校验 | ASR 转写与脚本比对;对比度、主题、渲染前静态闸门 |

## 几个关键设计

- **时序不靠手写**:每张时长与每个动画的入场时刻都来自实测音频,所以"配音念完了画面还在等"在结构上就不可能发生。
- **每张都有标题层与展开层**,分属不同动画 stage,不会出现"只有一行大字"的页面。
- **动画真的进视频**:捕获用逐帧步进而不是录屏,入场动画是渲染出来的,不是冻结在终态。
- **渲染有闸门**:静态检查会拒绝未定义 CSS 变量、图片缺失、外链资源、入场动画缺动画类的页面 —— 这些正是"视频看着坏了但每个脚本都报成功"的元凶。

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
node <skill>/scripts/capture.mjs ./my-video --mode motion
node <skill>/scripts/build-video.mjs ./my-video --asr
```

工作流全文(7 阶段、6 个确认闸门)在 `SKILL.md`;`references/` 放着编写规范、配图 SOP、TTS/对时说明与渲染内幕。

## 支持平台

Windows / macOS / Linux。脚本全部是 Node ESM,不依赖特定 shell。Windows 上建议用 Git Bash 或 WSL 而非 PowerShell(非 ASCII 路径 + 复杂参数组合容易出问题);ffmpeg 与 Chromium 路径自动探测。

## 网络访问

**只有你主动执行的那一步才会联网**:

- `scripts/asr.mjs` —— HTTPS `POST` 到 `https://api.minimaxi.com/v1/speech_to_text`(海外套餐设 `MINIMAX_REGION=global` 时走 `https://api.minimax.io`)。仅在你运行时。
- `scripts/fetch-official-images.mjs` —— 打开**你传入的**网址(官方网站或本地 `file://` 页面)以列出并下载候选配图。
- 配音合成经由 mcode connector 或 `mmx-cli`,它们会访问 MiniMax。
- 其余全部离线:对时、静态检查、截图、编码、主题对比度校验。

无遥测、无埋点、无隐藏端点、无安装器、无原生二进制。

## 数据使用

- 你写的口播文本会送到你选择的语音服务;产物音频只在你运行 `scripts/asr.mjs` 时才送到 ASR 服务。
- 抓取的素材下载到项目的 `assets/` 目录,并需在 `assets/MANIFEST.md` 登记来源与许可。
- 其余数据全部留在你传入的项目目录内 —— 技能只往这个目录里写东西。
- **不存储、不内嵌任何凭据**:ASR 脚本运行时从 `MINIMAX_API_KEY` 或 `--api-key` 读取,且从不写出到任何文件。

## 排错

`SKILL.md` 末尾有一张"症状 → 原因 → 处置"表,覆盖这条流水线真实踩过的坑:配音念完画面还在等、页面只有标题、元素在 0 秒就入场、未定义 CSS 变量导致文字隐形、图片 broken、深色主题字幕糊底、音色语种不对、拼接后时长不符。

## 许可

MIT —— 见 `LICENSE`。设计系统的一部分(10 套主题、图片框原语、若干入场动画)改编自
[html-ppt-skill](https://github.com/lewislulu/html-ppt-skill)(MIT,Copyright (c) 2026 lewis);
完整声明与上游 MIT 原文见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
