# 实测证据

> 这里的每个数字都是跑出来的，不是抄文档。
> 复现方式写在每节末尾；完整证据全文在 JYAI 仓库 `docs/OFFICIAL-REALTIME-PATH.md`（§54–§77）。

## 1. 调色链：13/13 feature 逐像素对齐官方 shader

| feature | 对齐口径 | 实测 |
|---|---|---|
| `curves`（曲线） | 恒等 LUT 与官方生成器比对 | **256/256 texel 字节完全一致** |
| `hsl`（中性） | 逐字节比对 | **逐字节相同** |
| `hsl_curves` | 逐点 | maxAbs **1 LSB** |
| 65³ 3D LUT | 与官方 LUT 生成器比对 | maxAbs **2 LSB**（建议 129³，同为 2 LSB 但更平滑） |
| 曲线 / 分级 / 色轮 / 日志轮 / 色彩校正 | 逐点 | maxAbs **1 LSB** |

**为什么值得较这个真**：差 1 LSB 肉眼无感，差 8 LSB 就有色带。
1 LSB ⇒ 调色结果可以当"官方结果"用，不需要人工微调。

## 1.5 ★ 官方渲染/预览那条路**自带一层有损投影**

官方渲染器出的是 **PNG 序列（无损）→ h264 High / yuv420p / 8bit mp4**。
实测同一批帧，PNG 原帧 vs 从它自己的 mp4 里抽出来的帧：

| 帧 | MAD | maxAbs | 变化像素 |
|---|---|---|---|
| 0 | 1.971 | 157 | 77.9% |
| 20 | 2.199 | 159 | 79.1% |
| 39 | **8.339** | 70 | 95.7% |
| 64 | 7.416 | 66 | 95.2% |
| 90 | 0.627 | 38 | 34.5% |

⇒ **剪映的预览/导出看到的那一层，本身就和它的数学差了 MAD 2~8、maxAbs 157、95% 的像素都变了。**

**对照**（同一 0–255 标度）：

| | 误差 | 产物格式 |
|---|---|---|
| 我们的复刻 vs 官方 shader | **maxAbs ≤ 1**（曲线 LUT 256/256 字节一致） | **hevc Main 10 / yuv420p10le** |
| 官方渲染 PNG → 它的 mp4 | MAD 2~8 · maxAbs 157 | h264 High / yuv420p / **8bit** |

⇒ 所以"打开剪映核对"核对的是一个**自己都不准的投影**；
⇒ 而我们算的是**剪映的数学本身**，且中间不叠那层 8bit 4:2:0 损失
⇒ **在对话框里直接认证**比"导出预览再肉眼比"更准，也更快。

## 2. 10bit / 16F 出片

| 项 | 实测 |
|---|---|
| RGBA16F FBO | **COMPLETE** |
| 渲染误差（16F） | **0.000187** |
| 渲染误差（8bit） | 0.001751 ⇒ 16F 好 **9.4×** |
| banding 台阶 | 1 / 4.4 |

**诚实结论**：位深收益在**4:2:0 交付**时会被色度子采样淹没。
⇒ 能吃满位深的是**中间格式 / 母版**（ProRes 422 HQ、16bit WAV、FFV1），不是最终 mp4。

## 3. `clear`（清晰度）：官方 8 级金字塔的接线自证

官方结构全解：**6 支 frag · 23 个 RT · 8 级金字塔**（1280×720 → 10×5），
尺寸链从 `.rt` 二进制逐字节 diff 解出。

**接线代数自证**（不靠肉眼）：

| 条件 | 自洽性 \|C_0 − G_0\| |
|---|---|
| 正确接线（fact=0 / 无量化 / 不 clamp） | **9.737e-19** |
| 注入 wrong_lap | 5.7e-2 |
| 注入 wrong_add | 3.6e-2 |
| 注入 no_top | 6.0e-4 |

⇒ 判据分辨力 **5.7e+16 倍**。

**官方参考帧**（造 `type:'clear'` 的 intensity 型 effect 节点草稿 → 官方渲染）：

