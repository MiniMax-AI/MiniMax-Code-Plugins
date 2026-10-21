# 官方行为操作全集（实测 2026-10-21）

> **★ 这份清单推翻了旧结论"官方只有 27 个行为操作"。**
> 27 那个数字来自官方 `app-server.mjs` 里的 `gk0` 常量（一个历史快照），**不是当前宿主进程的真实授权范围**。
> 实测：官方全集 **18 个域 / 199 个 op**，我们这道桥 **全部放行（0 个被拒）**。

## 怎么测的

直接打官方管道（绕过我们插件的本地 schema），每个 op 用空参数打一次，按错误码分三类：

| 判定 | 含义 |
|---|---|
| `accepted:true` | 放行，且空参数就能过（173 个） |
| `xxx_required` / `xxx_invalid` | **放行**，只是缺参数（26 个）⇒ 说明这个 op 存在 |
| `unsupported_behavior_operation` | 不放行（**0 个**） |

⇒ 结论：**桥没有拦任何官方 op**。以前"只能用 27 个"是我们只试了 27 个，不是只能用 27 个。

## 分域清单

| 域 | 数量 | 干什么 |
|---|---|---|
| `draft` | 14 | 草稿级（画布/封面/名称/背景/对齐） |
| `track` | 4 | 轨道（增删静音/改名） |
| `segment` | 19 | 片段（增删改/切分/布局/可见/镜像/复制/时码） |
| `video` | 56 | 视频素材与特效（转场/淡入淡出/抠像/绿幕/变速/音量/数字人…） |
| `audio` | 24 | 音频（音量/变声/降噪/音高/人声分离/美颜…） |
| `text` | 16 | 文字与字幕（加文字/加字幕/样式/关键词/动画/追踪器） |
| `textTemplate` | 8 | 文字模板 |
| `sticker` | 7 | 贴纸 |
| `effect` | 3 | 特效（加/改参数/重置） |
| `filter` | 2 | 滤镜（加/改） |
| `adjustment` | 3 | 调色调整（加/基础色/重置） |
| `keyframe` | 3 | 关键帧（增删改） |
| `template` | 4 | 模板（可变视频/音频/文字/静音） |
| `templateCombination` | 3 | 模板组合 |
| `attachment` | 13 | 附件（AI 任务/视频算法/AI 创作） |
| `story` | 11 | 故事（AI 备选素材） |
| `undoRedo` | 6 | 撤销重做 |
| `batch` | 3 | 批处理（开始/结束/冻结） |

## 全量 op 清单

### `draft`（14）

`draft.setCanvasSize`  `draft.setCanvasBackground`  `draft.setCover`  `draft.clearCover`  `draft.setDraftName`  `draft.setDraftId`  `draft.setDraftUpdateTime`  `draft.ensureDraftCanvasSize`  `draft.updateDraftAIGCWatermark`  `draft.clearDraft`  `draft.setDraft`  `draft.setAlignMode`  `draft.setDraftKeywordsConfigs`  `draft.setVideoGeneratorType`

### `track`（4）

`track.add`  `track.delete`  `track.mute`  `track.updateTrackName`

### `segment`（19）

`segment.move`  `segment.scale`  `segment.translate`  `segment.rotate`  `segment.updateLayout`  `segment.split`  `segment.insert`  `segment.delete`  `segment.mirror`  `segment.setTimeRange`  `segment.innerReplace`  `segment.innerReplaceStack`  `segment.paste`  `segment.visible`  `segment.mute`  `segment.setName`  `segment.duplicate`  `segment.setDescription`  `segment.multiSegmentsSetTimeRange`

### `video`（56）

