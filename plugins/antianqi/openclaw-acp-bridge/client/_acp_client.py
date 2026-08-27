"""ACP HTTP client shipped with the openclaw-acp-bridge Plugin.

This is the **only** HTTP client used by the Plugin at runtime. Every
Skills' `from acp_client import ...` resolves to this file. It owns:

  - The token (read from $ACP_TOKEN or a plugin-bundled fallback path).
  - The HTTP opener (always `NoRedirectHandler`, never follows 3xx).
  - The base URL guard (loopback only; refuses non-loopback origins).
  - The terminal-state set for task polling.
  - The SSE stream iterator for `stream_task` / `run_and_stream`.

Why it lives inside the Plugin (not under `<ACP_HOME>/openclaw-skill/`):

  Earlier revisions of this Plugin imported `acp_tools` from a sibling
  repository (`antianqi/openclaw-mcode-acp`). Reviewers flagged that
  the runtime HTTP path was not under this Plugin's review: the smoke
  test verified the smoke test's own opener, not the opener the Skills
  actually used. By inlining a small, self-contained client here, the
  no-redirect guarantee, the loopback guard, and the token-handling
  rules are all under this Plugin's diff and tested by the bundled
  `scripts/smoke.py` + `scripts/test_no_redirect.py`.

  The Plugin still talks to the **same** server
  (`http://127.0.0.1:9999/acp/*`); only the client implementation
  moved. Server-side endpoint paths and request/response shapes are
  documented inline below and were cross-checked against
  `server/acp-server.py` in the upstream repository.

Standard library only. No third-party packages.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional
from urllib.parse import urlparse


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: The server's loopback base URL. The client refuses to talk to anything
#: not on this allow-list, because the bearer token would otherwise be
#: sent over the wire to a host the user did not explicitly opt into.
DEFAULT_BASE_URL = 'http://127.0.0.1:9999'

#: Hosts accepted by the loopback guard. Keep this narrow: a public DNS
#: resolver can return 127.0.0.1 for a name, so we only accept literal
#: loopback names, not "localhost" if the user is on a misconfigured
#: system that resolves localhost to a non-loopback address.
ALLOWED_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1', '[::1]'})

#: Terminal states for `create_task` (the worker pool's `succeeded` is
#: the success state; `completed` does not exist in the server protocol).
TERMINAL_STATES = frozenset({'succeeded', 'failed', 'timeout', 'cancelled'})

#: Default poll interval for `wait_task`.
DEFAULT_POLL_INTERVAL = 2.0

#: Default total timeout for `wait_task`.
DEFAULT_WAIT_TIMEOUT = 600.0


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class ACPError(Exception):
    r"""Raised on any non-2xx HTTP response from the ACP server.

    `status` is the HTTP status code; `body` is the parsed JSON body if
    the server returned JSON, or the raw text otherwise.
    """

    def __init__(self, status: int, body: Any, message: str = ''):
        self.status = status
        self.body = body
        super().__init__(message or f'ACP HTTP {status}: {body}')


class ACPTokenMissing(ACPError):
    """Raised when the bearer token cannot be located."""

    def __init__(self):
        super().__init__(
            0, None,
            'ACP token not found. Set $ACP_TOKEN (recommended) or write '
            'the token to ~/.acp_token (one line, no trailing newline) '
            'before calling any token-bearing endpoint.',
        )


# ---------------------------------------------------------------------------
# No-redirect opener (single primitive, hard-coded)
# ---------------------------------------------------------------------------

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse every 3xx response.

    Overrides `http_error_301` / `_302` / `_303` / `_307` / `_308` directly.
    The base class dispatches by method name (not via a generic
    `http_error_30x`), so each must be overridden individually. Any 3xx
    not explicitly listed would still hit the default HTTPRedirectHandler
    and follow the redirect; to make the policy fail-closed we also
    strip the default handler from the opener in `_build_opener`.
    """

    @staticmethod
    def _deny(req, fp, code, msg, headers):
        location = headers.get('Location', '?') if headers else '?'
        raise urllib.error.HTTPError(
            req.full_url,
            code,
            f'redirect refused by openclaw-acp-bridge: {code} -> {location}',
            headers,
            fp,
        )

    http_error_301 = _deny  # type: ignore[assignment]
    http_error_302 = _deny  # type: ignore[assignment]
    http_error_303 = _deny  # type: ignore[assignment]
    http_error_307 = _deny  # type: ignore[assignment]
    http_error_308 = _deny  # type: ignore[assignment]


