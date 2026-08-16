#!/usr/bin/env python3
"""Agnes AI 图像 / 视频生成统一入口。

图像（同步）：
  python agnes.py image --prompt "..." [--size 2K] [--ratio 16:9] [--image a.png b.png] [--format url] [--out DIR]
视频（异步，内部轮询）：
  python agnes.py video --prompt "..." [--image x.png] [--keyframes a b] [--duration 5] [--width W --height H] [--out DIR]

API key 读取顺序：--api-key > AGNES_API_KEY 环境变量 > ~/.hermes/.env 文件里的 AGNES_API_KEY。
标准库实现，零第三方依赖，Python 3.8+。
"""

import argparse
import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(newline="\n")
    sys.stderr.reconfigure(newline="\n")
except Exception:
    pass

BASE = "https://apihub.agnes-ai.com"
IMAGE_MODEL = "agnes-image-2.1-flash"
VIDEO_MODEL = "agnes-video-v2.0"

MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}


class ApiError(Exception):
    def __init__(self, code, msg):
        self.code = code
        super().__init__(f"HTTP {code}: {msg}")


def normalize_path(p):
    """MSYS 路径 /c/Users/... → Windows 盘符路径 C:/Users/...。"""
    s = str(p)
    if len(s) >= 3 and s[0] == "/" and s[2] == "/" and s[1].isalpha():
        s = f"{s[1].upper()}:/{s[3:]}"
    return s


