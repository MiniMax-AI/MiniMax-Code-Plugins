# jianying

> 用**逐像素复刻的剪映调色链**给视频调色，出 **10bit / 保留原音轨**的成片 —— 不需要剪映 GUI。

> **平台：仅 Windows。** 依赖本机的剪映 11.6 运行时与一个**活的**剪映进程（草稿读写与官方渲染都走剪映的
> 本机命名管道）。调色与出片本身不需要打开剪映界面，但草稿相关动词需要剪映在运行。

## 解决什么问题

剪映的调色（亮度/对比/饱和/色温/分色/对数轮/曲线/HSL 曲线/锐化/暗角…）只有官方 app 能算。
想把调色纳入 AI 自动化流水线（改参数 → 出片 → 再改），有两条路：

1. **官方导出器** —— 官方 CLI 侧被 `−100007`（会话模式不支持）与 `−100015`（未授权宿主进程）挡死，
   且 CLI 构建比 app 早 5 天 ⇒ 命令树注册表错位。**这是官方侧的问题，我们不绕。**
2. **自己复刻**（本插件）—— 把官方的调色数学逐 feature 复刻出来（13/13 逐像素对齐，误差 ≤ 1 LSB），
   自己出片。

⇒ 本插件走第 2 条：**MCP 提供 10 个原子动词**（草稿读写 / 调色 / 出片 / 混音 / 渲染 / 验收），
**Skill 提供 7 条"有自己中间思路 + 门禁"的剪辑链路**（含一条跨链流水线：一件事做完时按它串联）。

## 试一下

**示例提示词**（可直接粘给 MiniMax Code）：

```text
给这个视频调色出片，风格用暖一点的，输出到 out\cut\demo.mp4
```

**预期结果**：

1. 插件先跑 `check-env` 环境自检，缺依赖会直接报缺哪一个。
2. `grade_apply` 按 `spec` 出片，产出 `graded10.mp4`（逐点直算，推荐）与 `graded_lut.mp4`（65³ LUT 形态）。
3. 同一个动词返回**逐节点生效探针**：`adjustColor` / `logWheel` / … 每一项的 MAD 都必须非零，
   任何一个为 0 ⇒ 动词**直接判失败**（而不是"链看着跑通、实际少一个节点"）。
4. 返回全链改变量 `grade_change_mad`（实测 > 0）与产物路径。
5. 画面验收用 `verify_diff` 对改前/改后帧做**全帧最大**像素差；注意官方渲染器本身有噪声底，
   像素结论要带 `noiseDir` 校准（见 `skills/jianying-verify/SKILL.md`）。

**示例提示词二（给剪映草稿出成片）**：

```text
把这个剪映草稿出成片，输出到 out\cut\demo.mp4
```

⇒ 走 `make_film`：**官方渲染器出画面** → 可选我们的 3D LUT（曲线类调色）→ **我们的混音链**
（音量 / 淡入淡出 / 降噪 / 响度归一）→ ffmpeg 编码 → **带断言的验收**
（双流齐备 + 时长对齐官方时间线 ±1 帧 + 响度偏离 ≤1 LUFS ⇒ 否则判失败）。
★ **曲线参数由我们自己的接口给**（`grade` 字段），不需要你在剪映里先存一份带曲线的草稿。

也可以直接调动词：

```bash
node scripts/run-verb.mjs --list
node scripts/run-verb.mjs grade_apply '{"src":"<源视频.mp4>","outDir":"<输出目录>","spec":{"adjustColor":{"brightness":0.1,"temperature":0.15}}}'
```

## 10 个动词

