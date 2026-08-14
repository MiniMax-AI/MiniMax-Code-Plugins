---
name: agnes-media
description: Use when 用户用 Agnes AI 生成图片或视频。跑 scripts/agnes.py。
version: 1.0.0
author: Fectivnfy112357
license: MIT
---

# Agnes AI 生图 / 生视频

## Overview

封装 Agnes AI 两个生产模型的调用。Agent 只负责写 prompt 和传参数，脚本接管请求构建、任务轮询、结果下载、错误处理。

- **图像** `agnes-image-2.1-flash`：文生图 / 图生图 / 多图合成，URL 或 Base64 输出，同步（秒级）。
- **视频** `agnes-video-v2.0`：文生视频 / 图生视频 / 关键帧动画，异步任务（先创建再轮询）。

脚本：`scripts/agnes.py`，标准库实现，零第三方依赖，Python 3.8+ 均可。

## When to Use

- 用户要「生成一张图」→ 文生图；「按描述改这张图」→ 图生图；「把几张图合成」→ 多图合成。
- 用户要「生成视频」→ 文生视频；「让这张图动起来」→ 图生视频；「两帧/多帧之间过渡」→ 关键帧动画。
- 写 prompt 前先读 `references/prompt-styles.md`（推荐结构 + 示例）。
- **不要用本 skill 做**：工具/模型选型与对比 → `ai-media-generation-tools` skill。

## 前置：API Key

脚本按顺序读取：`--api-key` 参数 → `AGNES_API_KEY` 环境变量 → `~/.hermes/.env` 文件里的 `AGNES_API_KEY`。

key 已通过环境变量 `AGNES_API_KEY` 提供（`~/.bashrc` 里 export），脚本开箱即用。想迁移到 Hermes 统一管理，可用 `hermes config set AGNES_API_KEY=xxx` 写进 `~/.hermes/.env`——脚本会直接解析该文件。
明文不进 skill 目录（避免被 skill 同步/分享时泄露）。

## 固定流程

统一脚本 + 两个子命令：

```
python <skill_dir>/scripts/agnes.py image ...   # 图像，同步
python <skill_dir>/scripts/agnes.py video ...   # 视频，异步（脚本内部轮询）
```

`<skill_dir>` = 本 skill 的安装目录（SKILL.md 所在目录；由宿主的技能加载器提供，如 `skill_view` 的 `skill_dir` / `resourceBase` 字段）。执行脚本统一用：`python "<skill_dir>/scripts/agnes.py" ...`。

### 图像（同步，秒级返回）

```bash
python .../scripts/agnes.py image \
  --prompt "日出薄雾峡谷上方的发光浮空城市，电影级写实，广角，高视觉密度" \
  --size 2K --ratio 16:9 --out ~/Downloads
```

| 参数 | 说明 |
|---|---|
| `--prompt` | 必填，风格见 prompt-styles.md |
| `--size` | 档位 `1K/2K/3K/4K`，默认 `1K` |
| `--ratio` | `1:1/3:4/4:3/16:9/9:16/2:3/3:2/21:9`，默认 `1:1` |
| `--image` | 图生图/多图合成：本地路径或 URL，可多次传入；本地文件自动转 data URI |
| `--format` | `url`（默认）或 `b64` |
| `--out` | 输出目录，默认 `~/Downloads` |

### 视频（异步，分钟级，脚本自动轮询）

```bash
python .../scripts/agnes.py video \
  --prompt "A young astronaut walking across a red desert planet, dust blowing in the wind, slow cinematic tracking shot, dramatic sunset lighting, realistic sci-fi style" \
  --duration 5 --out ~/Downloads
```

| 参数 | 说明 |
|---|---|
| `--prompt` | 必填 |
| `--image` | 图生视频：输入图（本地路径或 URL） |
| `--keyframes` | 关键帧动画：多个输入图（本地或 URL，至少 2 个） |
| `--duration` | 目标时长（秒），脚本自动算 `num_frames`（8n+1 且 ≤441） |
| `--num-frames` / `--frame-rate` | 手动指定（高级，绕过 --duration） |
| `--width` / `--height` | 默认 `1152x768` |
| `--seed` / `--negative-prompt` | 可复现 / 排除内容 |

## 提示词风格

→ `references/prompt-styles.md`：文生图 / 图生图 / 多图合成 / 高信息密度 + 文生视频 / 图生视频 / 关键帧动画的推荐结构 + 中英文示例。**写 prompt 前先读，套结构而非空想。**

## 参数详情

→ `references/api-reference.md`：尺寸档位表、ratio 输出尺寸表、视频时长表、任务状态、错误码、定价。

## Common Pitfalls

1. **图像 `response_format` 别放顶层**：脚本已按正确位置处理（url→`extra_body.response_format`；文生 b64→顶层 `return_base64`；图生 b64→`extra_body.response_format=b64_json`）。不要手改 payload。
2. **图生图别传 `tags:["img2img"]`**：文档明确不需要，脚本也不会传。
3. **视频 `num_frames` 必须满足 `8n+1` 且 ≤441**：用 `--duration` 让脚本算，别手填 120 这类非法值。
4. **视频是异步的**：脚本内部轮询（5s 间隔，最长 10 分钟）。不要以为无返回就是失败。
5. **本地图片**：图像/视频脚本都会把本地文件自动转 data URI，实测图像与视频 API 均接受（视频网关会把 data URI 落盘成内部 URL 再处理）。无需手动上传图床。
6. **选型问题别混进来**：本 skill 只执行生成；工具/模型选型走 `ai-media-generation-tools`。

## Verification Checklist

- [ ] 输出文件存在于 `--out` 目录且非空（图像 >10KB，视频 >100KB）
- [ ] 视频任务 `status=completed`，`metadata.url` 已下载
- [ ] 脚本末尾打印的 JSON 里 `ok=true` 且含 `files` 绝对路径
- [ ] 用 `vision_analyze` / `video_analyze` 抽查成片质量
