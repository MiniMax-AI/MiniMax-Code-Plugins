"""Review point 1: base_url must default to HTTPS; plain HTTP is allowed
only for loopback hosts or for non-loopback hosts with explicit opt-in.

`validate_base_url` exits on policy violation. We assert that:
  - https to any host passes silently.
  - http to loopback (127.0.0.1, ::1, localhost, 0.0.0.0) passes silently.
  - http to a non-loopback host is rejected unless `allow_insecure_http = true`.
  - when opted in, a warning is emitted and the call still passes.
  - any other scheme (ftp, file, ...) is rejected.
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search
from _fixtures import FakeResponse  # noqa: F401  (imported for parity with other test files)


def _captured(callable_, *args, **kwargs):
    """Run `callable_(args, kwargs)` and capture stderr/stdout. Returns
    (returncode, stderr, stdout)."""
    err, out = io.StringIO(), io.StringIO()
    rc = {"v": None}
    def _exit(code=0):
        rc["v"] = code
        raise SystemExit(code)
    with mock.patch.object(search, "warn", wraps=search.warn) as _w, \
         mock.patch.object(search.sys, "stderr", err), \
         mock.patch.object(search.sys, "stdout", out), \
         mock.patch.object(search.sys, "exit", side_effect=_exit):
        try:
            callable_(*args, **kwargs)
        except SystemExit:
            pass
    return rc["v"], err.getvalue(), out.getvalue()


class TestValidateBaseUrl(unittest.TestCase):
    def test_https_to_any_host_passes(self):
        rc, err, _ = _captured(search.validate_base_url, "https://searx.example.com", {})
        self.assertIsNone(rc, f"https should pass silently, got rc={rc} err={err!r}")

    def test_http_to_ipv4_loopback_passes(self):
        rc, err, _ = _captured(search.validate_base_url, "http://127.0.0.1:8888", {})
        self.assertIsNone(rc, f"loopback ipv4 should pass, got rc={rc} err={err!r}")

    def test_http_to_localhost_passes(self):
        rc, err, _ = _captured(search.validate_base_url, "http://localhost:8080", {})
        self.assertIsNone(rc, f"localhost should pass, got rc={rc} err={err!r}")

    def test_http_to_ipv6_loopback_passes(self):
        rc, err, _ = _captured(search.validate_base_url, "http://[::1]:8080/", {})
        self.assertIsNone(rc, f"ipv6 loopback should pass, got rc={rc} err={err!r}")

    def test_http_to_non_loopback_is_rejected(self):
        rc, err, _ = _captured(search.validate_base_url, "http://searx.example.com", {})
        self.assertEqual(rc, 1)
        self.assertIn("rejected by default", err)
        self.assertIn("searx.example.com", err)
        self.assertIn("https://", err)
        self.assertIn("loopback", err)
        self.assertIn("allow_insecure_http", err)

    def test_http_to_non_loopback_with_opt_in_passes_with_warning(self):
        rc, err, _ = _captured(search.validate_base_url, "http://searx.example.com", {"allow_insecure_http": True})
        self.assertIsNone(rc)
        self.assertIn("cleartext", err)
        self.assertIn("searx.example.com", err)

    def test_ftp_scheme_is_rejected(self):
        rc, err, _ = _captured(search.validate_base_url, "ftp://searx.example.com/", {})
        self.assertEqual(rc, 1)
        self.assertIn("scheme must be http or https", err)

    def test_empty_scheme_is_rejected(self):
        rc, err, _ = _captured(search.validate_base_url, "searx.example.com", {})
        self.assertEqual(rc, 1)
        self.assertIn("scheme", err)

    def test_missing_host_is_rejected(self):
        rc, err, _ = _captured(search.validate_base_url, "https://", {})
        self.assertEqual(rc, 1)
        self.assertIn("host", err)


if __name__ == "__main__":
    unittest.main()
