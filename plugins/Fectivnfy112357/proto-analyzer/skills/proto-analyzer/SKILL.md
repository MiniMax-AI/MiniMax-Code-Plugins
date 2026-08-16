---
name: proto-analyzer
description: >
  Analyzes prototype page URLs to generate backend development documentation:
  PRD (business requirements), System Design (architecture), and API Specification
  (integration contracts). Use whenever the user provides a prototype page link
  (Figma, Axure, online demo, deployed HTML) and wants backend documentation,
  API specs, data models, or any phrase like "analyze this prototype", "generate
  backend docs from this page", "extract requirements from this URL".
---

# Proto Analyzer

Transform a prototype URL into three backend development documents:
1. **PRD.md** — Business requirements, field rules, workflows
2. **SYSTEM-DESIGN.md** — Architecture, schema, module boundaries
3. **API-SPEC.md** — RESTful endpoints, request/response contracts

## Host capabilities (none are required)

This Skill assumes only that the host agent can read its `SKILL.md` and
follow instructions. The following host capabilities are **optional** —
if present they are used; if absent, fallbacks in this Skill apply.

| Capability | Used in | Fallback when absent |
|---|---|---|
| Browser automation MCP (Playwright, Puppeteer, etc.) | Step 1 — page DOM inspection, screenshots | User pastes the rendered HTML source (e.g. browser "Save as…" then `cat page.html`); the Skill parses the static HTML for field extraction |
| Sub-agent dispatch (Task tool) | Steps 5/6 — PRD / System-Design / API-Spec / Verifier | The host agent does the work itself, sequentially, in the order PRD → System-Design → API-Spec → Verification. This is the default; sub-agents are only a performance optimization |
| Authenticated browser session (cookies, SSO state) | Step 1.2 — accessing a login-protected prototype | The user logs in themselves in the host's browser; this Skill never reads, requests, records, or echoes credential values |

Do not assume any of these are present. The Skill's contract is the four
output documents; the orchestration is a host-side choice.

## Data boundary (confirm before processing private prototypes)

A real browser page is not just the URL the user pastes. Visiting it
causes the host's browser to load additional resources the page
controls, including but not limited to: CDN assets, web fonts, analytics
beacons, SSO / OAuth redirect endpoints, third-party iframes, and API
sub-resources called by the page's own JavaScript.

**Before Step 1 begins**, the host agent must surface this to the user
when the prototype is private, internal, or contains business-sensitive
content. Recommended wording:

> The prototype URL may cause your browser to load downstream resources
> (CDN, fonts, analytics, SSO, iframes, API sub-resources). For a
> private / internal prototype, please confirm the prototype itself
> and the downstream services it pulls from are within scope before
> proceeding. If you would rather not visit a private URL, paste the
> rendered HTML source instead (see "Host capabilities" above).

For a public, non-sensitive prototype, the host agent can proceed
without a separate confirmation, but the disclosure still stands.

## Workflow

### Step 1: Prototype Exploration (Blocking)

Explore the prototype to understand its content.

#### 1.1 Browser Tool Selection

If the host has a browser automation MCP, use it. The Skill is tool-agnostic;
any of the following work:

- **Playwright MCP** — `browser_navigate`, `browser_snapshot`, `browser_take_screenshot`, `browser_click`, `browser_type`
- **Chrome Puppeteer MCP** — `puppeteer_navigate`, `puppeteer_screenshot`, `puppeteer_evaluate`, `puppeteer_click`, `puppeteer_fill`
- **Other browser MCP tools** — adapt the same operations to whatever the host exposes

**Strategy**: start with the most capable tool. If one fails (page doesn't
render, auth blocked, headless issue), try another, or fall back to the
user pasting rendered HTML source.

#### 1.2 Navigation & Authentication

- Navigate to the provided URL using the selected browser tool
- If a password / verification / login page appears:
  - **Do not request credentials from the user in chat.** The user logs in
    in the host's already-authenticated browser session, or logs in
    themselves; this Skill then reads the resulting authenticated state.
  - This Skill does not request, read, record, or echo credential values
    anywhere in the conversation, in the generated documents, or in the
    `page-analysis.json` output.
