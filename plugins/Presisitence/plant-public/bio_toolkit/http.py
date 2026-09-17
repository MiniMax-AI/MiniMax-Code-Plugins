"""共享 HTTP 工具层：统一超时、重试、错误处理与 User-Agent。

所有对外 API 请求都经过这里，保证行为一致、可复现。
"""
from __future__ import annotations

import time
from typing import Any

import httpx

# 礼貌性 User-Agent：部分数据库要求标识来源
USER_AGENT = "plant-public-mcp/0.1 (plant disease resistance research; contact: researcher)"

DEFAULT_TIMEOUT = 30.0
MAX_RETRIES = 3
RETRY_BACKOFF = 2.0  # 秒，指数退避基数


class BioHTTPError(RuntimeError):
    """统一的对外请求异常。"""


def _client(timeout: float, follow_redirects: bool = True) -> httpx.Client:
    return httpx.Client(
        timeout=timeout,
        follow_redirects=follow_redirects,
        headers={"User-Agent": USER_AGENT},
    )


def get(
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    accept: str | None = None,
) -> httpx.Response:
    """带重试的 GET。对 429/5xx 自动退避重试。"""
    h = dict(headers or {})
    if accept:
        h["Accept"] = accept
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with _client(timeout) as c:
                resp = c.get(url, params=params, headers=h)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise BioHTTPError(f"HTTP {resp.status_code} from {url}")
            resp.raise_for_status()
            return resp
        except (httpx.HTTPError, BioHTTPError) as exc:  # noqa: PERF203
            last_exc = exc
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
            else:
                raise BioHTTPError(f"GET failed after {MAX_RETRIES} tries: {url} -> {exc}") from exc
    raise BioHTTPError(str(last_exc))  # pragma: no cover


def post(
    url: str,
    *,
    data: dict[str, Any] | None = None,
    json: Any | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    accept: str | None = None,
) -> httpx.Response:
    """带重试的 POST。"""
    h = dict(headers or {})
    if accept:
        h["Accept"] = accept
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with _client(timeout) as c:
                resp = c.post(url, data=data, json=json, headers=h)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise BioHTTPError(f"HTTP {resp.status_code} from {url}")
            resp.raise_for_status()
            return resp
        except (httpx.HTTPError, BioHTTPError) as exc:
            last_exc = exc
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
            else:
                raise BioHTTPError(f"POST failed after {MAX_RETRIES} tries: {url} -> {exc}") from exc
    raise BioHTTPError(str(last_exc))  # pragma: no cover


def get_json(url: str, **kw: Any) -> Any:
    return get(url, accept="application/json", **kw).json()


def get_text(url: str, **kw: Any) -> str:
    return get(url, **kw).text
