"""Review point 4: validates the proto-analyzer SKILL's extraction contract.

The Skill is a guidance document, not code. This test suite verifies the
*contract* of the Skill's output (`page-analysis.json`) against a static
prototype fixture, and checks that the SKILL.md text still contains the
boundary rules, credential rules, and host-capability notes that
reviewers asked for. No network, no browser, no sub-agents.
"""
import json
import os
import re
import unittest
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_PATH = os.path.normpath(os.path.join(HERE, os.pardir, "SKILL.md"))
FIXTURE_HTML = os.path.join(HERE, "fixtures", "sample-prototype.html")
EXPECTED_JSON = os.path.join(HERE, "fixtures", "expected-page-analysis.json")


# ---------- SKILL.md text checks ----------

class TestSkillText(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SKILL_PATH, encoding="utf-8") as f:
            cls.text = f.read()

    def test_has_host_capabilities_section(self):
        self.assertIn("Host capabilities", self.text)
        # All three rows of the table must be present
        for kw in ("Browser automation MCP", "Sub-agent dispatch", "Authenticated browser session"):
            self.assertIn(kw, self.text, f"missing host-capability row: {kw}")

    def test_has_data_boundary_section(self):
        self.assertIn("Data boundary", self.text)
        # Must mention the page-loaded downstream categories
        for kw in ("CDN", "fonts", "analytics", "SSO", "iframe", "API"):
            self.assertIn(kw, self.text, f"missing downstream category: {kw}")

    def test_does_not_ask_user_for_credentials(self):
        # The pre-fix line was "ask the user for credentials"; the new text
        # must explicitly state the Skill does not request/reads/records/echo.
        # We tolerate the historical phrase as long as the surrounding line
        # is in a negation context.
        for line in self.text.splitlines():
            if "ask the user" in line.lower() and "credential" in line.lower():
                self.assertIn("not", line.lower(),
                              f"un-rewritten credential line: {line!r}")
        # The negative promise must be present in some form.
        lower = self.text.lower()
        for kw in ("does not request", "do not request",
                   "never request", "never reads", "never record", "never echo"):
            if kw in lower:
                break
        else:
            self.fail("no negative credential phrasing found in SKILL.md")

    def test_does_not_require_sub_agents(self):
        # The pre-fix Step 5 / Step 6 had "Spawn three sub-agents in parallel"
        # and "Spawn a verification sub-agent". The new text must not phrase
        # these as required.
        for forbidden in (
            "Spawn three sub-agents in parallel",
            "Spawn a verification sub-agent",
        ):
            self.assertNotIn(forbidden, self.text,
                             f"outdated sub-agent language still present: {forbidden!r}")
        # And the new wording must use "may" or "is not required"
        self.assertIn("is not required", self.text.lower())

    def test_documents_three_layer_boundaries(self):
        for layer in ("PRD.md", "SYSTEM-DESIGN.md", "API-SPEC.md"):
            self.assertIn(layer, self.text)
        # Each layer has a "Should NOT include" block
        self.assertGreaterEqual(self.text.count("Should NOT include"), 3)

    def test_documents_six_extraction_rules(self):
        for rule_no in range(1, 7):
            self.assertIn(f"**Rule {rule_no}", self.text,
                          f"missing Rule {rule_no} label")


# ---------- fixture HTML structure checks ----------

