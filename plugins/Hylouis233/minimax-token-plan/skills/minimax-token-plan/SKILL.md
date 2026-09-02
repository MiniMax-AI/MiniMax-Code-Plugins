---
name: minimax-token-plan
description: Use MiniMax Token Plan and optional pay-as-you-go multimodal tools for web search, image understanding and generation, speech, video, lyrics, music, and music covers while preserving entitlement and cost boundaries.
---

# MiniMax Token Plan workflows

Use this skill when the user asks to use MiniMax Token Plan, MiniMax image or speech generation,
Hailuo/H3 video, MiniMax Music, lyrics generation, or the MiniMax multimodal API.

## Mandatory routing

1. Call `minimax_get_capabilities` before the first external MiniMax call in a task.
2. Explain which configured key class and quota/balance route the requested tool will use.
3. Obtain explicit user confirmation before setting `confirm_usage: true`.
4. Use Token Plan tools for search, image understanding, eligible image generation, and eligible
   speech. H3 video and voice design/cloning require another billing route. Music/lyrics may use a
   Token Plan key only for an existing eligible account; never claim new-user availability.
5. For video, create a task and return its task ID. Query status separately; do not busy-poll.
6. Treat music and lyrics as grandfathered capabilities. Since 2026-08-20, new users cannot obtain
   paid API access. If the API rejects access, report the boundary and suggest MiniMax Audio or the
   open-source MiniMax Music 3 model rather than retrying.

## Media rules

- Vision and single subject-reference inputs accept HTTPS URLs or bounded
  `data:image/jpeg|png|webp;base64,...` values; never pass arbitrary local paths.
- Video reference-image, video, and audio collections require HTTPS URLs. First/last-frame inline data
  images are deliberately smaller so the complete JSON-RPC request stays within the stdio safety limit.
- Prefer URL output to keep large binary payloads out of MCP context.
- Generated URLs can expire; tell the user to persist desired outputs promptly.
- Never echo API keys, authorization headers, or full data-URI media.
- Do not describe a successful request as free. Token Plan calls consume quota; paygo calls may
  consume Credits or account balance.

## Failure handling

- Authentication errors: verify that key region matches `MINIMAX_API_HOST`.
- Status `2056` or usage-limit messages: report the quota/model mismatch and suggest an eligible
  model or waiting for reset; do not silently swap key classes.
- HTTP 429: preserve the trace ID and ask the user to retry later.
- Music/lyrics access rejection: report the 2026-08-20 new-user cutoff.
- Never retry generation automatically after an uncertain response because the original request may
  already have consumed quota or created a task.
