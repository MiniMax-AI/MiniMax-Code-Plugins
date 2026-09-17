# TTS 对接与对时算法

## 为什么 TTS 在 HTML 之前(本流水线与常见做法的最大差异)

常见顺序是"先写 HTML 再配音",这会逼你**估算**每张时长、**猜**动画延迟,产出的典型症状就是:TTS 念完画面还傻等好几秒(估长了)、展开层在口播已经讲到别处时才出现(猜错了)。

本流水线反过来:脚本定稿 → 立刻出 TTS → ffprobe 实测 → 算好每个 stage 的入场时刻 → 才动 HTML。HTML 里没有任何写死的秒数,所有延迟通过 `--t1/--t2/--t3` 由 capture 注入。改音色、改语速、改一个字,只需重跑 TTS 和 plan-timings,HTML 通常一个字不用动。

## 对时算法(plan-timings.mjs 内部逻辑)

对每张 slide:

1. `D` = ffprobe 实测该段 TTS 时长。
2. 第 k 句口播的开口时刻 ≈ `D × (前 k−1 句字数和 ÷ 总字数)`(中文语速在句间分布足够均匀,误差通常 <0.3s)。
3. stage s 的入场时刻 = 映射到该层的最早一句的开口时刻 − 0.2s(视觉略提前,观感同步;广播惯例)。
4. 成片时长 = `ceil((D + tail) × fps) / fps`,对齐帧网格;`tail` 默认 0.8s。

字数统计忽略空白,标点计入(TTS 遇标点会自然停顿,计入反而更准)。

对时数据有三层,层层可实测回查,怀疑音画脱节时**先拿数据再动手**:

1. **估算**(plan-timings):上表的字数占比估算。对正常语速样本误差通常 <0.3s。
2. **静音实测**(`node scripts/check-timing.mjs <项目目录>`):TTS 句间有 0.2s+ 停顿,脚本用 ffmpeg silencedetect 直接测出每句真实开口,输出"估算 vs 实测"对比表;`--calibrate` 把实测边界写回 timings.json(只校准静音段数与句数完全匹配的 slide),之后删 `build/frames/` 重跑 capture 与 build-video。
3. **ASR 复核**(build-video `--asr`):按句切出音频逐段转写,既验内容(数字/专名),也验边界——某段转写混入上一句的开头,说明那句实际开口比估算晚,回第 2 层校准。

另注意"体感不同步"常是**设计层错位**而非算法误差:大数字/主体图必须挂在**提到它的那句**的 stage 上(见 authoring.md 强同步原则),把第一句的亮点画在 stage 2 里,算法再准观众也觉得脱节。

## 留白调校

留白 = 每张的 `tail`(口播结束到切页)。默认 **0.8s**:低于 0.5s 观众有被追赶感,高于 1.5s 就是"念完发呆"。

- 整片节奏紧凑(快消风格):script.json 每张加 `"tail": 0.4`。
- 讲述舒缓(品牌片):`"tail": 1.2`,首尾张 1.5。
- 单张微调:只改那一张的 `tail`,重跑 plan-timings 即可,不用重做 TTS。

语速:整体 1.0;首尾张 0.95 略慢有仪式感。如果 plan-timings 警告语速偏离 3–6.5 字/s,先检查是不是 speed 设错或字数超限,不要急着 --pacing 重估。

⚠ **实测坑:`speed=0.95` 对短句(≤10 字)可能不降反升** —— TTS 引擎在短句上似乎会补静音,导致时长反而变长(2026-09-17 端到端实测发现)。所以:首尾张若要 0.95,该张口播别太短;或者短句直接保持 1.0。

⚠ **stage 时序的前提**:入场延迟依赖 `--fx-delay` 机制(见 authoring.md 实现原理)。若页面用了旧版 tokens.css(把延迟写成独立的 `animation-delay: var(--tN)`),延迟会被 `.fx-*` 简写覆盖,表现为"部分元素 0 秒就入场"——这比估算偏差(通常 <0.3s)更影响体感,排查音画不同步时先排除它。

## mcode 环境的 TTS 命令

单条合成 / 批量合成(≤10 条/批):

```bash
mcode-tools connector call connector__matrix__batch_text_to_audio --args '{"requests": [
  {"text": "第一句口播。", "voice_id": "Chinese (Mandarin)_Gentleman", "speed": 1.0, "output_file": "01.mp3"},
  {"text": "……", "voice_id": "…", "speed": 0.95, "output_file": "08.mp3"}
]}'
```

