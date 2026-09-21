// webui/server/lib/interaction/permission-presets.js
// Per-session permission mode presets. Replaces the inline label
// mapping previously inlined in routes/model.js#handleSetPermissions.
// Closes the permission-presets seam from BORROW-dsh-deepseek-harness
// 2026-08-28 § 3.
//
// The module owns three things:
//   1. PERMISSION_PRESETS  — the canonical list of named presets.
//   2. webuiModeToLabel    — pure: mode string → display label.
//   3. applyPermissionPreset — cs+cid mutator that routes through
//                              state-bus.pushStateFor (no direct SSE).

import { pushStateFor } from "../state-bus.js";

// Named permission presets (webui-side). Each entry maps to:
//   id:         the wire-format id accepted by handleSetPermissions
//   label:      display label shown in the webui UI
//   mcodeValue: the corresponding mcode session permission mode value
//               (informational — mcode 0.1.5 acp does not support
//                mid-session changes; see routes/model.js:99)
export const PERMISSION_PRESETS = [
  { id: "ask",  label: "Ask",         mcodeValue: "default" },
  { id: "auto", label: "Auto",        mcodeValue: "auto" },
  { id: "read", label: "Read",        mcodeValue: "read" },
  { id: "full", label: "Full access", mcodeValue: "bypassPermissions" },
  { id: "off",  label: "Off",         mcodeValue: "off" },
];

// getPermissionPreset — look up a preset by id (case-insensitive).
// Returns undefined when id is unknown or falsy.
export function getPermissionPreset(id) {
  if (!id) return undefined;
  const norm = String(id).toLowerCase();
  return PERMISSION_PRESETS.find((p) => p.id === norm);
}

// webuiModeToLabel — pure: map a webui mode string to its display label.
//   Preserves the original fallback behavior (unknown → "Full access")
//   so handleSetPermissions' response payload stays byte-identical.
export function webuiModeToLabel(mode) {
  const m = String(mode || "full").toLowerCase();
  if (m === "ask") return "Ask";
  if (m === "auto") return "Auto";
  if (m === "read") return "Read";
  if (m === "off") return "Off";
  return "Full access";
}

// applyPermissionPreset — set cs.permissions to the preset's label
// and push the new state via state-bus. Returns the applied label,
// or null when the preset id is unknown (caller decides response).
export function applyPermissionPreset(cs, cid, presetId) {
  const preset = getPermissionPreset(presetId);
  if (!preset) return null;
  cs.permissions = preset.label;
  pushStateFor(cid);
  return preset.label;
}