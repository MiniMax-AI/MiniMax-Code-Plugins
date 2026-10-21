# Add ScanSci PDF: source-only academic paper retrieval plugin

## Package and maintenance

This plugin supplies two Skills (`scansci-pdf` and `scansci-sort`) and a local
stdio MCP server for DOI/arXiv retrieval, search, citations and reading-list
triage. It vendors a patched source-only fork of upstream ScanSci PDF v1.18.0,
commit `ec812f085f392a9b67768fbcad7ddeb340e0245f`, under Apache-2.0.

The submitted plugin is `1.18.0-minimax.2`; the vendored engine is
`1.18.0.post2`. It includes Python source and packaged helper scripts, not only
Markdown/JSON. It does not use a PyPI engine installation or a `scansci-pdf`
executable found on PATH. No precompiled engine extensions, browser binaries,
credentials or downloaded Tor executables are bundled.

## Dependencies and startup

- Node >=22 and Python >=3.11 are required. Install the hash-locked dependencies
  from `vendor/scansci-pdf/requirements.lock` into a prepared Python environment;
  browser workflows use `requirements-browser.lock` and an owner-installed browser.
- `mcp.json` starts `launch_secure.mjs`, which probes a supported interpreter,
  binds its absolute path and launches `run_secure.py` with Python `-I`.
  `SCANSCI_PDF_PYTHON` can name the absolute interpreter of the prepared environment.
- The launcher verifies delivered source hashes and installed dependency versions.
  These checks are local integrity checks, not upstream signatures or an
  interpreter/site-package authenticity attestation.
- CLI and sorting helpers use that same packaged bootstrap from the user's project
  workspace. Direct Python invocation requires `python -I .../run_secure.py`.

## Data and network behavior

Configuration, caches and scoped credential exports stay in the active project's
private `.scansci-pdf/` directory, not an implicit home-directory engine state.
Python path/write checks reject existing symlink/junction escapes. Destructive
cache operations and workbook overwrite require explicit owner confirmation.

Requests contact scholarly APIs, publisher/CDN endpoints, enabled mirrors and
user-authorized institutional gateways. Users can select `legal_only` to restrict
retrieval sources. Unpaywall requires the user's real email. Institutional routes
require the user's own account/entitlement; no account or access is supplied.

Hosted transport requires public HTTPS, validates destinations at connection and
redirect boundaries, and retains hostname TLS validation. Explicit owner-configured
proxies remain supported. Local browser traffic uses an authenticated CONNECT guard;
remote browser services are unavailable in hosted mode. Paper content, links and
metadata are treated as untrusted external data, not instructions.

## Response to the October 12 review

This revision targets the seven findings on `0acd104`:

1. Hosted native browser profiles are not reopened or cloned. Only scoped credential
   exports are restored; localStorage requires opt-in and an exact origin.
2. Cookie identity/security fields must be complete and valid before restoration or
   migration. Incomplete legacy records require re-login rather than weakened defaults.
3. Zotero API credentials use origin-confined transport. Storage origins are
   allowlisted; uploads do not receive API keys or follow redirects. One multipart
   stream is followed by checked API-origin registration.
4. Browser launch sites propagate trusted configuration, enforce explicit executable
   selection and verify the actual program and digest, including Camoufox.
5. CLI/log/error/MCP output uses shared secret redaction. Direct and bulk configuration
   saves use typed trust-change comparison and independent mutable defaults, and require
   actual boolean confirmation. A valid replacement for a corrupt stored pin requires
   confirmation too, rather than silently inheriting trust or permanently blocking repair.
6. Isolated bootstrap startup and the delivered stdio process are exercised with the
   locked SDK, including its current and legacy schema attribute names.
7. Main-repository exact-head Checks still require maintainer approval. This account has
   read-only access to the upstream repository; actual approval and re-run API requests
   were rejected with HTTP 403 on October 14. Local tests and successful fork runs do not
   substitute for upstream Checks.

## Validation and explicit limits

Local results, reproducible checks and skipped cases are recorded in
`REVIEW-NOTES.md`; `REVIEW-REPLY.md` is the corresponding review response.
The submitted SHA and service-side workflow results are recorded separately in the PR.
These local documents do not claim upstream CI/CodeQL approval or a green upstream check.

- Windows Python 3.11.17 and 3.13.16: each 1002 passed, 5 skipped, 0 failed with
  an approved installed Edge browser and local intercepted fixtures.
- Delivered `mcp.json` -> Node -> isolated Python stdio: both versions pass, 18 tools.
- Source/dependency verification passes; independent source rehash has 173 entries
  and no mismatches. Repository schema validation and static checks pass.
- Root npm tests remain 336 passed, 6 failed, 3 skipped on this Windows host:
  one symlink-privilege failure and five unchanged octopus-meme-maker smoke assertions.
  No repository-wide green result is claimed.

Windows Python 3.11/3.13 and locally intercepted real Edge fixtures are the local
runtime coverage. Live institutional login, publisher entitlement, successful live
Zotero upload, real Camoufox/Firefox, and Linux/macOS runtime behavior are not
established by those fixtures. Python audit checks are not an OS sandbox and do not
claim resistance to concurrent replacement of filesystem ancestors.

This description supersedes the original PyPI/PATH-only packaging description: the
submitted package vendors and executes the verified source-only engine described here.