- Take a screenshot for visual reference (if the browser tool supports it)
- Identify the prototype platform type from the rendered DOM:
  - **Figma** — typically renders as a canvas with static layers
  - **Axure** — may have simulated interactions, notes panels, dynamic content
  - **CoDesign / 蓝湖 / 墨刀** — Chinese prototyping platforms with their own viewers
  - **Deployed HTML** — real HTML/CSS/JS, may have real form elements
  - **Other** — describe what you see

#### 1.3 Prototype Platform Awareness

Different prototype platforms behave differently in a browser. Adjust your extraction approach accordingly:

| Platform | DOM Reality | Extraction Approach |
|----------|------------|--------------------|
| **Figma embed** | Static SVG/canvas layers; no real HTML form elements | Read visual labels, infer field structure from layout; look for design annotations |
| **Axure viewer** | Simulated interactions via JavaScript; notes in sidebar panels | Use both visual inspection AND notes panel (highest authority); interact with dynamic panels to reveal hidden states |
| **CoDesign/墨刀** | May have real HTML inputs mixed with static previews | Check if elements are actual `<input>` tags or just styled divs; prefer actual inputs |
| **Deployed HTML demo** | Real HTML/CSS/JS; actual form elements | Standard DOM inspection; extract from `<form>`, `<input>`, `<select>`, etc. |

**Key principle**: When in doubt about whether a visual element represents a real field or mock data, **check the prototype's annotation/notes system first**, then ask the user for clarification.

#### 1.4 Page Type Classification

Before extracting any fields, classify each page:

| Page Type | Characteristics | Extraction Strategy |
|-----------|----------------|--------------------|
| **表单页** (Form) | Input boxes, textareas, selects, file uploads, editors with labels | Extract label-input pairs as backend fields |
| **列表页** (List) | Table/grid with column headers, filter bar, pagination | Extract column headers as list fields; extract filter items; do NOT extract individual row data values |
| **详情页** (Detail) | Read-only display of a record | Extract displayed fields; note whether there's an associated edit/create form |
| **导航/面板** (Dashboard) | Cards/links to other pages | Extract navigation structure only; typically no backend fields |
| **登录/注册** (Auth) | Auth forms | Extract auth fields; note auth method |

#### 1.5 Field Extraction: Core Decision Framework

The central challenge: **distinguishing field definitions from data instances and mock content**. Use this decision tree:

```
Is this element part of a form control or data display?
├── Form control (input, select, textarea, upload zone, editor)
│   └── Has a visible label nearby? → YES = real field, NO = investigate further
│
├── Data display (static text, table cell, card content)
│   ├── Is it inside a "list" or "table" row? → YES = data instance (extract structure, not values)
│   ├── Is it inside a "form" with other input fields? → YES = could be pre-filled value (check if editable)
│   └── Is it standalone display content? → Evaluate context (see 1.6)
│
└── Navigation/UI chrome (menus, breadcrumbs, buttons, logos)
    └── NOT a field
```

**Apply these filtering rules:**

**Rule 1: Label-Input Pairing (primary signal for form pages)**
A real form field has:
- A label (noun phrase, typically 2-8 characters in Chinese) adjacent to a control
- Often marked with `*` if required
- The control is interactive (or designed to appear interactive in the prototype)
- Examples: "课程名称" + text box, "考试时长" + number input, "课程图片" + upload zone

**Rule 2: Data Instance vs. Field Definition**
- **Field definition** describes a category of data: "考试名称", "手机号", "总课时"
- **Data instance** is a specific value: "2026年中级经济法VIP高效通关班", "182******83", "60"
- Extract the **field** (with its constraints), not the **value**
- When you see a list of repeated items (e.g., multiple questions, multiple products), extract the **item structure** (what fields each item has) but not the specific content of each item

