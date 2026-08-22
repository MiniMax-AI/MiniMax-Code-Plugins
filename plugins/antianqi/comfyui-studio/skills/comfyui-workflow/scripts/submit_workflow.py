#!/usr/bin/env python3
"""Submit a ComfyUI workflow, poll the queue, and download the output.

This is a single-file CLI wrapper around the local ComfyUI HTTP API. It is
intentionally tiny: no third-party Python dependencies, no native extensions,
no telemetry. Everything it does is also exposed by the Plugin's stdio MCP
server (see ../../../server.mjs); use whichever fits the host agent.

Environment:
    COMFYUI_URL       ComfyUI base URL. Default: http://127.0.0.1:8188
    COMFYUI_API_TOKEN Optional bearer token for auth-fronted ComfyUI

Examples:
    python submit_workflow.py --probe
    python submit_workflow.py --workflow path/to/wf.json --prompt "a cat"
    python submit_workflow.py --queue
    python submit_workflow.py --download --filename out.png --output-dir ./out
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8188"
PROMPT_MARKER = "__PROMPT__"
POLL_INTERVAL_S = 2.0
POLL_TIMEOUT_S = 15 * 60  # 15 minutes cap; long jobs are a VRAM risk


def base_url() -> str:
    return os.environ.get("COMFYUI_URL", DEFAULT_URL).rstrip("/")


def auth_headers() -> dict:
    token = os.environ.get("COMFYUI_API_TOKEN", "")
    return {"authorization": f"Bearer {token}"} if token else {}


def http_json(method: str, path: str, body: dict | None = None) -> tuple[int, dict | str]:
    url = base_url() + path
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"content-type": "application/json", "accept": "application/json", **auth_headers()},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")
    except urllib.error.URLError as e:
        return 0, f"connection error: {e.reason}"


def http_download(path: str, dest: Path) -> int:
    url = base_url() + path
    req = urllib.request.Request(url, headers=auth_headers())
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.read())
            return resp.status
    except urllib.error.URLError as e:
        print(f"[download] {url}: {e.reason}", file=sys.stderr)
        return 0


def apply_prompt_override(workflow: dict, prompt_text: str | None) -> dict:
    """If --prompt was given and the workflow has a __PROMPT__ marker, substitute.

    Walks every node in the workflow. For any CLIPTextEncode-style node whose
    `text` input is exactly the literal marker, replace with the user's text.
    Nodes that already have a value are left alone.
    """
    if not prompt_text:
        return workflow
    changed = []
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        text = inputs.get("text")
        if text == PROMPT_MARKER:
            inputs["text"] = prompt_text
            changed.append(node_id)
    if changed:
        print(f"[prompt] substituted __PROMPT__ in nodes: {changed}", file=sys.stderr)
    return workflow


def cmd_probe(_args) -> int:
    status, body = http_json("GET", "/system_stats")
    if status != 200:
        print(f"[probe] FAILED status={status} body={body}")
        return 2
    if isinstance(body, dict):
        version = body.get("system", {}).get("comfyui_version", "?")
        print(f"[probe] OK comfyui_version={version}")
        for dev in body.get("devices", []) or []:
            free_gb = (dev.get("vram_free") or 0) / (1024 ** 3)
            total_gb = (dev.get("vram_total") or 0) / (1024 ** 3)
            print(f"[probe] device={dev.get('name')} vram_free={free_gb:.1f}GB/{total_gb:.1f}GB")
    else:
        print(f"[probe] OK body={body}")
    return 0


def cmd_queue(_args) -> int:
    status, body = http_json("GET", "/queue")
    if status != 200 or not isinstance(body, dict):
        print(f"[queue] FAILED status={status} body={body}")
        return 2
    running = body.get("queue_running") or []
    pending = body.get("queue_pending") or []
    print(f"[queue] running={len(running)} pending={len(pending)}")
    for item in running:
        print(f"  running  prompt_id={item[1] if len(item) > 1 else '?'}")
    for item in pending:
        print(f"  pending  prompt_id={item[1] if len(item) > 1 else '?'}")
    return 0


def cmd_download(args) -> int:
    out_dir = Path(args.output_dir or ".")
    params = urllib.parse.urlencode({
        "filename": args.filename,
        "subfolder": args.subfolder or "",
        "type": args.folder_type or "output",
    })
    status = http_download(f"/view?{params}", out_dir / args.filename)
    if status == 200:
        print(f"[download] saved {out_dir / args.filename}")
        return 0
    return 2


def cmd_submit(args) -> int:
    if not args.workflow:
        print("[submit] --workflow is required (or use --probe / --queue / --download)", file=sys.stderr)
        return 2
    wf_path = Path(args.workflow)
    if not wf_path.exists():
        print(f"[submit] workflow file not found: {wf_path}", file=sys.stderr)
        return 2
    try:
        workflow = json.loads(wf_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"[submit] invalid JSON: {e}", file=sys.stderr)
        return 2

    workflow = apply_prompt_override(workflow, args.prompt)

    status, body = http_json("POST", "/prompt", {"prompt": workflow})
    if status != 200:
        print(f"[submit] HTTP {status}: {body}")
        return 2
    if not isinstance(body, dict) or "error" in body:
        print(f"[submit] workflow rejected: {body}")
        return 2
    prompt_id = body.get("prompt_id")
    print(f"[submit] prompt_id={prompt_id} number={body.get('number')}")

    deadline = time.time() + POLL_TIMEOUT_S
    out_dir = Path(args.output_dir or ".")
    while True:
        if time.time() > deadline:
            print(f"[poll] timed out after {POLL_TIMEOUT_S}s, prompt_id={prompt_id} still running", file=sys.stderr)
            return 3
        time.sleep(POLL_INTERVAL_S)
        status, hist = http_json("GET", f"/history/{prompt_id}")
        if status != 200 or not isinstance(hist, dict):
            continue
        entry = hist.get(prompt_id)
        if not entry:
            continue
        st = (entry.get("status") or {}).get("status_str")
        if st not in (None,):
            print(f"[poll] status={st}")
        if st == "success":
            outputs = entry.get("outputs") or {}
            saved = []
            for node_out in outputs.values():
                for media in node_out.get("images", []) + node_out.get("gifs", []) + node_out.get("videos", []):
                    fname = media.get("filename")
                    sub = media.get("subfolder", "")
                    typ = media.get("type", "output")
                    qs = urllib.parse.urlencode({"filename": fname, "subfolder": sub, "type": typ})
                    dest = out_dir / fname
                    s = http_download(f"/view?{qs}", dest)
                    if s == 200:
                        saved.append(str(dest))
            if not saved:
                print("[poll] success but no output files reported (workflow may not have a Save node)")
                return 0
            print("[poll] saved:")
            for p in saved:
                print(f"  {p}")
            return 0
        if st in ("error", "cancelled"):
            print(f"[poll] {st}: {entry}")
            return 4


def main() -> int:
    ap = argparse.ArgumentParser(description="Drive a local ComfyUI server.")
    ap.add_argument("--url", help="Override COMFYUI_URL for this invocation only")
    ap.add_argument("--workflow", help="Path to a workflow JSON file")
    ap.add_argument("--prompt", help="Optional prompt override (replaces __PROMPT__ in the workflow)")
    ap.add_argument("--output-dir", help="Directory to save generated outputs")
    ap.add_argument("--filename", help="Filename to download (with --download)")
    ap.add_argument("--subfolder", default="", help="Subfolder under ComfyUI output dir")
    ap.add_argument("--folder-type", default="output", choices=["output", "input", "temp"])
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--probe", action="store_true", help="Health probe /system_stats")
    mode.add_argument("--queue", action="store_true", help="Show running and pending queue")
    mode.add_argument("--download", action="store_true", help="Download a file by name")
    args = ap.parse_args()

    if args.url:
        os.environ["COMFYUI_URL"] = args.url

    if args.probe:
        return cmd_probe(args)
    if args.queue:
        return cmd_queue(args)
    if args.download:
        if not args.filename:
            print("--download requires --filename", file=sys.stderr)
            return 2
        return cmd_download(args)
    return cmd_submit(args)


if __name__ == "__main__":
    sys.exit(main())
