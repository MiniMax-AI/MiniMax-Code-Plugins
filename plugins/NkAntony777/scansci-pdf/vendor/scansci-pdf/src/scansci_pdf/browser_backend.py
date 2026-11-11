"""Unified browser backend: patchright (default), CloakBrowser, or Camoufox.

patchright is the Apache-2.0 open-source Playwright fork that patches the
detectable automation fingerprints (``--enable-automation`` removal,
``Runtime.enable`` leak, ``navigator.webdriver``, ...). Its documented best
practice is ``channel="chrome"`` + ``headless=False`` — i.e. driving the local
Google Chrome, whose kernel auto-updates. CloakBrowser's free tier is pinned
to Chromium 146 (newer 148/150 kernels are Pro-only), so it is kept as an
opt-in fallback. Camoufox is the last-resort fallback: an open-source
anti-detect Firefox (kernel Firefox 152), with a clean headless UA — no
``HeadlessChrome``/``HeadlessFirefox`` leak, verified at runtime.

All backends expose the same Playwright sync API surface (``launch``,
``launch_persistent_context``); the CloakBrowser-only ``humanize`` flag is
accepted everywhere and ignored on patchright.
"""

from __future__ import annotations

import logging

from .proxy_redaction import redacting_logger
import os
import re
import shutil
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .browser_provenance import (
    resolve_camoufox_executable,
    resolve_channel_executable,
    verified_or_none,
    verify_browser_executable,
)

logger = redacting_logger(__name__)

BACKEND_PATCHRIGHT = "patchright"
BACKEND_CLOAKBROWSER = "cloakbrowser"
BACKEND_CAMOUFOX = "camoufox"
DEFAULT_BACKEND = BACKEND_PATCHRIGHT


def _installed_cloakbrowser(config):
    """Hosted launches use an owner-installed binary, never implicit installers."""
    explicit = str((config or {}).get('browser_executable', '') or '').strip()
    candidate = explicit or os.environ.get('CLOAKBROWSER_BINARY_PATH')
    if not candidate:
        from cloakbrowser.config import get_binary_path
        candidate = get_binary_path()
    path = Path(candidate).expanduser().absolute()
    if not path.is_file():
        if explicit:
            from .security import SecurityError
            raise SecurityError("Configured browser executable is unavailable")
        candidate = find_local_browser(config)
        if not candidate:
            return False
        path = Path(candidate).absolute()
    # Same allowlist + symlink + pinned-digest gate every other launch path uses.
    path = verify_browser_executable(path, config)
    os.environ['CLOAKBROWSER_BINARY_PATH'] = str(path)
    os.environ['CLOAKBROWSER_AUTO_UPDATE'] = 'false'
    return True


def _guard_page_navigation(page):
    from .security import public_url
    original = page.goto
    def goto(url, *args, **kwargs):
        public_url(url)
        return original(url, *args, **kwargs)
    page.goto = goto
    return page


def _guard_context_navigation(context):
    original = context.new_page
    def new_page(*args, **kwargs):
        return _guard_page_navigation(original(*args, **kwargs))
    context.new_page = new_page
    for page in context.pages:
        _guard_page_navigation(page)
    return context


def _guard_context_proxy(browser, proxy):
    original = browser.new_context
    def new_context(*args, **kwargs):
        kwargs['proxy'] = proxy
        kwargs['ignore_https_errors'] = False
        return _guard_context_navigation(original(*args, **kwargs))
    browser.new_context = new_context
    return browser


# ---------------------------------------------------------------------------
# Availability / resolution
# ---------------------------------------------------------------------------

def is_available(name: str | None = None) -> bool:
    """Check whether a backend package is importable. None → resolved backend."""
    if name is None:
        name = DEFAULT_BACKEND
    try:
        if name == BACKEND_PATCHRIGHT:
            import patchright  # noqa: F401
            return True
        if name == BACKEND_CLOAKBROWSER:
            import cloakbrowser  # noqa: F401
            return True
        if name == BACKEND_CAMOUFOX:
            import camoufox  # noqa: F401
            return True
    except ImportError:
        return False
    return False


