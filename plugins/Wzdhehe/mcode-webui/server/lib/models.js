// webui/server/lib/models.js
// Builtin model extraction from mcode cli.js bundle + context limit lookup.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { MCODE_ROOT } from "./config.js";

// v0.5.bj: 启动时从 mcode 的 cli.js bundle 里提取 hardcoded 的 MiniMax-M* 模型列表
// （用户 TUI 显示的 model 候选项就是这一份，mcode 内部硬编码 — 我们从 mcode 自己的 bundle 读，不在 webui 硬编码）
let CACHED_BUILTIN_MODELS = null;

function findCliEntry() {
  // mcode.ps1 里有 cliEntry = Join-Path $basedir "..."
  const mcodePs1 = join(MCODE_ROOT, "mcode.ps1");
  if (!existsSync(mcodePs1)) return null;
  try {
    const ps1 = readFileSync(mcodePs1, "utf-8");
    const m = ps1.match(/cliEntry\s*=\s*Join-Path\s+\$basedir\s+"([^"]+)"/);
    if (m) return join(MCODE_ROOT, m[1]);
  } catch {}
  return null;
}

export function getBuiltinModelsFromMcode() {
  if (CACHED_BUILTIN_MODELS !== null) return CACHED_BUILTIN_MODELS;
  try {
    // v0.5.bj: 优先用 MCODE_ROOT（跟 MCODE_CMD 同源），fallback 默认路径
    let cliEntry = findCliEntry();
    if (!cliEntry || !existsSync(cliEntry)) {
      console.log("[models] cli.js not found, fallback empty");
      CACHED_BUILTIN_MODELS = [];
      return [];
    }
    const content = readFileSync(cliEntry, "utf-8");
    // 匹配 MiniMax-M* 形式（带或不带 -highspeed 等后缀）
    const re = /MiniMax-M[0-9][a-z0-9.-]*/g;
    const found = new Set();
    let m;
    while ((m = re.exec(content)) !== null) found.add(m[0]);
    CACHED_BUILTIN_MODELS = [...found].sort().reverse(); // M3 排前
    console.log(
      "[models] extracted from cli.js:",
      CACHED_BUILTIN_MODELS.length,
      "models",
    );
    return CACHED_BUILTIN_MODELS;
  } catch (e) {
    console.error("[models] extract failed:", e.message);
    CACHED_BUILTIN_MODELS = [];
    return [];
  }
}

// v0.5.bx-10: model 真实 context limit — 从 mcode cli.js bundle 硬编码提取
//   数据源: cli.js h7i={"MiniMax-M3":{limit:{context:512e3,...}}, "MiniMax-M2.7":{limit:{context:2e5,...}}}
//   mavis 不知道 model context, webui 必须自己查 (避免硬编码漂移)
//   输入: 'minimax_api/MiniMax-M3' 或 'MiniMax-M3', 输出: 512000 / 200000 / 0(unknown)
const MCODE_MODEL_LIMITS = {
  "MiniMax-M3": 512000,
  "MiniMax-M2.7": 200000,
  "MiniMax-M2.7-highspeed": 200000,
  // 兜底: 128k, 200k, 512k 几个常见值
};
export function getMcodeModelLimit(modelFullName) {
  if (!modelFullName) return 0;
  // 'minimax_api/MiniMax-M3' → 'MiniMax-M3'
  const short = modelFullName.includes("/")
    ? modelFullName.split("/").pop()
    : modelFullName;
  if (MCODE_MODEL_LIMITS[short]) return MCODE_MODEL_LIMITS[short];
  // 模糊匹配: MiniMax-M2.7-highspeed 应该匹配 M2.7 的 200k
  for (const k of Object.keys(MCODE_MODEL_LIMITS)) {
    if (short.startsWith(k) || k.startsWith(short))
      return MCODE_MODEL_LIMITS[k];
  }
  return 0;
}
