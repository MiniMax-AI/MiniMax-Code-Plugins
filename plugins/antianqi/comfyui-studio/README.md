# ComfyUI Studio

A generic, dependency-free toolkit for driving a local ComfyUI server. **Two parts in one
Plugin**: (1) the basic control layer for submitting workflows, polling the queue, and
downloading outputs, and (2) three preset workflow templates that solve common recurring
tasks (consistent-character selfie, reference-image mimicry, and short-drama pipeline).
Bundles four Skills and a stdio MCP server; ships zero native binaries, zero installers, and
zero third-party dependencies.

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

For users who have already trained a character LoRA and want to ship a recurring series of
selfies, the Plugin also ships two preset workflows (`selfie-text-to-image.json`,
`selfie-mimicry.json`) that wire a LoRA, a face ControlNet, and a portrait-oriented latent
into one submission — no boilerplate, no edits to the workflow.

For users who want to produce a multi-shot short drama with two consistent characters, the
Plugin ships the first-frame and image-to-video workflow presets plus a documented 7-stage
pipeline. The user provides the LoRAs, the video checkpoint, and the TTS pipeline; the
Plugin provides the templates.

## Try it

After installing the Plugin into MiniMax Code:

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit the bundled
text-to-image workflow with the prompt "a tabby cat sleeping on a windowsill, morning
light, photorealistic" and report the saved image path.
```

Expected result: the agent calls `submit_prompt` (or `submit_workflow.py`), polls the queue
until the run finishes, downloads the image, and tells the user where it was saved. The
end-to-end walkthrough is in [`examples/minimal-run.md`](examples/minimal-run.md).

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
│   ├── comfyui-workflow/  # Submit / poll / download (the basic transport)
│   │   ├── SKILL.md
│   │   ├── references/api-reference.md
│   │   └── scripts/submit_workflow.py
│   ├── comfyui-character/ # Consistent character generation (selfie + mimicry presets)
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── prompt-patterns.md
│   │       └── lora-guide.md
│   └── comfyui-drama/     # 7-stage short drama pipeline (first-frame + image-to-video presets)
│       └── SKILL.md
├── workflows/             # Six preset workflow JSONs (generic, no private content)
│   ├── text-to-image.json
│   ├── image-to-image.json
│   ├── selfie-text-to-image.json     # preset: portrait + face LoRA + ControlNet
│   ├── selfie-mimicry.json           # preset: IP-Adapter + face LoRA
│   ├── drama-first-frame.json        # preset: two LoRA slots for a two-character drama
│   └── drama-image-to-video.json     # preset: distilled LTX-class video model
├── examples/
│   ├── README.md
│   └── minimal-run.md     # 5-minute end-to-end walkthrough
└── docs/
    ├── security-notes.md
    └── troubleshooting.md
```

## Four Skills, two transport layers

- **`comfyui-studio`** — entry point. Reads the user's intent and routes to the right sibling.
- **`comfyui-workflow`** — submits workflow JSON, polls the queue, downloads outputs. This is
  the basic transport that every other Skill uses.
- **`comfyui-character`** — produces a consistent character across many generations, using a
  LoRA the user trained themselves. Ships two preset workflows: `selfie-text-to-image.json`
  for prompt-driven portrait generation, and `selfie-mimicry.json` for reference-image
  mimicry via IP-Adapter.
- **`comfyui-drama`** — 7-stage short-drama pipeline: storyboard → TTS → script refinement →
  first-frame image (`drama-first-frame.json`) → image-to-video clip
  (`drama-image-to-video.json`) → subtitle burn → audio/video assembly.

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
- For `comfyui-character`: a LoRA you trained, dropped into `models/loras/`. Optionally a
  face ControlNet (for `selfie-text-to-image.json`) and an IP-Adapter model (for
  `selfie-mimicry.json`).
- For `comfyui-drama`: two character LoRAs (for two-character dramas), a distilled LTX-2.3
  class video checkpoint, a TTS pipeline of the user's choice, and FFmpeg for the
  assembly stages.
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
- It does not run TTS, edit spreadsheets, burn subtitles, or assemble audio/video. The
  `comfyui-drama` Skill documents the full 7-stage pipeline but only ships ComfyUI
  workflow templates for the two image-side stages; the other stages are user pipeline
  steps that the Plugin deliberately does not assume.

## License

Apache-2.0. See [LICENSE](LICENSE).
