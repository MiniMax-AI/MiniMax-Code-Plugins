"""Institutional login via stealth browser. Replaces Selenium for WebVPN/CARSI/EZProxy login."""

from __future__ import annotations

import json
import time
import atexit
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

try:
    from .browser_backend import launch
    from .browser_backend import BACKEND_CAMOUFOX, BACKEND_CLOAKBROWSER, BACKEND_PATCHRIGHT
    from .browser_backend import is_available as _browser_backend_available
    _HAS_CLOAKBROWSER = any(
        _browser_backend_available(b)
        for b in (BACKEND_PATCHRIGHT, BACKEND_CLOAKBROWSER, BACKEND_CAMOUFOX)
    )
except ImportError:
    launch = None  # type: ignore[assignment]
    _HAS_CLOAKBROWSER = False
from .log import get_logger
from .browser_cookies import DEFAULT_LOGIN_TARGET_URL
from .security import secure_write_text

log = get_logger()

# localStorage holds bearer tokens for every origin the browser touched, so
# persisting it requires an explicit opt-in from the operator.
LOCALSTORAGE_OPT_IN_KEY = "browser_persist_localstorage"


def localstorage_opt_in(value: Any) -> bool:
    """True only for a real opt-in. The string ``"false"`` must stay off.

    Delegates to the shared config parser so this consumer, ``update_config``
    and the config-file migration resolve a toggle the same way. An
    unrecognized type or literal fails closed to OFF.
    """
    from .config import config_bool

    return config_bool(LOCALSTORAGE_OPT_IN_KEY, value, False)


def _default_login_target() -> str:
    """Fallback login target when the operator configured none.

    A code constant, not cache data: save and restore must agree on the same
    target, and both resolve it from config or this constant, never from the
    saved state file.
    """
    return DEFAULT_LOGIN_TARGET_URL