def resolve_backend(config: dict[str, Any] | None = None) -> str:
    """Resolve the effective backend from config, falling back gracefully.

    ``browser_backend`` config key (default "patchright"); an unknown value
    warns and resets to the default. Fallback chain:
    patchright → cloakbrowser → camoufox (last resort). A missing patchright
    falls to cloakbrowser; a missing — or below the kernel floor — cloakbrowser
    falls to camoufox when that is installed.
    """
    cfg = config or {}
    from .security import strict_mode, SecurityError
    if strict_mode() and cfg.get("browser_backend"):
        requested = str(cfg["browser_backend"]).strip().lower()
        if requested not in (BACKEND_PATCHRIGHT, BACKEND_CLOAKBROWSER, BACKEND_CAMOUFOX) or not is_available(requested):
            raise SecurityError("Configured browser backend is unavailable")
        return requested
    requested = str(cfg.get("browser_backend", DEFAULT_BACKEND) or DEFAULT_BACKEND).strip().lower()
    if requested not in (BACKEND_PATCHRIGHT, BACKEND_CLOAKBROWSER, BACKEND_CAMOUFOX):
        logger.warning("browser_backend: unknown backend '%s', using %s", requested, DEFAULT_BACKEND)
        requested = DEFAULT_BACKEND
    if requested == BACKEND_PATCHRIGHT and not is_available(BACKEND_PATCHRIGHT):
        logger.warning(
            "browser_backend: patchright not installed, falling back to cloakbrowser. "
            "Run: pip install patchright"
        )
        requested = BACKEND_CLOAKBROWSER
    if requested == BACKEND_CLOAKBROWSER and not is_available(BACKEND_CLOAKBROWSER):
        logger.warning(
            "browser_backend: cloakbrowser not installed, falling back to camoufox. "
            "Run: pip install cloakbrowser (or pip install camoufox)"
        )
        requested = BACKEND_CAMOUFOX
    if requested == BACKEND_CAMOUFOX and not is_available(BACKEND_CAMOUFOX):
        logger.warning(
            "browser_backend: camoufox not installed, falling back to cloakbrowser. "
            "Run: pip install camoufox"
        )
        requested = BACKEND_CLOAKBROWSER if is_available(BACKEND_CLOAKBROWSER) else BACKEND_PATCHRIGHT
    # A stale cloakbrowser kernel fails the hard gate at launch time; redirect
    # to camoufox when available instead of erroring out (escape hatch kept).
    if requested == BACKEND_CLOAKBROWSER and is_available(BACKEND_CAMOUFOX):
        v = _cloakbrowser_dist_version()
        if v is not None and v < CLOAKBROWSER_REQUIRED_MIN and not os.environ.get("SCANSCI_ALLOW_OLD_CLOAKBROWSER"):
            logger.warning(
                "browser_backend: cloakbrowser %s below required floor %s, using camoufox",
                ".".join(str(x) for x in v), ".".join(str(x) for x in CLOAKBROWSER_REQUIRED_MIN),
            )
            return BACKEND_CAMOUFOX
    return requested


# ---------------------------------------------------------------------------
# Local browser discovery (Chrome/Edge newer than bundled stealth Chromium 146)
# ---------------------------------------------------------------------------
# CloakBrowser's free tier is pinned to Chromium 146 (free builds stopped
# updating after 2026-05; newer 148/150 are Pro-only). Sites behind
# Cloudflare Turnstile repeatedly challenge the stale 146 fingerprint, so we
# prefer a local Chrome/Edge with a newer kernel.
# ---------------------------------------------------------------------------

_BUILTIN_CHROMIUM_MIN = (146, 0)  # bundled stealth Chromium; only swap when newer

_SYSTEM_BROWSER_PATHS_WIN = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
]

_SYSTEM_BROWSER_NAMES_POSIX = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "microsoft-edge", "msedge",
]

_version_cache: dict[str, str] = {}


def _parse_version(v: str) -> tuple[int, ...]:
    """'150.0.7871.187' -> (150, 0, 7871, 187); (0,) when unparseable."""
    nums = [int(n) for n in re.findall(r"\d+", v or "")]
    return tuple(nums[:4]) if nums else (0,)


