# 渲染原理与排错

## 采集为什么不"等几秒再截图"

固定 sleep 是最脆的等待:慢机器上动画没跑完、字体没换好就截了;快机器上白白多等。capture.mjs 全部用事件驱动:

- **字体**:等每个 `link[rel=stylesheet]` load/error → 对 `document.fonts` 里每个 face 显式 `load()`(`font-display: swap` 会推迟下载,不主动 load 可能永远不取)→ `fonts.ready` → 两次 rAF 让排版落在真实字形上。整体 8s 硬上限。
- **图片**:等所有 `<img>` complete,单图 4s 上限,加载不动就跳过(所以素材必须先落本地)。
- **页面加载**:`domcontentloaded`,不等 `load`/`networkidle`(一个挂起的外链资源会把死等烧进结果)。

## still 模式(终态截图)

所有有限动画直接 `Animation.finish()` 跳到终态(fill-mode forwards 保持),无限氛围动画保持自然运行,截图即"这张讲完时观众看到的画面"。速度:每张 1–2s。

## motion 模式(动画真正进视频)

原理 = 确定性逐帧步进:

1. 所有动画 `pause()` 并 pin 到 `currentTime = 0`。
2. 每帧把**每个动画**的 `currentTime` 统一设为 `i / fps`。CSS 动画自带 `animation-delay`,currentTime 是含延迟的绝对时间,所以各层时序天然正确——这也是为什么 HTML 里不能手写延迟、必须让管线注入 `--t1/--t2/--t3`。
3. 每帧 `page.screenshot()` 存 PNG 序列。
4. 编码时 `tpad=stop_mode=clone` 把最后一帧克隆补满整张时长:只有动画窗口逐帧渲染,静止段零成本。

只拍动画窗口(最长动画 endTime + 0.25s)而不是整张时长,8 张 × 30fps 通常只需 600–1200 帧,约 2–6 分钟(50–200ms/帧)。预算进超时,别中途杀。

限制(由此决定何时退回 still):页面动作必须全部由 CSS `@keyframes` / WAAPI 驱动。`<video>` 元素、`setTimeout` 编排、rAF 物理无法 seek——本套版式规范已禁用这些,正常不会遇到。

## 字幕系统(capture 自动烧录,默认开)

字幕不在 HTML 里写、不需要作者操心:capture 读 `timings.json` 的 `clauses[]`(单一数据源),在页面加载前注入——每句一个 `.kit-sub` 元素,底部居中,胶囊底 + 文字色取自主题钩子(`--sub-bg` / `--sub-fg` / `--sub-ring`,默认深色半透明 + 白字,浅色深色主题都读得清);显示窗 = 该句开口 → 下句开口,做成**全时长百分比关键帧动画**,逐帧 seek 天然工作,still 模式 `finish()` 后自动隐藏(所以 Gate 4 静态预览看不到字幕,字幕验收在 Gate 5 成片)。

**几何全部跟随画布变量**,横竖版都不用改代码:
- 位置 `bottom = --stage-h × 0.0778`(1920×1080 下 = 84px,避开 slide-num)
- 宽度 `max-width = --stage-w × 0.729`(1920 下 = 1400px,竖版自动收窄)
- 字号/内距 `× --sub-scale`(capture 按画布宽度算,竖版收窄到 0.75 下限保证可读)

深色主题务必检查字幕对比:跑 `node scripts/check-theme.mjs <项目>`,它会算"字幕文字 vs 胶囊合成到背景后"的对比度。深色主题建议 `--sub-bg: rgba(0,0,0,.58)` 并加 `--sub-ring: 1px solid rgba(255,255,255,.16)` 做视觉分隔。

### 字幕可读性怎么验(三件套,缺一不可)

1. **数值关** —— 跑 `node scripts/check-theme.mjs <项目>`:它算的是"字幕文字 vs 胶囊合成到背景后"的对比度, <4.5:1 直接判定不通过(这是唯一能自动拦住"字幕糊在深色背景上"的关口)。
2. **帧关** —— 字幕只在成片里出现(still 预览会 finish 掉), 所以要抽 motion 帧看:
   ```bash
   node scripts/capture.mjs <项目> --mode motion --ids 01   # 先出帧
   # 抽某句开口之后的一帧(例: 第 2 句 3.4s → 取 3.6s)
   ffmpeg -y -v error -i build/frames/01/f00108.png -vf "crop=iw:0.22*ih:0:0.70*ih" sub-check.png
   ```
   看三点: 字幕是否出现、有没有被裁掉、底部与页码是否重叠。capture 若发现某张没有 clauses 会直接告警(不会再静默出无字幕片)。
3. **静音关(Gate 5)** —— 关掉声音整片看一遍: 只靠字幕能不能看懂?这是听障视角,也是平台自动字幕的验收标准。