class PersistentBrowser:
    """Keeps a stealth browser alive across multiple operations.

    Login once, reuse the same browser for all subsequent downloads.
    The WebVPN session stays valid because the browser instance never closes.
    """

    def __init__(self):
        self._browser = None
        self._context = None
        self._page = None
        self._cookies_saved = False
        self._config_identity = None

    @property
    def is_alive(self) -> bool:
        if self._browser is None:
            return False
        try:
            self._page.url  # noqa: B018
            return True
        except Exception:
            self._cleanup()
            return False

    def get_page(self, config: dict[str, Any] | None = None):
        """Get or create the browser page. Returns (context, page)."""
        identity = json.dumps(config, sort_keys=True, default=str)
        if self.is_alive and self._config_identity == identity:
            return self._context, self._page
        if self.is_alive:
            self._cleanup()
        self._config_identity = identity
        return self._start(config)

    def _start(self, config: dict[str, Any] | None = None):
        """Start a new browser instance. Restores saved state if available."""
        if not _HAS_CLOAKBROWSER:
            raise RuntimeError("cloakbrowser not installed. Run: pip install cloakbrowser")
        log.info("   [browser] Starting persistent browser...")
        self._browser = launch(
            headless=False, humanize=True,
            args=["--disable-features=CrossOriginOpenerPolicy"],
            config=config,
        )
        self._context = self._browser.new_context()
        self._page = self._context.new_page()

        if config:
            self._restore_state(config)

        return self._context, self._page

    def _restore_state(self, config: dict[str, Any]):
        """Restore saved cookies and localStorage into the browser.

        The scope comes from the operator's config only — never from the
        ``target_url`` written inside the cache file. A cache file that names
        its own target could otherwise have any origin's cookies re-injected
        into this context, so ``state["target_url"]`` is used solely to check
        that the file was written for the target we are already authorized for.
        """
        from .config import DATA_DIR
        cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
        state_file = cache_dir / "browser_state.json"
        if not state_file.exists():
            return
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except Exception:
            log.info("   [browser] browser_state.json corrupted, starting fresh")
            return
        if not isinstance(state, dict):
            log.info("   [browser] browser_state.json is not an object, starting fresh")
            return

        from .browser_cookies import (
            DEFAULT_LOGIN_TARGET_URL,
            authorized_target_urls,
            credentials_for_target,
        )

        targets = authorized_target_urls(config) or [_default_login_target()]
        target_url = targets[0]

        cached_target = str(state.get("target_url") or "")
        if cached_target:
            cached_host = (urlparse(cached_target).hostname or "").lower()
            target_host = (urlparse(target_url).hostname or "").lower()
            if cached_host != target_host:
                log.info("   [browser] Saved state belongs to a different target "
                         f"({cached_host}), not restoring into {target_host}")
                return

        cookies = credentials_for_target(state.get("cookies") or [], config, target_url)
        if cookies:
            try:
                self._context.add_cookies(cookies)
                log.info(f"   [browser] Restored {len(cookies)} target-domain cookies")
            except Exception as e:
                log.info(f"   [browser] Cookie restore warning: {e}")

        storage = state.get("localStorage", {}) if localstorage_opt_in(config.get(LOCALSTORAGE_OPT_IN_KEY, False)) else {}
        for origin, items in storage.items():
            if not self._origin_matches_target(str(origin), target_url):
                log.info(f"   [browser] Skipped restored localStorage outside the login target: {origin}")
                continue
            try:
                self._page.goto(origin, wait_until="commit", timeout=10000)
                for key, value in items.items():
                    self._page.evaluate(f"localStorage.setItem({json.dumps(key)}, {json.dumps(value)})")
            except Exception as e:
                log.info(f"   [browser] localStorage restore failed for {origin}: {e}")

        log.info("   [browser] Browser state restored")

    def save_cookies(self, config: dict[str, Any], *, target_url: str = ""):
        """Save target-domain cookies (and, only when opted in, localStorage).

        localStorage holds bearer tokens for whatever origin the browser
        visited, so it is off unless the operator sets
        ``browser_persist_localstorage``; even then only the login target and
        known publisher origins are kept.
        """
        if not self._context:
            return
        try:
            from .browser_cookies import (
                DEFAULT_LOGIN_TARGET_URL,
                authorized_target_urls,
                security_cookies,
                scoped_cookies,
            )
            from .config import DATA_DIR
            cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
            cache_dir.mkdir(parents=True, exist_ok=True)

            targets = authorized_target_urls(config, target_url)
            target_url = targets[0] if targets else _default_login_target()
            cookies = scoped_cookies(self._context.cookies(), target_url)

            localStorage: dict[str, dict[str, Any]] = {}
            if localstorage_opt_in(config.get(LOCALSTORAGE_OPT_IN_KEY, False)):
                localStorage = self._scoped_localstorage(target_url)
            else:
                log.info("   [browser] localStorage persistence disabled "
                         f"(set {LOCALSTORAGE_OPT_IN_KEY}=true to opt in)")

            state = {"cookies": cookies, "localStorage": localStorage, "target_url": target_url}
            state_file = cache_dir / "browser_state.json"
            secure_write_text(state_file, json.dumps(state, indent=2, ensure_ascii=False))

            cookie_file = cache_dir / "instsci-cookies.json"
            cookie_data = security_cookies(cookies)
            secure_write_text(cookie_file, json.dumps(cookie_data, indent=2, ensure_ascii=False))

            netscape_file = cache_dir / "instsci-cookies.txt"
            from .browser_cookies import cookies_to_netscape
            secure_write_text(netscape_file, cookies_to_netscape(cookies))

            self._cookies_saved = True
            log.info(f"   [browser] Saved {len(cookies)} cookies + {len(localStorage)} localStorage origins")
        except Exception as e:
            log.info(f"   [browser] Failed to save state: {e}")

    @staticmethod
    def _origin_matches_target(origin: str, target_url: str) -> bool:
        from .credential_transport import origin_of
        return bool(origin_of(target_url)[1]) and origin_of(origin) == origin_of(target_url)

    def _scoped_localstorage(self, target_url: str) -> dict[str, dict[str, Any]]:
        """Collect localStorage for the login target origin only."""
        from urllib.parse import urlparse as _urlparse

        storage: dict[str, dict[str, Any]] = {}
        for page in self._context.pages:
            try:
                url = page.url
                if not url.startswith("http"):
                    continue
                page_host = (_urlparse(url).hostname or "").lower()
                if not self._origin_matches_target(url, target_url):
                    log.info(f"   [browser] Skipped localStorage for non-target origin: {page_host}")
                    continue
                parts = _urlparse(url)
                origin = f"{parts.scheme}://{parts.netloc}"
                items = page.evaluate("""
                    (() => {
                        const items = {};
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            items[key] = localStorage.getItem(key);
                        }
                        return items;
                    })()
                """)
                if items:
                    storage[origin] = items
            except Exception:
                pass
        return storage

    def _cleanup(self):
        """Close browser gracefully."""
        try:
            if self._browser:
                self._browser.close()
        except Exception:
            pass
        self._browser = None
        self._context = None
        self._page = None

    def close(self):
        """Explicitly close the browser."""
        self._cleanup()
        log.info("   [browser] Persistent browser closed")


