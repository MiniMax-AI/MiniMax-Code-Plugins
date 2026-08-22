# ComfyUI Studio

A generic, dependency-free toolkit for driving a local ComfyUI server. Submit workflows, poll
the queue, download generated images, and build consistent characters with a self-trained
LoRA. Bundles three Skills and a stdio MCP server; ships zero native binaries, zero installers,
and zero third-party dependencies.

## The problem

Driving a local ComfyUI server from an agent requires either:

- Hand-rolling HTTP calls every time (`/prompt`, `/history`, `/view`...) and rewriting the
  same boilerplate per workflow.
- Adopting a heavyweight MCP server that pulls in 50+ MB of native dependencies (the
  `sharp` image library) and runs an install hook on first use — a non-starter for shared
  environments.

This Plugin does the first without paying the second cost. The same three primitives are
exposed through both a tiny Python CLI and a ~200-line stdio MCP server, so the user picks
whichever entry point fits their host agent.

## Try it

After installing the Plugin into MiniMax Code:

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit the bundled
text-to-image workflow with the prompt "a tabby cat sleeping on a windowsill, morning
light, photorealistic" and report the saved image path.
```

Expected result: the agent calls `submit_prompt` (or `submit_workflow.py`), polls the queue
until the run finishes, downloads the image, and tells the user where it was saved. The end-to-end
walkthrough is in [`examples/minimal-run.md`](examples/minimal-run.md).

## What you get

```
comfyui-studio/
├── plugin.json            # Plugin manifest (required)
├── mcp.json               # Registers the stdio MCP server
├── server.mjs             # 200-line zero-dep stdio JSON-RPC server
├── LICENSE                # Apache-2.0
├── README.md              # This file
├── skills/
│   ├── comfyui-studio/    # Routing layer: which sibling Skill applies
│   ├── comfyui-workflow/  # Submit / poll / download
│   │   ├── SKILL.md
│   │   ├── references/api-reference.md
│   │   └── scripts/submit_workflow.py
│   └── comfyui-character/ # Consistent characters with a self-trained LoRA
│       ├── SKILL.md
│       └── references/
│           ├── prompt-patterns.md
│           └── lora-guide.md
├── workflows/
│   ├── text-to-image.json
│   └── image-to-image.json
├── examples/
│   ├── README.md
│   └── minimal-run.md     # 5-minute end-to-end walkthrough
└── docs/
    ├── security-notes.md
    └── troubleshooting.md
```

## Three Skills, one shared transport

- **`comfyui-studio`** — entry point. Reads the user's intent and routes to the right sibling.
- **`comfyui-workflow`** — submits workflow JSON, polls the queue, downloads outputs.
- **`comfyui-character`** — produces a consistent character across many generations, using a
  LoRA the user trained themselves and placed in ComfyUI's `models/loras/`.

Read [`skills/comfyui-studio/SKILL.md`](skills/comfyui-studio/SKILL.md) for the routing
table. Each sibling's `SKILL.md` is the actual implementation guide.

## MCP server (optional)

`mcp.json` registers a stdio MCP server. The server speaks JSON-RPC directly, with zero npm
dependencies; the only requirement is Node.js 18+ on the host's `PATH`. The three tools it
exposes mirror the Python CLI:

| Tool | Purpose |
|---|---|
| `submit_prompt` | Submit a workflow JSON; returns a `prompt_id` |
| `check_queue`   | Report running and pending counts and IDs |
| `get_image`     | Download a generated image by filename |

If the host agent is not MCP-aware, the Python script gives you the same primitives without
needing Node or any MCP plumbing.

## Requirements

- A running ComfyUI server reachable at `COMFYUI_URL` (default `http://127.0.0.1:8188`).
- At least one checkpoint model in ComfyUI's `models/checkpoints/`.
- For `comfyui-character`: a LoRA you trained, dropped into `models/loras/`.
- Python 3.10+ if you use the script. Node 18+ if you use the MCP server.
- No accounts. No paid services. No telemetry. No native binaries. No installers.

## Data and network

- The Plugin only talks to `COMFYUI_URL`. It makes no other network calls.
- The Plugin reads workflow JSON files the user names and writes outputs to the user-chosen
  `--output-dir`. It does not read or upload model files, LoRAs, voice samples, or any other
  identity asset.
- The Plugin does not log, persist, or transmit any user data.
- See [`docs/security-notes.md`](docs/security-notes.md) for the full threat model.

## What the Plugin does not do

- It does not train LoRAs. Training is its own project; this Plugin only consumes a LoRA
  the user already has.
- It does not bundle or distribute any LoRA, model, face embedding, voice sample, or any
  other identity asset. Every character is user-supplied.
- It does not install packages, run post-install hooks, or download native binaries.
- It does not call any cloud service or third-party API.

## License

Apache-2.0. See [LICENSE](LICENSE).
