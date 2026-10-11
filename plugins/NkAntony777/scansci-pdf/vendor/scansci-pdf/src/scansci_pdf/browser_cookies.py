"""Extract cookies via CloakBrowser for publisher access.

Opens a visible CloakBrowser window, lets user log in to their institution,
then captures and saves publisher cookies for automated downloads.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .log import get_logger
from .security import secure_write_text

log = get_logger()

# Publisher domains that benefit from institutional cookies
PUBLISHER_DOMAINS = [
    "sciencedirect.com",
    "elsevier.com",
    "springer.com",
    "springerlink.com",
    "link.springer.com",
    "onlinelibrary.wiley.com",
    "wiley.com",
    "ieeexplore.ieee.org",
    "ieee.org",
    "nature.com",
    "science.org",
    "sciencemag.org",
    "tandfonline.com",
    "pnas.org",
    "jstor.org",
    "acs.org",
    "rsc.org",
    "cambridge.org",
    "oup.com",
    "academic.oup.com",
    "sagepub.com",
    "sage.cnpereading.com",
    "mdpi.com",
    "frontiersin.org",
]

# Publisher login URLs for quick access
PUBLISHER_LOGIN_URLS = {
    "elsevier": "https://www.sciencedirect.com/",
    "springer": "https://link.springer.com/",
    "wiley": "https://onlinelibrary.wiley.com/",
    "nature": "https://www.nature.com/",
    "science": "https://www.science.org/",
    "ieee": "https://ieeexplore.ieee.org/",
    "tandfonline": "https://www.tandfonline.com/",
    "pnas": "https://www.pnas.org/",
    "acs": "https://pubs.acs.org/",
    "rsc": "https://pubs.rsc.org/",
    "aip": "https://pubs.aip.org/",
    "aps": "https://journals.aps.org/",
    "iop": "https://iopscience.iop.org/",
    "oxford": "https://academic.oup.com/",
    "acm": "https://dl.acm.org/",
    "sage-cn": "https://sage.cnpereading.com/login",
}


def _save_cookies_json(cookies: list[dict[str, Any]], output_path: Path) -> None:
    secure_write_text(output_path, json.dumps(cookies, indent=2, ensure_ascii=False))


def cookies_to_netscape(cookies: list[dict[str, Any]]) -> str:
    """Convert a list of cookie dicts to Netscape HTTP Cookie File format.

    HttpOnly cookies are written with the ``#HttpOnly_`` line prefix, which is
    the only place the format carries that flag. Without it an export/import
    round trip (CloakBrowser import, ``import-cookies``) turns an HttpOnly
    session into a page-script-readable one.
    """
    lines = ["# Netscape HTTP Cookie File\n"]
    for c in cookies:
        domain = c.get("domain", "")
        flag = "TRUE" if domain.startswith(".") else "FALSE"
        path = c.get("path", "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        expires = str(int(c.get("expires", 0) or 0))
        name = c.get("name", "")
        value = c.get("value", "")
        prefix = "#HttpOnly_" if c.get("httpOnly") else ""
        if "sameSite" in c:
            metadata = {"name": name, "domain": domain, "path": path, "sameSite": c["sameSite"]}
            lines.append("#ScanSci-Cookie-Attributes " + json.dumps(metadata, ensure_ascii=False) + "\n")
        lines.append(f"{prefix}{domain}\t{flag}\t{path}\t{secure}\t{expires}\t{name}\t{value}\n")
    return "".join(lines)


def parse_netscape_cookies(text: str) -> list[dict[str, Any]]:
    """Parse Netscape-format cookie file into structured cookie objects."""
    metadata = {}
    prefix = "#ScanSci-Cookie-Attributes "
    for line in text.splitlines():
        if line.startswith(prefix):
            try:
                item = json.loads(line[len(prefix):])
                if isinstance(item, dict):
                    metadata[(item.get("name"), item.get("domain"), item.get("path"))] = item.get("sameSite")
            except (ValueError, TypeError):
                continue
    cookies: list[dict[str, Any]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        http_only = False
        if line.startswith("#HttpOnly_"):
            http_only = True
            line = line.removeprefix("#HttpOnly_")
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain = parts[0]
        cookie_path = parts[2]
        secure = parts[3].upper() == "TRUE"
        try:
            expires = int(parts[4])
        except (ValueError, IndexError):
            expires = 0
        name = parts[5]
        value = "\t".join(parts[6:])
        cookie: dict[str, Any] = {
            "name": name, "value": value,
            "domain": domain, "path": cookie_path,
            "secure": secure, "expires": expires,
        }
        if http_only:
            cookie["httpOnly"] = True
        same_site = metadata.get((name, domain, cookie_path))
        if same_site in ("Strict", "Lax", "None"):
            cookie["sameSite"] = same_site
        cookies.append(cookie)
    return cookies


def _save_cookies_netscape(cookies: list[dict[str, Any]], output_path: Path) -> None:
    secure_write_text(output_path, cookies_to_netscape(cookies))


def _is_publisher_cookie(cookie: dict[str, Any]) -> bool:
    """Check if a cookie belongs to a known publisher domain.

    Dot-anchored via :func:`_host_in`: only the domain itself or a true
    subdomain matches, so ``evil-sciencedirect.com`` is not ScienceDirect.
    """
    return _host_in((cookie.get("domain") or "").lstrip(".").lower(), PUBLISHER_DOMAINS)


# Hosts accepted as a *custom* login destination (CLI ``login --url`` / MCP
# ``custom_url``). Institutional flows (WebVPN/EZProxy/CARSI) are exempt:
# their origin comes from the operator's own config, not from a caller.
CUSTOM_LOGIN_ALLOWED_DOMAINS = sorted(
    (set(PUBLISHER_DOMAINS) | {"doi.org"}
     | {urlparse(u).hostname or "" for u in PUBLISHER_LOGIN_URLS.values()}) - {""}
)


def _host_in(host: str, domains: Any) -> bool:
    """True when ``host`` is one of ``domains`` or a subdomain of one."""
    return any(host == d or host.endswith("." + d) for d in domains if d)


# Target used when the operator configured none. A code constant shared by the
# save and restore paths so both agree on which origin the jar belongs to.
DEFAULT_LOGIN_TARGET_URL = "https://www.sciencedirect.com/"


def is_allowed_login_destination(url: str) -> tuple[bool, str]:
    """Check a custom login destination against the publisher/IdP allowlist.

    Returns ``(allowed, host)``. ``host`` is the parsed hostname (empty when
    the URL is unparseable or non-HTTP), so callers can report it.
    """
    try:
        parsed = urlparse(url or "")
    except Exception:
        return False, ""
    if parsed.scheme not in ("http", "https"):
        return False, ""
    host = (parsed.hostname or "").lower()
    if not host:
        return False, ""
    return _host_in(host, CUSTOM_LOGIN_ALLOWED_DOMAINS), host


# Fields a persisted cookie may carry. The first four identify the cookie;
# the rest are the SECURITY and LIFECYCLE attributes a browser needs to
# restore it faithfully. Anything outside this set is dropped so a captured
# jar cannot smuggle unrelated data (or Playwright-only internals such as
# ``sid``/``partitionKey``) through the cache.
COOKIE_IDENTITY_FIELDS = ("name", "value", "domain", "path")
COOKIE_SECURITY_FIELDS = ("httpOnly", "secure", "sameSite", "expires")

# A record written by the pre-D64-05 code path. It carries none of the
# security attributes, so the HttpOnly/Secure/SameSite/expiry state of the
# original cookie is simply not in the file and cannot be reconstructed.
LEGACY_COOKIE_FIELDS = frozenset(COOKIE_IDENTITY_FIELDS)

_VALID_SAME_SITE = {"strict": "Strict", "lax": "Lax", "none": "None", "no_restriction": "None"}

# Cookie-name prefixes the browser itself refuses to set without their
# required attributes, so a stripped record under one of these names must not
# be restored as a weaker cookie.
_HOST_PREFIX = "__Host-"
_SECURE_PREFIX = "__Secure-"


def _coerce_bool(value: Any) -> bool:
    """Strict truthiness for a security attribute.

    ``bool("false")`` is ``True``, which is precisely how a saved ``"false"``
    ends up meaning ON. Only real booleans (and the canonical JSON literals)
    are accepted; anything else is OFF.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "on"}
    return False


