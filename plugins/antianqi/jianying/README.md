# jianying · MiniMax Code 插件

> **不点剪映的界面，直接用剪映自己的计算。** 逐像素复刻的调色数学（**从对话框直接认证**）+ 剪映本机管道的草稿操作，
> 让"改参数 → 看效果 → 再改"这件事能被 AI 串起来。

## 痛点：GUI 自动化不是解法

想用 AI 批量调色、批量改草稿，最直觉的路子是让 computer use 去点剪映的界面。实际走一遍就知道：

- **慢**：调一次色要走「选片段 → 调参数 → 导出 → 对比」，每一步都是几十秒的等待；
- **脆**：点错一个下拉框、调错一个数值，你未必看得出来；
- **验不了**：改完只能肉眼看，而"看得出变了"这件事本身就没有判据。

还有一个更隐蔽的坑：**想核对"这组参数在剪映里到底是什么效果"，你只能打开剪映、导出预览、然后肉眼比。**
而**导出的预览视频本身就不准** —— 实测官方渲染那条路（PNG 原帧 → h264 4:2:0 **8bit** mp4）自带一层有损投影：

| 路径 | 误差（同一 0–255 标度） |
|---|---|
| 我们的复刻 vs 官方 shader | **maxAbs ≤ 1**（曲线 LUT 256/256 字节一致） |
| 官方渲染 PNG → 它的 mp4（预览/导出看到的那层） | **MAD 2~8 · maxAbs 157 · 95% 像素都变了** |

⇒ 拿一个自己都不准的东西当"标准答案"，**永远对不上，也永远不敢下结论**。

⇒ 剪映真正的价值在**它的调色数学**和**它自己的草稿结构**；GUI 只是这两样东西的手动外壳。
**外壳可以不碰，核心可以接管。**

## 我们的做法

**① 调色数学自己复刻 → 从对话框直接认证** —— 把剪映 13 个调色 feature 的算法逐个逆向复刻（逐像素对齐官方 shader，
误差 **≤ 1 LSB**；曲线恒等情形与官方 LUT 生成器 **256/256 texel 字节完全一致**），
**不依赖官方导出器**（它被官方自己挡死：`−100007` / `−100015`）。
⇒ 我们算出来的是**剪映的数学本身**，不是它那层有损投影
⇒ **在对话框里就能认证**：不开剪映、不导出、不肉眼比，直接给数值结论（逐节点生效探针 + 逐点误差）。
（顺带：我们的产物是 **hevc Main 10 / yuv420p10le**，中间没有 8bit 4:2:0 那层损失。）

**② 改草稿走剪映自己的管道** —— 通过剪映进程的本机命名管道，用官方的 **27 个行为操作**改草稿
（`segment.split` / `video.setVolume` / `text.add` …），**不是模拟点击**。落盘后剪映照常能打开。

**③ 最难的那半：怎么知道它真的生效了** —— 这一步比前两步都难，而且大部分同类方案都栽在这：
官方渲染器**同态重渲染就有 MAD 48~123 的噪声**（同一份草稿渲染两次，17/108 帧不同），
所以"画面好像变了"根本不能当证据。我们把主判据换成**语义判据**（落盘草稿里那个字段真的变了吗），
像素差必须先量噪声底再校准。

## 能做什么

| 场景 | 怎么用 | 产出 |
|---|---|---|
| **调色认证** | "这组参数在剪映里会是什么效果" | 剪映数学的逐点真值（**≤ 1 LSB** 级）+ **逐节点生效探针**（哪个节点没生效直接报，不装作跑通了）；需要成片时一并出 10bit / 保留原音版本 |
| **改草稿** | "把草稿里第一段音量调到 25%，改完落盘并确认生效" | 改完的草稿 + **生效证据**；**真草稿逐文件 sha 断言没被动过** |
| **审片验收** | "审一下这版，哪里要返修、返修后用什么证据确认" | 画面/画质/响度/时间线/草稿完整性多维度对照 + **最小返修范围** |
| **剪口播** | 给一份 SRT | 标出水词/长停顿/重复 → 出**保留区间表** → 人工确认后才落刀（不自动删） |

## 可延伸性

- **8 个原子动词 + 6 个 skill**：动词层只给原语（读草稿 / 改草稿 / 落盘 / 渲染 / 调色 / 混音 / 验收），
  skill 层是"**有自己中间思路 + 门禁**"的完整链路。
  ⇒ **加新场景 = 加一条 skill，不用动底层。**
- **换脑子也能用**：skill 只调动词，不绑定执行路径（离线写盘还是活体通道，动词内部决定）。
- **调色链是独立可复用的数学资产**：10 个节点 × 参数语义 × 精度口径（逐点 1 LSB / LUT 2 LSB），
  可以接到别的渲染器上，不止剪映。
- **判据纪律是护城河**：工具谁都能调，但"怎么知道它真的生效了"要在知道渲染器噪声底、
  绝对值 vs 增量口径的前提下才答得上来。

## 安装

**方式一：本地 marketplace（推荐，改了随时 `git pull`）**

```bash
git clone https://github.com/antianqi/jianying-plugin.git ~/.minimax/plugins/jianying
mcode plugin list          # 目录扫描会自动装上并启用 ⇒ 应看到 jianying@local enabled
```

> `mcode plugin add -m local jianying` 会返回 `LOCAL_PLUGIN_INSTALL_UNSUPPORTED` ——
> **这是正常的**：local marketplace 是**目录扫描**式的，clone 进去就已经装上了，不需要再 add。

**方式二：等上游合并**

