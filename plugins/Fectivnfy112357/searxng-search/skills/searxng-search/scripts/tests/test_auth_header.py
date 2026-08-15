"""Review point 1+4: the Authorization header is constructed correctly for
bearer and basic auth, and the resolved values flow from the config into
the header without leaking into the URL.

`build_request` is a pure function over `(config, args)`; we drive it
directly without touching the network.
"""
import argparse
import base64
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
