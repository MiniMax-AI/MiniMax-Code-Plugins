from __future__ import annotations

from contextlib import redirect_stdout
import io
import json

from scansci_pdf import main, search


def test_search_json_is_ascii_safe_and_contains_author_match(monkeypatch):
    monkeypatch.setattr(
        search,
        "search_papers",
        lambda *args, **kwargs: [
            {
                "title": "Soil ı study",
                "doi": "10.1234/example",
                "authors": ["Pınar Reich"],
                "_author_match": {
                    "name": "Pınar Reich",
                    "id": "A123",
                    "works_count": 10,
                    "cited_by_count": 20,
                },
            }
        ],
    )
    raw = io.BytesIO()
    ascii_stdout = io.TextIOWrapper(raw, encoding="ascii", errors="strict")

    with redirect_stdout(ascii_stdout):
        main.search_cmd(
            query="",
            limit=10,
            year_from=None,
            year_to=None,
            sort="cited_by_count",
            json_output=True,
            author="Pınar Reich",
            author_id="",
        )
    ascii_stdout.flush()
    output = raw.getvalue().decode("ascii")
    payload = json.loads(output)

    assert payload["results"][0]["title"] == "Soil ı study"
    assert payload["author_match"]["name"] == "Pınar Reich"


# --- D64-12: one Web startup, shared by both CLI entries ------------------


def test_web_startup_options_contract():
    """The shared launch arguments, so a future change is made in one place."""
    from scansci_pdf import web

    options = web.web_startup_options("127.0.0.1", 8081)

    assert options["host"] == "127.0.0.1"
    assert options["port"] == 8081
    # The full request target would put a ?t= hand-off URL in the log verbatim.
    assert options["access_log"] is False


def test_start_web_server_shows_the_operator_the_token_link(monkeypatch, capsys):
    """The token may be shown in first-access instructions; it must simply be
    the same instruction on both entry points, from the same function."""
    from scansci_pdf import web

    monkeypatch.setenv(web.TOKEN_ENV, "synthetic-operator-token")
    monkeypatch.setattr("uvicorn.run", lambda app, **kwargs: None)

    web.start_web_server("127.0.0.1", 8081)

    out = capsys.readouterr().out
    assert "http://127.0.0.1:8081/?t=synthetic-operator-token" in out
