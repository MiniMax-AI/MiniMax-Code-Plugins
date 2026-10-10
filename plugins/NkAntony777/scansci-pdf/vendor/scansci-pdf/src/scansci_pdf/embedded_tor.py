"""Embedded Tor: auto-download and manage Tor binary as subprocess.

Downloads Tor Expert Bundle to ~/.scansci-pdf/tor/ on first use,
starts it as a SOCKS5 proxy subprocess, and cleans up on exit.
Supports obfs4 bridges for restricted networks.
"""

from __future__ import annotations

import io
import hashlib
import os
import platform
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from .log import get_logger

log = get_logger()

# Default bridges for restricted networks (obfs4)
DEFAULT_OBFS4_BRIDGES = [
    "obfs4 154.35.22.13:16844 8FB268DC3037E3F5A5E64C9031B2F92384321B93 cert=bjNGcJBJqUTRqtA4q0z2CU8wmsGdDJnVBPpnrZqK+z8kfH3ZNxFbcFhsBdz2t317W77YOA iat-mode=0",
    "obfs4 192.95.36.142:443 3424DB3F0F1F5A7935872FDE7573F9FB912AAEF1 cert=nmPlqulSC4W5X+9mrrq1xLObRTFM81QjPcJm687Dsr0PQRw4UaI8OCkuNfYklA3/aWF3sA iat-mode=0",
    "obfs4 51.222.13.177:50000 1C46E0A5B76D624B99260522F818D1F0287FD4B4 cert=uxPGjNskSCqHGoODKx8j3wcllOJBuJnlkGEXXf9geUZG4YEmyrPK1sc0ePsSVuLD8P9Kg iat-mode=0",
    "obfs4 51.81.223.139:50000 B3A09F6EE345B6B246D3C462FF6643BB30D639FF cert=+yoRAwJXN3Ge1mH2kDjDRTXWbJa1yANPN4kvP1H4ozuFr3S9NbfPQ6YMclexjGqIIAFJcA iat-mode=0",
]

# Mirror URLs for downloading Tor Expert Bundle.
# Files live under {mirror}/torbrowser/{version}/ on both mirrors.
TOR_DOWNLOAD_MIRRORS = [
    "https://dist.torproject.org/torbrowser",
    "https://archive.torproject.org/tor-package-archive/torbrowser",
]

# Tor Browser version shipping the Expert Bundle. Bump when torproject.org
# cuts a new stable release. Hash manifest fetched from Tor Project 2026-10-09.
TOR_VERSION = "15.0.24"
# SHA-256 values from Tor Project's sha256sums-signed-build.txt for this release.
# A release upgrade must update these source-controlled pins, not fetch new pins.
TOR_HASHES = {
    'linux-x86_64': '8e012ec6815d7899cb64011582e2dade88e74119c6661068a2a3252de0ccd7f2',
    'linux-i686': '7537fea3478d05b8af25d7f8199c031b281f7015c32bb4177bef71f8e5100d9b',
    'macos-aarch64': 'd47afd04b6c751129978390ad003d74ac8b88adfbb939350f0f89999e6570644',
    'macos-x86_64': '8acb0b590f6be34084dcb6d84009ac0c61cc7c5261b7a19d2ab94845aa9bd5b6',
    'windows-x86_64': 'e9dc6ccc93cd6afa507193f4de284d6424233ff5102155cd2c94b259e8a22b65',
    'windows-i686': '7c2755b09876ebc6c2e2d2d1d3279b2be3e9beec35ff0ca2e7df4c1abcad1ae4',
}


