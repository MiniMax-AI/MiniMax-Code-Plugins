# Apache-2.0; unchanged function from Rimagination/scansci-pdf v1.18.0 ec812f085f392a9b67768fbcad7ddeb340e0245f
def _download_url(
    url: str,
    out: Path,
    identifier: str,
    headers: dict[str, str],
    proxies: dict[str, str] | None,
) -> Path | None:
    """Stream a URL to disk, accepting only real PDFs (magic bytes, >=10KB)."""
    import requests

    try:
        s = requests.Session()
        s.trust_env = False
        resp = s.get(url, headers=headers, proxies=proxies, timeout=30, stream=True, allow_redirects=True)
        if resp.status_code != 200:
            return None
        first = next(resp.iter_content(chunk_size=8192), b"")
        if not first.startswith(b"%PDF"):
            return None
        path = out / _safe_name(identifier)
        with open(path, "wb") as f:
            f.write(first)
            for chunk in resp.iter_content(chunk_size=65536):
                f.write(chunk)
        if path.stat().st_size < 10_000:
            path.unlink(missing_ok=True)
            return None
        return path
    except Exception:
        return None
