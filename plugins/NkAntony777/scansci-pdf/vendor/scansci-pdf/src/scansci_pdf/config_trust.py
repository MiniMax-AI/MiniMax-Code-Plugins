"""Central trust policy: which configuration keys may change what runs.

One list, one validator, one write boundary. A browser binary and a paper
landing page are the same kind of object to this engine — attacker-influenced
input — with one difference: a binary *is code*. These keys therefore decide
which bytes get executed or which host gets contacted, so writing one is a
trust decision rather than a preference.

Two properties are enforced here and nowhere else:

1. **Confirmation at the write boundary.** :func:`enforce_trust_write` is called
   from :func:`scansci_pdf.config.update_config`, which is the actual
   persistence path for a single key. The MCP tool wrapper also checks, but a
   wrapper is one caller — the boundary is what every caller shares, including
   a direct ``update_config`` call that never goes through a tool.

2. **Format validity before anything is persisted.** An illegal value raises
   instead of being written, so a malformed pin can never silently degrade into
   "no pin recorded" downstream (which would leave a cached binary trusted).

Both checks raise *before* the config file is touched, so a refused write
leaves the file and the effective trust outcome exactly as they were.
"""

from __future__ import annotations

import json
import re
from typing import Any

# The provenance digest pin table. Its value decides whether a given file's
# bytes may be executed, which is the strongest statement available offline.
BROWSER_DIGEST_KEY = "browser_binary_sha256"

# Every setting whose value decides which code runs or which host is contacted.
# One list: callers ask :func:`is_trust_sensitive` instead of re-declaring a
# subset, so a new trust key cannot silently escape confirmation.
TRUST_SENSITIVE_KEYS: frozenset[str] = frozenset({
    BROWSER_DIGEST_KEY,          # which bytes are approved to run
    "browser_executable",        # which binary the launcher is told to start
    "browser_login_target_url",   # authorized credential destination
    "browser_backend",           # which browser implementation is loaded
    "browser_auto_upgrade",      # whether an auto-detected binary may be adopted
    "browser_persist_localstorage",  # site storage kept across launches
    "network_proxy",             # egress
    "proxy_pool",                # egress, per-request rotation
    "tor_proxy",                 # egress
    "flaresolverr_url",          # host that executes JS on our behalf
    "camofox_url",               # host that executes JS on our behalf
})

_CONFIRMATION_HINT = (
    "Explicit owner confirmation required: '{key}' decides what code this "
    "engine runs or which host it contacts. Re-send with confirmed=True to "
    "apply it deliberately."
)

# A SHA-256 is exactly 64 lowercase/uppercase hex characters. Anything else is
# a typo or a truncated value, and a truncated value must never be stored as if
# it were a real pin.
_SHA256_HEX = re.compile(r"^[0-9a-fA-F]{64}$")


def is_trust_sensitive(key: str) -> bool:
    """Whether writing this key is a trust change needing confirmation."""
    return str(key) in TRUST_SENSITIVE_KEYS


def _require_digest(value: Any, label: str) -> str:
    """Return a normalized 64-hex digest, or raise :class:`ValueError`."""
    if not isinstance(value, str):
        raise ValueError(
            f"{label}: a browser digest must be a 64-character SHA-256 hex "
            f"string, got {type(value).__name__}"
        )
    text = value.strip()
    if not _SHA256_HEX.match(text):
        raise ValueError(
            f"{label}: '{text[:80]}' is not a 64-character SHA-256 hex digest"
        )
    return text.lower()


def normalize_browser_digests(value: Any) -> dict[str, str] | str:
    """Validate and normalize the digest pin table.

    Supported shapes:

    * ``{}`` / ``None`` / ``""`` — no pins recorded (clears the table)
    * ``{"<program path or launcher name>": "<64 hex>"}`` — each digest is
      *bound to that program*, which is the strongest form
    * ``"<64 hex>"`` — an approved-digest semantic: exactly these bytes may
      run, wherever the program is found

    Any other shape (a list, an integer, a non-hex string, a dict whose values
    are not digests) raises, so a malformed value is never persisted and never
    silently read back as "no pin".
    """
    if value is None:
        return {}
    if isinstance(value, dict):
        pins: dict[str, str] = {}
        for target, digest in value.items():
            if not isinstance(target, str) or not target.strip():
                raise ValueError(
                    f"{BROWSER_DIGEST_KEY}: each pin must name the program it "
                    f"applies to, got {target!r}"
                )
            pins[target.strip()] = _require_digest(
                digest, f"{BROWSER_DIGEST_KEY}[{target!r}]"
            )
        return pins
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return {}
        if text.startswith("{"):
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"{BROWSER_DIGEST_KEY}: not valid JSON: {exc}"
                ) from exc
            if not isinstance(parsed, dict):
                raise ValueError(
                    f"{BROWSER_DIGEST_KEY}: a JSON pin table must be an object "
                    f"of program -> digest, got {type(parsed).__name__}"
                )
            return normalize_browser_digests(parsed)
        return _require_digest(text, BROWSER_DIGEST_KEY)
    raise ValueError(
        f"{BROWSER_DIGEST_KEY}: unsupported pin shape {type(value).__name__}; "
        "use {} or {'<program>': '<64 hex sha256>'}"
    )


def normalize_trust_value(key: str, value: Any) -> Any:
    """Validate a trust key's value, raising :class:`ValueError` if illegal.

    Applies whether or not the change was confirmed: an illegal value is
    always a bug or an attack, never something to persist.
    """
    if key == BROWSER_DIGEST_KEY:
        return normalize_browser_digests(value)
    if value is None:
        return ""
    return str(value)


def enforce_trust_write(
    key: str,
    value: Any,
    *,
    confirmed: bool,
    current: Any = None,
) -> Any:
    """Validate and confirmation-check a trust key write.

    Returns the normalized value to persist. Raises :class:`ValueError` — before
    any write — when the value is malformed, or when it would change trust
    without explicit confirmation.

    Writing the value that is already stored is not a trust change and is
    allowed, so reading back and re-saving a config stays a no-op.
    """
    if not is_trust_sensitive(key):
        return value

    normalized = normalize_trust_value(key, value)
    if normalized == current:
        return normalized

    from .security import strict_mode

    if strict_mode() and confirmed is not True:
        raise ValueError(_CONFIRMATION_HINT.format(key=key))
    return normalized
