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
| `test/jianying.test.mjs` | **10 / 10** |
| `scripts/selftest-mcp.mjs` | **17 / 17** |
| `scripts/selftest-draft-edit.mjs` | **16 / 16** |
| `scripts/selftest-talk-cut.mjs` | **10 / 10** |
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
