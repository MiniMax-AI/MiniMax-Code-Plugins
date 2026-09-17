# Minimal end-to-end run

This walkthrough takes a fresh ComfyUI install and runs the bundled `text-to-image.json` workflow
in under 5 minutes. It exercises every layer of the Plugin: the MCP server, the Python script,
both skills, and the health-probe / submit / poll / download flow.

## What you need

- A running ComfyUI server on `http://127.0.0.1:8188` (or another address — set `COMFYUI_URL`).
- At least one checkpoint model installed in ComfyUI's `models/checkpoints/` directory.
- For the character variant: a LoRA the user trained, dropped into `models/loras/`.

You do **not** need Node.js, npm, or any third-party Python package. The Plugin ships a
zero-dependency stdio MCP server and a zero-dependency Python script.

## Step 1 — verify ComfyUI is reachable

```bash
cd <plugin-root>
python skills/comfyui-workflow/scripts/submit_workflow.py --probe
```

Expected output:

```text
[probe] OK comfyui_version=0.29.2
[probe] device=cuda:0 vram_free=7.4GB/8.0GB
```

If the probe fails, see `docs/troubleshooting.md`. Do not continue.

## Step 2 — pick a checkpoint

Open the bundled workflow:

```
workflows/text-to-image.json
```

The `CheckpointLoaderSimple` node (node `3`) has `inputs.ckpt_name` set to `"any.safetensors"`.
Replace this with the actual filename of a checkpoint on your ComfyUI install. Use
`GET /object_info/CheckpointLoaderSimple` to list available names, or look in
`models/checkpoints/` yourself.

```bash
curl -s http://127.0.0.1:8188/object_info/CheckpointLoaderSimple | \
  python -c "import json,sys; d=json.load(sys.stdin); print(d['CheckpointLoaderSimple']['input']['required']['ckpt_name'][0])"
```

That prints a JSON array of every checkpoint ComfyUI can see. Pick one and edit
`workflows/text-to-image.json` to use its filename.

## Step 3 — submit a workflow

```bash
python skills/comfyui-workflow/scripts/submit_workflow.py \
  --workflow workflows/text-to-image.json \
  --prompt "a tabby cat sleeping on a windowsill, morning light, photorealistic" \
  --output-dir ./out
```

The `--prompt` argument is substituted into the `__PROMPT__` token inside the workflow's
`CLIPTextEncode` node. If you remove that marker from the workflow, edit the workflow's `text`
field directly instead.

Expected output:

```text
[prompt] substituted __PROMPT__ in nodes: ['30']
[submit] prompt_id=<uuid> number=42
[poll] status=success
[poll] saved:
  out/comfyui_studio_00001_.png
```

The script polls every 2 seconds with a 15-minute cap. Long-running jobs need a manual cap;
see `docs/troubleshooting.md` for VRAM recovery if something goes wrong mid-run.

## Step 4 — verify the output

```bash
ls -la out/
file out/comfyui_studio_00001_.png
```

You should see a real PNG, around 1-5 MB for a 1024×1024 generation. If the file is small or
zero bytes, the workflow likely had a downstream error; see Step 6 in the troubleshooting
guide.

## Step 5 — same flow via the MCP server

The Plugin's stdio MCP server exposes the same three primitives as the Python script. From any
MCP-capable agent:

```text
Use the comfyui-studio MCP server to:
  1. check_queue to confirm ComfyUI is empty
  2. submit_prompt with the bundled text-to-image workflow and the prompt "a tabby cat..."
  3. wait until /history/<prompt_id> returns success
  4. get_image on the returned filename
```

The agent should report the prompt_id, the saved file path, and the time taken. The
[server.mjs](../server.mjs) file is the source; it is plain Node 18+ stdlib, no `package.json`
needed to run it.

## What to try next

- **Tweak the prompt.** Change the `--prompt` argument and re-run. The seed in the workflow
  is fixed at `42`, so identical prompts produce identical images.
- **Switch the LoRA.** Edit `workflows/text-to-image.json` and set `inputs.lora_name` on node
  `10` to a LoRA you placed in `models/loras/`. Read
  [`skills/comfyui-character/references/prompt-patterns.md`](../skills/comfyui-character/references/prompt-patterns.md)
  for the 4-module prompt structure that makes LoRAs work.
- **Use the image-to-image workflow.** `workflows/image-to-image.json` accepts an input image
  through ComfyUI's `/upload/image` endpoint. Set the `image` field on node `20` after upload.
- **Bring your own workflow.** Drop a `.json` file into `workflows/` and pass its path via
  `--workflow`. The Plugin only assumes the `__PROMPT__` convention for prompt override;
  everything else passes through unchanged.

## License

Apache-2.0. See [LICENSE](../LICENSE).
