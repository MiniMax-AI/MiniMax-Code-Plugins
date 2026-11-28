// SessionStart 注入的「索引」构建器。
//
// 补的是这个缺口：技能按需调用、开场**不会**自动加载 —— 新会话只说一句「继续」时接不上上下文。
// 这里把仓库的**待办账本**与**体量状态**在会话开场确定性推进上下文。
//
// 铁律：
//   1. **只读** —— 绝不写回 handoff.md 或任何文件。
//   2. **索引不是副本** —— 注入的是行号范围 + 标题摘要，正文永远靠 Read 回填。
//      这是 doc-protocol「单一权威载体」的延伸：本块是**指针**，不是第二份真值。
//   3. **fail-open** —— 任何异常退化成「不注入」，绝不阻塞会话。
//   4. **长度有天花板** —— 每会话都吃一次 token，必须有硬上限。
//
// 阈值来源：`<repo>/doc-budget.json` —— 与仓库里的 doc-protocol 体量闸脚本
// （`check-doc-budget.py --config`）**同一个文件**，单一真源。无该文件时退回
// BUDGET_DEFAULTS（值须与该脚本 DEFAULTS 相等，否则两处会漂移）。
//
// **零配置开箱即用**（v1.1.1）：仓库**不写** `entrypoints[]` 时，回退到内置约定集
// （`defaultSpecs`）—— 只要仓库里有账本载体文件（默认 `.agents/HANDOFF.md`，2026-11-28 起；
// 老仓库用 `doc-budget.json` 的 `ledger.path` 声明自己的位置），开场就自动注入
// 「待办账本索引 + 体量摘要」。要改或要关，才需要写配置：
//   - 显式写 `entrypoints: [...]` → 完全听配置；
//   - 显式写 `entrypoints: []`    → 明确关掉（「没写」≠「写空」）。
//
// ⚠️ 刻意**不判断** SessionStart 的 `source`（startup/resume/clear/compact）：
// 任何一次会话开始都该注入（compact 之后更需要），按 source 分流只会漏。源码实测
// payload 是 `{...e, ...别名}` 全量 spread，`source` 原样可读，但这里用不上。

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { readGuardrailsFile } from "./guard.mjs";

// ---------------------------------------------------------------------------
// 默认预算 —— 与 check-doc-budget.py 的 DEFAULTS 同值（只保留摘要用得到的字段）
// ---------------------------------------------------------------------------
export const BUDGET_DEFAULTS = {
  documents: [
    { id: "handoff", path: ".agents/HANDOFF.md", maxLines: 2000, maxBytes: 512000 },
    { id: "instructions", path: "AGENTS.md", maxBytes: 61440, maxInstructions: 150 },
  ],
  ledger: {
    path: ".agents/HANDOFF.md",
    // 与 python DEFAULTS 同值：from=null 表示「从第一个二级标题起」，
    // to 是**正则**（第一个日期段标题之前止）。
    // 2026-11-28 统一约定：交接文档集中 .agents/HANDOFF.md（可入库、跨 agent），与 python 同步改。
    from: null,
    to: "^##\\s+\\d{4}-\\d{2}-\\d{2}",
    maxBytes: 15360, // 15 KB
    maxLines: 40,
    maxItems: 30,
  },
};

const DEFAULT_MAX_ROWS = 20;
const DEFAULT_MAX_CHARS = 1800;
const HARD_MAX_CHARS = 4000;
const TOTAL_MAX_CHARS = 6000; // 多 entry 总上限（SessionStart 每会话一次，必须有天花板）
const TITLE_MAX_CHARS = 80;
const DEFAULT_STATUSES = ["🔴", "🟡", "⏳"];
const ALL_STATUS_MARKS = ["🔴", "🟡", "⏳", "✅", "❌"];

const ROW_RE = /^\s*\|.*\|\s*$/;
const SEP_RE = /^\s*\|[\s:|-]+\|\s*$/;
const HEADING_RE = /^#{1,6}\s/;

