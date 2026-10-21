"""Keep alternate school entry points consistent with the shared write gate."""

import asyncio

import pytest

from scansci_pdf import config, mcp_server, schools
from scansci_pdf.cli import main_commands


@pytest.fixture
def private_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(config, "CONFIG_FILE", tmp_path / "config.json")
    for key in ("output_dir", "cache_dir", "carsi_cookie_dir"):
        monkeypatch.setitem(config.DEFAULT_CONFIG, key, str(tmp_path / key))
    entry = schools.SchoolEntry("Fixture University", "Fixture", "https://gateway.example/", b"", b"")
    monkeypatch.setattr(schools, "search_schools", lambda query: [entry])
    monkeypatch.setattr(main_commands, "_apply_school_config", lambda cfg, query: (
        cfg.update(instsci_school=entry.name, instsci_base_url=entry.host), entry)[1])
    monkeypatch.setattr(main_commands, "_show_setup_check", lambda cfg: True)
    return entry


def test_alternate_mcp_school_requires_confirmation(private_config):
    result = asyncio.run(mcp_server.configure_school(private_config.name))
    assert "confirmation required" in result
    assert not config.CONFIG_FILE.exists()
    accepted = asyncio.run(mcp_server.configure_school(private_config.name, confirmed=True))
    assert "Configured school" in accepted
    before = config.CONFIG_FILE.read_bytes()
    unchanged = asyncio.run(mcp_server.configure_school(private_config.name))
    assert "Configured school" in unchanged
    assert config.CONFIG_FILE.read_bytes() == before


@pytest.mark.parametrize("confirmed", [False, 1, "true"])
def test_alternate_cli_school_refusal_leaves_config_unchanged(private_config, confirmed):
    with pytest.raises(ValueError, match="confirmation required"):
        main_commands.setup(school=private_config.name, email="", output_dir="", federated=False,
                            federated_school="", check=False, confirm_trust=confirmed)
    assert not config.CONFIG_FILE.exists()


def test_alternate_cli_school_propagates_explicit_confirmation(private_config):
    main_commands.setup(school=private_config.name, email="", output_dir="", federated=False,
                        federated_school="", check=False, confirm_trust=True)
    stored = config.load_config()
    assert stored["instsci_school"] == private_config.name
    assert stored["instsci_base_url"] == private_config.host