def _build_opener() -> urllib.request.OpenerDirector:
    """Return an opener that never follows redirects.

    `urllib.request.build_opener` registers a default HTTPRedirectHandler
    in BOTH the legacy `opener.handlers` list AND the dispatch dict
    `opener.handle_error['http'][code]`. The dispatch dict is what
    actually routes 3xx responses to handlers; the `handlers` list is
    retained only for backward compatibility. To make our subclass win
    we have to remove the default from BOTH structures before
    registering our handler.
    """
    opener = urllib.request.build_opener()
    opener.handlers[:] = [
        h for h in opener.handlers
        if not isinstance(h, urllib.request.HTTPRedirectHandler)
    ]
    for protocol, by_code in list(opener.handle_error.items()):
        for code, lst in list(by_code.items()):
            by_code[code] = [
                h for h in lst
                if not isinstance(h, urllib.request.HTTPRedirectHandler)
            ]
    opener.add_handler(_NoRedirectHandler())
    return opener


# ---------------------------------------------------------------------------
# Token resolution
# ---------------------------------------------------------------------------

def _read_token_file(path: Path) -> Optional[str]:
    try:
        text = path.read_text(encoding='utf-8').strip()
    except OSError:
        return None
    return text or None


def _resolve_token() -> str:
    """Return the bearer token for the loopback ACP server.

    Resolution order (first hit wins):
      1. `$ACP_TOKEN` (recommended for CI and shells).
      2. `~/.acp_token` (one line, no trailing newline; user-mode convenience).
      3. `<plugin_root>/.acp_token` (one line; co-located fallback so a
         freshly-unpacked Plugin can run without further setup when the
         user has dropped a token next to it).

    Raises `ACPTokenMissing` if none of the above is set.
    """
    env = os.environ.get('ACP_TOKEN', '').strip()
    if env:
        return env
    home = _read_token_file(Path.home() / '.acp_token')
    if home:
        return home
    # Fall back to a token file co-located with this module's parent.
    # `_acp_client.py` lives in `<plugin>/client/`, so the plugin root
    # is the parent of that.
    plugin_root = Path(__file__).resolve().parent.parent
    bundled = _read_token_file(plugin_root / '.acp_token')
    if bundled:
        return bundled
    raise ACPTokenMissing()


# ---------------------------------------------------------------------------
# HTTP core
# ---------------------------------------------------------------------------

def _check_loopback(base_url: str) -> None:
    """Refuse to talk to anything not on the loopback allow-list.

    The token would be sent to this base URL on every authenticated
    request. A misconfigured `ACP_BASE_URL` (or a DNS rebinding) could
    otherwise exfiltrate the token to a remote host.
    """
    parsed = urlparse(base_url)
    if parsed.scheme != 'http' or parsed.hostname not in ALLOWED_HOSTS:
        raise ACPError(
            0, None,
            f'ACP_BASE_URL must be a loopback http URL on one of '
            f'{sorted(ALLOWED_HOSTS)}; got {base_url!r}. Refusing to send '
            f'the bearer token to a non-loopback host.',
        )