def _download_url() -> tuple[str, str]:
    """Get the download URL path and filename for the Tor Expert Bundle.

    Returns ``(url_path, filename)`` where ``url_path`` is relative to a
    mirror root (e.g. ``"15.0.17"``) and ``filename`` is the archive name.
    All Expert Bundle archives are .tar.gz on every platform since 0.4.7.x.
    """
    system = platform.system()
    machine = platform.machine().lower()

    # Map (system, machine) → the os-arch slug used in the filename.
    if system == "Windows":
        os_arch = "windows-i686" if machine in ('x86', 'i386', 'i686') else "windows-x86_64"
    elif system == "Darwin":
        os_arch = "macos-aarch64" if machine in ("arm64", "aarch64") else "macos-x86_64"
    elif system == 'Linux' and machine in ('x86_64', 'amd64', 'i386', 'i686', 'x86'):
        os_arch = 'linux-i686' if machine in ('i386', 'i686', 'x86') else 'linux-x86_64'
    else:
        raise ValueError(f'No pinned Tor Expert Bundle for {system}/{machine}')

    filename = f"tor-expert-bundle-{os_arch}-{TOR_VERSION}.tar.gz"
    return TOR_VERSION, filename


def _tor_dir(config: dict[str, Any]) -> Path:
    from .config import DATA_DIR
    from .security import strict_mode, workspace_path, no_symlinks
    path = Path(config.get("cache_dir", str(DATA_DIR / "cache"))).parent / "tor"
    path = workspace_path(path) if strict_mode() else path.absolute()
    no_symlinks(path)
    return path


def _tor_binary(config: dict[str, Any]) -> Path | None:
    """Find the tor binary path, downloading if needed."""
    from .security import strict_mode
    bundle = _tor_dir(config) / f'bundle-{TOR_VERSION}'
    if bundle.exists():
        return _verify_bundle(bundle)
    # PATH executables remain available only to standalone, non-hosted users.
    system_tor = shutil.which('tor') if not strict_mode() else None
    return Path(system_tor) if system_tor else None


def _bundle_digest():
    _, filename = _download_url()
    slug = filename.removeprefix('tor-expert-bundle-').removesuffix(f'-{TOR_VERSION}.tar.gz')
    return TOR_HASHES[slug]


def _verify_bundle(bundle: Path) -> Path:
    from .security import SecurityError, no_symlinks
    no_symlinks(bundle)
    archive_path = bundle / '.bundle.tar.gz'
    no_symlinks(archive_path)
    data = archive_path.read_bytes()
    if hashlib.sha256(data).hexdigest() != _bundle_digest():
        raise SecurityError('Cached Tor archive failed pinned verification')
    expected = {'.bundle.tar.gz'}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for member in archive:
            if not member.isfile():
                continue
            target = bundle / member.name
            no_symlinks(target)
            if not target.resolve().is_relative_to(bundle.resolve()):
                raise SecurityError('Tor bundle path escapes installation')
            with archive.extractfile(member) as original:
                if hashlib.sha256(target.read_bytes()).digest() != hashlib.sha256(original.read()).digest():
                    raise SecurityError('Installed Tor file differs from verified archive')
            expected.add(str(target.relative_to(bundle)).replace('\\', '/'))
    actual = set()
    for path in bundle.rglob('*'):
        no_symlinks(path)
        if path.is_file():
            actual.add(str(path.relative_to(bundle)).replace('\\', '/'))
    if actual != expected:
        raise SecurityError('Unexpected file in Tor executable directory')
    executable = bundle / 'tor' / ('tor.exe' if platform.system() == 'Windows' else 'tor')
    if not executable.is_file():
        raise SecurityError('Verified bundle lacks Tor executable')
    return executable