# Module-level singleton
_browser = PersistentBrowser()
atexit.register(_browser.close)


def get_browser(config: dict[str, Any] | None = None):
    """Get the persistent browser singleton. Returns (browser, context, page)."""
    context, page = _browser.get_page(config)
    return _browser, context, page


def save_browser_cookies(config: dict[str, Any]):
    """Save cookies from the persistent browser."""
    _browser.save_cookies(config)


def close_browser():
    """Close the persistent browser."""
    _browser.close()


def _save_cookies_json(cookies: list[dict[str, Any]], cookie_file: Path) -> None:
    """Save cookies in JSON format (scansci-pdf compatible).

    Keeps the security/lifecycle attributes so a session restored from this
    file is not weaker than the one the browser held.
    """
    from .browser_cookies import security_cookies
    cookie_file.parent.mkdir(parents=True, exist_ok=True)
    secure_write_text(cookie_file, json.dumps(security_cookies(cookies), indent=2, ensure_ascii=False))


def _save_cookies_netscape(cookies: list[dict[str, Any]], cookie_file: Path) -> None:
    """Save cookies in Netscape format (CloakBrowser import compatible)."""
    from .browser_cookies import cookies_to_netscape
    secure_write_text(cookie_file, cookies_to_netscape(cookies))


def _import_to_browser(cookie_file: Path, config: dict[str, Any], target_url: str = "") -> int:
    """Import cookies into CloakBrowser. Returns count imported."""
    try:
        from .browser_engine import import_cookies, is_available
        if not is_available(config):
            log.info("   [browser] CloakBrowser not running, skipping auto-import")
            return 0
        count = import_cookies(cookie_file, config, target_url=target_url)
        log.info(f"   [browser] Imported {count} cookies into CloakBrowser")
        return count
    except Exception as exc:
        log.info(f"   [browser] Could not auto-import to CloakBrowser: {exc}")
        return 0