结果取 `success_items[].node_id`,逐条拿下载链接落盘到 `audio/`:

```bash
mcode-tools get_asset_url <node_id>   # 得到 URL 后 curl 下载为 audio/<id>.mp3
```

音色候选用 `connector__matrix__get_voice_list` 查;开工对齐时先问用户音色倾向(温润男声/干练女声/其他)。

**⚠ 音色名称不可信,试听必须带 ASR 验音(2026-09 实测教训)**:平台标签会错位——`Chinese (Mandarin)_News_Anchor` 标着普通话新闻女声,实际生成**粤语**(ASR 转写出"來自/從"等繁体)。只看名字选声 = 盲选。正确流程:

1. 取 3 个候选音色,各自单条 TTS 一句固定探针文案(含数字与专名,如"三家科技公司,去年营收三点五亿美元。")——**单条**生成,避免批量配对错位;
2. 每段转写验证(mcode 用 `listen_audio`;其他环境用 `node scripts/asr.mjs --file probe.mp3 --language zh`),检查:转写是**简体**普通话(出现繁体字 = 粤语/其他语种,弃)、数字念对、无明显吞字;
3. 把"实测语种"标注进试听清单,连同音频给用户三选一(阶段在 Phase 1,别跳过)。

**强制普通话的窍门**:调用时带 `language: zh` 头(脚本的 `--language zh`),模型会按普通话解码;若结果里仍出现繁体字(如 來/從/聲/畫),基本可判定该音色实际输出的是粤语。反向确认粤语可用 `--language yue`。

实测可用的普通话音色(2026-09-17,mcode matrix):

| voice_id | 标签名 | 实测 |
|---|---|---|
| `Chinese (Mandarin)_Gentle_Senior` | 温柔学姐 | ✅ 普通话,干练 |
| `Chinese (Mandarin)_Sweet_Lady` | 甜美女声 | ✅ 普通话,亲和(**2026-09-17 实测主用**) |
| `Chinese (Mandarin)_Crisp_Girl` | 清脆少女 | ✅ 普通话,清澈 |
| `Chinese (Mandarin)_Mature_Woman` | 傲娇御姐 | ✅ 普通话,讲述感 |
| `Chinese (Mandarin)_Wise_Women` | 阅历姐姐 | ✅ 普通话 |
| `Chinese (Mandarin)_Male_Announcer` | 播报男声 | ✅ 普通话(可用) |

| voice_id | 标签名 | 实测 |
|---|---|---|
| `Chinese (Mandarin)_News_Anchor` | 新闻女声 | ❌ 实际输出**粤语**,勿用 |

(音色库会漂移,此表只是起点;每次开新项目仍要走上面的 ASR 验音三步。)

## 语种与音色(开工对齐必问)

**口播语言在开工对齐时定死**,写进 `script.json` 的 `lang`(默认 `zh`)。它牵动四件事:

1. **口播稿**用什么语言写(`clauses[].text`);双语时 `text2` 放**另一语言**(主行=口播语言)。
2. **音色必须匹配语种** —— 中文用 `Chinese (Mandarin)_*`,英语用 `English_*`,粤语用对应粤语音色。错配的表现是"带口音/念错/语种漂移",写完必须用 ASR 验。
3. **字数与语速基准**:`plan-timings` 按 `lang` 自动切换 —— 中文 4.8 字/s(常见 3–6.5),英文 ~14 字符/s(常见 9–18,约 150 词/分);字幕单行上限中文 18 字 / 英文 42 字符。
4. **ASR 识别语言头**:`asr.mjs` 读 `lang` 自动带 `language: zh|en|yue`。中文项目会检查"是否冒出繁体字"(=粤语),英文项目会检查"是否混入中文字符"。

**换语言只需三步**:改 `script.json` 的 `lang` → 换匹配语种的 `voice_id` 重做 TTS → 若开双语,给每句补/换 `text2`。排版与脚本逻辑都不用动。

英语音色示例(mcode 与 mmx-cli 都会随平台更新,以实测为准):

```bash
# mcode: 列全部音色后挑 English_* 前缀的
mcode-tools connector call connector__matrix__get_voice_list --args '{}'
# mmx-cli: 同样先列再选
mmx speech voices
# mmx-cli 示例(官方文档中出现过的英语男声)
mmx speech synthesize --text "Three companies, three point five billion dollars." --voice English_magnetic_voiced_man --speed 1.0 --out audio/probe.mp3
```

验音同样要带语言头:`--language en`(英语)/ `--language zh`(普通话)/ `--language yue`(粤语)。



