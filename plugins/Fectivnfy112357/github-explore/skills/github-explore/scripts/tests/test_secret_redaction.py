"""Review point 4: on error, sensitive info in stderr is redacted."""
import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _lib
from _fixtures import FakeProc

TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
FPAT = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"

class TestRedactSecrets(unittest.TestCase):
    def test_redacts_credential_shapes(self):
        cases = {
            TOKEN: "ghx_***",
            FPAT: "github_pat_***",
            "Bearer abcdefghijklmnopqrstuvwx": "Bearer ***",
            "token=supersecretvalue": "token=***",
            "GH_TOKEN=ghp_abc": "GH_TOKEN=***",
        }
        for raw, expected in cases.items():
            self.assertEqual(_lib.redact_secrets(raw), expected, raw)
    def test_leaves_ordinary_text_intact(self):
        msg = "rate limit exceeded (attempt 3/3)"
        self.assertEqual(_lib.redact_secrets(msg), msg)

class TestStderrRedaction(unittest.TestCase):
    def test_warn_redacts_token(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            _lib.warn("error: " + TOKEN)
        self.assertNotIn(TOKEN, err.getvalue())
        self.assertIn("***", err.getvalue())
    def test_die_redacts_token_and_exits(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as cm:
                _lib.die("failed: " + TOKEN)
        self.assertEqual(cm.exception.code, 1)
        self.assertNotIn(TOKEN, err.getvalue())
        self.assertIn("***", err.getvalue())
    def test_gh_json_error_path_redacts_gh_stderr(self):
        err = io.StringIO()
        with mock.patch.object(_lib, "run_gh", return_value=FakeProc(returncode=1, stderr="unauthorized " + TOKEN)), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit):
                _lib.gh_json(["search", "repos", "x"])
        self.assertNotIn(TOKEN, err.getvalue())

if __name__ == "__main__":
    unittest.main()
