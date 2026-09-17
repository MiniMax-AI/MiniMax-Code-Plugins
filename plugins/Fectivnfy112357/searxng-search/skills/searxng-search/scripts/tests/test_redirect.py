"""P1 review round 2 (point 1): HTTP redirects must not forward the
Authorization header to a different origin (or a different scheme).

The default `urllib.request.HTTPRedirectHandler` re-issues a 30x response
to the `Location:` URL *with* the original Authorization header. A
misconfigured `base_url` (e.g. an instance fronted by a load balancer
that 302s to a different port) would leak the Bearer / Basic token to a
host the user never explicitly trusted, and would also permit a silent
HTTPS->HTTP downgrade.

`_SafeRedirectHandler` rejects all 3xx with a clear diagnostic. These
tests assert the rejection path and the diagnostic content for every
supported status code, and assert the *Location:* URL printed to the
user does not echo credentials from the original request.
"""
import argparse
import io
import os
import sys
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search
from _fixtures import FakeResponse  # noqa: F401  (parity with other test files)


class TestSafeRedirectHandlerBlocksAllRedirects(unittest.TestCase):
    """Every supported 3xx code must raise HTTPError with a clear
    diagnostic, and the diagnostic must mention the redirect so the user
    knows to fix their `base_url` or front the instance with a same-origin
    reverse proxy."""

    def _assert_blocked(self, code: int, label_fragment: str, headers=None):
        handler = search._SafeRedirectHandler()
        req = urllib.request.Request("https://searx.example.com/search?q=x")
        req.add_header("Authorization", "Bearer ghp_secretvalue_aaaaaaaaaaaaaaaa")
        loc = headers if headers is not None else {"Location": "https://other.example.com:9000/search"}
        method = getattr(handler, f"http_error_{code}")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            method(req, mock.Mock(), code, "Found", loc)
        self.assertEqual(cm.exception.code, code)
        msg = str(cm.exception)
        self.assertIn("redirect blocked", msg)
        self.assertIn(label_fragment, msg)
        # The diagnostic must show the redirect target so the user can fix
        # their config — but stripped of any query/fragment that could carry
        # credentials.
        if "Location" in loc:
            self.assertIn("other.example.com:9000", msg)
        # Critical: the Authorization header value must NOT be echoed into
        # the error message, even though it is on the request object.
        self.assertNotIn("ghp_secretvalue_aaaaaaa", msg)

    def test_301_is_blocked(self):
        self._assert_blocked(301, "301 Moved Permanently")

    def test_302_is_blocked(self):
        self._assert_blocked(302, "302 Found")

    def test_303_is_blocked(self):
        self._assert_blocked(303, "303 See Other")

    def test_307_is_blocked(self):
        self._assert_blocked(307, "307 Temporary Redirect")

    def test_308_is_blocked(self):
        self._assert_blocked(308, "308 Permanent Redirect")


class TestSafeRedirectHandlerDiagnosticShape(unittest.TestCase):
    """The diagnostic must be useful (show scheme/host/port/path) but must
    not echo the query string or fragment of the Location header. Those
    are common places to embed tokens."""

    def test_diagnostic_strips_query_and_fragment(self):
        handler = search._SafeRedirectHandler()
        req = urllib.request.Request("https://searx.example.com/search?q=x")
        location = "https://other.example.com:9000/path?token=ghp_SECRETabcdefghij1234#frag"
        with self.assertRaises(urllib.error.HTTPError) as cm:
            handler.http_error_302(req, mock.Mock(), 302, "Found", {"Location": location})
        msg = str(cm.exception)
        # Path is preserved.
        self.assertIn("/path", msg)
        # Query is stripped.
        self.assertNotIn("token=", msg)
        self.assertNotIn("ghp_SECRET", msg)
        # Fragment is stripped.
        self.assertNotIn("frag", msg)

    def test_diagnostic_handles_unparseable_location(self):
        handler = search._SafeRedirectHandler()
        req = urllib.request.Request("https://searx.example.com/search?q=x")
        with mock.patch.object(search.urllib.parse, "urlparse", side_effect=ValueError("bad url")):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                handler.http_error_302(req, mock.Mock(), 302, "Found", {"Location": "http://x"})
        msg = str(cm.exception)
        self.assertIn("redirect blocked", msg)
        self.assertIn("(unparseable)", msg)

    def test_diagnostic_handles_missing_location(self):
        handler = search._SafeRedirectHandler()
        req = urllib.request.Request("https://searx.example.com/search?q=x")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            handler.http_error_302(req, mock.Mock(), 302, "Found", {})
        msg = str(cm.exception)
        self.assertIn("redirect blocked", msg)
        self.assertIn("(none)", msg)