def _request(
    method: str,
    path: str,
    body: Optional[dict] = None,
    *,
    base_url: Optional[str] = None,
    token: Optional[str] = None,
    auth: bool = True,
    stream: bool = False,
    timeout: Optional[float] = None,
) -> urllib.request.addinfourl:
    """Issue a single HTTP request, returning the raw response object.

    Adds the bearer header (when `auth=True`), JSON-encodes the body, and
    uses the no-redirect opener. The caller is responsible for `.read()`
    / iteration / `.status` / `.headers` etc.

    `base_url` resolution order (first hit wins):
      1. the explicit `base_url` argument
      2. `$ACP_BASE_URL` (lets callers point the client at a non-default
         server without re-implementing the public functions)
      3. `DEFAULT_BASE_URL = 'http://127.0.0.1:9999'`

    `stream=True` disables the read timeout (used for SSE). `stream=False`
    defaults to a 30s timeout.

    `auth=True` (the default for every endpoint except health): the bearer
    token is added to the request and `_resolve_token()` is consulted
    when no token is given. `auth=False` skips both. The loopback guard
    and no-redirect opener apply regardless of `auth`.
    """
    if base_url is None:
        base_url = os.environ.get('ACP_BASE_URL') or DEFAULT_BASE_URL
    _check_loopback(base_url)
    url = f'{base_url.rstrip("/")}{path}'
    headers = {}
    data: Optional[bytes] = None
    if auth:
        if token is None:
            token = _resolve_token()
        headers['Authorization'] = f'Bearer {token}'
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    if timeout is None:
        timeout = None if stream else 30.0
    return _OPENER.open(req, timeout=timeout)


def _json(resp: urllib.request.addinfourl) -> Any:
    """Read a response and parse it as JSON, closing the response."""
    try:
        return json.loads(resp.read().decode('utf-8'))
    finally:
        resp.close()


# Module-level opener; the no-redirect policy is global to the client.
_OPENER = _build_opener()


# ---------------------------------------------------------------------------
# Health (no auth)
# ---------------------------------------------------------------------------

def health(base_url: str = DEFAULT_BASE_URL) -> dict:
    """GET /acp/health (no auth required, but the rest of the security
    boundary still applies).

    Health is the only endpoint that does not require a bearer token
    (the server's `/acp/health` handler is anonymous). However, the
    loopback guard and the no-redirect opener still apply: routing
    health through the same `_request` primitive used by every other
    public function means a misconfigured `ACP_BASE_URL` cannot be
    used to probe a non-loopback host, and a 302 on the health
    endpoint is surfaced as an error rather than silently followed.
    This was the round-4 finding: the previous implementation called
    `urllib.request.urlopen` directly and bypassed both checks.
    """
    try:
        resp = _request('GET', '/acp/health', base_url=base_url, auth=False, timeout=10.0)
        return _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None


def _read_err_body(e: urllib.error.HTTPError) -> Any:
    try:
        body = e.read().decode('utf-8', errors='replace')
    except Exception:
        return None
    try:
        return json.loads(body)
    except Exception:
        return body


# ---------------------------------------------------------------------------
# Task endpoints
# ---------------------------------------------------------------------------

def create_task(
    prompt: str,
    workspace: str,
    files: Optional[List[str]] = None,
    timeout: str = '5m',
) -> str:
    """POST /acp/task/create. Returns `task_id` (a string)."""
    body: Dict[str, Any] = {'prompt': prompt, 'workspace': workspace, 'timeout': timeout}
    if files:
        body['files'] = files
    try:
        resp = _request('POST', '/acp/task/create', body=body)
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    task_id = data.get('task_id')
    if not isinstance(task_id, str):
        raise ACPError(0, data, f'/acp/task/create returned no task_id: {data!r}')
    return task_id


def get_task(task_id: str) -> dict:
    """GET /acp/task/get?id=<task_id>. Returns the task dict."""
    qs = urllib.parse.urlencode({'id': task_id})
    try:
        resp = _request('GET', f'/acp/task/get?{qs}')
        return _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None


def list_tasks(limit: int = 50) -> list:
    """GET /acp/task/list. Returns a list of task dicts (in-memory cache)."""
    qs = urllib.parse.urlencode({'limit': limit})
    try:
        resp = _request('GET', f'/acp/task/list?{qs}')
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    # The server returns either a list directly or {"tasks": [...]}; accept
    # both shapes defensively.
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get('tasks'), list):
        return data['tasks']
    raise ACPError(0, data, f'/acp/task/list returned unexpected shape: {data!r}')


