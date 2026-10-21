"""Regression tests for the second UNEP feedback round (6-pitfall report)."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest

from scansci_pdf import pipeline
from scansci_pdf.pipeline import QueueEntry, _mdpi_variants, _PDF_URL_HINT


class TestMdpiSlugExtensions:
    """Mappings verified live (HTTP %PDF probe, 2026-09) before landing."""

    @pytest.mark.parametrize("doi,expected_file", [
        ("10.3390/app10175755", "applsci-10-05755.pdf"),
        ("10.3390/educsci10020027", "education-10-00027.pdf"),
        ("10.3390/d14060441", "diversity-14-00441.pdf"),
        ("10.3390/a17100465", "algorithms-17-00465.pdf"),
        ("10.3390/dj11010021", "dentistry-11-00021.pdf"),
        ("10.3390/tourhosp7060168", "tourismhosp-07-00168.pdf"),
    ])
    def test_hard_prefixes_construct_correct_urls(self, doi, expected_file):
        urls = _mdpi_variants(doi)
        # the vol-splitting heuristic emits several candidates; the verified
        # one must be among them (the fetch loop tries in order)
        assert any(u.endswith(expected_file) for u in urls)


class TestPdfUrlHint:
    def test_mdpi_pdf_version_form_matches(self):
        assert _PDF_URL_HINT.search(
            "https://www.mdpi.com/2076-3417/10/10/5755/pdf?version=1234")

    def test_wiley_pdfdirect_matches(self):
        assert _PDF_URL_HINT.search(
            "https://onlinelibrary.wiley.com/doi/pdfdirect/10.1002/pro.70752")

    def test_plain_article_page_still_rejected(self):
        assert not _PDF_URL_HINT.search(
            "https://www.nature.com/articles/s41586-021-03819-2")


class TestLaneResultGuarantee:
    def test_grey_disabled_entries_get_explicit_failure_rows(
            self, tmp_path: Path, monkeypatch):
        """Entries whose only lane is a vetoed grey lane must surface as
        failures with a reason — never vanish into a silent 0/0."""
        monkeypatch.setattr(pipeline, "_enrich_oa_urls", lambda *a, **k: None)
        monkeypatch.setattr(
            pipeline, "_run_fast_lane",
            lambda *a, **k: [{"success": True, "doi": "10.1016/x.1",
                              "file": "f.pdf", "source": "elsevier_api"}])
        entries = [
            QueueEntry(identifier="10.1016/x.1", channel="elsevier"),
            QueueEntry(identifier="10.1080/paywalled.1"),  # auto -> grey lane
        ]
        results = pipeline.run_lanes(
            entries, tmp_path, config={}, allow_grey=False,
            allow_institution=False)
        by_doi = {r["doi"]: r for r in results}
        assert by_doi["10.1016/x.1"]["success"]
        row = by_doi["10.1080/paywalled.1"]
        assert not row["success"]
        assert "grey lane disabled" in row["error"]


class TestAuthConnectorGate:
    def test_proxy_with_cookies_still_loads_them(self, monkeypatch, caplog):
        from scansci_pdf.auth import WebVPNAuth

        auth = WebVPNAuth({"network_proxy": "http://x:1",
                           "instsci_base_url": "https://w.example"})
        loaded = []
        monkeypatch.setattr(auth, "_try_load_cookies",
                            lambda: loaded.append(1) or True)
        with caplog.at_level(logging.WARNING):
            assert auth.login() is True
        assert loaded  # cookies honored even with proxy set

    def test_proxy_without_cookies_warns_loudly(self, monkeypatch, caplog):
        from scansci_pdf.auth import WebVPNAuth

        auth = WebVPNAuth({"network_proxy": "http://x:1",
                           "instsci_base_url": "https://w.example"})
        monkeypatch.setattr(auth, "_try_load_cookies", lambda: False)
        with caplog.at_level(logging.WARNING):
            assert auth.login() is True  # behavior preserved...
        assert "personal" in caplog.text.lower()  # ...but the assumption is loud


if __name__ == "__main__":
    pytest.main([__file__])
