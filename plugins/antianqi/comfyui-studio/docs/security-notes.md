# Security notes

This Plugin is designed to be safe to install in environments where ComfyUI is already running
locally. It does not introduce new network destinations, does not run any installers, and does
not request elevated privileges.

## What the Plugin touches

| Surface | Action | Notes |
|---|---|---|
| Local HTTP API (`COMFYUI_URL`) | Reads queue, submits workflows, downloads images | Default `http://127.0.0.1:8188`; loopback only unless overridden |
| Local filesystem | Reads workflow JSON files the user points at; writes outputs to a user-chosen directory | The script never writes outside `--output-dir` |
| Environment variables | Reads `COMFYUI_URL` and optional `COMFYUI_API_TOKEN` | Token is sent only to `COMFYUI_URL` |
| LoRA / checkpoint files | The Plugin does not read, write, copy, or upload any model file | Models and LoRAs are loaded by ComfyUI itself, on its own terms |

The Plugin does not:

- Make outbound requests to anywhere except `COMFYUI_URL`.
- Install, download, or update any package (no `npm install`, no `pip install`, no post-install
  hook). The MCP server is a single-file `server.mjs` that uses only the Node 18+ stdlib.
- Collect telemetry, analytics, or crash reports.
- Read or upload any file outside of what the user explicitly passes as `--workflow`,
  `--output-dir`, or `--filename`.
- Set environment variables, modify the user's shell, or change system settings.

## Threat model

The Plugin assumes:

- The host running ComfyUI is a development workstation the user controls.
- The `COMFYUI_URL` address points to a process the user started and trusts.
- Any reverse proxy in front of ComfyUI is the user's own and is responsible for its own
  authentication.

The Plugin does not defend against a malicious ComfyUI server. If `COMFYUI_URL` points to a
server an attacker controls, the attacker can return any JSON they like from `/prompt`,
`/history`, and `/view` — the Plugin will display that JSON to the agent. Treat `COMFYUI_URL`
the same way you treat the path of any binary you run.

## Authentication

Plain ComfyUI has no authentication. If the user runs ComfyUI behind a reverse proxy that
requires a bearer token, set `COMFYUI_API_TOKEN` in the environment. The Plugin's MCP server
and the Python script both add it as `Authorization: Bearer <token>` to every request. The
token never leaves the host; it is not logged, echoed, or sent to any other destination.

## The MCP server boundary

The Plugin's `server.mjs` exposes three tools: `submit_prompt`, `check_queue`, and
`get_image`. Each maps to a single HTTP call against `COMFYUI_URL`. The server holds no state
between calls and does not open any socket other than the stdio JSON-RPC channel to its parent
agent. It is a thin adapter, not a service.

## What you should review before adopting

- **The bundled workflow JSON.** Open `workflows/text-to-image.json` and confirm you understand
  every node. ComfyUI workflows are arbitrary code graphs; the Plugin's only assumption is the
  `__PROMPT__` token convention, which is opt-in.
- **`mcp.json`.** Confirm the `COMFYUI_URL` it sets is the address you want.
- **`server.mjs`.** It is ~200 lines of plain Node stdlib; review it the same way you would
  review any other small script you are about to run.
- **The `submit_workflow.py` script.** Single file, stdlib only; review it before running.

## Reporting a security issue

See the parent repository's [`SECURITY.md`](https://github.com/MiniMax-AI/MiniMax-Code-Plugins/blob/main/SECURITY.md)
for the responsible-disclosure process.

## License

Apache-2.0. See [LICENSE](../LICENSE).
