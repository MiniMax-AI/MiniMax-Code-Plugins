---
name: jianying-cut
description: 'Use when: 给视频按调色参数或风格出片 / 用复刻的剪映调色链出 10bit 成片 / 按暖色、清爽、电影感、明亮风格调色 / 调色后出带原声的片 / 验收改动在画面上是否可见. 触发词: 给这个视频调色出片 / 按XX风格调色 / 出个10bit的片 / 剪映调色 / 调色后出片 / 出带声音的片 / 剪映出片 / 看看改动有没有生效.'
displayNames:
  zh-Hans: 剪映调色出片（10bit · 保留原声）
license: Apache-2.0
compatibility: Requires Windows + ffmpeg 6.0 + Python 3.14 + JYAI_HOME 指向 JYAI 仓库（工具链在 JYAI_HOME/tools）+ 剪映 11.6 运行时缓存（读取官方 shader 用；出片本身不依赖剪映 GUI）。
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "调色链 10 个节点逐像素对齐官方 shader（误差 ≤1 LSB）；10bit/16F 出片链路已验证"
---

# 剪映调色出片（jianying-cut）

> **一句话定位**：给一个源片，按调色参数或风格预设，用**逐像素复刻的剪映调色链**出 **10bit / 保留原音轨**的成片，
> 附「原片 | 调色后」对比图与逐节点生效明细。**不需要剪映 GUI。**

## 调什么（动词与能力）

本 skill 只动一个动词：**`grade_apply`**（调色 + 出片）。
配套两个：**`verify_diff`**（验收改动是否可见）、**`render_frames`**（用官方渲染器出帧）。

| 想做的事 | 调哪个动词 | 关键参数 |
|---|---|---|
| 调亮度/对比/饱和/色温… | `grade_apply` | `spec.adjustColor.*` |
| 分色调整 | `grade_apply` | `spec.hsl.<颜色名>.{hue,saturation,lightness}` |
| 对数轮 / 三原色轮 | `grade_apply` | `spec.logWheel.*` / `spec.primaryWheel.*` |
| 曲线 / HSL 耦合曲线 | `grade_apply` | `spec.curves.*` / `spec.hsl_curves.*` |
| 锐化 / 暗角 / 颗粒 | `grade_apply` | `spec.sharpen` / `spec.vignetting` / `spec.particle` |
| 确认改动看得见 | `verify_diff` | `beforeDir` / `afterDir` |

★ **参数怎么填** → `references/chain-api.md`（语义在这里）· `mcp/tools/grade-apply.schema.json`（硬校验在这里）
★ **多少算"生效"** → `references/verify-discipline.md`
★ **别再踩** → `references/pitfalls.md`

## 主工作流

**入口**：`scripts/run-verb.mjs`（本插件自带的 MCP 客户端 ⇒ 走的是**和 mcode 加载插件时完全一样的动词**）

```bash
# ① 环境自检（可选但建议）
node ${PLUGIN_ROOT}/scripts/check-env.mjs

# ② 出片
node ${PLUGIN_ROOT}/scripts/run-verb.mjs grade_apply '{
  "src": "<源视频.mp4 的绝对路径>",
  "outDir": "<输出目录的绝对路径>",
  "frames": 12,
  "spec": { "adjustColor": { "brightness": 0.10, "contrast": 0.12, "saturation": 0.28, "temperature": 0.15 } }
}'

# ③ 验收（改动是否在画面上可见）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "beforeDir": "<改前帧目录>", "afterDir": "<改后帧目录>"
}'
```

**流程**：
```
健康检查（check-env）
  ↓
grade_apply：出 10bit 成片 + 逐节点生效探针（任一节点为 0 ⇒ 动词直接判失败）
  ↓
读产物：graded10.mp4（逐点直算，推荐）/ graded_lut.mp4（65³ LUT 形态）
  ↓
需要时 verify_diff：max-over-frames 判"看得见"
```

**产物**（在 `outDir` 下）：
| 文件 | 内容 |
|---|---|
| `graded10.mp4` | **hevc / yuv420p10le / 原音轨**（逐点直算，推荐交付） |
| `graded_lut.mp4` | 同上，LUT 形态（链式插值误差 2 LSB） |
| `grade-side-by-side.png` | 左 原片 / 右 调色后 |
| `grade-compare.json` | 逐节点探针 · 调色改变量 · LUT vs 直算差 · 10bit 回读误差 |

## 常见诉求 → spec 速查

| 用户说 | spec |
|---|---|
| 调亮一点 | `{"adjustColor":{"brightness":0.12}}` |
| 调暖一点 | `{"adjustColor":{"temperature":0.15}}` |
| 提亮中间调、压高光 | `{"adjustColor":{"shadow":0.15,"highlight":-0.10}}` |
| 更有食欲（餐饮） | `{"adjustColor":{"saturation":0.28,"temperature":0.15,"contrast":0.12},"logWheel":{"shadow":{"r":0.14,"g":0.06,"b":0.0,"s":0.08}}}` |
| 电影感 | `{"adjustColor":{"contrast":0.22,"saturation":-0.10,"shadow":0.16},"vignetting":{"intensity":0.35,"param":0.30}}` |
| 更锐 | `{"sharpen":{"intensity":0.5}}` |
| 红色更艳 | `{"hsl":{"HSLRed":{"hue":0.56,"saturation":0.62,"lightness":0.55}}}` |

## 失败处理

| 症状 | 原因 | 处理 |
|---|---|---|
| `入参不合法：未知键` | spec 里写了没这个节点 | 查 `references/chain-api.md` 的 10 节点表 |
| `亮度 5 > 最大 1` | 强度语义是 −1..1，不是 0..100 | 换算：界面 0..100 ⇒ 强度 = (v/100)*2 − 1 |
| `下列节点没有生效（探针为 0）` | 该节点被静默跳过（形态/素材问题） | 单独调该节点，看 `grade-compare.json` |
| `调色改变量为 0` | spec 空 / 全 0 | 至少给一个非零强度 |
| `缺 JYAI 工具` | `JYAI_HOME` 没设 | `set JYAI_HOME=<JYAI 仓库路径>` |
| `UnicodeEncodeError gbk` | 环境码页 | 脚本已自设 UTF-8；若仍出现，检查调用方是否另起进程 |

## ★ 三条纪律（别破）

1. **本 skill 不直接改 `draft_content.json`** —— 改草稿请用 `jianying-draft-edit`（走 `draft.*` 动词）。
2. **不自己算像素差** —— 一律用 `verify_diff`（max-over-frames），不抽单帧。
3. **不绕过护栏** —— `grade_apply` 内建的探针、`draft_commit` 的 sha 断言是**故意拦人**的，不要关掉。

## 边界（不做什么）

| 不做 | 为什么 | 替代 |
|---|---|---|
| 改剪映草稿 | 本 skill 只出片 | `jianying-draft-edit` |
| 混音 / 加 BGM / 响度归一 | 另一条链 | `audio_mix` 动词（需草稿目录） |
| 上传多平台 | 平台侧各有一套 | 平台自己的 skill |
| 官方导出器出片 | 官方 CLI 侧被 −100007 / −100015 挡死，**不绕** | 我们自己出（就是本 skill） |
| 曲线/HSL/色轮**写回剪映** | 草稿侧字段名尚未确证 | 只能本地出片（见 `references/pitfalls.md`） |
