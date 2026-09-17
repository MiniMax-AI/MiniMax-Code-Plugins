# Octopus Meme Maker

Generate Smooth Squishmallow-style pink-octopus office-worker GIF memes from a scene description. Ships the 4-stage pipeline (base pose → 6s video → transparent text overlay → 720×720 GIF) plus the cross-platform scripts that assemble the final 480×480 mini-GIF for chat apps.

## Try it

```text
Make me a new octopus worker meme: 摆烂躺平 (lying flat on the desk, one eye half-closed, the other fully closed, the tip of one tentacle holding a coffee cup). The character must match the existing reference bases in examples/*.png (3D Squishmallow style). Save the result to <scene-dir>/ and follow the 4-stage pipeline in skills/octopus-meme-maker/SKILL.md (6-candidate contact-sheet round → user pick → base.png).
```

Expected result: `<scene-dir>/base.png` (1024×1024 base) → `<scene-dir>/video.mp4` (1080p 6s 24fps, 141 frames) → `<scene-dir>/final.gif` (720×720, 141 frames) → `<scene-dir>/final-mini.gif` (480×480, 141 frames).

## What's in this Plugin

- `skills/octopus-meme-maker/SKILL.md` — the 4-stage pipeline + ban-list + exit conditions
- `skills/octopus-meme-maker/reference.md` — character anatomy, style rules, prompt template, reference image list
- `skills/octopus-meme-maker/issues.md` — known failure modes and feedback signals
- `scripts/_fonts.py` — shared CJK font discovery and loading for the four scripts (not a CLI entry point)
- `scripts/make_contact_sheet.py` — compose the 6-candidate contact sheet stage 1 hands to the user (Pillow)
- `scripts/make_text_overlay.py` — render transparent Chinese text overlay (Pillow, cross-platform font picker)
- `scripts/make_preview_strip.py` — extract 5 key frames from the video and stitch a preview strip (ffmpeg + Pillow)
- `scripts/make_gif.py` — compose 720×720 final.gif + 480×480 final-mini.gif from video + overlay (ffmpeg subprocess)
- `examples/` — 3 base.png samples that the maintainer has successfully extracted. **This is the character / style reference.** Pass all three as `input_file_paths` to `image_synthesize` for every new scene to lock the Squishmallow style, anatomy, and rendering vibe; the prompt overrides the scene composition: `02-stay-late-base.png`, `10-toilet-slacking-base.png`, `11-touch-fish-base.png`
- `reference/videos/` — 2 h3 source videos (768×768, 24 fps, 6.58 s, h264+aac) picked as illustrative animation samples: `breakdown-h3.mp4` (我裂开了) and `treat-milk-tea-h3.mp4` (请大家喝奶茶)

## Requirements

- A MiniMax Code build that provides the `image_synthesize` and `gen_videos` host tools (those are host capabilities, not part of this Plugin; verified on mcode 0.4.6). Stage 1 and stage 2 of the pipeline call them directly.
- Python 3.10+
- `pip install Pillow`
- `ffmpeg` 5.0+ on `PATH` (verify with `ffmpeg -version`). The scripts pass `-fps_mode`, which replaced `-vsync` in ffmpeg 5.0; `make_gif.py` checks the major version up front and fails with a clear message on an older build.
- A CJK font installed on the system for the text overlay. The script auto-picks the first match from this list:
  - macOS: `/System/Library/Fonts/STHeiti Medium.ttc`, `/System/Library/Fonts/PingFang.ttc`
  - Linux: `/usr/share/fonts/truetype/wqy/wqy-microhei.ttc`, `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`
  - Windows: `C:\Windows\Fonts\msyh.ttc`, `C:\Windows\Fonts\simhei.ttf`
  - Pass `--font <path>` to override.
- MiniMax Code's `image_synthesize` and `gen_videos` tools (used by stage 1 and stage 2 of the pipeline; not bundled in this Plugin — they are part of the host).

## What this Plugin does NOT do