def _read_env_file(path):
    """从 .env 文件读 AGNES_API_KEY=xxx（兼容 export 前缀与引号）。"""
    try:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            if line.startswith("AGNES_API_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    except OSError:
        pass
    return None


def get_api_key(explicit):
    if explicit:
        return explicit.strip()
    env = os.environ.get("AGNES_API_KEY", "").strip()
    if env:
        return env
    # Hermes .env：HERMES_HOME 优先，其次 ~/.hermes，再 Windows 默认 AppData 位置
    candidates = []
    hh = os.environ.get("HERMES_HOME", "").strip()
    if hh:
        candidates.append(os.path.join(hh, ".env"))
    candidates.append(str(Path.home() / ".hermes" / ".env"))
    candidates.append(str(Path.home() / "AppData" / "Local" / "hermes" / ".env"))
    for env_path in candidates:
        v = _read_env_file(env_path)
        if v:
            return v
    raise SystemExit(
        "ERROR: 未找到 API key。用 --api-key、AGNES_API_KEY 环境变量或 ~/.hermes/.env 里的 AGNES_API_KEY 提供。"
    )


def _request(url, payload=None, key=None, timeout=60):
    headers = {"User-Agent": "agnes-media-skill/1.0"}
    data = None
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise ApiError(e.code, body[:800])
    except urllib.error.URLError as e:
        raise ApiError(0, f"network error: {e.reason}")


def _post_with_retry(url, payload, key, timeout, retries=3, backoff=10):
    """创建任务，对 500/503（繁忙/队列满）带退避重试。"""
    last = None
    for i in range(retries):
        try:
            return _request(url, payload=payload, key=key, timeout=timeout)
        except ApiError as e:
            last = e
            if e.code in (500, 503) and i < retries - 1:
                time.sleep(backoff)
                continue
            raise
    raise last


def to_data_uri(path):
    p = Path(path)
    mime = MIME.get(p.suffix.lower())
    if not mime:
        raise SystemExit(f"ERROR: 不支持的图片格式 {p.suffix}: {path}")
    data = p.read_bytes()
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def resolve_image(v):
    v = normalize_path(v)
    if v.startswith(("http://", "https://", "data:")):
        return v
    if not Path(v).exists():
        raise SystemExit(f"ERROR: 图片文件不存在: {v}")
    return to_data_uri(v)


def download(url, dest_dir, filename):
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / filename
    req = urllib.request.Request(url, headers={"User-Agent": "agnes-media-skill/1.0"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return dest


def cmd_image(args):
    key = get_api_key(args.api_key)
    payload = {"model": IMAGE_MODEL, "prompt": args.prompt, "size": args.size}
    if args.ratio:
        payload["ratio"] = args.ratio

    images = [resolve_image(v) for v in (args.image or [])]
    if images:
        extra = {"image": images}
        extra["response_format"] = "b64_json" if args.format == "b64" else "url"
        payload["extra_body"] = extra
    else:
        if args.format == "b64":
            payload["return_base64"] = True
        else:
            payload["extra_body"] = {"response_format": "url"}

    resp = _post_with_retry(f"{BASE}/v1/images/generations", payload, key, timeout=360)
    item = (resp.get("data") or [{}])[0]
    out_dir = normalize_path(args.out) if args.out else str(Path.home() / "Downloads")
    stem = f"agnes_{time.strftime('%Y%m%d_%H%M%S')}"
    files = []

    if item.get("url"):
        dest = download(item["url"], out_dir, f"{stem}.png")
        files.append(str(dest))
    elif item.get("b64_json"):
        dest = Path(out_dir) / f"{stem}.png"
        Path(out_dir).mkdir(parents=True, exist_ok=True)
        dest.write_bytes(base64.b64decode(item["b64_json"]))
        files.append(str(dest))
    else:
        raise SystemExit(
            f"ERROR: 响应既无 url 也无 b64_json: {json.dumps(resp, ensure_ascii=False)[:500]}"
        )

    print(json.dumps(
        {"ok": True, "kind": "image", "model": IMAGE_MODEL, "size": args.size,
         "ratio": args.ratio or "1:1", "files": files},
        ensure_ascii=False))


def poll_video(vid, key, interval=5, timeout=600):
    url = f"{BASE}/agnesapi?video_id={vid}"
    deadline = time.time() + timeout
    last_status = "unknown"
    while time.time() < deadline:
        try:
            resp = _request(url, key=key, timeout=60)
        except ApiError as e:
            if e.code in (401, 403):
                raise SystemExit(f"ERROR: 查询任务失败 {e}")
            last_status = "poll_error"
            time.sleep(interval)
            continue
        status = resp.get("status")
        last_status = status or last_status
        if status == "completed":
            meta = resp.get("metadata") or {}
            # 文档写 metadata.url，但实测 url 与 size_mapping 都在顶层（无 metadata 包装），两者都兼容
            url = meta.get("url") or resp.get("url")
            return "completed", url, resp
        if status == "failed":
            return "failed", None, resp
        time.sleep(interval)
    return last_status, None, None


def cmd_video(args):
    key = get_api_key(args.api_key)
    payload = {
        "model": VIDEO_MODEL,
        "prompt": args.prompt,
        "width": args.width if args.width else 1152,
        "height": args.height if args.height else 768,
    }

    if args.keyframes:
        imgs = [resolve_image(v) for v in args.keyframes]
        payload["extra_body"] = {"image": imgs, "mode": "keyframes"}
    elif args.image:
        payload["image"] = resolve_image(args.image)

    fr = args.frame_rate if args.frame_rate else 24
    if args.num_frames:
        nf = args.num_frames
        if nf > 441 or (nf - 1) % 8 != 0:
            raise SystemExit(f"ERROR: num_frames={nf} 不合法（须 8n+1 且 ≤441）")
    elif args.duration:
        nf = round(args.duration * fr / 8) * 8 + 1
        nf = max(9, min(nf, 441))
    else:
        nf = 121  # 约 5 秒
    payload["num_frames"] = nf
    payload["frame_rate"] = fr

    if args.seed is not None:
        payload["seed"] = args.seed
    if args.negative_prompt:
        payload["negative_prompt"] = args.negative_prompt
    if args.num_inference_steps:
        payload["num_inference_steps"] = args.num_inference_steps

    resp = _post_with_retry(f"{BASE}/v1/videos", payload, key, timeout=120, retries=4, backoff=15)
    vid = resp.get("video_id") or resp.get("task_id") or resp.get("id")
    if not vid:
        raise SystemExit(
            f"ERROR: 创建任务响应缺少 video_id/task_id: {json.dumps(resp, ensure_ascii=False)[:500]}"
        )

    status, meta_url, final_resp = poll_video(vid, key)
    if status == "completed" and meta_url:
        out_dir = normalize_path(args.out) if args.out else str(Path.home() / "Downloads")
        dest = download(meta_url, out_dir, f"{vid}.mp4")
        print(json.dumps(
            {"ok": True, "kind": "video", "model": VIDEO_MODEL, "video_id": vid,
             "seconds": (final_resp or {}).get("seconds"),
             "size": (final_resp or {}).get("size"),
             "files": [str(dest)]},
            ensure_ascii=False))
    elif status == "failed":
        err = (final_resp or {}).get("error")
        raise SystemExit(f"ERROR: 视频任务失败: {json.dumps(err, ensure_ascii=False)[:500]}")
    else:
        raise SystemExit(
            f"ERROR: 轮询超时（600s），任务仍为 {status}。可用 video_id={vid} 稍后手动查询。"
        )


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--api-key", help="Agnes API key（可选，默认读环境变量/.env）")
    common.add_argument("--out", default=None, help="输出目录（默认 ~/Downloads）")

    p = argparse.ArgumentParser(description="Agnes AI 图像/视频生成")
    sub = p.add_subparsers(dest="command", required=True)

    im = sub.add_parser("image", parents=[common], help="生成图像（同步）")
    im.add_argument("--prompt", required=True)
    im.add_argument("--size", default="1K", help="尺寸档位 1K/2K/3K/4K（默认 1K）")
    im.add_argument("--ratio", default="1:1")
    im.add_argument("--image", action="append", help="图生图/多图合成输入（可多次）")
    im.add_argument("--format", choices=["url", "b64"], default="url")
    im.set_defaults(func=cmd_image)

    vd = sub.add_parser("video", parents=[common], help="生成视频（异步）")
    vd.add_argument("--prompt", required=True)
    vd.add_argument("--image", help="图生视频输入图（本地路径或 URL）")
    vd.add_argument("--keyframes", nargs="+", help="关键帧动画输入图（至少 2 个，空格分隔）")
    vd.add_argument("--duration", type=float, help="目标时长（秒）")
    vd.add_argument("--num-frames", type=int, help="手动指定帧数（8n+1 且 ≤441）")
    vd.add_argument("--frame-rate", type=int, default=24)
    vd.add_argument("--width", type=int, default=None)
    vd.add_argument("--height", type=int, default=None)
    vd.add_argument("--seed", type=int, default=None)
    vd.add_argument("--negative-prompt", default=None)
    vd.add_argument("--num-inference-steps", type=int, default=None)
    vd.set_defaults(func=cmd_video)
    return p


def main():
    try:
        args = build_parser().parse_args()
        if args.command == "video" and args.keyframes and len(args.keyframes) < 2:
            raise SystemExit("ERROR: 关键帧动画至少需要 2 张输入图（--keyframes）")
        args.func(args)
    except ApiError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