| value | 官方行为 |
|---|---|
| 0 | **空转**（逐像素相同）—— 官方默认就是这个 |
| 1 | 生效，MAD **0.004523**（40 640 px 变化，unsharp mask 签名） |
| 0.5 | 线性（v0.5 / v1.0 = **0.4986**） |

## 4. 官方 27 个行为操作的参数契约（实测，非抄文档）

方法：直接用官方 `app-server.mjs` 的 `gk0` 白名单 + 逐个参数名实探
（用真 segmentId / 真时间戳 / 真素材路径，看官方报错是否变化）。

| op | 必填参数（实测） | 备注 |
|---|---|---|
| `video.add` | **`path`** | `source` / `sourcePath` / `filePath` 都不认 |
| `audio.add` | **`audioPath`** | ★ 不是 `source` / `path` |
| `text.add` | **`content`** | `text` 不认 |
| `track.mute` / `track.delete` | **`trackId`** | |
| `segment.setTimeRange` | **`segmentId`** + 时间 | `startTimeUs` / `startUs` + `durationUs` 均可 |
| `segment.delete` | **`segmentId`** | |
| `segment.move` | **`segmentId`** + **需要 snapshot** | `segment_move_snapshot_required` |
| `segment.split` | **`splitTime`** | ★ 不是 `splitTimeUs` |
| `track.add` | 仍未探到 | 报 `track_add_params_required`，候选全不对 |

**★ 官方行为操作是带命名空间的**（`segment.move` 不是 `move`）——
历史上"白名单 0/150"就是命名错造成的。

**★ 剪"中间一段"的正确链**

```text
① segment.split  {segmentId, splitTime: t1}        → 切成两段（后半段拿新 id）
② segment.split  {segmentId: 前半id, splitTime: t0} → 前半再切两半
③ segment.delete {segmentId: 中间段id}              → 时间线缩短 (t1 - t0)
```

实测：时间线 **9 033 333 → 8 033 333 µs**（正好剪掉 1 秒）。
**★ split 会让后面的段整体后移 ⇒ 多个区间必须从后往前处理。**

## 5. 判据纪律（本插件真正的护城河）

### 5.1 官方渲染器**不是确定性的**

同一份草稿**渲染两次**，帧就已经不一样：

| 样本 | 不同的帧 | 最差 MAD |
|---|---|---|
| 抓帧容差 60ms | 14/108 | **48.19** |
| 抓帧容差 20ms（收紧后） | 17/108 | **123.55** |

⇒ 噪声底比任何"改动可见"阈值（0.5）**高两个数量级** ⇒ 裸像素差不能证明"改动可见"。

**排除过的假设**：收紧容差后 108/108 全部精确命中、噪声依旧 ⇒ 不是容差问题；
提交前 vs 提交后 MAD 17.41（比同态噪声还小）⇒ 不是素材路径重定位；
渲染前后草稿目录 sha 树 64 文件 0 变化 ⇒ 渲染是只读的。

### 5.2 主判据换成**语义**

改草稿链的"改动生效"证据 = **落盘草稿的逐段字段差**：

| 场景 | 证据 |
|---|---|
| 调音量 | 真草稿 `volume=0.99` → 落盘副本 `volume=0.2`（其余 3 段不变） |

⇒ **完全不依赖像素**，确定性、可复跑。

### 5.3 已踩过的反面教材（都写进了 `references/pitfalls.md`）

| # | 坑 | 后果 |
|---|---|---|
| 1 | 单帧抽样当判据 | 既会假 FAIL 也会假 PASS |
| 2 | 两份验收并发写同一目录 | 证据互相污染 |
| 3 | 削波用**绝对值**口径 | 白底图 clip=36% ⇒ 误判 FAIL |
| 4 | 读错状态源（动词之间不共享状态） | "各自都成功，链路却是错的" |
| 5 | 基线借用**别的跑**的旧目录 | 比的是两次不同的改动 ⇒ 假绿 |
| 6 | 用字符串收集 stdout | 二进制被毁 ⇒ 假报"0 差异" |
| 7 | 读指定草稿缺 `--root` | **静默返回空**，比报错更难发现 |

## 6. 自检（全部带负向注入）

