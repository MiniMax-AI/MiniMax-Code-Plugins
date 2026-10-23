---
name: jianying-grade-chain
description: 'Use when: 查某个调色节点/参数怎么填时 / 不确定某个调色效果该归到哪个节点时 / 调色链精度口径与可选节点清单时 / 用户给了调色参数要落到链上时. 本 skill 是【库】—— 仅在其它 skill 引用它、或用户明确问调色链细节时被使用，不主动触发. 触发词: 调色链有哪些节点 / 这个参数填哪个节点 / 调色能精确到什么程度 / 曲线的控制点怎么排.'
displayNames:
  zh-Hans: 剪映·调色链细节（库 · 仅被引用）
license: Apache-2.0
compatibility: Requires nothing beyond the plugin's grade_apply verb. No external dependency.
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "10 个节点逐像素对齐官方 shader（误差 ≤1 LSB）；链 API 形态见 tools/jyai-gl-bake.py 的 normalize_chain_spec"
---

# 剪映调色链细节（jianying-grade-chain · 库 skill）

> **一句话定位**：回答"**这个调色效果该用哪个节点、参数怎么填、能精确到什么程度**"。
> ★ **本 skill 是【库】**：不主动触发，只在其它 skill 引用它、或用户明确问调色链细节时使用。
> 完整版：`references/chain-api.md`（本文件是它的入口速查）。

## 10 个节点（`grade_apply` 的 spec 键）

| 节点 | 类型 | 能否烘 3D LUT | 官方对应 |
|---|---|---|---|
| `adjustColor` | 逐点 | ✅ | 基础画面调节（亮度/对比/饱和/高光/暗部/色温…） |
| `colorCorrection` | 逐点 | ✅ | 色彩校正（adjustColor 的精简变体） |
| `hsl` | 逐点 | ✅ | 分色调整（8 默认色 + 用户取色） |
| `logWheel` | 逐点 | ✅ | 对数轮（阴影/中间调/高光/偏移 四段） |
| `primaryWheel` | 逐点 | ✅ | 三原色轮 ★ **链 API 形态未接入**（参数语义未定义）⇒ 写进来直接报错 |
| `curves` | 逐点 | ✅ | 曲线（red/green/blue/luma 4 条 1D） |
| `hsl_curves` | 逐点 | ✅ | HSL 耦合曲线（6 条） |
| `sharpen` | **邻域** | ❌ | 锐化（渲染期算子） |
| `vignetting` | **uv** | ❌ | 暗角/白角（渲染期算子） |
| `particle` | **uv** | ❌ | 颗粒/光斑（渲染期算子） |

★ **邻域 / uv 依赖的三个节点不能烘 3D LUT**（3D LUT 只能表达"逐点函数"）⇒ 只能在渲染期算。
★ `fade` / `lightSensation` 是 **`adjustColor` 的子参数**，**不是独立节点**（官方 frag 里是 adjustColor 流水线的最后两段，顺序固定）。

## 强度语义

- `-1..1` = **强度**：`0` 不动 · `+0.5` 中等偏上 · `-1` 拉满
- `0..1` = **比例/百分比**：`sharpen.intensity` · `vignetting.param`
- 界面 0..100 ⇒ 强度 = `(v/100)*2 - 1`

## ★ 最容易踩的坑：两条曲线的控制点布局**不同**

| 节点 | 布局 | 判别 |
|---|---|---|
| `curves` | **A,L,R** | 第一个三元组的第二项是 **x** |
| `hsl_curves` | **L,A,R** | 第一个三元组的第二项是 **y** |

⇒ **两套数组不能互相套用。**

## 常见诉求 → spec

> ★ **机器可读版**：`references/intent-map.json`（21 条"人话 → 参数"映射）
> ★ 里面的参数名由机械审计**按 schema 校验** ⇒ 拼错会被当场抓出来（不会静默失效）。

| 用户说 | spec |
|---|---|
| 调亮一点 | `{"adjustColor":{"brightness":0.12}}` |
| 调暖一点 | `{"adjustColor":{"temperature":0.15}}` |
| 提亮中间调、压高光 | `{"adjustColor":{"shadow":0.15,"highlight":-0.10}}` |
| 更有食欲（餐饮） | `{"adjustColor":{"saturation":0.28,"temperature":0.15,"contrast":0.12},"logWheel":{"shadow":{"r":0.14,"g":0.06,"b":0.0,"s":0.08}}}` |
| 电影感 | `{"adjustColor":{"contrast":0.22,"saturation":-0.10,"shadow":0.16},"vignetting":{"intensity":0.35,"param":0.30}}` |
| 红色更艳 | `{"hsl":{"HSLRed":{"hue":0.56,"saturation":0.62,"lightness":0.55}}}` |

## 精度口径

| 路径 | 误差 |
|---|---|
| 逐点直算（`graded10.mp4`） | maxAbs **1 LSB** |
| 65³ 3D LUT（`graded_lut.mp4`） | maxAbs **2 LSB** |
| 129³ 3D LUT | maxAbs **2 LSB**（更小） |

⇒ **要精确 ⇒ 用逐点直算那一版**；要小体积/快 ⇒ 用 LUT 版。

## 机器可读版

- 入参 schema（硬校验，**未知键直接拒绝**）：`mcp/tools/grade-apply.schema.json`
- 能力字典（9 动词 / 3 类元素 / 3 类节点 / 6 类判据）：`references/capability-dict.json`
- 人读版（每个参数的语义、官方对应、已知不覆盖）：`references/chain-api.md`

## ★ 边界（不做什么 / 为什么 / 替代）

| 不做 | 为什么 | 替代 |
|---|---|---|
| **`clear`（清晰度，8 级金字塔）接入链** | 尚未接入；且**官方默认 intensity=0 本身就是空转**（§67 实测 value=0 逐像素相同） | 只能出参考帧做对照，不能当可用节点 |
| **`colorMigration`（色彩迁移）** | 官方算法在闭源 `Amaz.Algorithm` ⇒ 拿不到 | 自算替代（与 `clear` 同类：只能自己实现） |
| **把曲线 / HSL / 色轮写回剪映预览** | 草稿侧字段名尚未确证，**且官方预览渲染器本身也不认这些**（实测：它只认强度型调色）⇒ 这条路对曲线类是关的 | 本地出片（`jianying-cut` / `make_film --grade`）；★ 曲线参数由我们自己的接口给，**不需要用户在剪映里存草稿** |
| **给 `sharpen` / `vignetting` / `particle` 配 LUT 烘焙** | 这三个是**渲染期**节点（邻域 / uv 依赖）⇒ LUT 表达不了 | 链内渲染期算（已在链里） |
| **把 `fade` / `lightSensation` 当独立节点** | 它们是 **`adjustColor` 的子参数**，不是顶层 spec 键 | 写 `spec.adjustColor.fade` / `spec.adjustColor.lightSensation` |
| **用 `primaryWheel`** | 链 API 形态的**参数语义未定义** ⇒ 过去静默烘成恒等 LUT | 现在直接报错（用 `adjustColor` / `logWheel` 近似） |
| **用 `hsl` 的用户取色键（`01#ad8a86_H`）** | 链 API 形态未接入（官方要按取色器分配色相范围） | 现在直接报错 ⇒ 改用官方默认色 |
| **照抄官方 shader 的定点编码** | 官方 `enCode` 会截断（\|v\|>1 时截断）⇒ 拉普拉斯差分超 [−1,1] 会丢精度 | 链内用 float64 复刻，别在中间丢 |
