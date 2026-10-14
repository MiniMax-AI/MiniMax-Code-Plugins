"""Launch the vendored engine with the hosted-plugin security policy enabled."""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):
    raise SystemExit('Python >=3.11 is required')
if not sys.flags.isolated:
    raise SystemExit('Isolated Python startup required: use launch_secure.mjs or python -I run_secure.py')

import os
from pathlib import Path
import hashlib
import importlib.abc
import importlib.util
import json
import re

engine = Path(__file__).resolve().parent
package = engine.parents[1] if engine.parent.name == 'vendor' else engine
provenance = engine / 'SOURCE-HASHES.json'
if not provenance.exists():
    raise SystemExit('Pinned source manifest is required')
if provenance.exists():
    manifest = json.loads(provenance.read_text(encoding='utf-8'))
    for name, expected in manifest['files'].items():
        candidate = engine / name
        if candidate.is_symlink() or not candidate.resolve().is_relative_to(engine):
            raise SystemExit('Engine file escapes the pinned source directory')
        content = candidate.read_bytes().replace(b'\r\n', b'\n')
        if hashlib.sha256(content).hexdigest() != expected:
            raise SystemExit(f'Pinned engine source changed: {name}')
    actual = {str(p.relative_to(engine)).replace('\\', '/') for p in (engine/'src').rglob('*')
              if p.is_file() and p.suffix in {'.py', '.json', '.html', '.dat', '.pyd', '.so', '.dll'}}
    if actual != {name for name in manifest['files'] if name.startswith('src/')}:
        raise SystemExit('Unexpected or missing source/native module in pinned engine')

class SourceLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Load verified source directly, ignoring stale/untrusted bytecode caches."""
    def _pinned_file(self, fullname):
        relative = 'src/' + fullname.replace('.', '/')
        for name in (relative + '/__init__.py', relative + '.py'):
            if name in manifest['files']:
                file = engine / name
                if file.is_file():
                    return file
        return None
    def find_spec(self, fullname, path=None, target=None):
        if fullname != 'scansci_pdf' and not fullname.startswith('scansci_pdf.'):
            return None
        file = self._pinned_file(fullname)
        if file is None:
            # Optional engine modules must retain their source fallback, not
            # fall through to an unverified bytecode/native/namespace finder.
            raise ModuleNotFoundError(f'No pinned engine source for {fullname}', name=fullname)
        return importlib.util.spec_from_file_location(fullname, file, loader=self,
                    submodule_search_locations=[str(file.parent)] if file.name == '__init__.py' else None)
    def create_module(self, spec): return None
    def get_code(self, fullname):
        # `runpy` — which drives `--module` — asks the loader for the CODE of a
        # module before executing it, and only then discovers whether it is a
        # package. Without this the loader can import a pinned module but not
        # serve one to `runpy`: '--module' fails with
        # "'SourceLoader' object has no attribute 'get_code'".
        # The file is the same manifest-verified source `exec_module` reads.
        file = self._pinned_file(fullname)
        if file is None:
            raise ImportError(f'No pinned engine source for {fullname}', name=fullname)
        return compile(file.read_bytes(), str(file), 'exec')
    def exec_module(self, module):
        exec(self.get_code(module.__spec__.name), module.__dict__)

sys.meta_path.insert(0, SourceLoader())
sys.dont_write_bytecode = True

def verify_dependencies():
    # `packaging` is a declared runtime dependency (see pyproject.toml); a
    # clean/isolated environment that lacks it must get an actionable message
    # instead of a raw ModuleNotFoundError traceback.
    try:
        from packaging.requirements import Requirement
    except ImportError:
        raise SystemExit(
            "Missing runtime dependency 'packaging'.\n"
            "Install it with: python -m pip install 'packaging>=24,<27'\n"
            "or install the pinned set: "
            "python -m pip install --require-hashes -r requirements.lock"
        )
    from importlib.metadata import PackageNotFoundError, version
    lines = (engine/'requirements.lock').read_text(encoding='utf-8').splitlines()
    for line in lines:
        if not line or line[0].isspace() or line.startswith('#'):
            continue
        requirement = Requirement(line.removesuffix('\\').strip())
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            installed = version(requirement.name)
        except PackageNotFoundError:
            raise SystemExit(f'Missing pinned dependency: {requirement.name}')
        if installed not in requirement.specifier:
            raise SystemExit(f'Dependency version mismatch: {requirement.name} {installed}; expected {requirement.specifier}')
    optional = engine/'requirements-browser.lock'
    if optional.exists():
        for line in optional.read_text(encoding='utf-8').splitlines():
            if not line or line[0].isspace() or line.startswith('#'):
                continue
            requirement = Requirement(line.removesuffix('\\').strip())
            if requirement.marker and not requirement.marker.evaluate():
                continue
            try:
                installed = version(requirement.name)
            except PackageNotFoundError:
                continue
            if installed not in requirement.specifier:
                raise SystemExit(f'Optional dependency version mismatch: {requirement.name} {installed}; expected {requirement.specifier}')

verify_dependencies()

root = Path.cwd().resolve()
if provenance.exists() and root.is_relative_to(package):
    raise SystemExit('Launch from the project workspace, outside the plugin package')
os.environ["SCANSCI_PDF_WORKSPACE"] = str(root)
os.environ["SCANSCI_PDF_DATA_DIR"] = str(root / ".scansci-pdf")
os.environ['SCANSCI_PDF_SECURE_ENTRY'] = str(engine/'run_secure.py')
os.umask(0o077)

src = engine / "src"
sys.path.insert(0, str(src))

from scansci_pdf.security import enforce_public_transport, enforce_workspace_writes, workspace_path
temporary = workspace_path(root / '.scansci-pdf' / 'tmp')
temporary.mkdir(parents=True, exist_ok=True, mode=0o700)
os.environ['TMP'] = os.environ['TEMP'] = os.environ['TMPDIR'] = str(temporary)
import tempfile
tempfile.tempdir = str(temporary)
enforce_public_transport()
enforce_workspace_writes()
from scansci_pdf.proxy_redaction import install_secret_egress
install_secret_egress()

if '--verify' in sys.argv:
    from scansci_pdf import __version__
    # What this proves is narrow, and the output says so: the vendored files
    # match the shipped SOURCE-HASHES.json manifest and the installed
    # dependency versions match requirements.lock. It does NOT attest that the
    # bytes came from the upstream tag/commit recorded in the manifest, nor
    # that `__version__` identifies the executing distribution.
    print(json.dumps({'engine_version': __version__, 'source': str(src), 'workspace': str(root),
                      'python_executable': sys.executable, 'python_version': list(sys.version_info[:2]),
                      'isolated_startup': bool(sys.flags.isolated),
                      'source_manifest': 'verified', 'dependency_lock': 'verified',
                      'verification_scope': 'local file hashes + installed dependency versions; '
                                            'not an upstream provenance attestation'}))
else:
    if len(sys.argv) > 2 and sys.argv[1] == '--module':
        import runpy
        module = sys.argv[2]
        # Allowlist, not a prefix: only these two engine modules may be driven
        # through the verified source loader. `scansci_pdf.cli` is a package and
        # executes its `cli/__main__.py`, which calls the Typer app that
        # registers `session-broker-run` and the rest of the commands.
        if module not in {'scansci_pdf.cli', 'scansci_pdf.progress_bar'}:
            raise SystemExit('Unknown engine child module')
        sys.argv = [module, *sys.argv[3:]]
        runpy.run_module(module, run_name='__main__', alter_sys=True)
        raise SystemExit(0)
    if len(sys.argv) > 2 and sys.argv[1] == '--helper':
        import runpy
        helper = sys.argv[2]
        if helper not in {'sort_finalize_writeback.py', 'sort_mdpi_res_batch.py'}:
            raise SystemExit('Unknown packaged helper')
        sys.argv = [str(engine/'scripts'/helper), *sys.argv[3:]]
        runpy.run_path(sys.argv[0], run_name='__main__')
        raise SystemExit(0)
    from scansci_pdf.main import main
    main()
