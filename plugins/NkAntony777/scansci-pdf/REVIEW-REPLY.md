## October 11 follow-up — local worktree evidence, not exact-head CI

The repair closes the follow-up paths rather than only the reported reproduction:

- Batch identifiers and cached Zotero attachments are checked before any outside-workspace read. Zotero reports attachment/upload failures as partial failures with a retained parent key and retry guidance.
- Cookie persistence, imports, merges, institutional sessions and browser restore share explicit-target scope and retain security/lifecycle attributes. Old four-field records require a new login; they are rejected before normalization, including incoming merge records. requests jars retain Secure, expiry, HttpOnly and SameSite. Plugin Netscape exports preserve SameSite in a private metadata comment.
- localStorage is opt-in through a shared boolean parser; the string `"false"` is off. Browser trust-pin changes require explicit confirmation. Version probes, normal/persistent launch and Camoufox's concrete executable go through provenance checks before execution.
- Unauthenticated streamable HTTP is loopback-only. Both Web entry points disable access logs, and login tokens are not rendered in initial HTML. Proxy credentials are redacted in logs, exceptions, structured results and Rich output, without a nesting-depth or dictionary-key escape.
- All Elsevier API callers use origin-confined requests; cross-origin, port-change and HTTPS-downgrade redirects lose API keys/institutional tokens. Launcher child modules work without trusting bytecode caches, and the integration staging excludes environments and generated metadata.

Real Windows Chrome cookie round-trip and actual stdio MCP/tool-call/tamper checks passed against the delivered source manifest and unchanged dependency locks. A separate short-path environment installs `requirements-browser.lock` with hash checks; no positive test rewrites pins or repairs a copied manifest. Full results and limitations are in REVIEW-NOTES.md and the local handoff evidence.

CI records the checked-out SHA, verifies the delivered manifest/locks and opts into the real approved-browser cookie test on Linux/Windows. This revision is committed locally after the worktree checks, with post-commit independent review requested. No push or GitHub run is claimed: same-head CI remains an acceptance requirement, not a claimed pass. Real Firefox/Camoufox and live institutional/Elsevier/Zotero service behavior remain unverified.