def history(
    status: Optional[str] = None,
    workspace: Optional[str] = None,
    limit: Optional[int] = None,
    since: Optional[str] = None,
) -> list:
    """GET /acp/task/history. Returns a list of task dicts (SQLite-backed).

    Note: the server returns a list directly, not `{"tasks": [...]}`.
    """
    params: Dict[str, Any] = {}
    if status is not None:
        params['status'] = status
    if workspace is not None:
        params['workspace'] = workspace
    if limit is not None:
        params['limit'] = limit
    if since is not None:
        params['since'] = since
    qs = urllib.parse.urlencode(params)
    try:
        resp = _request('GET', f'/acp/task/history?{qs}')
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get('tasks'), list):
        return data['tasks']
    raise ACPError(0, data, f'/acp/task/history returned unexpected shape: {data!r}')


def stats() -> dict:
    """GET /acp/task/stats. Returns a queue + DB summary dict."""
    try:
        resp = _request('GET', '/acp/task/stats')
        return _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None


def cancel_task(task_id: str) -> dict:
    """POST /acp/task/cancel. Returns the updated task dict."""
    try:
        resp = _request('POST', '/acp/task/cancel', body={'task_id': task_id})
        return _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None


def wait_task(
    task_id: str,
    timeout: float = DEFAULT_WAIT_TIMEOUT,
    poll_interval: float = DEFAULT_POLL_INTERVAL,
) -> dict:
    """Poll `get_task` until a terminal state is reached. Returns the final task dict."""
    deadline = time.monotonic() + timeout
    while True:
        state = get_task(task_id)
        status = state.get('status')
        if status in TERMINAL_STATES:
            return state
        if time.monotonic() >= deadline:
            raise ACPError(
                0, state,
                f'wait_task timed out after {timeout}s; last status={status!r}',
            )
        time.sleep(poll_interval)


def stream_task(
    task_id: str,
    on_event: Optional[Callable[[str, dict], None]] = None,
) -> Iterator[Dict[str, Any]]:
    """GET /acp/task/stream?id=<task_id> (SSE). Yields `{type, data}` dicts.

    If `on_event` is given, it is invoked for each event in addition to
    (or instead of) yielding. The iterator terminates when the server
    closes the stream.
    """
    qs = urllib.parse.urlencode({'id': task_id})
    resp = _request('GET', f'/acp/task/stream?{qs}', stream=True)
    try:
        event_name = 'message'
        data_buf: List[str] = []
        while True:
            line_bytes = resp.readline()
            if not line_bytes:
                break
            line = line_bytes.decode('utf-8', errors='replace').rstrip('\r\n')
            if not line:
                # Blank line: dispatch the buffered event.
                if data_buf:
                    raw = '\n'.join(data_buf)
                    try:
                        data = json.loads(raw)
                    except Exception:
                        data = {'raw': raw}
                    evt: Dict[str, Any] = {'type': event_name, 'data': data}
                    if on_event is not None:
                        on_event(event_name, data)
                    yield evt
                event_name = 'message'
                data_buf = []
                continue
            if line.startswith('event:'):
                event_name = line[len('event:'):].strip() or 'message'
            elif line.startswith('data:'):
                data_buf.append(line[len('data:'):].lstrip())
            # ignore comments (lines starting with ':') and other fields
    finally:
        resp.close()


def run_and_stream(
    prompt: str,
    workspace: str,
    files: Optional[List[str]] = None,
    timeout: str = '5m',
    on_event: Optional[Callable[[str, dict], None]] = None,
) -> dict:
    """Convenience: create + stream + return the final task dict."""
    task_id = create_task(prompt=prompt, workspace=workspace, files=files, timeout=timeout)
    last_evt: Dict[str, Any] = {}
    for evt in stream_task(task_id, on_event=on_event):
        last_evt = evt
    return get_task(task_id)


# ---------------------------------------------------------------------------
# Inbox endpoints
# ---------------------------------------------------------------------------

