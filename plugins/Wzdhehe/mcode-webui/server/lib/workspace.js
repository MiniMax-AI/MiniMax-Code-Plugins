// webui/server/lib/workspace.js
// Workspace state + browsing helpers.

import {
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
  sep,
  delimiter,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { DEFAULT_WORKSPACE } from "./config.js";
import { detectTuiCwd } from "./config.js";
import { pushStateFor } from "./state-bus.js";

// -----------------------------------------------------------------------
// v2 security (PR #55 review point 5): workspace containment.
// 之前 handleWorkspaceChange / browseWorkspace 接受任意绝对路径 — 任何能过
// 鉴权的浏览器客户端都能把工作区设到主机上任意目录（mcode 会在那里以服务
// 进程身份跑），browse 还能枚举任意目录内容。现在引入"允许根"（allowed
// roots）边界：
//   1. 候选路径 resolve 后必须再经 realpathSync（解析全部软链）落在某个
//      允许根之内才可用。目录穿越（../）在 resolve 归一时折回真实位置、
//      软链逃逸在 realpath 时暴露 — 两者最终都撞在 containment 检查上被
//      拒，并给出可行动错误（列出允许根 + 扩展方法）。
//   2. 允许根来源 = 最小配置面（不进 settings/config — 那是其他模块的领
//      地）：env MCODE_WEBUI_WORKSPACE_ROOTS，系统路径分隔符分段（POSIX
//      ":" / Windows ";"）。设置后【完全替换】默认面，可收窄可扩宽。
//      未设置时的默认面 = 用户主目录 + 现配默认工作区（MCODE_WORKSPACE /
//      TUI cwd.json / homedir 三源之一，见 config.js DEFAULT_WORKSPACE）
//      + 系统 tmp 目录 — 即现状默认行为的全部合法落点（默认工作区兜底就
//      是 home；scratch 工作区惯例在 tmp），默认行为不破坏。
//   3. 已知残余（诚实申报）: 存进 cs.workspace.dir 的是 resolve() 形而非
//      realpath 归一形（保持既有行为与测试兼容）；若校验通过后软链被改
//      指向允许根外，存在残余窗口 — 但远窄于修复前的"任意目录"。
const WORKSPACE_ROOTS_ENV = "MCODE_WEBUI_WORKSPACE_ROOTS";

// 允许根列表（realpath 归一、去重、只收存在的目录）。每次调用现读 env，
// 测试与运维都能即时改面，无缓存失效问题。
export function getAllowedWorkspaceRoots() {
  const fromEnv = process.env[WORKSPACE_ROOTS_ENV];
  const candidates = [];
  if (fromEnv && fromEnv.trim()) {
    for (const p of fromEnv.split(delimiter)) {
      const t = p.trim();
      if (t) candidates.push(resolve(t));
    }
  } else {
    candidates.push(homedir(), DEFAULT_WORKSPACE, tmpdir());
  }
  const roots = [];
  for (const c of candidates) {
    let real;
    try {
      real = realpathSync(c);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue; // 不存在/不可解析的根直接跳过，不 fatal
    }
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

// dir 是否位于 root 内（含 root 本身）。用 relative() 而非字符串前缀：
// ".."-开头或跨盘绝对路径都判外；`..${sep}` 前缀写法不会误杀 "..foo" 这类
// 合法目录名。
function isWithinRoot(root, dir) {
  const rel = relative(root, dir);
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function containmentError(absDir, realDir, roots) {
  const via = realDir === absDir ? "" : `（软链解析后为 ${realDir}）`;
  const rootsDesc = roots.length
    ? roots.join(" , ")
    : `（空 — 检查 ${WORKSPACE_ROOTS_ENV} 是否全部指向存在的目录）`;
  return (
    `工作区越界: ${absDir}${via} 不在任何允许根内。` +
    `允许根: ${rootsDesc}。` +
    `如需扩展请设置 ${WORKSPACE_ROOTS_ENV} 环境变量` +
    `（多个根用系统路径分隔符分段；设置后完全替换默认允许根）。`
  );
}

// 校验 absDir（resolve 后的绝对路径）：realpath 解析全部软链后必须落在
// 允许根内。返回 {ok:true, real, roots} 或 {ok:false, error, roots}。
function resolveWithinRoots(absDir) {
  const roots = getAllowedWorkspaceRoots();
  let real;
  try {
    real = realpathSync(absDir);
  } catch (e) {
    return {
      ok: false,
      roots,
      error: `无法解析路径 ${absDir}: ${e.message}`,
    };
  }
  for (const r of roots) {
    if (isWithinRoot(r, real)) return { ok: true, real, roots };
  }
  return { ok: false, roots, error: containmentError(absDir, real, roots) };
}

// v0.5.al: per-cid 切换 workspace
// body: {dir, syncTui?, saveRecent?}
//   dir: 绝对路径（必须是存在的目录，且落在允许根内 — v2 security）
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
  // v2 security: containment 校验（realpath 解软链后必须在允许根内）。
  // useTui/reset 的目标同样过闸 — 越界时给可行动错误而非静默放行。
  const contained = resolveWithinRoots(absDir);
  if (!contained.ok) return { ok: false, error: contained.error };
  // 写到 cs（保持 resolve() 形；containment 已由 realpath 校验通过）
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
// query: ?path=<absolute>  (省略时返回允许根列表)
// v2 security: 目录枚举与工作区同边界 — 只有落在允许根内的目录才可枚举；
//   省略 path 时的根视图只暴露允许根本身（之前 POSIX 枚举 "/" 全量子目录、
//   Windows 枚举盘符，等于对任意客户端开放目录枚举 oracle）。响应形状保持
//   兼容：POSIX 仍 dir:"/"，Windows 仍 dir:null + roots 数组；前端
//   public/app/events.js loadBrowse 对 data.roots 有现成分支。
export function browseWorkspace(rawPath) {
  const MAX = 500; // 单层最多返回 500 个子目录，避免 huge dirs 把前端卡死
  let target,
    parent,
    roots = null;
  if (!rawPath) {
    // 没传 path → 根视图 = 允许根（前端把它渲染为顶层节点）
    roots = getAllowedWorkspaceRoots();
    target = process.platform === "win32" ? null : "/";
    if (target) {
      const parentPath = dirname(target);
      parent = parentPath === target ? null : parentPath;
    } else {
      parent = null;
    }
    return { ok: true, dir: target, parent, roots, children: [] };
  }
  target = resolve(rawPath);
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: `目录不存在: ${rawPath}` };
  }
  // v2 security: 枚举前 containment 校验（realpath 解软链后必须在允许根内）
  const contained = resolveWithinRoots(target);
  if (!contained.ok) return { ok: false, error: contained.error };
  const parentPath = dirname(target);
  parent = parentPath === target ? null : parentPath;
  if (parent !== null && !resolveWithinRoots(parent).ok) {
    // 上级已在允许根外 → 导航到顶（前端 up 按钮不再引导越界请求）
    parent = null;
  }
  const children = [];
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
}
