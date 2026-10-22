# 链 API 人读版（`grade.apply` 的 `spec` 怎么填）

> **机器可读版**：`mcp/tools/grade-apply.schema.json`（硬校验，非法键直接拒绝）
> **能力字典**：`references/capability-dict.json`（9 动词 / 3 类元素 / 3 类节点 / 6 类判据）
> ★ 本文的语义部分（每个参数**什么意思**）只有这里有；schema 管"能不能填"。

## 强度语义

所有 `-1..1` 的参数是**强度**，不是绝对值：`0` = 不动 · `+0.5` = 中等往上调 · `-1` = 拉满。
`0..1` 的参数是**比例/百分比**（如 `sharpen.intensity`、`vignetting.param`）。

## 10 个节点

| 节点 | 类型 | 能否烘 3D LUT | 官方对应 |
|---|---|---|---|
| `adjustColor` | 逐点 | ✅ | 基础画面调节（亮度/对比/饱和/高光/暗部/色温…） |
| `colorCorrection` | 逐点 | ✅ | 色彩校正（adjustColor 的精简变体） |
| `hsl` | 逐点 | ✅ | 分色调整（8 默认色 + 用户取色） |
| `logWheel` | 逐点 | ✅ | 对数轮（阴影/中间调/高光/偏移 四段） |
| `primaryWheel` | 逐点 | ✅ | 三原色轮 ★ **链 API 形态未接入**（`red/green/blue/cyan/magenta/yellow` 各自的参数语义从未定义）⇒ 写进来**直接报错** |
| `curves` | 逐点 | ✅ | 曲线（red/green/blue/luma 4 条 1D） |
| `hsl_curves` | 逐点 | ✅ | HSL 耦合曲线（6 条） |
| `sharpen` | **邻域** | ❌ | 锐化（渲染期算子） |
| `vignetting` | **uv** | ❌ | 暗角/白角（渲染期算子） |
| `particle` | **uv** | ❌ | 颗粒/光斑（渲染期算子） |

★ **邻域 / uv 依赖的三个节点不能烘 3D LUT**（3D LUT 只能表达"逐点函数"）⇒ 只能在渲染期算。

### 哪个动词用哪条链（★ 别混用）

| 节点 | `grade_apply`（逐点直算） | `make_film --grade`（3D LUT） |
|---|---|---|
| `adjustColor` `colorCorrection` `hsl` `logWheel` `primaryWheel` `curves` `hsl_curves` | ✅ | ✅ |
| `sharpen` `vignetting` `particle`（渲染期算子：邻域 / uv0 依赖） | ✅ | ❌ **写进来直接报错**（3D LUT 表达不了 ⇒ 会静默变恒等） |
| `smartColorAdjustment` | ❌ 未实现（会报错） | ❌ 会报错 |

⇒ ★ **两条链都不许"静默失效"**：
- 3D LUT 路径：缺曲线通道 / 含渲染期算子 / 含未实现节点 ⇒ **抛异常**，不烘恒等
- 逐点直算路径：带**逐节点生效探针**（单节点 vs 零，必须非零），并输出 "★ 无效果（参数形态可能不对）"
- **节点内的参数名**：拼错 ⇒ 过去被静默忽略、烘出**恒等 LUT**（出片"成功"但调色没发生）
  ⇒ 现在**两层都堵**：schema 用 `grade_apply` 的 spec 约束（跨动词复用），烘焙器自己也拒未知参数名

### `adjustColor`（含两个"子参数"，不是独立节点）

| 参数 | 含义 |
|---|---|
| `brightness` | 整体亮度 |
| `contrast` | 对比度 |
| `saturation` | 饱和度 |
| `vibrance` | 自然饱和度（保护已高饱和区域） |
| `highlight` | 高光（提亮区的对比） |
| `shadow` | 暗部 |
| `black` / `white` | 黑场 / 白场 |
| `temperature` | 色温（**正 = 偏暖**，负 = 偏冷） |
| `fade` | 褪色（0..1）—— 走官方 `fade_max.texture` 17³ LUT |
| `lightSensation` | 光感（−1..1）—— 走官方 min/max 两张 17³ LUT |

★ **`fade` / `lightSensation` 是 `adjustColor` 的子参数**（官方 frag 里是 adjustColor 流水线的最后两段，顺序固定）。

### `hsl`（分色调整）

键 = 颜色名，值 = `{hue, saturation, lightness}`（界面值 ±100）：
`HSLRed` / `HSLGreen` / `HSLBlue` / `HSLYellow` / `HSLCyan` / `HSLMagenta`，
以及**用户取色**（形如 `01#ad8a86_H` 的键，schema 里用 `patternProperties` 放行）。

> ★ **用户取色键尚未接入链 API 形态**（官方要按取色器给它分配色相范围，见 `HSL_LEFT/RIGHT_KEY_PTS` 那套）
> ⇒ 过去会被**静默丢弃**（该颜色完全不生效，看起来像"没反应"）⇒ 现在**直接报错**，请改用官方默认色。

### `logWheel`（对数轮，四段）

