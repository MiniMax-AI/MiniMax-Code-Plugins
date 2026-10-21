"""Configuration management for ScanSci PDF."""

from __future__ import annotations

import json
from copy import deepcopy
import os
import re
from pathlib import Path
from typing import Any
from .security import secure_write_text, strict_mode, workspace_path, no_symlinks
from .config_trust import (
    TRUST_BOOL_KEYS,
    TRUST_SENSITIVE_KEYS,
    enforce_trust_write,
    is_trust_sensitive,
    normalize_trust_value,
)

DATA_DIR = Path(os.environ.get("SCANSCI_PDF_DATA_DIR", str(Path.home() / ".scansci-pdf")))
CONFIG_FILE = DATA_DIR / "config.json"

DEFAULT_SCIHUB_DOMAINS = [
    # Direct PDF mirrors (no CAPTCHA, PDF via sci.bban.top iframe) — verified 2026-07
    # vg/al 现为 Turnstile 门/首页壳（2026-08-31 实测），保留用于人工点一次模式
    "https://sci-hub.vg",
    "https://sci-hub.al",
    "https://sci-hub.mk",
    # 2026-08-31 深夜直连实测新增：bz/mksa 稳定出文章页（iframe PDF，无验证墙）
    "https://sci-hub.bz",
    "https://sci-hub.mksa.top",
    # ALTCHA-protected (stable; used as manual-download hint)
    "https://sci-hub.ru",
    "https://sci-hub.ee",
    # Cloudflare-protected (requires CloakBrowser JS challenge bypass)
    "https://sci-hub.st",
    # Reported intermittent (2026-06); kept but deprioritized
    "https://sci-hub.mksa.top",
    # Legacy (currently down, kept for future recovery)
    "https://sci-hub.se",
    "https://sci-hub.is",
    "https://sci-hub.41610.org",
]