`video.add`  `video.setMaterial`  `video.setMask`  `video.clearMask`  `video.setOpacity`  `video.setBackgroundColor`  `video.setBackgroundBlur`  `video.setBackgroundImage`  `video.clearBackground`  `video.formatVideo`  `video.setTransition`  `video.updateTransition`  `video.clearTransition`  `video.setFade`  `video.denoiseOn`  `video.denoiseOff`  `video.addAnimation`  `video.updateAnimation`  `video.deleteAnimation`  `video.setSpeed`  `video.pitchOn`  `video.pitchOff`  `video.setCurveSpeed`  `video.seprateAudio`  `video.setMatting`  `video.clearMatting`  `video.reverse`  `video.crop`  `video.muteOn`  `video.muteOff`  `video.setBasicColor`  `video.resetBasicColor`  `video.setVolume`  `video.setFigure`  `video.setMakeupRoot`  `video.clearFigure`  `video.setFigureFaceId`  `video.setMix`  `video.setChromaColor`  `video.setChromaIntensity`  `video.setChromaShadow`  `video.setChromaEdgeSmooth`  `video.setChromaSpill`  `video.resetChroma`  `video.applyAllChroma`  `video.removeSmartCrop`  `video.addSmartCrop`  `video.setSmartColorAdjust`  `video.setStable`  `video.setVideoAlgorithm`  `video.addDigitalHuman`  `video.updateDigitalHuman`  `video.updateDigitalHumanRendered`  `video.addObjectLocked`  `video.updateObjectLocked`  `video.removeObjectLocked`

### `audio`（24）

`audio.add`  `audio.setVolume`  `audio.setFade`  `audio.denoiseOn`  `audio.denoiseOff`  `audio.pitchOn`  `audio.pitchOff`  `audio.setVoiceEffect`  `audio.setVoiceEffectParams`  `audio.clearVoiceEffect`  `audio.setVoiceEffectToAll`  `audio.setVocalSeparation`  `audio.updateVocalSeparation`  `audio.removeVocalSeparation`  `audio.setVocalBeautify`  `audio.updateVocalBeautify`  `audio.resetVocalBeautify`  `audio.removeVocalBeautify`  `audio.setSpeed`  `audio.modifiedToneOn`  `audio.modifiedToneOff`  `audio.setMaterial`  `audio.addBeat`  `audio.removeBeat`

### `text`（16）

`text.add`  `text.setMaterials`  `text.addSubtitles`  `text.setFixedSize`  `text.addAnimation`  `text.updateAnimation`  `text.deleteAnimation`  `text.addVideoTracker`  `text.updateVideoTracker`  `text.removeVideoTracker`  `text.deleteTextToAudioIds`  `text.updateSubtitleTemplate`  `text.resetSubtitleTemplate`  `text.updateEffect`  `text.setSubtitleKeywords`  `text.clearSubtitleKeywords`

### `textTemplate`（8）

`textTemplate.add`  `textTemplate.setMaterial`  `textTemplate.addAnimation`  `textTemplate.updateAnimation`  `textTemplate.deleteAnimation`  `textTemplate.addVideoTracker`  `textTemplate.updateVideoTracker`  `textTemplate.removeVideoTracker`

### `sticker`（7）

`sticker.add`  `sticker.addAnimation`  `sticker.updateAnimation`  `sticker.deleteAnimation`  `sticker.addVideoTracker`  `sticker.updateVideoTracker`  `sticker.removeVideoTracker`

### `effect`（3）

`effect.add`  `effect.updateAdjustParams`  `effect.resetAdjustParams`

### `filter`（2）

`filter.add`  `filter.update`

### `adjustment`（3）

`adjustment.add`  `adjustment.setBasicColor`  `adjustment.resetBasicColor`

### `keyframe`（3）

`keyframe.add`  `keyframe.delete`  `keyframe.update`

### `template`（4）

`template.setMutableVideos`  `template.setMutableAudios`  `template.setMutableTexts`  `template.setTemplateMute`

### `templateCombination`（3）

`templateCombination.templateCombinationAdd`  `templateCombination.replace`  `templateCombination.setSize`

