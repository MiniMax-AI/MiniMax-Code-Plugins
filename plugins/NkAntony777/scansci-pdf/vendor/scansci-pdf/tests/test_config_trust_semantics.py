"""Trust comparisons must match the values that configuration consumers use."""

from __future__ import annotations

import json
from copy import deepcopy

import pytest

from scansci_pdf import browser_backend, config as cfg
from scansci_pdf.browser_login import localstorage_opt_in
from scansci_pdf import config_trust
from scansci_pdf.config_trust import TRUST_BOOL_KEYS, enforce_trust_write
from scansci_pdf.remote_assist import RemoteAssist
from scansci_pdf.security import SecurityError


@pytest.fixture
def private_config(tmp_path, monkeypatch):
    monkeypatch.setenv("SCANSCI_PDF_WORKSPACE", str(tmp_path))
    monkeypatch.setattr(cfg, "DATA_DIR", tmp_path / ".scansci-pdf")
    monkeypatch.setattr(cfg, "CONFIG_FILE", tmp_path / ".scansci-pdf" / "config.json")
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setitem(cfg.DEFAULT_CONFIG, "output_dir", str(tmp_path / "papers"))
    cfg.CONFIG_FILE.parent.mkdir()
    return tmp_path


def _assert_runtime_boolean(key, config, expected, monkeypatch):
    assert config[key] is expected
    if key == "browser_auto_upgrade":
        calls = []
        monkeypatch.delenv("CLOAKBROWSER_BINARY_PATH", raising=False)
        monkeypatch.setattr(browser_backend, "find_local_browser", lambda config: calls.append(config))
        assert browser_backend.resolve_browser_binary(config) is None
        assert bool(calls) is expected
    elif key == "browser_persist_localstorage":
        assert localstorage_opt_in(config[key]) is expected
    else:
        assert RemoteAssist._resolve_host(config, allow_lan=True) == (
            "0.0.0.0" if expected else "127.0.0.1"
        )


@pytest.mark.parametrize("key", sorted(TRUST_BOOL_KEYS))
def test_bulk_false_strings_are_persisted_as_disabled_booleans(private_config, monkeypatch, key):
    baseline = {**cfg.load_config(), key: False}
    cfg.save_config(baseline, confirmed=True)
    for value in (False, "false", "False", "  FALSE  ", "no", "off", "0", "",
                  "unknown", 1, None, [], {}):
        proposed = {**cfg.load_config(), key: value}
        cfg.save_config(proposed)
        assert proposed[key] == value
        assert json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))[key] is False
        _assert_runtime_boolean(key, cfg.load_config(), False, monkeypatch)


@pytest.mark.parametrize("key", sorted(TRUST_BOOL_KEYS))
def test_enabling_a_trust_boolean_still_requires_actual_confirmation(private_config, monkeypatch, key):
    cfg.save_config({**cfg.load_config(), key: False}, confirmed=True)
    before = cfg.CONFIG_FILE.read_bytes()
    for value in (True, "true", " TRUE ", "yes", "on", "1"):
        proposed = {**cfg.load_config(), key: value, "email": "must-not-partially-save@example.invalid"}
        for confirmation in (False, None, 1, "true"):
            with pytest.raises(ValueError, match="confirmation required"):
                cfg.save_config(proposed, confirmed=confirmation)
            assert cfg.CONFIG_FILE.read_bytes() == before
        with pytest.raises(ValueError, match="confirmation required"):
            cfg.update_config(key, value)
        assert cfg.CONFIG_FILE.read_bytes() == before
    cfg.save_config(proposed, confirmed=True)
    assert json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))[key] is True
    _assert_runtime_boolean(key, cfg.load_config(), True, monkeypatch)
    with pytest.raises(ValueError, match="confirmation required"):
        cfg.save_config({**cfg.load_config(), key: False})


@pytest.mark.parametrize("key", sorted(TRUST_BOOL_KEYS))
@pytest.mark.parametrize("value, expected", [("false", False), ("False", False), (" TRUE ", True)])
def test_legacy_boolean_migration_does_not_block_unrelated_saves(
    private_config, monkeypatch, key, value, expected,
):
    cfg.CONFIG_FILE.write_text(json.dumps({key: value}), encoding="utf-8")
    _assert_runtime_boolean(key, cfg.load_config(), expected, monkeypatch)
    cfg.update_config("email", "maintainer@example.invalid")
    stored = json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))
    assert stored[key] is expected
    assert stored["email"] == "maintainer@example.invalid"
    cfg.save_config(cfg.load_config())
    _assert_runtime_boolean(key, cfg.load_config(), expected, monkeypatch)