DEFAULT_CONFIG: dict[str, Any] = {
    "email": "scansci-pdf@example.invalid",
    "output_dir": str(DATA_DIR / "papers"),
    "cache_dir": str(DATA_DIR / "cache"),
    "network_proxy": "",
    "proxy_pool": "",  # 逗号分隔的代理列表；非空时批量下载按代理轮换出口 IP
    "download_strategy": "fastest",  # fastest / grey_only(all 3 grey) / scihub_only(Sci-Hub only) / scihub_first / oa_first / legal_only
    "race_mode": "hedge",  # hedge: score-ordered staggered cascade (fewer requests, less anti-bot heat) / full: flat parallel race
    "hedge_delay_seconds": 1.5,  # hedged cascade: wait this long before widening to the next lane
    "batch_default_lanes": True,  # batch downloads default to pretriage + channel-lane scheduling (fast HTTP -> grey -> institutional)
    "lane_s2_batch_min": 10,  # minimum batch size to enrich OA URLs via the S2 batch endpoint (500 ids/request)
    "lane_mdpi_cdn": True,  # fast lane: construct mdpi-res.com CDN URLs for 10.3390 DOIs (bypasses the bot-walled main site)
    "scihub_enabled": True,
    "scihub_domains": DEFAULT_SCIHUB_DOMAINS,
    "vpnsci_enabled": False,
    "vpnsci_school": "",
    "vpnsci_base_url": "",
    "vpnsci_cookie_file": "",
    "carsi_enabled": False,
    "carsi_idp_name": "",
    "ezproxy_enabled": False,
    "ezproxy_login_url": "",
    # 机构会话自愈：下载走机构渠道前自动校验 WebVPN/CARSI 会话，
    # 已过期时打开浏览器重新登录。仅当存在历史 cookie 且校验明确判定
    # 过期才触发；新用户或网络不可达绝不弹浏览器。
    "auto_relogin": True,
    "core_api_key": "",
    "openalex_api_key": "",
    "elsevier_api_key": "",
    "springer_api_key": "",  # Springer Nature Full Text API (TDM) — entitlement follows the institution (ORCID-affiliated key, needs a Springer subscription with TDM rights)
    "elsevier_insttoken": "",
    "connect_timeout": 15,
    "read_timeout": 30,
    "request_delay_min": 2.0,
    "request_delay_max": 5.0,
    "fixed_request_delay_enabled": False,
    "json_probe_cache_seconds": 3600,
    "cache_ttl_hours": 168,
    "parallel_sources": True,
    "parallel_probes": True,
    "batch_workers": 10,
    "batch_stagger_seconds": 0.3,
    "min_pdf_size_bytes": 10000,
    "browser_headless": False,
    "browser_humanize": True,
    # 浏览器后端：patchright（默认，Apache-2.0 开源 playwright fork，内核随本机 Chrome 自动更新）
    # 或 cloakbrowser（免费版内核卡 Chromium 146，作为可选回退）
    "browser_backend": "patchright",
    # 批量下载时每 N 篇回收一次浏览器上下文（cookie 内存交接，登录态不丢）。
    # 0 = 关闭。长批次（上千篇）建议 100-200，避免 Chrome 长会话内存漂移。
    "browser_restart_every": 0,
    # 批量下载成功后自动抓取附件/补充材料（SI）。默认关——大多数任务只要主 PDF。
    # 开启后成功论文会尝试抓取出版商补充材料，存为 {DOI}_SI{n}.{ext}，并写 si_manifest.json。
    "fast_retry_wait_sec": 60,
    # 冷却重试期间的逐篇间隔（秒）。实测 15s/篇可 100% 绕开 Elsevier API 限流。
    "fast_retry_delay_sec": 15,
    # 任务启动时自动弹出悬浮进度条（独立进程，已有实例则不重复弹出）。
    "progress_bar_auto": True,
    # Turnstile 交互门（如 sci-hub.vg）：无头会话下无法点击，默认跳过并冷却。
    # scihub_browser_headless=false 时可开启人工点一次模式（点一次整批复用）。
    "scihub_turnstile_click": True,
    "turnstile_wait_sec": 180,
    # 机构级联并行 fetcher 数（各持独立登录会话）。默认 1 = 串行；2 可省约一半
    # Phase 2 时间，代价是同 IP 双浏览器会话。
    "institutional_workers": 1,
    # 灰色源竞速浏览器的独立无头开关（只影响 sci-hub 竞速，机构登录仍有可见窗口）。
    # true = 竞速全程零窗口、零任务栏闪烁；指纹安全性由 UA 清洗保证。
    "scihub_browser_headless": False,
    "scihub_browser_first": True,  # false = pure-HTTP Sci-Hub lane (use when the PDF CDN challenges headless browsers but serves plain requests)
    # 浏览器内核选择（CloakBrowser 免费版内置 Chromium 146 已过老，遇 Cloudflare Turnstile 会反复验证）：
    #   browser_executable: 显式指定浏览器二进制路径（本机 Chrome/Edge）；留空=自动探测
    #   browser_auto_upgrade: True 时自动探测本机 Chrome/Edge（版本 > 146 优先于内置 stealth Chromium）
    "browser_executable": "",
    "browser_auto_upgrade": True,
    "remote_assist_lan": False,
    # 浏览器二进制指纹钉死表：{"<绝对路径或启动器名>": "<64 位 sha256>"}。
    # 它决定「哪些字节可以被执行」，因此属于信任设置：改动它必须经所有者
    # 显式确认，且只有规范的 SHA-256 十六进制值会被接受。
    # Provenance digest pins: which bytes may be executed. Trust setting —
    # changing it needs explicit owner confirmation (see TRUST_SENSITIVE_KEYS).
    "browser_binary_sha256": {},
    "is_campus_network": False,
    "tor_proxy": os.environ.get("TOR_PROXY", ""),
    "tor_use_bridges": False,
    "use_tor_for_scihub": True,
    "google_scholar_limit": 5,
    "max_browser_workers": 1,
    "scihub_browser_workers": 3,  # Number of Sci-Hub domains to race in parallel via browser
    "host_concurrency": {},
    "auto_rename": True,
    "zotero_api_key": "",
    "zotero_library_type": "user",
    "zotero_library_id": "",
    "flaresolverr_url": "http://127.0.0.1:8191/v1",
    "cookie_path": "",
    "chrome_profile_dir": "",
    "carsi_cookie_dir": "",
    # Persist browser localStorage (bearer tokens per origin) in
    # browser_state.json. SECURITY toggle: off by default, and the string
    # "false" must stay off — never resolved through bool(value).
    "browser_persist_localstorage": False,
    # The publisher/institution origin a browser login is authorized to
    # persist credentials for. Cookies outside this target are neither saved
    # nor restored.
    "browser_login_target_url": "",
}

