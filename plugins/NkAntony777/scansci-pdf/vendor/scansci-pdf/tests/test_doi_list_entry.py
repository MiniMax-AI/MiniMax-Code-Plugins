from scansci_pdf.paperlist import parse_paper_list


def test_doi_only_reading_list_does_not_require_title(tmp_path):
    path = tmp_path/'reading.txt'
    path.write_text('10.1038/s41586-024-07386-0\n', encoding='utf-8')
    entries = parse_paper_list(path)
    assert len(entries) == 1
    assert entries[0].doi == '10.1038/s41586-024-07386-0'
