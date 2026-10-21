from scansci_pdf import browser_backend


def test_hosted_launch_forces_proxy_in_browser_and_every_context(tmp_path, monkeypatch):
    monkeypatch.setenv('SCANSCI_PDF_WORKSPACE', str(tmp_path))
    monkeypatch.setattr(browser_backend, 'resolve_backend', lambda config: 'patchright')
    captured = {}
    class Page:
        def goto(self, url): return url
    class Context:
        pages = []
        def new_page(self): return Page()
    class Browser:
        def new_context(self, **kwargs):
            captured['context'] = kwargs
            return Context()
    def launch(*args, **kwargs):
        captured['launch'] = kwargs
        return Browser()
    monkeypatch.setattr(browser_backend, '_launch_patchright', launch)
    browser = browser_backend.launch(config={}, proxy={'server': 'http://127.0.0.1:6666'})
    proxy = captured['launch']['proxy']
    assert proxy['server'] != 'http://127.0.0.1:6666'
    assert '--proxy-bypass-list=<-loopback>' in captured['launch']['args']
    context = browser.new_context(proxy={'server': 'http://127.0.0.1:6666'}, ignore_https_errors=True)
    assert captured['context']['proxy'] == proxy
    assert captured['context']['ignore_https_errors'] is False
    import pytest
    from scansci_pdf.security import SecurityError
    with pytest.raises(SecurityError):
        context.new_page().goto('file:///C:/Windows/win.ini')


def test_hosted_persistent_launch_validates_profile_and_tls(tmp_path, monkeypatch):
    import pytest
    from scansci_pdf.security import SecurityError
    monkeypatch.setenv('SCANSCI_PDF_WORKSPACE', str(tmp_path))
    captured = {}
    class Context:
        def close(self): pass
    class Browser:
        def new_context(self, **kwargs):
            captured.update(kwargs)
            return Context()
        def close(self): pass
    monkeypatch.setattr(browser_backend, 'launch', lambda **kwargs: Browser())
    browser_backend.launch_persistent_context(str(tmp_path/'profile'), config={}, ignore_https_errors=True)
    assert not (tmp_path/'profile').exists()
    assert 'ignore_https_errors' not in captured
    with pytest.raises(SecurityError):
        browser_backend.launch_persistent_context(str(tmp_path.parent/'outside-profile'), config={})
