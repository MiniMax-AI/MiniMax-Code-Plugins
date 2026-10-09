"""Connection-boundary and filesystem policies for the hosted plugin fork."""

from __future__ import annotations

import functools
import inspect
import ipaddress
import json
import os
import socket
import tempfile
import contextlib
import sys
import threading
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPSConnection
from urllib3.connectionpool import HTTPSConnectionPool


class SecurityError(ValueError):
    pass


def strict_mode() -> bool:
    return bool(os.environ.get("SCANSCI_PDF_WORKSPACE"))


def public_address(value: str) -> str:
    address = ipaddress.ip_address(value)
    if (not address.is_global or address.is_multicast or address.is_reserved
            or getattr(address, "ipv4_mapped", None)
            or getattr(address, "sixtofour", None)
            or getattr(address, "teredo", None)
            or (address.version == 6 and address in ipaddress.ip_network("64:ff9b::/96"))):
        raise SecurityError("Only public, globally routable IP addresses are permitted")
    return str(address)


def public_url(url: str) -> str:
    if not isinstance(url, str) or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        raise SecurityError("Invalid public HTTPS URL")
    try:
        parts = urlsplit(url)
        host = parts.hostname
        if (parts.scheme != "https" or not host
                or (parts.port is not None and not 1 <= parts.port <= 65535)
                or parts.username is not None or parts.password is not None
                or "\\" in url or "%" in host):
            raise SecurityError("Only credential-free public HTTPS URLs are permitted")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if host.lower().rstrip(".") in {"localhost", "metadata.google.internal"}:
                raise SecurityError("Local and metadata hosts are prohibited")
        else:
            public_address(host)
    except (TypeError, ValueError) as exc:
        raise SecurityError(str(exc)) from exc
    return host


class PublicHTTPSConnection(HTTPSConnection):
    def _new_conn(self):
        # Resolve at the actual connection boundary, validate ALL answers, then
        # connect to a numeric sockaddr. TLS still verifies the original host.
        answers = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        if not answers:
            raise SecurityError("DNS returned no addresses")
        for _, _, _, _, address in answers:
            public_address(address[0])
        error = None
        for family, kind, protocol, _, address in answers:
            sock = socket.socket(family, kind, protocol)
            try:
                if isinstance(self.timeout, (float, int)) or self.timeout is None:
                    sock.settimeout(self.timeout)
                for level, option, value in self.socket_options or []:
                    sock.setsockopt(level, option, value)
                if self.source_address:
                    sock.bind(self.source_address)
                sock.connect(address)
                public_address(sock.getpeername()[0])
                return sock
            except OSError as exc:
                error = exc
                sock.close()
            except BaseException:
                sock.close()
                raise
        raise error or SecurityError("No public address could be reached")


class PublicHTTPSPool(HTTPSConnectionPool):
    ConnectionCls = PublicHTTPSConnection


class PublicHTTPSAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {"https": PublicHTTPSPool}

    def send(self, request, **kwargs):
        public_url(request.url)
        from .proxy_transport import require_authorized_proxy
        for proxy in (kwargs.get("proxies") or {}).values():
            if proxy:
                require_authorized_proxy(proxy)
        if kwargs.get("verify") is False:
            raise SecurityError("TLS certificate verification cannot be disabled")
        return super().send(request, **kwargs)

    def proxy_manager_for(self, proxy, **kwargs):
        from .proxy_transport import guarded_proxy_manager
        if proxy not in self.proxy_manager:
            self.proxy_manager[proxy] = guarded_proxy_manager(
                proxy, num_pools=self._pool_connections, maxsize=self._pool_maxsize,
                block=self._pool_block, proxy_headers=self.proxy_headers(proxy), **kwargs)
        return self.proxy_manager[proxy]


class PublicSession(requests.Session):
    def __init__(self):
        super().__init__()
        self.trust_env = False
        self.max_redirects = 8
        adapter = PublicHTTPSAdapter(pool_connections=32, pool_maxsize=32, max_retries=0)
        self.mount("https://", adapter)
        self.mount("http://", RejectHTTPAdapter())

def public_session() -> requests.Session:
    return PublicSession()


def enforce_public_transport() -> None:
    # This standalone process hosts only this engine. Cover legacy source helpers
    # that instantiate requests.Session directly, without altering other hosts.
    requests.Session = PublicSession
    requests.sessions.Session = PublicSession


class RejectHTTPAdapter(HTTPAdapter):
    def send(self, request, **kwargs):
        raise SecurityError("Only HTTPS is permitted for untrusted external URLs")


def no_symlinks(path: Path) -> None:
    path = Path(os.path.abspath(path))
    if os.name == 'nt':
        # One native query per ancestor also catches junctions without resolving
        # the target. pathlib.is_symlink + is_junction performs duplicate stats.
        import ctypes
        query = _windows_attributes
        for item in [*reversed(path.parents), path]:
            attributes = query(str(item))
            if attributes != 0xFFFFFFFF and attributes & 0x400:
                raise SecurityError('Symlinks and junctions are not permitted')
        return
    for item in [*reversed(path.parents), path]:
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise SecurityError("Symlinks and junctions are not permitted")


if os.name == 'nt':
    import ctypes
    _windows_attributes = ctypes.WinDLL('kernel32', use_last_error=True).GetFileAttributesW
    _windows_attributes.argtypes = [ctypes.c_wchar_p]
    _windows_attributes.restype = ctypes.c_uint32


_private_dirs = set()
_private_dirs_lock = threading.Lock()


