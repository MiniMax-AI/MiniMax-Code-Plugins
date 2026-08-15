"""Review point 4: the configured `timeout` is passed through to
`urllib.request.urlopen`. We mock urlopen and inspect the call.
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import search
from _fixtures import FakeResponse


def _run_main(load_config_return, argv=("search.py", "q")):
    """Run `search.main()` with all network/config side effects mocked,
    and return the urlopen mock so the test can inspect its call args."""
    u = mock.Mock(return_value=FakeResponse(b'{"results":[]}'))
    with mock.patch.object(sys, "argv", list(argv)), \
         mock.patch.object(search, "load_config", return_value=load_config_return), \
         mock.patch.object(search, "build_request", return_value=mock.Mock()), \
         mock.patch.object(search.urllib.request, "urlopen", u), \
         mock.patch.object(search.sys, "exit", side_effect=SystemExit):
        try:
            search.main()
        except SystemExit:
            pass
    return u


class TestTimeoutConfig(unittest.TestCase):
    def test_default_timeout_is_30(self):
        u = _run_main({"base_url": "https://x"})
        self.assertEqual(u.call_args.kwargs.get("timeout"), 30)

    def test_custom_timeout_is_passed_through(self):
        u = _run_main({"base_url": "https://x", "timeout": 7})
        self.assertEqual(u.call_args.kwargs.get("timeout"), 7)


if __name__ == "__main__":
    unittest.main()