@pytest.mark.parametrize("key", sorted(TRUST_BOOL_KEYS))
@pytest.mark.parametrize("value", ["unknown", 1, None])
def test_invalid_legacy_boolean_values_migrate_fail_closed(private_config, monkeypatch, key, value):
    cfg.CONFIG_FILE.write_text(json.dumps({key: value}), encoding="utf-8")
    _assert_runtime_boolean(key, cfg.load_config(), False, monkeypatch)
    cfg.save_config(cfg.load_config())
    assert json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))[key] is False


def test_declared_auto_upgrade_default_remains_enabled(private_config):
    assert cfg.load_config()["browser_auto_upgrade"] is True


def test_relative_profile_migration_allows_bulk_and_single_key_noops(private_config):
    cfg.CONFIG_FILE.write_text(json.dumps({"chrome_profile_dir": "profiles"}), encoding="utf-8")
    absolute = str(private_config / "profiles")
    assert cfg.load_config()["chrome_profile_dir"] == absolute
    cfg.update_config("email", "maintainer@example.invalid")
    assert json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))["chrome_profile_dir"] == absolute
    cfg.update_config("chrome_profile_dir", "profiles")
    cfg.save_config({**cfg.load_config(), "chrome_profile_dir": "profiles/../profiles"})
    assert cfg.load_config()["chrome_profile_dir"] == absolute


def test_legacy_profile_and_booleans_migrate_in_one_unrelated_save(private_config):
    legacy = {key: "false" for key in TRUST_BOOL_KEYS}
    legacy["chrome_profile_dir"] = "profiles"
    cfg.CONFIG_FILE.write_text(json.dumps(legacy), encoding="utf-8")
    cfg.update_config("email", "maintainer@example.invalid")
    stored = json.loads(cfg.CONFIG_FILE.read_text(encoding="utf-8"))
    assert all(stored[key] is False for key in TRUST_BOOL_KEYS)
    assert stored["chrome_profile_dir"] == str(private_config / "profiles")


@pytest.mark.parametrize("confirmation", [False, None, 1, "true"])
def test_profile_destination_changes_remain_atomic_and_confirmed(private_config, confirmation):
    cfg.CONFIG_FILE.write_text(json.dumps({"chrome_profile_dir": "profiles"}), encoding="utf-8")
    before = cfg.CONFIG_FILE.read_bytes()
    proposed = {**cfg.load_config(), "chrome_profile_dir": "other-profile", "email": "not-saved@example.invalid"}
    with pytest.raises(ValueError, match="confirmation required"):
        cfg.save_config(proposed, confirmed=confirmation)
    assert cfg.CONFIG_FILE.read_bytes() == before
    with pytest.raises(ValueError, match="confirmation required"):
        cfg.update_config("chrome_profile_dir", "other-profile", confirmed=confirmation)
    assert cfg.CONFIG_FILE.read_bytes() == before
    cfg.save_config(proposed, confirmed=True)
    assert cfg.load_config()["chrome_profile_dir"] == str(private_config / "other-profile")


def test_bulk_profile_escape_is_rejected_even_when_confirmed(private_config):
    cfg.save_config(cfg.load_config())
    before = cfg.CONFIG_FILE.read_bytes()
    with pytest.raises(SecurityError, match="trusted workspace"):
        cfg.save_config({**cfg.load_config(), "chrome_profile_dir": "../outside"}, confirmed=True)
    assert cfg.CONFIG_FILE.read_bytes() == before


@pytest.mark.parametrize("method", ["update", "bulk"])
def test_corrupt_stored_pin_requires_confirmation_but_can_be_repaired(private_config, method):
    corrupt = {"chrome.exe": "not-a-sha256"}
    replacement = {"chrome.exe": "ab" * 32}
    cfg.CONFIG_FILE.write_text(json.dumps({"browser_binary_sha256": corrupt}), encoding="utf-8")
    before = cfg.CONFIG_FILE.read_bytes()

    def repair(confirmed):
        if method == "update":
            cfg.update_config("browser_binary_sha256", json.dumps(replacement), confirmed=confirmed)
        else:
            cfg.save_config({**cfg.load_config(), "browser_binary_sha256": replacement,
                             "email": "repaired@example.invalid"}, confirmed=confirmed)

    for confirmation in (False, None, 1, "true"):
        with pytest.raises(ValueError, match="confirmation required"):
            repair(confirmation)
        assert cfg.CONFIG_FILE.read_bytes() == before
    repair(True)
    assert cfg.load_config()["browser_binary_sha256"] == replacement
    cfg.save_config(cfg.load_config())