def _probe_windows_versions(config: dict[str, Any] | None = None) -> dict[str, str]:
    """One PowerShell call: {path: version} for every existing system browser.

    The version is read from the file's version resource without executing the
    binary, but each candidate is still put through the same provenance gate
    the POSIX branch applies — Windows must not be the weaker platform.
    """
    allowed: list[str] = []
    for path in _SYSTEM_BROWSER_PATHS_WIN:
        path = os.path.expandvars(path)
        if not Path(path).is_file():
            continue
        if verified_or_none(path, config) is None:
            continue
        allowed.append(path)
    if not allowed:
        return {}
    paths = ",".join("'" + p.replace("'", "''") + "'" for p in allowed)
    script = (
        f"$paths = @({paths}); "
        "foreach ($p in $paths) { if (Test-Path -LiteralPath $p) { "
        'Write-Output ("$p`t" + (Get-Item -LiteralPath $p).VersionInfo.ProductVersion) } }'
    )
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return {}
    result: dict[str, str] = {}
    for line in out.splitlines():
        line = line.strip()
        if "\t" in line:
            path, version = line.split("\t", 1)
            result[path.strip()] = version.strip()
    _version_cache.update(result)
    return result


def _probe_posix_versions(config: dict[str, Any] | None = None) -> dict[str, str]:
    """{path: version} for PATH-resolved browsers, gated before execution.

    Every candidate must pass :func:`verified_or_none` *before* ``--version``
    runs. A PATH lookup is attacker-influenceable, and ``--version`` is already
    arbitrary code execution, so a rejected candidate is skipped rather than
    probed. Never widen the check to obtain a version.
    """
    result: dict[str, str] = {}
    for name in _SYSTEM_BROWSER_NAMES_POSIX:
        found = shutil.which(name)
        if not found:
            continue
        gated = verified_or_none(found, config)
        if gated is None:
            continue
        try:
            out = subprocess.run([str(gated), "--version"], capture_output=True, text=True, timeout=5).stdout or ""
            m = re.search(r"\d+\.\d+\.\d+\.\d+", out)
            result[str(gated)] = m.group(0) if m else "999.0.0.0"
        except Exception:
            result[str(gated)] = "999.0.0.0"
    return result


def find_local_browser(config: dict[str, Any] | None = None) -> str | None:
    """Find a local Chrome/Edge newer than the bundled stealth Chromium 146.

    Returns the binary path, or None when the bundled Chromium should be kept.
    Every path returned has already passed the provenance gate *before* any
    version probe executed it, so the result is safe to launch.
    """
    versions = (
        _probe_windows_versions(config) if os.name == "nt" else _probe_posix_versions(config)
    )
    best: str | None = None
    best_version = _BUILTIN_CHROMIUM_MIN
    for path, version in versions.items():
        parsed = _parse_version(version)
        if parsed > best_version:
            best, best_version = path, parsed
    if best:
        logger.info(
            "browser_backend: using local browser %s (kernel %s) instead of bundled Chromium",
            best, best_version,
        )
    return best


# ---------------------------------------------------------------------------
# CloakBrowser kernel override (CLOAKBROWSER_BINARY_PATH protocol)
# ---------------------------------------------------------------------------

def resolve_browser_binary(config: dict[str, Any] | None = None) -> str | None:
    """Decide which browser binary CloakBrowser should launch.

    Priority: explicit config ``browser_executable`` > an externally pinned
    ``CLOAKBROWSER_BINARY_PATH`` env var (validated, then left as-is) >
    auto-detected local Chrome/Edge when ``browser_auto_upgrade`` is on
    (default).

    Every returned path has passed the provenance gate. Returns a path to set
    as CLOAKBROWSER_BINARY_PATH, or None to keep the bundled stealth Chromium
    (which the launch path gates separately).
    """
    cfg = config or {}
    explicit = str(cfg.get("browser_executable", "") or "").strip()
    if explicit:
        if Path(explicit).exists():
            return str(verify_browser_executable(explicit, cfg))
        from .security import strict_mode, SecurityError
        if strict_mode():
            raise SecurityError("Configured browser executable is unavailable")
        logger.warning("browser_backend: browser_executable '%s' not found, falling back", explicit)
    env_path = os.environ.get("CLOAKBROWSER_BINARY_PATH", "").strip()
    if env_path and Path(env_path).exists():
        # Externally pinned, but not thereby trusted: the env var is still an
        # input, so it goes through the same allowlist + digest gate.
        return str(verify_browser_executable(env_path, cfg))
    if cfg.get("browser_auto_upgrade", True):
        # find_local_browser gates each candidate before probing it, so a
        # detected path here has already been executed exactly zero times
        # unless it passed.
        detected = find_local_browser(cfg)
        if detected:
            return str(verify_browser_executable(detected, cfg))
    return None


# ---------------------------------------------------------------------------
# patchright launch helpers
# ---------------------------------------------------------------------------