# Config keys that are security toggles rather than preferences. They share
# one parser across load, write and migration, and any value that is not
# unambiguously a boolean resolves OFF (fail closed).
SECURITY_BOOL_KEYS = TRUST_BOOL_KEYS

_BOOL_TRUE_LITERALS = frozenset({"true", "1", "yes", "on"})
_BOOL_FALSE_LITERALS = frozenset({"false", "0", "no", "off", ""})


def parse_config_bool(value: Any) -> bool | None:
    """Parse a config boolean, or ``None`` when the value is not one.

    The single parser for reads, writes and migrations. ``bool("false")`` is
    ``True`` in Python, which is how a security toggle silently turns itself
    on; here a string is true only when it is one of the canonical literals
    (case- and whitespace-insensitive) and false only when it likewise is.
    Anything else is ``None`` — meaning "not a boolean".
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _BOOL_TRUE_LITERALS:
            return True
        if text in _BOOL_FALSE_LITERALS:
            return False
        return None
    return None


def config_bool(key: str, value: Any, default: bool = False) -> bool:
    """Fail-closed boolean read for a config key.

    An unknown type or an unrecognized literal yields ``default``, which is
    ``False`` for every toggle in :data:`SECURITY_BOOL_KEYS`.
    """
    parsed = parse_config_bool(value)
    if parsed is None:
        return default
    return parsed



def _load_raw_config() -> dict[str, Any]:
    config = deepcopy(DEFAULT_CONFIG)
    no_symlinks(CONFIG_FILE)
    if CONFIG_FILE.exists():
        try:
            with CONFIG_FILE.open("r", encoding="utf-8") as fh:
                existing = json.load(fh)
            if isinstance(existing, dict):
                config.update(existing)
        except Exception:
            pass
    for key, value in DEFAULT_CONFIG.items():
        config.setdefault(key, deepcopy(value))
    from .proxy_redaction import register_config_secrets
    register_config_secrets(config)
    return config


def load_config() -> dict[str, Any]:
    config = _load_raw_config()
    # Migration: a security toggle written before the schema declared its type
    # may sit in config.json as a STRING (and, worse, as the string "false",
    # which a naive truthiness test reads as ON). Normalize every toggle here
    # with the same parser the write path uses, so read/write/migration agree.
    for key in SECURITY_BOOL_KEYS:
        config[key] = normalize_trust_value(key, config.get(key))
    if strict_mode():
        for key in ("cache_dir", "output_dir"):
            config[key] = str(workspace_path(config[key]))
        for key in ("vpnsci_cookie_file", "instsci_cookie_file", "cookie_path", "chrome_profile_dir", "carsi_cookie_dir"):
            if config.get(key):
                config[key] = str(workspace_path(config[key]))
        from .proxy_transport import authorize_proxy
        for proxy in [config.get("network_proxy"), config.get("tor_proxy"), *parse_proxy_pool(config.get("proxy_pool"))]:
            if proxy:
                authorize_proxy(proxy)
    return config


def _validate_trust_values(config: dict[str, Any]) -> dict[str, Any]:
    """Return a normalized copy, rejecting malformed trust values before save.

    Shape validation precedes the trust-diff/confirmation gate in save_config.
    Neither single-key updates nor direct/bulk saves may bypass that gate.
    """
    normalized = dict(config)
    for key in TRUST_SENSITIVE_KEYS:
        if key in normalized:
            normalized[key] = normalize_trust_value(key, normalized[key])
    return normalized


def save_config(config: dict[str, Any], *, confirmed: bool = False) -> None:
    from .proxy_redaction import register_config_secrets
    register_config_secrets(config)
    normalized = _validate_trust_values(config)
    current = _load_raw_config()
    effective = {**deepcopy(DEFAULT_CONFIG), **normalized}
    for key in TRUST_SENSITIVE_KEYS:
        enforce_trust_write(key, effective.get(key), confirmed=confirmed, current=current.get(key))
    secure_write_text(CONFIG_FILE, json.dumps(normalized, indent=2, ensure_ascii=False))


_VALIDATION_RULES: dict[str, tuple[type, Any, Any]] = {
    # key: (type, min_value, max_value)
    "connect_timeout": (int, 1, 60),
    "read_timeout": (int, 1, 120),
    "request_delay_min": (float, 0.0, 30.0),
    "request_delay_max": (float, 0.0, 60.0),
    "json_probe_cache_seconds": (int, 0, 86400),
    "cache_ttl_hours": (int, 1, 8760),
    "batch_workers": (int, 1, 50),
    "batch_stagger_seconds": (float, 0.0, 10.0),
    "min_pdf_size_bytes": (int, 100, 1000000),
    "google_scholar_limit": (int, 1, 50),
}

_VALID_STRATEGIES = frozenset({"fastest", "scihub_first", "scihub_only", "grey_only", "oa_first", "legal_only"})


def update_config(key: str, value: str, confirmed: bool = False) -> dict[str, Any]:
    import warnings as _warnings

    config = load_config()
    from .proxy_redaction import register_config_secrets
    register_config_secrets({key: value})
    if strict_mode() and key == 'tor_install_confirmed':
        raise ValueError('Installation confirmation is per-call and cannot be persisted')
    if strict_mode() and key in {"output_dir", "cache_dir", "vpnsci_cookie_file", "instsci_cookie_file"}:
        value = str(workspace_path(value))
    if strict_mode() and key in {"network_proxy", "proxy_pool", "tor_proxy"}:
        from .proxy_transport import authorize_proxy
        for proxy in parse_proxy_pool(value):
            authorize_proxy(proxy)

    # Central trust policy, applied at the boundary every caller shares. A tool
    # wrapper can be bypassed by a direct ``update_config`` call; this cannot.
    # Raises before ``save_config``, so a refused write leaves both the config
    # file and the effective trust outcome untouched.
    trust_key = is_trust_sensitive(key)
    if trust_key:
        value = enforce_trust_write(
            key, value, confirmed=confirmed, current=config.get(key)
        )

    # Validate: warn on unknown keys
    if key not in DEFAULT_CONFIG:
        _warnings.warn(
            f"Unknown config key '{key}' — it will be stored but may have no effect. "
            f"Valid keys include: {', '.join(sorted(DEFAULT_CONFIG.keys()))}",
            stacklevel=2,
        )

    # Special handling for download_strategy
    if key == "download_strategy":
        value_lower = value.lower().strip()
        if value_lower not in _VALID_STRATEGIES:
            raise ValueError(
                f"Invalid download_strategy '{value}'. Valid options: {', '.join(sorted(_VALID_STRATEGIES))}"
            )
        config[key] = value_lower
        save_config(config, confirmed=confirmed)
        return config

    if key in config:
        if key in SECURITY_BOOL_KEYS:
            # Security toggles go through the shared parser, never through
            # the old `value.lower() in (...)` branch that also handled the
            # non-bool "false" string.
            config[key] = config_bool(key, value, bool(DEFAULT_CONFIG.get(key, False)))
        else:
            old_type = type(config[key])
            if old_type == bool:
                config[key] = parse_config_bool(value) is True
            elif old_type == int:
                try:
                    config[key] = int(value)
                except ValueError:
                    raise ValueError(f"Invalid integer value for '{key}': '{value}'")
            elif old_type == float:
                try:
                    config[key] = float(value)
                except ValueError:
                    raise ValueError(f"Invalid float value for '{key}': '{value}'")
            elif old_type == list:
                # Try JSON parse for list values (e.g. scihub_domains)
                try:
                    parsed = json.loads(value)
                    if isinstance(parsed, list):
                        config[key] = parsed
                    else:
                        raise ValueError(f"Expected a JSON list for '{key}', got {type(parsed).__name__}")
                except json.JSONDecodeError:
                    raise ValueError(
                        f"Invalid list value for '{key}'. Use JSON format, e.g.: '[\"https://sci-hub.vg\",\"https://sci-hub.al\"]'"
                    )
            else:
                config[key] = value
    else:
        config[key] = value

    if key in _VALIDATION_RULES:
        _, min_val, max_val = _VALIDATION_RULES[key]
        if config[key] < min_val or config[key] > max_val:
            config[key] = DEFAULT_CONFIG[key]

    save_config(config, confirmed=confirmed)
    return config


SENSITIVE_KEYS = [
    "core_api_key",
    "vpnsci_cookie_file",
    "zotero_api_key",
    "zotero_library_id",
    "elsevier_api_key",
    "elsevier_insttoken",
    "springer_api_key",
    "instsci_cookie_file",
]

# Canonical proxy-credential redaction, shared by every display boundary.
#
# ``*`` not ``+`` for the username: an empty username (``http://:pass@host``)
# is still a credential. ``:`` excluded so the FIRST colon splits user/pass,
# and the password part is greedy (but ``/``-free) so a password containing a
# colon is masked whole without swallowing a URL path.
_PROXY_URL_CREDS_RE = re.compile(r"(//[^/@\s:]*:)[^@/\s]+@")
# A scheme is optional in a user-typed proxy, so ``user:pass@host`` is a
# credential too. The password is required, which keeps ``bob@proxy:3128``
# (username only) and ``127.0.0.1:1080`` (no ``@``) untouched. ``(?<!/)``
# keeps this from re-entering the ``//`` form handled above.
_PROXY_BARE_CREDS_RE = re.compile(r"(?<![/\w])([^/@\s:]*:)[^@/\s]+@")


def mask_config_value(key: str, value: Any) -> Any:
    """Return a display-safe copy of a config value.

    Secrets (API keys, tokens, cookie files) are fully masked; proxy URLs keep
    host/port but hide the password (``http://user:***@host:port``). The
    schemeless ``user:pass@host`` form is masked as well.
    """
    if value is None:
        return value
    if key in SENSITIVE_KEYS or re.search(r"key|token|secret|password|cookie|credential", key, re.I):
        return "***"
    if "proxy" in key.lower() and isinstance(value, str) and "@" in value:
        masked = _PROXY_URL_CREDS_RE.sub(r"\1***@", value)
        return _PROXY_BARE_CREDS_RE.sub(r"\1***@", masked)
    return value


def get_config_safe() -> dict[str, Any]:
    config = load_config()
    from .proxy_redaction import redact_proxy_structure
    return redact_proxy_structure({key: mask_config_value(key, value) for key, value in config.items()})


def parse_proxy_pool(value: str | None) -> list[str]:
    """Parse a comma-separated proxy list into a deduplicated list.

    Accepts forms like ``"socks5://1.1.1.1:1080, http://2.2.2.2:8080"`` and
    returns ``["socks5://1.1.1.1:1080", "http://2.2.2.2:8080"]``. Empty/blank
    entries are dropped. Order is preserved; duplicates removed.
    """
    if not value:
        return []
    seen: set[str] = set()
    proxies: list[str] = []
    for token in str(value).split(","):
        proxy = token.strip()
        if proxy and proxy not in seen:
            seen.add(proxy)
            proxies.append(proxy)
    return proxies
