"""Token handling on the two local control surfaces.

The bearer token must never be readable by page scripts or third-party CDNs,
must not be written to logs, and must stop working once it has expired.
"""

from __future__ import annotations

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
    assert "Content-Security-Policy" in response.headers
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