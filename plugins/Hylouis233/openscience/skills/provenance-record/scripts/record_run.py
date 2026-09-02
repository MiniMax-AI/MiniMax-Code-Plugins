#!/usr/bin/env python3
"""Append one provenance entry to .openscience/provenance.jsonl.

Records what was produced, by which tool, in which environment.
Pure standard library; safe to run from any project root.
"""

import argparse
import hashlib
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

META_DIR = ".openscience"
LOG_FILE = "provenance.jsonl"


def env_fingerprint():
    """Return (hash, details) for the current runtime environment.

    The hash identifies the environment; details are stored once per
    hash under .openscience/env/<hash>.txt (dedup by existence).
    """
    details = (
        f"python: {sys.version}\n"
        f"platform: {platform.platform()}\n"
        f"machine: {platform.machine()}\n"
        f"processor: {platform.processor()}\n"
    )
    key = f"{sys.version}|{platform.platform()}|{platform.machine()}"
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return digest, details


def main():
    parser = argparse.ArgumentParser(
        description="Record a provenance entry for produced artifacts."
    )
    parser.add_argument(
        "--path", action="append", default=[], metavar="PATH",
        help="Artifact path; repeat for multiple paths.",
    )
    parser.add_argument("--tool", default="", help="Tool/skill that ran.")
    parser.add_argument("--session", default="", help="Session identifier.")
    parser.add_argument("--model", default="", help="Model name/version.")
    parser.add_argument("--note", default="", help="Free-form note.")
    parser.add_argument(
        "--format", choices=["text", "json"], default="text",
        help="Output format of the confirmation.",
    )
    args = parser.parse_args()

    if not args.path:
        parser.error("at least one --path is required")

    meta = Path(META_DIR)
    meta.mkdir(parents=True, exist_ok=True)

    env_hash, env_details = env_fingerprint()
    env_dir = meta / "env"
    env_dir.mkdir(exist_ok=True)
    env_file = env_dir / f"{env_hash}.txt"
    if not env_file.exists():  # dedup: environment details stored once per hash
        env_file.write_text(env_details, encoding="utf-8")

    entry = {
        "ts": datetime.now(timezone.utc).astimezone().isoformat(),
        "paths": [str(p) for p in args.path],
        "tool": args.tool,
        "session": args.session,
        "model": args.model,
        "env_hash": env_hash,
        "note": args.note,
    }

    log_path = meta / LOG_FILE
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    if args.format == "json":
        print(json.dumps({"ok": True, "entry": entry, "log": str(log_path)},
                         ensure_ascii=False))
    else:
        print(f"recorded {len(entry['paths'])} path(s) -> {log_path}")
        print(f"env_hash: {env_hash}")


if __name__ == "__main__":
    main()
