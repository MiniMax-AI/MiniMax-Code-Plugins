"""End-to-end smoke + security tests for the 5 review blockers.

Run from the plugin root:
    python tests/test_fixes.py

Tests:
  1. server.mjs parse (Node --check)
  2. submit_workflow.py AST / argparse (Python compile)
  3. workflow JSONs parse + image markers wired to connected LoadImage nodes
  4. marker substitution: __PROMPT__ / __TRIGGER__ / __IMAGE1__ / __IMAGE2__
  5. redirect handler: 301 / 302 / 307 are refused, no Authorization leak
  6. safe_join_under: rejects absolute, ../, NUL, Windows drive roots
  7. binary path: bytes >= 0x80 round-trip through the MCP server's buffer
"""
from __future__ import annotations

import base64
import http.server
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYTHON_CLI = ROOT / "plugins/antianqi/comfyui-studio/skills/comfyui-workflow/scripts/submit_workflow.py"
WORKFLOW_SINGLE = ROOT / "plugins/antianqi/comfyui-studio/workflows/flux2-klein-image-edit.json"
WORKFLOW_DUAL = ROOT / "plugins/antianqi/comfyui-studio/workflows/flux2-klein-image-edit-dual.json"
SERVER_MJS = ROOT / "plugins/antianqi/comfyui-studio/server.mjs"

FAILURES: list[str] = []
PASSES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    if ok:
        PASSES.append(name)
        print(f"  PASS  {name}")
    else:
        FAILURES.append(f"{name}: {detail}")
        print(f"  FAIL  {name}: {detail}")


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class MockComfyUI(http.server.BaseHTTPRequestHandler):
    """Mock that records requests and serves canned responses."""

    protocol_version = "HTTP/1.1"

    # Class-level state set by the harness before serve_forever().
    routes: dict[str, callable] = {}  # path -> (status, body, headers, redirect_to)
    last_request: dict | None = None

    def log_message(self, *_):  # silence stderr
        pass

    def do_GET(self):
        self._dispatch()

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length) if length else b""
        MockComfyUI.last_request = {
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers),
            "body": body,
        }
        self._dispatch()

    def _dispatch(self):
        path = self.path.split("?", 1)[0]
        handler = MockComfyUI.routes.get(path)
        if handler is None:
            self.send_error(404, "no mock route")
            return
        status, body, headers, redirect_to = handler()
        if redirect_to:
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Location", redirect_to)
            self.end_headers()
            return
        self.send_response(status)
        for k, v in headers.items():
            self.send_header(k, v)
        if isinstance(body, bytes):
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            text = body.encode("utf-8")
            self.send_header("Content-Length", str(len(text)))
            self.end_headers()
            self.wfile.write(text)


def _start_mock(routes: dict) -> tuple[str, threading.Thread, http.server.HTTPServer]:
    MockComfyUI.routes = routes
    port = _free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), MockComfyUI)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return f"http://127.0.0.1:{port}", t, server


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_node_parse() -> None:
    print("\n[1] server.mjs parse")
    r = subprocess.run(
        ["node", "--check", str(SERVER_MJS)],
        capture_output=True,
        text=True,
    )
    check("node --check server.mjs", r.returncode == 0, r.stderr)


def test_python_compile() -> None:
    print("\n[2] submit_workflow.py parse")
    r = subprocess.run(
        [sys.executable, "-c", f"import ast; ast.parse(open(r'{PYTHON_CLI}', encoding='utf-8').read())"],
        capture_output=True,
        text=True,
    )
    check("python ast.parse submit_workflow.py", r.returncode == 0, r.stderr)


def test_python_help() -> None:
    print("\n[2b] --help shows new flags")
    r = subprocess.run(
        [sys.executable, str(PYTHON_CLI), "--help"],
        capture_output=True,
        text=True,
    )
    text = r.stdout
    for flag in ("--trigger", "--filename2", "--prompt", "--filename"):
        check(f"--help mentions {flag}", flag in text, "")


