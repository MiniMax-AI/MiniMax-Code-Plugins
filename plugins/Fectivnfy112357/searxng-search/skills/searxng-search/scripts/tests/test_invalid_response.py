"""Review point 4 + P1 review round 2: error paths for non-JSON responses,
HTTPError body echo, SearXNG structured error response, and authentication
error body suppression. The script must exit non-zero and (in the body-echo
case) not leak credentials that the server reflected back.
"""
import argparse
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search
from _fixtures import FakeHTTPError, FakeResponse


def _args(**over):
    base = dict(
        query="q", categories=None, engines=None, language=None,
        page=1, time_range=None, max_results=None, safesearch=None,
    )
    base.update(over)
    return argparse.Namespace(**base)


def _capture_main(argv, open_side_effect, load_config_mock=None):
    """Invoke `search.main()` with patched argv / opener / load_config,
    return (exit_code, stderr_text).

    `open_side_effect` is the value/exception that the mocked opener.open
    will produce when main() calls it.
    """
    if load_config_mock is None:
        load_config_mock = mock.Mock(return_value={"base_url": "https://searx.example.com"})
    err = io.StringIO()
    open_mock = mock.Mock(side_effect=open_side_effect) if isinstance(open_side_effect, BaseException) or (
        callable(open_side_effect) and not isinstance(open_side_effect, mock.Mock)
    ) else mock.Mock(return_value=open_side_effect)
    opener = mock.Mock()
    opener.open = open_mock
    with mock.patch.object(sys, "argv", ["search.py"] + argv), \
         mock.patch.object(sys, "stderr", err), \
         mock.patch.object(search, "load_config", load_config_mock), \
         mock.patch.object(search, "build_request",
                            mock.Mock(return_value=mock.Mock(get_header=mock.Mock(return_value=None)))), \
         mock.patch.object(search, "_build_opener", return_value=opener), \
         mock.patch.object(search.sys, "exit", side_effect=SystemExit) as e:
        try:
            search.main()
        except SystemExit:
            pass
    return e.call_args[0][0] if e.call_args else None, err.getvalue()


class TestInvalidResponse(unittest.TestCase):
    def test_non_json_response_exits_with_diagnostic(self):
        body = b"<html>oops not json</html>"
        rc, err = _capture_main(["q"], FakeResponse(body))
        self.assertEqual(rc, 1)
        self.assertIn("Invalid JSON", err)
        self.assertIn("oops not json", err)

    def test_searxng_structured_error_exits(self):
        body = b'{"error": "instance disabled"}'
        rc, err = _capture_main(["q"], FakeResponse(body))
        self.assertEqual(rc, 1)
        self.assertIn("SearXNG returned error", err)
        self.assertIn("instance disabled", err)

    def test_http_error_echoes_body_redacted(self):
        # 500 is not auth-class, so body IS echoed. The "server" reflects
        # back an Authorization header in its error body which must be
        # masked via shape-based redaction.
        body = b'{"detail": "got Authorization: Basic ' + (b"A" * 60) + b'"}'
        rc, err = _capture_main(["q"], FakeHTTPError(500, body))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 500", err)
        # The reflected credential must be masked, not echoed.
        self.assertNotIn(b"A" * 60, err.encode())
        self.assertIn("Authorization: Basic ***", err)

    def test_url_error_reports_reason(self):
        from urllib.error import URLError
        rc, err = _capture_main(["q"], URLError("dns failure"))
        self.assertEqual(rc, 1)
        self.assertIn("Request failed", err)
        self.assertIn("dns failure", err)

    def test_timeout_error_reports_configured_timeout(self):
        rc, err = _capture_main(["q"], TimeoutError(""))
        # We can't easily test the actual timeout from the opener's
        # perspective without hitting the network, but we can verify
        # the error message uses the configured value.
        self.assertEqual(rc, 1)
        self.assertIn("Request timed out", err)
        self.assertIn("30s", err)  # default