def _coerce_expires(value: Any, now: float) -> float:
    """Normalize ``expires`` to a float epoch seconds; non-positive = session."""
    try:
        expires = float(value)
    except (TypeError, ValueError):
        return -1.0
    if expires != expires or expires in (float("inf"), float("-inf")):  # NaN/inf
        return -1.0
    return expires


def _normalize_cookie(cookie: dict[str, Any], now: float) -> dict[str, Any] | None:
    """Project one cookie onto the persisted allowlist.

    Returns ``None`` when the record is unusable (no name, no value, or already
    expired), so callers can drop it instead of persisting a dead credential.
    """
    if not isinstance(cookie, dict):
        return None
    name = cookie.get("name")
    if not isinstance(name, str) or not name:
        return None
    value = cookie.get("value")
    if value is None:
        return None

    expires = _coerce_expires(cookie.get("expires"), now)
    # An expired record must never be written or re-injected: it is a dead
    # credential that only adds noise to the jar.
    if expires > 0 and expires <= now:
        return None

    normalized: dict[str, Any] = {
        "name": name,
        "value": str(value),
        "domain": str(cookie.get("domain") or ""),
        "path": str(cookie.get("path") or "/"),
        "httpOnly": _coerce_bool(cookie.get("httpOnly")),
        "secure": _coerce_bool(cookie.get("secure")),
        # Playwright's session-cookie sentinel. Persisting 0 instead makes the
        # browser treat the cookie as expired on restore.
        "expires": expires if expires > 0 else -1.0,
    }

    same_site = cookie.get("sameSite")
    if isinstance(same_site, str):
        mapped = _VALID_SAME_SITE.get(same_site.strip().lower().replace("-", "_"))
        if mapped:
            # SameSite=None is only honoured on a Secure cookie; persisting it
            # on a non-secure one yields a record the browser rejects.
            if mapped == "None" and not normalized["secure"]:
                mapped = "Lax"
            normalized["sameSite"] = mapped

    return normalized


