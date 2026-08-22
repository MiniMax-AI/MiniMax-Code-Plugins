# ComfyUI Studio

> 🧪 **Beta test build** — `v0.2.0-beta.1`. The official PR
> ([MiniMax-AI/MiniMax-Code-Plugins#15](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/15))
> is open and waiting for review. **To participate in the beta**: install from the
> [`antianqi/MiniMax-Code-Plugins-1`](https://github.com/antianqi/MiniMax-Code-Plugins-1) fork
> following the instructions in [`BETA.md`](BETA.md), then report issues back so we can fix
> them before the official merge. See the bottom of this README for the mcode internal beta
> group context.

A generic, dependency-free toolkit for driving a local ComfyUI server. **Two parts in one Plugin**:
**A. a natural-language control layer** for submitting any ComfyUI workflow, polling the queue, and
downloading outputs, and **B. six preset workflow templates** that cover the most common recurring
tasks (selfie, mimicry, image edit, image fusion, drama first frame, drama image-to-video).
Bundles four Skills and a stdio MCP server. Ships zero native binaries, zero installers, zero
third-party dependencies. Apache-2.0.

---

## The two parts

| Part | What it does | Where to look |
|---|---|---|
| **A. Natural-language control** | The transport between an agent and a local ComfyUI server. Submit any workflow JSON, poll the queue, download outputs. The same three primitives are exposed through a Python CLI and a 0-dep stdio MCP server. | `comfyui-workflow` Skill + `server.mjs` + `scripts/submit_workflow.py` |
| **B. 6 preset workflows** | Six opinionated workflow JSONs for the most common ComfyUI tasks. Each is wired with prompt / image / LoRA markers so the agent can submit them with one call. | `comfyui-character` Skill (scenarios 1–4) + `comfyui-drama` Skill (scenarios 5–6) + the `workflows/*.json` files |

Part A is the workhorse. Part B is six production-ready starting points built on top of Part A.

---

## Part B — the 6 preset scenarios

Numbered by how a user typically says it. The number is the **trigger scenario**, not a model id —
the agent reads the user's intent and picks the matching number.

| # | Trigger | What the user typically says | Preset workflow | One-line description |
|---|---|---|---|---|
| **1** | **生图** (generate an image) | "用我的角色画一张自拍" / "生成一张赛博朋克风格的照片" | `workflows/selfie-text-to-image.json` | Text + 2 LoRAs (face + style) → one character image |
| **2** | **模仿** (mimic an image) | "照着这张照片再画一张同款" / "模仿这张图的姿势和光线" | `workflows/selfie-mimicry.json` | Reference image + ControlNet + vision LLM reprompt + 2 LoRAs → one character image in the same pose/lighting |
| **3** | **改图** (edit an image) | "把背景换成办公室" / "衣服换成西装,光线调亮" | `workflows/flux2-klein-image-edit.json` | 1 reference image + prompt → edited image |
| **4** | **融合** (fuse two images) | "把这张图里的人物放到那张图里" / "让她穿上这件衣服,背景换成海边" | `workflows/flux2-klein-image-edit-dual.json` | 2 reference images + prompt → fused image ("the person from image 1 in the scene of image 2") |
| **5** | **首帧** (drama first frame) | "生成这部短剧第 3 镜的首帧画面" | `workflows/drama-first-frame.json` | 2-character LoRA slots + prompt → one 16:9 first-frame image |
| **6** | **出片** (image to video) | "把这个首帧做成 4 秒视频" | `workflows/drama-image-to-video.json` | 1 first-frame image + motion prompt → one MP4 clip |

> **Routing rule of thumb**: scenarios 1–4 → `comfyui-character`; scenarios 5–6 → `comfyui-drama`;
> anything else ("use ComfyUI to ...", "submit this workflow", "check the queue") → `comfyui-workflow`
> (Part A).

The detailed recipes (model stack, custom-node requirements, prompt structure, knobs) live in each
Skill's `SKILL.md`. The table here is the index.

---

## Part A — natural-language control

No matter what the user wants, the last three steps are always the same:

1. **Submit a workflow** → `POST /prompt`, capture `prompt_id`
2. **Poll the queue** → `GET /history/<prompt_id>` until terminal status
3. **Download outputs** → `GET /view?filename=...&subfolder=...&type=output`

Two equivalent entry points. Pick whichever the host agent supports.

### A1. Python CLI (no MCP required)

```bash
# Health probe
python skills/comfyui-workflow/scripts/submit_workflow.py --probe

# Submit any workflow (one of the bundled presets or the user's own)
python skills/comfyui-workflow/scripts/submit_workflow.py \
  --workflow plugins/antianqi/comfyui-studio/workflows/flux2-klein-image-edit.json \
  --prompt "the same person sitting in an office chair, professional lighting" \
  --filename reference_face.png \
  --output-dir ./out
```

The script understands three marker conventions so you don't have to rewrite the workflow JSON
for every run:

| Marker | Replaced with |
|---|---|
| `__PROMPT__` (in any `CLIPTextEncode.text` or `CR Text.text` field) | the value of `--prompt` |
| `__TRIGGER__` (in any `CR Text.text` field) | the value of `--trigger` (LoRA trigger word) |
| `__IMAGE1__` / `__IMAGE2__` (in any `LoadImage.image` field) | the value of `--filename` / `--filename2` |

### A2. stdio MCP server (no Python required)

`mcp.json` registers a 200-line stdio JSON-RPC server in plain Node stdlib. Zero npm dependencies.
The three tools mirror the Python script:

| MCP tool | Mirrors CLI flag | What it does |
|---|---|---|
| `submit_prompt` | `--workflow` + `--prompt` | Submit a workflow JSON; return `prompt_id` |
| `check_queue`   | `--queue` | Report running and pending counts and IDs |
| `get_image`     | `--download` | Download a generated image by filename |

If the host agent is MCP-aware, prefer this. If not, use the Python CLI — they are behaviourally
identical.

---

## Model boundary (read this first)

The Plugin draws a clean line between **public generation models** and **user-supplied LoRAs**.

| Asset type | What you see in the workflow JSON | Why |
|---|---|---|
| **Public generation models** (checkpoints, VAE, CLIP, ControlNet, video models, vision LLMs) | **The actual filenames on disk in the reference ComfyUI install that built this Plugin.** | The workflow runs out of the box on the reference install. Edit the loader field to point at your own file on a different install. |
| **LoRAs** | **Generic placeholder names**: `your_face_lora.safetensors`, `your_style_lora.safetensors`, `character_a_lora.safetensors`, `character_b_lora.safetensors`, `any_motion_lora.safetensors`. | LoRAs are user-trained identity assets. The Plugin does not bundle or name anyone's private LoRAs. The user edits the `LoraLoader*.lora_name` field to point at their own file. |
| **Image inputs** | `__IMAGE1__` / `__IMAGE2__` | The Python CLI / MCP server replaces these at submit time. |
| **Prompt / trigger text** | `__PROMPT__` / `__TRIGGER__` | The Python CLI / MCP server replaces these at submit time. |

The exact filenames / placeholders in the six bundled workflows:

| # | Workflow | Checkpoint | CLIP / VAE | ControlNet / Vision LLM | LoRA placeholders |
|---|---|---|---|---|---|
| 1 | `selfie-text-to-image.json`         | `Z-Image-Base-8steps-豹豹喵呜の白玉v2White_Marble-AIO_v2-bf16.safetensors` | bundled with CheckpointLoader | — | `your_face_lora.safetensors` + `your_style_lora.safetensors` |
| 2 | `selfie-mimicry.json`               | `ZIT-moodyPornMix_zitV10R1DPO_fp16.safetensors` | bundled with UNETLoader | `Z-Image-Fun-Controlnet-Union-2.1.safetensors` (ControlNet) + `Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf` (vision LLM) | same 2 LoRA placeholders |
| 3 | `flux2-klein-image-edit.json`       | `flux-2-klein-base-9b-fp8.safetensors` | `qwen_3_8b_fp8mixed.safetensors` + `diffusion_pytorch_model.safetensors` | — | (no LoRA) |
| 4 | `flux2-klein-image-edit-dual.json`  | `flux-2-klein-base-9b-fp8.safetensors` | same CLIP/VAE as #3 | — | (no LoRA) |
| 5 | `drama-first-frame.json`            | `Z-Image-Base-8steps-豹豹喵呜の白玉v2White_Marble-AIO_v2-bf16.safetensors` | bundled with CheckpointLoader | — | `character_a_lora.safetensors` + `character_b_lora.safetensors` |
| 6 | `drama-image-to-video.json`         | `10Eros_v1-fp8mixed_learned.safetensors` | `ltx-2.3_text_projection_bf16.safetensors` + `gemma_3_12B_it_fp8_scaled.safetensors` + `LTX23_video_vae_bf16.safetensors` | — | `any_motion_lora.safetensors` |

If your ComfyUI install uses a different filename for any of these — for example,
`sd_xl_base_1.0.safetensors` instead of `Z-Image-Base-8steps-豹豹喵呜の白玉v2White_Marble-AIO_v2-bf16.safetensors`,
or `ltx-2.3-distilled.safetensors` instead of `10Eros_v1-fp8mixed_learned.safetensors` — edit the
relevant `ckpt_name` / `clip_name1` / `clip_name2` / `vae_name` / `control_net_name` field in the
workflow JSON. ComfyUI will accept whatever file is on disk under the name you set.

---

## Try it

After installing the Plugin into MiniMax Code:

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit scenario 3
(改图 / flux2-klein-image-edit) with the prompt "the same person sitting in an office
chair, the same outfit, professional lighting" and report the saved image path.
```

Expected result: the agent probes ComfyUI, submits the bundled
`workflows/flux2-klein-image-edit.json`, polls until done, downloads the image, and tells you
where it was saved. The end-to-end walkthrough is in [`examples/minimal-run.md`](examples/minimal-run.md).

---

## What you get

```
comfyui-studio/
├── plugin.json                       # Plugin manifest (required)
├── mcp.json                          # Registers the stdio MCP server
├── server.mjs                        # 200-line zero-dep stdio JSON-RPC server
├── LICENSE                           # Apache-2.0
├── README.md                         # This file
├── skills/
│   ├── comfyui-studio/               # Routing layer: numbers 1-6 + freeform → sibling Skill
│   ├── comfyui-workflow/             # The basic transport (Part A)
│   │   ├── SKILL.md
│   │   ├── references/api-reference.md
│   │   └── scripts/submit_workflow.py
│   ├── comfyui-character/            # Scenarios 1, 2, 3, 4 (selfie + mimicry + Klein edits)
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── prompt-patterns.md
│   │       └── lora-guide.md
│   └── comfyui-drama/                # Scenarios 5, 6 (first-frame + image-to-video)
│       └── SKILL.md
├── workflows/                        # The 6 preset workflow JSONs
│   ├── selfie-text-to-image.json     # scenario 1: 生图
│   ├── selfie-mimicry.json           # scenario 2: 模仿
│   ├── flux2-klein-image-edit.json   # scenario 3: 改图
│   ├── flux2-klein-image-edit-dual.json  # scenario 4: 融合
│   ├── drama-first-frame.json        # scenario 5: 首帧
│   └── drama-image-to-video.json     # scenario 6: 出片
├── examples/
│   ├── README.md
│   └── minimal-run.md                # 5-minute end-to-end walkthrough
└── docs/
    ├── security-notes.md
    └── troubleshooting.md
```

---

## Four Skills, one routing table

The Plugin's `comfyui-studio` Skill is the entry point. It reads the user's intent and routes to
one of three siblings. Each sibling's `SKILL.md` is the actual implementation guide.

| Skill | Job | When |
|---|---|---|
| `comfyui-studio` | Routing: read the user's intent, pick the number 1–6 or fall through to freeform | Always start here when the user says "use ComfyUI to ..." |
| `comfyui-workflow` | The transport (Part A). Submit / poll / download any workflow JSON. | "Submit this workflow", "check the queue", "download the image" — or as a building block by the sibling Skills. |
| `comfyui-character` | Scenarios 1, 2, 3, 4. Character selfies (with LoRA) and Flux.2 Klein image edits. | "Make a selfie", "mimic this photo", "edit / fuse this image" |
| `comfyui-drama` | Scenarios 5, 6 + the 7-stage pipeline around them (storyboard → TTS → first frame → image-to-video → subtitle burn → assembly). | "Make a short drama", "generate the first frame", "turn this into a video clip" |

Read [`skills/comfyui-studio/SKILL.md`](skills/comfyui-studio/SKILL.md) for the full routing table.

---

## Requirements

- A running ComfyUI server reachable at `COMFYUI_URL` (default `http://127.0.0.1:8188`).
- The checkpoint / VAE / CLIP / ControlNet files referenced in each preset (see the model
  boundary table above). Edit any loader field that does not match your install.
- For scenarios 1 and 2 (`comfyui-character` selfie workflows): a face LoRA and a style LoRA
  in `models/loras/`. The Plugin does not bundle them; it uses placeholder names.
- For scenario 2 (`selfie-mimicry.json`): the custom-node pack list in
  `skills/comfyui-character/SKILL.md` (controlnet_aux, LLaMA-CPP, ModelPatchLoader, etc.).
- For scenarios 3 and 4 (`comfyui-character` Klein workflows): the Flux.2 Klein 9B UNET, the
  Qwen3 8B CLIP, and the bundled VAE.
- For scenarios 5 and 6 (`comfyui-drama`): two character LoRAs (for two-character dramas), an
  LTX-Video checkpoint with its DualCLIP text encoders and VAE, a TTS pipeline of the user's
  choice, and FFmpeg for the assembly stages.
- Python 3.10+ if you use the Python CLI. Node 18+ if you use the MCP server.
- No accounts. No paid services. No telemetry. No native binaries. No installers.

---

## Data and network

- The Plugin only talks to `COMFYUI_URL`. It makes no other network calls.
- The Plugin reads workflow JSON files the user names and writes outputs to the user-chosen
  `--output-dir`. It does not read or upload model files, LoRAs, voice samples, or any other
  identity asset.
- The Plugin does not log, persist, or transmit any user data.
- See [`docs/security-notes.md`](docs/security-notes.md) for the full threat model.

---

## What the Plugin does not do

- It does not train LoRAs. Training is its own project; this Plugin only consumes a LoRA the
  user already has.
- It does not bundle or distribute any LoRA, model, face embedding, voice sample, or any other
  identity asset. Every character and voice is user-supplied.
- It does not install packages, run post-install hooks, or download native binaries.
- It does not call any cloud service or third-party API.
- It does not run TTS, edit spreadsheets, burn subtitles, or assemble audio/video. The
  `comfyui-drama` Skill documents the full 7-stage pipeline but only ships ComfyUI workflow
  templates for the two image-side stages (scenarios 5 and 6); the other stages are user
  pipeline steps that the Plugin deliberately does not assume.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
