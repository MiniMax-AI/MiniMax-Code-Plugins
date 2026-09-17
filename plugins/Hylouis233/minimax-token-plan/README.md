# MiniMax Token Plan

Capability-aware MiniMax tools for MiniMax Code. The bundled, dependency-free MCP server exposes
Token Plan search, image understanding, image generation, voice listing, and text-to-speech, plus
optional pay-as-you-go video and legacy music/lyrics workflows.

## Why this plugin exists

MiniMax currently publishes two different MCP/API surfaces:

- Token Plan MCP exposes coding-plan search and image understanding.
- The general MiniMax API exposes image, speech, video, music, lyrics, and voice endpoints.

Those surfaces do **not** have identical entitlements. As of 2026-08-21, Token Plan explicitly
covers eligible text, image, and speech resources. MiniMax H3 video, voice design, rapid voice
cloning, and other special models require another billing route. Music and Lyrics APIs stopped
accepting new users on 2026-08-20; existing paying users may continue.

This plugin keeps those boundaries explicit instead of silently spending a different balance or
claiming that an unavailable model is part of Token Plan.

MiniMax M3/M2.7 language inference is intentionally not wrapped as an MCP tool: configure it as the
primary MiniMax Code model through the official OpenAI- or Anthropic-compatible provider endpoint.
This plugin supplies the external tools that the model can call.

## Configuration

Export environment variables before starting MiniMax Code:

```bash
# Token Plan Subscription Key (recommended for search, vision, image, and speech)
export MINIMAX_TOKEN_PLAN_API_KEY="your-subscription-key"

# Optional pay-as-you-go key for H3 video and legacy/special endpoints
export MINIMAX_PAYGO_API_KEY="your-paygo-key"

# Global or Mainland host; the key and host must belong to the same region
export MINIMAX_API_HOST="https://api.minimax.io"
# export MINIMAX_API_HOST="https://api.minimaxi.com"
```

For compatibility, `MINIMAX_API_KEY` is accepted. Set `MINIMAX_API_KEY_MODE=token-plan` (default)
or `MINIMAX_API_KEY_MODE=paygo` to state what that generic key represents. Explicit keys always
take precedence.

Keys are read from the process environment and are never returned by tools, written to disk, or
placed in prompts.

## Tools

| Tool | Key route | Notes |
|---|---|---|
| `minimax_get_capabilities` | none | Reports configured key classes and documented coverage; no network call. |
| `minimax_web_search` | Token Plan | Official `/v1/coding_plan/search`. |
| `minimax_understand_image` | Token Plan | Official `/v1/coding_plan/vlm`; HTTPS or bounded inline data-image sources only. |
| `minimax_generate_image` | Token Plan, fallback paygo | Text-to-image and one subject reference. |
| `minimax_list_voices` | Token Plan, fallback paygo | Read-only voice inventory. |
| `minimax_text_to_speech` | Token Plan, fallback paygo | Defaults to `speech-2.8-hd` and URL output. |
| `minimax_create_video` | paygo | MiniMax H3 V2 task creation. |
| `minimax_query_video` | paygo | Queries a video task; does not create or cancel work. |
| `minimax_generate_lyrics` | Token Plan or paygo / grandfathered | Existing eligible users only after 2026-08-20. |
| `minimax_generate_music` | Token Plan or paygo / grandfathered | Existing eligible users only after 2026-08-20. |
| `minimax_preprocess_music_cover` | Token Plan or paygo / grandfathered | Sends an HTTPS audio URL for cover preprocessing. |

Every generation or content-submission tool requires `confirm_usage: true`. This is intentionally
not inferred: calls can consume Token Plan quota, Credits, balance, or submit user media to MiniMax.

## Example prompts

```text
先检查我的 MiniMax 权益配置，再生成一张 16:9 的赛博朋克海报。
```

```text
使用 Token Plan 的 speech-2.8-hd，把这段中文转成普通话旁白；调用前先告诉我会消耗额度。
```

```text
我已经配置 pay-as-you-go key。创建一个 5 秒、16:9 的 MiniMax H3 视频任务，然后查询状态。
```

### Expected result

MiniMax Code first reports which Token Plan/paygo key classes are configured and the documented
coverage boundary. It asks for confirmation before consuming quota or balance, calls the matching
tool, and returns structured JSON with output URLs, task IDs, trace IDs, and any lifecycle warning.
It never silently moves an unsupported Token Plan request to a pay-as-you-go key. Video creation
returns once with a task ID; a later query returns the task status and output URL.

## Safety and billing

- Run `minimax_get_capabilities` before choosing a paid tool.
- Never treat an API error as proof that an entitlement does not exist; preserve the HTTP status,
  MiniMax status code, trace ID, and suggested next step.
- Generated URL results may expire. Download them promptly using a trusted client if persistence is
  required.
- The server accepts only the official Global/Mainland HTTPS API hosts in production.
- Local file paths are not accepted for vision/reference media. Single-image tools accept HTTPS or
  inline JPEG/PNG/WebP data URLs below 900,000 characters. Video reference collections require HTTPS;
  optional first/last-frame data images are capped at 430,000 characters each so every schema-valid
  request remains below the 1,000,000-character stdio frame limit.

## Official references

- [Token Plan overview](https://platform.minimax.io/docs/token-plan/intro)
- [Token Plan pricing and coverage](https://platform.minimax.io/docs/guides/pricing-token-plan)
- [Token Plan MCP](https://platform.minimax.io/docs/token-plan/mcp-guide)
- [MiniMax multimodal MCP guide](https://platform.minimax.io/docs/guides/mcp-guide)
- [Image generation](https://platform.minimax.io/docs/guides/image-generation)
- [Video generation](https://platform.minimax.io/docs/guides/video-generation)
- [Music and lyrics](https://platform.minimax.io/docs/guides/music-generation)

## Requirements

- Node.js 22 or later
- A MiniMax Global or Mainland account
- Token Plan Subscription Key for included Token Plan resources
- Optional pay-as-you-go key or eligible legacy music account for non-Token-Plan tools
- Windows, macOS, or Linux with a MiniMax Code installation that supports local stdio MCP servers

## Network and data behavior

- Destinations: `https://api.minimax.io` (Global) or `https://api.minimaxi.com` (Mainland), selected
  by `MINIMAX_API_HOST`. Production mode rejects every other host.
- Submitted data: prompts, search queries, text for speech, bounded single-image data URLs,
  HTTPS image/video/audio references, and generation settings are sent only when the corresponding tool
  is called.
- Returned data: structured API metadata and expiring output URLs. Unexpected large binary strings
  are truncated before entering MCP context; responses above 5 MiB are rejected.
- Local data: no credentials, prompts, media, or outputs are persisted. Arbitrary local media paths
  are rejected.
- Telemetry: none. The plugin does not contact its author or any non-MiniMax service.

## Validation evidence

```text
npm run check
```

The repository check runs all plugin tests plus manifest, schema, output-schema, and secret scans. The
local MiniMax fixture verifies key routing, explicit usage confirmation, schema/transport media bounds,
HTTPS-only reference collections, response-key redaction and truncation, bounded responses, quota errors,
video task separation, music lifecycle warnings, and the complete stdio initialize/list/call handshake
without consuming real MiniMax resources.