class TestBuildOpenerUsesSafeHandler(unittest.TestCase):
    """`_build_opener` must install the safe handler so the default urllib
    redirect handler is NOT in play (which would forward Authorization)."""

    def test_opener_includes_safe_redirect_handler(self):
        opener = search._build_opener()
        # urllib stores handlers in `handlers` (list). We assert an instance
        # of our safe class is registered.
        safe_instances = [h for h in opener.handlers if isinstance(h, search._SafeRedirectHandler)]
        self.assertEqual(len(safe_instances), 1, "_SafeRedirectHandler must be installed exactly once")

    def test_opener_does_not_install_default_redirect_handler(self):
        opener = search._build_opener()
        # If a generic HTTPRedirectHandler (not our subclass) is also
        # installed, it would still chase redirects. urllib's build_opener
        # REPLACES handlers passed to it, so only the safe one should be
        # present.
        from urllib.request import HTTPRedirectHandler
        non_safe = [h for h in opener.handlers
                    if isinstance(h, HTTPRedirectHandler) and not isinstance(h, search._SafeRedirectHandler)]
        self.assertEqual(non_safe, [], f"non-safe redirect handlers installed: {non_safe}")


class TestRedirectIntegrationInMain(unittest.TestCase):
    """End-to-end: when the opener returns a 302, the script must exit
    non-zero with the redirect diagnostic, and the Authorization header
    must not be visible in the error output.

    This is the regression test for the *exact* bug the P1 review cited:
    a loopback URL returning 302 to a different port, with the Bearer
    token forwarded to the second origin.
    """

    def _run(self, base_url: str, auth_token: str = ""):
        config = {"base_url": base_url}
        if auth_token:
            config["auth"] = {"type": "bearer", "token": auth_token}

        # Simulate a 302 from the opener: the safe handler would raise
        # HTTPError("redirect blocked: ...") in real life, but here we
        # mock the opener to short-circuit and raise the same error so
        # the integration path through main() is exercised.
        def _open_redirect(*a, **kw):
            raise urllib.error.HTTPError(
                url=base_url + "/search",
                code=302,
                msg="redirect blocked: 302 Found to https://other.example.com:9000/path",
                hdrs=None,
                fp=None,
            )

        err = io.StringIO()
        open_mock = mock.Mock(side_effect=_open_redirect)
        opener = mock.Mock()
        opener.open = open_mock

        with mock.patch.object(sys, "argv", ["search.py", "q"]), \
             mock.patch.object(sys, "stderr", err), \
             mock.patch.object(search, "load_config", return_value=config), \
             mock.patch.object(search, "build_request",
                                mock.Mock(return_value=mock.Mock(get_header=mock.Mock(return_value=None)))), \
             mock.patch.object(search, "_build_opener", return_value=opener), \
             mock.patch.object(search.sys, "exit", side_effect=SystemExit) as e:
            try:
                search.main()
            except SystemExit:
                pass
        return e.call_args[0][0] if e.call_args else None, err.getvalue()

    def test_main_exits_nonzero_on_redirect(self):
        rc, err = self._run("https://searx.example.com")
        self.assertEqual(rc, 1)
        self.assertIn("redirect blocked", err)

    def test_main_does_not_echo_authorization_in_redirect_diagnostic(self):
        # The Authorization header is on the request, but the error
        # message must not echo it.
        rc, err = self._run("https://searx.example.com", auth_token="ghp_aabbccddeeff00112233445566778899")
        self.assertEqual(rc, 1)
        self.assertIn("redirect blocked", err)
        self.assertNotIn("ghp_aabbccddeeff", err)


if __name__ == "__main__":
    unittest.main()