| 动词 | 作用 |
|---|---|
| `draft_open` | 打开草稿（默认只读副本） |
| `draft_read` | 读草稿语义结构（时间线/片段/素材） |
| `draft_patch` | 语义级修改（**官方行为操作全集：18 域 / 199 个，桥全部放行**；含加字幕、调色写回入口） |
| `draft_commit` | 落盘（自动素材路径重定位 + 真草稿 sha 断言） |
| `render_frames` | 用官方渲染器出帧/mp4 |
| `grade_apply` | 调色（10 节点链）+ 出 10bit 成片（**自带逐节点生效探针**） |
| `audio_mix` | 混音 + 响度归一到 −14 LUFS |
| `verify_diff` | 多维度验收：画面可见性 / 画质 / 响度 / 时间线 / 草稿完整性 |
| **`make_film`** | **给剪映草稿一条命令出成片**（官方渲染器出画面 + 我们的调色/混音/编码 + 带断言的验收） |
| **`run_pipeline`** | **按预置路线编排多条动词**（开副本 → 改草稿 → 落盘 → 语义验收 → 出成片；路线定义在 `references/pipeline-profiles.json`） |

## 7 个 Skill

| Skill | 干什么 |
|---|---|
| `jianying-cut` | 调色出片链路（风格预设 + 门禁） |
| `jianying-draft-edit` | 改草稿链路（官方操作全集 + 落盘 + 生效验证） |
| `jianying-review` | 审片验收（多维度对照 + 最小返修范围） |
| `jianying-talk-cut` | 剪口播（SRT 规划器 + 水词/停顿/重复判定 + 落刀） |
| `jianying-verify`（库） | 验收判据纪律（**仅被引用时用**） |
| `jianying-grade-chain`（库） | 调色链 API 语义（10 节点 × 参数）（**仅被引用时用**） |
| `jianying-pipeline` | **跨链流水线**：一句话做完一件事（改完→审→出片），一份副本走到底 |

## 精度

| 路径 | 误差 |
|---|---|
| 逐点直算（默认） | maxAbs **1 LSB** |
| 65³ 3D LUT | maxAbs **2 LSB** |
| 129³ 3D LUT | maxAbs **2 LSB**（更小） |

曲线恒等情形与官方 LUT 生成器 **256/256 texel 字节完全一致**。

## 结构

```text
plugin-root/
├── plugin.json                 # portable Agent Plugins 1.0（mcode 0.3.x）
├── mcp.json                    # MCP 声明（0.3.x）
├── .claude-plugin/plugin.json  # v0.4.0+ manifest（skills[] + mcpServers）
├── mcp/
│   ├── server.mjs              # 9 动词 stdio MCP server（0 npm 依赖）
│   └── tools/<verb>.schema.json# 每个动词的入参 schema（硬校验）
├── skills/
│   ├── jianying-cut/SKILL.md
│   ├── jianying-draft-edit/SKILL.md
│   ├── jianying-review/SKILL.md
│   ├── jianying-talk-cut/SKILL.md
│   ├── jianying-verify/SKILL.md
│   ├── jianying-grade-chain/SKILL.md
│   └── jianying-pipeline/SKILL.md
├── references/                 # 共享知识（按需引用）
│   ├── chain-api.md            #   链 API 语义（10 节点 × 参数）
│   ├── official-ops.md         #   官方 op 全集（18 域 199 个，逐个打桥的结果）
│   ├── verify-discipline.md    #   判据纪律（视野 / 噪声底 / 注入自检）
│   ├── pitfalls.md             #   踩坑清单
│   └── capability-dict.json    #   能力字典（9 动词 / 3 类元素 / 3 类节点 / 6 类判据，机器可读）
└── scripts/
    ├── run-verb.mjs            # 插件自带的 MCP 客户端（让 skill 调动词）
    ├── check-env.mjs           # 环境自检
    ├── selftest-mcp.mjs        # MCP 动词自检（40 项断言，含 8 条 MCP 层冒烟）
    ├── selftest-draft-edit.mjs # 改草稿链路端到端自检（16 项）
    ├── selftest-talk-cut.mjs   # 剪口播自检（10 项）
    ├── talk-cut-plan.mjs       # 口播保留区间规划器
    ├── talk-cut-apply.mjs      # 口播落稿器
    ├── add-subtitles.mjs        # 字幕落稿器（SRT/plan → 带时码的文字段）
    └── selftest-subtitle.mjs    # 字幕落稿自检
```

