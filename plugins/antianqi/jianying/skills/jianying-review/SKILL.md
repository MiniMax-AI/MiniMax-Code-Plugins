---
name: jianying-review
description: 'Use when: 审片 / 检查这版剪得对不对 / 返修验收 / 这版片子整体过不过关 / 画质或响度有没有问题 / 交片前检查. 触发词: 审一下这版 / 看看剪得对不对 / 这版片子审得过吗 / 交片前检查 / 画面有没有过曝 / 响度够不够 / 时间线对不对.'
displayNames:
  zh-Hans: 剪映·审片验收（多维度 · 带数字和证据边界）
license: Apache-2.0
compatibility: Requires Windows + 剪映 11.6 在运行（官方渲染器）+ ffmpeg 6.0 + Python 3.9+ + JYAI_HOME 指向 JYAI 仓库.
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "官方 editing-review 的证据边界纪律 + 我们可运行的检测器（多维度 verify_diff）"
---

# 剪映审片验收（jianying-review）

> **一句话定位**：对"改前 / 改后"两版做**多维度对照检查**，每条结论都带**数字 + 证据边界**，
> 并给出**最小返修范围**。★ 审片本身**不授权**改草稿或发布。

## ★ 我们和官方的差别

剪映官方的 `editing-review` 只有 47 行，且原文明确写着：
**「这里列出的是检查方法，不是已实现或已运行的检测器」**。
⇒ 官方告诉你**该查什么**；**我们有真正能跑的检测器和数字**（像素差 / 画质 / 响度 / 时间线 / sha）。

**但纪律要跟官方一致**（这是我们从它身上学的）：
- **源素材分析只能证明源素材内容；草稿结构只能证明编排事实；渲染成片的音画证据才支持"实际呈现"的结论**
- **不要把"上游成功"当成"审片通过"**（草稿应用成功 ≠ 画面对了）
- **只对工具真正覆盖的维度和范围下结论**；采样不能证明"全片没有闪帧"
- **区分四类结论**：证据支持通过 / 已确认问题 / **证据不足** / 与本次范围无关
- **没有足够证据的必查项要保留为"待确认"**，不能因为"没发现问题"就给完整通过

## 检查维度（`verify_diff` 的 `checks`）

| 维度 | 查什么 | 需要的证据 | 不达标时 |
|---|---|---|---|
| `visibility` | 改动在画面上**看得见**吗 | 改前/改后帧目录 **+ 噪声基线** | max MAD ≤ 判据线 ⇒ FAIL |
| `picture` | 画质：均值漂移 / **新增**高光削波 / **新增**暗部死黑 | 同上 | 新增削波 >2% / 死黑 >10% ⇒ FAIL |
| `audio` | 响度 LUFS / true peak | 改前/改后 mp4 | 偏离 −14 LUFS ⇒ 提示 |
| `timeline` | 段数 / 轨道 / 时长 / **逐段字段差** | 改前/改后草稿 JSON | 给了 `expect` 就按期望断言；没给且什么都没动 ⇒ **改动可能没落盘** |
| `draft_integrity` | 真草稿有没有被误改 | 真草稿目录 | 落盘时已做逐字节断言 |

**★ 判据用增量不用绝对值**：片子里本来就有的纯白/纯黑**不算**削波/死黑，只有**被改动新推上去/压下去**的才算缺陷。

## ★★★ 审片前必须知道的一件事：官方渲染器**有噪声底**

**同一份草稿渲染两次，帧就已经不一样**（实测 14~17/108 帧不同，最差 MAD **48~123**）。
⇒ **裸 MAD 阈值（0.5）没有任何判别力**；"max MAD=123.5 ⇒ 改动可见"这类结论**不成立**。

**⇒ 审片必须先量噪声底**（`noiseDir` = 同一状态**再渲染一次**的帧目录）：

```bash
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "beforeDir": "<before>/frames", "afterDir": "<after>/frames",
  "noiseDir":  "<before>/frames-again",
  "checks": ["visibility","picture","timeline"]
}'
```

> ★ `noiseDir` = **同一状态再渲染一次**的帧目录。
> ★ **JSON 里不能写行内注释**（`#` 或 `//` 都不行）⇒ 照抄会被 `run-verb.mjs` 拒成"参数不是合法 JSON"。
> 要注释就写在 JSON 外面（像这样）。