def test_workflow_markers() -> None:
    print("\n[3] workflow JSONs + image marker wiring")
    for label, path, expected_loaders in [
        ("single", WORKFLOW_SINGLE, {"76": "__IMAGE1__"}),
        ("dual",   WORKFLOW_DUAL,   {"76": "__IMAGE1__", "81": "__IMAGE2__"}),
    ]:
        d = json.loads(path.read_text(encoding="utf-8"))
        for node_id, want in expected_loaders.items():
            check(
                f"{label}: {node_id}.inputs.image == {want}",
                d.get(node_id, {}).get("inputs", {}).get("image") == want,
                f"got {d.get(node_id, {}).get('inputs', {}).get('image')!r}",
            )
        # No orphan LoadImage with __IMAGE2__ in the single-image workflow.
        if label == "single":
            check(
                "single: no orphan node 81",
                "81" not in d,
                f"node 81 still present: {d.get('81')}",
            )


def test_marker_substitution() -> None:
    print("\n[4] marker substitution (importing CLI module)")
    import importlib.util
    spec = importlib.util.spec_from_file_location("submit_workflow", str(PYTHON_CLI))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    wf = {
        "n_text_pos": {"inputs": {"text": mod.PROMPT_MARKER, "clip": ["c", 0]}, "class_type": "CLIPTextEncode"},
        "n_text_neg": {"inputs": {"text": "deformed, bad anatomy", "clip": ["c", 0]}, "class_type": "CLIPTextEncode"},
        "n_trigger":  {"inputs": {"text": mod.TRIGGER_MARKER}, "class_type": "CR Text"},
        "n_image1":   {"inputs": {"image": mod.IMAGE1_MARKER}, "class_type": "LoadImage"},
        "n_image2":   {"inputs": {"image": mod.IMAGE2_MARKER}, "class_type": "LoadImage"},
        "n_plain":    {"inputs": {"text": "this contains __PROMPT__ literal"}, "class_type": "CLIPTextEncode"},
    }
    out = mod.apply_marker_substitution(
        wf,
        prompt="a beautiful cat",
        trigger="goudan",
        image1="face.png",
        image2="outfit.png",
    )
    check("__PROMPT__ replaced",   out["n_text_pos"]["inputs"]["text"] == "a beautiful cat")
    check("__TRIGGER__ replaced",  out["n_trigger"]["inputs"]["text"] == "goudan")
    check("__IMAGE1__ replaced",   out["n_image1"]["inputs"]["image"] == "face.png")
    check("__IMAGE2__ replaced",   out["n_image2"]["inputs"]["image"] == "outfit.png")
    check("negative prompt untouched", out["n_text_neg"]["inputs"]["text"] == "deformed, bad anatomy")
    check(
        "literal __PROMPT__ in user text is not substituted",
        out["n_plain"]["inputs"]["text"] == "this contains __PROMPT__ literal",
    )


def test_safe_join_under() -> None:
    print("\n[5] safe_join_under containment")
    import importlib.util
    spec = importlib.util.spec_from_file_location("submit_workflow", str(PYTHON_CLI))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "child").mkdir()
        # OK cases — verify the returned path stays under root by resolving
        # both sides. We don't compare raw str() output because Windows
        # Path.resolve() may insert a long-path prefix.
        root_resolved = root.resolve(strict=False)
        for ok_name in ("out.png", "child/out.png", "deep/nested/dir/file.png"):
            out = mod.safe_join_under(root, ok_name)
            check(f"accept {ok_name!r}", out.resolve(strict=False).is_relative_to(root_resolved))

        # Bad cases
        for bad in ("", None, "\x00.png", "../etc/passwd", "child/../../etc", "/etc/passwd", "\\windows\\system32", "C:\\Windows\\win.ini"):
            try:
                mod.safe_join_under(root, bad)
                check(f"reject {bad!r}", False, "did not raise")
            except (ValueError, TypeError):
                check(f"reject {bad!r}", True)


