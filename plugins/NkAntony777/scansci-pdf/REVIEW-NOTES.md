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
