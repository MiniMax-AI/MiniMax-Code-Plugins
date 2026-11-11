// webui/test/lib-sessions-persist.test.js
// Unit tests for server/lib/sessions.js persistence boundaries (v2 hardening,
// PR #55 review point 5).
//
// Why this test exists: saveSessions used to rewrite the JSON file in place
// (non-atomic — a crash mid-write truncates it) and loadSessions silently
// treated parse failures as an empty DB, so the next load-modify-save wiped
// the user's real data. The fix: tmp-file + atomic rename, sync-write
// serialization (single-process assumption), and explicit corruption handling
// (quarantine copy + actionable error, original file never touched by load).
//
// These tests pin:
//   - save/load roundtrip and no .tmp leftovers
//   - corrupted JSON: [] returned, original bytes INTACT, quarantine copy
//     exists, error logged once (no spam on repeat loads)
//   - non-array root treated as corruption too
//   - corrupted DB + subsequent save: fresh DB lands, old bytes survive in
//     the quarantine copy (data-disappearance chain broken)
//   - cleanupEmptyDefaultSessions never overwrites a corrupted DB
//   - atomicity: stringify failure / tmp-write failure leave the DB untouched
//   - interleaved load-modify-save units never tear the file, never lose a
//     committed unit, and every intermediate read parses
//
// Module-load order note: SESSIONS_DB is computed by config.js at import
// time from MCODE_WEBUI_SESSIONS_DB, so the env var is set BEFORE the SUT's
// dynamic import (node --test gives each file its own process). No static
// SUT import in this file — that would hoist above the env assignment.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

let sessions;
let DIR;
let DB;

before(async () => {
  DIR = mkdtempSync(join(tmpdir(), "webui-sessdb-"));
  DB = join(DIR, "sessions.json");
  process.env.MCODE_WEBUI_SESSIONS_DB = DB;
  sessions = await import("../server/lib/sessions.js");
});

after(() => {
  try {
    chmodSync(DIR, 0o700); // 万一某用例中途失败没恢复
  } catch {}
  rmSync(DIR, { recursive: true, force: true });
});

function writeDbRaw(content) {
  writeFileSync(DB, content, "utf8");
}

function readDbRaw() {
  return readFileSync(DB, "utf8");
}

function quarantineFiles() {
  return readdirSync(DIR).filter((f) => f.includes(".corrupted-"));
}

function tmpLeftovers() {
  return readdirSync(DIR).filter((f) => f.endsWith(".tmp"));
}

// 每个损坏用例用不同长度内容 — (mtime,size) 备忘不会跨用例误命中
let corruptSeq = 0;
function writeCorruptedDb() {
  corruptSeq += 1;
  const content = `{"corrupted fixture #${corruptSeq}" is not json`.padEnd(
    20 + corruptSeq,
    " ",
  );
  writeDbRaw(content);
  return content;
}

describe("save/load roundtrip", () => {
  test("missing file loads as []", () => {
    assert.deepEqual(sessions.loadSessions(), []);
  });

  test("save → load roundtrip; no .tmp leftover after save", () => {
    const data = [{ id: "s1", title: "对话 1", chat: ["用户 hi"] }];
    sessions.saveSessions(data);
    assert.deepEqual(sessions.loadSessions(), data);
    assert.equal(readDbRaw(), JSON.stringify(data, null, 2));
    assert.deepEqual(tmpLeftovers(), []);
  });

  test("valid JSON with UTF-8 BOM still parses (v0.5.bx-5 regression pin)", () => {
    writeDbRaw("﻿" + JSON.stringify([{ id: "bom" }]));
    assert.deepEqual(sessions.loadSessions(), [{ id: "bom" }]);
  });
});

