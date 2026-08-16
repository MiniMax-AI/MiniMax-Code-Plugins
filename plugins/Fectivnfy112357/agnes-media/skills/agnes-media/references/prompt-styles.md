# Agnes 提示词风格参考

落地自 Agnes 官方文档（图像 2.1 Flash + 视频 V2.0）。写 prompt 时套用对应结构、按需组合元素，不要空想。

## 图像（agnes-image-2.1-flash）

### 文生图

结构：`[主体] + [场景/环境] + [风格] + [光照] + [构图] + [质量要求]`

中文示例：

> 日出时分薄雾峡谷上方的发光浮空城市，电影级写实风格，广角构图，丰富的建筑细节，柔和的金色光线，高视觉密度

英文示例：

> A luminous floating city above a misty canyon at sunrise, cinematic realism

要点：主体在前，随后堆叠场景→风格→光照→构图→质量。

### 图生图

结构：`[改变要求] + [新风格/场景] + [需添加或移除的元素] + [需保留的元素]`

中文示例：

> 将白天街道场景改为电影级赛博朋克夜景，添加霓虹招牌和湿滑路面倒影，同时保留原始街道布局、相机角度和主要建筑形状

英文示例：

> Transform the scene into a rain-soaked cyberpunk night with neon reflections while preserving the original composition

要点：说清「改什么」和「保留什么」——构图保留是 2.1 的核心能力。

### 多图合成

结构：`[参考图角色] + [目标场景] + [图像间关系] + [风格/光照/构图]`

中文示例：

> 将第一张图作为主要角色，第二张图作为产品参考，生成一张电影级活动海报，保留角色身份和产品外形，使用自然光照和干净的商业构图

英文示例：

> Combine the two characters into an intense fantasy battle scene, dynamic lighting, detailed background, cinematic composition

要点：明确每张参考图的角色，以及最终图如何组合它们。

### 高信息密度图像

结构：明确视觉层次——主要主体、背景环境、重要次要细节、风格、光照、构图约束。

示例：

> 建在悬崖上的大型奇幻港口城市，数百艘小船，层叠的石桥，发光的窗户，远山，多云的日落天空，电影级奇幻写实风格，广角构图，丰富的建筑细节，高视觉密度

---

## 视频（agnes-video-v2.0）

### 文生视频

结构：`[主体] + [动作] + [场景] + [镜头运动] + [光线] + [风格]`

示例：

> A young astronaut walking across a red desert planet, dust blowing in the wind, slow cinematic tracking shot, dramatic sunset lighting, realistic sci-fi style

要点：动作和镜头运动是关键（区别于静态图），明确主体在做什么、镜头怎么动。

### 图生视频

结构：描述「哪些该动」+「哪些主体元素保持稳定」。

示例：

> Animate the character with subtle breathing motion, hair moving gently in the wind, background lights flickering softly, while keeping the face and outfit consistent

要点：同时约束运动元素和一致性元素。

### 关键帧动画

结构：清晰描述关键帧之间的过渡关系 + 一致性约束。

示例：

> Create a smooth transition from the first keyframe to the second keyframe, maintaining character identity, consistent camera angle, and natural motion between scenes

要点：点明过渡的目标（平滑、自然），并锁住身份/机位/运动的一致性。

---

## 通用要点

- **英文 prompt 通常更稳**：官方示例均为英文；中文示例由文档原文给出，亦可直接用。
- **主体放最前**：两种模型的推荐结构都以主体开头。
- **一致性约束要显式写**：图生/关键帧/多图都要写「保留 / 保持 X」。
- **视频必须写动作和镜头**：纯静态描述生成不出运动。
