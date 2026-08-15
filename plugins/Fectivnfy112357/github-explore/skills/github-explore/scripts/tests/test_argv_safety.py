"""Review point 4: params are built into a gh argv LIST (no shell).

Quotes, separators and $-expansions in user queries can never be interpreted
by a shell, because run_gh() always calls subprocess with a list.
"""
import argparse
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import _lib
import find_repos
from _fixtures import FakeProc

class TestRunGhArgvSafety(unittest.TestCase):
    def test_run_gh_passes_argv_list_without_shell(self):
        captured = {}
        def fake_run(args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return FakeProc(stdout="ok")
        with mock.patch.object(_lib.subprocess, 'run', side_effect=fake_run):
            _lib.run_gh(["search", "repos", "a b; c", "$(rm -rf /)", 'quote"d'])
        self.assertEqual(captured["args"][0], "gh")
        self.assertIsNone(captured["kwargs"].get("shell"), "shell must never be enabled")
        self.assertEqual(captured["args"][3], "a b; c")
        self.assertEqual(captured["args"][4], "$(rm -rf /)")
        self.assertEqual(captured["args"][5], 'quote"d')

class TestBuildQualifiers(unittest.TestCase):
    def _ns(self, **over):
        base = dict(
            query="vector database", semantic=True, language=None, topic=None,
            min_stars=None, max_stars=None, pushed_since=None, created_since=None,
            include_forks=False, include_archived=False, license=None,
            owner=None, org=None, good_first_issues=False, help_wanted=False,
        )
        base.update(over)
        return argparse.Namespace(**base)
    def test_returns_list_of_strings(self):
        qs = find_repos.build_qualifiers(self._ns(query="vector database"))
        self.assertIsInstance(qs, list)
        self.assertTrue(all(isinstance(q, str) for q in qs))
    def test_multi_word_no_narrow_dual_scope(self):
        qs = find_repos.build_qualifiers(self._ns(query="vector database"))
        self.assertEqual(len(qs), 2)
        self.assertIn("in:readme", qs[0])
        self.assertNotIn("in:readme", qs[1])
    def test_narrowing_disables_dual_scope(self):
        qs = find_repos.build_qualifiers(self._ns(query="vector database", language="python"))
        self.assertEqual(len(qs), 1)
        self.assertNotIn("in:readme", qs[0])
        self.assertIn("language:python", qs[0])
        self.assertIn("fork:false", qs[0])
        self.assertIn("archived:false", qs[0])
    def test_query_with_special_chars_kept_verbatim(self):
        q = 'multi "agent" framework; x'
        qs = find_repos.build_qualifiers(self._ns(query=q))
        # free-text query is preserved verbatim as one unit; filters are appended
        self.assertTrue(all(q in s for s in qs))
        self.assertIn("in:readme", qs[0])
        self.assertNotIn("in:readme", qs[1])
        self.assertIn("fork:false", qs[1])
    def test_shlex_quote_hint_helper(self):
        self.assertEqual(find_repos.shlex_quote("vector-db"), "vector-db")
        q = find_repos.shlex_quote('a "b" c')
        self.assertTrue(q.startswith('"'))
        self.assertTrue(q.endswith('"'))

if __name__ == "__main__":
    unittest.main()