实现细节(排错时知道去哪看):字幕动画被明确排除在"动画窗"计算之外(`.kit-sub` 不参与 animEnd),否则字幕这个全时长动画会把逐帧捕获拉长到整张时长、白拍几倍帧数。clause 带 `text2` 时自动两行(次行 `.kit-sub-2`,小字号低透明度),无需配置。`build-video` 另输出 `out/subs.srt`,与烧录字幕同源同窗(双语时双行),供平台上传。单句 >18 字、text2 >60 字符 plan-timings 会警告。

## 视觉验证三件套(改完 HTML 必走)

不要自欺,三步都要做:

1. **重新截图**:`node scripts/capture.mjs <项目> --mode still`,看 `preview/<id>.png`
2. **核对主体位置**:图片主体在画面中央偏上吗?有没有被裁掉一半?(配图 SOP 见 `image-sources.md`)
3. **抽成片实际帧核对**:`ffmpeg -ss <时刻> -i out/final.mp4 -frames:v 1 frame.png` —— **必须核对 final.mp4 的实际帧**,不要只看截图管线的产物(成片的淡入淡出、字幕时机与截图不同)

关于 stage 时序的归因:先用 `check-timing.mjs` 拿实测数据,再抽成片帧确认;如果"一部分元素 0 秒就入场、一部分正常",那是 tokens.css 的延迟被 `.fx-*` 简写覆盖(见 authoring.md 的实现原理),不是估算偏差。

## 放映页(看动画的最短路径,不用等编码)

`node scripts/preview-page.mjs <项目> [--open]` → `preview/play/index.html`,单文件、零依赖、file:// 双击即看:

