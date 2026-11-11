## October 14 round-4 review response

The October 12 review targets 0acd104. This revision addresses implementation points 1-6;
point 7 (upstream exact-head Checks) still needs maintainer approval. The submitted commit and
service-side run links are recorded in the PR, separately from the local evidence here.

- Native persistent profiles no longer bypass scoped persistence: all hosted profile launches use
  non-persistent contexts, both batch paths skip native-profile cloning, and old profiles are never
  automatically reopened or deleted. A real approved Edge restart verifies unrelated SSO cookies and
  unapproved localStorage do not return while scoped HttpOnly/Secure target cookies still restore.
- Cookie records require complete, valid identity/security state before normalization. Partial
  secure-only/expires-only records are refused. Legacy credentials require re-login.
- Zotero requests use origin-confined transport including Zotero-API-Key; redirects are disabled.
  Response upload origins are explicitly allowlisted. Storage never receives the API key, uploads
  use one streamed multipart envelope, and registration success is checked independently.
- Trusted config is propagated to every launch site. Hosted missing config, missing explicit backend
  or missing explicit binary fail closed, including Camoufox. Raw options cannot replace its
  verified executable. Changed config invalidates a cached browser context.
- Global secret egress covers legacy CLI print/stream paths, log exception chains, Rich and MCP JSON.
  Direct/bulk config saves now share mandatory trust-change confirmation with the MCP update path;
  proxy/backend/binary/digest/institution-origin setters cannot bypass it. Typed boolean comparison
  and persistence prevent "False" strings from enabling trust options; ordinary legacy boolean
  and relative-profile migration remain possible without inventing a new trust decision. Mutable
  defaults no longer alias the caller's pin table; corrupt old pins allow only confirmed valid repair.
- MCP now runs a packaged Node bootstrap supporting python3-only installations and an absolute
  SCANSCI_PDF_PYTHON override. It binds a supported interpreter and launches with -I; run_secure.py
  independently checks >=3.11 and isolated startup. Polluted PYTHONHOME/PYTHONPATH and workspace
  shadow-module canaries pass, as does actual manifest-based stdio on both supported Python versions.
  Its acceptance script now uses the locked SDK's input_schema, with tested legacy compatibility.

Evidence and explicit limits are in REVIEW-NOTES.md. The initial 27 regression cases failed on the
old implementation. The local review follow-up adds 80 regressions. Final Windows Python 3.13
suite: 1002 passed, 5 skipped, 0 failed; Python 3.11: 1002 passed, 5 skipped, 0 failed.
The publication recheck reproduced both counts in 147.62 and 148.17 seconds respectively,
including the real Edge fixtures and actual stdio checks with strict school confirmation.
Delivered-source hashes (173 entries), schema validation and both actual stdio sessions pass.
Root npm test is not green on this host (336 pass / 6 fail / 3 skip):
one symlink EPERM and five unchanged octopus-meme-maker platform/line-ending assertions.
This is not a claim of upstream CI/CodeQL, real Firefox, Linux/macOS, live account
login or a successful live Zotero upload.

PR-BODY.md supplies the updated description of source-only vendoring, Node bootstrap,
workspace-local data and validation limits. Publishing the revised head does not grant this
account permission to approve upstream workflows: approval and re-run requests on the previous
head were independently verified to return HTTP 403 on October 14.