def download_tor(config: dict[str, Any]) -> Path | None:
    """Stage a pinned bundle; never execute an unchecked download or legacy cache."""
    from .security import SecurityError, strict_mode, public_session, extract_verified_tar, no_symlinks
    if strict_mode() and not config.get('tor_install_confirmed'):
        raise SecurityError('Confirm the Tor installation explicitly before downloading executables')
    directory = _tor_dir(config)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    no_symlinks(directory)
    destination = directory / f'bundle-{TOR_VERSION}'
    if destination.exists():
        return _verify_bundle(destination)
    version, filename = _download_url()
    data = None
    with public_session() as session:
        from .network import configured_proxy
        proxy = configured_proxy(config)
        if proxy:
            session.proxies = {'https': proxy}
        for mirror in TOR_DOWNLOAD_MIRRORS:
            try:
                with session.get(f'{mirror}/{version}/{filename}', stream=True, timeout=(10, 30)) as response:
                    response.raise_for_status()
                    chunks, total = [], 0
                    deadline = time.monotonic() + 180
                    for chunk in response.iter_content(65536):
                        total += len(chunk)
                        if total > 128 * 1024 * 1024 or time.monotonic() > deadline:
                            raise SecurityError('Tor download exceeds size/time limit')
                        chunks.append(chunk)
                    data = b''.join(chunks)
                break
            except (OSError, __import__('requests').RequestException) as exc:
                log.warning('Tor mirror unavailable: %s', exc)
    if data is None:
        return None
    stage = Path(tempfile.mkdtemp(prefix='.tor-stage-', dir=directory))
    try:
        extract_verified_tar(io.BytesIO(data), stage, _bundle_digest())
        (stage / '.bundle.tar.gz').write_bytes(data)
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for member in archive:
                if member.isfile() and member.mode & 0o111:
                    (stage / member.name).chmod(0o700)
        _verify_bundle(stage)
        stage.rename(destination)
        return _verify_bundle(destination)
    finally:
        if stage.exists():
            no_symlinks(stage)
            if stage.parent.resolve() != directory.resolve() or not stage.name.startswith('.tor-stage-'):
                raise SecurityError('Invalid temporary extraction directory')
            shutil.rmtree(stage)


def _write_torrc(tor_dir: Path, socks_port: int, use_bridges: bool = False, binary_dir: Path | None = None) -> Path:
    """Generate a minimal torrc configuration file."""
    torrc_path = tor_dir / "torrc"
    lines = [
        f"SocksPort {socks_port}",
        "SocksListenAddress 127.0.0.1",
        "AvoidDiskWrites 1",
        "Log notice stdout",
        "GeoIPFile unreachable",
        "GeoIPv6File unreachable",
        f'DataDirectory "{str(tor_dir / "data").replace(chr(92), "/")}"',
    ]

    if use_bridges:
        lines.append("UseBridges 1")
        candidates = [binary_dir / 'pluggable_transports' / name for name in ('lyrebird.exe', 'lyrebird', 'obfs4proxy.exe', 'obfs4proxy')] if binary_dir else []
        transport = next((path for path in candidates if path.is_file()), None)
        if transport is None:
            raise ValueError('Verified bundle lacks an obfs4 transport')
        lines.append(f'ClientTransportPlugin obfs4 exec "{str(transport).replace(chr(92), "/")}"')
        for bridge in DEFAULT_OBFS4_BRIDGES:
            lines.append(f"Bridge {bridge}")

    from .security import secure_write_text
    secure_write_text(torrc_path, "\n".join(lines) + "\n")
    return torrc_path