def private_windows_directory(path: Path) -> None:
    # Protect the directory once; new mkstemp files inherit its restricted ACL.
    # Avoid launching icacls for every cached metadata record or saved cookie.
    info = path.stat()
    identity = (str(path), info.st_dev, info.st_ino)
    with _private_dirs_lock:
        if identity in _private_dirs:
            return
        import csv
        import io
        import subprocess
        tool = Path(os.environ["SystemRoot"]) / "System32" / "icacls.exe"
        identity_tool = tool.with_name('whoami.exe')
        output = subprocess.check_output([str(identity_tool), '/user', '/fo', 'csv', '/nh'],
                                        creationflags=subprocess.CREATE_NO_WINDOW).decode('utf-8', errors='replace')
        sid = next(csv.reader(io.StringIO(output.strip())))[1]
        subprocess.run([str(tool), str(path), '/reset'], check=True, capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
        subprocess.run([str(tool), str(path), "/inheritance:r", "/grant:r", f"*{sid}:(OI)(CI)F"],
                       check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        _private_dirs.add(identity)


def workspace_path(value: str | Path) -> Path:
    root = Path(os.environ["SCANSCI_PDF_WORKSPACE"]).absolute()
    raw = Path(value).expanduser()
    candidate = Path(os.path.abspath(raw if raw.is_absolute() else root / raw))
    if not candidate.is_relative_to(root):
        raise SecurityError('Path must remain within the trusted workspace')
    no_symlinks(candidate)
    return candidate


@contextlib.contextmanager
def atomic_binary_writer(path: str | Path, *, private: bool = False, durable: bool = False):
    """Private temporary file and atomic replacement; never follow a target link."""
    path = Path(path).absolute()
    if strict_mode():
        path = workspace_path(path)
    else:
        no_symlinks(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    no_symlinks(path.parent)
    if private and os.name == "nt":
        private_windows_directory(path.parent)
    elif private:
        path.parent.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix=".scansci-", dir=path.parent)
    try:
        if private and os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            fd = None
            yield handle
            handle.flush()
            if durable:
                os.fsync(handle.fileno())
        no_symlinks(path)
        os.replace(temporary, path)
    finally:
        if fd is not None:
            os.close(fd)
        Path(temporary).unlink(missing_ok=True)


def secure_write_text(path: str | Path, text: str) -> None:
    with atomic_binary_writer(path, private=True, durable=True) as handle:
        handle.write(text.encode("utf-8"))


def enforce_workspace_writes() -> None:
    """Cover legacy Python writers without replacing pathlib or builtins APIs.

    This containment guard is not a sandbox for native libraries or child browsers.
    Downloaded content is data, never executable code.
    """
    import sys
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
    def audit(event, args):
        if not strict_mode():
            return
        if event == 'open':
            path, mode, flags = args
            if isinstance(path, (str, bytes, os.PathLike)) and ((flags or 0) & write_flags or mode and any(c in mode for c in 'wax+')):
                workspace_path(os.fsdecode(path))
        elif event in {'os.remove', 'os.rmdir', 'os.mkdir', 'os.chmod', 'os.truncate', 'shutil.rmtree'}:
            if isinstance(args[0], (str, bytes, os.PathLike)):
                workspace_path(os.fsdecode(args[0]))
        elif event in {'os.rename', 'os.link', 'os.symlink'}:
            for path in args[:2]:
                if isinstance(path, (str, bytes, os.PathLike)):
                    workspace_path(os.fsdecode(path))
            if event != 'os.rename':
                raise SecurityError('Creating symlinks/hardlinks is not permitted')
    sys.addaudithook(audit)


def extract_verified_tar(archive, directory: Path, digest: str) -> None:
    """Never extract unverified archives or any absolute/traversal/link member."""
    import hashlib
    import io
    import tarfile
    import re

    data = archive.getvalue()
    if not re.fullmatch(r"[a-f0-9]{64}", digest or "") or hashlib.sha256(data).hexdigest() != digest:
        raise SecurityError("Tor bundle does not match the pinned SHA-256")
    no_symlinks(directory)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as source:
        members = source.getmembers()
        if len(members) > 10000 or sum(m.size for m in members) > 512 * 1024 * 1024:
            raise SecurityError("Tor archive exceeds extraction limits")
        names = set()
        for member in members:
            name = PurePosixPath(member.name)
            if (name.is_absolute() or ".." in name.parts or "\\" in member.name
                    or ":" in member.name or member.name in names
                    or not (member.isdir() or member.isfile())):
                raise SecurityError("Unsafe Tor archive member")
            names.add(member.name)
            no_symlinks(directory / str(name))
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for member in members:
            target = directory / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                no_symlinks(target)
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                fd = os.open(target, flags, 0o600)
                with os.fdopen(fd, "wb") as output, source.extractfile(member) as input_file:
                    import shutil
                    shutil.copyfileobj(input_file, output)


_PATH_ARGUMENTS = {"file", "file_path", "bib_file", "cookie_file", "output_dir", "output", "input_file"}


def guarded_tool(function):
    signature = inspect.signature(function)

    @functools.wraps(function)
    def guarded(*args, **kwargs):
        if not strict_mode():
            return function(*args, **kwargs)
        bound = signature.bind(*args, **kwargs)
        for name in {'url', 'custom_url'} & bound.arguments.keys():
            if bound.arguments[name]:
                public_url(bound.arguments[name])
        for name in _PATH_ARGUMENTS & bound.arguments.keys():
            value = bound.arguments[name]
            if value:
                bound.arguments[name] = str(workspace_path(value))
        for name in {'candidates_json', 'candidates'} & bound.arguments.keys():
            value = bound.arguments[name]
            if isinstance(value, str) and not value.lstrip().startswith(('[', '{')):
                bound.arguments[name] = str(workspace_path(value))
        result = function(*bound.args, **bound.kwargs)
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            pass
        return json.dumps({"trust": "untrusted_external_data", "result": result}, ensure_ascii=False)

    return guarded
