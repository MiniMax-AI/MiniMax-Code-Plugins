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

- A **browser automation tool** in the host agent (e.g. Playwright MCP or
  Puppeteer MCP) to inspect the prototype page; the skill adapts to whatever
  is available.
- Access to the prototype URL (credentials, if any, are supplied by the user
  when prompted).

## Data and network

- The skill only navigates the prototype URL the user provides; nothing is
  sent anywhere else.
- Credentials for password-protected prototypes are entered by the user at
  prompt time and are not stored.
- No telemetry, no third-party services.

## License

MIT
