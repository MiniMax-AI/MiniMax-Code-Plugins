# agnes-media

Generate images and videos through the **Agnes AI API**: text-to-image,
image-to-image, multi-image composition, text-to-video, image-to-video and
keyframe animation — one stdlib-only Python script handles request building,
async task polling and result download; the agent only writes the prompt.

## The problem

Calling a production media-generation API from an agent means juggling
request payloads, async task queues, polling and file download — error-prone
and slow to repeat. agnes-media wraps both Agnes AI production models
(`agnes-image-2.1-flash` sync images, `agnes-video-v2.0` async videos) behind
a single script: `image` for seconds-fast images, `video` for minute-scale
videos with automatic frame-count math and built-in polling.

## Try it

Install from `/plugins` → **Local**, then ask:

```text
generate an image of a glowing floating city above a canyon at sunrise, cinematic, wide angle
```

**Expected result**: the generated image saved to the output directory
(default `~/Downloads`), with the script printing `ok=true` and the file
paths.

Direct usage:

```text
python <skill_dir>/scripts/agnes.py image --prompt "..." --size 2K --ratio 16:9
python <skill_dir>/scripts/agnes.py video --prompt "..." --duration 5
python <skill_dir>/scripts/agnes.py image --image a.png b.png --prompt "compose these"
```

## Requirements

- **An Agnes AI API key** (paid service) — provided via `--api-key`, the
  `AGNES_API_KEY` environment variable, or an `.env` file.
- Python 3.8+ (stdlib-only script).

## Data and network

- The script talks only to the Agnes AI API (`apihub.agnes-ai.com`).
- The API key is read from the user's own environment/config; it is never
  stored in this plugin's directory.
- Local input images are sent to the API as data URIs for image-to-image /
  video tasks.
- No telemetry, no other third-party services.

## License

MIT
