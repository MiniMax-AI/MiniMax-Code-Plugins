// webui/server/lib/settings.js
// Runtime-tunable settings (currently just LAN broadcast toggle).

import { PORT, HOST } from "./config.js";
import { LAN_IP } from "./lan.js";
import { MCODE_CMD, DEFAULT_WORKSPACE, DEFAULT_MODEL } from "./config.js";

// v0.5.ap: 局域网访问设置 — 运行时可切换（per-server）
// 状态从 /api/settings GET 获取；POST /api/settings {lanBroadcast: bool} 修改
// 关闭时：拒绝所有非本地 IP 的请求，返 403 + 提示页
let lanBroadcastEnabled = true;

export function getLanBroadcast() {
  return lanBroadcastEnabled;
}

export function setLanBroadcast(v) {
  lanBroadcastEnabled = !!v;
  console.log(
    `[webui] LAN access ${lanBroadcastEnabled ? "enabled" : "disabled"}`,
  );
}

// LAN 拒绝页面（浏览器请求返 HTML，API 请求返 JSON）
const LAN_REJECT_HTML = (
  remoteIp,
) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>webui — 局域网访问已关闭</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 560px; margin: 80px auto; padding: 24px; color: #333; line-height: 1.6; }
h1 { color: #c0392b; margin-top: 0; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
.box { background: #fef9e7; border-left: 4px solid #f1c40f; padding: 14px 18px; border-radius: 4px; margin: 20px 0; }
</style></head><body>
<h1>🚫 局域网访问已关闭</h1>
<p>本 webui 当前<strong>仅允许本机访问</strong>，你的设备（<code>${remoteIp || "远程"}</code>）不在白名单内。</p>
<div class="box"><strong>如何开启：</strong><br>在本机浏览器打开 <code>http://127.0.0.1:7890/</code> → 左下角点"设置" → 开启"局域网访问"</div>
<p>或者直接用本机 URL：<code>http://127.0.0.1:7890/</code></p>
</body></html>`;

export function rejectLan(res, pathname, remoteIp) {
  const isApi = pathname.startsWith("/api/");
  const isSettings = pathname === "/api/settings"; // 让用户能远程切回
  if (isSettings) return false;
  if (isApi) {
    res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: false,
        error: "LAN 访问已关闭。在本机打开设置开启。",
      }),
    );
    return true;
  }
  res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
  res.end(LAN_REJECT_HTML(remoteIp));
  return true;
}

export function getSettingsSnapshot() {
  return {
    ok: true,
    lanBroadcast: lanBroadcastEnabled,
    port: PORT,
    host: HOST,
    lanIp: LAN_IP,
    lanUrl: `http://${LAN_IP}:${PORT}`,
    localUrl: `http://127.0.0.1:${PORT}`,
    mcodeCmd: MCODE_CMD,
    mcodeVersion: "0.1.2",
    defaultWorkspace: DEFAULT_WORKSPACE,
    defaultModel: DEFAULT_MODEL,
  };
}