def open_login_browser(
    url: str,
    config: dict[str, Any],
    *,
    cookie_file: Path,
    detect_login: Any = None,
    max_wait: int = 300,
    auto_import: bool = True,
    keep_alive: bool = False,
    publisher: str = "",
    allow_unlisted_domain: bool = False,
) -> bool | tuple[bool, Any, Any, Any]:
    """Open a visible stealth browser for interactive login.

    Args:
        url: Login URL to open.
        config: scansci-pdf config dict.
        cookie_file: Path to save captured cookies (JSON).
        detect_login: Optional callable(browser_context, page) -> bool for custom login detection.
        max_wait: Max seconds to wait for login.
        auto_import: Whether to auto-import cookies into CloakBrowser.
        keep_alive: If True, return (True, context, page) without closing browser.
        publisher: Publisher name for remote assist display.
        allow_unlisted_domain: Skip the publisher/IdP allowlist. Only the
            institution-operated flows (WebVPN/EZProxy/CARSI) set this; their
            origin comes from the operator's own config, not from a caller.

    Returns:
        True if login succeeded, or (True, context, page) if keep_alive.
    """
    from .browser_cookies import is_allowed_login_destination, scoped_cookies

    # A caller-supplied destination (CLI `login --url`, MCP `custom_url`) must
    # be a known publisher/IdP host, otherwise the session we persist could
    # belong to anything the user happened to visit.
    if not allow_unlisted_domain:
        allowed, host = is_allowed_login_destination(url)
        if not allowed:
            log.info(f"   [browser] Rejected non-allowlisted login destination: {url}")
            print(f"  拒绝打开非白名单登录地址: {url}")
            print("  请使用已知出版社地址，例如 https://www.sciencedirect.com/")
            return (False, None, None, None) if keep_alive else False

    log.info(f"   [browser] Opening stealth browser: {url}")
    print(f"\n  请在浏览器中登录 ({url})")
    print("  程序会自动检测登录完成...\n")

    # Start remote assist if port is configured
    remote = None
    if int(config.get("remote_assist_port", 0)) > 0:
        from .remote_assist import RemoteAssist
        remote = RemoteAssist(config, publisher=publisher)
        remote.start()
        remote.update_url(url)

    if not _HAS_CLOAKBROWSER:
        log.info("   [browser] cloakbrowser not installed")
        return (False, None, None, None) if keep_alive else False

    try:
        browser = launch(headless=False, humanize=True,
                         args=["--disable-features=CrossOriginOpenerPolicy"], config=config)
        context = browser.new_context()
        page = context.new_page()

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as exc:
            log.info(f"   [browser] Page load warning: {exc}")
            print("  页面加载超时，但仍可手动登录。")

        elapsed = 0
        while elapsed < max_wait:
            time.sleep(3)
            elapsed += 3

            try:
                current_url = page.url
                if remote:
                    remote.update_url(current_url)
            except Exception:
                log.info("   [browser] Browser closed by user.")
                if remote:
                    remote.stop()
                if not keep_alive:
                    try:
                        browser.close()
                    except Exception:
                        pass
                return (False, None, None, None) if keep_alive else False

            # A custom detector is authoritative: when it says "not yet", the
            # generic URL-shape fallback below must NOT confirm the login —
            # it used to bless an unauthenticated redirect to the publisher
            # (cookie count > 3) as success for CARSI/EZProxy (#29, #62).
            if detect_login is not None:
                if detect_login(context, page):
                    # Only target-domain cookies are persisted; the context also
                    # holds the campus IdP/SSO cookies of the login portal.
                    cookies = scoped_cookies(context.cookies(), url)
                    if not cookies:
                        log.info("   [browser] Login detected, waiting for target-domain cookies")
                        continue
                    _save_cookies_json(cookies, cookie_file)
                    netscape_path = cookie_file.with_suffix(".txt")
                    _save_cookies_netscape(cookies, netscape_path)
                    log.info(f"   [browser] Login successful! Saved {len(cookies)} cookies.")
                    print(f"  登录成功！Cookie 已保存至 {cookie_file}")
                    if auto_import:
                        _import_to_browser(netscape_path, config, url)
                    if remote:
                        remote.stop()
                    if keep_alive:
                        return True, context, page
                    browser.close()
                    return True
                continue

            url_lower = current_url.lower()
            if "login" not in url_lower and "cas" not in url_lower and "sso" not in url_lower:
                if len(context.cookies()) > 3:
                    cookies = scoped_cookies(context.cookies(), url)
                    if not cookies:
                        log.info("   [browser] Redirect detected, waiting for target-domain cookies")
                        continue
                    _save_cookies_json(cookies, cookie_file)
                    netscape_path = cookie_file.with_suffix(".txt")
                    _save_cookies_netscape(cookies, netscape_path)
                    log.info(f"   [browser] Login successful! Saved {len(cookies)} cookies.")
                    print(f"  登录成功！Cookie 已保存至 {cookie_file}")
                    if auto_import:
                        _import_to_browser(netscape_path, config, url)
                    if remote:
                        remote.stop()
                    if keep_alive:
                        return True, context, page
                    browser.close()
                    return True

        print("  登录超时。")
        if remote:
            remote.stop()
        if not keep_alive:
            try:
                browser.close()
            except Exception:
                pass
        return (False, None, None, None) if keep_alive else False

    except Exception as exc:
        log.info(f"   [browser] Login error: {exc}")
        from .proxy_redaction import redact_proxy_text
        print("  登录出错: " + redact_proxy_text(exc))
        return (False, None, None, None) if keep_alive else False