- **No credentials**: it does not read, write, accept, or transmit any API key, OAuth token, refresh token, client secret, username, password, or any other form of authentication credential. The Plugin has no login flow and no `Authorization` header.
- **No network access at runtime**: the shipped Python scripts run entirely on the local machine and only call `ffmpeg` and `Pillow` from the local system. They do not open any TCP / UDP / WebSocket connection.
- **No telemetry**: the Plugin does not phone home, does not log usage, and does not embed any analytics SDK. It ships no Google Analytics, no Sentry, no Mixpanel, no Cloudflare beacon, and no error reporter.
- **No third-party services**: the Plugin does not call any remote service. (Stage 1 and stage 2 of the pipeline call MiniMax Code's `image_synthesize` and `gen_videos` host tools, but those are part of the host runtime — the Plugin itself never makes a remote call.)

## Supported platforms

- **macOS 13+** — verified. Python 3.14.7, Pillow 12.3.0, ffmpeg 8.1.2, STHeiti font.
- **Linux** — verified on Ubuntu 24.04.4. Python 3.12.3, Pillow 10.2.0, ffmpeg 6.1.1, Noto Sans CJK. All four scripts produced the same artifact geometry as the macOS run: 1080×220 overlay, 2400×530 preview, 1460×974 contact sheet, `720,720,141` and `480,480,141` GIFs, and a 14-character caption auto-fitting at size 88.
- **Windows 10/11** — not verified on a Windows host. The scripts use `subprocess.run` with argument lists (no shell, so no quoting or injection surface), and the font picker falls back to `C:\Windows\Fonts\msyh.ttc`.

## Data and network

- No network access at runtime. The Plugin runs entirely on the local machine.
- The character generation steps (stage 1, stage 2) call host-provided image and video synthesis tools; those are out of scope for this Plugin but their network and data behaviour follows the host's policy.
- No credentials, accounts, paid services, telemetry, installers, symlinks, or native binaries are bundled.

## Verification

Shell blocks in this README are POSIX shell (macOS, Linux, or Git Bash on Windows). On Windows without Git Bash, run the same `python3 …` lines from PowerShell or `cmd`; only `mkdir -p` and `cp` need replacing (for example `New-Item -ItemType Directory -Force`, `Copy-Item`).

Every script pins its own stdout/stderr to UTF-8 and replaces characters the console cannot encode, so a Chinese caption prints on a cp1252 (English Windows) or cp936 console instead of raising `UnicodeEncodeError`. Subprocess output is decoded as UTF-8 with replacement rather than with the locale encoding.

This is a self-contained run: it uses the sample video bundled in `reference/videos/`, so no scene has to exist first. Run from this Plugin's root directory.

```bash
mkdir -p /tmp/octopus_selftest
cp reference/videos/breakdown-h3.mp4 /tmp/octopus_selftest/video.mp4

python3 scripts/make_text_overlay.py "再熬一会" /tmp/octopus_overlay.png
python3 scripts/make_preview_strip.py /tmp/octopus_selftest/video.mp4 /tmp/octopus_preview.png
python3 scripts/make_gif.py /tmp/octopus_selftest "再熬一会"
```

Expected:

| Output | Check |
|---|---|
| `/tmp/octopus_overlay.png` | 1080×220 RGBA |
| `/tmp/octopus_preview.png` | 2400×530 RGB (5 frames + label band) |
| `/tmp/octopus_selftest/final.gif` | `720,720,141` from `ffprobe` |
| `/tmp/octopus_selftest/final-mini.gif` | `480,480,141` from `ffprobe` |

All three scripts must exit 0. `make_gif.py` warns on stderr when the source video is not square; the bundled sample is 768×768, so that note is expected here and the render still succeeds.

## Packaging and submission

This directory carries the manifests for three runtime layouts. Each is read by a different reader, and the upstream repository documents the first two as valid choices for a submission.

| Manifest | Reader | Purpose |
|---|---|---|
| `plugin.json` (top level) | portable Agent Plugins 1.0 | The cross-runtime baseline. `scripts/validate.mjs` checks this layout by default, and mcode 0.3.x and 0.4.0+ both read it. |
| `.claude-plugin/plugin.json` | Claude Code compatible plugin | The preferred form for mcode 0.4.0+. Read as `manifestKind: CLAUDE_CODE`. |
| `.minimax-plugin/plugin.json` | MiniMax manifest | The Marketplace submission entry point and the desktop app's richer manifest (icon, category, displayName, exampleQueries). |

`icon.png` is referenced by the Claude Code compatible manifest (`icon`) and by the MiniMax manifest (`icon`).

The two manifest formats are not interchangeable and cannot both be *active* in one directory. A valid portable root `plugin.json` wins over `.minimax-plugin/plugin.json`:

```ts
if (await pluginPathExists(root, 'plugin.json', 'file')) {
  const agentPlugin = await tryReadAgentPluginPackage(rootPath);
  if (agentPlugin) return agentPlugin;   // root plugin.json wins
}
if (manifests.hasMiniMax) return readMiniMaxPluginPackage(rootPath, { source: 'LOCAL_MINIMAX' });
```

So when both files are present, the MiniMax manifest — `icon`, `category`, `displayName`, `exampleQueries` — is not read, and a locally installed copy shows the runtime's default icon. The Claude Code compatible manifest is a separate reader and is not affected by that precedence.

For a Marketplace submission, point the source at this directory (`plugins/weekbin/octopus-meme-maker`) and build the ZIP from a copy with the portable manifest removed:

```bash
rsync -a --exclude '/plugin.json' \
  plugins/weekbin/octopus-meme-maker/ \
  <local-package-dir>/
```

The `--exclude` is anchored (`/plugin.json`), so the nested manifests are kept.

### Localization

The client's plugin data model carries a single scalar `displayName` / `description` — there is no `displayName_zh`-style locale variant. Region (CN / US) is chosen at submission time, not per field. This package therefore uses bilingual user-facing strings (Chinese first, English second) so one package reads correctly in both regions.

## License

Apache-2.0. See [LICENSE](./LICENSE).