- 给了 `noiseDir` ⇒ 判据线 = `max(threshold, noiseMad × 1.5)`，输出里有 `noiseMad` / `madOverNoise`；
- **没给** ⇒ 输出里 `calibrated:false` + note ⇒ **这时"可见"只能当参考，不能当结论**。

**★ 结构性改动请用语义判据**（不依赖像素、完全确定）：
`timeline` 维度会给出**逐段字段差**（`segmentDiffs`：段 id + 变了哪些字段 + 改前改后值），
> ★ `beforeDraft` / `afterDraft` 要指**裸草稿 JSON**（顶层就有 `tracks`）——
> `draft_read` 的响应外面包了一层 `draft`，直接存响应会被读成 `tracks: 0`（判据静默失效）。
配合 `expect` 直接断言：

```bash
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "checks": ["timeline"],
  "beforeDraft": "<改前的明文草稿.json>", "afterDraft": "<改后的明文草稿.json>",
  "expect": { "segmentFieldChanged": "volume", "segmentsDelta": 0 }
}'
```

> **审片报告里必须写清"这条结论是语义的还是像素的"** —— 两者可信度差一个数量级。

## 主工作流

```bash
# ① 渲染改前 / 改后（官方渲染器）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs render_frames '{"draft":"<copy>","outDir":"<outdir>"}'

# ② 多维度审片
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "beforeDir": "<before>/frames", "afterDir": "<after>/frames",
  "checks": ["visibility","picture","audio","timeline","draft_integrity"],
  "beforeVideo": "<before>.mp4", "afterVideo": "<after>.mp4",
  "beforeDraft": "<before draft_content.json>", "afterDraft": "<after draft_content.json>",
  "realDraft": "<草稿库>\\<草稿名>"
}'
```

**输出结构**：
```json
{ "verdict": "PASS" | "FAIL",
  "checks": { "visibility": {...}, "picture": {...}, "audio": {...}, "timeline": {...}, "draft_integrity": {...} },
  "problems": ["高光削波【新增】3.21%（>2%）", ...] }
```

## 结论怎么写（照官方那套分类）

| 类别 | 什么时候用 | 写法 |
|---|---|---|
| **证据支持通过** | 该维度有检测器覆盖且达标 | "画面变化可见：max MAD 123.5 @frame74（22/108 帧有差异）" |
| **已确认问题** | 有数字支撑的缺陷 | "实际 vs 预期 → 定位 → 影响 → 最小返修 + 返修后用什么证据确认" |
| **证据不足** | 该维度没有检测器覆盖 | "响度未测（未提供 mp4）——待确认，不写成'响度正常'" |
| **与本次范围无关** | 用户没要求这个维度 | 不展开、不泛化罗列风险 |

## ★ 最小返修原则

- 只修**有证据的问题**，范围最小
- 说明**应该保持什么**（避免修 A 破坏 B）
- 给出**返修后用什么证据确认**（不是"再优化一下"这种无法执行的建议）
- **审片请求不授权修改**：用户授权修复时，才把问题与最小返修范围交给执行入口（`jianying-draft-edit`）

## ★ 边界（不做什么 / 为什么 / 替代）

| 不做 | 为什么 | 替代 |
|---|---|---|
| **改草稿 / 落盘** | **审片请求不授权修改**；越权改草稿会动到用户资产 | 用户授权后，把问题与最小返修范围交给 `jianying-draft-edit` |
| **发布 / 导出成片** | 发布侧已有独立 skill 体系 | `daily-platforms-export` · `lvchuanjiao-daily-upload` |
| **"全片没有闪帧"这类全片结论** | 采样不能证明"全片没有闪帧"（官方原话）⇒ 只能写"证据不足/待确认" | 缩小范围重测，或在结论里标注覆盖范围 |
| **拿官方渲染器的裸像素差当结论** | 同态重渲染噪声底就有 MAD 48~123 ⇒ 裸 MAD 分不出"改动"与"噪声" | 语义判据（`timeline` 逐段字段差）为主 · 像素必须带 `noiseDir` 校准 |
| **结构化调色（曲线/HSL/色轮）的写回与判定** | 草稿侧字段名尚未确证 | `jianying-cut` 走我们自己的链出片 |

## 参考

- 判据纪律（必读）：`skills/jianying-verify/SKILL.md` · `references/verify-discipline.md`
- 踩坑清单：`references/pitfalls.md`
- 官方 `editing-review` 原文对照：`%ProgramFiles%\JianyingPro\<版本>\Resources\canvas_agent\skills\editing-review\SKILL.md`
