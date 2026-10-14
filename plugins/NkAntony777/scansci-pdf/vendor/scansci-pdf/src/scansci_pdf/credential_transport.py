"""Confine API credentials to their issuing origin on every redirect hop."""

from urllib.parse import urlsplit

import requests

# Headers that carry a secret Elsevier (or any API origin) issued to US. They
# are confined to the origin that supplied them; a redirect that crosses an
# origin boundary must not receive any of them.
CREDENTIAL_HEADERS = ("X-ELS-APIKey", "X-ELS-InstToken", "Zotero-API-Key", "Authorization")

_DEFAULT_PORTS = {"https": 443, "http": 80}


def origin_of(url: str) -> tuple[str, str, int]:
    """(scheme, host, port) of a URL — the unit redirect confinement compares.

    Scheme, host AND port all participate: ``https://host`` and
    ``https://host:8443`` are different origins, and a scheme downgrade to
    plain HTTP is a boundary crossing even when the host is unchanged.
    """
    parts = urlsplit(str(url))
    scheme = (parts.scheme or "").lower()
    host = (parts.hostname or "").lower()
    try:
        port = parts.port
    except ValueError:  # malformed port: treat it as unspecified, not trusted
        port = -1
    if port is None:
        port = _DEFAULT_PORTS.get(scheme, -1)
    return (scheme, host, port)


class _OriginConfinedSession:
    """Mixin: never send origin credentials to a different origin.

    ``requests`` strips ``Authorization`` on a cross-host redirect but leaves
    arbitrary headers such as ``X-ELS-APIKey`` / ``X-ELS-InstToken`` in place,
    so an API response that redirects elsewhere would hand an institutional
    token to whatever host it named. This strips the confined headers on the
    prepared request immediately before it is handed to the adapter, which is
    the single choke point every redirect hop passes through — 301/302/303/
    307/308 alike, first request and later hops, so a hop that is rebuilt as a
    GET, a hop that is replayed as-is, and the SSL retry all behave the same.

    Stripping on the way out (rather than rebuilding the request) keeps the
    per-hop public-address check and TLS verification intact: the request is
    still validated and sent by the very same adapter stack, just without the
    credentials this origin is not entitled to share.
    """

    #: origin the credentials belong to; ``None`` disables confinement
    credential_origin: tuple[str, str, int] | None = None

    def send(self, request, **kwargs):
        if self.credential_origin is not None:
            if origin_of(request.url) != self.credential_origin:
                for name in CREDENTIAL_HEADERS:
                    request.headers.pop(name, None)
        return super().send(request, **kwargs)


_confined_session_class: type | None = None


def confined_session(url: str) -> requests.Session:
    """A real Session for ``url`` whose origin credentials stay at that origin.

    Built from whatever ``requests.Session`` currently is, so under the secure
    launcher this is still the real ``PublicSession`` and keeps its per-hop
    public-address check, proxy authorization and TLS verification.
    """
    global _confined_session_class

    base = requests.Session
    if _confined_session_class is None or not issubclass(_confined_session_class, base):
        _confined_session_class = type(
            "_OriginConfinedSession", (_OriginConfinedSession, base), {},
        )
    session = _confined_session_class()
    session.credential_origin = origin_of(url)
    return session



def confined_request(method: str, url: str, **kwargs):
    """Use the confined transport for a one-off API request."""
    with confined_session(url) as session:
        return session.request(method, url, **kwargs)
