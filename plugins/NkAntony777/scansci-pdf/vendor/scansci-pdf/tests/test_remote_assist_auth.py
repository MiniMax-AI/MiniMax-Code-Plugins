"""RemoteAssist must stay loopback-bound and token-authenticated (merge-blocking findings 1 and 3)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

import pytest

from scansci_pdf.remote_assist import RemoteAssist


def _request(url: str, *, method: str = "GET", headers: dict[str, str] | None = None):
    """Return (status, body) without raising on 4xx/5xx."""
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


@pytest.fixture
def assist():
    server = RemoteAssist({}, publisher="elsevier")
    server.start()
    yield server
    server.stop()


def _base(assist: RemoteAssist) -> str:
    return f"http://{assist.bound_host}:{assist.port}"


def _auth(assist: RemoteAssist) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {assist.token}",
        "X-Requested-With": "XMLHttpRequest",
    }


def test_binds_loopback_by_default(assist):
    assert assist.bound_host == "127.0.0.1"
    assert assist._server.server_address[0] == "127.0.0.1"
    assert "127.0.0.1" in assist.lan_url


def test_lan_requires_config_opt_in_and_caller_confirmation():
    assert RemoteAssist({"remote_assist_lan": True})._host == "127.0.0.1"
    assert RemoteAssist({}, allow_lan=True)._host == "127.0.0.1"
    both = RemoteAssist({"remote_assist_lan": True, "remote_assist_host": "0.0.0.0"}, allow_lan=True)
    assert both._host == "0.0.0.0"


def test_token_is_random_per_instance():
    assert RemoteAssist({}).token != RemoteAssist({}).token


def test_unauthenticated_requests_are_rejected(assist):
    base = _base(assist)
    status_page, _ = _request(f"{base}/")
    status_api, _ = _request(f"{base}/api/status")
    done_api, _ = _request(f"{base}/api/done", method="POST")
    assert status_page != 200
    assert status_api != 200
    assert done_api != 200
    assert not assist._done_event.is_set()


def test_wrong_token_is_rejected(assist):
    status, _ = _request(f"{_base(assist)}/api/status", headers={"Authorization": "Bearer nope"})
    assert status == 401


def test_valid_token_serves_status_and_signals_done(assist):
    base = _base(assist)
    status, body = _request(f"{base}/api/status", headers=_auth(assist))
    assert status == 200
    assert json.loads(body)["completed"] is False

    status, body = _request(f"{base}/api/done", method="POST", headers=_auth(assist))
    assert status == 200
    assert json.loads(body)["ok"] is True
    assert assist._done_event.is_set()
    assert assist._state["completed"] is True


def test_printed_url_token_authenticates_the_page(assist):
    status, body = _request(assist.url)
    assert status == 200
    assert assist.token in body


def test_cross_origin_post_without_csrf_header_is_rejected(assist):
    headers = {"Authorization": f"Bearer {assist.token}"}
    status, _ = _request(f"{_base(assist)}/api/done", method="POST", headers=headers)
    assert status == 403
    assert not assist._done_event.is_set()


def test_dynamic_values_are_escaped_in_served_page(assist):
    assist.update_publisher("<script>alert('p')</script>")
    assist.update_url("https://example.com/?a=<img src=x onerror=alert(1)>")
    status, body = _request(assist.url)
    assert status == 200
    assert "<script>alert('p')</script>" not in body
    assert "<img src=x onerror=alert(1)>" not in body
    assert "&lt;script&gt;alert(&#x27;p&#x27;)&lt;/script&gt;" in body
    assert "&lt;img src=x onerror=alert(1)&gt;" in body