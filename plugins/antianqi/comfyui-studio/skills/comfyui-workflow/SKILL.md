---
name: comfyui-workflow
description: Submit a ComfyUI workflow JSON to a local 8188 server, monitor the queue, and download generated images. Use this Skill when the user wants to run a saved workflow, check whether ComfyUI is busy, fetch a generated image, list available checkpoints, or automate a reproducible generation pipeline.
---

# ComfyUI Workflow

Submit workflows, monitor the queue, and retrieve outputs from a local ComfyUI server. This is
the workhorse Skill; `comfyui-character` builds on top of it for character-consistent generation.

## Scope

This Skill covers the **transport** between an agent and a local ComfyUI server. It does not
edit workflows, train models, or invent prompts — those concerns live in sibling Skills. It
assumes the user already has a workflow JSON they want to run (either a file the user wrote or
one of the bundled `workflows/*.json` examples).

## Two equivalent entry points

You can drive ComfyUI from this Skill in either of two ways. Pick whichever the host environment
supports best.

### A. Python script (CLI-friendly, no MCP required)

```bash
# Health probe
python scripts/submit_workflow.py --probe

# Submit a workflow
python scripts/submit_workflow.py \
  --workflow ./workflows/text-to-image.json \
  --prompt "a tabby cat sleeping on a windowsill, morning light, photorealistic" \
  --output-dir ./out

# Check the queue without submitting
python scripts/submit_workflow.py --queue

# Download a specific image
python scripts/submit_workflow.py --download \
  --filename ComfyUI_00001_.png --output-dir ./out
```

The script lives at `skills/comfyui-workflow/scripts/submit_workflow.py` (relative to the Plugin
root) and accepts `COMFYUI_URL` from the environment, falling back to `http://127.0.0.1:8188`.
Full flag list in `references/api-reference.md`.

### B. stdio MCP server (no Python required)

When the host agent is MCP-aware, the Plugin's `server.mjs` exposes three tools that mirror the
Python script:

| Tool | Mirrors |
|---|---|
| `submit_prompt` | `--workflow` invocation |
| `check_queue`   | `--queue` invocation |
| `get_image`     | `--download` invocation |

The MCP server has zero npm dependencies. It is a 200-line stdio JSON-RPC server in plain Node.
See `mcp.json` for the registration snippet and `server.mjs` for the source.

## Workflow contract

ComfyUI accepts a JSON object whose top-level keys are node IDs and whose values are
`{class_type, inputs}` records. When the user provides a workflow, **do not edit the structure**
unless they ask. Two patterns are common:

- A workflow file saved from the ComfyUI web UI: keys are numeric strings, `class_type` matches
  the node name in the editor, `inputs` reference other nodes by `[nodeId, outputIndex]`.
- An "API format" workflow produced by ComfyUI's "Save (API Format)" menu: same shape, but with
  widget values inlined into `inputs`.

Both work identically when POSTed to `/prompt`. The Plugin's `workflows/text-to-image.json` and
`workflows/image-to-image.json` are in the API format.

## Overriding prompt values at submit time

The bundled Python script understands a tiny templating convention so you do not have to rewrite
the workflow JSON for every run. In a workflow, a `CLIPTextEncode` node with `inputs.text`
starting with the literal string `__PROMPT__` will have that text replaced with the value of
`--prompt` on the command line before submission. This is a no-op for nodes that do not opt in.

```json
{
  "30": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "__PROMPT__", "clip": ["4", 0] }
  }
}
```

For workflows without that marker, the user must edit the workflow JSON directly.

## Step-by-step recipe

1. **Health probe.** Either call `check_queue` via MCP or run `submit_workflow.py --probe`. Stop
   and report if ComfyUI is unreachable; do not invent a successful run.
2. **Resolve the workflow.** If the user named a file, read it. If they named a workflow by
   description (e.g. "the one with the upscale at the end"), ask for a path or a saved name.
3. **Apply prompt override if used.** If `--prompt` is provided and the workflow contains
   `__PROMPT__`, substitute. Otherwise pass the workflow through unchanged.
4. **Submit.** POST to `/prompt` with `{"prompt": <workflow>}`. Capture `prompt_id`.
5. **Poll.** Loop `GET /history/<prompt_id>` with a 2-second sleep. Stop on terminal status
   (`success`, `error`, or `cancelled`). Use a 15-minute cap; long jobs should be split.
6. **Resolve outputs.** The `outputs` object lists the `SaveImage` / `VHS_VideoCombine` files
   produced. For each, fetch `GET /view?filename=...&subfolder=...&type=output`.
7. **Report.** Tell the user the prompt_id, the time taken, the saved file paths, and any
   warnings (low VRAM, retries, partial outputs).

## Long jobs and VRAM safety

- ComfyUI 22B-class models can hold the GPU for hours. The Plugin does not implement a watchdog;
  for jobs longer than 30 minutes, instruct the user to watch `nvidia-smi` themselves.
- If a poll returns an error status, capture the full `outputs` block and the error message;
  report both. Do not retry automatically — generation is expensive.

## Requirements

- ComfyUI running locally (or reachable at `COMFYUI_URL`).
- Python 3.10+ if using the script. The MCP server requires Node 18+.
- No additional accounts, paid services, or network destinations.

## License

Apache-2.0. See [LICENSE](../../LICENSE).
