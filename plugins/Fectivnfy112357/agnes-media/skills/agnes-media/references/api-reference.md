# Agnes API 参数参考

整理自 Agnes 官方文档。脚本已封装这些参数，此处供 Agent 查表（尺寸映射、时长、状态、错误码）。

## 图像 API

- Endpoint：`POST https://apihub.agnes-ai.com/v1/images/generations`
- 模型：`agnes-image-2.1-flash`
- 请求头：`Authorization: Bearer <KEY>`、`Content-Type: application/json`

### 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `model` | 是 | `agnes-image-2.1-flash` |
| `prompt` | 是 | 生成/编辑指令 |
| `size` | 是 | 档位 `1K/2K/3K/4K`，也兼容 `1024x768` 历史写法（可能被标准化） |
| `ratio` | 否 | `1:1/3:4/4:3/16:9/9:16/2:3/3:2/21:9`，默认 `1:1` |
| `return_base64` | 否 | 文生图 Base64 输出用 |
| `extra_body.image` | 否 | 图生图/多图合成输入图（URL 或 Data URI），数组 |
| `extra_body.response_format` | 否 | `url` 或 `b64_json` |

### 输出尺寸表（size × ratio）

| Ratio | 1K | 2K | 3K | 4K |
|---|---|---|---|---|
| 1:1 | 1024x1024 | 2048x2048 | 3072x3072 | 4096x4096 |
| 3:4 | 864x1152 | 1728x2304 | 2592x3456 | 3456x4608 |
| 4:3 | 1152x864 | 2304x1728 | 3456x2592 | 4608x3456 |
| 16:9 | 1312x736 | 2624x1472 | 3936x2208 | 5248x2944 |
| 9:16 | 736x1312 | 1472x2624 | 2208x3936 | 2944x5248 |
| 2:3 | 832x1248 | 1664x2496 | 2496x3744 | 3328x4992 |
| 3:2 | 1248x832 | 2496x1664 | 3744x2496 | 4992x3328 |
| 21:9 | 1568x672 | 3136x1344 | 4704x2016 | 6272x2688 |

> `1920x1080` / `2560x1440` 非原生尺寸，会被标准化。要 16:9 显示素材请用 `size=2K, ratio=16:9`（得 2624x1472）再下游裁剪。

### 响应

- URL 输出：`data[0].url`
- Base64 输出：`data[0].b64_json`

### 关键约束

- `response_format` 不能放顶层：url → `extra_body.response_format`；文生 b64 → 顶层 `return_base64`；图生 b64 → `extra_body.response_format=b64_json`。
- 图生图不要传 `tags:["img2img"]`。
- 输入图无法公开访问时用 Data URI。
- 客户端超时建议 60–360s。

---

## 视频 API

- 创建：`POST https://apihub.agnes-ai.com/v1/videos`
- 查结果（推荐）：`GET https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>`
- 查结果（兼容旧版）：`GET https://apihub.agnes-ai.com/v1/videos/<TASK_ID>`
- 模型：`agnes-video-v2.0`

### 创建参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `model` | string | `agnes-video-v2.0` |
| `prompt` | string | 视频内容描述 |
| `image` | string | 图生视频输入图 URL |
| `mode` | string | `ti2vid` 或 `keyframes` |
| `height` | int | 默认 768 |
| `width` | int | 默认 1152 |
| `num_frames` | int | ≤441 且 8n+1 |
| `frame_rate` | number | 1–60 |
| `num_inference_steps` | int | 推理步数 |
| `seed` | int | 可复现 |
| `negative_prompt` | string | 排除内容 |
| `extra_body.image` | array | 关键帧模式输入图 URL 数组 |
| `extra_body.mode` | string | `keyframes` |

### 尺寸标准化

提交的宽高会被映射到最近的 480p/720p/1080p 标准档。以响应 `size` / `seconds` / `metadata.size_mapping` 为准。

### 时长控制

`seconds = num_frames / frame_rate`

| 目标时长 | 推荐参数 |
|---|---|
| 约 3 秒 | `num_frames: 81`, `frame_rate: 24` |
| 约 5 秒 | `num_frames: 121`, `frame_rate: 24` |
| 约 10 秒 | `num_frames: 241`, `frame_rate: 24` |
| 约 18 秒 | `num_frames: 441`, `frame_rate: 24` |

### 任务状态

| 状态 | 说明 |
|---|---|
| `queued` | 排队中 |
| `in_progress` | 生成中 |
| `completed` | 成功。视频 URL 在顶层 `url` 字段（文档示例写 `metadata.url`，实测无 `metadata` 包装，脚本两者都兼容） |
| `failed` | 失败（`error` 字段给原因） |

### 错误码

| 码 | 说明 |
|---|---|
| 400 | 参数无效 |
| 401 | key 未授权 |
| 404 | 任务/视频未找到 |
| 500 | 服务器错误 |
| 503 | 繁忙，稍后重试 |

---

## 定价

| 类型 | 标准价 | 当前价 |
|---|---|---|
| 图像 | $0.003/张 | $0/张 |
| 视频 | $0.005/秒 | $0/秒 |
