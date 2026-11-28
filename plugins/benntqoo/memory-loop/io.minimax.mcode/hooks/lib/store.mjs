// 候选记录的读写与去重。全部同步 IO —— 钩子在 process.exit 前必须已经写完。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

/** 字段分隔符：用 NUL 而不是空格，避免 ("a","b c") 与 ("a b","c") 撞指纹。 */
const SEP = String.fromCharCode(0);

/**
 * 记录指纹，用于跨次运行去重。
 *
 * 用 signals + summary 前 200 字做哈希：candidates 里的 ts/session_id 每次都不同，
 * 但它们不是区分「内容」的字段，所以不能进指纹（否则永远去不了重）。
 */
export function fingerprint(rec) {
  const s = `${rec?.signals || ""}${SEP}${String(rec?.summary || "").slice(0, 200)}`;
  return createHash("sha1").update(s).digest("hex");
}

/** 读 jsonl。文件不存在返回 []，坏行跳过 —— 永不抛错。 */
export function readJsonl(path) {
  if (!existsSync(path)) return [];
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v); // 数组行也算坏行
    } catch {
      // 坏行跳过
    }
  }
  return out;
}

/** 追加写 jsonl（自动建目录）。返回实际写入条数，失败返回 0。 */
export function appendJsonl(path, records) {
  if (!records || records.length === 0) return 0;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    return records.length;
  } catch {
    return 0;
  }
}

/** 读小状态文件；不存在或损坏返回 fallback。 */
export function readState(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 写小状态文件（自动建目录）。失败静默 —— 状态丢了可以从零重建。 */
export function writeState(path, obj) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj), "utf-8");
    return true;
  } catch {
    return false;
  }
}