class TestAuthErrorBodySuppression(unittest.TestCase):
    """P1 review round 2: 401/403/407 bodies must not be echoed to stderr.

    These codes are the canonical "your credentials are wrong" responses,
    and SearXNG-style instances have been observed to reflect the
    Authorization header back in the body. Shape-based redaction can't
    cover every variant; suppressing the body entirely for these codes
    closes the leak surface.
    """

    def test_401_body_is_suppressed(self):
        # Even if the body contains a long-shape bearer token, it must
        # not appear in the error output.
        body = b'{"detail": "got Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
        rc, err = _capture_main(["q"], FakeHTTPError(401, body))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 401", err)
        self.assertIn("body suppressed", err)
        # Body bytes must not leak.
        self.assertNotIn(b"Bearer ghp_", err.encode())
        self.assertNotIn(b"got Bearer", err.encode())

    def test_403_body_is_suppressed(self):
        body = b'{"detail": "forbidden: bad credentials xyz123"}'
        rc, err = _capture_main(["q"], FakeHTTPError(403, body))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 403", err)
        self.assertIn("body suppressed", err)
        self.assertNotIn(b"xyz123", err.encode())
        self.assertNotIn(b"forbidden: bad", err.encode())

    def test_407_body_is_suppressed(self):
        # Proxy auth challenge — same class of leak.
        body = b'{"detail": "Proxy-Authenticate: Basic realm=svc"}'
        rc, err = _capture_main(["q"], FakeHTTPError(407, body))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 407", err)
        self.assertIn("body suppressed", err)
        self.assertNotIn(b"Proxy-Authenticate", err.encode())

    def test_500_body_is_NOT_suppressed(self):
        # 500 is not auth-class; the body should still be echoed (and
        # run through redact_secrets as usual). This guards against
        # accidentally widening the suppression to all HTTPError codes.
        body = b'{"error": "internal server error"}'
        rc, err = _capture_main(["q"], FakeHTTPError(500, body))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 500", err)
        self.assertIn("internal server error", err)
        self.assertNotIn("body suppressed", err)


class TestResponseShapeRobustness(unittest.TestCase):
    """Robustness beyond the P1 review: a malformed-but-200 response must
    produce a clean diagnostic, not a raw traceback that bypasses the
    redacted-error pipeline."""

    def test_json_array_root_exits_with_diagnostic(self):
        # A proxy/login page or misconfigured endpoint can return a JSON
        # array; the script used to crash with AttributeError on data.get().
        rc, err = _capture_main(["q"], FakeResponse(b'[{"x": 1}]'))
        self.assertEqual(rc, 1)
        self.assertIn("JSON object", err)

    def test_non_utf8_body_exits_with_diagnostic(self):
        # A 200 response in latin-1/GBK used to raise an uncaught
        # UnicodeDecodeError.
        rc, err = _capture_main(["q"], FakeResponse('{"results": [{"title": "caf\u00e9"}]}'.encode("latin-1")))
        self.assertEqual(rc, 1)
        self.assertIn("non-UTF-8", err)

    def test_oversized_response_exits_with_diagnostic(self):
        with mock.patch.object(search, "MAX_RESPONSE_BYTES", 16):
            rc, err = _capture_main(["q"], FakeResponse(b"x" * 100))
        self.assertEqual(rc, 1)
        self.assertIn("limit", err)
        self.assertNotIn(b"x" * 16, err.encode())  # body not echoed

    def test_oversized_http_error_body_is_capped(self):
        # The HTTPError path reads the body with the same cap; a huge
        # error body must not be slurped into memory or echoed wholesale.
        with mock.patch.object(search, "MAX_RESPONSE_BYTES", 32):
            rc, err = _capture_main(["q"], FakeHTTPError(500, b"z" * 1000))
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 500", err)
        self.assertLess(len(err), 200)  # truncated, not 1000 bytes


if __name__ == "__main__":
    unittest.main()