def inbox_write(
    session_id: str,
    content: str,
    sender: str = 'goudan',
    msg_type: str = 'progress',
    parent_id: Optional[int] = None,
) -> int:
    """POST /acp/inbox/write. Returns the new `message_id` (int)."""
    body: Dict[str, Any] = {
        'session_id': session_id,
        'sender': sender,
        'content': content,
        'msg_type': msg_type,
    }
    if parent_id is not None:
        body['parent_id'] = parent_id
    try:
        resp = _request('POST', '/acp/inbox/write', body=body)
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    msg_id = data.get('message_id')
    if not isinstance(msg_id, int):
        raise ACPError(0, data, f'/acp/inbox/write returned no message_id: {data!r}')
    return msg_id


def inbox_read(
    session_id: str,
    since_id: int = 0,
    sender: Optional[str] = None,
    msg_type: Optional[str] = None,
    limit: Optional[int] = None,
) -> list:
    """GET /acp/inbox/read. Returns a **list** of message dicts.

    Note: the server returns a list directly, not a `{"messages": [...]}`
    mapping. Messages with `id <= since_id` are filtered out by the
    server. The server also auto-marks returned messages as read.
    """
    params: Dict[str, Any] = {'session_id': session_id, 'since_id': since_id}
    if sender is not None:
        params['sender'] = sender
    if msg_type is not None:
        params['msg_type'] = msg_type
    if limit is not None:
        params['limit'] = limit
    qs = urllib.parse.urlencode(params)
    try:
        resp = _request('GET', f'/acp/inbox/read?{qs}')
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get('messages'), list):
        return data['messages']
    raise ACPError(0, data, f'/acp/inbox/read returned unexpected shape: {data!r}')


def inbox_ask(
    session_id: str,
    question: str,
    sender: str = 'mavis',
    timeout: int = 300,
) -> dict:
    """POST /acp/inbox/ask. Blocks until the peer answers (server-side).

    Returns `{"question_id": int, "answer": str}` on success, or
    `{"question_id": int, "error": "timeout"}` on timeout.
    """
    body = {
        'session_id': session_id,
        'sender': sender,
        'question': question,
        'timeout': timeout,
    }
    try:
        resp = _request('POST', '/acp/inbox/ask', body=body, timeout=float(timeout) + 30)
        return _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None


def inbox_answer(question_id: int, answer: str) -> int:
    """POST /acp/inbox/answer. Returns the new `answer_id` (int)."""
    try:
        resp = _request('POST', '/acp/inbox/answer', body={
            'question_id': question_id, 'answer': answer,
        })
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    ans_id = data.get('answer_id')
    if not isinstance(ans_id, int):
        raise ACPError(0, data, f'/acp/inbox/answer returned no answer_id: {data!r}')
    return ans_id


def inbox_sessions(limit: int = 20) -> list:
    """GET /acp/inbox/sessions. Returns a list of session summaries."""
    qs = urllib.parse.urlencode({'limit': limit})
    try:
        resp = _request('GET', f'/acp/inbox/sessions?{qs}')
        data = _json(resp)
    except urllib.error.HTTPError as e:
        raise ACPError(e.code, _read_err_body(e)) from None
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get('sessions'), list):
        return data['sessions']
    raise ACPError(0, data, f'/acp/inbox/sessions returned unexpected shape: {data!r}')


# ---------------------------------------------------------------------------
# Peer helpers (client-side; do not call the server)
# ---------------------------------------------------------------------------

def peer_session_id(prefix: str = 'session') -> str:
    """Generate a session id like `session-20260814-084530` (local only)."""
    return time.strftime(f'{prefix}-%Y%m%d-%H%M%S')


def peer_greet(session_id: str, message: str) -> int:
    """Goudan-side helper: send the opening message with `sender='goudan'`.

    **Do not call this from a mavis session.** It is hard-coded to post
    under `sender='goudan'`, so a mavis-side call would attribute the
    message to the wrong peer. From mavis, use
    `inbox_write(session_id, message, sender='mavis')` directly.
    """
    return inbox_write(session_id, message, sender='goudan')