### `attachment`（13）

`attachment.insertAsyncTasks`  `attachment.deleteAsyncTasks`  `attachment.updateAsyncTasksStatus`  `attachment.insertVideoAlgorithms`  `attachment.deleteVideoAlgorithms`  `attachment.updateVideoAlgorithm`  `attachment.insertAiWriterInfos`  `attachment.deleteAiWriterInfos`  `attachment.updateAiWriterInfo`  `attachment.setAiCreatorContent`  `attachment.updateAiCreation`  `attachment.updateAiReel`  `attachment.updateAiReelAgent`

### `story`（11）

`story.deleteAiStoryAlternative`  `story.addAiStoryAlternativeMaterials`  `story.cloneAiStoryAlternativeMaterials`  `story.deleteAiStoryAlternativeMaterials`  `story.updateAiStoryAlternativeMaterial`  `story.pinAiStoryAlternativeMaterial`  `story.updateMoveFeedsToAlternative`  `story.updateStoryId`  `story.innerReplace`  `story.innerReplaceStack`  `story.findInnerReplaceIds`

### `undoRedo`（6）

`undoRedo.undo`  `undoRedo.redo`  `undoRedo.canUndo`  `undoRedo.canRedo`  `undoRedo.getTopItemId`  `undoRedo.resetUndoRedo`

### `batch`（3）

`batch.batchStart`  `batch.batchEnd`  `batch.freezeVideo`

## 已确证参数契约的 op

> 只列**实测过参数**的。判据是**回读草稿后字段真的变了** —— 不是"官方说 accepted"。

