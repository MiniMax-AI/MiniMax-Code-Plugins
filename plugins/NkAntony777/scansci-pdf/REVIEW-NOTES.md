## Round-4 repair, October 14, 2026

This section supersedes earlier safety descriptions where they differ. These are local validation
results, not upstream GitHub Checks. The submitted commit and any fork-hosted run links are recorded
separately in the PR; no upstream workflow approval or CodeQL pass is claimed here.
Plugin version is 1.18.0-minimax.2; the source-only engine is 1.18.0.post2.

1. Native browser profile persistence: hosted launch_persistent_context creates a non-persistent
   browser context and owns its browser cleanup. It never opens the requested legacy profile.
   Both publisher-batch implementations refuse to clone native profiles. Live SSO remains available
   in a context; across runs only scoped exports may be restored and re-login can be necessary.
   Existing legacy profiles are not deleted. localStorage export/restore uses an exact origin,
   including scheme and port, and still requires owner opt-in.
2. Cookie migration: all identity and security fields must exist with valid types before scoped
   save/restore/import/merge. Incomplete records, non-finite expiry, invalid SameSite and weakened
   SameSite=None records are discarded rather than normalized into apparently complete credentials.
3. Zotero: Zotero-API-Key joins the origin-confined credential header set. Every real API request
   uses that transport and disables redirects. Storage upload origins have a small explicit HTTPS
   allowlist (www.zotero.org and the declared Zotero S3 origins); API keys never go to storage.
   Full uploads stream prefix/file/suffix in one request, with an unambiguous Content-Length, then
   register uploadKey at the API origin. Redirects and failed registration are visible failures.
   Protocol reference: https://www.zotero.org/support/dev/web_api/v3/file_upload
   No successful live Zotero service upload is claimed.
4. Browser config: every production launch call supplies config (also checked by an AST regression).
   Hosted calls without config fail before backend selection. Explicit missing backends/binaries
   fail closed, pins remain enforced, and a changed config invalidates the thread-local/live-browser
   cache. Native-profile and normal browser calls share the provenance gate. Camoufox honors an
   explicit browser_executable before installation discovery, refuses an invalid selection rather
   than falling back, and rejects raw launch options that would replace the verified program.
5. Sensitive output/trust writes: a process-local secret registry covers values loaded/set in config,
   proxy passwords keep the existing structural masker, and CLI print/streams, logs/tracebacks,
   Rich consoles and MCP JSON share redaction. Structured credential keys are masked without masking
   Zotero object identifiers needed for retries. Both bulk save_config and single-key update_config
   compare trust-affecting changes before any persistence and require actual boolean confirmation.
   Trust booleans are compared, loaded and saved with the same fail-closed semantics; a string
   "False" cannot enable automatic browser selection. Legacy boolean and relative-profile migration
   do not turn unrelated updates into new trust decisions. Mutable defaults are independently copied,
   so in-place pin changes cannot mutate the comparison baseline. A corrupt stored pin can be
   replaced with a valid pin only after explicit confirmation; invalid replacements remain refused.
   Both CLI surfaces expose --confirm-trust; MCP uses confirmed:true. Callers may not infer consent.
6. Interpreter: mcp.json uses the packaged source-only Node bootstrap (Node >=22); the host may set
   SCANSCI_PDF_PYTHON to an absolute prepared-environment interpreter. Otherwise it probes python3,
   then python, using -I -S, checks >=3.11, and binds the absolute returned interpreter. Engine and
   child module launches use -I; inherited PYTHON* state is removed by the bootstrap. run_secure.py
   independently rejects an old interpreter or an unisolated launch. The bootstrap is source-hashed,
   but these checks do not attest interpreter authenticity or owner-managed site-package signatures.
   The actual stdio acceptance script reads the locked MCP 2.x input_schema attribute, with a
   tested fallback for the MCP 1.x inputSchema attribute.

Validation of the final source revision:

- Windows Python 3.13.16: 1002 passed, 5 skipped, 0 failed (1007); real approved Edge enabled,
  156.29 seconds after the final cross-review repairs.
- Windows Python 3.11.17: 1002 passed, 5 skipped, 0 failed (1007); real approved Edge enabled,
  153.58 seconds after the final cross-review repairs.
- Fresh publication recheck: the same 1002-pass/5-skip result on both interpreters,
  Python 3.11 in 148.17 seconds and Python 3.13 in 147.62 seconds. Actual delivered stdio,
  strict school-confirmation/atomic setup, source/dependency verification, independent rehash,
  root schema validation, Node syntax and whitespace checks were also repeated successfully.
- Actual delivered mcp.json -> Node bootstrap -> isolated Python stdio: passed on both interpreters.
  18 tools; initialize/tools-list, DOI parsing, outside-workspace rejection, Tor confirmation,
  masked secret config, helper overwrite confirmation and modified-source rejection exercised.
- SOURCE-HASHES.json independently recomputed: 173 entries, no mismatches.
- Repository npm run validate: passed, 29 hosted plugins and all examples.
- Root npm test: 336 passed, 6 failed, 3 skipped (345). One failure is an EPERM
  symlink creation in test/hosted-plugins.test.mjs; five are unchanged octopus-meme-maker
  CRLF/frontmatter-sensitive smoke assertions. These are not ScanSci engine failures;
  no repository-wide green test result is claimed, and those files were not modified.