**Rule 3: Context-Based Mock Data Detection**
A text block is likely mock/sample data (not a backend field) when:
- It contains complete, domain-specific business content (a full exam question, a complete user bio, a full product description)
- It is significantly longer than a typical form input (paragraphs of text inside what should be a single field)
- It appears inside a "sample" or "example" container, card, or panel
- It is repeated multiple times with similar structure (indicates data instances, not field definitions)
- It contains placeholder patterns (Lorem ipsum style, "正确答案内容", "示例文本")
- The label explicitly says "示例", "样例", "mock", "demo"
- It appears in a "preview" or "展示" zone that is separate from the input form

**Rule 4: Aggregated/Computed Displays**
Text that summarizes or aggregates other data is typically NOT a field:
- "共 X 条记录", "总计 X 分", "第 X/Y 页" — pagination/summary info
- "已选择 3 项" — selection counter
- These are UI metadata, not backend fields

**Rule 5: Designer Notes Authority**
If the prototype has a notes/annotations/specification system:
- Notes describing field rules (length limits, format requirements, data sources) are **authoritative**
- Field definitions in notes take priority over visual interpretation
- Notes may reveal fields that aren't visually obvious (server-side validations, hidden fields)

**Rule 6: When Ambiguous — Ask or Flag**
If you cannot confidently determine whether content is a field definition or mock data:
- Flag it with `confidence: "low"` in the output
- Include it in `excluded_items` with reason "uncertain — requires clarification"
- During Step 2 (Context Review), present ambiguous items to the user

#### 1.6 Navigation Graph

- Identify all pages reachable from the current page (navigation trees, sidebars, menus, clickable cards)
- For each reachable page: classify its type, extract fields using the rules above
- Limit depth: do NOT follow links more than **2 levels deep** from the starting page
- Deduplicate: skip pages with visually identical content (e.g., "编辑" vs "创建" may have the same fields)

#### 1.7 Output: page-analysis.json Schema

Produce a `page-analysis.json` with this EXACT structure:

```json
{
  "project_name": "string",
  "platform_type": "string — Figma/Axure/CoDesign/墨刀/deployed HTML/etc.",
  "prototype_url": "string",
  "total_pages": number,
  "pages": [
    {
      "page_name": "string",
      "page_type": "form | list | detail | dashboard | auth | other",
      "navigation_path": "string — e.g., 后台 > 课程管理 > 创建课程",
      "confidence": number,
      "sections": [
        {
          "section_name": "string",
          "fields": [
            {
              "label": "string",
              "field_key": "string — suggested snake_case key",
              "control_type": "text | number | textarea | select | radio | checkbox | date | file | rich_text | switch | custom",
              "required": boolean,
              "max_length": "number | null",
              "placeholder": "string | null",
              "validation_rules": ["string array"],
              "data_source": "string | null — e.g., 用户输入, 字典接口, 关联其他实体",
              "confidence": "high | medium | low",
              "notes": "string | null — designer annotations if available"
            }
          ],
          "actions": [
            {
              "label": "string",
              "type": "submit | reset | navigate | dialog_trigger | delete | other",
              "requires_confirmation": boolean,
              "target_page": "string | null"
            }
          ]
        }
      ],
      "excluded_items": [
        {
          "text": "string — brief description of excluded content",
          "reason": "string — why excluded (data_instance, mock_content, aggregated_display, uncertain, navigation_chrome, etc.)",
          "rule_applied": "string — which extraction rule triggered the exclusion"
        }
      ]
    }
  ],
  "navigation_tree": ["array of reachable page paths"],
  "auth_required": boolean,
  "analysis_notes": "string — observations about prototype completeness, ambiguities, or limitations"
}
```

**Key principles for the output:**
- `excluded_items` documents what was filtered and why — this is auditable and debuggable
- `confidence` on each field and page lets downstream agents know what to trust
- `excluded_items[].rule_applied` links each exclusion to a specific rule, making the reasoning transparent
- Never include raw mock data content in the `fields` arrays

### Step 2: Context Draft & Review (Interactive)

Based on `page-analysis.json`, **draft the business context yourself** and present it to the user for review.

Draft three items:
1. **业务背景与痛点** — infer from page content
2. **目标用户角色** — infer from page structure
3. **预期目标** — infer from the feature set

