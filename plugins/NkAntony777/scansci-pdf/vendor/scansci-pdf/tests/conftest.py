"""Ensure tests import the repo's own source tree, not an installed copy."""
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
import os

os.environ.setdefault("SCANSCI_PROGRESS_BAR", "0")  # pytest 不得弹出 GUI

import pytest


@pytest.fixture(autouse=True)
def isolated_secret_registry():
    from scansci_pdf import proxy_redaction
    proxy_redaction._SECRETS.clear()
    yield
    proxy_redaction._SECRETS.clear()
    import atexit
    login = sys.modules.get("scansci_pdf.browser_login")
    if login:
        atexit.unregister(login._browser.close)
