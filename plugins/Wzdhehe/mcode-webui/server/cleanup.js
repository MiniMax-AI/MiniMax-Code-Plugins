// webui/server/cleanup.js
// Background timers / startup hooks.

import { cleanupEmptyDefaultSessions } from "./lib/sessions.js";
import { ensureMcodeCommands } from "./lib/acp-client.js";

// 启动时一次性清理：默认名 session（24h 以上未用的）
export function runStartupCleanup() {
  cleanupEmptyDefaultSessions();
  // 启动后 5 秒触发 mcode commands cache（lazy init，第一次 /help 时会再触发）
  setTimeout(() => {
    ensureMcodeCommands().catch(() => {});
  }, 5000);
}