| op | 参数 | 实测依据 |
|---|---|---|
| `text.add` | `{content, startTime, duration, trackIndex, needInsertTargetTrack}`（也接受 `segInfo.material.content` / `segInfo.timeRange.start|duration`） | 落成 text 轨的段，`target_timerange` = 期望值（按 {fps{'}'} 帧对齐，误差 ≤ 1 帧） |
| `video.add` | `{path, startTime?, sourceDuration?, ...}`（顶层 `path`） | 顶层 `path` ⇒ `video_source_unreadable`（认）；`videos:[{path}]` ⇒ `video_path_required`（不认） |
| `audio.add` | `{audioPath}` | `audio_source_unreadable` |
| `video.setVolume` | `{segmentId, volume}` | 草稿里 `segment.volume` 0.99 → 0.2 |
| `segment.split` | `{segmentId, splitTime}`（★ 不是 `splitTimeUs`） | 时间线 9033333 → 8033333 µs |
| `segment.delete` | `{segmentId}` | 段数 −1 |
| `text.setMaterials` | `{updates:[{segmentId, ...}]}` | 报 `text_updates_required` ⇒ 认 `updates` 数组 |
| `draft.*`（11 个） | 需先有 snapshot | 报 `draft_snapshot_required` |

## ★ 三个坑（都是"accepted 但没生效"那一类）

### 1. `accepted:true` ≠ 生效
`segment.setTimeRange` 传 `startUs/durationUs` ⇒ 官方回 `accepted:true`，但回读时码变成 **0/0**
（它不认这个键名，把没识别的字段当 0 写进去了）。⇒ **判据必须是"回读草稿，字段真的变了"**。

### 2. `needInsertTargetTrack` + `trackIndex` 会把段塞进错的轨
`text.add` 的 `needInsertTargetTrack=true` 时，段会插进 `trackIndex` 指向的那条轨 ——
**哪怕它是 video 轨**。⇒ 要往同一条 text 轨里放多条字幕，得：
第一条 `needInsertTargetTrack:true` 建轨 ⇒ 读回那条 text 轨的下标 ⇒ 之后
`needInsertTargetTrack:false` + 该下标。

### 3. `text.addSubtitles`（官方专门的加字幕 op）参数还没探对
已知骨架：`{type, trackIndex, segInfos:[{timeRange:{start,duration}, material, segmentId}]}`，
`type` 要**数值枚举**（`MetaTypeSubtitle=10` / `MetaTypeLyrics=11`），
`material.words[]` 是逐词时间轴（`{text, startTime, endTime}`）。
实测：各种形态都**只建了空 text 轨、没落段**。
⇒ **但普通 `text.add` + `startTime/duration` 已经能落出带时码的文字（= 字幕轨）** ⇒ 走那条路。


## ★ 音频 AI 效果类 op（实测 2026-10-21）

| 能力 | op | 参数 | 落成 | 能不能真算 |
|---|---|---|---|---|
| **降噪** | `video.denoiseOn`（★ **不是** `audio.denoiseOn`） | `{segmentId, isDenoise?, denoiseMode?, denoiseRate?}` | `materials.realtime_denoises[]`：`{type:"realtime_denoise", sami_name:"denoise_v2", sami_version:"1.0", is_denoise, denoise_mode, denoise_rate}` | ✅ **本地 SAMI 实时 DSP**，不依赖云端 |
| **人声美化** | `audio.setVocalBeautify` | `{segmentId, enable:true}` | `materials.vocal_beautifys[]`：`{type:"vocal_beautify", enable, ambient_sound_level:75, voice_change_mode:null, production_path:""}` | ✅ **本地实时**（`production_path` 为空 ⇒ 不是云端产出） |
| **变声** | `audio.setVoiceEffect` | `{segmentId}` | `materials.audio_effects[]` | ✅ 本地 |
| **人声分离** | `audio.setVocalSeparation` | ★ 参数未探对（6 种形态都无变化） | 结构已知：`{type:"vocal_separation", choice, removed_sounds, time_range, final_algorithm:"", production_path:""}` | ⚠️ **写引用可以，产出拿不到** —— `production_path`/`final_algorithm` 为空 ⇒ 分离是**剪映的 AI 任务**（与 ASR 同类，在 agent runtime / 云端） |

**键名风格**：`isDenoise`/`is_denoise`、`denoiseMode`/`denoise_mode` 两种都认；`enable` 只认 `enable`（`isEnable` 无效）。

## 关键入口速查

| 想做的事 | 走哪个 op |
|---|---|
| **加字幕** | `text.add {content, startTime, duration}`（落成 text 轨的段） |
| 官方原生字幕（带逐词时间轴/歌词） | `text.addSubtitles`（参数待探） |
| **调色写回草稿** | `effect.add` / `effect.updateAdjustParams` / `adjustment.add` / `adjustment.setBasicColor` / `filter.add` / `keyframe.*` / `video.setBasicColor` / `video.setSmartColorAdjust` |
| 调色 material 集合（草稿里现成就有） | `materials.hsl` · `materials.hsl_curves` · `materials.color_curves` · `materials.log_color_wheels` · `materials.primary_color_wheels` · `materials.material_colors` |
| 抠像 / 绿幕 | `video.setMatting` · `video.setChroma*` · `video.applyAllChroma` |
| 变声 / 人声分离 / 美颜 | `audio.setVoiceEffect` · `audio.setVocalSeparation` · `audio.setVocalBeautify` |
| 转场 / 淡入淡出 / 变速 | `video.setTransition` · `video.setFade` · `video.setSpeed` · `video.setCurveSpeed` |
| 模板里的可变文字 | `template.setMutableTexts`（官方自己报 `template_mutable_text_action_missing` ⇒ 未实现） |
| 数字人 | `video.setFigure` · `video.setDigitalHuman` · `video.setMakeupRoot` |

## 复现

```bash
node tools/probe-op-whitelist-full.mjs    # 199 个 op 逐个打桥，输出放行/缺参/被拒
node tools/probe-text-timing-final.mjs    # text.add 的 startTime/duration 实测
node tools/probe-subtitle-final.mjs       # text.addSubtitles 的参数形态
```
