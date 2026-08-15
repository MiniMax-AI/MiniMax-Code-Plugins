"""Review point 4: on error, sensitive info that leaked into stderr is masked.

`redact_secrets` covers 5 credential shapes. `die` and `warn` route
through it before printing. We also assert the `Authorization: Basic`
header value is masked in error output.
"""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search


TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
FPAT = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"
BEARER_FULL = "Bearer " + TOKEN
BASIC_FULL = "Authorization: Basic " + ("A" * 60)


class TestRedactSecrets(unittest.TestCase):
    def test_redacts_credential_shapes(self):
        cases = {
            TOKEN: "ghx_***",
            FPAT: "github_pat_***",
            BEARER_FULL: "Bearer ***",
            "token=supersecretvalue": "token=***",
            "SEARXNG_TOKEN=ghp_abc": "SEARXNG_TOKEN=***",
        }
        for raw, expected in cases.items():
            self.assertEqual(search.redact_secrets(raw), expected, raw)

    def test_redacts_authorization_basic_header_value(self):
        self.assertEqual(search.redact_secrets(BASIC_FULL), "Authorization: Basic ***")

    def test_leaves_ordinary_text_intact(self):
        msg = "HTTP 401: unauthorized (attempt 3/3)"
        self.assertEqual(search.redact_secrets(msg), msg)


class TestStderrRedaction(unittest.TestCase):
    def test_die_redacts_token_and_exits(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err), self.assertRaises(SystemExit) as cm:
            search.die("failed: " + TOKEN)
        self.assertEqual(cm.exception.code, 1)
        self.assertNotIn(TOKEN, err.getvalue())
        self.assertIn("***", err.getvalue())

    def test_warn_redacts_authorization_basic(self):
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            search.warn("upstream sent: " + BASIC_FULL)
        self.assertNotIn("A" * 60, err.getvalue())
        self.assertIn("Authorization: Basic ***", err.getvalue())


if __name__ == "__main__":
    unittest.main()
