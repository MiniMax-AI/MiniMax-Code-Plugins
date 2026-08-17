"""Review point 3: config loading is robust to missing files, malformed
TOML/JSON, missing env vars, and overly-permissive file modes (POSIX).

We exercise the real config-loading path with `tempfile.TemporaryDirectory`
so the tests cover the actual TOML/JSON parse + env-var resolve + perm-check
pipeline rather than a mock that drifts from the real code.

`die` and `warn` print to stderr and call `sys.exit`. We capture stderr
directly to verify the message; the exit code is incidental.
"""
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search


def _capture(callable_):
    """Run `callable_()` with `sys.exit` raising and stderr captured.
    Return (exit_code, stderr_text)."""
    err = io.StringIO()
    rc = {"v": None}
    def _exit(code=0):
        rc["v"] = code
        raise SystemExit(code)
    with mock.patch.object(sys, "stderr", err), \
         mock.patch.object(search.sys, "exit", side_effect=_exit):
        try:
            callable_()
        except SystemExit:
            pass
    return rc["v"], err.getvalue()


class TestLoadConfigErrors(unittest.TestCase):
    def test_no_toml_no_json_exits(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True):
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("Config file not found", err)

    def test_invalid_toml_exits(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "validate_base_url"), \
             mock.patch.object(search, "check_file_permissions"):
            os.makedirs(os.path.join(d, "agents"), exist_ok=True)
            with open(os.path.join(d, "agents", "searxng.toml"), "w") as f:
                f.write("[auth\ntype = broken")
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("Invalid TOML", err)

    def test_missing_base_url_exits(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "validate_base_url"), \
             mock.patch.object(search, "check_file_permissions"):
            os.makedirs(os.path.join(d, "agents"), exist_ok=True)
            with open(os.path.join(d, "agents", "searxng.toml"), "w") as f:
                f.write('default_categories = ["general"]\n')
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("base_url is required", err)

    def test_valid_config_loads_with_url_check(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "check_file_permissions") as cp:
            os.makedirs(os.path.join(d, "agents"), exist_ok=True)
            with open(os.path.join(d, "agents", "searxng.toml"), "w") as f:
                f.write('base_url = "https://searx.example.com"\n')
            config = search.load_config()
        self.assertEqual(config["base_url"], "https://searx.example.com")
        cp.assert_called_once()


class TestResolveEnv(unittest.TestCase):
    def test_unset_env_var_exits_with_message(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            rc, err = _capture(lambda: search.resolve_env("$SEARXNG_TOKEN"))
        self.assertEqual(rc, 1)
        self.assertIn("SEARXNG_TOKEN is not set", err)

    def test_brace_syntax_is_stripped(self):
        with mock.patch.dict(os.environ, {"SEARXNG_TOKEN": "abc"}):
            self.assertEqual(search.resolve_env("${SEARXNG_TOKEN}"), "abc")

    def test_plain_string_passes_through(self):
        self.assertEqual(search.resolve_env("plain-literal"), "plain-literal")

    def test_empty_string_passes_through(self):
        self.assertEqual(search.resolve_env(""), "")


class TestConfigFieldTypes(unittest.TestCase):
    """Numeric config fields must be integers. A hand-edited TOML with
    `timeout = "30"` used to raise a raw TypeError from urllib (and
    `default_max_results = "5"` from result slicing); both now fail
    fast with a clear message during load_config.
    """

    def _write(self, d, body):
        os.makedirs(os.path.join(d, "agents"), exist_ok=True)
        with open(os.path.join(d, "agents", "searxng.toml"), "w") as f:
            f.write(body)

    def test_timeout_as_string_exits(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "validate_base_url"), \
             mock.patch.object(search, "check_file_permissions"):
            self._write(d, 'base_url = "https://searx.example.com"\ntimeout = "30"\n')
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("timeout", err)
        self.assertIn("must be an integer", err)

    def test_default_max_results_as_string_exits(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "validate_base_url"), \
             mock.patch.object(search, "check_file_permissions"):
            self._write(d, 'base_url = "https://searx.example.com"\ndefault_max_results = "5"\n')
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("default_max_results", err)
        self.assertIn("must be an integer", err)

    def test_boolean_is_rejected(self):
        # `True` is an int subclass; treat it as a config typo, not a number.
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "validate_base_url"), \
             mock.patch.object(search, "check_file_permissions"):
            self._write(d, 'base_url = "https://searx.example.com"\ntimeout = true\n')
            rc, err = _capture(search.load_config)
        self.assertEqual(rc, 1)
        self.assertIn("timeout", err)

    def test_valid_integers_load_ok(self):
        with tempfile.TemporaryDirectory() as d, \
             mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": d}, clear=True), \
             mock.patch.object(search, "check_file_permissions"):
            self._write(d, 'base_url = "https://searx.example.com"\ntimeout = 12\ndefault_max_results = 3\n')
            config = search.load_config()
        self.assertEqual(config["timeout"], 12)
        self.assertEqual(config["default_max_results"], 3)


class TestFilePermissions(unittest.TestCase):
    def test_world_readable_warns(self):
        if os.name != "posix":
            self.skipTest("POSIX-mode-bits check is skipped on non-POSIX platforms")
        # Drive the check by patching os.stat so the assertion is portable
        # across platforms (Windows doesn't preserve 0o600 reliably).
        fake_stat = type("S", (), {"st_mode": 0o644})()
        with mock.patch.object(search.os, "stat", return_value=fake_stat), \
             mock.patch.object(search, "warn", wraps=search.warn) as w:
            search.check_file_permissions("/dummy/path")
        self.assertTrue(w.called)
        self.assertIn("readable beyond the owner", str(w.call_args))

    def test_owner_only_does_not_warn(self):
        if os.name != "posix":
            self.skipTest("POSIX-mode-bits check is skipped on non-POSIX platforms")
        fake_stat = type("S", (), {"st_mode": 0o600})()
        with mock.patch.object(search.os, "stat", return_value=fake_stat), \
             mock.patch.object(search, "warn", wraps=search.warn) as w:
            search.check_file_permissions("/dummy/path")
        self.assertFalse(w.called)

    def test_missing_file_silently_skips(self):
        with mock.patch.object(search.os, "stat", side_effect=OSError("missing")), \
             mock.patch.object(search, "warn", wraps=search.warn) as w:
            search.check_file_permissions("/does/not/exist")
        self.assertFalse(w.called)

    def test_skipped_on_non_posix(self):
        # Even with a "world-readable" stat, the check is a no-op on
        # non-POSIX because `st_mode` is a synthetic value on Windows
        # and not derived from the file's real ACL.
        if os.name == "posix":
            self.skipTest("POSIX-only assertion")
        fake_stat = type("S", (), {"st_mode": 0o644})()
        with mock.patch.object(search.os, "stat", return_value=fake_stat), \
             mock.patch.object(search, "warn", wraps=search.warn) as w:
            search.check_file_permissions("/dummy/path")
        self.assertFalse(w.called)


if __name__ == "__main__":
    unittest.main()
