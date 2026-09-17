# 章鱼表情包生成器 Octopus Meme Maker

把一段场景描述变成 Smooth Squishmallow 风格的粉红色章鱼打工人 GIF 表情包。包内自带完整 4 阶段流水线（基础姿态 → 6 秒视频 → 透明文字叠加 → 720×720 GIF），以及组装最终 480×480 小图的跨平台脚本。

## 试试看

```text
给我做一个新的章鱼打工人表情包：摆烂躺平（趴在桌上，一只眼睛半闭，另一只全闭，一条触手尖端着一杯咖啡）。
角色必须和 examples/*.png 里的 3D Squishmallow 风格 base 图一致。
结果存到 <scene-dir>/，按 skills/octopus-meme-maker/SKILL.md 里的 4 阶段流水线执行（6 张候选拼图 → 用户挑选 → base.png）。
```

预期产物：`<scene-dir>/base.png`（1024×1024 底图）→ `<scene-dir>/video.mp4`（1080p 6 秒 24fps，141 帧）→ `<scene-dir>/final.gif`（720×720，141 帧）→ `<scene-dir>/final-mini.gif`（480×480，141 帧）。

## 包内有什么

- `skills/octopus-meme-maker/SKILL.md` — 4 阶段流水线 + 禁用清单 + 每步的退出条件
- `skills/octopus-meme-maker/reference.md` — 角色解剖、风格规则、提示词模板、参考图清单
- `skills/octopus-meme-maker/issues.md` — 已知失败模式与反馈信号对照
- `scripts/make_text_overlay.py` — 渲染透明中文文字叠加层（Pillow，跨平台字体探测）
- `scripts/make_preview_strip.py` — 从 6 秒视频抽 5 个关键帧拼成预览条
- `scripts/make_gif.py` — 由视频 + 叠加层组装 720×720 `final.gif` 与 480×480 `final-mini.gif`（调用 ffmpeg）
- `examples/` — 3 张底图样片，**就是真正的角色 / 风格参考**。每次新建场景都必须把这 3 张全部作为 `input_file_paths` 传给 `image_synthesize`，用来锁住 Squishmallow 风格、解剖和渲染氛围；场景构图由 prompt 覆盖：`02-stay-late-base.png`、`10-toilet-slacking-base.png`、`11-touch-fish-base.png`
- `reference/videos/` — 2 个 H3 源视频样片（768×768、24fps、6.58 秒、h264+aac）：`breakdown-h3.mp4`（我裂开了）、`treat-milk-tea-h3.mp4`（请大家喝奶茶）
- `icon.png` — 插件图标（512×512 PNG）

## 依赖

- `minMcodeVersion`：`0.2.0`（流水线用到 `image_synthesize` 与 `gen_videos` 两个宿主工具，二者在 0.2.0 起稳定）
- Python 3.10+
- `pip install Pillow`
- `ffmpeg` 5.0+，且在 `PATH` 上（用 `ffmpeg -version` 验证）。脚本使用 `-fps_mode`，该参数在 ffmpeg 5.0 取代了 `-vsync`；`make_gif.py` 会预先检查主版本号，版本过低时给出明确报错。
- 系统中需安装一个中文字体用于文字叠加。脚本会按下列顺序自动挑选第一个存在的：
  - macOS：`/System/Library/Fonts/STHeiti Medium.ttc`、`/System/Library/Fonts/PingFang.ttc`
  - Linux：`/usr/share/fonts/truetype/wqy/wqy-microhei.ttc`、`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`
  - Windows：`C:\Windows\Fonts\msyh.ttc`、`C:\Windows\Fonts\simhei.ttf`
  - 也可用 `--font <路径>` 手动指定。
- MiniMax Code 的 `image_synthesize` 与 `gen_videos` 工具（流水线第 1、2 阶段使用；不属于本插件，属宿主能力）。

## 本插件不做什么

- **不涉及任何凭据**：不读取、不写入、不接受、不传输任何 API Key、OAuth token、refresh token、client secret、用户名、密码或其他形式的认证凭据。没有登录流程，不设置 `Authorization` 头。
- **运行时不联网**：包内 Python 脚本完全在本机运行，只调用本机的 `ffmpeg` 与 `Pillow`，不建立任何 TCP / UDP / WebSocket 连接。
- **无埋点**：不 phone home、不记录使用情况、不内嵌任何分析 SDK。不含 Google Analytics、Sentry、Mixpanel、Cloudflare beacon 或错误上报。
- **不调用第三方服务**：插件本身不发起任何远程调用。（流水线第 1、2 阶段调用 MiniMax Code 的 `image_synthesize` 与 `gen_videos` 宿主工具，那属于宿主运行时，插件自身不发起远程调用。）

## 支持平台

- macOS 13+（原作者在 macOS 上验证）
- Linux（Ubuntu 22.04+、Debian 12+；只需 ffmpeg + Python + Pillow）
- Windows 10/11（PowerShell 或 Git Bash；流水线是纯 Python + ffmpeg 子进程调用）

## 数据与网络

- 运行时无网络访问，完全在本机运行。
- 角色生成步骤（第 1、2 阶段）调用宿主提供的图像与视频合成工具；那不属于本插件职责，其网络与数据行为遵循宿主策略。
- 不打包任何凭据、账号、付费服务、埋点、安装器、符号链接或原生二进制。

## 自检

在本插件根目录执行：

```bash
python3 scripts/make_text_overlay.py "再熬一会" /tmp/octopus_test_overlay.png
python3 scripts/make_preview_strip.py /path/to/some/video.mp4 /tmp/octopus_test_strip.png
python3 scripts/make_gif.py /path/to/some/scene-dir "再熬一会"
```

三个脚本都必须退出码为 0，并生成对应输出文件。

## 打包与提交

本目录同时是社区仓库插件和 MiniMax Marketplace 包：

- `plugin.json` — 社区仓库清单（`$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`）
- `.minimax-plugin/plugin.json` — Marketplace 入口清单。Marketplace 的 ZIP 或 GitHub 子目录提交必须让该文件直接位于根目录

**关于图标**：`icon.png` 由 Marketplace 清单的 `icon` 字段引用。客户端渲染插件时读取的是服务端 catalog 返回的 `icon_url`，不会读取本地目录里的 `icon.png`。因此本图标只有在插件**发布到 Marketplace 之后**才会显示；从社区仓库本地安装的插件在客户端里会显示默认图标，这是预期行为。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE)。
