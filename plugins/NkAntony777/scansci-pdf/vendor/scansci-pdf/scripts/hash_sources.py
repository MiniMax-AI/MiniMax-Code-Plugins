"""Regenerate source integrity manifest after reviewing engine changes."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
paths = [p for p in (root/'src').rglob('*') if p.is_file() and p.suffix in {'.py', '.json', '.html', '.dat'}]
paths.extend(root/name for name in ['run_secure.py', 'pyproject.toml', 'requirements.lock', 'requirements-browser.lock',
    'scripts/sort_finalize_writeback.py', 'scripts/sort_mdpi_res_batch.py'])
manifest = {'upstream': 'Rimagination/scansci-pdf', 'tag': 'v1.18.0',
    'commit': 'ec812f085f392a9b67768fbcad7ddeb340e0245f',
    'files': {str(p.relative_to(root)).replace('\\', '/'): hashlib.sha256(p.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
              for p in sorted(paths)}}
(root/'SOURCE-HASHES.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