Present them to the user like this:

```
根据原型页面内容，我总结了以下业务背景，请确认或修改：

**业务背景与痛点：** [草稿]
**目标用户：** [草稿]
**预期目标：** [草稿]

请告诉我需要修改的地方，或直接回复"确认"继续。
```

Also present any **low-confidence fields** or **ambiguous items** from `excluded_items` that need user clarification:

```
以下字段/内容我拿不准，请确认：
- [模糊项 1] — 原因：...
- [模糊项 2] — 原因：...
```

Wait for user confirmation or edits before proceeding.

### Step 3: Tech Stack Selection (Interactive, Blocking)

Ask the user to choose a backend tech stack. If they haven't specified one, present options:

```
请选择后端技术栈：
1. Java + Spring Boot + MyBatis Plus
2. Python + FastAPI + SQLAlchemy
3. Go + Gin + GORM
4. Node.js + NestJS + TypeORM
5. 其他（请说明）
6. 框架无关的描述即可
```

**Do NOT proceed to document generation until tech stack is confirmed.**

### Step 4: Tech Stack Convention Discovery

Once tech stack is confirmed:

1. Check installed skills for matching tech stack domain knowledge (grep skill directories and descriptions for keywords like "spring", "fastapi", "gin", "nestjs", "django", "mybatis", "jpa", "gorm").
2. **If a matching skill exists:** read its relevant reference files to extract framework conventions, best practices, and patterns.
3. **If no matching skill:** rely on the model's internal knowledge of the framework's industry-standard conventions.
4. **If user chose framework-agnostic:** skip this step; generate generic descriptions in SYSTEM-DESIGN.md.

### Step 5: Document Generation

**Only proceed after Step 1 is complete (`page-analysis.json` available) AND Steps 2-3 confirmed by user.**

The host agent generates three documents, in the order
**PRD.md → SYSTEM-DESIGN.md → API-SPEC.md**. If the host has a sub-agent
capability (Task / spawn), the three generations can be dispatched in
parallel as a performance optimization; this Skill does not require it.
The Skill's contract is the three documents on disk, not the
orchestration mechanism.

For each document, the host agent has:
- `page-analysis.json` (complete field / interaction data from Step 1)
- User-confirmed context (business background, roles, goal — from Step 2)
- Tech stack conventions (from Step 4)

#### Document Boundary Rules (STRICT)

Each document has a **clear responsibility boundary**. Do NOT cross these boundaries:

**PRD.md — Business Layer (WHAT and WHY)**
- ✅ Should include: business background, roles, workflow diagrams, page modules, field business meanings (label, required, data type, validation rules in plain language), interaction feedback, exception scenarios, business rules
- ❌ Should NOT include: database table names, SQL types (VARCHAR, INT, etc.), ORM models, API paths, HTTP methods, JSON response structures, technical implementation details
- Field example: "姓名 — 必填，文本，最多50个字符，不可包含特殊符号"

**SYSTEM-DESIGN.md — Architecture Layer (HOW)**
- ✅ Should include: tech stack declaration, module layering (routers → services → models), entity relationships (one-to-many, etc.), table structures (field name, SQL type, constraints, index suggestions), directory structure, cache design, deployment
- ❌ Should NOT include: API endpoint definitions, request/response JSON examples, business rule descriptions (reference PRD instead), specific SQL CREATE statements
- Entity example: "User: id BIGINT PK, username VARCHAR(50) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL"

**API-SPEC.md — Contract Layer (CONTRACT)**
- ✅ Should include: endpoint inventory (path + method), request params (query/path/body), response JSON structures, status codes, business error codes, framework-specific conventions (Pydantic schemas, DTO classes, etc.)
- ❌ Should NOT include: database table definitions, SQL types, ORM models, business background descriptions, workflow diagrams
- Endpoint example: "POST /api/v1/users — Body: {username: string (required, max 50), email: string (required, email format)} → {id: number, username: string}"

**Data flow between documents:**
```
PRD field "姓名: 必填, 文本, 最多50字符"
  → SYSTEM-DESIGN derives: name VARCHAR(50) NOT NULL
    → API-SPEC generates: name: string (required, maxLength: 50)
```