- git diff --check and Node bootstrap syntax: passed.
- The first 27 focused round-4 tests all failed against the original implementation and passed
  after the core changes. Additional coverage exercises real browser restart, both native-profile
  clone paths, CLI subprocesses, split secret writes, upload redirect/refusal and interpreter startup.
- The local review follow-up adds 80 regressions: 42 typed trust/migration/default-isolation cases, 29 Camoufox
  executable-selection/raw-option cases and 9 SDK-schema compatibility cases. The first 27
  Camoufox cases failed before this follow-up repair. The full-suite MCP schema failure observed
  during review is fixed rather than excluded or bypassed.
- Final local logs are under the workspace directory
  `repair-review-followup-20261014/final-r2-*.log`; earlier failing review and first repair runs
  are separate from this final result. Publication recheck logs are under
  `pr64-publish-verify-20261014/`. PR-BODY.md supplies the corrected PR description.
  Upstream Checks remain a separate approval-gated release requirement.

Five full-suite skips: three unavailable Windows symlink-privilege cases, absent second-checkout
comparison and the intentionally optional Generic-strategy prefix case. The real browser fixtures
intercept responses locally: no real institutional login, publisher retrieval or service entitlement
is demonstrated. No Linux/macOS or real Camoufox/Firefox execution is claimed here. Linux/Windows
3.11/3.13 workflow wiring now installs Node 22 and exercises the isolated launch; the upstream run
still requires maintainer approval on a new submitted head. Native libraries/browser children are
not an OS sandbox, and concurrent filesystem ancestor replacement remains a documented limitation.

# PR #64: patched engine, security and performance

This plugin now owns a source-only ScanSci fork based on upstream v1.18.0,
commit `ec812f085f392a9b67768fbcad7ddeb340e0245f`. It launches the vendored source directly,
verifies normalized source hashes and installed dependency versions, ignores bytecode caches,
and installs dependencies using hash-locked requirements. The hash manifest detects accidental
or isolated source changes; it is not an independent signature against replacement of the
entire plugin by someone who can also replace the launcher and manifest.

## Maintainer findings addressed

- Public HTTPS only for untrusted queue links and source downloads. Resolve all DNS answers
  at the connection boundary, reject private/link-local/metadata addresses, connect numeric IPs,
  retain original hostname TLS validation, and enforce policy at each redirect/new connection.
- Explicit owner-configured HTTP(S)/SOCKS5 proxies remain usable. Numeric CONNECT/SOCKS targets
  prevent remote DNS from choosing a private destination. This assumes the configured proxy
  itself is trusted infrastructure; it does not defend against a malicious proxy operator.
- Browser fallback and institutional login use an authenticated local CONNECT guard. QUIC and
  non-proxied WebRTC are disabled. Guarded contexts retain the proxy and TLS verification.
- Tor archives require source-controlled SHA-256 pins. All members are checked before extraction;
  links, traversal, device files, duplicate paths and excessive sizes are rejected. Installation
  is staged, requires confirmation, and cached executable/support files are checked against
  the pinned archive before execution. Hosted mode does not execute `tor` from arbitrary PATH.
- Generic secret masking covers Springer keys. Config/cookie writes are private and atomic;
  Windows credentials use a current-user SID directory ACL, Unix uses 0700 directories/0600 files.
- Inputs and Python writes remain within the project, with symlink/junction checks. Cache deletion
  and workbook overwrite require explicit confirmation. Workbook serialization is atomic and
  text cells neutralize spreadsheet formula prefixes. Similar-size PDFs are no longer silently
  deleted as duplicates; content hashes must match.
- Paper text, links and metadata are marked untrusted external data in tool responses and Skills.
- Root `mcp.json` participates in repository schema validation; packaged helpers are present.

## Follow-up repair, October 11, 2026

This section supersedes the October 9 functional/security counts below; those older numbers and performance measurements are historical. The counts below were measured on the worktree before committing this revision. Post-commit rechecks are recorded separately; no same-head GitHub CI result is claimed.

Cookie save/restore now preserves security and lifecycle attributes across browser JSON, the plugin's Netscape format, requests and institutional paths. Legacy four-field records are rejected before defaults can launder them; re-login once after upgrading. Target authorization is required on both sides, including merge/handoff/import. localStorage has a shared fail-closed boolean parser and remains off by default.

All Elsevier exits use origin-confined transport, and shared proxy redaction covers exceptions, mapping keys/deep structures, logs, result JSON and Rich consoles. Batch/Zotero paths are constrained before opening; Zotero attachment failures remain visible as partial failures. Browser version probes and all launch routes check the actual executable; changing trust pins needs explicit confirmation. Both Web entries disable token-bearing access logs; unauthenticated streamable HTTP cannot bind publicly. Secure module launch, real stdio MCP and source tamper rejection are covered using an unchanged delivered manifest and lockfiles.

