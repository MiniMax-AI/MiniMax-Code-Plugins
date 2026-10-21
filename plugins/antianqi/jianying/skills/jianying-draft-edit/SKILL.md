---
name: jianying-draft-edit
description: 'Use when: 改剪映草稿 / 给草稿加素材或音轨 / 移动裁剪片段 / 调某段的音量 / 加文字 / 加轨道 / 撤销重做 / 改完落盘并验证生效. 触发词: 给这个草稿加个片段 / 把这段剪短 / 把这轨静音 / 加个文字 / 改完存一下 / 撤销刚才那步 / 看看改动生效没有.'
displayNames:
  zh-Hans: 剪映·改草稿（27 个官方操作 · 落盘不动真草稿）
license: Apache-2.0
compatibility: Requires Windows + 剪映 11.6 在运行（edit 域走官方命名管道）+ JYAI_HOME 指向 JYAI 仓库（落盘/渲染/验收在 JYAI_HOME/tools）+ ffmpeg + Python 3.14.
metadata:
  author: antianqi
  version: "0.1.0"
  basis: "官方 edit 域 27 个带命名空间的行为操作（实测 27/27）；落盘走 draft/writeFile；验收走【语义】逐段字段差（像素差需先量噪声底）"
---

# 剪映改草稿（jianying-draft-edit）

> **一句话定位**：在**副本**上改剪映草稿（加素材/加音轨/移动裁剪/调音量/加文字/加轨道/撤销重做），
> 落盘后用**落盘草稿的逐段字段差**确认改动真的生效 —— **真草稿零改动**。

## 调什么（动词）

| 动词 | 作用 |
|---|---|
| `draft_open` | 打开草稿（**默认开副本**；`allowReal` 与 `copy` 冲突会被拒） |
| `draft_read` | 读草稿语义结构（时间线/片段/素材）—— 拿 `segmentId` 等 id 用 |
| `draft_patch` | **27 个官方行为操作**（见下表） |
| `draft_commit` | 落盘（自动**素材路径重定位** + **真草稿 sha 前后断言**） |
| `render_frames` | 用官方渲染器出帧（改前/改后各一次） |
| `verify_diff` | 逐帧像素差（**取全帧最大**）判定"看得见" |

## ★ 27 个官方操作（带命名空间，**不是裸名**）

| 组 | 操作 |
|---|---|
| `draft` | `setCanvasSize` · `setDraftId` |
| `track` | `add` · `delete` · `mute` |
| `segment` | `move` · `scale` · `translate` · `rotate` · `updateLayout` · `split` · `delete` · `setTimeRange` · `innerReplace` · `setDescription` |
| `video` | `add` · `muteOn` · `muteOff` · `setVolume` |
| `audio` | `add` · `setVolume` |
| `text` | `add` |
| `undoRedo` | `undo` · `redo` · `canUndo` · `canRedo` |
| 批量 | `invokeBatch` |

**★ 已知必填项**（缺了会被本地先拦下，不白跑一次官方调用）：
`video.add`→`path` · **`audio.add`→`audioPath`** · `text.add`→`content` · `track.mute`/`track.delete`→`trackId` ·
`segment.move`/`setTimeRange`/`setDescription`→`segmentId` · **`segment.split`→`splitTime`** ·
`segment.updateLayout`→`layout` · `segment.innerReplace`→`replacement`

## 主工作流

```bash
# ① 开副本（拿 sessionId）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_open '{"draft":"<草稿库>\\<草稿名>","copy":true}'

# ② 读结构（拿 segmentId）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_read '{"scope":"segments"}'

# ③ 改（可多次；每次 baseRevision 会递增）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_patch '{"op":"video.setVolume","sessionId":"ve-session-N","params":{"segmentId":"<uuid>","volume":0.25}}'

# ④ 落盘（会做路径重定位 + 真草稿 sha 断言）
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_commit '{"realDraft":"<草稿库>\\<草稿名>"}'

# ⑤ 验收（★ 主判据 = 语义：落盘草稿的逐段字段差）
#    改前/改后各读一次明文草稿，再让 verify_diff 比"哪个字段变了"
node ${PLUGIN_ROOT}/scripts/run-verb.mjs draft_read '{"path":"<copy>/draft_content.json"}'
node ${PLUGIN_ROOT}/scripts/run-verb.mjs verify_diff '{
  "checks": ["timeline"],
  "beforeDraft": "<改前的明文草稿.json>", "afterDraft": "<改后的明文草稿.json>",
  "expect": { "segmentFieldChanged": "volume" }
}'
```

## ★ 四条纪律（别破）

