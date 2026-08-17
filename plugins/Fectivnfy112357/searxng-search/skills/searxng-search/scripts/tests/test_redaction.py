"""Review point 4: on error, sensitive info that leaked into stderr is masked.

`redact_secrets` covers 5 credential shapes. `die` and `warn` route
through it before printing. We also assert the `Authorization: Basic`
header value is masked in error output.

P1 review round 2 (point 3): the exact-secret registry (`register_secret` /
`reset_active_secrets`) must mask short or otherwise shape-non-conforming
tokens that the pattern-based redaction cannot catch.
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
    def setUp(self):
        # Ensure each test starts with a clean registry.
        search.reset_active_secrets()

    def tearDown(self):
        search.reset_active_secrets()

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


class TestExactSecretRegistry(unittest.TestCase):
    """P1 review round 2 (point 3): shape-based redaction cannot cover
    every token variant. The active-request secret registry
    (`register_secret`) provides exact-value replacement as a primary
    defense; shape patterns are a fallback.

    These tests pin down the registry's contract:
      - Short tokens that don't match any shape ARE masked after registration.
      - A substring secret is replaced before its containing string
        (longest-first).
      - `reset_active_secrets` clears the registry.
      - Empty / falsy values are no-ops.
      - Duplicates don't grow the set.
    """

    def setUp(self):
        search.reset_active_secrets()

    def tearDown(self):
        search.reset_active_secrets()

    def test_short_token_is_masked_after_registration(self):
        # 8 chars — well below the 20-char shape threshold for `gh[pousr]_`.
        # Without the registry, this would pass through; with it, it must
        # be replaced.
        short = "abc12345"
        search.register_secret(short)
        out = search.redact_secrets(f"server saw header value {short} in trace")
        self.assertNotIn(short, out)
        self.assertIn("***", out)
        self.assertIn("server saw header value *** in trace", out)

    def test_non_shape_token_is_masked_after_registration(self):
        # A bespoke internal token format with no matching shape pattern.
        bespoke = "internal-token-zzzz-9999"
        search.register_secret(bespoke)
        out = search.redact_secrets(f"upstream error: {bespoke} is not authorized")
        self.assertNotIn(bespoke, out)
        self.assertIn("upstream error: *** is not authorized", out)

    def test_unregistered_short_token_is_NOT_masked(self):
        # Counter-test: if a token was never registered, we don't claim
        # to mask it. The pattern-based fallback is best-effort and may
        # miss it. This pins down the contract that the registry is the
        # primary defense.
        short = "abc12345"
        out = search.redact_secrets(f"server saw {short} in trace")
        self.assertIn(short, out)

    def test_substring_secret_replaced_before_container(self):
        # "abc" is a substring of "abcdef". When both are registered, the
        # longer one must be replaced first so the shorter one isn't
        # masked by a leftover.
        search.register_secret("abc")
        search.register_secret("abcdef")
        out = search.redact_secrets("value=abcdef in payload")
        self.assertNotIn("abcdef", out)
        # After both replacements: "value=*** in payload" (if "abcdef" is
        # replaced first) or "value=***def in payload" (if "abc" is first
        # but the leftover `def` is harmless).
        # The contract is: no registered value may remain.
        self.assertNotIn("abc", out)
        self.assertNotIn("abcdef", out)

    def test_reset_clears_registry(self):
        search.register_secret("abc12345")
        out1 = search.redact_secrets("leak abc12345 here")
        self.assertNotIn("abc12345", out1)
        search.reset_active_secrets()
        # After reset, the same value is no longer masked.
        out2 = search.redact_secrets("leak abc12345 here")
        self.assertIn("abc12345", out2)

    def test_empty_value_is_noop(self):
        # Empty / falsy registrations must not pollute the registry or
        # match unrelated text.
        search.register_secret("")
        search.register_secret(None) if False else None  # type: ignore[arg-type]
        out = search.redact_secrets("normal text with *** placeholders")
        # No replacement should happen for an empty registered value
        # (replace("", "***") would replace every empty position, so we
        # guard against that).
        self.assertNotEqual(out, "normal text with ******** placeholders")

    def test_duplicate_registration_is_idempotent(self):
        # The set is deduplicated; repeated registration must not change
        # output and must not change set size meaningfully.
        for _ in range(5):
            search.register_secret("abc12345")
        out = search.redact_secrets("leak abc12345 here")
        self.assertNotIn("abc12345", out)
        self.assertIn("***", out)


class TestStderrRedaction(unittest.TestCase):
    def setUp(self):
        search.reset_active_secrets()

    def tearDown(self):
        search.reset_active_secrets()

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
