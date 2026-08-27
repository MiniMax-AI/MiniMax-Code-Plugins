#!/usr/bin/env python3
"""Connectivity check for legal-core MCP connectors (flk + pkulaw).

For each connector configured in ../mcp.json this script performs a live
MCP handshake (initialize + tools/list) and reports a structured result:

  - flk:    spawned locally via stdio; must always pass (free builtin tier).
  - pkulaw: HTTP gateway; requires PKULAW_TOKEN env var. Missing token is a
            WARNING (token_missing), not a failure -- skills degrade to the
            free tier by design.

Exit code: 0 when all mandatory checks pass, 1 otherwise.
Usage: python scripts/check_connectors.py [--format json] [--timeout 30]
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
FLK_SERVER = PLUGIN_ROOT / "mcp" / "flk_server.py"
MCP_JSON = PLUGIN_ROOT / "mcp.json"

results = []


def report(name, status, detail):
    """status: pass | warn | fail"""
    results.append({"connector": name, "status": status, "detail": detail})
    icon = {"pass": "PASS", "warn": "WARN", "fail": "FAIL"}[status]
    print(f"{icon}  {name}: {detail}")


def mcp_stdio_roundtrip(cmd, messages, timeout):
    """Send newline-delimited JSON-RPC messages to a stdio MCP server."""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding="utf-8",
    )
    payload = "".join(json.dumps(m, ensure_ascii=False) + "\n" for m in messages)
    try:
        out, _ = proc.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        raise RuntimeError(f"stdio server did not respond within {timeout}s")
    replies = [json.loads(line) for line in out.splitlines() if line.strip()]
    return replies


def check_flk(timeout):
    if not FLK_SERVER.is_file():
        report("flk", "fail", f"server script missing: {FLK_SERVER}")
        return
    msgs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "check-connectors", "version": "0"}}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
         "params": {"name": "flk_check",
                    "arguments": {"title": "中华人民共和国民法典"}}},
    ]
    started = time.time()
    try:
        replies = mcp_stdio_roundtrip([sys.executable, str(FLK_SERVER)], msgs, timeout)
    except Exception as exc:  # noqa: BLE001 -- report any failure structurally
        report("flk", "fail", f"stdio handshake failed: {exc}")
        return
    latency = time.time() - started
    tools = []
    found = None
    for r in replies:
        if r.get("id") == 2:
            tools = [t.get("name") for t in r.get("result", {}).get("tools", [])]
        if r.get("id") == 3:
            content = r.get("result", {}).get("content", [])
            if content:
                try:
                    found = json.loads(content[0].get("text", "{}"))
                except json.JSONDecodeError:
                    found = {"parse_error": True}
    if not tools:
        report("flk", "fail", "tools/list returned no tools")
        return
    ok = isinstance(found, dict) and found.get("found") is True
    status = "pass" if ok else "fail"
    detail = (f"tools={tools}; flk_check 民法典 -> "
              f"found={found.get('found')} status={found.get('status')}; "
              f"{latency:.1f}s")
    report("flk", status, detail)


def check_pkulaw(timeout):
    try:
        cfg = json.loads(MCP_JSON.read_text(encoding="utf-8"))
        entry = cfg.get("mcpServers", {}).get("pkulaw")
    except Exception as exc:  # noqa: BLE001
        report("pkulaw", "fail", f"cannot read mcp.json: {exc}")
        return

    if entry is None:
        report("pkulaw", "warn",
               "not_enabled（默认状态）：pkulaw 为付费商业源，未配置不启用。"
               "启用方法：① mcp.pkulaw.com 获取 SERVICE_ID 与 Token；"
               "② 设置 PKULAW_SERVICE_ID 与 PKULAW_TOKEN；"
               "③ python scripts/enable_pkulaw.py（握手验证通过后才会写入配置）。"
               "未启用时所有 skill 自动降级到 flk 免费层并标注来源缺口。")
        return

    url = entry.get("url", "")
    token = os.environ.get("PKULAW_TOKEN", "").strip()
    if not token:
        report("pkulaw", "warn",
               "已在 mcp.json 启用但当前 shell 未设置 PKULAW_TOKEN，无法验证。"
               "请设置后重跑；如凭证已失效，执行 enable_pkulaw.py --disable 移除。")
        return

    def post(payload):
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream",
                     "Authorization": f"Bearer {token}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        # Streamable-HTTP may answer with SSE frames; take the last data line.
        for line in reversed(body.splitlines()):
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return json.loads(body)

    try:
        init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "check-connectors", "version": "0"}}})
        server = init.get("result", {}).get("serverInfo", {})
        tools = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        names = [t.get("name") for t in tools.get("result", {}).get("tools", [])]
        report("pkulaw", "pass", f"server={server.get('name', '?')} tools={len(names)}: {names[:6]}")
    except urllib.error.HTTPError as exc:
        kind = {401: "auth_error（token 无效或过期）", 403: "auth_error（无权限）"}.get(
            exc.code, f"http_{exc.code}")
        report("pkulaw", "fail",
               f"gateway rejected: {kind}。凭证失效时应停用："
               "python scripts/enable_pkulaw.py --disable")
    except Exception as exc:  # noqa: BLE001
        report("pkulaw", "fail", f"handshake failed: {exc}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    as_json = "--format" in sys.argv and "json" in sys.argv
    timeout = 30
    if "--timeout" in sys.argv:
        timeout = int(sys.argv[sys.argv.index("--timeout") + 1])

    check_flk(timeout)
    check_pkulaw(timeout)

    failed = any(r["status"] == "fail" for r in results)
    if as_json:
        print(json.dumps({"checks": results, "ok": not failed},
                         ensure_ascii=False, indent=2))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