| 自检 | 结果 |
|---|---|
| `test/jianying.test.mjs` | **11 / 11** |
| `scripts/selftest-mcp.mjs` | **58 / 58**（含编排器两段式 4 条 + 新路线 2 条） |
| `scripts/selftest-draft-edit.mjs` | **17 / 17** |
| `scripts/selftest-talk-cut.mjs` | **11 / 11**（带草稿；无草稿时落稿链显式 SKIP ⇒ 7 项） |
| `scripts/check-env.mjs` | **17 OK / 0 MISS** |
| 上游官方校验器 | `OK plugin antianqi/jianying` · **30 插件全绿** |

**负向注入自检 7/7**（每个判据都必须能因正确原因失败）：

| 注入 | 期望失败 | 实际 |
|---|---|---|
| frontmatter `name` != 目录名 | 失败 | `frontmatter name must equal its directory name` |
| `description` 超 1024 字符 | 失败 | `description is 1285 chars (limit 1024)` |
| 代码里写死盘符路径 | 失败 | `must not hardcode a drive letter path` |
| 代码里出现 `fetch(` | 失败 | `must not make HTTP requests` |
| README 删掉"预期结果" | 失败 | `README must state the expected result` |
| README 删掉"无遥测"披露 | 失败 | `README must disclose telemetry behaviour` |
| manifest `skills[]` 指向缺失文件 | 失败 | Skill 路径列表 deep-equal 不匹配 |

## 6.5 ★★ 编排器的两段式（人工确认点）—— 实测证据（2026-10-24）

> 路线 `talk-cut-then-render` 里那一步（产出"保留/删除"区间表）标了
> `"confirm": true` + `"artifact": "$planPath"` ⇒ 编排器跑完那一步就**停下来**。

| 断言 | 期望 | 实测 |
|---|---|---|
| 第一段 | 停在关卡，后面 3 步**一步都没跑** | `verdict=AWAIT_CONFIRM` · `gate.step=3` · `gate.pendingSteps=3` |
| 关卡产物 | 存在 + 有 sha | `artifact=<…>/talk-cut-plan.json` · `artifactSha` 非空 · `artifactPreview.stats` 有值 |
| **不确认就续跑** | **拒绝执行** | `verdict=REFUSED` · 自检断言"被拒那次 `talk-cut-apply.mjs` **根本没被执行**" |
| 假 token | 明确报错（不许默默从头跑） | `找不到流水线状态` |
| 确认后续跑 | 走完 | `verdict=PASS` · apply 自证 **已验证剪掉 2/2 个区间** |
| 真草稿 | 全程零改动 | 落盘前后 sha 相同（`realDraftUnchanged=true`） |

**apply 的判据（形态无关 + 有区分力）**：

| 区间 | 这一轨时长总量 | 结果 |
|---|---|---|
| `2200000..2600000 us`（400 000 us） | 3 000 000 → 2 600 000 | 正好少 400 000 ✅ |
| `200000..900000 us`（700 000 us） | 2 600 000 → 1 900 000 | 正好少 700 000 ✅ |

阴性对照：演练模式（没 `--apply`）下同一条判据**必然不成立**（脚本当场打印
"阴性对照：演练没动草稿 ⇒ 判据现在【不成立】"）⇒ 判据能区分"剪了"和"没剪"。

## 6.6 ★★★ 这一轮挖出来的两个真缺陷（都是"官方说改了不算数"的变种）

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | `draft_read {sessionId}` 读出来的**不是刚开的那份草稿**（段数/时长/id 全不一样）；最坑的一次读到的是**两天前**另一个会话留下的草稿 | **剪映的 session id 会回收复用**（进程重启后从 1 重新数）⇒ 状态目录里还留着上一次的 `snapshot-<sid>.json`，而 `draft_read` 优先读快照 ⇒ 新会话"继承"了旧草稿 | `draft_open` 开新会话时**先删掉这个 id 的旧快照**；另加一道：会话记下草稿 id，读到的 id 对不上就点名报错 |
| 2 | `draft_patch` 报 `effectVerified=false, changes=0`，可段**确实**被切成了两半 | 生效探针的基线是**磁盘上的加密草稿** ⇒ `readDraftJson` 解析不出来 ⇒ 返回 null ⇒ 探针以为"改前不存在" ⇒ 段数变化算不出来 | 基线读不出来就**走官方管道解密**（`readDraftForDiff`）⇒ 探针不再假阴性 |

