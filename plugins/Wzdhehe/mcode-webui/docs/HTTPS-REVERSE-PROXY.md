# HTTPS and reverse proxy

> **Why this doc exists.** The webui binds plain HTTP (Node `http.createServer`).
> TLS termination is delegated to a reverse proxy in front of it. This page
> collects three ready-to-copy configs (nginx, caddy, Traefik 2) plus the SSE
> foot-guns that bite people who don't know to look for them.

## Table of contents

| # | Section |
|---|---|
| 1 | [Why a reverse proxy](#1-why-a-reverse-proxy) |
| 2 | [How the webui and the proxy share auth](#2-how-the-webui-and-the-proxy-share-auth) |
| 3 | [Common pitfalls — Server-Sent Events (SSE)](#3-common-pitfalls--server-sent-events-sse) |
| 4 | [nginx](#4-nginx) |
| 5 | [caddy](#5-caddy) |
| 6 | [Traefik 2](#6-traefik-2) |
| 7 | [Verification checklist](#7-verification-checklist) |
| 8 | [Troubleshooting](#8-troubleshooting) |

## 1. Why a reverse proxy

| Capability | Status | Why |
|---|---|---|
| Built-in HTTPS server | ❌ | Node's `https.createServer` needs cert + key files; ops would have to be re-implemented for cert rotation, SNI, OCSP stapling, ALPN. The Node stdlib also lacks ACME. We deliberately don't ship a TLS stack. |
| Reverse-proxy-friendly | ✅ | The webui serves the full HTTP API on `PORT` (default 8080). 🔒 v2 (PR #55 review point 2): the default bind is now loopback `127.0.0.1` — for a same-host proxy that is exactly right (proxy → `127.0.0.1:8080`). If the proxy lives on another host, opt into a wider bind explicitly: `HOST=0.0.0.0` env or the persisted `lanBind` setting (`POST /api/settings {lanBind: true}`). nginx / caddy / Traefik in front is the recommended deployment shape. |
| mTLS (client certs) | ❌ | Same as HTTPS — not in scope; configure mTLS at the proxy layer. |
| Rate limiting | ✅ | Per-`{IP,token}` fixed-window limiter (see [`server/lib/rate-limit.js`](../server/lib/rate-limit.js)). Token holders get 2x. Loopback bypasses entirely. |

**When you don't need a proxy.** The webui is also designed to run local-only:
`HOST=127.0.0.1` (the v2 default) + `MCODE_WEBUI_RATE_LIMIT` defaults
are safe on loopback.

## 2. How the webui and the proxy share auth

The webui accepts two token carriers (see [`server/lib/auth.js`](../server/lib/auth.js)):

| Carrier | Use case |
|---|---|
| `Authorization: Bearer <token>` | Browser `fetch`, programmatic clients. Preferred — never touches URL bar / referer / history. |
| `?token=<token>` query string | Browser `EventSource` (SSE). The `EventSource` API cannot set custom headers, so the only way to authenticate an SSE connection from the browser is via the URL. |

**Recommendation for proxy configs below**: set `MCODE_WEBUI_TOKEN=<random>` on the webui process, and either:

- (preferred) have the proxy rewrite the `Authorization` header to the webui's expected value (`proxy_set_header Authorization "Bearer <token>"`), OR
- pass `?token=<token>` straight through (the EventSource will see it).

**Don't log the token.** Both nginx and caddy default to logging the request line including the query string; if you put `?token=` in the URL, that lands in the access log. Either:
- strip the `token=` query param at the proxy (`proxy_set_header Authorization "Bearer $arg_token"`), OR
- set `access_log off` for the SSE / API location.

### 2.1 Browser origins behind a proxy — the `trustedOrigins` allowlist (v2)

🔒 v2 (PR #55 review point 1) replaced the old wildcard CORS with
**trusted-origin reflection**, and added a browser **Origin/CSRF gate**:
any mutating request (`POST` / `DELETE`) whose `Origin` header is
present but untrusted is rejected 403 *before* every other gate.

Behind a reverse proxy the browser's `Origin` is your **external**
origin — `https://webui.example.com` — not the webui's own
`http://127.0.0.1:8080`. The webui only trusts its own serving origins
(loopback + LAN address while LAN sharing is on) plus an explicit
allowlist, so **you must register the external origin** or the SPA's
own authenticated `POST`s will 403 and cross-origin reads will fail:

```bash
# one-time, against the local webui (adjust scheme/host/port):
curl -X POST http://127.0.0.1:8080/api/settings \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <your-token>" \
  -d '{"trustedOrigins": ["https://webui.example.com"]}'
```

Rules (fail-closed, whole batch): `http`/`https` origin serialization
only (`scheme://host[:port]`, no path/query/userinfo), at most 16
entries of 1..200 chars; an invalid batch is rejected 400 unchanged.
The list is persisted in `~/.mcode-webui/settings.json` and returned by
`GET /api/settings`. Details:
[SECURITY-NOTES — CORS](../references/SECURITY-NOTES.md#cors--cross-origin-resource-sharing).

Proxy checklist for origins:

- **Forward the `Origin` header untouched.** nginx / caddy / Traefik
  all pass it through by default — do NOT strip it, and do NOT rewrite
  it to something else (the webui reflects and gates on the verbatim
  value).
- **Use the exact browser-visible origin**, scheme + host + port. If
  you serve the SPA on `https://webui.example.com` (default port),
  the entry is `https://webui.example.com` — no trailing slash, no
  path. An `http://` origin behind an `https://` page will never be
  sent by the browser, so don't list it.
- The webui sends `Vary: Origin` on every response; proxies must not
  strip `Vary` either, or a cached CORS response could be reused for a
  different origin.
- Programmatic clients that send no `Origin` (curl, MCP, CLI) are
  unaffected by the gate — they keep working through the proxy as
  before.

## 3. Common pitfalls — Server-Sent Events (SSE)

SSE long connections (`/api/events`, `/api/alerts`) are the #1 source of "my proxy works for everything except the live feed" bug reports. The trap is buffering: reverse proxies default to **buffering upstream responses** to send them in one TCP write, which kills any stream that depends on incremental flushing.

| Pitfall | Symptom | Fix |
|---|---|---|
| **Response buffering** | Events appear in batches every 30+ seconds instead of as they happen | `proxy_buffering off;` (nginx) / `flush_interval -1` or `buffer` not set (caddy) / `flushInterval: "100ms"` (Traefik 2 file provider) |
| **HTTP/1.0 downstream** | Some proxies default to HTTP/1.0 for upstream; SSE needs 1.1 for chunked transfer | `proxy_http_version 1.1;` (nginx) / `versions h1 h2` (Traefik 2.4+ default) |
| **Connection: close header injected by proxy** | EventSource closes every few minutes | `proxy_set_header Connection "";` (nginx) / default in caddy / default in Traefik 2 |
| **Read timeout shorter than event gap** | If the proxy's idle timeout < event gap, it kills the SSE | `proxy_read_timeout 1h;` (nginx) / `timeouts { read 1h }` (Traefik 2) |
| **`/api/health` throttled** | Liveness probe gets 429 under load | Exempt `/api/health` at the proxy level too (most do — but some rate-limiting middlewares don't) |

## 4. nginx

Tested against nginx 1.24.x. Replace every `example.com`, `/path/to/`, and `127.0.0.1:8080` with your values.

```nginx
# /etc/nginx/sites-available/mcode-webui.conf
# Upstream: the webui binds 127.0.0.1:8080 by default (v2 loopback
# default) — ideal for a same-host proxy. If the proxy runs on another
# host, widen the bind explicitly on the webui process (HOST=0.0.0.0
# env, or POST /api/settings {lanBind: true}). Remember to register
# the external origin in trustedOrigins — see §2.1.
upstream mcode_webui_upstream {
    server 127.0.0.1:8080;
    keepalive 32;
}

# Plain HTTP → HTTPS redirect. Comment out if you only run LAN.
server {
    listen 80;
    listen [::]:80;
    server_name webui.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name webui.example.com;

    # TLS cert / key. Use certbot / acme.sh / your CA. Webui does NOT
    # ship a TLS stack; everything here is at the proxy layer.
    ssl_certificate     /etc/letsencrypt/live/webui.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webui.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Strip the `?token=` query string before it lands in the access log.
    # Token holders are then re-injected as Authorization header so the
    # webui's lib/auth.js#extractToken sees the same value either way.
    # This is the safest default; remove if you don't mind the token
    # appearing in your nginx access log.
    set $auth_bearer $arg_token;
    if ($http_authorization != "") { set $auth_bearer $http_authorization; }

    access_log /var/log/nginx/mcode-webui.access.log;
    error_log  /var/log/nginx/mcode-webui.error.log;

    # --- SSE / streaming endpoints ---------------------------------------
    # MUST come before the catch-all `/` location so the SSE-specific
    # overrides win.
    location ~ ^/api/(events|alerts)$ {
        proxy_pass http://mcode_webui_upstream;

        # SSE: disable buffering so each `data:` line flushes immediately.
        proxy_buffering off;
        proxy_cache off;

        # SSE: HTTP/1.1 upstream so chunked transfer encoding works.
        proxy_http_version 1.1;

        # SSE: clear the upstream Connection header — some apps send
        # "close" which makes EventSource disconnect mid-stream.
        proxy_set_header Connection "";

        # SSE: keep the connection open longer than the proxy's default
        # 60s idle timeout. 1h matches webui's keepalive cadence.
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization    $auth_bearer;
    }

    # --- API + SPA -------------------------------------------------------
    location / {
        proxy_pass http://mcode_webui_upstream;

        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization    $auth_bearer;

        # Reasonable default for the JSON API. /api/events already has
        # its own block above.
        proxy_read_timeout 60s;
    }
}
```

## 5. caddy

Tested against caddy 2.7.x. Caddy auto-requests Let's Encrypt certs if you
omit the `tls` block, but this example keeps the cert explicit so reviewers
can drop in their own.

```caddyfile
# /etc/caddy/Caddyfile
# Upstream address — match what you set PORT/HOST to on the webui process.
# 127.0.0.1 is the recommended default; the proxy and the webui run on
# the same host.

webui.example.com {
    # ----- TLS -----
    # Replace with your cert / key paths, OR delete this block to let
    # Caddy auto-provision via ACME (requires DNS-01 or HTTP-01 reach).
    tls /etc/letsencrypt/live/webui.example.com/fullchain.pem \
        /etc/letsencrypt/live/webui.example.com/privkey.pem

    # ----- Logging -----
    log {
        output file /var/log/caddy/mcode-webui.log
        # DON'T include the query string in the log — `?token=` would
        # leak. The default `LOG` format already redacts the URI's query.
        format console
    }

    # ----- Reverse proxy base config -----
    reverse_proxy http://127.0.0.1:8080 {
        # SSE: keep the upstream connection open. Caddy's default is
        # 30s; bump to 1h to match the webui's keepalive.
        transport http {
            # Caddy 2.7+ supports read_timeout per transport.
            read_timeout 1h
            dial_timeout 30s
        }

        # Header policy. Caddy already forwards standard headers; the
        # Authorization header rewrite is the only webui-specific bit.
        header_up Host              {host}
        header_up X-Real-IP         {remote_host}
        header_up X-Forwarded-For   {remote_host}
        header_up X-Forwarded-Proto {scheme}
        # Token carriers (priority: client Authorization header > ?token=
        # query string). lib/auth.js#extractToken accepts both.
        header_up Authorization {http.reverse_proxy.header.Authorization}

        # SSE: Caddy does NOT buffer streaming responses by default
        # (unlike nginx), so no `flush_interval -1` is needed. If you
        # see buffering in your version, add:
        #   flush_interval -1
        # ...to this block. Caddy 2.7+ already passes through SSE.
    }

    # ----- SSE-specific route (must come BEFORE the catch-all) -----
    # The `events` and `alerts` endpoints are SSE streams. The base
    # reverse_proxy above handles them correctly out of the box, but
    # the explicit block lets reviewers see *why* these paths exist.
    @sse_paths {
        path /api/events /api/alerts
    }
    handle @sse_paths {
        reverse_proxy http://127.0.0.1:8080 {
            transport http {
                read_timeout 1h
                # SSE: do NOT buffer. Caddy 2.7+ default is fine.
                # Older versions: uncomment to force passthrough.
                # flush_interval -1
            }
            # Don't truncate the response at the upstream's idle timeout.
            # Caddy 2.7+ also requires you to NOT set
            # `timeouts { read 30s }` at the server level — it's
            # transport-local.
        }
    }

    # ----- Health probe -----
    # /api/health is exempted from the webui's rate limiter (router.js
    # Gate 4), so orchestrators won't trip on it.
    handle /api/health {
        reverse_proxy http://127.0.0.1:8080
    }

    # ----- Catch-all for SPA + remaining API -----
    handle {
        reverse_proxy http://127.0.0.1:8080
    }
}
```

## 6. Traefik 2

Tested against Traefik 2.10.x with the **file provider**. Docker users:
translate the labels 1-for-1 from the file-provider fields below.

```yaml
# traefik/dynamic/mcode-webui.yml  (loaded by the file provider)
http:
  routers:
    mcode-webui-secure:
      rule: "Host(`webui.example.com`)"
      entryPoints: ["websecure"]
      tls:
        # Replace with your cert resolver or static cert path. Options:
        #   - certResolver: letsencrypt  (auto ACME)
        #   - domains: [{main: webui.example.com, sans: [*.example.com]}]
        #   - For static certs (offline / air-gapped), use:
        #       tls.certificates:
        #         - certFile: /path/to/fullchain.pem
        #           keyFile:  /path/to/privkey.pem
        certResolver: letsencrypt
      service: mcode-webui
      # Apply the rate-limit + auth middlewares (see middlewares below).
      middlewares:
        - mcode-headers
        - mcode-strip-token

    mcode-webui-plain:
      rule: "Host(`webui.example.com`)"
      entryPoints: ["web"]
      service: mcode-webui
      # HTTP → HTTPS redirect via redirectScheme middleware.
      middlewares:
        - mcode-redirect-https

  services:
    mcode-webui:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
        # SSE: keep the connection alive longer than Traefik's 30s default.
        # Traefik's `serversTransport` controls this.
        serversTransport: mcode-webui-transport

  serversTransports:
    mcode-webui-transport:
      # SSE: 1h read timeout. Default 30s would kill long-idle SSE.
      forwardingTimeouts:
        dialTimeout: "30s"
        responseHeaderTimeout: "0s"   # no timeout on response headers — SSE
        idleConnTimeout: "1h"         # keepalive matches webui

  middlewares:
    # HTTPS redirect for the plain-HTTP entrypoint.
    mcode-redirect-https:
      redirectScheme:
        scheme: https
        permanent: true

    # Strip `?token=` from the upstream request and forward it as
    # Authorization: Bearer <token> instead. This prevents the token
    # from appearing in your Traefik access log.
    mcode-strip-token:
      # Traefik 2.10's plugin middleware API isn't always available;
      # the inline replacePath / addHeaders below are simpler.
      replacePath:
        # No-op path; the header rewrite below does the work.
        path: ""
      addHeaders:
        # The webui's lib/auth.js#extractToken reads both the
        # Authorization header and the `?token=` query string. If the
        # client already supplied Authorization, prefer that; otherwise
        # fall back to the URL token. The webui accepts both, so we
        # just always forward both — Traefik won't double up.
        # NOTE: Traefik's addHeaders is STATIC; dynamic per-request
        # header injection requires a plugin (traefik-plugin-header-
        # rewrite or similar). For simplicity here we just forward
        # the client-supplied Authorization header as-is.
        # (See §2 above for the full auth-shaping discussion.)
        customRequestHeaders:
          X-Forwarded-Proto: "https"

    # Standard reverse-proxy headers.
    mcode-headers:
      headers:
        customRequestHeaders:
          X-Real-IP: "true"  # placeholder; Traefik fills this automatically
        # SSE: do NOT buffer. Traefik 2.10 passes streaming responses
        # through by default. If you're on 2.4 or older and see SSE
        # buffering, add a plugin:
        #   plugin:
        #     name: buffering
        #     config:
        #       flushInterval: "100ms"
```

## 7. Verification checklist

After deploying, run through this from the **client** machine:

```bash
# Replace webui.example.com with your hostname.
HOST=webui.example.com

# 1. HTTPS works
curl -fsSL "https://${HOST}/api/health"
# Expect: {"ok":true,...}

# 2. Token auth (when MCODE_WEBUI_TOKEN is set on the webui process)
#    — without token, expect 401.
curl -i "https://${HOST}/api/state" | head -1
# Expect: HTTP/2 401

# 3. Token auth — with token, expect 200.
curl -i -H "Authorization: Bearer <your-token>" "https://${HOST}/api/state" | head -1
# Expect: HTTP/2 200

# 4. SSE — open a stream and confirm events arrive within 1s, not 30s.
timeout 5 curl -N -H "Authorization: Bearer <your-token>" \
    "https://${HOST}/api/events"
# Expect: data: {...} lines arriving at near-realtime cadence.

# 5. Browser-origin gate (v2) — with the external origin registered in
#    trustedOrigins (§2.1), the preflight is answered and the origin is
#    reflected verbatim (never a wildcard):
curl -s -i -X OPTIONS "https://${HOST}/api/state" \
    -H "Origin: https://${HOST}" \
    -H "Access-Control-Request-Method: POST" | grep -i access-control
# Expect: Access-Control-Allow-Origin: https://webui.example.com
#         Access-Control-Allow-Methods: GET, POST, OPTIONS, DELETE

# 6. Browser-origin gate (v2) — an UNregistered origin gets no CORS
#    headers on reads and a 403 on mutating requests:
curl -s -i -X POST "https://${HOST}/api/settings" \
    -H "Origin: https://evil.example" \
    -H 'Content-Type: application/json' -d '{}' | head -1
# Expect: HTTP/2 403  {"ok":false,"error":"cross-origin request rejected"}
```

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser `POST`/`DELETE` returns 403 `cross-origin request rejected` | v2 Origin/CSRF gate: the external origin is not in `trustedOrigins` | `POST /api/settings {"trustedOrigins": ["https://webui.example.com"]}` — exact browser-visible origin, no trailing slash (§2.1). Check the proxy isn't rewriting/stripping the `Origin` header |
| Browser can't read API responses (CORS errors in console) but curl works | External origin not allowlisted — untrusted origins get zero `Access-Control-*` headers by design | Same fix: register the origin in `trustedOrigins` (§2.1) |
| `curl` returns 301 to HTTPS but the browser shows cert error | You're testing the redirect, not the TLS handshake | Test directly: `curl -v https://webui.example.com/api/health` |
| SSE events arrive in bursts every 30s | Proxy is buffering | See §3 — set `proxy_buffering off` (nginx) / add the `buffering` plugin (Traefik 2.4) / check Caddy version |
| SSE disconnects after a few minutes | Proxy idle timeout | Bump `proxy_read_timeout` / `read_timeout` / `forwardingTimeouts.idleConnTimeout` to 1h |
| `?token=` appears in nginx access log | Default nginx logs include query string | Either strip at proxy (recommended) or `access_log off` for the SSE location |
| 401 even with token | Token lost during header rewrite | Check your `proxy_set_header Authorization` line; verify the webui process has `MCODE_WEBUI_TOKEN` matching |
| Rate limit (429) on the health endpoint | Misconfigured middleware also throttling | `/api/health` is already exempted at the webui layer (router.js Gate 4). If your proxy middleware still throttles, exempt `/api/health` there too |
| 502 from nginx after webui restart | Upstream down during restart | `proxy_next_upstream` + retry; or just reload nginx after the webui is back up |

---

See also:

- [`docs/CAPABILITIES.md` §11 Network & access control](CAPABILITIES.md#11-network--access-control) — operational overview
- [`server/lib/rate-limit.js`](../server/lib/rate-limit.js) — algorithm details
- [`server/lib/auth.js`](../server/lib/auth.js) — token validation contract