#### 5.1 PRD.md

Generate `PRD.md` using the template at `templates/prd-template.md`. Must include:

- **Business background & pain point** — from user-provided context; never fabricate
- **Roles & usage scenarios** — who uses this page and in what situation
- **Core workflow diagram** — text-based flow (A → B → C) derived from the navigation graph
- **Page module breakdown** — filter zone, data grid, form sections, action bar
- **Field & interaction rules** — every field from page-analysis with: field name, data type (in business terms: text/number/date), required flag, length limit, validation rules (format, range, business constraints)
- **Operation feedback** — what happens on each button click (confirm dialog, navigation, loading state, duplicate submission prevention)
- **Exception scenarios** — network timeout, permission denied, empty data placeholder behavior

**REMINDER:** No database terminology, no API paths, no JSON structures.

**CRITICAL:** Only include fields from `page-analysis.json` that are in the `fields` arrays. Cross-check `excluded_items` to ensure excluded content was not inadvertently included.

#### 5.2 SYSTEM-DESIGN.md

Generate `SYSTEM-DESIGN.md` using the template at `templates/system-design-template.md`. Must include:

- **Tech stack declaration** — framework, database, cache (from Step 4 conventions)
- **Module boundary planning** — routers → services → models layering
- **Schema design** — entities derived from PRD fields; relationships (one-to-many, etc.); core table structures with field name, SQL type, constraints, index suggestions (no raw SQL)
- **Directory structure** — recommended project layout following the tech stack conventions from Step 4

**REMINDER:** No API endpoint definitions, no request/response JSON examples. Reference PRD for business rules.

#### 5.3 API-SPEC.md

Generate `API-SPEC.md` applying the tech stack conventions from Step 4. Must include:

- **Endpoint inventory** — all endpoints needed to support the prototype (list, detail, create, update, delete, dictionary/config lookups)
- **Per-endpoint definition**:
  - Path, HTTP method, brief description
  - Request: headers, query params, body JSON (mark required vs optional)
  - Response: success JSON structure, status codes, business error codes with messages
- **Framework-specific conventions**: apply rules from Step 4 (e.g. MyBatis Plus single-table CRUD inherits BaseMapper — no separate XML; FastAPI uses Pydantic schemas with dependency injection; etc.)
- **Naming conventions**: follow the tech stack's RESTful or framework-specific naming patterns

**REMINDER:** No database table definitions, no business background. Reference SYSTEM-DESIGN for entity types, PRD for validation rules.

### Step 6: Verification

The host agent runs the verification checklist itself (or, if a
sub-agent capability is available, may dispatch the checklist to one
as a performance optimization — this is not required).

The verifier reads all three generated documents and:

1. Cross-references every field mentioned in PRD/API-SPEC against the original `page-analysis.json`
2. Checks that no field from the prototype is missing in the API contract
3. Validates that API endpoints cover all interactions identified in the navigation graph
4. Ensures SYSTEM-DESIGN entities map to the fields identified on the prototype
5. **Checks for excluded-item leakage** — verifies nothing from `excluded_items` arrays appears as a field in any document
6. Checks document boundary compliance (no overlap between the three documents)
7. Produces `VERIFICATION.md` with:
   - Coverage matrix: prototype fields vs document mentions (covered / missing)
   - Gap list: any field, interaction, or page zone that was not captured
   - **Exclusion integrity check**: confirms no excluded content leaked into documents
   - Document boundary compliance check (any overlap detected)
   - Confidence score per document

If gaps are found, re-spawn the relevant document agent with the gap report and regenerate only the affected sections.

## Output Location

All documents are written to the project root or a `docs/` directory:

```
docs/
├── PRD.md
├── SYSTEM-DESIGN.md
├── API-SPEC.md
└── VERIFICATION.md
```

## Templates

- PRD structure: see `templates/prd-template.md`
- System Design structure: see `templates/system-design-template.md`
- API Spec structure: see `templates/api-spec-template.md`
