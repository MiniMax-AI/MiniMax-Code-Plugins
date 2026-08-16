# proto-analyzer

Turn a prototype page URL into **backend development documentation**:

1. **PRD.md** — business requirements, field rules, workflows
2. **SYSTEM-DESIGN.md** — architecture, schema, module boundaries
3. **API-SPEC.md** — RESTful endpoints, request/response contracts
4. **VERIFICATION.md** — coverage matrix and gap report

## The problem

Backend development usually starts from a frontend prototype (Figma, Axure,
deployed HTML) — and extracting reliable requirements from it is hard: mock
data looks like real fields, list rows look like field definitions, and
designer notes are scattered. proto-analyzer packages a disciplined
extraction workflow (platform-aware DOM analysis, a field-vs-data decision
tree with auditable exclusion rules), generates the three documents in
parallel with strict boundary separation, and runs a verification agent that
cross-checks coverage and leaks.

## Try it

Install from `/plugins` → **Local**, then paste a prototype link:

```text
analyze this prototype and generate backend docs: https://example.com/proto/exam-admin
```

**Expected result**: `docs/PRD.md`, `docs/SYSTEM-DESIGN.md`, `docs/API-SPEC.md`
and `docs/VERIFICATION.md` in the project — fields, rules and endpoints
traceable back to the prototype, with low-confidence items flagged for your
review.

## Requirements

- Python 3.10+ (for the regression test suite that validates the SKILL's
  output contract against a static prototype fixture).
- Optional: a **browser automation tool** in the host agent (Playwright MCP,
  Puppeteer MCP, etc.) to inspect the prototype page in a real browser.
  If unavailable, paste the rendered HTML source instead — the Skill's
  extraction rules still apply.
- Optional: a **sub-agent dispatch** capability in the host agent to run
  the three document generators concurrently. If unavailable, the host
  agent generates them in order (PRD → System-Design → API-Spec); this is
  the default.
- Access to the prototype URL the user wants analyzed. See the
  "Authentication" note below.

## Data and network

This Skill runs entirely in the host agent. The data flow depends on
whether the host uses a browser tool or works from pasted HTML.

**Direct (this Skill)**: no network calls of its own. Reads
`page-analysis.json` (intermediate) and writes the four output documents
to `docs/` in the project.

**Direct (when the host uses a browser tool)**: the host's browser
issues a single GET on the URL the user provides. That is the only
explicit request made for this Skill.

**Downstream (the prototype page itself, NOT this Skill)**: a real
browser page is not just the URL you paste — visiting it causes the
host's browser to load additional resources the page controls,
including but not limited to:

- CDN assets (scripts, images, CSS)
- Web fonts
- Analytics / telemetry beacons
- SSO / OAuth redirect endpoints
- Third-party iframes
- API sub-resources called by the page's own JavaScript

Those requests are part of normal browser behavior, not part of this
Skill, but they DO leave the host's browser and reach the services
listed above. For a private / internal prototype, the user must
confirm that the prototype itself and the downstream services it
loads are within scope before the host visits the URL. The host agent
should surface this to the user (sample wording in `SKILL.md` "Data
boundary" section).

**Authentication**: if the prototype requires login, the user logs in
via the host's already-authenticated browser session, or logs in
themselves; this Skill then reads the resulting authenticated state.
**This Skill never requests, reads, records, or echoes credential
values in the conversation, in the generated documents, or in the
`page-analysis.json` output.** This applies to bearer tokens, basic
auth usernames/passwords, API keys, session cookies, OTP codes, and
any other secret material.

**No telemetry, no third-party services run by this Skill.** The
Skill is a guidance document; the only file output is the four docs
under `docs/`.

## Security model

- No credentials handled or echoed at any point.
- No private endpoints or hidden telemetry in this Skill.
- The host's browser may reach downstream services listed above when
  loading the prototype; the user is responsible for confirming that
  scope before processing private prototypes.

## License

MIT
