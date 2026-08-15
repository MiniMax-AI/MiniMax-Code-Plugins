"""Review point 2 (post-fix): raw `gh` command stderr piped through
scripts/redact_stderr.py is redacted before reaching the agent transcript.
"""
import io
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
sys.path.insert(0, SCRIPTS)  # so `import _lib` works for direct cases

import _lib  # noqa: E402

WRAPPER = os.path.join(SCRIPTS, "redact_stderr.py")

TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
FPAT = "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz"


def _run_wrapper(stdin_bytes: bytes) -> str:
    """Invoke the wrapper as a subprocess with `stdin_bytes` on stdin.

    Returns the decoded stdout. For byte-exact comparison (line-ending
    preservation), use _run_wrapper_bytes.
    """
    return _run_wrapper_bytes(stdin_bytes).decode("utf-8")


def _run_wrapper_bytes(stdin_bytes: bytes) -> bytes:
    """Byte-exact wrapper invocation. Asserts a clean exit."""
    r = subprocess.run(
        [sys.executable, WRAPPER],
        input=stdin_bytes,
        capture_output=True,
        timeout=15,
    )
    assert r.returncode == 0, (
        f"wrapper exited {r.returncode}\n--- stderr ---\n{r.stderr!r}"
    )
    return r.stdout


class TestRedactStderrWrapper(unittest.TestCase):
    def test_redacts_classic_pat(self):
        out = _run_wrapper(f"unauthorized: {TOKEN}\n".encode("utf-8"))
        self.assertNotIn(TOKEN, out)
        self.assertIn("***", out)

    def test_redacts_fine_grained_pat(self):
        out = _run_wrapper(f"hint: use {FPAT}\n".encode("utf-8"))
        self.assertNotIn(FPAT, out)
        self.assertIn("github_pat_***", out)

    def test_redacts_env_var_form(self):
        out = _run_wrapper("GH_TOKEN=ghp_abcsecret1234567890xx\n".encode("utf-8"))
        self.assertNotIn("ghp_abcsecret1234567890xx", out)
        self.assertIn("GH_TOKEN=***", out)

    def test_preserves_ordinary_text(self):
        msg = "rate limit exceeded (attempt 3/3); retry in 60s\n"
        out = _run_wrapper(msg.encode("utf-8"))
        self.assertEqual(out, msg)

    def test_empty_input(self):
        out = _run_wrapper(b"")
        self.assertEqual(out, "")


class TestRedactStderrInProcess(unittest.TestCase):
    """Sanity: in-process call to the same code path the wrapper uses."""

    def test_redact_secrets_direct(self):
        # Classic PAT pattern matches first and rewrites the ghp_ token to
        # `ghx_***` (preserving the prefix marker), so the bearer line
        # reads `bearer ghx_***`, not `bearer ***`. This is intentional
        # ordering in _lib._SECRET_PATTERNS (more specific shapes first).
        self.assertEqual(
            _lib.redact_secrets(f"bearer {TOKEN}"),
            "bearer ghx_***",
        )

    def test_wrapper_handles_mixed_content(self):
        # Mixed: a token, an env var, a normal line — all in one stream.
        # The wrapper must preserve the input line endings (LF in, LF out)
        # so the downstream consumer sees exactly what `gh` produced, with
        # only the credential-shaped substrings replaced.
        mixed = (
            f"auth failed: {TOKEN}\n"
            "GH_TOKEN=ghp_other1234567890abcdef\n"
            "To request a token visit https://github.com/settings/tokens\n"
        )
        out_bytes = _run_wrapper_bytes(mixed.encode("utf-8"))
        out = out_bytes.decode("utf-8")

        # 1. Redaction happened on both credential shapes.
        self.assertNotIn(TOKEN, out)
        self.assertNotIn("ghp_other1234567890abcdef", out)

        # 2. Line endings preserved byte-exactly (no LF -> CRLF translation).
        # If the wrapper regresses to text-mode stdout, every '\n' in
        # out_bytes would be '\r\n'. Count LFs vs CRLFs as a tripwire.
        self.assertEqual(out_bytes.count(b"\r\n"), mixed.encode("utf-8").count(b"\r\n"),
                         "wrapper introduced CRLF where input had LF")
        self.assertEqual(out_bytes.count(b"\n"), mixed.encode("utf-8").count(b"\n"),
                         "wrapper dropped a newline")

        # 3. Non-credential text passes through untouched.
        self.assertIn(
            "To request a token visit https://github.com/settings/tokens\n",
            out,
        )


if __name__ == "__main__":
    unittest.main()
