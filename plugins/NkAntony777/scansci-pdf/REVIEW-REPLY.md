Thanks for the detailed review. This revision vendors and patches the engine directly, based
on the existing upstream v1.18.0 tag/commit, rather than relying on a nonexistent 1.17.2 release
or waiting for an upstream fix.

The actual connection layer now validates DNS answers and uses numeric destination addresses,
including redirects, configured HTTP/SOCKS proxies and a guarded local browser path. Tor uses
pinned archive hashes and checked extraction; installation needs explicit confirmation. Secrets
are masked, config/cookies have private atomic persistence, writes stay in the project with
symlink/junction checks, and destructive workbook/cache actions require confirmation. The
packaged helpers and root mcp.json are included in validation, and Skills declare the untrusted
content boundary. The launcher verifies source hashes/dependency versions and loads source
without trusting PATH engines or bytecode caches.

Local Windows evidence: 429 engine tests passed, 3 skipped; actual stdio MCP integration and
Chrome redirect/private-address checks passed; repository validation passed. A repeatable
4-worker/40-file HTTPS fixture completes every file and reduces TLS connections from 40 to 4.
Including write containment, median transport time was 385→340 ms locally and 1026→385 ms
with 20 ms connection delay. This is not a claim about live publisher latency or Cython speed.

REVIEW-NOTES.md contains the details and limitations: remote browser daemons/private-intranet
routes remain restricted, Firefox and other platforms need CI evidence, Tor extraction was
tested but no working circuit is claimed, and path checks are not a native OS sandbox. A scoped
Linux/Windows workflow is added; I do not count approval-pending GitHub jobs as passes.
