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

Marker substitution (when --workflow is provided):
    --prompt    replaces the literal "__PROMPT__"  in any text input
    --trigger   replaces the literal "__TRIGGER__" in any text input
    --filename  binds the value to the literal "__IMAGE1__" LoadImage marker
    --filename2 binds the value to the literal "__IMAGE2__" LoadImage marker
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
TRIGGER_MARKER = "__TRIGGER__"
IMAGE1_MARKER = "__IMAGE1__"
IMAGE2_MARKER = "__IMAGE2__"
POLL_INTERVAL_S = 2.0
POLL_TIMEOUT_S = 15 * 60  # 15 minutes cap; long jobs are a VRAM risk


# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse HTTP redirects.

    A redirected endpoint may live on a different host (proxy misconfig,
    DNS hijack, accidental public URL). Forwarding COMFYUI_API_TOKEN there
    would violate the security model in docs/security-notes.md. We fail
    closed: any 3xx is surfaced to the caller as an HTTPError with the
    original status code and the offending Location header.
    """

    @staticmethod
    def _deny(req, fp, code, msg, headers):
        location = headers.get("Location", "?") if headers else "?"
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            f"redirect refused by comfyui-studio: {code} -> {location}",
            headers,
            fp,
        )

    # Override every redirect code Python knows about. The base class
    # dispatches by method name (http_error_301, _302, _303, _307, _308),
    # not via a generic http_error_30x.
    http_error_301 = _deny
    http_error_302 = _deny
    http_error_303 = _deny
    http_error_307 = _deny
    http_error_308 = _deny


def _build_opener() -> urllib.request.OpenerDirector:
    """Build an opener that never follows redirects.

    `urllib.request.build_opener` registers a default HTTPRedirectHandler
    in BOTH the legacy `opener.handlers` list AND the dispatch dict
    `opener.handle_error["http"][code]`. The dispatch dict is what
    actually routes 3xx responses to handlers (see
    `OpenerDirector.error` / `_call_chain`); the `handlers` list is
    retained only for backward compatibility. To make our subclass win,
    we have to remove the default from BOTH structures.
    """
    opener = urllib.request.build_opener()

    # 1. Strip the default HTTPRedirectHandler from the legacy list.
    opener.handlers[:] = [
        h for h in opener.handlers
        if not isinstance(h, urllib.request.HTTPRedirectHandler)
    ]

    # 2. Strip the default from the dispatch dict. This is the one that
    #    actually matters at request time.
    for protocol, by_code in list(opener.handle_error.items()):
        for code, lst in list(by_code.items()):
            by_code[code] = [h for h in lst if not isinstance(h, urllib.request.HTTPRedirectHandler)]

    # 3. Register our subclass. It's now the only http redirect handler.
    opener.add_handler(_NoRedirectHandler())
    return opener


# Module-level opener used by every request below. `install_opener` also
# makes `urllib.request.urlopen` honor the same policy.
_opener = _build_opener()
urllib.request.install_opener(_opener)


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
        with _opener.open(req, timeout=30) as resp:
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
        with _opener.open(req, timeout=60) as resp:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(resp.read())
            return resp.status
    except urllib.error.URLError as e:
        print(f"[download] {url}: {e.reason}", file=sys.stderr)
        return 0


# ---------------------------------------------------------------------------
# Output-path containment
# ---------------------------------------------------------------------------

def safe_join_under(root: Path, name: str) -> Path:
    """Resolve root/name and verify it stays inside root.

    Rejects:
      - non-string or empty names
      - names containing NUL bytes
      - absolute paths (POSIX "/" or Windows drive roots like "C:\\")
      - any name whose resolved form is not a descendant of root
        (covers "..", "..\\..", symlink escapes, etc.)
    """
    if not isinstance(name, str) or not name:
        raise ValueError(f"filename must be a non-empty string, got {name!r}")
    if "\x00" in name:
        raise ValueError(f"filename contains NUL byte: {name!r}")
    if name.startswith(("/", "\\")) or (len(name) >= 2 and name[1] == ":"):
        raise ValueError(f"filename must be a relative path under output-dir: {name!r}")
    root_resolved = root.resolve(strict=False)
    candidate = (root / name).resolve(strict=False)
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        raise ValueError(
            f"filename {name!r} escapes output-dir {root_resolved}"
        ) from None
    return candidate


# ---------------------------------------------------------------------------
# Marker substitution
# ---------------------------------------------------------------------------

def apply_marker_substitution(
    workflow: dict,
    *,
    prompt: str | None = None,
    trigger: str | None = None,
    image1: str | None = None,
    image2: str | None = None,
) -> dict:
    """Replace marker strings in workflow nodes with the user's values.

    Marker contract (matches the Plugin's docs):
      __PROMPT__  -> --prompt     in any text input
      __TRIGGER__ -> --trigger    in any text input (typically CR Text.text)
      __IMAGE1__  -> --filename   in any LoadImage.image input
      __IMAGE2__  -> --filename2  in any LoadImage.image input

    Matching is exact (==), never substring, so user prompts that happen
    to contain a marker prefix are left alone. Empty / None substitutions
    are skipped; any marker left in the workflow after this call is a
    signal to the user that they forgot the corresponding flag (we log
    a warning below).
    """
    text_subs = (
        (PROMPT_MARKER, prompt),
        (TRIGGER_MARKER, trigger),
    )
    image_subs = (
        (IMAGE1_MARKER, image1),
        (IMAGE2_MARKER, image2),
    )
    applied: list[tuple[str, str, int]] = []  # (node_id, marker, n_chars)
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for marker, value in text_subs:
            if not value:
                continue
            if inputs.get("text") == marker:
                inputs["text"] = value
                applied.append((node_id, marker, len(value)))
        for marker, value in image_subs:
            if not value:
                continue
            if inputs.get("image") == marker:
                inputs["image"] = value
                applied.append((node_id, marker, len(value)))
    if applied:
        summary = ", ".join(f"{mid}@{nid}({n}ch)" for nid, mid, n in applied)
        print(f"[markers] substituted {len(applied)} marker(s): {summary}", file=sys.stderr)

    # Warn on any markers still present so a forgotten flag is obvious.
    leftover = _collect_unresolved_markers(workflow)
    if leftover:
        for marker, node_ids in leftover.items():
            print(
                f"[markers] WARNING: {marker} still present in nodes {node_ids}; "
                f"pass the corresponding --flag to replace it",
                file=sys.stderr,
            )
    return workflow


def _collect_unresolved_markers(workflow: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for marker in (PROMPT_MARKER, TRIGGER_MARKER, IMAGE1_MARKER, IMAGE2_MARKER):
        hits: list[str] = []
        for node_id, node in workflow.items():
            if not isinstance(node, dict):
                continue
            inputs = node.get("inputs")
            if not isinstance(inputs, dict):
                continue
            if inputs.get("text") == marker or inputs.get("image") == marker:
                hits.append(node_id)
        if hits:
            out[marker] = hits
    return out


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

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
    try:
        dest = safe_join_under(out_dir, args.filename)
    except ValueError as e:
        print(f"[download] refusing {e}", file=sys.stderr)
        return 2
    params = urllib.parse.urlencode({
        "filename": args.filename,
        "subfolder": args.subfolder or "",
        "type": args.folder_type or "output",
    })
    status = http_download(f"/view?{params}", dest)
    if status == 200:
        print(f"[download] saved {dest}")
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

    apply_marker_substitution(
        workflow,
        prompt=args.prompt,
        trigger=args.trigger,
        image1=args.filename,
        image2=args.filename2,
    )

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
            skipped = []
            for node_out in outputs.values():
                for media in node_out.get("images", []) + node_out.get("gifs", []) + node_out.get("videos", []):
                    fname = media.get("filename")
                    if not fname:
                        continue
                    try:
                        dest = safe_join_under(out_dir, fname)
                    except ValueError as e:
                        # Server-supplied filename tried to escape --output-dir.
                        # We refuse the file but keep polling the rest of the
                        # outputs so a single bad name doesn't lose the run.
                        skipped.append((fname, str(e)))
                        continue
                    sub = media.get("subfolder", "")
                    typ = media.get("type", "output")
                    qs = urllib.parse.urlencode({"filename": fname, "subfolder": sub, "type": typ})
                    s = http_download(f"/view?{qs}", dest)
                    if s == 200:
                        saved.append(str(dest))
            if skipped:
                for fname, reason in skipped:
                    print(f"[poll] skipped {fname!r}: {reason}", file=sys.stderr)
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
    ap.add_argument("--trigger", help="Optional LoRA trigger word (replaces __TRIGGER__ in CR Text.text)")
    ap.add_argument(
        "--filename",
        help=(
            "Dual meaning: in --download mode, the file to fetch from ComfyUI; "
            "in submit mode, the image name to bind to __IMAGE1__ in LoadImage nodes."
        ),
    )
    ap.add_argument(
        "--filename2",
        help="Image name to bind to __IMAGE2__ in LoadImage nodes (submit mode only, for fusion presets).",
    )
    ap.add_argument("--output-dir", help="Directory to save generated outputs")
    ap.add_argument("--subfolder", default="", help="Subfolder under ComfyUI output dir (download mode)")
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
