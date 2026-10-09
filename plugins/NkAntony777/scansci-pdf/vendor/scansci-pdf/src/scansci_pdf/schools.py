"""School database for multi-university WebVPN support."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

_DEFAULT_KEY = b"wrdvpnisthebest!"

_DATA_DIR = Path(__file__).parent / "data"
_DATA_FILE = _DATA_DIR / "webvpn.json"
_DATA_FILE_ENCRYPTED = _DATA_DIR / "webvpn.dat"


_schools_cache: list["SchoolEntry"] | None = None


@dataclass
class SchoolEntry:
    name: str
    province: str
    host: str
    key: bytes
    iv: bytes
    school_type: str = "webvpn"  # "webvpn", "easyconnect", "atrust", or "ezproxy"
    gateway: str = ""  # EasyConnect/aTrust gateway domain


def _load_db() -> dict:
    # Try encrypted .dat first (production)
    if _DATA_FILE_ENCRYPTED.exists():
        try:
            from ._core.instsci_core import decrypt_data
            encrypted = _DATA_FILE_ENCRYPTED.read_bytes()
            return json.loads(decrypt_data(encrypted))
        except Exception:
            pass  # Fall through to plaintext

    # Fallback to plaintext .json (development)
    if _DATA_FILE.exists():
        return json.loads(_DATA_FILE.read_text(encoding="utf-8"))

    return {}


def _parse_entry(name: str, province: str, info: dict) -> SchoolEntry | None:
    host = info.get("host", "").strip()
    if not host:
        return None
    if not host.startswith("http"):
        host = f"https://{host}"

    key_str = info.get("crypto_key", "")
    iv_str = info.get("crypto_iv", "")

    key = key_str.encode("utf-8") if key_str else _DEFAULT_KEY
    iv = iv_str.encode("utf-8") if iv_str else key

    school_type = info.get("type", "webvpn")
    gateway = info.get("gateway", "")

    return SchoolEntry(
        name=name, province=province, host=host,
        key=key, iv=iv, school_type=school_type, gateway=gateway,
    )


def list_schools() -> list[SchoolEntry]:
    global _schools_cache
    if _schools_cache is not None:
        return _schools_cache
    db = _load_db()
    result = []
    for province, schools in db.items():
        for name, info in schools.items():
            entry = _parse_entry(name, province, info)
            if entry:
                result.append(entry)
    _schools_cache = result
    return result


def search_schools(query: str) -> list[SchoolEntry]:
    query_lower = query.lower()
    results = []
    for entry in list_schools():
        if (query_lower in entry.name.lower()
                or query_lower in entry.province.lower()
                or query_lower in entry.host.lower()):
            results.append(entry)
    return results


def get_school(name: str) -> SchoolEntry:
    schools = list_schools()

    for s in schools:
        if s.name == name:
            return s

    matches = [s for s in schools if name in s.name]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        matches.sort(key=lambda s: len(s.name))
        return matches[0]

    for s in schools:
        if s.name in name:
            return s

    raise ValueError(f"School not found: '{name}'. Use instsci_schools to list.")