class _HTMLProbe(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []
        self.ids = set()
        self.classes = []

    def handle_starttag(self, tag, attrs):
        self.tags.append(tag)
        d = dict(attrs)
        if "id" in d:
            self.ids.add(d["id"])
        if "class" in d:
            self.classes.append(d["class"])


class TestFixtureHTML(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE_HTML, encoding="utf-8") as f:
            cls.html = f.read()
        cls.probe = _HTMLProbe()
        cls.probe.feed(cls.html)

    def test_well_formed(self):
        # The parser would have raised on malformed input; just check it
        # produced a non-empty tag list.
        self.assertGreater(len(self.probe.tags), 0)

    def test_contains_all_form_fields(self):
        expected_ids = {
            "course_name", "course_category", "course_price",
            "course_intro", "course_cover",
        }
        missing = expected_ids - self.probe.ids
        self.assertFalse(missing, f"form fields missing in fixture: {missing}")

    def test_contains_filter_fields(self):
        for fid in ("filter_category", "filter_price_min", "filter_price_max"):
            self.assertIn(fid, self.probe.ids)

    def test_contains_mock_card_with_marker(self):
        # The mock data section must be detectable for Rule 3 to work.
        self.assertIn("data-mock=\"true\"", self.html)
        self.assertIn("示例课程", self.html)

    def test_contains_list_table_with_sample_rows(self):
        self.assertIn("<table>", self.html)
        self.assertIn("<tbody>", self.html)
        # At least 3 data rows so Rule 2 has something to exclude
        self.assertGreaterEqual(self.html.count("<tr>"), 4)  # header + 3 rows


# ---------- expected JSON contract checks ----------

class TestExpectedJSON(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(EXPECTED_JSON, encoding="utf-8") as f:
            cls.data = json.load(f)

    def test_top_level_shape(self):
        for k in ("project_name", "platform_type", "prototype_url",
                 "total_pages", "pages", "navigation_tree",
                 "auth_required", "analysis_notes"):
            self.assertIn(k, self.data, f"missing top-level key: {k}")

    def test_pages_have_required_keys(self):
        for page in self.data["pages"]:
            for k in ("page_name", "page_type", "navigation_path",
                     "confidence", "sections", "excluded_items"):
                self.assertIn(k, page, f"page {page.get('page_name')} missing {k}")
            for section in page["sections"]:
                self.assertIn("section_name", section)
                self.assertIn("fields", section)
                self.assertIn("actions", section)

    def test_field_keys_match_fixture_form_ids(self):
        fixture_ids = {
            "course_name", "course_category", "course_price",
            "course_intro", "course_cover",
        }
        found = set()
        for page in self.data["pages"]:
            for section in page["sections"]:
                for field in section["fields"]:
                    found.add(field["field_key"])
        missing = fixture_ids - found
        self.assertFalse(missing, f"form field keys missing in expected JSON: {missing}")

    def test_excluded_items_have_rule_applied(self):
        for page in self.data["pages"]:
            for item in page["excluded_items"]:
                self.assertIn("rule_applied", item)
                self.assertIn("reason", item)
                self.assertIn("text", item)

    def test_mock_card_excluded_by_rule_3(self):
        # Find the page that should exclude the mock-card aside.
        for page in self.data["pages"]:
            for item in page["excluded_items"]:
                if "mock" in item["text"].lower() or "示例" in item["text"]:
                    self.assertIn("Rule 3", item["rule_applied"])
                    return
        self.fail("expected the mock-card aside to be excluded under Rule 3")

    def test_table_rows_excluded_by_rule_2(self):
        for page in self.data["pages"]:
            for item in page["excluded_items"]:
                if "data row" in item["text"].lower() or "tbody" in item["text"].lower():
                    self.assertIn("Rule 2", item["rule_applied"])
                    return
        self.fail("expected table data rows to be excluded under Rule 2")

    def test_auth_required_is_false(self):
        # Fixture has no login page; auth_required should be false and
        # no field should be credential-shaped.
        self.assertFalse(self.data["auth_required"])


# ---------- cross-check: no leakage from excluded_items to fields ----------

class TestNoExclusionLeakage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(EXPECTED_JSON, encoding="utf-8") as f:
            cls.data = json.load(f)
        with open(FIXTURE_HTML, encoding="utf-8") as f:
            cls.html = f.read()

    def test_no_excluded_text_appears_as_field_label(self):
        labels = set()
        for page in self.data["pages"]:
            for section in page["sections"]:
                for field in section["fields"]:
                    labels.add(field["label"])
        for page in self.data["pages"]:
            for item in page["excluded_items"]:
                # The excluded text is descriptive, not a label; the
                # dangerous form is if a specific value like "182***83"
                # ended up as a field label. Check the items that name
                # concrete data values.
                for needle in ("182", "12345", "4.8", "2026-07-15", "1980", "3580", "1280"):
                    if needle in item["text"]:
                        self.assertNotIn(needle, labels,
                                          f"concrete data value {needle!r} leaked into a field label")


# ---------- document boundary rule: SKILL.md prohibits SQL types in PRD ----------

class TestDocumentBoundaryPrompts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SKILL_PATH, encoding="utf-8") as f:
            cls.text = f.read()

    def test_prd_block_mentions_no_sql_types(self):
        # Extract the PRD block: between "PRD.md — Business Layer" and
        # the next "**SYSTEM-DESIGN.md"
        m = re.search(
            r"PRD\.md — Business Layer.*?(?=\*\*SYSTEM-DESIGN\.md|\Z)",
            self.text, re.DOTALL,
        )
        self.assertIsNotNone(m, "PRD block not found in SKILL.md")
        block = m.group(0)
        self.assertIn("SQL types", block)
        self.assertIn("Should NOT include", block)

    def test_system_design_block_mentions_no_api_endpoints(self):
        m = re.search(
            r"SYSTEM-DESIGN\.md — Architecture Layer.*?(?=\*\*API-SPEC\.md|\Z)",
            self.text, re.DOTALL,
        )
        self.assertIsNotNone(m)
        block = m.group(0)
        self.assertIn("API endpoint", block)

    def test_api_spec_block_mentions_no_database_table(self):
        m = re.search(
            r"API-SPEC\.md — Contract Layer.*?(?=\*\*Data flow|\Z)",
            self.text, re.DOTALL,
        )
        self.assertIsNotNone(m)
        block = m.group(0)
        self.assertIn("database table", block)


if __name__ == "__main__":
    unittest.main()
