// skill-forge —— 解析「当前项目的 skill 落点」
//
// 为什么单独成文件：Stop 与 SessionStart 两个钩子都要用同一套判定，
// 而这段逻辑里藏着一个必须显式挡掉的边界 ——
//
//   当工作区本身就是用户 home（cwd = C:\Users\<name>）时，
//   「项目级 .minimax/skills」= C:\Users\<name>\.minimax\skills。
//   此时若照推，等于打着「项目专属」的旗号把 skill 写进一个全局性的位置。
//
// 依据：MiniMax Code 的技能目录约定
//   用户级    <dataDir>/skills/            （所有 Agent 可见）
//   项目级    <repo>/.minimax/skills/      （当前工作区专属，随 git 走）
//
// ⚠️ 三个插件（skill-forge / memory-loop / project-guardrails）的标记表必须一致，
// 否则同一工作区会算出不同的「项目根」。改这里之前先看另外两份。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const MAX_UP = 40;

/** 归一化路径用于比较：统一分隔符、去尾斜杠；Windows 下忽略大小写。 */
export function normPath(p) {
  let s = resolve(String(p)).replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

/**
 * 项目根标记：`.git` / `.minimax` / `.agents` 同等权重，就近者赢。
 *
 * `.minimax` 是 MiniMax 的工作区标记（项目级 skills / hooks 都在这下面）；
 * `.agents` 是跨 agent 共享目录（配置与记忆载体），也当项目根。
 */
const ROOT_MARKERS = [".git", ".minimax", ".agents"];

/**
 * 从 start 向上找项目根：**最近的标记获胜**，三个标记同等权重。
 * 一个都找不到则回退 start 本身。
 *
 * 为什么是「就近」而不是「`.git` 绝对优先」：工作区里越深的 `.minimax/skills`
 * 优先级越高，若让高位的 `.git` 越过低位自带的 `.minimax`，算出的落点就会跟
 * 运行时实际读取的位置不一致 —— 文件写了却不生效。
 */
export function findProjectRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < MAX_UP; i++) {
    if (ROOT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

/**
 * 用户级 skills 目录 —— 只能用作**防撞**判据，绝不作为写入目标。
 *
 * 本地插件的根目录是 <dataDir>/plugins/<名>，所以往上两级就是 dataDir；
 * 只有当父目录名确实是 "plugins" 时才认，否则返回 null（不猜）。
 */
export function userSkillsDir() {
  const root = process.env.PLUGIN_ROOT || process.env.MINIMAX_PLUGIN_ROOT;
  if (!root || !root.trim()) return null;
  const pluginsDir = dirname(resolve(root.trim()));
  if (basenameOf(pluginsDir) !== "plugins") return null;
  return join(dirname(pluginsDir), "skills");
}

function basenameOf(p) {
  const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/**
 * 算出本次会话应当使用的 skill 落点。
 *
 * @param {string} cwd 钩子 payload 里的 cwd（可空，回退 process.cwd()）
 * @returns {{root: string, skillsDir: string, isUserLevel: boolean}}
 *   skillsDir   绝对路径，写文件用这个
 *   isUserLevel true 表示落点与用户级目录重合 —— 调用方应放弃推送
 */
export function resolveSkillTarget(cwd) {
  const start = cwd && String(cwd).trim() ? String(cwd) : process.cwd();
  const root = findProjectRoot(start);
  const skillsDir = join(root, ".minimax", "skills");

  const isHome = normPath(root) === normPath(homedir());
  const userDir = userSkillsDir();
  const collides = userDir ? normPath(skillsDir) === normPath(userDir) : false;

  return {
    root,
    skillsDir,
    isUserLevel: isHome || collides,
  };
}