@pytest.mark.parametrize("method", ["update", "bulk"])
def test_corrupt_stored_pin_does_not_permit_invalid_replacement(private_config, method):
    corrupt = {"chrome.exe": "not-a-sha256"}
    cfg.CONFIG_FILE.write_text(json.dumps({"browser_binary_sha256": corrupt}), encoding="utf-8")
    before = cfg.CONFIG_FILE.read_bytes()
    for confirmation in (False, True):
        with pytest.raises(ValueError, match="SHA-256 hex digest"):
            if method == "update":
                cfg.update_config("browser_binary_sha256", json.dumps(corrupt), confirmed=confirmation)
            else:
                cfg.save_config({**cfg.load_config(), "browser_binary_sha256": corrupt}, confirmed=confirmation)
        assert cfg.CONFIG_FILE.read_bytes() == before


def test_refused_stored_profile_can_be_repaired_by_confirmed_bulk_save(private_config):
    cfg.CONFIG_FILE.write_text(json.dumps({"chrome_profile_dir": "../outside"}), encoding="utf-8")
    before = cfg.CONFIG_FILE.read_bytes()
    proposed = {**cfg.DEFAULT_CONFIG, "chrome_profile_dir": "profiles"}
    for confirmation in (False, None, 1, "true"):
        with pytest.raises(ValueError, match="confirmation required"):
            cfg.save_config(proposed, confirmed=confirmation)
        assert cfg.CONFIG_FILE.read_bytes() == before
    cfg.save_config(proposed, confirmed=True)
    assert cfg.load_config()["chrome_profile_dir"] == str(private_config / "profiles")


def test_current_normalization_does_not_swallow_unexpected_errors(private_config, monkeypatch):
    normalize = config_trust.normalize_trust_value

    def unexpected(key, value):
        if value == "unexpected-current":
            raise RuntimeError("unexpected normalization failure")
        return normalize(key, value)

    monkeypatch.setattr(config_trust, "normalize_trust_value", unexpected)
    with pytest.raises(RuntimeError, match="unexpected normalization failure"):
        enforce_trust_write("browser_backend", "camoufox", current="unexpected-current", confirmed=True)


def test_in_place_pin_change_cannot_mutate_defaults_or_bypass_confirmation(private_config):
    defaults = deepcopy(cfg.DEFAULT_CONFIG)
    proposed = cfg.load_config()
    proposed["browser_binary_sha256"]["chrome.exe"] = "ab" * 32
    assert cfg.DEFAULT_CONFIG == defaults
    assert cfg.load_config()["browser_binary_sha256"] == defaults["browser_binary_sha256"]
    for confirmation in (False, None, 1, "true"):
        with pytest.raises(ValueError, match="confirmation required"):
            cfg.save_config(proposed, confirmed=confirmation)
        assert not cfg.CONFIG_FILE.exists()
        assert cfg.DEFAULT_CONFIG == defaults
    cfg.save_config(proposed, confirmed=True)
    assert cfg.load_config()["browser_binary_sha256"] == {"chrome.exe": "ab" * 32}
    assert cfg.DEFAULT_CONFIG == defaults


@pytest.mark.parametrize("key", [
    key for key, value in cfg.DEFAULT_CONFIG.items() if isinstance(value, (dict, list))
])
def test_loaded_mutable_defaults_are_independent(private_config, key):
    defaults = deepcopy(cfg.DEFAULT_CONFIG[key])
    first = cfg.load_config()
    second = cfg.load_config()
    assert first[key] is not second[key]
    assert first[key] is not cfg.DEFAULT_CONFIG[key]
    if isinstance(first[key], dict):
        first[key]["synthetic-marker"] = {"nested": ["changed"]}
    else:
        first[key].append({"nested": ["changed"]})
    assert cfg.DEFAULT_CONFIG[key] == defaults
    assert second[key] == defaults
    assert cfg.load_config()[key] == defaults
