# Changelog

## 1.1.0 — 2026-09-18

**安全边界(响应 PR #41 评审的五条 Request changes)**

- **路径收监**:`script.json` 是 agent 可编辑文件,其 `slides[].id/html/audio` 与 `bgm.file` 此前被直接拼进文件路径。现于 `tools.mjs` 新增 `safeId / safeRel / inside / validateScriptPaths / validateTimingsIds`,六个消费脚本(capture / build-video / plan-timings / check-timing / check-slides / asr)在 `JSON.parse` 后立即校验:id 走白名单 `^[A-Za-z0-9_-]{1,64}$`,路径拒绝绝对路径、resolve 后必须落在项目目录内、并对符号链接做 realpath 复核。此前 `id="../../victim"` 可触发**项目目录外的递归删除**(`capture.mjs` 的 `rmSync(build/frames/<id>, {recursive:true})`)。
- **覆盖拒绝**:`init-project.mjs` 对已存在且非空的目录直接拒绝(列出将被覆写的 5 个生成文件),需显式 `--force`;`fetch-official-images.mjs` 的 `--out-dir` 默认收监在工作目录内、已存在文件不覆盖;`prep-image.mjs --crop` 输出已存在需 `--force`。顺带修 `--topic` 未转义即插入模板 HTML 的问题。
- **ASR 端点白名单**:API Key 只发官方域(`api.minimaxi.com` / `api.minimax.io`);`--base-url` / `MINIMAX_BASE_URL` 指向其他地址一律硬拒绝,自建网关需显式 `--allow-any-endpoint`(打印醒目警告)。此前被偷换的环境变量可把 Key 发往任意端点。
- **抓图 SSRF 收紧**:新增 `scripts/url-policy.mjs`(纯函数)。拦 loopback / 链路本地(含云元数据 169.254.169.254)/ 私网 / CGNAT / 无点主机名;只允许 http(s),`file://` 需显式 `--allow-file`;禁带 userinfo 的 URL;`maxRedirects:0` 手动跟重定向且**逐跳**复用同一策略;响应大小上限默认 30MB(`--max-mb`);落盘文件名清洗补 Windows 保留名。
- **可执行测试**:新增 `tests/`(node:test,零依赖,从仓库根 `node --test` 自动发现 → 被 `npm run check` 真实执行)—— `safe-paths`(恶意 id/路径 + canary 完好性 + symlink 逃逸)、`no-clobber`(覆盖拒绝)、`endpoint-allowlist`(白名单拒绝 + 本地假服务器收到 Bearer 假 Key 的正向证据)、`fetch-policy`(host/URL/重定向/文件名 44 例)、`render-smoke`(init → 静音音频 → plan-timings → check-slides → capture → build-video 全链出片)。首轮 72 例(后续又加了 `preview-page` 与 `tokens-fx`,见下,现共 99 例),本地全绿。另附 scoped workflow `.github/workflows/html2video-for-mcode-smoke.yml`(path-filter 只在本插件变更时跑,装 ffmpeg + playwright 后真实执行,含渲染冒烟)。

**图表与动效**

- `references/authoring.md` 新增 **纯 CSS/SVG 图表**章节:横向条形 / 柱状 / 环形(`conic-gradient`)/ 折线(inline SVG)/ 进度条五种画法与选型速查;三条底线 = 禁外链图表库(离线取不到且 canvas 动画逐帧 seek 不到)、数值必须来自已核实口径、禁止 AI 生图当图表。
- 新增 `fx-grow-x` / `fx-grow-y`(条形从左、柱状从底生长),折线 `fx-draw` 描边画入;**动效可一键关**:根元素或任意容器加 `no-fx`,关掉后 motion 捕获自动退化为静态帧,时长与音画同步不变(实测动画终态 vs `no-fx` 帧 PSNR 51.7dB,画面一致)。
- `timeline` 版式改为整轴淡入 + 时间点逐个错峰入场。

**静默故障(继续加闸门)**

- **fx 关键帧不含 opacity → 元素永久隐形**:`[data-stage]` 的基础态是 `opacity:0`,靠动画抬回 1;只做 transform/描边的动画(`fx-grow-x/y`、既有的 `fx-draw`)不改 opacity 就会永远不可见。关键帧已补 `opacity:1`,并在 `check-slides.mjs` 新增 **5b 项**静态拦截(fx 类的关键帧未声明 opacity → ✗)。
- **旧帧目录污染成片**:切 `no-fx` 或改用 still 后,上一轮 motion 的帧目录仍在,`build-video` 会优先用残留帧把过时动画混进成片;capture 现在在产出静态图的路径上主动作废该张帧目录。
- **柱状图模板高度塌陷**:外层容器写 `align-items:flex-end` 会让列 wrapper 高度塌成内容高,柱子百分比高度变 0(静默不显示);模板改为默认 stretch + 列内 `justify-content:flex-end`,并在文档里写明这个坑。

**放映页(可以先放映一遍再渲染)**

- 新增 `scripts/preview-page.mjs <项目> [--open] [--no-script]` → `preview/play/index.html`:单文件、零依赖、`file://` 双击即看的放映页。**只干「把 HTML 画面放一遍」这一件事**:`←` `→`(触屏左右滑)翻页、`R` 重播入场动画、`X` 动效 / 关动效对照、`P` 口播文案 开 / 关、`O` 总览、`F` 全屏。**刻意不做播放器那套 UI** —— 没有计时器、进度条、逐句跟读高亮:要看时间或节奏就看成片,预览页里跑计时器只会让人盯秒表(实测标签页放着就变成 `204.2s / 6.3s`)。
- **口播 UI 按数据决定加不加载**:有 clauses + 有 `timings.json` → 列出该张口播文案;有 clauses 但还没对时 → 只列文案并标「(未对时)」(口播还没做也能先看 HTML);没有 clauses 或 `--no-script` → 面板与口播按钮完全不出现,画面占满整宽。
- **布局随窗口自适应**:顶栏/底栏可换行、话题名过长省略号;窄窗口与手机上口播面板收成底部抽屉并默认收起(画面优先),手机给触摸条按钮 + 左右滑动翻页,总览网格按宽度自动列数,高度用 `100dvh`(免得被手机地址栏切掉)。
- 为什么不是「直接打开 `slides/*.html`」:延迟 `--t1/--t2/--t3` 与画布尺寸由渲染管线按 `timings.json` 注入,tokens.css 里只有占位值(`--t2:800ms`),直接开原文件会看到「所有动画挤在开头两秒」。放映页生成**快照副本**(`preview/play/<name>.html`),把实测延迟写进 `<html style>`(等价于管线注入,优先级最高)并加 `<base href="../../slides/">` 让主题与素材照常解析。实测:同一张 t=3.0s,副本第二层 `opacity 0`(未入场),原文件 `opacity 1`(已入场)——与成片一致的是副本。**还没对时**则按 HTML 里实际用到的 stage 等间隔排(0.3/1.3/2.3s),页面顶部黄条如实标注「不是成片时序」。
- 副本是快照,改完 `slides/` 必须重跑;页面与副本头部都写明真实文件路径与生成时间。
- 老项目没有 `no-fx` 规则时,只给关动效副本兜底注入该规则并在页面提示(否则切过去是空白,会被误判成「关动效 bug」)。
- 新增 `init-project.mjs --upgrade-css`:给老项目的 `tokens.css` 幂等补上新版 `no-fx` 规则(只动这一个文件,不碰 `script.json` 等其他内容)。此前对所有旧项目的建议「用新版 init-project 重生成」是错的 —— 那需要 `--force`,会重置 `script.json`。
- 新增 `scripts/nofx-css.mjs`:`no-fx` 规则的唯一来源(`init-project` 写入 tokens.css、`preview-page` 兜底注入共用一份,避免 CSS 漂移)。
- `fx-spotlight` 的关键帧补 `opacity: 1` —— 它是本技能文档里列为可用的入场类,但只做 `clip-path`,基础态 `opacity:0` 抬不回来 → 用了就永久隐形(被 `check-slides` 的 5b 项拦住,即「文档说能用、闸门说不能用」)。
- SKILL.md 的 Gate 4 增加「放映页交用户自己放一遍」;`references/render.md` 增放映页章节(定位、键位、口播三态、为什么必须用副本);`authoring.md` 的动效开关一节写明交付前用 `X` 对照验收。
- 测试 +27 例(共 99):`preview-page`(注入/合并/no-fx/base 顺序/自包含无外链/**不做计时器**/**不得出现「配音」字样**/响应式与触摸、口播三态、等间隔兜底、越界拒绝/幂等升级)、`tokens-fx`(对模板断言**每个非无限 fx 动画的关键帧都声明 opacity**、no-fx 规则含 opacity 重置、`--upgrade-css` 幂等且不碰其他文件)。
**文档**

- 开工对齐"主题与受众"→"**主题与领域**"(受监管题材必问免责声明与数据出处标注);新增 `references/compliance.md`(财经口播红线、数字三要件、涨跌色按受众翻转、免责声明写法、医疗/法律/广告法、Gate 清单);`tokens.css` 增 `--up/--down` 与 `.disclaimer`;`check-slides.mjs` 增整片级财经关键词自查。
- **层的入场顺序不再固定为"标题先行"**:改为"每张至少两个信息层、分属不同 stage,顺序由强同步原则决定"(大数字先入 / 设问先出 / 图先入都合法),要拦的是"只有一个层"。
- 补 `roadmap` 版式的 HTML 片段(此前表格里有、代码块缺失),并修 kpi-grid 片段使用未定义类 `.grid g4`(会静默竖排)的问题。

## 1.0.1 — 2026-09-17

**新增:领域与合规(受监管题材)**

- `references/compliance.md`(新)— 领域确认问法(题材 + 受众 + 是否受监管)、财经口播三条红线(不给操作建议 / 不预测价格 / 不编数据图形)、数字三要件(**口径 + 币种 + 时点**)、涨跌色按受众翻转(A 股/港股 = 红涨绿跌)、免责声明写法与位置(`.disclaimer`,停留 ≥3s,口播不念也不进字幕)、医疗 / 法律 / 政务 / 广告法要点、Gate 收尾检查清单
- **开工对齐**第一批问题从"主题与受众"升级为"**主题与领域**":受监管题材(财经投研 / 医疗健康 / 法律 / 政务政策 / 营销效果宣称)必须多问一句"要不要免责声明与数据出处标注"(默认要),并把结论记进 Gate 0 与 `research/notes.md`
- `tokens.css` 新增 `--up` / `--down` 涨跌专用令牌(默认 = `--good` / `--bad`)与 `.disclaimer` / `.disclaimer-box` 原语(纯附加,旧项目与既有主题不受影响)
- `check-slides.mjs` 新增**整片级领域自查**:命中多个财经/投研关键词却没有免责或出处行 → 给出提示(提示而非错误;用户已明确不要免责可忽略)
- `research.md` 增"先确认领域"与财经/投研题材坑(同比≠环比、GAAP≠非GAAP、把旧时点当"目前");`authoring.md` 增免责声明片段、kpi-grid 改用 `var(--up)/var(--down)`、主题速查增财经行;`evals` 增 2 条(财经开局确认、涨跌色按受众)

## 1.0.0 — 2026-09-17

首个公开版本。

**流水线**:开工对齐(语言/风格/字幕/画布/音色/素材边界)→ 信息搜集 → 脚本 → TTS → 实测对时 → 配图 → HTML 分步入场 → 逐帧渲染 → ASR 反向校验,共 7 阶段 6 个确认闸门。

**脚本(11 个,纯 Node,无构建步骤)**

| 脚本 | 作用 |
|---|---|
| `init-project.mjs` | 生成项目骨架(目录 + tokens.css + slide 模板 + script.json 契约) |
| `plan-timings.mjs` | ffprobe 实测每段 TTS → 时长、每层入场时刻、每句开口时刻 |
| `check-timing.mjs` | 静音检测实测每句真实开口,与估算对比并可校准 |
| `check-theme.mjs` | 全部主题的 WCAG 对比度闸门(正文/次级/字幕/强调色) |
| `check-slides.mjs` | 渲染前静态检查(未定义变量/图片缺失/外链/data-stage 未配动画/硬编码颜色) |
| `capture.mjs` | 终态截图或逐帧步进捕获,字幕默认烧录 |
| `build-video.mjs` | 编码 → 拼接 → 音轨对位 → BGM 混音 → 合成 → 自检 + SRT |
| `asr.mjs` | ASR 转写与脚本比对(直调 REST),支持字级时间戳核对开口时刻 |
| `prep-image.mjs` | 配图检查与受限裁切(裁掉面积上限 20%) |
| `fetch-official-images.mjs` | 从官方站点列取并下载候选素材图 |
| `tools.mjs` | ffmpeg/ffprobe 与 Node 包的多锚点探测 |

**设计系统**:13 套主题、17 种版式、图片框原语(`.img-frame`)、14 个入场/氛围动画、分步入场与错峰容器。

**语言**:中文普通话 / 英语 / 粤语,字数与语速基准、字幕行宽、ASR 语言校验随语言切换。

**画布**:1920×1080 横屏与 1080×1920 竖版(字幕几何随画布比例自适应)。

**字幕**:单语或双语烧录,另出 `out/subs.srt`。

**声音**:BGM 垫底(可选,自动循环与淡入淡出)、ASR 反向校验(音色语种、数字与专名一致性)。

**资料搜集**:`references/research.md` —— 来源四级分级、四条硬规则(多源交叉验证/一手优先/标注口径日期/不确定不进脚本)、query 设计、多源矛盾处理、notes 模板、各环境搜索工具差异(含 mmx search 10 条上限)。

**两套工具链**:mcode 沙箱用 platform connectors;其他 Agent 环境用 mmx-cli(配 TTS)与本仓 `asr.mjs`(配 ASR)。

**已修复的静默故障(均加了闸门)**

- 入场延迟被 `animation` 简写覆盖 → 元素在 0 秒入场(改用变量槽传递延迟)
- 未定义 CSS 变量 + 透明文字填充 → 文字完全隐形(check-slides 静态拦截)
- 图片加载失败 → 只出 broken 图标而无报错(capture 运行期点名)
- 缺少 clauses → 静默出无字幕片(capture 告警)
- 字幕窗口重叠 → 相邻两句同时可见, 看起来像"重影/错字"(淡出改为在窗口内归零, 并加窗口自检)
- 主题覆盖被忽略、同名选择器只取首个块(check-theme 合并语义修正)