| 键 | 作用 |
|---|---|
| `←` `→` / 空格 | 翻页(只加载当前这张,不预跑全部动画) |
| `R` | 重播当前张(换 iframe src = 重新加载 = 动画从 0 开始) |
| `X` | **动效 / 关动效对照**:切到 `preview/play/<name>.nofx.html`(根元素带 `no-fx`)。画面变空 = 有关键帧没把 `opacity:0` 抬回来;两版一致 = 动效设定干净 |
| `P` | 提词面板(该张 clauses,按播放时间高亮当前句);面板下方给"成片 X s · 最后一层入场 ≈ Y s",收尾不足 1.2s 会标红 |
| `O` / `F` | 总览(preview/*.png 缩略图,点击跳转)/ 全屏 |

**为什么要生成副本,而不是直接打开 `slides/*.html`**:动画延迟(`--t1/--t2/--t3`)和画布尺寸由渲染管线按 `timings.json` 注入(capture 走 `addInitScript`),HTML 与 tokens.css 里只有占位默认值。直接双击原文件,`--t2` 是 800ms 而不是实测的 4.9s —— 所有入场动画挤在开头两秒,看到的节奏与成片完全不同(实测:同一张 t=3.0s,副本里第二层还是 opacity 0,原文件里已经可见)。副本把这些值写进 `<html style>`(等价于管线注入,优先级最高),并加 `<base href="../../slides/">` 让 tokens.css 与 `../assets/*` 照常解析。

副本是**快照**:改完 `slides/` 必须重跑 `preview-page.mjs`,否则放映页还是旧画面(副本头部注释会写明真实文件路径)。放映页不烧字幕、不带声音 —— 字幕验收仍以成片为准。

老项目(`--upgrade-css` 之前生成的 tokens.css)没有 `no-fx` 规则,脚本会只给关动效副本兜底注入该规则,并在页面上如实说明。

## BGM 混音(可选)

build-video 检测到 script.json 的 `bgm` 配置时,在音轨对位之后、mux 之前插一步混音:

```
ffmpeg -y -i build/audio-timeline.wav -stream_loop -1 -i assets/bgm.mp3 \
  -filter_complex "[1:a]aresample=44100,aformat=channel_layouts=mono,volume=0.12,\
afade=t=in:st=0:d=1.5,afade=t=out:st=<total-2.5>:d=2.5[bg];\
[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]" \
  -map "[out]" -c:a pcm_s16le build/audio-mix.wav
```

- `-stream_loop -1` 让短 BGM 循环补满全片;`duration=first` 以人声轨长度为准收敛。
- `normalize=0` 必须带:amix 默认按输入数均分音量,**会把人声减半**;normalize=0 保持人声原电平,BGM 只受 `volume` 控制。
- `normalize` 选项需 ffmpeg ≥ 4.4;失败时脚本告警并退回纯人声(不中断出片)。
- 校验方法:`ffmpeg -i out/final.mp4 -af volumedetect -f null -` 看 mean/max 是否比纯人声轨抬高(有 BGM 应抬高);`silencedetect` 在句间空隙处应不再报静音(人声间隙被 BGM 填满)。

## 编码与拼接参数(手工排错用)

单张(帧序列):

```bash
ffmpeg -y -framerate 30 -i build/frames/01/f%05d.png \
  -vf "tpad=stop_mode=clone:stop_duration=99,fade=t=in:st=0:d=0.25,fade=t=out:st=<D-0.35>:d=0.3" \
  -t <D> -c:v libx264 -pix_fmt yuv420p -preset medium -crf 20 -movflags +faststart out/slide-01.mp4
```

- `-framerate` 必须在 `-i` 前(图片序列本身无时间戳,由它定义)。
- `yuv420p` 必须带,否则部分播放器绿屏/黑屏。
- `+faststart` 把 moov 挪到文件头,流媒体即点即播。

拼接:所有段由 build-video 统一编码(同编码器同参数),用 concat demuxer `-c copy` 无损秒拼;拼完 ffprobe 校验,总时长偏离 >0.25s 自动回退 concat filter 重编码(混入外来段时时间基不一致会把 8s 拼成 35s,copy 救不回来)。

音轨对位:每段 `aresample=44100,aformat=channel_layouts=mono,apad=whole_dur=<该张实测时长>` 补齐静音再 concat。**不要用 adelay+concat 的写法**(concat filter 会忽略 adelay 的偏移,所有语音堆到开头)。

## 自检标准

build-video 结束前强制:成片 ffprobe 时长与 timings 总时长差 ≤0.25s;`ffmpeg -v error -i final.mp4 -f null -` 全量解码零错误。任一不过,退出码非 0——看到非 0 不要交付。

## 排错表

| 现象 | 原因 | 处置 |
|---|---|---|
| 成片无声 | 音轨 wav 没生成/mux 失败 | `ffprobe build/audio-timeline.wav` 看时长;重跑 build-video |
| 语音全堆在开头 | 用了 adelay 写法 | 用本脚本的 apad 写法 |
| 拼接后时长暴涨 | 混入了外部编码的段 | 全段由 build-video 统一重编码;它已自动回退 |
| 中文方框 | 系统无 CJK 字体 | Linux: `apt install fonts-noto-cjk`;或字体栈换成已装字体 |
| 字体先丑后正(FOUT) | 外链字体 + 没走 capture 的字体等待 | 素材/字体本地化;确认用 capture.mjs 而非手工截图 |
| 动画没进视频 | 用了 still 模式 | `--mode motion` 重跑该张 |
| 动画层时序不对 | HTML 里手写了动画延迟 | 删掉,靠 --t1/--t2/--t3 注入 |
| chromium 启动失败 | 未装浏览器 | `npx playwright install chromium`(Linux CI 另加 `--with-deps`) |
| 某张段长不对 | 帧目录是旧 timings 的 | 删 `build/frames/<id>/` 重跑 capture;改过 TTS 必须重跑 plan-timings |
| Windows 下路径反斜杠进 concat 失败 | — | build-video 已统一转正斜杠;手工拼 list.txt 时注意 |
| 一部分元素 0 秒就入场、一部分按时序 | 旧 tokens.css:延迟被 `.fx-*` 简写覆盖 | 换新版 tokens.css(`--fx-delay`);见 authoring.md 实现原理 |
| 图片主体被裁到画面外 | 裸放 `<img>` 或 cover 配错比例 | 套 `.img-frame` + `--img-pos`;截图类改 `.contain`;主体贴边按 SOP 重搜 |
| 字幕在深色主题糊底 | 主题没覆写字幕钩子 | 加 `--sub-bg`(更深)+ `--sub-ring`;`check-theme.mjs` 会算这个对比 |
| PowerShell 下 spawnSync 返回 exit -5 或挂起 | 中文路径 + 复杂参数组合在 PowerShell 里易触发 | 改用 Git Bash / WSL 执行脚本,或先 `$env:PATH` 注入二进制目录(本套脚本走 Bash 一贯正常) |
| 数字/文字看不见 | 未定义 CSS 变量使整条 background 失效 + transparent 文字 | `check-slides.mjs`(静态)抓未定义变量;capture 会点名没加载出来的图 |
| 图片 broken 图标 | 文件缺失或 SVG 无效 | 同上;SVG 一律 inline 进 HTML 最稳 |

## 环境差异备忘

- **ffmpeg/ffprobe 探测**:所有脚本统一走 PATH → 项目/仓库 node_modules(ffmpeg-static/ffprobe-static)→ 常见安装位置(winget Links / scoop / C:\ffmpeg\bin);找不到时逐条列出排查项并以退出码 2 结束(区别于业务错误的 1)。
- **Windows**:`python`/`node` 命名、路径分隔符——本套脚本全 Node 实现,无 bash 数组、无八进制陷阱,可直接跑。ffmpeg:`winget install Gyan.FFmpeg` 或 `npm i ffmpeg-static ffprobe-static`。
- **Linux 沙箱(mcode)**:chromium 由 `npx playwright install chromium` 装;需中文字体包;`--with-deps` 补共享库。
- 超采样:capture `--dsf 2` 出 3840×2160 帧,build-video 检测到尺寸不符自动 lanczos 降采,文字边缘更锐;渲染时间约 ×4,成片母版才用。
