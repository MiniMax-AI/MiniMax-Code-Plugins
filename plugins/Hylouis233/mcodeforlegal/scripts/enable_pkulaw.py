#!/usr/bin/env python3
"""Enable or disable the optional PKULAW (北大法宝) MCP connector.

PKULAW is a paid commercial connector and stays DISABLED by default: the
plugin ships only the free flk connector in mcp.json. This script enables
pkulaw only after a live handshake against the official gateway succeeds,
so an unconfigured or invalid credential never leaves a broken entry behind.

Enable:
  1. Create a service at mcp.pkulaw.com -> get SERVICE_ID and Token.
  2. Set env vars (or pass flags):
       PKULAW_SERVICE_ID=<service id>   PKULAW_TOKEN=<token>
  3. python scripts/enable_pkulaw.py
     (writes the connector into ../mcp.json using the ${PKULAW_TOKEN} env
      reference -- the literal token is never written to disk)

Disable (credential revoked/expired, or simply opting out):
  python scripts/enable_pkulaw.py --disable

Exit codes: 0 ok, 1 handshake/write failed, 2 missing configuration.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
MCP_JSON = PLUGIN_ROOT / "mcp.json"
GATEWAY = "https://apim-gw.pkulaw.com/{service_id}/mcp"


def load_config():
    return json.loads(MCP_JSON.read_text(encoding="utf-8"))


def save_config(cfg):
    MCP_JSON.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def handshake(url, token, timeout):
    """Live initialize + tools/list against the streamable-http gateway."""
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
        for line in reversed(body.splitlines()):
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return json.loads(body)

    init = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                            "clientInfo": {"name": "enable-pkulaw", "version": "0"}}})
    server = init.get("result", {}).get("serverInfo", {})
    tools = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    names = [t.get("name") for t in tools.get("result", {}).get("tools", [])]
    return server, names


def cmd_enable(args):
    service_id = args.service_id or os.environ.get("PKULAW_SERVICE_ID", "").strip()
    token = args.token or os.environ.get("PKULAW_TOKEN", "").strip()
    if not service_id or not token:
        print("error: 缺少配置。请先：", file=sys.stderr)
        print("  ① mcp.pkulaw.com 控制台创建服务，获取 SERVICE_ID 与 Token", file=sys.stderr)
        print("  ② 设置环境变量 PKULAW_SERVICE_ID 与 PKULAW_TOKEN（或传 --service-id/--token）",
              file=sys.stderr)
        return 2

    url = GATEWAY.format(service_id=service_id)
    print(f"正在对 {url} 做连通性验证…")
    try:
        server, names = handshake(url, token, args.timeout)
    except urllib.error.HTTPError as exc:
        kind = {401: "凭证无效或已过期（401）", 403: "凭证无权限（403）"}.get(
            exc.code, f"HTTP {exc.code}")
        print(f"error: 网关拒绝：{kind}。未写入任何配置（pkulaw 保持未启用）。",
              file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 -- surface any failure structurally
        print(f"error: 验证失败：{exc}。未写入任何配置（pkulaw 保持未启用）。",
              file=sys.stderr)
        return 1

    cfg = load_config()
    cfg.setdefault("mcpServers", {})["pkulaw"] = {
        "type": "streamable-http",
        "url": url,
        "headers": {"Authorization": "Bearer ${PKULAW_TOKEN}"},
    }
    save_config(cfg)
    print(f"PASS  pkulaw 已启用：server={server.get('name', '?')}, tools={len(names)}")
    print(f"      前 6 个工具：{names[:6]}")
    print("注意：mcp.json 中保存的是 ${PKULAW_TOKEN} 环境变量引用，"
          "请确保运行 MiniMax Code 的环境中已设置该变量。")
    return 0


def cmd_disable(_args):
    cfg = load_config()
    if "pkulaw" not in cfg.get("mcpServers", {}):
        print("pkulaw 本就未启用，无需操作。")
        return 0
    del cfg["mcpServers"]["pkulaw"]
    save_config(cfg)
    print("pkulaw 已从 mcp.json 移除（未启用）。skill 将降级到 flk 免费层。")
    return 0


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--service-id", help="PKULAW SERVICE_ID（默认读 env PKULAW_SERVICE_ID）")
    parser.add_argument("--token", help="PKULAW Token（默认读 env PKULAW_TOKEN）")
    parser.add_argument("--disable", action="store_true", help="停用 pkulaw connector")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()
    code = cmd_disable(args) if args.disable else cmd_enable(args)
    sys.exit(code)


if __name__ == "__main__":
    main()
