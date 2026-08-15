"""Review point 4: error paths for non-JSON responses, HTTPError body
echo, and SearXNG structured error response. The script must exit
non-zero and (in the body-echo case) not leak credentials that the
server reflected back.
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


def _capture_main(argv, urlopen_mock, load_config_mock=None):
    """Invoke `search.main()` with patched argv / urlopen / load_config,
    return (exit_code, stderr_text)."""
    if load_config_mock is None:
        load_config_mock = mock.Mock(return_value={"base_url": "https://searx.example.com"})
    err = io.StringIO()
    with mock.patch.object(sys, "argv", ["search.py"] + argv), \
         mock.patch.object(sys, "stderr", err), \
         mock.patch.object(search, "load_config", load_config_mock), \
         mock.patch.object(search, "build_request",
                            mock.Mock(return_value=mock.Mock(get_header=mock.Mock(return_value=None)))), \
         mock.patch.object(search.urllib.request, "urlopen", urlopen_mock), \
         mock.patch.object(search.sys, "exit", side_effect=SystemExit) as e:
        try:
            search.main()
        except SystemExit:
            pass
    return e.call_args[0][0] if e.call_args else None, err.getvalue()


class TestInvalidResponse(unittest.TestCase):
    def test_non_json_response_exits_with_diagnostic(self):
        body = b"<html>oops not json</html>"
        urlopen = mock.Mock(return_value=FakeResponse(body))
        rc, err = _capture_main(["q"], urlopen)
        self.assertEqual(rc, 1)
        self.assertIn("Invalid JSON", err)
        self.assertIn("oops not json", err)

    def test_searxng_structured_error_exits(self):
        body = b'{"error": "instance disabled"}'
        urlopen = mock.Mock(return_value=FakeResponse(body))
        rc, err = _capture_main(["q"], urlopen)
        self.assertEqual(rc, 1)
        self.assertIn("SearXNG returned error", err)
        self.assertIn("instance disabled", err)

    def test_http_error_echoes_body_redacted(self):
        # The "server" reflects back an Authorization header in its error body.
        body = b'{"detail": "got Authorization: Basic ' + (b"A" * 60) + b'"}'
        urlopen = mock.Mock(side_effect=FakeHTTPError(401, body))
        rc, err = _capture_main(["q"], urlopen)
        self.assertEqual(rc, 1)
        self.assertIn("HTTP 401", err)
        # The reflected credential must be masked, not echoed.
        self.assertNotIn(b"A" * 60, err.encode())
        self.assertIn("Authorization: Basic ***", err)

    def test_url_error_reports_reason(self):
        from urllib.error import URLError
        urlopen = mock.Mock(side_effect=URLError("dns failure"))
        rc, err = _capture_main(["q"], urlopen)
        self.assertEqual(rc, 1)
        self.assertIn("Request failed", err)
        self.assertIn("dns failure", err)

    def test_timeout_error_reports_configured_timeout(self):
        urlopen = mock.Mock(side_effect=TimeoutError(""))
        # We can't easily test the actual timeout from urlopen's perspective
        # without hitting the network, but we can verify the error message
        # uses the configured value.
        rc, err = _capture_main(["q"], urlopen)
        self.assertEqual(rc, 1)
        self.assertIn("Request timed out", err)
        self.assertIn("30s", err)  # default


if __name__ == "__main__":
    unittest.main()