⇒ 通用教训：**判据的基线读不出来时，要换一条路读，不能当成"没有基线"**；
**任何"按 id 缓存"的东西，都必须考虑 id 会回收**。

## 6.7 ★★ 判据的"无法判定"必须与"没变"分开（这一轮修的假绿）

- 段级 diff 的 `fields` **只装【变了】的字段** ⇒ "没变"与"根本没法比"在 diff 里长得一样
  ⇒ `expect: {segmentFieldUnchanged: X}` 会被**静默满足**（假绿）。
- 现在有 `fieldComparability(before, after, field)`：数"两边都有的段"与"只有一边有的段"，
  字段不可比时**明确报"无法判定"**并判 FAIL（不装作"没变"）。
- 修完后 `selftest-draft-edit.mjs` 的负向注入 ⑦b 第一次**因正确原因**失败：
  `不该变的 "volume" 字段却变了`（不是"无法判定"）⇒ 判据有区分力。
- 同理，⑦ 的"改前"基线改成从**会话快照**取（暖机 patch 先把快照变成展开形态）⇒
  改前/改后**同形态** ⇒ 逐段字段差才可比。

## 6.8 ★ 编排器的另外两条路线（2026-10-24 续）

| 路线 | 步骤链 | 实测 |
|---|---|---|
| `subtitle-then-render` | `draft_open → draft_read → add-subtitles.mjs → draft_commit → make_film` | **PASS** · 字幕脚本自证 **时码吻合 2/2**（±1 帧 = 33333 µs）· 成片 3.000000 s |
| `render-and-mix` | `draft_open → make_film → audio_mix` | **PASS** · 双流齐备 **-14.00 LUFS** · `mixed.mp4` 实测 avg = **-14.28 LUFS** |

★ `render-and-mix` 用的是新加的 **`produces`** 机制：步骤声明
`"produces": {"$film": "film.mp4"}` ⇒ 编排器把 `<outDir>/film.mp4` 交给下一步
（否则"混音"这一步拿不到画面）。

★ 跑在**没有音轨**的草稿上时，这条路线 **FAIL** 并说明停在哪一步
（官方回 `nothing to mix`）⇒ 自检按环境分两种断言：
有音轨的草稿 ⇒ 断言成功；没有 ⇒ **断言它诚实失败**（不许"没音轨也照样出片成功"）。

★ 顺带修掉一个盲区：`run-pipeline.schema.json` 的 `profile` **枚举**与
`pipeline-profiles.json` **没有对账** ⇒ 加了新路线却忘了同步 ⇒ 路线存在却调不动
（`不在允许集合`）。现在机械审计 7k 做**双向对账**，负向注入 ㉜ ⇒ 审计自检 **33 / 33**。

★ 顺带修掉一个自相矛盾：意图分类器的权重函数注释写"长词更具体 ⇒ 权重更高"，
实现却是"3 字以上一律 3 分" ⇒ 命中"加字幕再出片"(6 字) 反而输给命中"加字幕"+"字幕"的
通用 skill 条目。改成**随长度增长**后，测试句 33 句 **top-1 100% / top-3 100%**。

## 6.9 ★ 单版审片（"审一下这版"）与 `undetermined`（2026-10-24 续）

| 维度 | 单版能判什么 | 为什么 |
|---|---|---|
| `visibility` | **判不了**（`skipped`）但**给出噪声底** | 没有改前就没有"改动"可比 |
| `picture` | 只给**绝对值**、**不判失败** | 片子里本来就有的纯白/纯黑不算缺陷 ⇒ 绝对值不能当判据 |
| `audio` | **能判** | 这一版的 LUFS / true peak（绝对目标 −14 LUFS） |
| `timeline` | 只给这一版的**结构** | 段数 / 轨道 / 时长 |
| `draft_integrity` | **能判** | 真草稿的 sha |

实测（`review-only` 路线，夹具 `JYAI能力批测-带音轨夹具`）：

