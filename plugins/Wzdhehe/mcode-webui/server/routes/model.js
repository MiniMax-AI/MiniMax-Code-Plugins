// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)

import { getBuiltinModelsFromMcode } from "../lib/models.js";
import { pushStateFor } from "../lib/state-bus.js";
import { DEFAULT_MODEL } from "../lib/config.js";
// v0.5.by: mcodePermissionToWebui / PERMISSION_MODES 仅用于 GET /api/permissions-modes 列合法值
//   (mid-session 修改不可用, 但 list 给前端 dropdown 还是有用的)
import { mcodePermissionToWebui, PERMISSION_MODES } from "../lib/mcode-rpc.js";

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

// GET /api/models
export function handleGetModels(_req, res, ctx) {
  const cs = ctx.cs;
  const list = [];
  const builtins = getBuiltinModelsFromMcode();
  const currentName = (cs.model && cs.model.name) || "";
  const currentProvider = currentName.includes("/")
    ? currentName.split("/")[0]
    : "minimax_api";
  for (const m of builtins) {
    list.push({
      id: `${currentProvider}/${m}`,
      label: m,
      provider: currentProvider,
    });
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      models: list,
      current: currentName || DEFAULT_MODEL,
      source: "mcode-cli-bundle",
    }),
  );
}

// POST /api/set-model — 只更新 cs.model
export async function handleSetModel(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const modelId = (payload.model || "").trim();
  if (!modelId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "model required" }));
  }
  cs.model = cs.model || {};
  cs.model.name = modelId;
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      model: modelId,
      note: "仅更新本地状态，mcode session 创建时会用此 model",
    }),
  );
}

// POST /api/permissions — v0.5.by 调整: mcode 0.1.5 acp 不支持 session/set_config_option
//   实测: mcode acp server 返 "Method not found" 给此方法
//   所以这里只更新本地 cs.permissions (用于 webui UI 显示), 不再尝试 RPC
//   真要改 mcode 端 permission mode: 重启 mcode 进程 + --permission 标志, 或者等 mcode 升级
// body: { mode: 'ask'|'auto'|'read'|'full' 或 mcode 原值 }
export async function handleSetPermissions(req, res, ctx) {
  const cs = ctx.cs;
  const cid = ctx.cid;
  const payload = await readJson(req);
  const webuiMode = (payload.mode || "full").toLowerCase();
  const label =
    webuiMode === "ask"
      ? "Ask"
      : webuiMode === "auto"
        ? "Auto"
        : webuiMode === "read"
          ? "Read"
          : webuiMode === "off"
            ? "Off"
            : "Full access";
  cs.permissions = label;
  pushStateFor(cid);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      permissions: label,
      mcodeSynced: false,
      note: "mcode 0.1.5 acp 不支持 mid-session 改 permissionMode (实测 probe 2026-08-20). 仅更新 webui UI, mcode 实际 mode 不变",
    }),
  );
}

// GET /api/permissions-modes — 列出 webui 4 标签 + mcode 6 原值, 供前端 dropdown
export function handleListPermissionModes(_req, res) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(
    JSON.stringify({
      ok: true,
      webui: [
        { value: "ask", label: "Ask", mcodeValue: "default" },
        { value: "auto", label: "Auto", mcodeValue: "auto" },
        { value: "read", label: "Read", mcodeValue: "read" },
        {
          value: "full",
          label: "Full access",
          mcodeValue: "bypassPermissions",
        },
      ],
      mcode: PERMISSION_MODES.map((v) => ({
        value: v,
        label: mcodePermissionToWebui(v),
      })),
    }),
  );
}

// POST /api/answer — legacy no-op (新 webui 走 /api/send)
export async function handleAnswer(req, res, _ctx) {
  const payload = await readJson(req);
  if (process.env.MCODE_USAGE_DEBUG)
    console.log(
      `[api.answer] type=${payload.type} option=${payload.option} (legacy, no-op)`,
    );
  res.writeHead(200, { "Content-Type": "application/json" });
  return res.end(
    JSON.stringify({
      ok: true,
      deprecated: true,
      note: "use /api/send for new flow",
    }),
  );
}
