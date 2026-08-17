"""Review point 1+4: the Authorization header is constructed correctly for
bearer and basic auth, and the resolved values flow from the config into
the header without leaking into the URL.

`build_request` is a pure function over `(config, args)`; we drive it
directly without touching the network.
"""
import argparse
import base64
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search


def _args(**over):
    base = dict(
        query="q", categories=None, engines=None, language=None,
        page=1, time_range=None, max_results=None, safesearch=None,
    )
    base.update(over)
    return argparse.Namespace(**base)


class TestBuildRequestAuthHeader(unittest.TestCase):
    def test_bearer_header_carries_token(self):
        config = {"base_url": "https://searx.example.com", "auth": {"type": "bearer", "token": "abc123"}}
        req = search.build_request(config, _args())
        self.assertEqual(req.get_header("Authorization"), "Bearer abc123")

    def test_bearer_resolves_env_var(self):
        config = {"base_url": "https://searx.example.com", "auth": {"type": "bearer", "token": "$SEARXNG_TOKEN"}}
        with mock.patch.dict(os.environ, {"SEARXNG_TOKEN": "secret-value"}):
            req = search.build_request(config, _args())
        self.assertEqual(req.get_header("Authorization"), "Bearer secret-value")

    def test_basic_header_is_base64_user_colon_pass(self):
        config = {
            "base_url": "https://searx.example.com",
            "auth": {"type": "basic", "user": "admin", "pass": "pw"},
        }
        req = search.build_request(config, _args())
        creds = req.get_header("Authorization")
        self.assertTrue(creds.startswith("Basic "))
        encoded = creds.split(" ", 1)[1]
        self.assertEqual(base64.b64decode(encoded).decode(), "admin:pw")

    def test_basic_resolves_env_vars(self):
        config = {
            "base_url": "https://searx.example.com",
            "auth": {"type": "basic", "user": "$SEARXNG_USER", "pass": "$SEARXNG_PASS"},
        }
        with mock.patch.dict(os.environ, {"SEARXNG_USER": "u1", "SEARXNG_PASS": "p1"}):
            req = search.build_request(config, _args())
        creds = req.get_header("Authorization")
        self.assertEqual(base64.b64decode(creds.split(" ", 1)[1]).decode(), "u1:p1")

    def test_no_auth_section_sends_no_authorization_header(self):
        config = {"base_url": "https://searx.example.com"}
        req = search.build_request(config, _args())
        self.assertIsNone(req.get_header("Authorization"))

    def test_token_does_not_leak_into_url(self):
        config = {"base_url": "https://searx.example.com", "auth": {"type": "bearer", "token": "abc123"}}
        req = search.build_request(config, _args())
        self.assertNotIn("abc123", req.full_url)
        self.assertIn("q=q", req.full_url)


def _get_header_ci(req, name):
    """urllib stores header names via `key.capitalize()` and `get_header`
    is an exact dict lookup, so look the value up case-insensitively."""
    for key, value in req.header_items():
        if key.lower() == name.lower():
            return value
    return None


class TestBuildRequestCustomHeaders(unittest.TestCase):
    """Custom `headers` config values get the same treatment as auth.*:
    `$ENV_VAR` references are resolved (instead of being sent as the
    literal `$NAME` text), and env-referenced values are registered for
    exact redaction in later error output."""

    def test_plain_header_passes_through(self):
        config = {"base_url": "https://searx.example.com", "headers": {"X-Custom": "value"}}
        req = search.build_request(config, _args())
        self.assertEqual(_get_header_ci(req, "X-Custom"), "value")

    def test_env_var_header_is_resolved(self):
        config = {"base_url": "https://searx.example.com", "headers": {"X-API-Key": "$SEARXNG_API_KEY"}}
        with mock.patch.dict(os.environ, {"SEARXNG_API_KEY": "hunter2"}):
            req = search.build_request(config, _args())
        self.assertEqual(_get_header_ci(req, "X-API-Key"), "hunter2")

    def test_env_var_header_registers_secret_for_redaction(self):
        search.reset_active_secrets()
        config = {"base_url": "https://searx.example.com", "headers": {"X-API-Key": "$SEARXNG_API_KEY"}}
        with mock.patch.dict(os.environ, {"SEARXNG_API_KEY": "hunter2"}):
            search.build_request(config, _args())
        out = search.redact_secrets("server echoed hunter2 in error body")
        self.assertNotIn("hunter2", out)
        self.assertIn("***", out)
        search.reset_active_secrets()

    def test_missing_env_var_header_exits(self):
        err = io.StringIO()
        config = {"base_url": "https://searx.example.com", "headers": {"X-Key": "$MISSING_VAR"}}
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(sys, "stderr", err), \
             mock.patch.object(search.sys, "exit", side_effect=SystemExit) as e:
            with self.assertRaises(SystemExit):
                search.build_request(config, _args())
        self.assertIn("MISSING_VAR is not set", err.getvalue())

    def test_non_string_header_value_exits(self):
        err = io.StringIO()
        config = {"base_url": "https://searx.example.com", "headers": {"X-Num": 42}}
        with mock.patch.object(sys, "stderr", err), \
             mock.patch.object(search.sys, "exit", side_effect=SystemExit) as e:
            with self.assertRaises(SystemExit):
                search.build_request(config, _args())
        self.assertIn("X-Num", err.getvalue())
        self.assertIn("headers", err.getvalue())


class TestUserAgent(unittest.TestCase):
    def test_user_agent_mentions_real_repo(self):
        req = search.build_request({"base_url": "https://searx.example.com"}, _args())
        ua = req.get_header("User-agent")
        self.assertIn("Fectivnfy112357", ua)
        self.assertNotIn("XYenon", ua)

    def test_user_agent_overridden_by_config_headers(self):
        config = {
            "base_url": "https://searx.example.com",
            "headers": {"User-Agent": "my-agent/9.9"},
        }
        req = search.build_request(config, _args())
        self.assertEqual(req.get_header("User-agent"), "my-agent/9.9")


if __name__ == "__main__":
    unittest.main()
