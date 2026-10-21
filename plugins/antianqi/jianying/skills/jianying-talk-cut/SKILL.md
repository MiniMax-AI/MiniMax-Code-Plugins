---
name: jianying-talk-cut
description: 'Use when: 剪口播 / 去掉口播里的废话、停顿、重复、卡壳 / 按转写稿整理口播 / 把长口播剪短 / 剪完落稿并确认生效. 触发词: 把这段口播的废话剪掉 / 去一下口水话 / 把停顿剪了 / 有重复的剪掉 / 口播剪干净点.'
displayNames:
  zh-Hans: 剪映·剪口播（去水词/停顿/重复 · 带人工确认）
license: Apache-2.0
compatibility: Requires Windows + 剪映 11.6 在运行 + ffmpeg 6.0 + Python 3.14 + JYAI_HOME 指向 JYAI 仓库. ★ 需要用户提供转写稿(SRT) —— 官方 ASR(AnalyzeAsset) 在 agent runtime，管道里拿不到（§74.4）。
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "官方 studio.edit.speaker_cut 的经验层（Clean Cut 思路）+ 我们自建的 SRT 判定器与 27-op 落稿链"
---

# 剪映剪口播（jianying-talk-cut）

> **一句话定位**：给一份**转写稿（SRT）**，去掉口播里的**水词 / 长停顿 / 重复**，
> 产出**保留区间表**给人确认，再把确认后的区间**真的剪进草稿**并落盘验证。
> ★ 官方 `speaker_cut` 的经验层我们照做，**但 ASR 那一步我们拿不到** ⇒ 改用**用户提供的转写稿**。

## ★ 为什么用"用户提供的 SRT"而不是官方 ASR

剪映官方的 `AnalyzeAsset`（ASR）和 `SegmentRecall`（素材召回）都在 **agent runtime**
（`vebun.exe` + `app-server.mjs`，HTTP 63178），**不在我们的 VE 管道里**
（§42.2 另已证 addon 的 526 个导出**一个都不在管道**）。
⇒ 官方 9 个 processor 里也**没有 ASR**（只有截帧/变速/裁剪/去字幕/合片）。
⇒ **但它缺的是"事实来源"（转写文本），不是"经验"（哪句是废话）** ⇒ 经验层我们自己做。

## 三级判定（保守优先）

| 判定 | 含义 | 处理 |
|---|---|---|
| **drop** | 整条只有水词/标点（如"嗯，呃。"） | **建议整句删** |
| **review** | 句中有实词但夹水词 / 长停顿 / 与前几条重复 | **标出位置，建议人工确认**（默认不删） |
| **keep** | 正常内容 | 保留 |

★ **默认不删 review** —— 口播里的"那个/然后"有时是口语节奏的一部分，删不删要人拍板。
★ 重复检测**往前看 3 条**（口播里"重录"常隔一句，不只相邻）。
★ 词级水词时间按字符比例估算（粗，但够定位）。

## 主工作流

```bash
# ① 规划（纯计算，不碰草稿）
node ${PLUGIN_ROOT}/scripts/talk-cut-plan.mjs \
  --srt "<转写稿.srt>" --out "<plan.json>" \
  [--filler-ms 700] [--dup-sim 0.72] [--dup-window 3] [--keep-repeats]

# ② 【人工确认】把 plan.json 里的 review 句逐条看过：
#    确认要删的 → 把该区间加进 dropRanges（或直接改 verdict 后重跑 ①）

# ③ 应用（默认演练；加 --apply 才真改）
node ${PLUGIN_ROOT}/scripts/talk-cut-apply.mjs --plan "<plan.json>" --draft "<草稿名>" [--apply]

# ④ 落盘后验收：官方渲染 + 像素差 + 时间线变化
node ${PLUGIN_ROOT}/scripts/run-verb.mjs render_frames '{"draft":"<copy>","outDir":"<outdir>"}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "beforeDir":"<before>/frames","afterDir":"<after>/frames",
  "checks":["visibility","timeline"],
  "beforeDraft":"<before draft_content.json>","afterDraft":"<after draft_content.json>"
}'
```

## ★ 剪"中间一段"的正确链（实测，2026-10-21）

```text
① segment.split  {segmentId, splitTime: t1}      → 切成两段，【后半段拿新 id】
   ※ split 会让【后面的段整体后移】⇒ 多个区间必须【从后往前】处理
② segment.split  {segmentId: 前半id, splitTime: t0} → 前半再切两半
③ segment.delete {segmentId: 中间段id}            → 时间线缩短 (t1 - t0)
```
实测：时间线 9033333 → 8033333 us（正好剪掉 1 秒）✓
**参数名（实测）**：`video.add`→`path` · `audio.add`→**`audioPath`** · `text.add`→`content` ·
`segment.setTimeRange`→`segmentId`+时间 · `segment.delete`→`segmentId` · `segment.move`→`segmentId`+**需要 snapshot**

## ★ 三条纪律（别破）

1. **先规划、后人工确认、再改** —— 不要跳过 ② 直接 `--apply`。
2. **动词之间共享状态**：改动在**会话内存**里，回读必须带 `sessionId` 才看得到（否则读到的是没落盘的磁盘草稿）。
3. **落盘后必须验收** —— `verify_diff` 看**时间线维度**（段数/时长变没变）+ **可见性维度**（画面确实变了）。

## 失败处理

| 症状 | 原因 | 处理 |
|---|---|---|
| `SRT 里没解析出任何字幕条目` | 不是 SRT 格式 | 转成 `HH:MM:SS,mmm --> HH:MM:SS,mmm` |
| `找不到覆盖它的段` | 区间超出草稿时间线 | 核对 SRT 时间轴与草稿时长 |
| `找不到中间段` | split 后 id 变了 | 每步都要回读拿新 id（脚本已做） |
| `edit/xxx 失败：xxx_required` | 参数名不对 | 见上面「参数名（实测）」表 |
| `管道连不上` | 剪映没在跑 | 启动剪映 |

## 边界（不做什么 / 为什么 / 替代）

| 不做 | 为什么 | 替代 |
|---|---|---|
| **自己做 ASR** | 官方 ASR 在 agent runtime（HTTP 63178），**不在我们的 VE 管道里**；本地 whisper 要装模型（可选，不在默认路径） | **用户给 SRT / 转写稿**（我们缺的是"事实来源"，不是"经验"） |
| **改写台词 / 生成旁白** | 官方也明确「自由改写和生成旁白走通用链路」 | 人工改写；或用 `jianying-draft-edit` 的 `text.add` 另加一段 |
| **按主题重排**（官方 topic_cut） | 需要素材召回（`SegmentRecall`）⇒ 拿不到 | 我们只做 **Clean Cut**（按 SRT 删废话） |
| **自动加字幕** | 字幕规范/样式是另一条链 | `jianying-draft-edit` 的 `text.add` 可以做，但不是本 skill 的事 |
| **不加人工确认就落刀** | 判定只到 `review` 级的水词/停顿/重复**默认不删** | `talk-cut-plan` 出保留区间表 ⇒ 人工确认 ⇒ `talk-cut-apply` 才落刀 |

## 参考

- 官方 `studio.edit.speaker_cut`（125 文件，Clean Cut / Topic Cut 两模式）：`%ProgramFiles%\JianyingPro\<版本>\Resources\canvas_agent\skills\studio.edit.speaker_cut\SKILL.md`
- 27 个官方 op 的实测报告：`<JYAI_HOME>\logs\editops.md`
- 判据纪律：`skills/jianying-verify/SKILL.md`
- 踩坑清单：`references/pitfalls.md`
