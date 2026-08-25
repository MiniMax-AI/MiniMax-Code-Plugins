"""Helpers shared by smoke.py and the no-redirect regression test.

Kept in a separate module so that the regression test can `import` the
no-redirect opener without running smoke.py's full check sequence. The
helpers expose a single primitive: an `OpenerDirector` that refuses
every 3xx response, so that a token-bearing request never silently
follows a redirect to a different origin.

Why this matters
----------------
A loopback URL by itself is not a strong security boundary. A
compromised or misconfigured server on the same host can return 302
pointing at any other local endpoint (a sidecar, a stray port the user
bound, a hostile container that learned the host name). Python's
default `urllib.request.urlopen` follows those redirects while keeping
the `Authorization` header attached, so the `$ACP_TOKEN` would leak to
whatever the redirect target is. The `NoRedirectHandler` in this module
refuses every 3xx so the caller surfaces the response as `HTTPError`
and the token never leaves the original request.
"""
from __future__ import annotations
import urllib.error
import urllib.request


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse every 3xx response on requests through this opener.

    Overrides ``http_error_301`` / ``_302`` / ``_303`` / ``_307`` /
    ``_308`` directly. The base class dispatches by method name
    (not via a generic ``http_error_30x``), so each must be overridden
    individually. Any 3xx we have not explicitly listed would still hit
    the default HTTPRedirectHandler and follow the redirect; to make
    the policy fail-closed we also strip the default handler entirely
    in ``build_no_redirect_opener``.
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

    http_error_301 = _deny
    http_error_302 = _deny
    http_error_303 = _deny
    http_error_307 = _deny
    http_error_308 = _deny


def build_no_redirect_opener() -> urllib.request.OpenerDirector:
    """Return an opener that never follows redirects.

    `urllib.request.build_opener` registers a default
    `HTTPRedirectHandler` in BOTH the legacy `opener.handlers` list AND
    the dispatch dict `opener.handle_error['http'][code]`. The dispatch
    dict is what actually routes 3xx responses to handlers (see
    `OpenerDirector.error` / `_call_chain`); the `handlers` list is
    retained only for backward compatibility. To make our subclass win,
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
    opener.add_handler(NoRedirectHandler())
    return opener