A fresh short-path Windows environment is installed with hash-locked `requirements-browser.lock`, avoiding both the previous pycparser drift and Windows environment-install path limits without changing any delivery pins. Chrome 154.0.8037.98 passed a real production save/restore round-trip with intercepted local responses (no real account login or publisher fetch). HttpOnly/Secure/SameSite, persistent expiry, session expiry and expired-cookie removal were observed in the real browser. Final full-suite run with that real-browser test enabled: **767 passed, 5 skipped, 0 failed** (772), 137.05 seconds. The five skips are three unavailable symlink-privilege cases, one absent second-checkout comparison and one Generic-strategy optional-prefix case. Manifest independent rehash: **172 entries, 0 mismatches, 0 omissions**. Actual stdio MCP lists 18 tools and checks DOI parsing, path escape, Tor confirmation, secret masking, write-back confirmation, clean verification and tamper rejection.

Linux/Windows CI now records its checkout SHA, runs launcher verification and opts into this real-browser round trip. GitHub execution is not claimed here. Camoufox/Firefox validation is still stub/kwargs coverage, not a real browser launch. Live institutional/Elsevier/Zotero services, Linux/macOS runtime behavior, physical power-loss, and resistance to concurrent filesystem ancestor replacement are not established by these tests.

## Local evidence, October 9, 2026

Windows, Python 3.13; optional browser dependencies installed from the lock:

- Focused security/transport/pipeline run: **38 passed, 1 skipped** (Windows symlink privilege).
- Final vendored engine suite: **429 passed, 3 skipped** (432 tests), including DOI-list parsing,
  rename data preservation and forced browser/context proxy regression cases.
- Real Chrome: allowed fixture HTTPS page works; private/metadata redirect, loopback HTTPS and
  HTTP local requests fail or receive proxy 403; the private fixture handlers are never reached.
- Actual stdio MCP: 18 tools; DOI-only list parses, outside-workspace input is rejected,
  Tor installation demands confirmation, and configured Springer key is masked.
- Official Windows Tor 15.0.24 archive downloaded for inspection: pinned SHA-256
  `e9dc6ccc93cd6afa507193f4de284d6424233ff5102155cd2c94b259e8a22b65` matched;
  guarded extraction and installed-file verification passed. The Python direct downloader
  timed out against both mirrors on this network. No working Tor circuit is claimed.
- Repository `npm run validate`: **passed**, including the root MCP schema.
- Root `npm test` across all plugins is **not green on this Windows host**: unrelated plugins
  fail LF-only YAML-frontmatter assumptions and Python GBK decoding (including octopus-meme-maker).
  Those plugin/test files are unchanged from this worktree's HEAD. These results are separate
  from the passing ScanSci engine suite; no repository-wide test pass is claimed.

Upstream baseline testing reproduced two timeout tests that did not mock the optional
`scansci-find` executable and one assertion that assumed concurrent worker order. This fork
fixes those test fixtures without installing a fake executable or serializing production work.
The actual MCP check also found and fixes the upstream DOI-list parser's missing default title.

## Measured transport performance

Repeat with `python vendor/scansci-pdf/scripts/benchmark_secure_download.py` in an environment
with `cryptography`; add `--connection-latency-ms 20` for the second scenario. The saved upstream
fixture is the unchanged v1.18.0 downloader. Four workers download 40 synthetic 512 KiB PDFs,
three rounds per mode, valid fixture CA, TCP_NODELAY. The secured mode includes the Python write
containment audit. Loopback permission is patched only in this disposable benchmark process.

| Scenario | Upstream median | Secured median | Ratio | Successful PDFs |
| --- | --- | --- | --- | --- |
| Local TLS, no injected delay | 385.019 ms | 340.230 ms | 1.13x | 40/40 each round |
| 20 ms per new connection | 1025.545 ms | 385.431 ms | 2.66x | 40/40 each round |

New TLS connections fall from **40 to 4 per round**. Batch workers, hedged race, source routing,
metadata caches and browser fallback remain present. These are controlled transport results;
they do not establish faster real publisher downloads or compare compiled Cython performance.
The hosted source fallback can have a different CPU profile from upstream native extensions.

## Compatibility and remaining validation

- Local DNS must resolve publisher destinations even when using a SOCKS proxy. Remote-only DNS
  networks and private intranet institutional sites are restricted by the public-IP policy.
- Remote CamoFox/FlareSolverr services cannot enforce redirect/rebinding policy, so hosted mode
  uses local guarded browsers. This is a documented capability restriction.
- Chromium is integration-tested here. Camoufox/Firefox preferences and other operating systems
  need actual integration evidence; the added Linux/Windows CI matrix has not been executed on
  GitHub. Previously installed browser binaries are required; implicit installers are avoided.
- Python audit/path checks are not an OS sandbox for native libraries/browser children and do
  not guarantee resistance to a concurrent local attacker renaming filesystem ancestors.
- Tor hashes were fetched from Tor Project over HTTPS; detached signature verification was not
  performed in this session. Platform pins must be reviewed when updating the bundle.

GitHub CI execution remains separate from these local results; pending approval is not a pass.