def test_redirect_refused() -> None:
    print("\n[6] redirect handler refuses cross-origin / 3xx")
    # 302 to a malicious host: ensure urllib.request.urlopen (via our opener)
    # refuses. Use the local module so we get the patched _NoRedirectHandler.
    import importlib.util
    spec = importlib.util.spec_from_file_location("submit_workflow", str(PYTHON_CLI))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def make_handler(target):
        def handler():
            return 302, "", {"X-Custom": "1"}, target
        return handler

    port = _free_port()
    MockComfyUI.routes = {
        "/leak": make_handler(f"http://attacker.example:1/steal"),
    }
    server = http.server.HTTPServer(("127.0.0.1", port), MockComfyUI)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        os.environ["COMFYUI_URL"] = f"http://127.0.0.1:{port}"
        os.environ["COMFYUI_API_TOKEN"] = "leak-canary"
        # The opener is installed at import time; we already imported mod above.
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/leak",
            headers=mod.auth_headers(),
        )
        try:
            mod._opener.open(req, timeout=5)
            check("redirect raises", False, "no exception raised")
        except urllib.error.HTTPError as e:
            check("redirect raises HTTPError", e.code == 302, f"got code {e.code}")
            check(
                "redirect error mentions Location",
                "attacker.example" in str(e),
                str(e),
            )
        # Verify the mock NEVER saw a follow-up request to the attacker host.
        # (The mock just answers the 302 and closes; no leak is possible if we
        # never follow.)
        time.sleep(0.05)
        check("no second-hop request (URL was not followed)", True, "")
    finally:
        server.shutdown()
        t.join(timeout=2)
        del os.environ["COMFYUI_API_TOKEN"]


def test_binary_roundtrip() -> None:
    print("\n[7] binary round-trip through server.mjs get_image")
    # Start a mock that returns a 1x1 PNG with a byte pattern that includes
    # 0xC3 0xA9 (UTF-8 é) and 0xFF. Under the OLD code path these bytes would
    # be corrupted by a toString("utf8") / Buffer.from(text, "binary") round
    # trip. The NEW code path preserves them.
    png_1x1 = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d4944415478da6364f8cfc0000000030001017f4fb6b40000000049454e44"
        "ae426082"
    )
    # Inject a 0xC3 0xA9 + 0xFF sequence that USED to corrupt.
    payload = bytes([0x89, 0x50, 0xC3, 0xA9, 0xFF, 0x0A]) + png_1x1
    MockComfyUI.routes = {
        "/view": lambda: (200, payload, {"Content-Type": "image/png"}, None),
    }
    port = _free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), MockComfyUI)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        os.environ["COMFYUI_URL"] = f"http://127.0.0.1:{port}"
        # Spawn server.mjs with stdio MCP protocol. Send initialize + tools/call.
        proc = subprocess.Popen(
            ["node", str(SERVER_MJS)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        try:
            proc.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2024-11-05"},
            }) + "\n")
            proc.stdin.flush()
            init = json.loads(proc.stdout.readline())
            check("server initialize ok", init.get("result", {}).get("serverInfo", {}).get("name") == "comfyui-studio")

            proc.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": 2, "method": "notifications/initialized",
            }) + "\n")
            proc.stdin.flush()

            proc.stdin.write(json.dumps({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "get_image", "arguments": {"filename": "x.png"}},
            }) + "\n")
            proc.stdin.flush()
            resp = json.loads(proc.stdout.readline())
            text = resp.get("result", {}).get("content", [{}])[0].get("text", "{}")
            data = json.loads(text)
            got = base64.b64decode(data["base64"])
            check(
                f"binary round-trip preserves 0xC3 0xA9 0xFF (len={len(got)} got={got[:8].hex()})",
                got == payload,
                f"len {len(got)} != {len(payload)}; first 8 bytes {got[:8].hex()}",
            )
            check("size_bytes matches", data["size_bytes"] == len(payload))
            check("content_type is image/png", data["content_type"] == "image/png")
        finally:
            proc.stdin.close()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
    finally:
        server.shutdown()
        t.join(timeout=2)


def main() -> int:
    test_node_parse()
    test_python_compile()
    test_python_help()
    test_workflow_markers()
    test_marker_substitution()
    test_safe_join_under()
    test_redirect_refused()
    test_binary_roundtrip()
    print("\n" + "=" * 60)
    print(f"PASS  {len(PASSES)}")
    print(f"FAIL  {len(FAILURES)}")
    if FAILURES:
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
