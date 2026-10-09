"""Remote human-in-the-loop assist for SSO/CAPTCHA verification.

When a browser session encounters SSO login or CAPTCHA that requires human
intervention, this module starts a lightweight HTTP server so the user can
monitor progress and signal completion from any device (phone, tablet, etc.).

Usage pattern:
    assist = RemoteAssist(config, publisher="elsevier")
    assist.start()
    # ... browser navigates to SSO page ...
    assist.wait_for_user(timeout=300)  # blocks until user signals done
    assist.stop()
"""

from __future__ import annotations

import json
import socket
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

from .log import get_logger

log = get_logger()

# HTML template for the remote assist page
_PAGE_TEMPLATE = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ScanSci-PDF Remote Assist</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #c9d1d9;
         display: flex; flex-direction: column; align-items: center; min-height: 100vh; padding: 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px;
          max-width: 480px; width: 100%; margin-top: 20px; }
  h1 { font-size: 20px; color: #58a6ff; margin-bottom: 8px; }
  .publisher { font-size: 14px; color: #8b949e; margin-bottom: 16px; }
  .status { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  .status.waiting { background: #1c1f26; border: 1px solid #d29922; color: #d29922; }
  .status.done { background: #1c1f26; border: 1px solid #3fb950; color: #3fb950; }
  .status.timeout { background: #1c1f26; border: 1px solid #f85149; color: #f85149; }
  .instructions { font-size: 13px; color: #8b949e; line-height: 1.6; margin-bottom: 16px; }
  .instructions li { margin-bottom: 6px; }
  .btn { display: block; width: 100%; padding: 14px; border: none; border-radius: 8px;
         font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary { background: #238636; color: #fff; }
  .btn-primary:hover { background: #2ea043; }
  .btn-primary:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  .url-box { background: #0d1117; border: 1px solid #30363d; border-radius: 6px;
             padding: 8px 12px; font-size: 12px; color: #58a6ff; word-break: break-all;
             margin-bottom: 16px; }
  .timer { font-size: 12px; color: #484f58; text-align: center; margin-top: 12px; }
</style>
</head>
<body>
<div class="card">
  <h1>🔐 Remote Assist</h1>
  <div class="publisher">{publisher}</div>
  <div class="status {status_class}" id="status">{status_text}</div>
  <div class="instructions">
    <ol>
      <li>Complete the login/verification in the browser window on the host machine</li>
      <li>After verification is done, click the button below</li>
    </ol>
  </div>
  <div class="url-box">{browser_url}</div>
  <button class="btn btn-primary" id="doneBtn" onclick="signalDone()">
    ✅ Verification Complete — Continue
  </button>
  <div class="timer" id="timer"></div>
</div>
<script>
  let done = false;
  async function signalDone() {
    if (done) return;
    done = true;
    document.getElementById('doneBtn').disabled = true;
    document.getElementById('doneBtn').textContent = '⏳ Continuing...';
    await fetch('/api/done', {method: 'POST'});
    document.getElementById('status').className = 'status done';
    document.getElementById('status').textContent = '✅ Done! Resuming...';
  }
  // Auto-check status
  setInterval(async () => {
    if (done) return;
    try {
      const r = await fetch('/api/status');
      const j = await r.json();
      if (j.completed) signalDone();
      if (j.url) document.querySelector('.url-box').textContent = j.url;
      document.getElementById('timer').textContent = 'Elapsed: ' + j.elapsed + 's / ' + j.timeout + 's';
    } catch(e) {}
  }, 2000);
</script>
</body>
</html>"""


class _RequestHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the remote assist server."""

    # Shared state across requests (set by RemoteAssist)
    _state: dict[str, Any] = {}

    def log_message(self, format, *args):
        """Suppress default HTTP logging."""
        pass

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            self._serve_page()
        elif self.path == "/api/status":
            self._serve_status()
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path == "/api/done":
            self._handle_done()
        else:
            self.send_error(404)

    def _serve_page(self):
        state = self._state
        status_class = "done" if state.get("completed") else "waiting"
        status_text = "✅ Verification complete!" if state.get("completed") else "⏳ Waiting for verification..."
        html = _PAGE_TEMPLATE.format(
            publisher=state.get("publisher", "Unknown"),
            status_class=status_class,
            status_text=status_text,
            browser_url=state.get("browser_url", ""),
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode())

    def _serve_status(self):
        state = self._state
        elapsed = int(time.time() - state.get("started_at", time.time()))
        data = {
            "completed": state.get("completed", False),
            "url": state.get("browser_url", ""),
            "elapsed": elapsed,
            "timeout": state.get("timeout", 300),
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _handle_done(self):
        self._state["completed"] = True
        event = self._state.get("done_event")
        if event:
            event.set()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def _find_free_port() -> int:
    """Find a free TCP port on localhost."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RemoteAssist:
    """Remote human-in-the-loop assist server.

    Starts an HTTP server that the user can access from any device to:
    - See the current verification status
    - Signal that verification is complete

    Example:
        assist = RemoteAssist(config, publisher="elsevier")
        assist.start()
        # ... browser navigates to SSO ...
        assist.update_url(page.url)
        if assist.wait_for_user(timeout=300):
            print("User completed verification!")
        assist.stop()
    """

    def __init__(self, config: dict[str, Any], publisher: str = ""):
        self._config = config
        self._publisher = publisher
        self._port = int(config.get("remote_assist_port", 0)) or _find_free_port()
        self._server: HTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._done_event = threading.Event()
        self._started_at = time.time()
        self._state: dict[str, Any] = {
            "publisher": publisher,
            "completed": False,
            "browser_url": "",
            "started_at": self._started_at,
            "timeout": 300,
            "done_event": self._done_event,
        }

    @property
    def port(self) -> int:
        return self._port

    @property
    def url(self) -> str:
        return f"http://localhost:{self._port}"

    @property
    def lan_url(self) -> str:
        """Get the LAN-accessible URL (for phone/tablet access)."""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return f"http://{ip}:{self._port}"
        except Exception:
            return self.url

    def start(self) -> str:
        """Start the remote assist server. Returns the access URL."""
        _RequestHandler._state = self._state
        self._server = HTTPServer(("0.0.0.0", self._port), _RequestHandler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        lan = self.lan_url
        log.info(f"   [RemoteAssist] Server started: {lan}")
        return lan

    def update_url(self, browser_url: str) -> None:
        """Update the displayed browser URL."""
        self._state["browser_url"] = browser_url

    def update_publisher(self, publisher: str) -> None:
        """Update the displayed publisher name."""
        self._state["publisher"] = publisher

    def wait_for_user(self, timeout: int = 300) -> bool:
        """Block until user signals completion or timeout.

        Returns True if user completed, False on timeout.
        """
        self._state["timeout"] = timeout
        lan = self.lan_url
        log.info(f"   [RemoteAssist] Waiting for user at {lan} (timeout={timeout}s)")
        print(f"\n{'='*60}")
        print(f"  🔐 Remote Assist: Complete verification from any device")
        print(f"  📱 Open this URL: {lan}")
        print(f"  ⏱  Timeout: {timeout}s")
        print(f"{'='*60}\n")
        completed = self._done_event.wait(timeout=timeout)
        if completed:
            log.info("   [RemoteAssist] User signaled completion")
        else:
            log.info("   [RemoteAssist] Timed out waiting for user")
        return completed

    def stop(self) -> None:
        """Stop the remote assist server."""
        if self._server:
            self._server.shutdown()
            self._server = None
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
        log.info("   [RemoteAssist] Server stopped")