def security_cookies(
    cookies: list[dict[str, Any]],
    *,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """Reduce a browser jar to the fields needed to restore it faithfully.

    Keeps name/value/domain/path plus the security and lifecycle attributes
    (``httpOnly``, ``secure``, ``sameSite``, ``expires``). Dropping those made
    every saved session *weaker* than the live one: an HttpOnly cookie came
    back page-script-readable and a session cookie came back with a real
    expiry. Types are validated rather than trusted, and already-expired
    records are filtered instead of being written out dead.
    """
    now = time.time() if now is None else now
    result: list[dict[str, Any]] = []
    for cookie in cookies or []:
        normalized = _normalize_cookie(cookie, now)
        if normalized is not None:
            result.append(normalized)
    return result


def minimal_cookies(cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deprecated alias for :func:`security_cookies`.

    Kept so existing callers keep working; "minimal" is no longer an accurate
    description — see :func:`security_cookies`.
    """
    return security_cookies(cookies)


def is_legacy_cookie_record(cookie: dict[str, Any]) -> bool:
    """True for a pre-D64-05 record that carries no security attributes.

    Such a file cannot restore the original cookie faithfully: the HttpOnly,
    Secure, SameSite and expiry state were never written. We do NOT guess them
    — the documented compat policy is that these records are dropped on
    browser restore and the operator re-logs in once, after which the new
    file carries real attributes.

    Note on scope of persistence: this file is a *cookie* jar, not full
    browser state. It cannot preserve WebVPN/EZProxy in-memory gateway state,
    challenge state or TLS sessions; those survive only inside a live visible
    browser context or a native persistent profile. See
    ``data/institutional_identity_policy.json``.
    """
    return isinstance(cookie, dict) and not (set(cookie) & set(COOKIE_SECURITY_FIELDS))


def _covers_host(cookie_domain: str, host: str) -> bool:
    """True when a cookie's domain would actually be sent to ``host``.

    Mirrors browser cookie scoping: the cookie's domain is the host itself or
    a parent of it (``.sciencedirect.com`` covers ``www.sciencedirect.com``),
    dot-anchored so ``evil-sciencedirect.com`` never matches. The reverse is
    not a match — a cookie for ``link.springer.com`` is not sent to
    ``www.sciencedirect.com``.
    """
    domain = (cookie_domain or "").lstrip(".").lower()
    # A single label such as ``com`` would match every host under that TLD.
    if not domain or "." not in domain or not host:
        return False
    return host == domain or host.endswith("." + domain)


def _target_hosts(target_urls: Any) -> list[str]:
    """Hosts of the explicitly authorized targets, in order."""
    hosts: list[str] = []
    for url in target_urls or ():
        host = (urlparse(url or "").hostname or "").lower()
        if host and host not in hosts:
            hosts.append(host)
    return hosts


def _prefix_violations(cookie: dict[str, Any]) -> bool:
    """True when a record violates a cookie-name prefix requirement.

    ``__Secure-`` requires Secure. ``__Host-`` additionally requires
    ``Path="/"`` and a host-only cookie domain (no leading dot). Invalid
    records are dropped before they can reach the browser.
    """
    name = cookie.get("name") or ""
    if name.startswith(_SECURE_PREFIX) and not cookie.get("secure"):
        return True
    if name.startswith(_HOST_PREFIX):
        return not (cookie.get("secure") and cookie.get("path") == "/" and not cookie.get("domain", "").startswith("."))
    return False


def authorized_target_urls(config: dict[str, Any] | None, target_url: str = "") -> list[str]:
    """The EXPLICITLY authorized targets for credential persistence.

    Only operator config and the caller's own argument count. A target read
    back out of the cache file is *not* authorization — a cache an attacker
    can rewrite would otherwise be able to name any origin and have its
    cookies re-injected.
    """
    urls: list[str] = []
    for candidate in ((target_url,) if target_url else ((config or {}).get("browser_login_target_url", ""),)):
        url = str(candidate or "")
        if url and url not in urls:
            urls.append(url)
    return urls

def scope_to_authorized_targets(
    cookies: list[dict[str, Any]],
    targets: list[str],
    *,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """The single credential-scope policy, applied on BOTH save and restore.

    Keeps only cookies the explicitly authorized targets would themselves
    receive, then normalizes them through :func:`security_cookies` and drops
    prefix-invalid records. Passing through an IdP during login therefore
    never persists that IdP's session, and a stale cache can never widen its
    own scope.

    Cross-domain institutional flows keep working because WebVPN/EZProxy
    proxy the publisher under the *proxy* hostname, which is the authorized
    target for those logins.
    """
    hosts = _target_hosts(targets)
    if not hosts:
        return []
    scoped = [
        c for c in cookies or []
        if isinstance(c, dict) and any(_covers_host(c.get("domain", ""), h) for h in hosts)
    ]
    return [c for c in security_cookies(scoped, now=now) if not _prefix_violations(c)]


def credentials_for_target(
    cookies: list[dict[str, Any]],
    config: dict[str, Any] | None = None,
    target_url: str = "",
    *,
    now: float | None = None,
) -> list[dict[str, Any]]:
    """Shared save/restore entry point for every credential path.

    Wraps :func:`scope_to_authorized_targets` with the authorized-target
    resolution so no caller has to re-implement the policy.

    The legacy test runs on the RAW records: normalization adds explicit
    ``httpOnly``/``secure``/``expires`` keys, so a post-normalization check
    could never tell a stripped record from a real one.
    """
    raw = [c for c in cookies or [] if not is_legacy_cookie_record(c)]
    return scope_to_authorized_targets(
        raw, authorized_target_urls(config, target_url), now=now
    )


def scoped_cookies(cookies: list[dict[str, Any]], url: str) -> list[dict[str, Any]]:
    """Keep only cookies belonging to the login target's own domain.

    The browser context holds every session the user touched while logging in:
    the target's cookies, the campus IdP/SSO cookies of whatever portal issued
    them, and any sibling publisher the flow passed through. Only cookies that
    the target domain would itself receive are persisted, so logging into one
    publisher no longer leaves a live session behind for every other publisher
    on the list, and a captured jar cannot be replayed against a different site.

    Security and lifecycle attributes are preserved (see
    :func:`security_cookies`), so an HttpOnly session does not come back
    page-script-readable.

    There is no cross-publisher carve-out: each login runs in its own context
    against one target, so cookies for a second publisher are never needed to
    complete the first. Cross-domain flows (WebVPN/EZProxy) proxy the publisher
    under the *proxy* hostname, which is the target here, so they keep working.
    """
    return credentials_for_target(cookies, None, url)



def extract_via_browser(
    config: dict[str, Any],
    *,
    url: str = "https://www.sciencedirect.com/",
    max_wait: int = 300,
) -> dict[str, Any]:
    """Open visible browser for institutional login, then capture publisher cookies.

    Args:
        config: scansci-pdf config dict.
        url: Login URL. Must be a known publisher/IdP destination.
        max_wait: Max seconds to wait for login.

    Returns:
        Result dict with success, cookies_count, domains, etc.
    """
    allowed, host = is_allowed_login_destination(url)
    if not allowed:
        log.info(f"   [cookies] Rejected non-allowlisted login destination: {url}")
        return {
            "success": False,
            "error": f"Login destination not allowed: {url}",
            "fix": "Use a known publisher URL, e.g. https://www.sciencedirect.com/",
        }

    try:
        from .browser_backend import launch
        from .browser_backend import is_available as _browser_backend_available
        if not _browser_backend_available():
            return {
                "success": False,
                "error": "no browser backend available",
                "fix": "pip install patchright (or pip install cloakbrowser)",
            }
    except ImportError:
        return {
            "success": False,
            "error": "no browser backend available",
            "fix": "pip install patchright (or pip install cloakbrowser)",
        }

    from .config import DATA_DIR
    cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
    cookie_file = cache_dir / "publisher_cookies.json"
    netscape_file = cache_dir / "publisher_cookies.txt"

    log.info(f"   [cookies] Opening browser: {url}")
    print(f"\n  请在浏览器中登录你的机构账号（如学校图书馆）")
    print(f"  打开页面: {url}")
    print(f"  登录完成后关闭浏览器窗口即可\n")

    try:
        browser = launch(headless=False, humanize=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
        except Exception as exc:
            log.info(f"   [cookies] Page load warning: {exc}")

        # Auto-dismiss cookie consent popups (common on Elsevier/Cell/Wiley/etc.)
        time.sleep(2)
        for js in [
            # Elsevier/Cell cookie banner
            "document.querySelector('#onetrust-accept-btn-handler')?.click()",
            # OneTrust general
            "document.querySelector('.onetrust-close-btn-handler')?.click()",
            # Generic consent banners
            "document.querySelector('[class*=\"cookie-accept\"], [class*=\"consent-accept\"]')?.click()",
            "document.querySelector('button[id*=\"accept\"], button[class*=\"accept\"]')?.click()",
        ]:
            try:
                page.evaluate(js)
            except Exception:
                pass

        # Wait for user to close browser
        try:
            page.wait_for_event("close", timeout=max_wait * 1000)
        except Exception:
            pass

        # Capture cookies, then keep only the target/publisher ones: the
        # context also holds the campus IdP/SSO cookies of whatever portal the
        # user logged in through, and those must not be persisted. Falling
        # back to the whole jar when the target has none is not an option.
        all_cookies = context.cookies()
        save_cookies = scoped_cookies(all_cookies, url)
        publisher_cookies = [c for c in save_cookies if _is_publisher_cookie(c)]

        if not save_cookies:
            browser.close()
            return {
                "success": False,
                "message": f"未在 {host} 捕获到 cookies。请确保已登录机构账号。",
            }

        # Save
        _save_cookies_json(save_cookies, cookie_file)
        _save_cookies_netscape(save_cookies, netscape_file)

        # Import into CloakBrowser server if running
        browser_imported = 0
        try:
            from .browser_engine import import_cookies, is_available
            if is_available(config):
                browser_imported = import_cookies(netscape_file, config, target_url=url)
        except Exception:
            pass

        browser.close()

        domains_found = list({c.get("domain", "").lstrip(".") for c in save_cookies})[:10]
        return {
            "success": True,
            "cookies_count": len(save_cookies),
            "total_captured": len(all_cookies),
            "cookie_file": str(cookie_file),
            "netscape_file": str(netscape_file),
            "domains": domains_found,
            "browser_imported": browser_imported,
            "message": f"捕获 {len(all_cookies)} 个 cookies，其中 {len(save_cookies)} 个属于 {host}"
                       f"（{len(publisher_cookies)} 个属于出版社）。已保存，后续下载自动使用。",
        }

    except Exception as exc:
        log.info(f"   [cookies] Error: {exc}")
        return {"success": False, "error": str(exc)}


def load_saved_cookies(config: dict[str, Any], target_url: str = "") -> list[dict[str, Any]]:
    """Load previously saved cookies, filtering out expired ones.

    The caller's target (or explicit configured login target) determines the
    restore scope. Without one, no credentials are returned.
    """
    from .config import DATA_DIR
    cookie_file = Path(config.get("cache_dir", str(DATA_DIR / "cache"))) / "publisher_cookies.json"
    if not cookie_file.exists():
        return []
    try:
        cookies = json.loads(cookie_file.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(cookies, list):
        return []
    now = time.time()
    cookies = credentials_for_target(cookies, config, target_url, now=now)
    return [c for c in cookies if _is_cookie_valid(c, now)]


def _is_cookie_valid(cookie: dict[str, Any], now: float | None = None) -> bool:
    """Check if a cookie is not expired. expires<=0 means session cookie (always valid)."""
    expires = cookie.get("expires", 0)
    if not expires or expires <= 0:
        return True
    if now is None:
        now = time.time()
    try:
        return float(expires) > now
    except (TypeError, ValueError):
        return False


def inject_cookies(session: Any, config: dict[str, Any], target_url: str = "") -> None:
    """Inject saved publisher cookies into a requests.Session."""
    cookies = load_saved_cookies(config, target_url)
    from .session_store import CookieStore
    CookieStore.apply_to_session(session, cookies)


def merge_cookies(
    new_cookies: list[dict[str, Any]],
    config: dict[str, Any],
    target_url: str = "",
    *,
    target_urls: list[str] | None = None,
) -> list[dict[str, Any]]:
    """Merge cookies for the caller's explicitly authorized targets only.

    A known publisher-domain list is not authorization for every publisher.
    Multi-origin integrations must supply their complete scope explicitly.
    """
    from .config import DATA_DIR

    targets = target_urls if target_urls is not None else authorized_target_urls(config, target_url)
    if not targets:
        return []
    cache_dir = Path(config.get("cache_dir", str(DATA_DIR / "cache")))
    cookie_file = cache_dir / "publisher_cookies.json"
    netscape_file = cache_dir / "publisher_cookies.txt"
    try:
        existing = json.loads(cookie_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        existing = []
    if not isinstance(existing, list):
        existing = []
    now = time.time()
    existing = [c for c in existing if isinstance(c, dict) and not is_legacy_cookie_record(c)]
    existing = scope_to_authorized_targets(existing, targets, now=now)
    key = lambda c: (c["name"], c["domain"], c["path"])
    merged = {key(c): c for c in existing}
    incoming = [c for c in new_cookies or [] if isinstance(c, dict) and not is_legacy_cookie_record(c)]
    for cookie in scope_to_authorized_targets(incoming, targets, now=now):
        merged[key(cookie)] = cookie
    result = list(merged.values())
    # Persist empty results too: expired or unauthorized credentials must not
    # survive a successful merge in an old cache file.
    _save_cookies_json(result, cookie_file)
    _save_cookies_netscape(result, netscape_file)
    return result


def _is_doi(text: str) -> bool:
    return text.startswith("10.") and "/" in text


def publisher_login(
    identifier: str,
    config: dict[str, Any],
    *,
    max_wait: int = 300,
) -> dict[str, Any]:
    """Open browser for institutional login on a publisher article page.

    Takes a DOI or publisher name, resolves to the article page, and opens
    a visible stealth browser. User clicks "Access through your institution",
    completes SSO login, then closes the browser. Cookies are captured and
    imported into CloakBrowser for automated downloads.

    Args:
        identifier: DOI (e.g. 10.1126/science.aec6396) or publisher name
                    (e.g. "elsevier", "wiley", "nature", "springer", "ieee",
                    "science", "tandfonline", "pnas", "acs", "rsc", "aip",
                    "aps", "iop", "oxford", "acm")
        config: scansci-pdf config dict
        max_wait: Max seconds to wait for login (default 300)

    Returns:
        Result dict with success, cookies_count, domains, message.
    """
    import re

    # Resolve identifier to a URL
    if _is_doi(identifier):
        # DOI → resolve to article URL
        url = f"https://doi.org/{identifier}"
        log.info(f"   [login] DOI detected, opening article: {url}")
    elif identifier.lower() in PUBLISHER_LOGIN_URLS:
        url = PUBLISHER_LOGIN_URLS[identifier.lower()]
        log.info(f"   [login] Publisher '{identifier}', opening: {url}")
    elif re.match(r"https?://", identifier):
        url = identifier
        allowed, host = is_allowed_login_destination(url)
        if not allowed:
            log.info(f"   [login] Rejected non-allowlisted login destination: {url}")
            return {
                "success": False,
                "error": f"Login destination not allowed: {identifier}",
                "fix": "Use a DOI, a publisher name, or a known publisher URL.",
            }
        log.info(f"   [login] URL detected: {url}")
    else:
        # Try fuzzy publisher name match
        lower = identifier.lower()
        match = None
        for key in PUBLISHER_LOGIN_URLS:
            if key in lower or lower in key:
                match = key
                break
        if match:
            url = PUBLISHER_LOGIN_URLS[match]
            log.info(f"   [login] Matched publisher '{match}', opening: {url}")
        else:
            available = ", ".join(sorted(PUBLISHER_LOGIN_URLS.keys()))
            return {
                "success": False,
                "error": f"Unknown publisher: '{identifier}'. Available: {available}",
            }

    return extract_via_browser(config, url=url, max_wait=max_wait)
