# 第三方组件与许可声明

本技能包含改编自第三方开源项目的内容。按 MIT 许可要求,原版权声明与许可原文如下。

---

## html-ppt-skill

- **来源**:https://github.com/lewislulu/html-ppt-skill
- **版权**:Copyright (c) 2026 lewis <sudolewis@gmail.com>
- **许可**:MIT
- **引入日期**:2026-09-17
- **改编范围**(均经改写以适配本技能的单页静态渲染与音画同步体系):
  - `scripts/init-project.mjs` 生成的 `slides/tokens.css`:
    - 10 套命名主题(`minimal-white` / `swiss-grid` / `corporate-clean` / `editorial-serif` /
      `magazine-bold` / `tokyo-night` / `catppuccin-mocha` / `nord` / `xiaohongshu-white` / `soft-pastel`)
      的配色令牌 —— 变量名已映射为本技能的命名(`--surface`→`--panel`、`--text-1/2/3`→`--fg/--muted/--fg-3`、
      `--border`→`--line` 等),外链字体(Playfair Display / Space Grotesk 等)已替换为本地字体栈
    - 图片框原语 `.img-frame` / `.contain` / `.fill` / `.img-scrim` / `.img-cap` / `.img-tag` 及其
      `--img-ratio` / `--img-pos` 变量
    - 部分入场动画的 keyframes(`fx-blur` `fx-rise` `fx-pop` `fx-spotlight` `fx-ripple` `fx-glitch`
      `fx-shimmer` `fx-kenburns` `fx-stagger`)—— 触发机制已由"切页时 JS 重新触发"改为
      "`animation-delay: var(--tN)` 绝对时间",以配合逐帧步进渲染
    - 排版角色与容器类 `.kicker` / `.eyebrow` / `.lede` / `.card`(含三变体)/ `.pill` / `.divider-accent`
  - `references/authoring.md` 的部分版式骨架改写自其 `templates/single-page/` 下的同名版本
  - `references/image-sources.md` 的图片框使用规范参照其 `.img-frame` 设计意图

**未引入的部分**(与其设计不兼容或有额外依赖):`runtime.js`(键盘导航/演讲者模式/概览)、
`assets/animations/fx/` 下的 20 个 canvas 特效(rAF 驱动,无法被逐帧 seek)、
`fonts.css` 与全部 Google Fonts 外链、Chart.js / highlight.js CDN 依赖、`@media print` 分页逻辑。

其中"翻页看一遍"的需求由自研的 `scripts/preview-page.mjs`(生成 `preview/play/index.html`)自行实现,
代码与上游无关:上游 runtime.js 是给"真人现场演讲"用的(演讲者窗口、逐字稿提词、计时器、BroadcastChannel 双窗同步),
本技能产出的是视频,没有现场讲这个动作;放映页只做逐张回放 + 动效开关对照 + 口播面板。

### MIT 许可原文

```
MIT License

Copyright (c) 2026 lewis <sudolewis@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

**商用说明**:MIT 许可允许商业使用、修改、再分发与再许可,唯一义务是保留上述版权与许可声明。
本技能生成的最终产物(视频、字幕、封面等)属于使用者自己的创作,不继承上述许可义务。