每段 = `{r, g, b, s}`（色相/饱和，−1..1）。段名：`shadow` / `midtone` / `highlights` / `offset`。

### `curves`（曲线）—— ★ 控制点是 **A,L,R** 布局，**每控制点 3 个 vec2（= 6 个数）**

`red` / `green` / `blue` / `luma` 各一组控制点，**扁平数字数组**。

> ★★ **最常踩的坑**：控制点**不是 x,y 交替**！**每控制点 = 3 个 vec2 = [锚点 A, 出向柄 L, 出向柄 R]**
> ⇒ **6 个数/控制点**。例：24 个数 = 4 个控制点。
>
> ★ 官方键名 `RPoints` / `GPoints` / `BPoints` / `YPoints` 与 `red` / `green` / `blue` / `luma`
> **完全等价**（烘焙器两套都认，实测烘出的 LUT 相同）。
>
> ★ **R / G / B / Y 四条必须一起给** —— 缺任一条会**直接报错**（不再静默烘成恒等 LUT）。
>
> ★ 可选强度键：`intensityR` / `intensityG` / `intensityB` / `intensityY`（0..1，缺省 1）。
>
> ★ 官方语义：**Y（亮度）曲线会等量改 R/G/B 三个通道**（为保色相）⇒
> 只改 R 时 G/B 也会小幅变化，**这不是 bug**。

```json
"curves": {
  "red":   [0,0, 0.1,0.0533, 0.2,0.1067, 0.3,0.16, 0.4067,0.3933, 0.5133,0.6267, 0.62,0.86, 0.7467,0.9067, 0.8733,0.9533, 1,1, 1,1, 1,1],
  "green": [0,0, 0.1,0.0533, 0.2,0.1067, 0.3,0.16, 0.4067,0.3933, 0.5133,0.6267, 0.62,0.86, 0.7467,0.9067, 0.8733,0.9533, 1,1, 1,1, 1,1],
  "blue":  [0,0, 0.1,0.0533, 0.2,0.1067, 0.3,0.16, 0.4067,0.3933, 0.5133,0.6267, 0.62,0.86, 0.7467,0.9067, 0.8733,0.9533, 1,1, 1,1, 1,1],
  "luma":  [0,0, 0.1,0.0533, 0.2,0.1067, 0.3,0.16, 0.4067,0.3933, 0.5133,0.6267, 0.62,0.86, 0.7467,0.9067, 0.8733,0.9533, 1,1, 1,1, 1,1]
}
```

### `hsl_curves`（HSL 耦合曲线）—— ★ 控制点是 **L,A,R** 布局

6 条：`hue2hue` / `hue2sat` / `hue2lum` / `lum2sat` / `satsat` / `satlum`，
每条 = `{points: [x0,y0, x1,y1, ...]}`。

> **★★ 最容易踩的坑：`curves` 的控制点是 A,L,R，`hsl_curves` 的是 L,A,R —— 两套布局不能互相套用。**
> 判别：`L`（Left 控制点）永远在 `A`（锚点）之前 ⇒ 看第一个三元组的第二项是 x 还是 y。

## 怎么写一个 spec（例子）

```json
{
  "adjustColor": { "brightness": 0.10, "contrast": 0.12, "saturation": 0.28, "temperature": 0.15 },
  "logWheel": { "shadow": { "r": 0.14, "g": 0.06, "b": 0.0, "s": 0.08 } },
  "sharpen": { "intensity": 0.45 }
}
```

## 精度（我们复刻的，不是官方保证）

| 路径 | 误差 |
|---|---|
| 逐点直算（`--no-lut` 之外的默认） | maxAbs **1 LSB** |
| 65³ 3D LUT | maxAbs **2 LSB**（链式插值误差） |
| 129³ 3D LUT | maxAbs **2 LSB**，但更小 |

⇒ **要精确 ⇒ 用逐点直算那一版**（`graded10.mp4`）；要小体积/快 ⇒ 用 LUT 版。

## 已知不覆盖

- `fade` / `lightSensation` 只在 `adjustColor` 内有效，单独提出来无效（会被 schema 拒）
- `primaryWheel`（三原色轮）**尚未接入链 API 形态** —— 参数语义未定义，过去会静默烘成恒等 LUT ⇒ 现在直接报错
- `hsl` 的**用户取色键**（`01#ad8a86_H`）**尚未接入链 API 形态** ⇒ 现在直接报错（请用官方默认色）
- `clear`（清晰度，8 级金字塔）**尚未接入链**（官方默认 intensity=0 本身是空转）
- `colorMigration`（色彩迁移）官方算法在闭源 `Amaz.Algorithm` ⇒ 只能自算替代
- 曲线 / HSL / 色轮**写回剪映**的草稿字段名尚未确证 ⇒ 目前只能**我们本地出片**，不能写进剪映预览
  ⇒ 且**实测官方预览渲染器本身也不认这些**（强度型调色它就带，曲线/HSL/色轮/effect 链/forceRender 链全不认）
  ⇒ 所以"调色写回剪映预览"这条路对曲线类**是关的**，曲线类只能走我们自己的出片链。
