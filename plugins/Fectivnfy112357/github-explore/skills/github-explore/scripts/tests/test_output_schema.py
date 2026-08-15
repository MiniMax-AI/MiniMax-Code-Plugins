"""Review point 4: --format json output matches the documented schemas.

find_repos uses camelCase PLURAL fields at top level; repo_summary nests
data under 'repo' with SINGULAR fields; explore nests repos under axes[i].repos[j].
"""
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import explore
import find_repos
import repo_summary

REPO = {
    "fullName": "acme/vec-db",
    "description": "vector database in python",
    "stargazersCount": 1234,
    "forksCount": 56,
    "language": "Python",
    "pushedAt": "2026-08-01T00:00:00Z",
    "isArchived": False,
    "isFork": False,
    "url": "https://github.com/acme/vec-db",
    "license": {"key": "mit", "name": "MIT License", "url": "https://example.com"},
}

def run_main(module, argv):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.object(sys, 'argv', ['prog'] + argv), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = module.main()
    return code, out.getvalue(), err.getvalue()

class TestFindReposSchema(unittest.TestCase):
    def test_json_output_uses_camelcase_plural_fields(self):
        with mock.patch.object(find_repos, 'ensure_auth'), mock.patch.object(find_repos, 'gh_json', return_value=[REPO]):
            code, out, err = run_main(find_repos, ["vector database", "--format", "json"])
        rows = json.loads(out)
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertIn("fullName", row)
        self.assertIn("stargazersCount", row)
        self.assertIn("forksCount", row)
        self.assertNotIn("full_name", row)
        self.assertIn("_rel", row)

class TestRepoSummarySchema(unittest.TestCase):
    def test_json_output_nests_under_repo_with_singular_fields(self):
        view = {
            "nameWithOwner": "acme/vec-db", "name": "vec-db",
            "description": "vector database", "stargazerCount": 1234,
            "forkCount": 56, "watchers": 3,
            "primaryLanguage": {"name": "Python"},
            "languages": {"Python": 1000},
            "licenseInfo": {"key": "mit", "name": "MIT License"},
            "defaultBranchRef": {"name": "main"},
            "isArchived": False, "isFork": False,
            "createdAt": "2020-01-01T00:00:00Z",
            "updatedAt": "2026-08-01T00:00:00Z",
            "pushedAt": "2026-08-01T00:00:00Z",
            "url": "https://github.com/acme/vec-db",
            "owner": {"login": "acme"},
            "repositoryTopics": [], "latestRelease": None,
            "mentionableUsers": [],
        }
        def fake_gh_json(args, timeout=90):
            if args[0] == "repo":
                return view
            if args[0] == "api":
                if args[1] == "/repos/acme/vec-db":
                    return {"open_issues_count": 12}
                if args[1] == "/repos/acme/vec-db/languages":
                    return {"Python": 1000}
            if args[0] == "issue":
                return []
            if args[0] == "pr":
                return []
            return None
        with mock.patch.object(repo_summary, 'ensure_auth'), mock.patch.object(repo_summary, 'gh_json', side_effect=fake_gh_json):
            code, out, err = run_main(repo_summary, ["acme/vec-db", "--format", "json"])
        d = json.loads(out)
        self.assertIn("repo", d)
        self.assertEqual(d["repo"]["stargazerCount"], 1234)
        self.assertNotIn("stargazersCount", d["repo"])
        self.assertEqual(d["open_issues_count"], 12)

class TestExploreSchema(unittest.TestCase):
    def test_json_output_nests_repos_under_axes(self):
        with mock.patch.object(explore, 'ensure_auth'), mock.patch.object(explore, '_gh_search_with_retry', return_value=[REPO]), mock.patch.object(explore, 'canonical_anchors_for', return_value=set()), mock.patch.object(explore, 'annotate_results'), mock.patch.object(explore, 'backfill_canonical', return_value=[]), mock.patch.object(explore, 'axis_quality_metrics', return_value={}):
            code, out, err = run_main(explore, ["multi-agent", "--axis", "framework|multi-agent framework in:readme", "--format", "json"])
        d = json.loads(out)
        self.assertEqual(d["topic"], "multi-agent")
        self.assertIn("axes", d)
        self.assertEqual(d["axes"][0]["name"], "framework")
        self.assertEqual(d["axes"][0]["repos"][0]["fullName"], "acme/vec-db")

class TestSchemaFlag(unittest.TestCase):
    def test_find_repos_schema_flag_prints_contract(self):
        out = io.StringIO()
        with mock.patch.object(sys, "argv", ["find_repos.py", "--schema"]), contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit):
                find_repos.main()
        self.assertIn("fullName", out.getvalue())

if __name__ == "__main__":
    unittest.main()
