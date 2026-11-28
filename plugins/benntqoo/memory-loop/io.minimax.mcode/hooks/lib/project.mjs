// memory-loop —— 从 cwd 解析「这次会话作用在哪个项目」+ 记忆载体落点。
//
// 必须从 payload 的 cwd 现算 —— 插件是全局生效的，写死路径必错。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MAX_UP = 40;

/** 路径归一化，仅用于比较：统一分隔符、去尾斜杠、Windows 下忽略大小写。 */
export function normPath(p) {
  if (!p) return "";
  let s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

/**
 * 项目根标记：`.git` / `.minimax` / `.agents` 同等权重，就近者赢。
 *
 * ⚠️ 三个插件（skill-forge / memory-loop / project-guardrails）的标记表必须一致，
 * 否则同一工作区会算出不同的「项目根」—— candidates / skills 与 guardrails 规则
 * 落进不同目录。改这里之前先看另外两份。
 */
const ROOT_MARKERS = [".git", ".minimax", ".agents"];

/** 从 start 向上找项目根：**就近的标记赢**，三个标记同等权重。 */
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
 * 会话的项目上下文。
 *
 * isHome=true 表示算出来的根与 home 重合 —— 调用方**必须放弃**，
 * 否则会以「项目专属」之名写到用户级目录里去。
 *
 * memoryDir：默认 `<root>/.agents/memory`（`.agents` 可入库、跨 agent 共享，
 * 记忆随 git 同步）。仓库可用 guardrails.json 的 `memory.dir` 覆盖。
 */
export function resolveProject(cwd) {
  const start = cwd && String(cwd).trim() ? String(cwd) : process.cwd();
  const root = findProjectRoot(start);
  return {
    root,
    isHome: normPath(root) === normPath(homedir()),
    memoryDir: join(root, readMemoryDirOverride(root) ?? join(".agents", "memory")),
  };
}

/** memory.dir 覆盖声明的候选落点，与 project-guardrails 同表：.agents 优先，.minimax 回退。 */
const OVERRIDE_RELS = [".agents/guardrails.json", ".minimax/guardrails.json"];

/** 只接受仓库内相对路径；绝对、盘符、`..` 一律拒绝（与 project-guardrails safeRelPath 同语义）。 */
function safeRelPath(file) {
  if (typeof file !== "string" || !file.trim()) return null;
  const f = file.trim().replace(/\\/g, "/");
  if (f.startsWith("/") || /^[a-zA-Z]:/.test(f)) return null;
  if (f.split("/").includes("..")) return null;
  return f;
}

/**
 * 读仓库对 memory 载体的覆盖声明（guardrails.json 的 `memory.dir`）。
 * 无文件 / JSON 坏 / 字段非法 → null 回退默认 —— fail-open：
 * 这是用户自己写的项目配置，读不到就当没配，绝不因配置写错而停摆。
 */
function readMemoryDirOverride(root) {
  for (const rel of OVERRIDE_RELS) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      // 剥掉 BOM：带 BOM 的 JSON.parse 会抛错 → 覆盖声明被静默忽略。
      parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const dir = safeRelPath(parsed.memory?.dir);
    if (dir) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 命令行入口 —— 蒸馏技能经此取路径与推进游标。
//
// 为什么技能不自己拼路径：技能正文是 markdown，路径写进去就是**第二份真源**，
// 与本文件的钩子逻辑必然漂移。历史上实际发生过：钩子已迁 `.agents/memory`，
// 技能仍读写旧目录 ⇒ 钩子写进去的候选技能一条也读不到，蒸馏静默失效。
// 所以路径、memory.dir 覆盖、游标文件名一律只在本文件定义，技能只调这里。
//
//   node <plugin>/hooks/lib/project.mjs status   → 打印 JSON {root, memoryDir, candidates, distilled, pending}
//   node <plugin>/hooks/lib/project.mjs commit   → 把蒸馏游标推进到当前候选总行数，打印同上 JSON
//
// 两个子命令都是 fail-open：任何异常输出 `{error}` 并 exit 1，绝不静默成功。
// ---------------------------------------------------------------------------

/** 候选总行数；文件缺失返回 0。坏行不计（与 store.readJsonl 同语义）。 */
function countLines(file) {
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function cliState(ctx) {
  const candidates = countLines(join(ctx.memoryDir, "candidates.jsonl"));
  let distilled = 0;
  try {
    const raw = readFileSync(join(ctx.memoryDir, "state.json"), "utf-8");
    const v = JSON.parse(raw)?.distilled;
    distilled = Number.isInteger(v) && v >= 0 ? v : 0;
  } catch {
    distilled = 0;
  }
  return {
    root: ctx.root,
    memoryDir: ctx.memoryDir,
    candidates,
    distilled,
    pending: Math.max(candidates - distilled, 0),
  };
}

export function main(argv = process.argv.slice(2)) {
  const sub = argv[0];
  try {
    const ctx = resolveProject(argv[1]); // 可选第二参 = cwd；缺省 process.cwd()
    if (ctx.isHome) throw new Error("cwd resolved to the home directory — home is not a project; refusing to operate (prevents writing project memory into a global directory)");
    if (sub === "status") return cliState(ctx);
    if (sub === "commit") {
      mkdirSync(ctx.memoryDir, { recursive: true });
      const st = cliState(ctx);
      writeFileSync(
        join(ctx.memoryDir, "state.json"),
        JSON.stringify({ distilled: st.candidates, updatedAt: new Date().toISOString() }),
        "utf-8",
      );
      return cliState(ctx);
    }
    throw new Error(`Unknown subcommand: ${sub ?? "(empty)"} — only status and commit are supported`);
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

// 仅当「本文件被直接执行」时才跑 CLI；被 import 时不产生副作用。
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const out = main();
  console.log(JSON.stringify(out));
  process.exit(out.error ? 1 : 0);
}
