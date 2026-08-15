"""Review point 4: pagination and rate-limit (403/429) failure handling."""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import explore
import org_landscape
from _fixtures import FakeProc

def _run_factory(responses):
    calls = []
    def fake_run(args, **kwargs):
        calls.append(args)
        idx = min(len(calls) - 1, len(responses) - 1)
        return responses[idx]
    return fake_run, calls

class TestGhSearchWithRetry(unittest.TestCase):
    def setUp(self):
        self._sleep = explore.time.sleep
        explore.time.sleep = lambda s: None
    def tearDown(self):
        explore.time.sleep = self._sleep
    def test_retries_on_rate_limit_then_succeeds(self):
        responses = [
            FakeProc(returncode=1, stderr="API rate limit exceeded"),
            FakeProc(returncode=1, stderr="HTTP 429"),
            FakeProc(returncode=0, stdout='[{"fullName": "a/b"}]'),
        ]
        fake_run, calls = _run_factory(responses)
        with mock.patch.object(explore.subprocess, 'run', side_effect=fake_run), mock.patch.object(explore, 'warn') as w:
            out = explore._gh_search_with_retry(["search", "repos", "x"])
        self.assertEqual(len(calls), 3)
        self.assertEqual(out, [{"fullName": "a/b"}])
        w.assert_called()
    def test_gives_up_after_max_attempts_on_rate_limit(self):
        responses = [FakeProc(returncode=1, stderr="rate limit exceeded")] * 5
        fake_run, calls = _run_factory(responses)
        with mock.patch.object(explore.subprocess, 'run', side_effect=fake_run), mock.patch.object(explore, 'warn'):
            out = explore._gh_search_with_retry(["search", "repos", "x"], max_attempts=3)
        self.assertEqual(len(calls), 3)
        self.assertEqual(out, [])
    def test_non_rate_limit_error_returns_empty_immediately(self):
        fake_run, calls = _run_factory([FakeProc(returncode=1, stderr="not found")])
        with mock.patch.object(explore.subprocess, 'run', side_effect=fake_run), mock.patch.object(explore, 'warn'):
            out = explore._gh_search_with_retry(["search", "repos", "x"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(out, [])

class TestOrgLandscapePagination(unittest.TestCase):
    def test_fetches_all_pages_in_order(self):
        ORG = "vercel"
        def fake_gh_json(args, timeout=90):
            url = args[1] if len(args) > 1 else ""
            if url == "/orgs/%s" % ORG:
                return {"public_repos": 250, "is_missing": None}
            if url.startswith("/orgs/%s/repos?per_page=100&page=" % ORG):
                page = int(url.split("&page=")[1].split("&")[0])
                n = 100 if page < 3 else 50
                return [{"fullName": "vercel/r%d-%d" % (page, i), "stargazersCount": i} for i in range(n)]
            return []
        with mock.patch.object(org_landscape, 'gh_json', side_effect=fake_gh_json), mock.patch.object(org_landscape, 'warn'):
            out = org_landscape.fetch_all_repos_via_api(ORG, max_workers=1)
        self.assertEqual(len(out), 250)
        self.assertEqual(out[0]["fullName"], "vercel/r1-0")
        self.assertEqual(out[100]["fullName"], "vercel/r2-0")
        self.assertEqual(out[200]["fullName"], "vercel/r3-0")

if __name__ == "__main__":
    unittest.main()
