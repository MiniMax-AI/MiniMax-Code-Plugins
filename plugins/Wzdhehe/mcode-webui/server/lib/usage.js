// webui/server/lib/usage.js
// mmx quota + usage queries.

import { spawn } from "node:child_process";
import { pushStateFor } from "./state-bus.js";

// v0.5.x → v0.5.y: /usage 改成直接调 mmx CLI（mmx quota show --output json），
// 完全不走 mcode exec/AI，拿到的是 mmx API 返回的真实结构化数据。
// 提取成 helper 让 /api/send (/usage slash)、/api/usage、/api/cmd /usage 三处都走同一份逻辑。
// 结果以 assistant 消息（● 前缀）的形式进 chat，不再隐藏（之前是 LLM fabrication 所以隐藏）。
export function mmxQuotaShow() {
  // mmx 在 Windows 上是 .ps1 shim，用 shell:true 让 cmd 自动解析
  return new Promise((resolve, reject) => {
    const child = spawn(
      "mmx",
      ["quota", "show", "--output", "json", "--no-color", "--quiet"],
      {
        windowsHide: true,
        shell: true,
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      reject(new Error("mmx quota show 超时（15s）"));
    }, 15000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(`mmx 启动失败：${e.message}（确认 mmx CLI 已安装并登录）`),
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(
            `mmx 退出码 ${code}：${(stderr || stdout).trim().slice(0, 200) || "无输出"}`,
          ),
        );
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(
          new Error(
            `mmx 返回非 JSON：${e.message}\nstdout: ${stdout.slice(0, 200)}`,
          ),
        );
      }
    });
  });
}

// v0.5.ai: /usage 改成 per-cid — 每个 webui tab 自己的 usage
export async function runUsageQuery(cs, cid) {
  try {
    const data = await mmxQuotaShow();
    const general =
      data.model_remains?.find((m) => m.model_name === "general") ||
      data.model_remains?.[0];
    if (general) {
      cs.usage.fiveHourPercent = general.current_interval_remaining_percent;
      cs.usage.weekly = `${general.current_weekly_remaining_percent}%`;
    }
    cs.usage.raw = JSON.stringify(data, null, 2);
    cs.usage.fetchedAt = Date.now();
    cs.usage.error = null;
  } catch (e) {
    cs.usage.fetchedAt = Date.now();
    cs.usage.error = String(e.message || e);
  }
  pushStateFor(cid);
  // 不写 chat，不 persistCurrentChat
}
