"""Token handling on the two local control surfaces.

The bearer token must never be readable by page scripts or third-party CDNs,
must not be written to logs, and must stop working once it has expired.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
import urllib.error
import urllib.request

import pytest


@pytest.fixture
def assist():
    from scansci_pdf import remote_assist as ra

    instance = ra.RemoteAssist({}, publisher="elsevier")
    instance.start()
    try:
        yield instance
    finally:
        instance.stop()


def _get(assist, path, token=None, headers=None):
    url = f"http://{assist.bound_host}:{assist.port}{path}"
    if token:
        url += ("&" if "?" in url else "?") + f"t={token}"
    request = urllib.request.Request(url, headers=headers or {})
    return urllib.request.urlopen(request, timeout=5)


def test_assist_page_sets_a_csp_that_blocks_external_scripts(assist):
    with _get(assist, "/", assist.token) as response:
        assert "Content-Security-Policy" in response.headers
        policy = response.headers["Content-Security-Policy"]
    # The token lives in this page's inline script, so no external script may
    # be permitted to run alongside it.
    assert "frame-ancestors 'none'" in policy
    assert "default-src 'none'" in policy
    assert "cdn." not in policy


def test_expired_token_is_refused_even_though_it_matches(assist):
    # Force expiry rather than sleeping: the rule under test is that a stale
    # token stops authorising a state change, not that it becomes unreadable.
    assist._state["token_expires_at"] = time.time() - 1
    with pytest.raises(urllib.error.HTTPError) as caught:
        _get(assist, "/api/status", assist.token)
    assert caught.value.code == 401


def test_token_is_not_written_to_the_start_log(assist, caplog):
    # start() already ran in the fixture; assert on the property that matters:
    # no log line the module emits contains the token.
    import logging

    from scansci_pdf import remote_assist as ra

    with caplog.at_level(logging.INFO, logger=ra.log.name):
        instance = ra.RemoteAssist({}, publisher="elsevier")
        instance.start()
        try:
            assert instance.token
            assert not any(instance.token in record.getMessage() for record in caplog.records)
        finally:
            instance.stop()


def test_web_page_never_renders_the_token_and_sets_a_csp(monkeypatch):
    from fastapi.testclient import TestClient

    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, "unit-test-token-value")
    client = TestClient(web.app)

    response = client.get("/", params={"t": "unit-test-token-value"})
    assert response.status_code == 200
    body = response.text
    assert "unit-test-token-value" not in body, "token must not be readable by page JS"
    assert "cdn.tailwindcss.com" not in body
    assert "cdn.jsdelivr.net" not in body
    policy = response.headers["Content-Security-Policy"]
    assert "Content-Security-Policy" in response.headers
    assert "cdn." not in policy
    assert "https://" not in policy
    assert "'unsafe-inline'" not in policy.split("script-src", 1)[-1].split(";", 1)[0]
    nonce = policy.split("script-src 'nonce-", 1)[1].split("'", 1)[0]
    assert f'nonce="{nonce}"' in body
    assert response.headers["Referrer-Policy"] == "no-referrer"
    # ...and it is handed over as an HttpOnly cookie instead.
    cookies = response.headers.get_list("set-cookie")
    assert any("HttpOnly" in value and "scansci_token" in value for value in cookies)


def test_web_cookie_authenticates_subsequent_api_calls(monkeypatch):
    from fastapi.testclient import TestClient

    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, "unit-test-token-value")
    client = TestClient(web.app)
    client.get("/", params={"t": "unit-test-token-value"})

    # The cookie alone must authorize a request with no query string.
    response = client.get("/api/status")
    assert response.status_code == 200
    assert response.headers["Content-Security-Policy"]


def test_interactive_docs_are_not_exposed():
    from scansci_pdf import web

    # An authenticated surface should not publish its route schema.
    assert web.app.docs_url is None
    assert web.app.redoc_url is None
    assert web.app.openapi_url is None

# ---------------------------------------------------------------------------
# D64-12: both Web startup entries must be the SAME secure startup.
#
# The logs are inspected on a REAL local server started with the very
# arguments each entry point hands to uvicorn, so the assertion is about what
# the deployed entry actually records — not about what the code appears to set.
# ---------------------------------------------------------------------------

SYNTHETIC_WEB_TOKEN = "SYNTHETIC-ROUND3-WEB-TOKEN"


class _CapturedLogs(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record):
        self.records.append(record)

    def text(self) -> str:
        return "\n".join(
            f"{r.name}:{r.levelname}:{r.getMessage()}" for r in self.records)


@contextlib.contextmanager
def _captured_logging():
    handler = _CapturedLogs()
    loggers = [logging.getLogger(name)
               for name in ("uvicorn.access", "uvicorn.error", "scansci_pdf")]
    for logger in loggers:
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        for logger in loggers:
            logger.removeHandler(handler)


@contextlib.contextmanager
def _real_server(**options):
    """A real uvicorn server on an ephemeral port."""
    import uvicorn

    settings = dict(options)
    settings["port"] = 0
    settings.setdefault("log_config", None)
    config = uvicorn.Config(uvicorn_app(), **settings)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.time() + 30
        while not server.started and time.time() < deadline:
            if not thread.is_alive():
                raise RuntimeError("uvicorn server died during startup")
            time.sleep(0.05)
        assert server.started, "uvicorn did not start in time"
        port = server.servers[0].sockets[0].getsockname()[1]
        yield server, port
    finally:
        server.should_exit = True
        thread.join(30)


def uvicorn_app():
    from scansci_pdf import web

    return web.app


def _http(url, headers=None, method="GET", data=None):
    request = urllib.request.Request(url, headers=headers or {}, method=method, data=data)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def _first_access_token_entry(monkeypatch):
    """Arguments `scansci-pdf web` hands to uvicorn."""
    import uvicorn

    from scansci_pdf import main as cli_main

    captured = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: captured.update(app=app, kwargs=kw))
    cli_main.web_server(host="127.0.0.1", port=8080)
    return captured


def _run_mode_web_entry(monkeypatch):
    """Arguments `scansci-pdf run --mode web` hands to uvicorn."""
    import uvicorn

    from scansci_pdf import deps, main as cli_main

    monkeypatch.setattr(deps, "print_status", lambda: None)
    captured = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: captured.update(app=app, kwargs=kw))
    # Same host/port as the standalone entry: only the PATH may differ.
    cli_main.run_server(mode=cli_main.ServerMode.WEB, host="127.0.0.1", port=8080)
    return captured


def test_both_web_entries_hand_uvicorn_the_same_secure_settings(monkeypatch):
    standalone = _first_access_token_entry(monkeypatch)
    via_run = _run_mode_web_entry(monkeypatch)

    assert standalone["app"] is via_run["app"]
    assert standalone["kwargs"] == via_run["kwargs"]
    assert standalone["kwargs"]["access_log"] is False


def test_neither_web_entry_writes_the_token_to_its_logs():
    from scansci_pdf import web

    for name, entry in (("web", _first_access_token_entry),
                        ("run --mode web", _run_mode_web_entry)):
        patcher = pytest.MonkeyPatch()
        try:
            patcher.setenv(web.TOKEN_ENV, SYNTHETIC_WEB_TOKEN)
            options = dict(entry(patcher)["kwargs"])

            with _captured_logging() as captured, _real_server(**options) as (_server, port):
                status, headers, _body = _http(
                    f"http://127.0.0.1:{port}/?t={SYNTHETIC_WEB_TOKEN}")
                assert status == 200, name

                # The token still works afterwards, via the HttpOnly cookie.
                cookie = [v for v in headers.get_all("set-cookie") if "scansci_token" in v]
                assert cookie and "HttpOnly" in cookie[0], name
                jar = cookie[0].split(";")[0]
                status, _headers, body = _http(f"http://127.0.0.1:{port}/api/status",
                                               {"Cookie": jar})
                assert status == 200 and b'"status":"ok"' in body, name

                # Anonymous and invalid-token writes are still refused.
                status, _h, _b = _http(f"http://127.0.0.1:{port}/api/download", method="POST",
                                       data=b'{"identifier": "10.1234/abcd"}')
                assert status in (401, 403), name
                status, _h, _b = _http(
                    f"http://127.0.0.1:{port}/api/download", {"X-ScanSci-Token": "wrong"},
                    method="POST", data=b'{"identifier": "10.1234/abcd"}')
                assert status == 401, name
        finally:
            patcher.undo()

        logs = captured.text()
        assert SYNTHETIC_WEB_TOKEN not in logs, f"{name} wrote the token to a log:\n{logs}"


def test_the_log_check_can_actually_detect_the_token(monkeypatch):
    """Control for the assertion above: with the access log enabled, the very
    same request DOES put the token in a log — so a silent pass is a real pass."""
    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, SYNTHETIC_WEB_TOKEN)

    with _captured_logging() as captured, _real_server(access_log=True) as (_server, port):
        status, _headers, _body = _http(f"http://127.0.0.1:{port}/?t={SYNTHETIC_WEB_TOKEN}")
        assert status == 200

    assert SYNTHETIC_WEB_TOKEN in captured.text()


def test_error_logging_stays_diagnosable(monkeypatch):
    """Disabling the access log must not silence the application's own errors."""
    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, SYNTHETIC_WEB_TOKEN)
    options = dict(_first_access_token_entry(monkeypatch)["kwargs"])

    with _captured_logging() as captured, _real_server(**options) as (_server, port):
        status, _headers, _body = _http(f"http://127.0.0.1:{port}/?t=wrong-token")
        assert status == 401

        status, _headers, _body = _http(f"http://127.0.0.1:{port}/api/status")
        assert status == 401

    assert captured.records, "server logging must still produce records"