# Troubleshooting

Common failures when using the Plugin and how to recover from them.

## Health probe fails

```text
[probe] FAILED status=0 body=connection error: [Errno 111] Connection refused
```

- ComfyUI is not running, or is running on a different port. Start ComfyUI and confirm with
  `curl http://127.0.0.1:8188/system_stats`.
- You set `COMFYUI_URL` to a different address. Confirm with `echo $COMFYUI_URL` (or
  `echo $env:COMFYUI_URL` in PowerShell) and unset it if you do not need to override.

## Workflow rejected with `node not found`

```text
[submit] workflow rejected: {"type":"validation", "node_id": "10", "message": "..."}
```

The workflow references a node or class ComfyUI does not have. Two common causes:

- The bundled workflow assumes a custom node you have not installed (e.g. `LoraLoader` from a
  custom-node pack). Install the missing pack or remove the offending node from the workflow.
- The workflow was saved by a newer ComfyUI version and references a node that has been
  renamed or removed. Re-save the workflow from your installed version.

## Workflow accepted, but no output appears

```text
[poll] success but no output files reported (workflow may not have a Save node)
```

The workflow does not have a `SaveImage`, `VHS_VideoCombine`, or other terminal node. Add one
or pick a workflow that ends in a save.

## VRAM exhausted mid-run

The Plugin does not have a VRAM watchdog; the user must watch `nvidia-smi` themselves for
long jobs (over 30 minutes). If the GPU reports `CUDA out of memory`:

1. Stop the current run: `POST /queue/interrupt`.
2. Clear the queue: `POST /queue/clear`.
3. Reduce the resolution in the workflow (e.g. `EmptyLatentImage` width/height).
4. Reduce the model precision if the workflow supports it.
5. Restart ComfyUI to free leaked allocations.

The Plugin never re-submits a failed run on its own — generation is expensive and the user
should be in the loop.

## Poll times out after 15 minutes

The Plugin's Python script and the documented recipe both cap polling at 15 minutes. For jobs
that take longer:

- Use a smaller model or lower resolution so the job fits inside the cap.
- Or modify the script's `POLL_TIMEOUT_S` to your desired value. The Plugin does not change
  this default; do not raise it silently.
- Or split the work into multiple submissions and run them serially.

## The MCP server starts but the agent cannot see tools

The Plugin's `mcp.json` registers the server under the name `comfyui-studio`. If the host
agent does not see the three tools (`submit_prompt`, `check_queue`, `get_image`):

- Confirm the host agent supports the MCP stdio transport.
- Confirm Node.js 18+ is on the host's PATH.
- Run the server manually to see its startup banner: `node server.mjs`. It should print
  `[comfyui-studio] ready; talking to http://127.0.0.1:8188` and stay running.

## LoRA does nothing at inference

See [`skills/comfyui-character/references/prompt-patterns.md`](../skills/comfyui-character/references/prompt-patterns.md).
The most common causes, in order of frequency:

1. The trigger word is not the first token in the prompt.
2. `strength_model` is set too low (try 0.85 → 1.0).
3. The base model was changed after training.
4. The negative prompt is fighting the LoRA.

## Identity drifts across generations

Same reference as above; the prompt-patterns file walks through the fix-it-once checklist.

## License

Apache-2.0. See [LICENSE](../LICENSE).