describe("corrupted DB — explicit outcome, never a silent empty store", () => {
  test("parse failure: [] returned, original bytes INTACT, quarantined once, error is actionable", (t) => {
    const corrupted = writeCorruptedDb();
    const errMock = t.mock.method(console, "error", () => {});
    let loaded;
    assert.doesNotThrow(() => {
      loaded = sessions.loadSessions();
    });
    assert.deepEqual(loaded, []);
    // 可行动错误: 指出损坏、隔离副本位置与恢复方法
    assert.equal(errMock.mock.callCount(), 1);
    const msg = String(errMock.mock.calls[0].arguments[0]);
    assert.ok(msg.includes("损坏"));
    assert.ok(msg.includes(".corrupted-"));
    assert.ok(msg.includes(DB), "error names the DB path");
    // 原文件原样保留（load 路径零写入）
    assert.equal(readDbRaw(), corrupted);
    // 隔离副本存在且字节一致；重复 load 不重复隔离、不刷屏
    sessions.loadSessions();
    assert.equal(errMock.mock.callCount(), 1);
    const q = quarantineFiles();
    assert.equal(q.length, 1);
    assert.equal(readFileSync(join(DIR, q[0]), "utf8"), corrupted);
  });

  test("non-array root treated as corruption (not a poison value)", (t) => {
    const content = '{"kind":"object","not":"an array"}';
    writeDbRaw(content);
    const errMock = t.mock.method(console, "error", () => {});
    assert.deepEqual(sessions.loadSessions(), []);
    assert.ok(
      String(errMock.mock.calls[0].arguments[0]).includes(
        "not a JSON array",
      ),
    );
    assert.equal(readDbRaw(), content);
    assert.equal(quarantineFiles().length >= 1, true);
  });

  test("corrupted → save fresh: new DB lands, old bytes survive in quarantine (no data disappearance)", () => {
    const corrupted = writeCorruptedDb();
    sessions.loadSessions(); // 触发隔离
    const qBefore = quarantineFiles();
    assert.equal(qBefore.length >= 1, true);
    sessions.saveSessions([{ id: "fresh-after-corruption" }]);
    assert.deepEqual(sessions.loadSessions(), [
      { id: "fresh-after-corruption" },
    ]);
    // 旧损坏数据仍完整在隔离副本里 — 可回填
    const qBytes = qBefore.map((f) => readFileSync(join(DIR, f), "utf8"));
    assert.ok(qBytes.includes(corrupted));
  });

  test("cleanupEmptyDefaultSessions never overwrites a corrupted DB", (t) => {
    const corrupted = writeCorruptedDb();
    t.mock.method(console, "error", () => {});
    sessions.cleanupEmptyDefaultSessions();
    assert.equal(readDbRaw(), corrupted, "corrupted file left untouched");
    assert.equal(quarantineFiles().length >= 1, true);
  });
});

describe("atomicity — a failed write never damages the DB", () => {
  test("JSON.stringify failure (circular ref): throws, DB untouched, no .tmp", () => {
    const good = [{ id: "good" }];
    sessions.saveSessions(good);
    const before = readDbRaw();
    const bad = [{ id: "circular" }];
    bad[0].self = bad[0];
    assert.throws(() => sessions.saveSessions(bad), TypeError);
    assert.equal(readDbRaw(), before);
    assert.deepEqual(tmpLeftovers(), []);
  });

  test(
    "tmp-write failure (read-only dir): throws, DB untouched, no .tmp",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    (t) => {
      const good = [{ id: "good-ro" }];
      sessions.saveSessions(good);
      const before = readDbRaw();
      chmodSync(DIR, 0o500);
      t.after(() => chmodSync(DIR, 0o700));
      assert.throws(() => sessions.saveSessions([{ id: "blocked" }]));
      assert.equal(readDbRaw(), before, "previous content intact");
      assert.deepEqual(tmpLeftovers(), []);
    },
  );
});

describe("interleaved load-modify-save — no lost committed unit, no torn file", () => {
  test("50 units interleaved across event-loop turns: all 50 committed and every read parses", async () => {
    sessions.saveSessions([]);
    const UNITS = 50;
    const run = async (i) => {
      await new Promise((r) => setImmediate(r)); // 制造交错
      // 单元内部全同步（与真实调用方 load→mutate→save 形态一致）:
      // 同步执行"运行至完成"，load 看到此前全部已提交单元 → 无丢失更新
      const all = sessions.loadSessions();
      all.push({ id: `s${i}` });
      sessions.saveSessions(all);
      // 每次提交后主文件都是完整可解析的 JSON（原子替换的效果）
      JSON.parse(readFileSync(DB, "utf8"));
    };
    await Promise.all(Array.from({ length: UNITS }, (_, i) => run(i)));
    const final = JSON.parse(readDbRaw());
    assert.equal(final.length, UNITS, "every committed unit survived");
    assert.deepEqual(tmpLeftovers(), []);
  });
});