class EmbeddedTor:
    """Manages an embedded Tor subprocess as a SOCKS5 proxy."""

    def __init__(self, config: dict[str, Any], socks_port: int = 0, use_bridges: bool = False):
        self.config = config
        self.socks_port = socks_port or self._find_free_port()
        self.use_bridges = use_bridges
        self._process: subprocess.Popen | None = None
        self._binary: Path | None = None

    @staticmethod
    def _find_free_port() -> int:
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    @property
    def proxy_url(self) -> str:
        return f"socks5h://127.0.0.1:{self.socks_port}"

    def start(self, timeout: int = 60) -> bool:
        """Start Tor subprocess and wait for it to be ready."""
        self._binary = _tor_binary(self.config)

        # Download if not found
        if not self._binary:
            log.info("Tor binary not found, downloading...")
            self._binary = download_tor(self.config)
            if not self._binary:
                return False

        # Warn when something else already holds our port — typically a
        # foreign/orphaned tor from a recycled MCP server process. Our own
        # tor would then die on bind and start() reports failure while the
        # proxy actually still works on that port (#61).
        import socket as _socket
        try:
            with _socket.create_connection(("127.0.0.1", self.socks_port), timeout=1):
                log.warning(
                    f"Tor: port {self.socks_port} is already occupied by another process — "
                    "if this is an old embedded Tor, either reuse it via tor_proxy "
                    f"({self.proxy_url}) or stop it before starting a new instance"
                )
        except OSError:
            pass

        tor_dir = self._binary.parent
        torrc = _write_torrc(_tor_dir(self.config) / 'runtime', self.socks_port, self.use_bridges, tor_dir)

        cmd = [str(self._binary), "-f", str(torrc)]
        log.info(f"Starting Tor: {' '.join(cmd[:2])}")

        try:
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == "Windows" else 0,
            )
        except Exception as e:
            log.error(f"Failed to start Tor: {e}")
            return False

        # Wait for SOCKS port to be ready
        import socket
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", self.socks_port), timeout=2):
                    log.info(f"Tor ready on {self.proxy_url}")
                    return True
            except (ConnectionRefusedError, OSError):
                # Check if process died
                if self._process.poll() is not None:
                    log.error(f"Tor exited with code {self._process.returncode}")
                    stderr = self._process.stderr.read().decode("utf-8", errors="replace")[:500]
                    log.error(f"Tor stderr: {stderr}")
                    self._process = None
                    return False
                time.sleep(1)

        log.warning("Tor startup timed out")
        self.stop()
        return False

    def stop(self) -> None:
        """Stop the Tor subprocess."""
        if self._process and self._process.poll() is None:
            log.info("Stopping embedded Tor")
            try:
                if platform.system() == "Windows":
                    self._process.terminate()
                else:
                    self._process.send_signal(signal.SIGTERM)
                self._process.wait(timeout=10)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None

    def is_running(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.stop()


# Global singleton for embedded Tor process
_embedded_tor: EmbeddedTor | None = None
_tor_lock = threading.Lock()
_tor_unavailable_since: float = 0.0  # timestamp when Tor last failed
_TOR_UNAVAILABLE_TTL = 3600  # 1 hour before retrying Tor download


def get_embedded_tor(config: dict[str, Any]) -> EmbeddedTor | None:
    """Get or create a global embedded Tor instance.

    If Tor download previously failed, skips retry for 1 hour to avoid
    blocking on unreachable torproject.org mirrors.
    """
    global _embedded_tor, _tor_unavailable_since
    with _tor_lock:
        if _embedded_tor and _embedded_tor.is_running():
            return _embedded_tor
        # Fast skip: Tor download previously failed within the TTL
        if _tor_unavailable_since and (time.time() - _tor_unavailable_since) < _TOR_UNAVAILABLE_TTL:
            return None

        use_bridges = config.get("tor_use_bridges", False)
        tor = EmbeddedTor(config, use_bridges=use_bridges)
        if tor.start():
            _embedded_tor = tor
            _tor_unavailable_since = 0.0  # reset on success
            return tor
        _tor_unavailable_since = time.time()  # cache failure timestamp
        return None


def running_embedded_tor() -> "EmbeddedTor | None":
    """Return the embedded instance only if it is ALREADY running.

    Unlike get_embedded_tor this never starts Tor or downloads a binary —
    safe to call from a health probe that must stay side-effect free (#61).
    """
    with _tor_lock:
        if _embedded_tor and _embedded_tor.is_running():
            return _embedded_tor
    return None


def stop_embedded_tor() -> None:
    """Stop the global embedded Tor instance."""
    global _embedded_tor
    with _tor_lock:
        if _embedded_tor:
            _embedded_tor.stop()
            _embedded_tor = None


def is_tor_installed(config: dict[str, Any]) -> bool:
    """Check if Tor binary is available (embedded or system)."""
    return _tor_binary(config) is not None


def install_tor(config: dict[str, Any]) -> dict[str, Any]:
    """Download and install Tor. Returns status dict."""
    binary = _tor_binary(config)
    if binary:
        return {"installed": True, "path": str(binary), "message": "Tor already installed"}

    binary = download_tor(config)
    if binary:
        return {"installed": True, "path": str(binary), "message": f"Tor installed to {binary}"}
    return {"installed": False, "error": "Failed to download Tor. Check network connectivity."}