| 项 | 实测 |
|---|---|
| 噪声底 | 同态重渲 MAD = **0.0000206**（另一轮 0）⇒ **噪声底本身也非确定 ⇒ 每次都要量** |
| 画面绝对值 | `clipRatio = 0.00724` · verdict = **"参考（未判定）"** |
| 响度 | **integratedLufs = −14** ✓ |
| 时间线 | 段数 3 · `single: true` |
| 结论 | PASS + **`undetermined: [visibility]`** + `verdictNote`（"这不是完整通过"） |

★ **"PASS" 不等于"全查过了"**：没判的维度现在进 `undetermined` 并附 `verdictNote`
⇒ 未测的维度要写成"待确认"，不能写成"正常"（官方 `editing-review` 的纪律）。

★ 自检当场又抓出第二层：**查了但测不出来**（纯画面片没有音轨 ⇒ `ebur128` 量不出 LUFS ⇒
`integratedLufs = null`）旧行为是**静默 null**（看着像"响度正常"）⇒
现在也进 `undetermined`（新增 `undeterminedReason`）⇒ 自检的断言是
"响度**要么**达标（|LUFS+14| ≤ 0.5）**要么**出现在 undetermined 里"。

★ 顺带修了一个**报告层缺陷**：编排器的步骤摘要只留白名单字段 ⇒ `verify_diff` 的结论
在 `checks` 里被丢掉 ⇒ 路线"跑成了却没产出它该产出的东西"。现在 `verify_diff` 走
**专用紧凑摘要**（保留关键数字，丢掉逐帧明细）。

## 6.10 ★ 两版对照审片（`review-compare`）+ 一个"判据写反了"的 bug

一次对照同时回答：画面变没变 · 画质新增削波 · 响度两版各是多少 · 时间线改了什么 · 真草稿有没有被误改。

实测（改前 = 纯视频探针，改后 = 带音轨夹具）：

| 项 | 实测 |
|---|---|
| 画面 | **FAIL（改动在画面上不可见）** ⇒ 两版只差音轨 ⇒ **判据不是恒真** ✓ |
| 噪声底 | MAD = 0.0000584 / 0.0000206（两次跑不同 ⇒ 噪声底本身非确定） |
| 画质 | `clipDelta = 0` |
| 响度 | 改前 **−14 LUFS**（truePeak −11.3 dBFS）· 改后 **−14 LUFS**（truePeak −13 dBFS） |
| 时间线 | 段数 **Δ = 1** |

★ 这个 FAIL 是**正确的**（画面本就没变）⇒ 判据判出"不可见"反而是它可信的证据。

★★ 顺带抓出一个**判据写反了**的 bug：响度检查写成 `Math.abs(lufs) > 0.5`
⇒ 比较的是**响度值本身** ⇒ **任何正常归一到 −14 LUFS 的片子都会被说成"未归一"**
（报告里 `-14` 与"未归一"同时出现，自相矛盾）。修正为判偏离量 `|lufs − (−14)| > 0.5`。
⇒ ★ 这类 bug **不会让自检变红**（只多一句 note）⇒ **只能靠人读报告发现**。

★ 编排器新增 **`setVars`**（步骤之后求值，抓这一步的产出存成别名）
⇒ 一份路线里开两份草稿时 `$dir` / `$sessionId` 不再互相覆盖；
审计守卫：`setVars`/`produces` 的变量必须声明、`produces` 路径不许 `..` 或绝对路径。




## 7. 复现

```bash
# 仓库自证（不需要剪映、不需要 Windows）
node --test test/jianying.test.mjs

# 环境自检（需要 ffmpeg / python / 剪映缓存）
node scripts/check-env.mjs

# 三个端到端自检（需要活的剪映 11.6 + 一个真实草稿）
$env:JYAI_TEST_DRAFT = "<草稿库>\<草稿名>"
node scripts/selftest-mcp.mjs
node scripts/selftest-draft-edit.mjs
node scripts/selftest-talk-cut.mjs
```

未设 `JYAI_TEST_DRAFT` 时自检会**明确打印 SKIP 并退出 0**（不伪装 PASS）。