## 要求

**平台**：Windows（10/11）。

**需要在本机存在的可执行文件**：

- `ffmpeg` 6.0 —— 在 `PATH`，或用 `FFMPEG` 环境变量指定
- Python 3.9+ —— 在 `PATH`，或用 `JYAI_PYTHON` 环境变量指定
- `node` ≥ 22（运行 MCP server 与脚本）
- 剪映 11.6 —— **草稿相关动词需要它在运行**（走本机命名管道 `\\.\pipe\videoeditor-runtime-*`）；
  调色与出片本身不依赖 GUI

**其他**：

- `JYAI_HOME` 指向 JYAI 工具链仓库（工具在 `JYAI_HOME/tools`）
- 剪映运行时缓存 `%LOCALAPPDATA%\JianyingPro\User Data\Cache`（读取官方 shader 参照源用）

**账号 / 付费服务**：**不需要任何账号，不需要任何付费服务，不需要任何 API Key。**

## 数据与网络

- **无网络访问。** 插件不发起任何 HTTP/HTTPS 请求，也不连任何远端服务。
- **不需要凭据。** 不读不写任何 token / 密钥 / cookie。
- **无遥测。** 不上报任何使用数据、错误或崩溃信息。
- **无第三方服务。** 不依赖任何外部 API、SDK 或托管后端。
- **本机 IPC**：草稿读写与官方渲染通过**本机命名管道**与正在运行的剪映通信（Windows 本地 IPC，非网络）。
- **数据流向**：所有输入（视频、音频、草稿）只在本机被读取；所有产物（成片、帧、报告）写到本机输出目录。
- **草稿只读**：插件**只读**用户草稿；写操作一律在副本上进行，落盘时逐文件 sha 断言真草稿未被改动。
- 路径全部通过 `JYAI_HOME` / `HOME` / `LOCALAPPDATA` / `ProgramFiles` / `PATH` 解析，**不写死盘符**。

## 边界

- 改草稿的**结构化调色字段**（曲线/HSL/色轮）：**路已经打开了**（`effect.add` / `adjustment.add` / `filter.add` /
  `keyframe.*` / `video.setBasicColor` 实测全部放行，草稿里也有 `materials.hsl` / `hsl_curves` / `color_curves` /
  `log_color_wheels` / `primary_color_wheels` 这些现成的 material 集合），但**参数契约还没探完** ⇒ 目前只能**本地出片**，
  不能写进剪映预览。
- ★ **官方预览渲染器的能力边界**（实测，噪声底精确为 0 的同源对照）：它**自带强度型调色**
  （`materials.effects[]` 里的 `type:"brightness"` + 段引用）与几何/合成；
  **不认**曲线 / HSL / 色轮 / effect 链 / `adjust` placeholder / forceRender 链。
  ⇒ 所以"把曲线写回剪映预览"这条路对**曲线类**是关的 —— 曲线类只能走我们自己的出片链（`make_film --grade`）。
- 官方导出器不可达（见上）。
- `clear`（清晰度，8 级金字塔）尚未接入链。
- 口播剪辑**不做 ASR**：官方 ASR 在 agent runtime 里、拿不到；我们用**用户提供的 SRT**，
  只做"哪句是废话"的判定（清词/长停顿/重复），不做改写。**字幕落稿已能做**（用户给 SRT ⇒ `scripts/add-subtitles.mjs`）。

## 证据

调色链逐 feature 对齐、10bit 出片链路、官方参考帧获取、**官方行为操作全集（199 个）+ 字幕落稿**、判据纪律 ——
见 JYAI 仓库的 `docs/OFFICIAL-REALTIME-PATH.md`（§54–§100；其中 §100 是插件整体审计报告）与 `docs/最终架构与开发路线.md`。
