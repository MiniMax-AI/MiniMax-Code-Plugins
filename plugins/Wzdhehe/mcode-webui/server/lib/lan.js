// webui/server/lib/lan.js
// LAN IP detection + local request check.

import { networkInterfaces } from "node:os";

// 检测本机局域网 IPv4（取第一个非 internal 的 IPv4）
export function detectLanIp() {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return "127.0.0.1";
}

export const LAN_IP = detectLanIp();

// 判断请求是否来自本机（IPv4 / IPv6 loopback）
export function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === LAN_IP
  );
}

// -----------------------------------------------------------------------
// v2 security fix (PR #55 review point 1): browser-Origin trust surface.
//
// isLocalRequest() above classifies loopback (and this host's LAN_IP)
// as "local", which feeds the token bypass in auth.js. That is correct
// for socket identity — curl on 127.0.0.1 is the operator — but it
// must NEVER double as a browser-origin exemption: a page on
// evil.com targeting http://127.0.0.1:8080 also arrives from a
// loopback socket. The functions below give router.js a separate,
// Origin-header-based trust set so the two dimensions stay distinct:
//   - socket identity (isLocalRequest) → token bypass
//   - browser origin (buildTrustedOrigins) → CORS reflection + CSRF gate
// All pure: parameters in, Set out. No fs / env / network access.
// -----------------------------------------------------------------------

// Normalize a request's Origin header for comparison. Returns the
// trimmed, lowercased serialization, or "" when absent/non-string.
// NOTE: this deliberately does NOT validate the shape — `Origin: null`
// (sandboxed iframe) must stay "present but untrusted", not collapse
// to "absent" (which would exempt it from the mutating-request gate).
export function normalizeOriginHeader(v) {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase();
}

// Is this bind host loopback-only? Anything else (0.0.0.0, a LAN IP,
// a hostname) means the socket is reachable from the network.
export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// Build the set of origins this server trusts for CORS reflection and
// the browser CSRF gate:
//   - the server's own serving origins (loopback v4/v6 + localhost),
//     always — the SPA itself lives there and its same-origin POSTs
//     carry an Origin header that must pass;
//   - the LAN address origin, only while LAN sharing is enabled
//     (the SPA served over the LAN IP is still our own code);
//   - `extra`: the explicit trustedOrigins allowlist from settings
//     (already sanitized at write time; re-normalized defensively).
// Default-port elision: on port 80/443 browsers serialize origins
// without an explicit port, so both forms are included.
export function buildTrustedOrigins({ port, lanBroadcast, lanIp = LAN_IP, extra } = {}) {
  const p = Number(port) || 0;
  const set = new Set();
  const add = (scheme, host) => {
    set.add(`${scheme}://${host}:${p}`);
    if ((scheme === "http" && p === 80) || (scheme === "https" && p === 443)) {
      set.add(`${scheme}://${host}`);
    }
  };
  add("http", "127.0.0.1");
  add("http", "localhost");
  add("http", "[::1]");
  if (lanBroadcast && typeof lanIp === "string" && lanIp && lanIp !== "127.0.0.1") {
    add("http", lanIp.includes(":") ? `[${lanIp}]` : lanIp);
  }
  if (Array.isArray(extra)) {
    for (const raw of extra) {
      const v = normalizeOriginHeader(raw);
      if (v) set.add(v);
    }
  }
  return set;
}