## BGM(可选,默认不开)

配置一次即可,全片自动垫底:script.json 顶层加 `"bgm": "assets/bgm.mp3"`(或对象形式 `{file, volume, fadeIn, fadeOut}`)。build-video 会:循环补满全片、淡入 1.5s、尾部淡出 2.5s、按 `volume`(默认 **0.12**,即 -18.4dB)压在人声之下;混音失败自动退回纯人声并告警。**ASR 校验始终切纯人声轨**,BGM 不干扰转写。

- 音量校准:0.08(极克制,讲述向)~ 0.15(活泼,快消向);听感标准 = 人声每个字都清楚,关掉画面只听音轨也不费劲。成片验收时留意 Gate 5。
- BGM 来源:① `connector__matrix__batch_text_to_music`(mcode 平台生成,≤5 条/批,无版权风险,首选);② 用户自备音乐(须确认授权,登记进 assets/MANIFEST.md)。不要从视频网站扒音乐。**⚠ mmx-cli 没有音乐生成命令**,非 mcode 环境只能走 ②(或跳过 BGM)。
- 生成建议:风格按题材选(科技/温暖/轻快),**要求"无人声、无强旋律记忆点、可循环"**;拿到的文件放 `assets/bgm.mp3`,先单独听一遍确认没有突兀的段落切换(循环点要干净)。
- 需要 ffmpeg ≥ 4.4(amix 的 normalize 选项);老版本会自动跳过 BGM 而不是报错中断。

## 双语字幕(可选)

script.json 的 clause 里加 `text2` 即自动生效:画面字幕变两行(中文主行 + 第二行小字号)、`out/subs.srt` 同步双行。不需要改 HTML、不需要额外参数。

- `text2` 规则:同一句的翻译,**不要重排语序**;第二行 ≤60 字符(plan-timings 超限预警);标点用目标语言习惯。
- 只做部分句子也可以(逐句独立);交付前确认双语字幕的语种组合(Gate 1 对齐时问清是"中英"还是其他)。

**部分失败的重试纪律**:上游对失败重发整批很敏感(rate limit)。失败后 sleep 10–30s,**只重试失败的条目**(从 requests 里摘出失败的重新组一个小批),不要重发整批。

TTS 落盘后立刻:

```bash
node scripts/plan-timings.mjs <项目目录>
```

把输出的时长表和警告一起给用户过 Gate 2。此时若某张语速警告,优先改口播字数(回 Phase 1)或调该张 speed 重做该段——不要放着警告往下走。

## ASR 反向校验流程

build-video `--asr` 会**按句**切出 `asr/part-<id>-<k>.mp3`(第 id 张第 k 句),并生成 `checklist.md`。两条路任选:

**路 A · mcode 沙箱**
1. `mcode-tools upload_temp_url asr/part-01-1.mp3` 取公网 URL。
2. `mcode-tools connector call connector__matrix__listen_audio --args '{"audio_info": {"url": "<URL>"}}'`。
3. 转写文本与 checklist 里"预期口播"比对:数字、年份、产品名必须完全一致;同音字/标点差异可接受。

**路 B · 直调 REST(任何环境,只同一把 API Key;mmx-cli 无 ASR 子命令)**

```bash
export MINIMAX_API_KEY=sk-xxx          # 与 mmx-cli 同一把; 海外套餐加 MINIMAX_REGION=global
node scripts/asr.mjs <项目目录>          # 逐句转写 → 自动比对 → 回填 asr/checklist.md
```

- 脚本自动做**比对判定**:数字对不上、或出现繁体字(疑似粤语)→ ✗ 并让进程以非 0 退出;相似度偏低 → ⚠ 待复核。
- 音频超接口限制(>500s 或 >50MB)时会用 ffmpeg 自动转单声道 16k mp3 再传,不用手工处理。
- 已有转写结果(如别的环境用 whisper 跑的)可直接喂进来比对:`node scripts/asr.mjs <项目> --from transcripts.json`(JSON 形如 `{"part-01-1": "文本"}`)。
- 想要**字级时间戳实测每句开口**(比静音检测更准,接口支持 `timestamp_level: word`):`node scripts/asr.mjs <项目> --verify-timing`,输出"估算 vs ASR 实测"对比表,偏差大就按结果调整 `timings.json` 的 `clauses[].start` 后重渲染。

不过关的 slide:改口播或重做该段 TTS → 重跑 plan-timings → 删 `build/frames/<id>/` 与 `out/slide-<id>.mp4` → 重跑 capture(该张)与 build-video。不要整片重做。
