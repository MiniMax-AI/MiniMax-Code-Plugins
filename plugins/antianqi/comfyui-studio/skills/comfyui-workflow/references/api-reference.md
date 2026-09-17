# ComfyUI 8188 API reference

A focused subset of the ComfyUI HTTP API that this Plugin uses. The full API surface is
documented at the ComfyUI project; this file covers only the endpoints the Plugin calls.

All endpoints are relative to the base URL in `COMFYUI_URL` (default `http://127.0.0.1:8188`).
All responses are JSON unless noted. All `POST` bodies are JSON.

## `GET /system_stats`

Reports ComfyUI version and runtime info. Used by the health probe.

Response shape (subset):

```json
{
  "system": { "comfyui_version": "0.29.2", "python_version": "3.11.x", "pytorch_version": "..." },
  "devices": [{ "name": "cuda:0", "type": "cuda", "vram_total": 8589934592, "vram_free": 6000000000 }]
}
```

## `GET /queue`

Returns the current queue.

Response shape:

```json
{
  "queue_running":  [["uuid", "prompt_id", {...workflow...}], ...],
  "queue_pending":  [["uuid", "prompt_id", {...workflow...}], ...]
}
```

The Plugin reports counts and prompt_ids; the full workflow body is not echoed back to the
agent to avoid blowing up the context window.

## `POST /prompt`

Submits a workflow. Body:

```json
{ "prompt": { "<nodeId>": { "class_type": "...", "inputs": {...} } } }
```

Response (success):

```json
{ "prompt_id": "uuid", "number": 42 }
```

Response (workflow-level error):

```json
{ "error": { "type": "validation", "message": "...", "details": "...", "node_id": "..." } }
```

The Plugin surfaces the full error block to the agent instead of swallowing it. Generation is
expensive; we want the user to see exactly what went wrong.

## `GET /history/<prompt_id>`

Polls the result of a submitted prompt. Returns the full `outputs` block once status is
terminal.

Response shape (subset):

```json
{
  "<prompt_id>": {
    "status": { "status_str": "success" | "error" | "cancelled" },
    "outputs": {
      "<nodeId>": {
        "images":  [{ "filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output" }],
        "gifs":    [...],
        "videos":  [...]
      }
    }
  }
}
```

The Plugin polls this every 2 seconds with a 15-minute cap. For long jobs, increase the cap or
have the user re-run with explicit acknowledgement.

## `GET /view`

Downloads a generated image. Query parameters:

| Parameter | Required | Notes |
|---|---|---|
| `filename`  | yes | The filename reported in `/history` outputs |
| `subfolder` | no  | Defaults to empty (root of the chosen folder) |
| `type`      | no  | One of `output`, `input`, `temp`. Default: `output` |
| `channel`   | no  | Used for 3D / multi-channel outputs |

Response: the image bytes, `Content-Type: image/png` (or whatever the original was).

## `POST /queue/clear`

Clears pending queue items. Does not interrupt running items. Use with care — there is no
"are you sure" prompt at the API level.

## `POST /queue/interrupt`

Interrupts the currently-running prompt. Use when the user says "stop" or when a poll detects
the queue is stuck.

## `GET /object_info/<NodeClassName>`

Returns the input schema for a specific node. Useful when the agent needs to know which
checkpoint or LoRA names ComfyUI currently sees on disk. The Plugin does not call this
directly; it is here so the user (or an agent) can probe a workflow before submission.

## Authentication

Plain ComfyUI has no authentication. If the user runs ComfyUI behind a reverse proxy that
requires a bearer token, set `COMFYUI_API_TOKEN` in the environment; the Plugin's MCP server
and the Python script both add it as `Authorization: Bearer <token>` on every request.

## Limits

The Plugin enforces a 15-minute default poll cap. ComfyUI itself has no hard timeout, but
long-running jobs are a known risk for GPU memory; see `docs/troubleshooting.md` for VRAM
recovery steps.

## License

Apache-2.0. See [LICENSE](../../../LICENSE).
