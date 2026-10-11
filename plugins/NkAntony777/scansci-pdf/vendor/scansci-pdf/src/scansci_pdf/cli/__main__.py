"""Allow running the CLI as ``python -m scansci_pdf.cli``.

This is the ``--module scansci_pdf.cli`` entry of ``run_secure.py`` — the child
process the session broker is spawned as (``session-broker-run``, ``--help``,
and every other command registered on the Typer app in ``_cli_core``).

``runpy.run_module`` executes a PACKAGE by running its ``__main__`` submodule.
The commands live on the Typer app re-exported from ``cli/__init__.py``, but
without this file nothing ever calls it, so the module entry died with
``No module named scansci_pdf.cli.__main__`` even though the commands were
registered all along.
"""

from __future__ import annotations

from scansci_pdf.cli import app

if __name__ == "__main__":
    app()
