"""FastAPI web interface for ScanSci PDF.

The UI and its API are authenticated with a bearer token (env
``SCANSCI_WEB_TOKEN``, else config ``web_token``, else generated per process).
The browser page receives the token only after an authenticated GET /, and a
small injected shim attaches it plus the ``X-Requested-With`` header to every
same-origin fetch, which is also what blocks CSRF on the POST endpoints.
"""

from __future__ import annotations

import hmac
import os
import re
import secrets
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from .config import load_config, mask_config_value
from .identifiers import is_arxiv_identifier, normalize_doi
from .log import get_logger
from .search import search_papers
from .security import SecurityError, no_symlinks
from .sources import download

log = get_logger()

_TEMPLATE_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(_TEMPLATE_DIR))
templates.env.cache_size = 0

app = FastAPI(
    title="ScanSci PDF",
    description="Academic paper downloader web UI",
    # Interactive docs would expose the whole route schema on an
    # authenticated surface; they are not part of the hosted package.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


# --- Auth ---

TOKEN_ENV = "SCANSCI_WEB_TOKEN"
TOKEN_CONFIG_KEY = "web_token"
_TOKEN_BYTES = 32
_generated_token = ""
# The token is handed over once, as an HttpOnly cookie, and never rendered into
# the page. It must not travel in the query string: uvicorn's access log
# records the full request target, and a URL also leaks through history and
# Referer. It must not be readable by page JavaScript either, so the Tailwind
# and Alpine scripts this template loads from a CDN cannot lift it and call
# the local API on the user's behalf.
_AUTH_COOKIE = "scansci_token"
# Restrictive default: no framing, no cross-origin anything, no plugin
# content. script-src additionally allows the two CDNs the shipped template
# uses; scripts they inject are same-origin from the browser's perspective.
_CSP = (
    "default-src 'self'; "
    "script-src 'self' https://cdn.tailwindcss.com https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)
_AUTH_SHIM = """<script>
(function () {
  // The bearer token lives in an HttpOnly cookie; JavaScript cannot read it.
  // Requests are same-origin, so the cookie authenticates them; the custom
  // header is what stops a cross-site form post from forging a write.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const options = Object.assign({}, init);
    const headers = new Headers((init && init.headers) || {});
    headers.set('X-Requested-With', 'XMLHttpRequest');
    options.headers = headers;
    options.credentials = 'same-origin';
    return nativeFetch(input, options);
  };
})();
</script>
"""


def web_token() -> str:
    """Bearer token for the web UI: env, else config, else one generated per process."""
    global _generated_token
    token = os.environ.get(TOKEN_ENV, "").strip() or str(load_config().get(TOKEN_CONFIG_KEY) or "").strip()
    if token:
        return token
    if not _generated_token:
        _generated_token = secrets.token_urlsafe(_TOKEN_BYTES)
    return _generated_token


def _request_token(request: Request) -> str:
    """Token from the Authorization header, X-ScanSci-Token, the session cookie, or ?t=."""
    authorization = request.headers.get("Authorization", "")
    if authorization[:7].lower() == "bearer ":
        return authorization[7:].strip()
    header = request.headers.get("X-ScanSci-Token", "").strip()
    if header:
        return header
    cookie = request.cookies.get(_AUTH_COOKIE, "").strip()
    return cookie or request.query_params.get("t", "").strip()


def require_auth(request: Request) -> None:
    """Reject requests without the bearer token, before any handler runs."""
    candidate = _request_token(request)
    if not candidate or not hmac.compare_digest(candidate, web_token()):
        raise HTTPException(status_code=401, detail="Unauthorized")


def require_csrf(request: Request) -> None:
    """A cross-site form post cannot set X-Requested-With, so it cannot forge a POST."""
    if request.headers.get("X-Requested-With", "") != "XMLHttpRequest":
        raise HTTPException(status_code=403, detail="Missing X-Requested-With header")


def _auth_page(html_text: str) -> str:
    """Inject the fetch shim. No token is rendered into the page."""
    if "</head>" in html_text:
        return html_text.replace("</head>", _AUTH_SHIM + "</head>", 1)
    return _AUTH_SHIM + html_text


# --- Security headers ---


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    """Apply the CSP and referrer policy to every response, not just the page."""
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", _CSP)
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Cache-Control", "no-store")
    return response


# --- Request/Response models ---

class DownloadRequest(BaseModel):
    identifier: str


class SearchRequest(BaseModel):
    query: str
    limit: int = 10


# --- Helper ---

_DOI_PATTERN = re.compile(r"^10\.\d{4,}/")
_DOI_URL_PATTERN = re.compile(r"https?://doi\.org/")


def _contained_output_file(file_path: str, output_dir: str) -> Path | None:
    """Resolve a download-layer path and keep it only if it stays inside output_dir.

    Containment is decided on fully resolved paths, never on string prefixes, and
    symlinks/junctions are refused outright (a link inside output_dir that points
    outside resolves outside and is rejected by the same check).
    """
    if not file_path or not output_dir:
        return None
    try:
        root = Path(output_dir).expanduser()
        target = Path(file_path).expanduser()
        no_symlinks(root)
        no_symlinks(target)
        root_resolved = root.resolve()
        target_resolved = target.resolve()
    except (SecurityError, OSError, RuntimeError, ValueError):
        return None
    if target_resolved == root_resolved or not target_resolved.is_relative_to(root_resolved):
        return None
    return target_resolved


def _is_doi_or_arxiv(text: str) -> bool:
    """Check if input looks like a DOI or arXiv ID (not a title)."""
    text = text.strip()
    if is_arxiv_identifier(text):
        return True
    if _DOI_URL_PATTERN.match(text):
        return True
    if _DOI_PATTERN.match(text):
        return True
    return False


def _check_sources(config: dict[str, Any]) -> dict[str, Any]:
    """Check availability of key download sources."""
    sources: dict[str, bool | str] = {}

    # CloakBrowser
    try:
        from .browser_engine import is_available
        cb_available = is_available(config)
        sources["cloakbrowser"] = cb_available
    except Exception:
        sources["cloakbrowser"] = False

    # Tor
    try:
        from .tor import check_tor_circuit
        tor_ok = check_tor_circuit(config)
        sources["tor"] = tor_ok
    except Exception:
        sources["tor"] = False

    # WebVPN
    sources["webvpn"] = bool(config.get("webvpn_cookies"))

    # CARSI
    sources["carsi"] = bool(config.get("carsi_cookies"))

    # Sci-Hub
    sources["scihub"] = config.get("scihub_enabled", True)

    return sources


# --- Routes ---

@app.get("/", response_class=HTMLResponse, dependencies=[Depends(require_auth)])
async def index(request: Request):
    page = templates.get_template("index.html").render({"request": request})
    response = HTMLResponse(_auth_page(page))
    # A ?t= link is a one-time handover: hand the token to an HttpOnly cookie
    # so later requests never repeat it in a URL that uvicorn logs.
    if request.query_params.get("t", "").strip():
        response.set_cookie(
            _AUTH_COOKIE,
            web_token(),
            httponly=True,
            samesite="strict",
            path="/",
        )
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = _CSP
    return response


@app.post("/api/download", dependencies=[Depends(require_auth), Depends(require_csrf)])
async def api_download(req: DownloadRequest):
    """Download a paper by DOI or arXiv ID. Returns PDF file or error JSON."""
    import asyncio

    identifier = req.identifier.strip()
    if not identifier:
        return JSONResponse({"success": False, "error": "Empty identifier"}, status_code=400)

    # Normalize DOI URL to bare DOI
    if _DOI_URL_PATTERN.match(identifier):
        identifier = _DOI_URL_PATTERN.sub("", identifier)

    # If input looks like a title (not DOI/arXiv), try to resolve first
    if not _is_doi_or_arxiv(identifier):
        from .resolver import resolve_title_to_doi
        config = load_config()
        doi = resolve_title_to_doi(identifier, config)
        if doi:
            identifier = doi
        else:
            return JSONResponse(
                {"success": False, "error": f"Could not resolve title to DOI: {identifier}"},
                status_code=404,
            )

    # Run download in a worker thread to avoid blocking the event loop.
    # asyncio.to_thread is the modern replacement for run_in_executor(None, fn)
    # and avoids deprecation warnings around get_event_loop() in async context.
    result = await asyncio.to_thread(download, identifier)

    if result.get("success"):
        file_path = result.get("file", "")
        source = result.get("source", "unknown")
        output_dir = str(load_config().get("output_dir", ""))
        target = _contained_output_file(file_path, output_dir)
        if target is None:
            log.warning("   [web] Refusing to serve a file outside output_dir: %s", file_path)
            return JSONResponse(
                {"success": False, "error": "Refusing to serve a file outside the output directory"},
                status_code=403,
            )
        if target.is_file():
            return FileResponse(
                target,
                media_type="application/pdf",
                filename=target.name,
                headers={"X-ScanSci-Source": source},
            )
        return JSONResponse(
            {"success": False, "error": "PDF file not found on disk after download"},
            status_code=500,
        )

    # Enhance error response with actionable guidance
    error_response = dict(result)
    config = load_config()
    sources = _check_sources(config)
    error_response["sources"] = sources

    # Add specific guidance based on what's available
    guidance = error_response.get("guidance", [])
    if not sources.get("cloakbrowser"):
        guidance.insert(0, "CloakBrowser is not running. Start it to enable browser-based downloads for paywalled papers.")
    if not sources.get("tor"):
        guidance.append("Tor is not running. Start Tor for anonymous Sci-Hub access.")

    error_response["guidance"] = guidance
    return JSONResponse(error_response, status_code=404)


@app.post("/api/search", dependencies=[Depends(require_auth), Depends(require_csrf)])
async def api_search(req: SearchRequest):
    """Search papers by keyword. Returns list of results."""
    query = req.query.strip()
    if not query:
        return JSONResponse([], status_code=400)

    # Normalize DOI URL
    if _DOI_URL_PATTERN.match(query):
        query = _DOI_URL_PATTERN.sub("", query)

    # If input is a DOI/arXiv, skip search and return a single-item result
    if _is_doi_or_arxiv(query):
        return JSONResponse([{"doi": normalize_doi(query) if not is_arxiv_identifier(query) else query, "title": "", "is_direct": True}])

    results = search_papers(query, limit=req.limit)
    return JSONResponse(results)


@app.get("/api/status", dependencies=[Depends(require_auth)])
async def api_status():
    """Health check with source availability."""
    config = load_config()
    # Only booleans and the output path are echoed; the path goes through the
    # config masker so a credential-looking value can never be surfaced here.
    sources = {name: bool(value) for name, value in _check_sources(config).items()}

    return JSONResponse({
        "status": "ok",
        "output_dir": mask_config_value("output_dir", config.get("output_dir", "")),
        "sources": sources,
    })