def webvpn_login(config: dict[str, Any]) -> bool:
    """Login to WebVPN via stealth browser."""
    from .sources.instsci import _get_webvpn_base
    base = _get_webvpn_base(config)
    if not base:
        log.info("   [WebVPN] No base URL configured")
        return False

    from .config import DATA_DIR
    cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
    # Canonical name matches the loader in instsci.instsci_cookie_path; the
    # loader also accepts the legacy underscore variant for migration.
    cookie_file = cache_dir / "instsci-cookies.json"

    return open_login_browser(base, config, cookie_file=cookie_file, max_wait=600,
                              allow_unlisted_domain=True)


def carsi_login(publisher: str, config: dict[str, Any], *, login_url: str, domains: list[str]) -> bool:
    """Login to CARSI federated authentication via stealth browser."""
    from .config import DATA_DIR
    cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache"))) / "carsi_cookies"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cookie_file = cache_dir / f"{publisher}.json"

    def _detect(context: Any, page: Any) -> bool:
        try:
            current_url = page.url
            on_publisher = any(d in current_url for d in domains)
            on_login = any(x in current_url.lower() for x in ("login", "institutional", "wayf", "saml", "cas", "idp"))
            if not on_publisher or on_login:
                return False
            # The URL gate alone false-positives: some publishers bounce the
            # unauthenticated visitor to their homepage, which passes the URL
            # check before the user has seen the IdP (#29). Require a
            # federated-auth artifact — completing CARSI always leaves a
            # Shibboleth/SAML session cookie or an IdP-domain (.edu.cn)
            # cookie in the context.
            for c in context.cookies():
                name = (c.get("name") or "").lower()
                dom = (c.get("domain") or "").lower()
                if "shibsession" in name or "saml" in name or "idp" in dom or dom.endswith(".edu.cn"):
                    return True
            return False
        except Exception:
            return False

    return open_login_browser(
        login_url,
        config,
        cookie_file=cookie_file,
        detect_login=_detect,
        max_wait=600,  # IdP + 2FA is human-paced; 180s wastes the run (#62)
        allow_unlisted_domain=True,
    )


def ezproxy_login(config: dict[str, Any]) -> bool:
    """Login to EZProxy via stealth browser."""
    from .sources.ezproxy import _ezproxy_origin, _is_proxy_domain

    origin = _ezproxy_origin(config)
    if not origin:
        log.info("   [EZProxy] No ezproxy_login_url configured")
        return False

    from .config import DATA_DIR
    cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
    cookie_file = cache_dir / "ezproxy_cookies.json"

    # Land on the bare /login endpoint: it is the only URL that reliably
    # challenges. /login?url=<target> skips straight to the raw publisher on
    # hostname-rewriting deployments and never authenticates (#62).
    login_url = f"{origin}/login"

    def _detect(context: Any, page: Any) -> bool:
        try:
            parsed = urlparse(page.url)
            path_q = f"{parsed.path}?{parsed.query}".lower()
            if "/login" in path_q or "wayf" in path_q or "shibboleth" in path_q:
                return False
            # The authentication signal is the proxy's own session cookie —
            # not the URL shape. "URL is not a login page" used to pass the
            # moment an unauthenticated visitor was redirected to the raw
            # publisher, saving 17 publisher cookies and zero proxy
            # cookies as a "successful" login (#62).
            for c in context.cookies():
                if _is_proxy_domain(c.get("domain") or ""):
                    return True
            host = (parsed.hostname or "").lower()
            return _is_proxy_domain(host)
        except Exception:
            return False

    return open_login_browser(
        login_url,
        config,
        cookie_file=cookie_file,
        detect_login=_detect,
        max_wait=600,  # SSO + 2FA is human-paced; 180s wastes the run (#62)
        allow_unlisted_domain=True,
    )