def _patchright_browser_kwargs(config: dict[str, Any] | None) -> dict[str, Any] | None:
    """Browser selection for the patchright backend.

    Explicit ``browser_executable`` wins; otherwise the ``chrome`` channel is
    resolved *by us* and passed as ``executable_path``. Handing patchright a
    bare ``channel=`` would let it resolve and launch whatever Chrome it finds,
    behind the provenance gate; doing the equivalent lookup here keeps the same
    browser while making the launch auditable.

    Returns the launch kwargs, or None when no acceptable local Chrome is
    installed and the caller should use the bundled build instead.
    """
    from .security import SecurityError

    cfg = config or {}
    explicit = str(cfg.get("browser_executable", "") or "").strip()
    if explicit:
        if Path(explicit).exists():
            return {"executable_path": str(verify_browser_executable(explicit, cfg))}
        from .security import strict_mode
        if strict_mode():
            raise SecurityError("Configured browser executable is unavailable")
        logger.warning("browser_backend: browser_executable '%s' not found, using channel=chrome", explicit)
    try:
        resolved = resolve_channel_executable("chrome", cfg)
    except SecurityError:
        raise
    except Exception as exc:  # noqa: BLE001 - defensive: never launch an unprobed binary
        raise SecurityError(f"Could not resolve the chrome channel: {exc}") from exc
    if resolved is None:
        logger.info("browser_backend: no local chrome found, falling back to bundled Chromium")
        return None
    return {"executable_path": str(resolved)}


def _bundled_chromium_kwargs(driver: Any, config: dict[str, Any] | None) -> dict[str, Any]:
    """Gate the bundled stealth Chromium used as the launch fallback.

    It lives in the user-writable Playwright cache, so it is the least
    provenanced binary we could start; ``launch()`` used to reach it with no
    arguments at all. Ask the driver where it is and put that path through the
    same gate rather than letting the launcher pick it implicitly.
    """
    from .security import SecurityError

    try:
        executable = driver.chromium.executable_path
    except Exception as exc:  # noqa: BLE001 - surfaces as "not installed"
        raise SecurityError(
            f"patchright's bundled Chromium could not be resolved: {exc}"
        ) from exc
    return {"executable_path": str(verify_browser_executable(executable, config))}


def _patchright_launch_attempts(config: dict[str, Any] | None, driver: Any) -> list[dict[str, Any]]:
    """Every launch attempt, each with a gate-verified ``executable_path``.

    A refusal of an installed local browser still raises: silently starting a
    different binary would hide that decision. A missing bundled Chromium, or
    one the gate rejects, does not discard a local browser that already passed.
    """
    from .security import SecurityError

    attempts: list[dict[str, Any]] = []
    local = _patchright_browser_kwargs(config)
    if local:
        attempts.append(local)
        if (config or {}).get("browser_executable"):
            return attempts
    try:
        attempts.append(_bundled_chromium_kwargs(driver, config))
    except SecurityError:
        if not attempts:
            raise
    if not attempts:
        raise SecurityError("No verified browser executable is available")
    return attempts


_DESKTOP_UA_TEMPLATE = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/{major}.0.0.0 Safari/537.36"
)


def _clean_patchright_ua(browser: Any, headless: bool) -> str | None:
    """Drop the ``HeadlessChrome/...`` UA prefix that headless Chrome sends.

    Returns a desktop-UA string for the launched kernel's real major version
    (so the UA always matches the actual binary), or None when the version
    cannot be read. Only headless launches need this: non-headless Chrome
    already sends the clean desktop UA.
    """
    if not headless:
        return None
    try:
        major = str(browser.version).split(".")[0]
        if not major.isdigit():
            return None
        return _DESKTOP_UA_TEMPLATE.format(major=major)
    except Exception:
        return None


