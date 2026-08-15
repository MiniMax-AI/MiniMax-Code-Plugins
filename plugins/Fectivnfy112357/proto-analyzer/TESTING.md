# proto-analyzer — testing & acceptance

The proto-analyzer Skill is a guidance document for the host agent; it
produces no runnable code of its own. The "tests" therefore verify the
**contract** of the Skill — both the text of `SKILL.md` (rules,
boundaries, host capabilities) and the **shape and content of the
expected `page-analysis.json`** against a static prototype fixture.

## 1. Automated tests (regression)

From the repo root:

```bash
node --test test/proto-analyzer.test.mjs
```

This runs the Python suite (5 test classes, 22 assertions) via
`plugins/Fectivnfy112357/proto-analyzer/skills/proto-analyzer/tests/run_tests.py`.
No network, no browser, no sub-agents.

The suite checks:

- **SKILL.md text** still contains the host-capabilities table,
  data-boundary disclosure, six extraction rules, three-layer boundary
  rules, and the negative credential promise ("never request / read /
  record / echo"). It also asserts the outdated "Spawn three
  sub-agents" wording is gone.
- **fixture HTML** is well-formed and contains the 5 form fields
  (`course_name`, `course_category`, `course_price`, `course_intro`,
  `course_cover`), the 3 filter fields, the `data-mock="true"`
  marker for Rule 3 exclusion, and the table with at least 3 data
  rows for Rule 2 exclusion.
- **expected-page-analysis.json** has the right top-level shape,
  page/section/field keys, and the right `excluded_items` with
  `rule_applied` pointing at Rule 2 (table rows), Rule 3 (mock
  card), and Rule 4 (pagination summary).
- **document-boundary SKILL text** still says each layer must not
  include the others' content (PRD no SQL, SYSTEM-DESIGN no API
  endpoints, API-SPEC no database tables).

## 2. Manual acceptance test

The fixture is a real static HTML file that an agent can drive through
the SKILL's workflow. To run end-to-end:

```bash
# 1. Serve the fixture locally (so the host can navigate to it)
cd plugins/Fectivnfy112357/proto-analyzer/skills/proto-analyzer/tests/fixtures
python -m http.server 8000 &
SERVER_PID=$!
cd -

# 2. Open your agent (Claude Code, Codex, Cursor, etc.) with the
#    proto-analyzer Skill installed. Then run:
#
#    analyze this prototype: http://localhost:8000/sample-prototype.html
#
# 3. Expected outputs the agent should produce:
#
#    docs/PRD.md          — must list 课程名称 / 课程分类 / 课程价格(元)
#                           / 课程简介 / 课程封面 as business fields.
#                           Must NOT contain SQL types, API paths, or
#                           JSON shapes.
#    docs/SYSTEM-DESIGN.md — must show entity / table sketch with
#                           course_name VARCHAR(50) NOT NULL, etc.
#                           Must NOT contain API endpoint paths.
#    docs/API-SPEC.md      — must list POST /api/v1/courses (create)
#                           and GET /api/v1/courses (list) with
#                           request/response JSON. Must NOT contain
#                           table definitions.
#    docs/VERIFICATION.md  — coverage matrix; must call out the
#                           "mock-card aside" and the 3 table rows as
#                           correctly EXCLUDED (not leaked into PRD).
#
# 4. Sanity assertions to run by hand:
#
#    a) PRD.md does NOT mention "VARCHAR", "INT", "JSON", "/api/".
#    b) SYSTEM-DESIGN.md does NOT mention "/api/v1/" or request body JSON.
#    c) API-SPEC.md does NOT contain "CREATE TABLE" or column SQL types.
#    d) PRD.md and SYSTEM-DESIGN.md do NOT both list the same field
#       with the same wording (boundary non-overlap).
#    e) The mock-card aside text and the 3 table row values appear
#       NOWHERE in PRD.md / SYSTEM-DESIGN.md / API-SPEC.md as field
#       values (exclusion integrity).
#
# 5. Cleanup
kill $SERVER_PID
```

## 3. Manual test for the no-credential rule

To verify the Skill behaves correctly on a login-protected prototype,
you do not need a real login page. Open your agent and ask:

> "Analyze https://httpbin.org/basic-auth/user/passwd — it's a test URL
> that returns 401 without credentials."

The agent should:
- **Not** ask you to paste the credentials into chat.
- Either prompt you to log in via the host's authenticated browser
  session, or tell you the prototype requires auth and cannot be
  processed without your own browser session.
- Produce a `page-analysis.json` with `auth_required: true` and no
  credential values anywhere in the output.

## 4. Manual test for the data-boundary disclosure

> "Analyze this internal prototype: https://intranet.example.com/admin"

The agent should surface the data-boundary warning (CDN / fonts /
analytics / SSO / iframe / API sub-resources) and ask you to confirm
the prototype and its downstream services are within scope before
proceeding. If you say "no, skip" or "paste the HTML instead", the
agent should accept the paste without navigating.

## 5. What this Skill is NOT testing

- **Browser rendering** — no real browser is launched; the agent's own
  browser tool is exercised at runtime in your environment.
- **Sub-agent dispatch** — the Skill does not depend on it; the
  default path is sequential in-host generation.
- **The host's LLM** — we test the contract (text + fixture + expected
  output), not the model's ability to follow it.
