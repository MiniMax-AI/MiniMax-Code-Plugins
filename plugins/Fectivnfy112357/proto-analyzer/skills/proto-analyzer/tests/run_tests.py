#!/usr/bin/env python3
"""Run proto-analyzer regression tests (stdlib unittest; no network, no browser).

Usage:  python run_tests.py                       (from the tests/ directory)
        python -m unittest discover -s tests -p "test_*.py"
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(HERE, pattern="test_*.py")
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