def _launch_patchright(
    config: dict[str, Any] | None,
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    **kwargs: Any,
) -> Any:
    """Launch via patchright (Playwright sync API, patched driver).

    Tries the verified local Chrome first; if it is missing, retries with the
    bundled chromium build (patchright install chromium). Every attempt names a
    concrete ``executable_path`` that already passed the provenance gate.
    ``humanize`` is a no-op here.
    """
    from patchright.sync_api import sync_playwright

    pw = sync_playwright().start()
    try:
        attempts = _patchright_launch_attempts(config, pw)
    except Exception:
        pw.stop()
        raise
    last_error: Exception | None = None
    for attempt in attempts:  # preferred → bundled chromium fallback
        try:
            browser = pw.chromium.launch(
                headless=headless,
                args=args or [],
                proxy=proxy,
                **attempt,
                **kwargs,
            )
            break
        except Exception as exc:  # noqa: BLE001 - try the fallback binary
            last_error = exc
    else:
        pw.stop()
        raise RuntimeError(
            f"patchright could not launch any browser: {last_error}. "
            "Install Google Chrome or run: patchright install chromium"
        ) from last_error

    # Headless Chrome's UA advertises ``HeadlessChrome``, a clear automation
    # signal to anti-bot checks. Inject a clean desktop UA at the context level
    # (renderer-level override — page-level JS UA spoofing is itself detected,
    # verified via sannysoft: JS override trips HEADCHR_UA, context-level UA is
    # "ok"). setdefault keeps an explicit caller-supplied user_agent.
    clean_ua = _clean_patchright_ua(browser, headless)
    if clean_ua:
        _original_new_context = browser.new_context

        def _new_context_with_clean_ua(*a: Any, **kw: Any) -> Any:
            kw.setdefault("user_agent", clean_ua)
            return _original_new_context(*a, **kw)

        browser.new_context = _new_context_with_clean_ua  # type: ignore[method-assign]

    # Stop the Playwright driver when the browser closes (mirrors CloakBrowser).
    original_close = browser.close

    def _close_with_cleanup() -> None:
        try:
            original_close()
        finally:
            try:
                pw.stop()
            except Exception:
                pass

    browser.close = _close_with_cleanup  # type: ignore[method-assign]
    return browser


def _launch_patchright_persistent(
    config: dict[str, Any] | None,
    user_data_dir: str,
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    **kwargs: Any,
) -> Any:
    """Persistent context via patchright, with the same gated binary fallbacks."""
    from patchright.sync_api import sync_playwright

    pw = sync_playwright().start()
    try:
        attempts = _patchright_launch_attempts(config, pw)
    except Exception:
        pw.stop()
        raise
    last_error: Exception | None = None
    for attempt in attempts:
        try:
            context = pw.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=headless,
                args=args or [],
                proxy=proxy,
                **attempt,
                **kwargs,
            )
            break
        except Exception as exc:  # noqa: BLE001 - try the fallback binary
            last_error = exc
    else:
        pw.stop()
        raise RuntimeError(
            f"patchright could not launch any browser: {last_error}. "
            "Install Google Chrome or run: patchright install chromium"
        ) from last_error

    original_close = context.close

    def _close_with_cleanup() -> None:
        try:
            original_close()
        finally:
            try:
                pw.stop()
            except Exception:
                pass

    context.close = _close_with_cleanup  # type: ignore[method-assign]
    return context


CLOAKBROWSER_REQUIRED_MIN = (0, 5, 9)  # keep in sync with the pyproject extra floor


