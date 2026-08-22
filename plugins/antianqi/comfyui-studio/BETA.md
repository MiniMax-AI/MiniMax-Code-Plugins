# 🧪 Beta Test Channel

> **Status**: This is the beta test distribution of `comfyui-studio`. The official
> PR ([MiniMax-AI/MiniMax-Code-Plugins#15](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/15))
> is open and waiting for review. While the merge is pending, the **standalone beta
> channel** lives at **[`antianqi/comfyui-studio`](https://github.com/antianqi/comfyui-studio)**
> (a single-plugin repo, not this monorepo fork). Please install from that repo, try the 6
> scenarios, and report issues back so we can fix them before the official release.
>
> This monorepo fork (`MiniMax-Code-Plugins-1`) is only kept alive so the upstream PR
> can be force-pushed. The install instructions below point at the standalone repo.

---

## TL;DR

```bash
# 1. Clone the standalone beta repo (or download the latest beta release tarball)
git clone https://github.com/antianqi/comfyui-studio.git

# 2. Symlink / copy the plugin into your MiniMax Code Plugins directory
ln -s "$(pwd)/comfyui-studio" \
       "$MCODE_HOME/plugins/antianqi/comfyui-studio"

# 3. (Optional) Verify
ls "$MCODE_HOME/plugins/antianqi/comfyui-studio/plugin.json"
```

> Don't know `$MCODE_HOME`? On most installs it is `~/.minimax/plugins/` (Linux/macOS) or
> `%USERPROFILE%\.minimax\plugins\` (Windows). The Plugin manager UI in mcode also has a
> "Install from local path" button — point it at the standalone repo root and you are done —
> the plugin is the whole repo, not a sub-folder.

## 3 install options

### Option A — Clone the standalone beta repo (recommended for testing)

```bash
git clone https://github.com/antianqi/comfyui-studio.git
# the plugin is the whole repo root
```

Pros: `git pull` later gets you the latest fixes without re-downloading.
Cons: requires git on the host.

### Option B — Download a release tarball (recommended for one-shot test)

Latest beta release:
**[`v0.2.0-beta.1`](https://github.com/antianqi/comfyui-studio/releases/tag/v0.2.0-beta.1)**

```bash
curl -L https://github.com/antianqi/comfyui-studio/archive/refs/tags/v0.2.0-beta.1.tar.gz \
  | tar -xz
cd comfyui-studio-0.2.0-beta.1
# the plugin is the whole folder
```

Pros: a frozen version, easy to roll back.
Cons: you have to re-download to get fixes.

### Option C — Download just the files you need (smallest payload)

[Browse the standalone beta repo at this tag](https://github.com/antianqi/comfyui-studio/tree/v0.2.0-beta.1),
hit "Download raw file" per file, OR use the GitHub CLI:

```bash
gh release download v0.2.0-beta.1 \
  --repo antianqi/comfyui-studio \
  --pattern '*' \
  --dir comfyui-studio-beta
```

## Try it (5 minutes)

After install, in any mcode session, paste this:

```text
Use comfyui-studio to verify that my local ComfyUI is reachable, then submit scenario 3
(改图 / flux2-klein-image-edit) with the prompt "the same person sitting in an office
chair, the same outfit, professional lighting" and report the saved image path.
```

Expected: the agent probes ComfyUI, submits the bundled workflow, polls until done, downloads
the image, and tells you where it was saved. The end-to-end walkthrough is in
[`examples/minimal-run.md`](examples/minimal-run.md).

If you have a trained character LoRA handy, try scenario 1 ("用我的角色画一张自拍") and
scenario 2 ("照着这张照片再画一张同款") — these are the two presets that exercise the
full face-LoRA + style-LoRA + Z-Image stack.

## What to test (the matrix)

| Scenario | Trigger | Preset workflow | Notes for testers |
|---|---|---|---|
| 1 | 生图 | `workflows/selfie-text-to-image.json` | Try with and without `--trigger`; try changing `LoraLoaderModelOnly.strength_model` |
| 2 | 模仿 | `workflows/selfie-mimicry.json` | Needs `ComfyUI-LLaMA-CPP` + `comfyui_controlnet_aux`; **will fail on installs without those custom nodes** |
| 3 | 改图 | `workflows/flux2-klein-image-edit.json` | Try different `KSampler.denoise` values (0.4 / 0.75 / 0.95) |
| 4 | 融合 | `workflows/flux2-klein-image-edit-dual.json` | Try with the "person on the left" + "outfit on the right" semantic |
| 5 | 首帧 | `workflows/drama-first-frame.json` | Set the second character LoRA's `strength_model = 0` for single-character dramas |
| 6 | 出片 | `workflows/drama-image-to-video.json` | Distilled LTX-2.3 is VRAM-friendly; non-distilled 22B is 30–60 min/shot |

## How to give feedback

Pick whichever channel fits you best:

- **GitHub issues on the standalone beta repo** (preferred for reproducible bugs):
  https://github.com/antianqi/comfyui-studio/issues
  Please include: your OS, your ComfyUI version, the scenario number, the prompt you used,
  and the full error output (or the prompt_id if ComfyUI swallowed the job).

- **Feishu mcode internal beta group**: just @ me in the channel where the announcement
  landed. Best for "it works but the UX is awkward" / "the docs say X but the workflow does Y".

- **PR comments**: https://github.com/MiniMax-AI/MiniMax-Code-Plugins/pull/15
  Best for structural / design feedback on the docs and the 6-scenario split.

## Known issues / not-yet-implemented

These are the things that are **intentionally out of scope** for the current PR but might
look like bugs:

- **Scenario 2 needs custom nodes**: `selfie-mimicry.json` uses
  `comfyui_controlnet_aux`, `ComfyUI-LLaMA-CPP`, `rgthree-comfy`, and
  `ComfyUI-Impact-Pack`. If your install does not have them, the submission will fail with
  `missing_node_type`. We are not bundling these because they vary across ComfyUI forks.
  The full list is in `skills/comfyui-character/SKILL.md`.
- **LoRA placeholders**: workflows reference `your_face_lora.safetensors`,
  `your_style_lora.safetensors`, `character_a_lora.safetensors`, etc. You **must** edit the
  `lora_name` field in the workflow JSON to point at your own file before submission. The
  Plugin does not bundle any private LoRAs.
- **Checkpoint filenames are the reference install's filenames**: the JSONs reference the
  exact files that ship on the reference ComfyUI install that built this Plugin. On a
  different install, you may need to edit the `ckpt_name` / `clip_name1` / `vae_name` /
  `control_net_name` fields. The Plugin does not pick abstract placeholder names for
  public generation models.
- **No TTS / no FFmpeg / no spreadsheet editor**: stages 2, 3, 6, 7 of the 7-stage drama
  pipeline are intentionally out of scope. See `skills/comfyui-drama/SKILL.md` for the full
  list.

## Versioning

- **`v0.2.0-beta.1`** — the version in `plugin.json` matches the PR #15 commit. The
  standalone beta repo is at [`antianqi/comfyui-studio`](https://github.com/antianqi/comfyui-studio);
  release tags live there, not in this fork.
- Future betas will tag on the standalone repo, with semver `-beta.N` suffixes.
- The first non-beta release (`v0.2.0`) will be published from the **official** repo
  (`MiniMax-AI/MiniMax-Code-Plugins`), not the standalone beta repo. Once that happens,
  the standalone beta repo will archive but stay readable as a historical reference.

## License

Apache-2.0. See [LICENSE](LICENSE).
