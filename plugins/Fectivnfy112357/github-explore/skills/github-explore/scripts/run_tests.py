#!/usr/bin/env python3
"""Run github-explore regression tests (stdlib unittest; no network, no gh).

Usage:  python run_tests.py                  (from the scripts/ directory)
        python -m unittest discover -s tests -p "test_*.py"
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # scripts/ dir so `import _lib` etc. resolve

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(os.path.join(HERE, "tests"), pattern="test_*.py")
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
