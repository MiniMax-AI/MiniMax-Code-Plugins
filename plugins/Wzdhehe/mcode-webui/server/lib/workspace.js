// webui/server/lib/workspace.js
// Workspace state + browsing helpers.

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_WORKSPACE } from "./config.js";
import { detectTuiCwd } from "./config.js";
import { pushStateFor } from "./state-bus.js";

// v0.5.al: per-cid 切换 workspace
// body: {dir, syncTui?, saveRecent?}
//   dir: 绝对路径（必须是存在的目录）
//   syncTui: true 时同时写 ~/.minimax/runtime/cwd.json（让 mcode TUI 也看到新 cwd）
//   saveRecent: true 时（默认 true）把 dir 加到 localStorage recents
export function handleWorkspaceChange(cs, cid, payload) {
  const action = payload.action || "set"; // 'set' | 'useTui' | 'reset' | 'detect'
  let target;
  if (action === "useTui") {
    target = detectTuiCwd();
    if (!target)
      return { ok: false, error: "mcode TUI 还没启动过，没有 cwd 记录" };
  } else if (action === "reset") {
    target = DEFAULT_WORKSPACE;
  } else if (action === "detect") {
    const tui = detectTuiCwd();
    return {
      ok: true,
      tuiCwd: tui,
      defaultWorkspace: DEFAULT_WORKSPACE,
      current: cs.workspace.dir,
      detectOnly: true,
    };
  } else {
    target = payload.dir;
  }
  if (!target || typeof target !== "string")
    return { ok: false, error: "dir 不能为空" };
  // 校验目录存在
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: `目录不存在: ${target}` };
  }
  const absDir = resolve(target);
  // 写到 cs
  cs.workspace = { dir: absDir, branch: null, tree: null };
  // 可选：同步 mcode TUI（写 cwd.json，下次 TUI 启动会看到新 cwd）
  if (payload.syncTui) {
    try {
      const cwdFile = join(homedir(), ".minimax", "runtime", "cwd.json");
      mkdirSync(dirname(cwdFile), { recursive: true });
      writeFileSync(
        cwdFile,
        JSON.stringify({ cwd: absDir, updatedAt: Date.now() }, null, 2),
        "utf8",
      );
    } catch (e) {
      console.warn(`[webui] sync cwd.json failed: ${e.message}`);
    }
  }
  pushStateFor(cid);
  return {
    ok: true,
    workspace: cs.workspace,
    tuiCwd: detectTuiCwd(),
    defaultWorkspace: DEFAULT_WORKSPACE,
  };
}

// v0.5.am: 列出目录下的子目录（仅目录，懒加载给前端树用）
// query: ?path=<absolute>  (省略时返回根盘符 / 根目录)
export function browseWorkspace(rawPath) {
  const MAX = 500; // 单层最多返回 500 个子目录，避免 huge dirs 把前端卡死
  let target,
    parent,
    roots = null;
  if (!rawPath) {
    // 没传 path → 返回根盘符（Windows: C:\ D:\ 等；其他: /）
    if (process.platform === "win32") {
      const found = [];
      for (let c = 65; c <= 90; c++) {
        const letter = String.fromCharCode(c) + ":\\";
        try {
          if (existsSync(letter) && statSync(letter).isDirectory())
            found.push(letter);
        } catch {}
      }
      if (found.length === 0) found.push("C:\\");
      roots = found;
      target = null;
    } else {
      target = "/";
    }
  } else {
    target = resolve(rawPath);
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      return { ok: false, error: `目录不存在: ${rawPath}` };
    }
    const parentPath = dirname(target);
    parent = parentPath === target ? null : parentPath;
  }
  const children = [];
  if (target) {
    let entries;
    try {
      entries = readdirSync(target, { withFileTypes: true });
    } catch (e) {
      return { ok: false, error: `无法读取: ${e.message}` };
    }
    const dirs = [];
    let skipped = 0;
    for (const ent of entries) {
      if (dirs.length >= MAX) {
        skipped++;
        continue;
      }
      try {
        if (ent.isDirectory()) {
          dirs.push({ name: ent.name, path: join(target, ent.name) });
        }
      } catch {
        skipped++;
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
    children.push(...dirs);
    return {
      ok: true,
      dir: target,
      parent,
      children,
      skipped,
      total: dirs.length,
    };
  } else {
    return { ok: true, dir: null, parent: null, roots, children: [] };
  }
}
