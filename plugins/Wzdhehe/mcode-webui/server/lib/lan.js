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