1. **永远开副本** —— `draft_open` 的 `copy` 默认 true；`allowReal=true` 必须同时 `copy=false`（否则被拒）。
2. **落盘后必须验证** —— `draft_commit` 会断言真草稿 sha 未变；**"没报错"不等于"生效"**，
   要用 `verify_diff` 看**语义**（哪个字段变了）。
3. **判据用全帧最大 + 先量噪声底** —— 不用单帧抽样（单帧会假 FAIL/假 PASS）；
   ★ 官方渲染器**同态重渲染就有 MAD 48~123 的噪声** ⇒ 像素结论必须带 `noiseDir` 校准，否则只当参考。
4. **★ 优先用语义判据** —— "改动生效"最硬的证据是**落盘草稿里那个字段真的变了**
   （如 `volume` 0.99→0.2），它**完全确定**，而像素差不是。

## 常见诉求 → op

| 用户说 | op + params |
|---|---|
| 把这轨静音 | `track.mute` `{trackId}` |
| 把这轨删了 | `track.delete` `{trackId}` |
| 加一条视频 | `video.add` `{path}`（★ 参数名是 `path`，不是 `source`/`filePath`） |
| 加一条音频 | `audio.add` `{audioPath}`（★ 不是 `source`） |
| 加一段文字 | `text.add` `{content}`（★ 不是 `text`） |
| 这段音量调到 25% | `video.setVolume` `{segmentId, volume}` |
| 这段静音 | `video.muteOn` `{segmentId}` |
| 把这段剪成两半 | `segment.split` `{segmentId, splitTime}`（★ 不是 `splitTimeUs`） |
| 删掉这段 | `segment.delete` `{segmentId}` |
| 挪到别的位置 | `segment.move` `{segmentId, ...}`（★ 需要先有 snapshot） |
| 改这段的时间范围 | `segment.setTimeRange` `{segmentId, startTimeUs?\|startUs?, durationUs?}` |
| 撤销上一步 | `undoRedo.undo` `{}` |
| 一次做多步 | `invokeBatch` `{operations:[...]}` |

> ★ **官方行为操作是带命名空间的**（`segment.move` 不是 `move`）—— 历史上"白名单 0/150"就是命名错造成的。
> ★ **剪"中间一段"的正确链**：`split(t1)` → `split(前半, t0)` → `delete(中段)`；
> **split 会让后面的段整体后移 ⇒ 多个区间必须从后往前处理**。

## 失败处理

| 症状 | 原因 | 处理 |
|---|---|---|
| `缺少必填参数：path` | op 的必填项没给 | 查上表；参数放 `params` 里 |
| `edit/xxx 失败：segment_id_required` | 官方原样错误 | 你的 `segmentId` 不存在/已被删 ⇒ 先 `draft_read` 重新拿 |
| `edit/xxx 失败：draft_snapshot_required` | 这个 op 需要先有快照 | 先做一次别的 op，或用 `draft.setDraftId` |
| `管道连不上` | 剪映没在跑 | 启动剪映；`edit` 域必须连到活着的 VE 服务 |
| `真草稿被改动了` | ★ 危险信号 | 立刻停；查是不是误开了真草稿 |
| `verify_diff` 的 timeline 判 FAIL | 语义判据没看到预期字段变化 | ① 确认 `expect` 的字段名对不对（如 `volume`）② 确认 `beforeDraft`/`afterDraft` 是**改前/改后**两份，不是同一份 |
| `verify_diff` 的 visibility 判"不可见" | 可能是**渲染噪声**盖住了，也可能是真没生效 | 先加 `noiseDir` 校准；再用 `timeline` 维度的语义判据交叉验证 |
| `draft_read` 返回 `chars=0` | 读指定草稿时 root 没解析出来 | 传 `root`（或用 `path` 的上级目录）；插件已自动补，但自定义路径时仍要核 |

## ★ 边界（不做什么）

| 不做 | 为什么 | 替代 |
|---|---|---|
| 改**真**草稿 | 官方零文件监听 ⇒ 写盘不保证 GUI 立刻可见；且我们的红线是"官方库只读" | 人工在 GUI 里导入/替换 |
| 写**结构化调色**（曲线/HSL/色轮） | 草稿侧字段名尚未确证 | `jianying-cut` 走我们自己的链出片 |
| 官方导出器出片 | 官方 CLI 被 −100007 / −100015 挡死，**不绕** | `jianying-cut` |
| 画布节点操作（连线/卡片） | 画布是**生成线**，与"编辑已有草稿时间线"不同轴 | 不做 |
| 从零生成（AIGC 资产/单集成片） | processor 走沙箱 agent，取不到 | 不做 |

## 参考

- 官方 27 op 的实测报告：`<JYAI_HOME>\logs\editops.md`（含每个 op 的官方报错 ⇒ 参数反推依据）
- 判据纪律：`references/verify-discipline.md`
- 踩坑清单：`references/pitfalls.md`
