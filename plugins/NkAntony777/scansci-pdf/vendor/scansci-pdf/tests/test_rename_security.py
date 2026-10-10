from scansci_pdf.rename import rename_pdf


def test_similar_size_files_are_not_deleted_as_duplicates(tmp_path, monkeypatch):
    import scansci_pdf.rename as rename
    monkeypatch.setattr(rename, 'generate_filename', lambda metadata: 'target')
    original = tmp_path/'new.pdf'
    target = tmp_path/'target.pdf'
    original.write_bytes(b'PDF-new-content')
    target.write_bytes(b'PDF-old-content')
    result = rename_pdf(original, {})
    assert result == tmp_path/'target_1.pdf'
    assert result.read_bytes() == b'PDF-new-content'
    assert target.read_bytes() == b'PDF-old-content'