// 首尾 emoji / 空白剥离（u flag 必需，否则 \p{...} 不生效）
const EDGE_EMOJI_RE =
  /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+|[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+$/gu;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 只接受「仓库内相对路径」；绝对路径、盘符、含 `..` 一律拒绝。 */
function safeRelPath(file) {
  if (typeof file !== "string" || !file.trim()) return null;
  const f = file.trim().replace(/\\/g, "/");
  if (f.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(f)) return null;
  if (f.split("/").includes("..")) return null;
  return f;
}

/** 把相对路径钉在 root 内；越界返回 null。 */
function resolveInside(root, rel) {
  const safe = safeRelPath(rel);
  if (!safe) return null;
  const base = resolve(root);
  const abs = resolve(base, safe);
  const prefix = base.endsWith(sep) ? base : base + sep;
  if (abs !== base && !abs.startsWith(prefix)) return null;
  return abs;
}

function readText(abs) {
  if (!abs || !existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function sizeOf(abs) {
  try {
    const st = statSync(abs);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function posInt(v, dflt, min, max) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 超限倍数：≥2 倍给「超 N×」，否则只给「超」。 */
function overLabel(actual, limit) {
  if (!limit || actual <= limit) return null;
  const r = actual / limit;
  return r >= 2 ? `over ${Math.round(r)}x` : "over";
}

const fmtSize = (bytes) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

/**
 * 读 <repo>/doc-budget.json（阈值单一真源，与 python 脚本 `--config` 共用）。
 * 缺文件 / JSON 坏 / 形态非法 → 一律退回 BUDGET_DEFAULTS（fail-open）。
 */
export function loadBudgetConfig(root, rel = "doc-budget.json") {
  const text = readText(resolveInside(root, rel));
  if (text == null) return BUDGET_DEFAULTS;

  let parsed;
  try {
    // 剥掉 BOM：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
    // 带 BOM 的 JSON.parse 会抛错 → 阈值静默回退默认值，用户看不出哪里不对。
    parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return BUDGET_DEFAULTS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return BUDGET_DEFAULTS;

  const out = { ...BUDGET_DEFAULTS, ...parsed };
  if (!Array.isArray(out.documents) || out.documents.length === 0) out.documents = BUDGET_DEFAULTS.documents;
  if (!out.ledger || typeof out.ledger !== "object") out.ledger = BUDGET_DEFAULTS.ledger;
  else out.ledger = { ...BUDGET_DEFAULTS.ledger, ...out.ledger };
  return out;
}

/**
 * 内置约定集 —— 仓库**没有**显式 `entrypoints[]` 时的回退，本函数就是「开箱即用」的来源。
 *
 * 两条硬设计：
 *
 *  1. **不在这里重复定义阈值。** `file`/`from`/`to` 全部从 `loadBudgetConfig(root).ledger`
 *     派生（真源＝`<repo>/doc-budget.json`，无则 `BUDGET_DEFAULTS`）。在这个函数里再写一遍
 *     「handoff.md / 首个二级标题 / 首个日期标题」，就等于开了第二处真源 —— 正是 F2
 *     那种「两份实现靠注释互指防漂移」的翻版。
 *
 *  2. **全有或全无，以「账本载体存在」为唯一约定标志。** 载体文件不在 → 返回空，
 *     整个默认集不生效。为什么必须 gate：否则任何有 `AGENTS.md` 的仓库每会话都会多出
 *     一行体量摘要 —— 那是噪声，不是信号。doc-protocol 的约定标志恰恰是「有一个账本载体」。
 */
function defaultSpecs(root) {
  const led = loadBudgetConfig(root).ledger || {};
  const abs = resolveInside(root, led.path);
  if (!abs || !existsSync(abs)) return [];

  return [
    {
      id: "handoff-ledger",
      kind: "markdown-table",
      label: "Todo ledger",
      file: safeRelPath(led.path),
      from: typeof led.from === "string" && led.from ? led.from : null,
      to: typeof led.to === "string" && led.to ? led.to : null,
      statuses: DEFAULT_STATUSES.slice(),
      maxRows: DEFAULT_MAX_ROWS,
      maxChars: DEFAULT_MAX_CHARS,
      source: "convention",
    },
    { id: "budget", kind: "budget", label: "Document size", config: "doc-budget.json", source: "convention" },
  ];
}

/**
 * 解析「要注入什么」。三级裁定：
 *
 *   1. `entrypoints` 是数组（**含空数组**）→ 完全听配置的；空数组 = 明确关闭。
 *   2. 字段缺失 / 不是数组 → **回退内置约定集**（`defaultSpecs`）。开箱即用走这条。
 *   3. 内置集也拿不到东西（仓库里没有账本载体）→ 返回 null，即「什么都不注入」。
 *
 * ⚠️ 1 与 2 的区别是**刻意的**：「没写」不等于「写空」。写空是明确意图（关掉），
 * 没写是「用默认」。如果把空数组也当默认，用户就失去了关掉它的办法。
 *
 * 规范化裁定见 `normalizeEntry`：结构非法丢该条、可选字段非法回退默认值，都不抛错。
 */
export function loadEntrypoints(root) {
  const found = readGuardrailsFile(root);
  const raw = found ? found.parsed.entrypoints : undefined;

  if (Array.isArray(raw)) {
    const specs = [];
    for (const item of raw) {
      const spec = normalizeEntry(item);
      if (spec) specs.push({ ...spec, source: "config" });
    }
    return { specs, path: found ? found.path : null, explicit: true };
  }

  const specs = defaultSpecs(root);
  return specs.length ? { specs, path: null, explicit: false } : null;
}

function normalizeEntry(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;

  const id = typeof e.id === "string" && e.id.trim() ? e.id.trim() : null;
  if (!id) return null;

  const rawKind = e.kind == null ? "markdown-table" : e.kind;
  if (rawKind !== "markdown-table" && rawKind !== "budget") return null;
  const kind = rawKind;

  const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : id;

  if (kind === "budget") {
    return {
      id,
      kind,
      label,
      config: typeof e.config === "string" && e.config.trim() ? e.config.trim() : "doc-budget.json",
    };
  }

  const file = safeRelPath(e.file);
  if (!file) return null;

  return {
    id,
    kind,
    label,
    file,
    from: typeof e.from === "string" && e.from ? e.from : null,
    to: typeof e.to === "string" && e.to ? e.to : null,
    statuses:
      Array.isArray(e.statuses) && e.statuses.some((s) => typeof s === "string" && s)
        ? e.statuses.filter((s) => typeof s === "string" && s)
        : DEFAULT_STATUSES.slice(),
    maxRows: posInt(e.maxRows, DEFAULT_MAX_ROWS, 1, 200),
    maxChars: posInt(e.maxChars, DEFAULT_MAX_CHARS, 1, HARD_MAX_CHARS),
  };
}

// ---------------------------------------------------------------------------
// markdown 表格解析
// ---------------------------------------------------------------------------

/**
 * 把一个 `from` / `to` 串变成行匹配器。
 *
 * **正则优先，编译失败回退字面量前缀** —— 这样两类写法都能用：
 * 普通标题（`## 剩余未完成与遗留事项`）当字面量；脚本默认值那种锚定式
 * （`^##\s+\d{4}-\d{2}-\d{2}`）当正则。含未配对 `(` 的标题会编译失败 → 自动回退。
 */
function makeMatcher(s) {
  if (typeof s !== "string" || !s) return null;
  try {
    const re = new RegExp(s);
    re.test("");
    return (line) => re.test(line);
  } catch {
    return (line) => line.startsWith(s);
  }
}

const H2_RE = /^##\s/;

/** `from` 是标题时返回它的层级（`##` → 2）；不是标题则 null。 */
function headingLevel(s) {
  const m = /^(#{1,6})\s/.exec(s || "");
  return m ? m[1].length : null;
}

/**
 * 切区间。
 *
 * 语义必须与 check-doc-budget.py 的 `_ledger_region` 一致（否则 A14 立刻红）：
 *   - 配了 `to` → **只用 `to` 终止**（python 不再看标题）；
 *   - 没配 `to` → 遇到**同级或更高级**的标题行止；
 *   - `from` 缺失 → 账本写法取**第一个二级标题**，entrypoints 写法取第 0 行（见 opts）。
 *
 * ⚠️ 「同级或更高级」不是「任意标题」：真实账本的表格常挂在 `### 子分组` 之下
 * （如 stock-agent 的 `## 剩余未完成…` → `### 规划内剩余…` → 表格）。
 * 若按 `^#{1,6}\s` 截断，区间会在第一个 `###` 就结束 ⇒ **表格整个读不到**。
 * 所以按 `from` 自身的层级来定终止条件（§4.2「下一个同级标题」）。
 */
function sliceRegion(lines, spec, opts = {}) {
  const matchFrom = makeMatcher(spec.from);
  const matchTo = makeMatcher(spec.to);

  let start = 0;
  if (matchFrom) {
    const idx = lines.findIndex((l) => matchFrom(l));
    start = idx >= 0 ? idx : 0; // 找不到 → 从文件头（§4.2）
  } else if (opts.fromIsSecondLevelHeading) {
    const idx = lines.findIndex((l) => H2_RE.test(l));
    start = idx >= 0 ? idx : 0;
  }

  const lvl = headingLevel(spec.from);
  const stopRe = lvl ? new RegExp(`^#{1,${lvl}}\\s`) : HEADING_RE;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (matchTo) {
      if (matchTo(line)) {
        end = i;
        break;
      }
    } else if (stopRe.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function splitCells(line) {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// 完成行判定，与 check-doc-budget.py 的 `_is_completed_row` 同语义：
// 先剥掉行内反引号 span（span 里的 `~~` 是字面引用，不是删除线），再对整行找 `~~` ——
// 单个 `~~` 也算完成行。旧实现「成对 `~~` + 只查前两格」与 Python 三处不一致，已对齐。
const INLINE_CODE_RE = /`+[^`\n]*`+/g;

function isCompletedRow(line) {
  return line.replace(INLINE_CODE_RE, "").includes("~~");
}

/** 状态判定：先第 1 格、再第 2 格；同格内取出现位置最靠前的。 */
function findStatus(cells) {
  for (let i = 0; i < Math.min(cells.length, 2); i++) {
    const c = cells[i] || "";
    let best = null;
    for (const mark of ALL_STATUS_MARKS) {
      const at = c.indexOf(mark);
      if (at >= 0 && (best === null || at < best.at)) best = { mark, at, cell: i };
    }
    if (best) return best;
  }
  return null;
}

function cleanTitle(s) {
  const t = String(s || "")
    .replace(/~~/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(EDGE_EMOJI_RE, "")
    .trim();
  // 超长时截到 80 字并留省略号 —— 否则会在半个词上硬切（如 `docs/operations/recap-`）
  return t.length > TITLE_MAX_CHARS ? `${t.slice(0, TITLE_MAX_CHARS - 1)}…` : t;
}

/**
 * 标题取自**前两格里「剥掉状态符号后更长」的那一格**。
 *
 * 为什么不能写死格号：真实仓库里两种列序**并存** ——
 *   `| 🔴 **P4 T4a 修复**（…） | 待开工 | 说明 |`   ← 状态+事项**同格**，第 2 格是状态词
 *   `| 🔴 待办 | market_read 抽取 | 来源段 |`        ← 第 1 格只有状态词，事项在第 2 格
 * 取「更长者」对两种都成立（事项总比「待开工」「挂起」这类状态词长）。
 */
function titleOf(cells) {
  const a = cleanTitle(cells[0] || "");
  const b = cleanTitle(cells[1] || "");
  if (!b) return a;
  if (!a) return b;
  return b.length > a.length ? b : a;
}

/** ⏳ 日期抓 MM-DD 补本年度；早于今天 → 过期天数。年份是推断（末句已声明）。 */
function overdueDays(text, today) {
  const m = /(\d{2})-(\d{2})/.exec(text || "");
  if (!m) return 0;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return 0;
  const d = new Date(today.getFullYear(), mm - 1, dd);
  if (d.getMonth() !== mm - 1 || d.getDate() !== dd) return 0; // 非法日期如 02-30
  const diff = Math.floor((today - d) / 86400000);
  return diff > 0 ? diff : 0;
}

function rankOf(item) {
  if (item.mark === "🔴") return 0;
  if (item.mark === "⏳" && item.overdue > 0) return 1;
  if (item.mark === "🟡") return 2;
  return 3;
}

const SUMMARY_NOTE = "Read the body with the file-reading tool. This block is an index, not the source of truth; the year is inferred — the body wins.";

// 约定默认集额外声明来源 + 出口 —— 否则用户看到凭空出现的块会不知道从哪来的、也不知道怎么关。
const CONVENTION_NOTE = `${SUMMARY_NOTE} (Built-in convention; override it or switch it off with entrypoints[] in guardrails.json.)`;

function buildTableBlock(root, spec) {
  const abs = resolveInside(root, spec.file);
  const text = readText(abs);
  if (text == null) return null; // 文件不存在 / 读失败 → 无输出（§4.3-1）

  const lines = text.split(/\r?\n/);
  // `from` 缺省 = **第一个二级标题** —— 与 check-doc-budget.py 的 ledger 语义对齐
  // （buildBudgetBlock 的活账本行走的就是同一条 opts）。若不这样对齐，同一个
  // `from: null` 在「表格行」会从文件第 0 行起、在「账本行」却从首个 H2 起，
  // 两处算出两个区间。
  const { start, end } = sliceRegion(lines, spec, { fromIsSecondLevelHeading: !spec.from });
  const today = new Date();

  const items = [];
  let total = 0;
  let noStatus = 0;

  // 表头 = 紧挨着分隔行之前的那一行。它不是数据，必须跳过 ——
  // 否则「状态 | 事项 | …」会被当成一条无状态行，同时把 total 抬高 1。
  let headerIdx = -1;
  for (let i = start; i < end; i++) {
    if (SEP_RE.test(lines[i])) {
      headerIdx = i - 1;
      break;
    }
  }

  for (let i = start; i < end; i++) {
    if (i === headerIdx) continue;
    const line = lines[i];
    if (!ROW_RE.test(line) || SEP_RE.test(line)) continue;
    const cells = splitCells(line);
    if (cells.length === 0) continue;
    total += 1;

    // 完成行 → 丢弃（「未完成投影」不变量）。与 Python 同判**整行**：
    // `~~` 落在状态格、事项格、备注格都算，剥掉反引号 span 后单个 `~~` 也算。
    if (isCompletedRow(line)) continue;

    const st = findStatus(cells);
    if (!st) {
      noStatus += 1; // 一个状态符号都没有 → 丢，但计数（§4.3-6）
      continue;
    }
    // 有符号但不在 statuses 里（如 ✅）→ 静默丢弃，**不**计入「无状态」。
    if (!spec.statuses.includes(st.mark)) continue;

    const title = titleOf(cells);
    const overdue =
      st.mark === "⏳" ? overdueDays(`${cells[0] || ""} ${cells[1] || ""}`, today) : 0;
    items.push({ mark: st.mark, title, overdue, order: items.length });
  }

  if (items.length === 0) return null; // 无可列行 → 不发输出（别白吃 token）

  items.sort((a, b) => rankOf(a) - rankOf(b) || a.order - b.order); // 稳定：同级保原文序

  const kept = [];
  let used = 0;
  for (const it of items) {
    if (kept.length >= spec.maxRows) break;
    const tag = it.mark === "⏳" && it.overdue > 0 ? `⏳ overdue ${it.overdue}d` : it.mark;
    const lineText = `- [${tag}] ${it.title}`;
    if (used + lineText.length > spec.maxChars) break; // 整行丢弃，不切半行
    kept.push(lineText);
    used += lineText.length + 1;
  }

  const out = [`[entrypoints] ${spec.label} (${spec.file}:${start + 1}-${end}) — ${items.length} open item(s):`];
  out.push(...kept);

  if (kept.length < items.length || noStatus > 0) {
    const extra = noStatus > 0 ? `; ${noStatus} row(s) without a status symbol are not listed` : "";
    out.push(`(${total} row(s) total, ${kept.length} shown${extra})`);
  }
  out.push(spec.source === "convention" ? CONVENTION_NOTE : SUMMARY_NOTE);
  return out.join("\n");
}

function buildBudgetBlock(root, spec) {
  const cfg = loadBudgetConfig(root, spec.config);
  const parts = [];

  for (const doc of cfg.documents || []) {
    if (!doc || typeof doc !== "object" || typeof doc.path !== "string") continue;
    const abs = resolveInside(root, doc.path);
    const bytes = sizeOf(abs);
    if (bytes == null) continue;

    const name = basename(doc.path).replace(/\.md$/i, "");
    const text = readText(abs) || "";
    const lineCount = text ? text.split(/\r?\n/).length : 0;

    // 只在确实设了行数阈值时才显示行数（AGENTS.md 无 maxLines ⇒ 只报字节）
    const head = doc.maxLines ? `${name} ${lineCount} lines/${fmtSize(bytes)}` : `${name} ${fmtSize(bytes)}`;
    const flags = new Set(); // 去重：行数与字节都超时不该出现「(超, 超)」
    const byBytes = overLabel(bytes, doc.maxBytes);
    if (byBytes) flags.add(byBytes);
    const byLines = overLabel(lineCount, doc.maxLines);
    if (byLines) flags.add(byLines);
    const flagStr = [...flags].join(", ");
    parts.push(flagStr ? `${head}(${flagStr})` : head);
  }

  const led = cfg.ledger;
  if (led && typeof led.path === "string") {
    const text = readText(resolveInside(root, led.path));
    if (text != null) {
      const bytes = Buffer.byteLength(text, "utf-8");
      const lines = text.split(/\r?\n/);
      const { start, end } = sliceRegion(
        lines,
        { from: led.from ?? null, to: led.to ?? null },
        { fromIsSecondLevelHeading: true }, // 账本：from 缺省 = 第一个二级标题（与脚本一致）
      );
      let dead = 0;
      let regionBytes = 0;
      for (let i = start; i < end; i++) {
        // 与 python 的 `_bytes("\n".join(region))` 保持一致：行间有 \n，**末行不带**。
        regionBytes += Buffer.byteLength(lines[i], "utf-8");
        if (i < end - 1) regionBytes += 1;
        const line = lines[i];
        if (ROW_RE.test(line) && !SEP_RE.test(line) && isCompletedRow(line)) dead += 1;
      }
      // 死行是**硬违规**，不能因为「没超字节预算」就不报 —— 它单独出现时也要显示。
      const tail = [];
      const over = overLabel(regionBytes, led.maxBytes);
      if (over) tail.push(over);
      if (dead > 0) tail.push(`${dead} dead rows`);
      parts.push(`live ledger ${fmtSize(regionBytes)}${tail.length ? `(${tail.join(", ")})` : ""}`);
    }
  }

  if (parts.length === 0) return null;
  return `[entrypoints] Document size: ${parts.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 生成注入块（每 spec 一段）。任何单条出错都跳过该条，不影响其余（fail-open）。
 * 总长超 TOTAL_MAX_CHARS 时按顺序丢弃靠后的 entry。
 */
export function buildEntrypointBlocks(root, specs) {
  if (!Array.isArray(specs) || specs.length === 0) return [];

  const blocks = [];
  let total = 0;
  for (const spec of specs) {
    let text = null;
    try {
      text = spec.kind === "budget" ? buildBudgetBlock(root, spec) : buildTableBlock(root, spec);
    } catch {
      text = null;
    }
    if (!text) continue;
    if (total + text.length > TOTAL_MAX_CHARS) break;
    blocks.push(text);
    total += text.length + 1;
  }
  return blocks;
}

export { safeRelPath, resolveInside, sliceRegion };