本插件已向上游 `MiniMax-AI/MiniMax-Code-Plugins` 提 PR：
**[#72](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/72)**（base `main` ← `antianqi:feature/jianying-plugin`，
上游 CI 全绿）。合并后 `mcode plugin add jianying@official` 即可。

**验证装好了**

```bash
mcode plugin list                                            # jianying@local enabled
node ~/.minimax/plugins/jianying/scripts/run-verb.mjs --list  # 列出 8 个动词
node ~/.minimax/plugins/jianying/scripts/check-env.mjs        # 环境自检：缺什么会指名道姓
```

## 8 个动词

| 动词 | 作用 |
|---|---|
| `draft_open` | 打开草稿（默认只读副本） |
| `draft_read` | 读草稿语义结构（时间线/片段/素材） |
| `draft_patch` | 语义级修改（**27 个官方行为操作**，带命名空间） |
| `draft_commit` | 落盘（自动素材路径重定位 + 真草稿 sha 断言） |
| `render_frames` | 用官方渲染器出帧/mp4 |
| `grade_apply` | 调色（10 节点链）+ 出 10bit 成片（**自带逐节点生效探针**） |
| `audio_mix` | 混音 + 响度归一到 −14 LUFS |
| `verify_diff` | 多维度验收：画面可见性 / 画质 / 响度 / 时间线 / 草稿完整性 |

## 6 个 Skill

| Skill | 干什么 |
|---|---|
| `jianying-cut` | 调色出片链路（风格预设 + 门禁） |
| `jianying-draft-edit` | 改草稿链路（27 个官方操作 + 落盘 + 生效验证） |
| `jianying-review` | 审片验收（多维度对照 + 最小返修范围） |
| `jianying-talk-cut` | 剪口播（SRT 规划器 + 水词/停顿/重复判定 + 落刀） |
| `jianying-verify`（库） | 验收判据纪律（**仅被引用时用**） |
| `jianying-grade-chain`（库） | 调色链 API 语义（10 节点 × 参数）（**仅被引用时用**） |

## 示例提示词与预期结果

**提示词**

```text
给这个视频调色出片，风格用暖一点的，输出到 out\cut\demo.mp4
```

**预期结果**

1. 环境自检先跑，缺依赖直接报缺哪一个。
2. `grade_apply` 产出 `graded10.mp4`（逐点直算，推荐）与 `graded_lut.mp4`（65³ LUT 形态）。
3. 返回**逐节点生效探针**：`adjustColor` / `logWheel` / … 每一项 MAD 都必须非零，
   任何一个为 0 ⇒ 动词**直接判失败**（而不是"链看着跑通、实际少一个节点"）。
4. 返回全链改变量 `grade_change_mad`（实测 > 0）与产物路径。
5. 画面验收用 `verify_diff`；注意像素结论要带 `noiseDir` 校准（见 `skills/jianying-verify/SKILL.md`）。

## 精度

| 路径 | 误差 |
|---|---|
| 逐点直算（默认） | maxAbs **1 LSB** |
| 65³ 3D LUT | maxAbs **2 LSB** |
| 129³ 3D LUT | maxAbs **2 LSB**（更小） |

## 要求

**平台**：Windows（10/11）。

**需要在本机存在的可执行文件**：

- `ffmpeg` 6.0 —— 在 `PATH`，或用 `FFMPEG` 环境变量指定
- Python 3.14 —— 在 `PATH`，或用 `JYAI_PYTHON` 环境变量指定
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

## 结构

```text
jianying-plugin/                  ← 仓库根 = 插件根
├── plugin.json                 # portable Agent Plugins 1.0（mcode 0.3.x）
├── mcp.json                    # MCP 声明（0.3.x）
├── .claude-plugin/plugin.json  # v0.4.0+ manifest（skills[] + mcpServers）
├── mcp/
│   ├── server.mjs              # 8 动词 stdio MCP server（0 npm 依赖）
│   └── tools/<verb>.schema.json# 每个动词的入参 schema（硬校验）
├── skills/                     # 6 个 skill
├── references/                 # 链 API 语义 / 判据纪律 / 踩坑清单 / 能力字典
├── scripts/                    # MCP 客户端 / 环境自检 / 三个自检 / talk-cut 规划与应用
├── test/jianying.test.mjs      # 仓库自证（10 例）
└── EVIDENCE.md                 # 实测数据
```

## 自检

```bash
node --test test/jianying.test.mjs     # 10 pass / 0 fail
node scripts/check-env.mjs             # 环境自检
```

`test/jianying.test.mjs` 钉住的是**会静默失败**的东西：manifest 的 `skills[]` 路径指向的子目录名
必须等于 frontmatter `name`（不等 ⇒ 运行时**静默丢弃、不报任何诊断**）、脚本调用必须锚到
`${PLUGIN_ROOT}`、代码里不许有网络客户端/凭据字面量/作者机器路径、README 该披露的必须披露。

## 边界

- 改草稿的**结构化调色字段**（曲线/HSL/色轮）**尚未确证**官方草稿字段名 ⇒ 目前只能**本地出片**，
  不能写进剪映预览。
- 官方导出器不可达（见上）。
- `clear`（清晰度，8 级金字塔）尚未接入链。
- 口播剪辑**不做 ASR**：官方 ASR 在 agent runtime 里、拿不到；我们用**用户提供的 SRT**，
  只做"哪句是废话"的判定（清词/长停顿/重复），不做改写与字幕。

## 证据

调色链逐 feature 对齐、10bit 出片链路、官方参考帧获取、官方 27 个行为操作的参数契约、判据纪律
—— 见 [`EVIDENCE.md`](EVIDENCE.md)。

许可：Apache-2.0（见 [`LICENSE`](LICENSE)）。