def _cloakbrowser_dist_version() -> tuple[int, ...] | None:
    try:
        from importlib.metadata import version as _dist_version

        raw = _dist_version("cloakbrowser")
    except Exception:
        return None
    parts: list[int] = []
    for token in raw.split("."):
        digits = "".join(ch for ch in token if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _enforce_cloakbrowser_floor() -> None:
    """Hard gate: stale stealth kernels get flagged by publishers, so browser
    launches refuse to run on an outdated cloakbrowser. Escape hatch for
    offline/emergency use: SCANSCI_ALLOW_OLD_CLOAKBROWSER=1."""
    import os

    if os.environ.get("SCANSCI_ALLOW_OLD_CLOAKBROWSER"):
        return
    raw = None
    try:
        from importlib.metadata import version as _dist_version

        raw = _dist_version("cloakbrowser")
    except Exception:
        pass
    v = _cloakbrowser_dist_version()
    if v is None or v >= CLOAKBROWSER_REQUIRED_MIN:
        return
    required = ".".join(str(x) for x in CLOAKBROWSER_REQUIRED_MIN)
    raise RuntimeError(
        f"cloakbrowser {raw} is below the required minimum {required} — stale stealth "
        "kernels get flagged by publishers. Run: pip install -U cloakbrowser "
        "(escape hatch: set SCANSCI_ALLOW_OLD_CLOAKBROWSER=1)"
    )


def _launch_cloakbrowser(
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    humanize: bool,
    **kwargs: Any,
) -> Any:
    _enforce_cloakbrowser_floor()
    from cloakbrowser import launch

    return launch(headless=headless, humanize=humanize, args=args, proxy=proxy, **kwargs)


def _launch_cloakbrowser_persistent(
    user_data_dir: str,
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    humanize: bool,
    **kwargs: Any,
) -> Any:
    _enforce_cloakbrowser_floor()
    from cloakbrowser import launch_persistent_context

    return launch_persistent_context(
        user_data_dir=user_data_dir,
        headless=headless,
        humanize=humanize,
        args=args,
        proxy=proxy,
        **kwargs,
    )


_CAMOUFOX_EXECUTABLE_NAMES = ("camoufox", "camoufox.exe", "firefox", "firefox.exe")


def _verified_camoufox_executable(config: dict[str, Any] | None) -> str:
    """Resolve Camoufox's real program and return it gate-verified.

    Delegates to :func:`resolve_camoufox_executable`, which resolves the
    owner-selected program first, otherwise the directory *deterministically*
    (never by ``rglob`` order), excludes directories, refuses symlinks/junctions,
    and applies the same allowlist + pinned-digest policy every other browser gets.

    Checking that the install directory exists is not enough: a replaced
    executable inside that directory would still be launched. This never
    downloads anything — a missing Camoufox raises.
    """
    return str(resolve_camoufox_executable(config))


def _camoufox_launch_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Keep raw Camoufox options from replacing the config-verified program."""
    opts = dict(kwargs)
    from_options = opts.pop("from_options", None)
    launch_options = opts.get("launch_options")
    if ("executable_path" in opts or from_options
            or (isinstance(launch_options, Mapping) and "executable_path" in launch_options)):
        from .security import SecurityError
        raise SecurityError(
            "Select the Camoufox program with browser_executable in trusted config; "
            "raw launch options may not replace the verified executable"
        )
    return opts


def _launch_camoufox(
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    humanize: bool,
    config: dict[str, Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Launch via Camoufox (anti-detect Firefox, Playwright API).

    Returns a vanilla ``playwright.sync_api.Browser`` so the rest of the stack
    (contexts, cookies, close) works unchanged. Handles its own Playwright
    driver lifecycle, mirroring the other backends.

    Callers pass Chromium-style flags (--disable-blink-features=..., ...);
    Camoufox is a Firefox fork that configures its own anti-fingerprinting,
    so caller args are dropped rather than handed to the Firefox binary
    (unknown flags end up treated as open-URL arguments there).

    The verified executable is resolved *before* ``NewBrowser`` is called, and
    passed explicitly as ``executable_path`` so Camoufox's own launcher cannot
    substitute a different program behind the gate.
    """
    if args:
        logger.debug("browser_backend: camoufox ignores %d caller arg(s) (Chromium flags)", len(args))
    opts = _camoufox_launch_kwargs(kwargs)
    executable = _verified_camoufox_executable(config)
    from camoufox import DefaultAddons, NewBrowser
    from playwright.sync_api import sync_playwright

    # The bundled uBlock addon downloads at build time and fails (or is
    # rate-limited) -> exclude it, it is not needed for download sessions.
    opts.setdefault("exclude_addons", [DefaultAddons.UBO])
    pw = sync_playwright().start()
    try:
        browser = NewBrowser(
            pw,
            headless=headless,
            humanize=humanize,
            args=[],  # chromium flags dropped — see docstring
            proxy=proxy,
            executable_path=executable,
            **opts,
        )
    except Exception:
        pw.stop()
        raise

    original_close = browser.close

    def _close_with_cleanup() -> None:
        try:
            original_close()
        finally:
            try:
                pw.stop()
            except Exception:
                pass

    browser.close = _close_with_cleanup  # type: ignore[method-assign]
    return browser


def _launch_camoufox_persistent(
    user_data_dir: str,
    headless: bool,
    proxy: Any,
    args: list[str] | None,
    humanize: bool,
    config: dict[str, Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Persistent context via Camoufox (returns a BrowserContext).

    Caller args (Chromium flags) are dropped — see _launch_camoufox. The
    verified executable is resolved before ``NewBrowser`` and passed explicitly,
    exactly as on the non-persistent path.
    """
    if args:
        logger.debug("browser_backend: camoufox ignores %d caller arg(s) (Chromium flags)", len(args))
    opts = _camoufox_launch_kwargs(kwargs)
    executable = _verified_camoufox_executable(config)
    from camoufox import DefaultAddons, NewBrowser
    from playwright.sync_api import sync_playwright

    opts.setdefault("exclude_addons", [DefaultAddons.UBO])
    pw = sync_playwright().start()
    try:
        context = NewBrowser(
            pw,
            persistent_context=True,
            user_data_dir=user_data_dir,
            headless=headless,
            humanize=humanize,
            args=[],  # chromium flags dropped — see _launch_camoufox
            proxy=proxy,
            executable_path=executable,
            **opts,
        )
    except Exception:
        pw.stop()
        raise

    original_close = context.close

    def _close_with_cleanup() -> None:
        try:
            original_close()
        finally:
            try:
                pw.stop()
            except Exception:
                pass

    context.close = _close_with_cleanup  # type: ignore[method-assign]
    return context


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------

def _proxy_from_config(config: dict[str, Any] | None) -> Any:
    """Playwright proxy dict from config, or None.

    Camoufox (Firefox) ignores Chromium's --proxy-server launch arg, so the
    configured egress (browser_static_proxy, else network_proxy) must be
    passed explicitly — otherwise camoufox always goes direct and every
    proxy-required host times out.
    """
    cfg = config or {}
    proxy = (str(cfg.get("browser_static_proxy", "") or "").strip()
             or str(cfg.get("network_proxy", "") or "").strip())
    if not proxy:
        return None
    from .browser_engine import _proxy_server_without_credentials
    from urllib.parse import urlsplit
    parts = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    server = _proxy_server_without_credentials(proxy)
    if not server:
        return None
    payload: dict[str, str] = {"server": server}
    if parts.username:
        payload["username"] = parts.username
    if parts.password:
        payload["password"] = parts.password
    return payload


def launch(
    *,
    headless: bool = True,
    proxy: Any = None,
    args: list[str] | None = None,
    humanize: bool = True,
    config: dict[str, Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Launch the resolved backend's stealth browser (Playwright sync API).

    ``humanize`` is accepted for CloakBrowser compatibility and ignored on
    the patchright backend. Returns the same object as
    ``playwright.chromium.launch()`` / ``cloakbrowser.launch()``.
    """
    from .security import strict_mode
    if strict_mode() and not isinstance(config, dict):
        from .security import SecurityError
        raise SecurityError("Hosted browser launch requires trusted config")
    backend = resolve_backend(config)
    if strict_mode():
        from .browser_guard import browser_proxy
        from .network import configured_proxy
        proxy = browser_proxy(configured_proxy(config) or None)
        if backend == BACKEND_CLOAKBROWSER:
            if not _installed_cloakbrowser(config):
                from .security import SecurityError
                raise SecurityError("Configured CloakBrowser binary is unavailable")
        if backend == BACKEND_CAMOUFOX:
            # Camoufox must already be installed; never fetch executable code in
            # response to a paper URL or a browser-fallback trigger. The check
            # is the real binary, not merely the install directory.
            _verified_camoufox_executable(config)
            kwargs['firefox_user_prefs'] = {**kwargs.get('firefox_user_prefs', {}),
                'network.proxy.no_proxies_on': '', 'network.proxy.allow_hijacking_localhost': True,
                'media.peerconnection.enabled': False, 'network.http.http3.enable': False}
        else:
            args = [*(args or []), '--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
    if backend == BACKEND_CAMOUFOX and proxy is None:
        proxy = _proxy_from_config(config)
    if backend == BACKEND_PATCHRIGHT:
        if humanize:
            logger.debug("browser_backend: humanize not supported by patchright, ignored")
        browser = _launch_patchright(config, headless=headless, proxy=proxy, args=args, **kwargs)
        return _guard_context_proxy(browser, proxy) if strict_mode() else browser
    if backend == BACKEND_CAMOUFOX:
        browser = _launch_camoufox(headless=headless, proxy=proxy, args=args, humanize=humanize, config=config, **kwargs)
    else:
        if not strict_mode():
            binary = resolve_browser_binary(config)
            if binary:
                os.environ['CLOAKBROWSER_BINARY_PATH'] = binary
        browser = _launch_cloakbrowser(headless=headless, proxy=proxy, args=args, humanize=humanize, **kwargs)
    return _guard_context_proxy(browser, proxy) if strict_mode() else browser


def launch_persistent_context(
    user_data_dir: str,
    *,
    headless: bool = True,
    proxy: Any = None,
    args: list[str] | None = None,
    humanize: bool = True,
    config: dict[str, Any] | None = None,
    **kwargs: Any,
) -> Any:
    """Launch the resolved backend with a persistent profile.

    Same contract as ``playwright.chromium.launch_persistent_context()``.
    """
    from .security import strict_mode, workspace_path
    if strict_mode():
        from .security import SecurityError
        if not isinstance(config, dict):
            raise SecurityError("Hosted browser launch requires trusted config")
        workspace_path(user_data_dir)
        # Native profiles bypass scoped credential exports; never reopen them.
        context_keys = {"viewport", "user_agent", "locale", "timezone_id", "accept_downloads"}
        context_options = {key: kwargs.pop(key) for key in list(kwargs) if key in context_keys}
        kwargs.pop("ignore_https_errors", None)
        browser = launch(headless=headless, proxy=proxy, args=args, humanize=humanize,
                         config=config, **kwargs)
        try:
            context = browser.new_context(**context_options)
        except Exception:
            browser.close()
            raise
        original_close = context.close

        def close():
            try:
                original_close()
            finally:
                browser.close()

        context.close = close
        return context
    backend = resolve_backend(config)
    if backend == BACKEND_CAMOUFOX and proxy is None:
        proxy = _proxy_from_config(config)
    if backend == BACKEND_PATCHRIGHT:
        if humanize:
            logger.debug("browser_backend: humanize not supported by patchright, ignored")
        context = _launch_patchright_persistent(
            config, user_data_dir, headless=headless, proxy=proxy, args=args, **kwargs
        )
    elif backend == BACKEND_CAMOUFOX:
        context = _launch_camoufox_persistent(
            user_data_dir, headless=headless, proxy=proxy, args=args, humanize=humanize, config=config, **kwargs
        )
    else:
        binary = resolve_browser_binary(config)
        if binary:
            os.environ['CLOAKBROWSER_BINARY_PATH'] = binary
        context = _launch_cloakbrowser_persistent(
            user_data_dir, headless=headless, proxy=proxy, args=args, humanize=humanize, **kwargs)
    return context


def browser_info(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Human-readable info about the current backend for diagnostics.

    Returns {"backend": ..., "binary": ..., "version": ...}.
    """
    cfg = config or {}
    backend = resolve_backend(cfg)
    info: dict[str, Any] = {"backend": backend, "binary": "", "version": ""}
    if backend == BACKEND_PATCHRIGHT:
        binary = ""
        explicit = str(cfg.get("browser_executable", "") or "").strip()
        # Report the verified program, or say plainly that it is not verified —
        # never name an unprovenanced path as the browser in use.
        if explicit and verified_or_none(explicit, cfg) is not None:
            binary = explicit
        else:
            try:
                resolved = resolve_channel_executable("chrome", cfg)
            except Exception:
                resolved = None
            if resolved:
                binary = str(resolved)
            else:
                versions = (
                    _probe_windows_versions(cfg) if os.name == "nt" else _probe_posix_versions(cfg)
                )
                for path, version in versions.items():
                    if "chrome" in path.lower():
                        binary, info["version"] = path, version
                        break
                else:
                    binary = "channel=chrome"
        info["binary"] = binary
        return info
    if backend == BACKEND_CAMOUFOX:
        # Report the program this engine would actually launch, gated — not a
        # guessed INSTALL_DIR path that may not exist or may not be approved.
        try:
            info["binary"] = _verified_camoufox_executable(cfg)
        except Exception as exc:  # noqa: BLE001 - diagnostics never raise
            info["binary"] = "camoufox (unverified)"
            info["version"] = f"not launchable: {exc}"
            return info
        try:
            from camoufox.pkgman import Version
            installed = Version.from_path()
            info["version"] = installed.full_string if installed.is_supported() else "unsupported"
        except Exception:
            info["version"] = "?"
        return info
    # CloakBrowser backend
    binary = resolve_browser_binary(cfg)
    try:
        from cloakbrowser.config import get_chromium_version
        bundled = get_chromium_version()
    except Exception:
        bundled = "?"
    if binary:
        info["binary"] = binary
        info["version"] = f"local (bundled {bundled})"
    else:
        info["binary"] = "bundled stealth Chromium"
        info["version"] = bundled
    return info
