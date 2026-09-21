// webui/test/lib-workspace-containment.test.js
// Unit tests for server/lib/workspace.js containment boundary (v2 security,
// PR #55 review point 5).
//
// Why this test exists: before the fix, handleWorkspaceChange and
// browseWorkspace accepted ANY absolute directory — a browser client that
// passed auth could point the workspace (where mcode runs with the server's
// credentials) at any host directory, and browse was a directory-enumeration
// oracle. The fix introduces allowed roots + realpath containment. These
// tests pin:
//   - legit workspace inside an allowed root keeps working (zero regression)
//   - traversal (../) out of the roots is rejected
//   - symlink escape out of the roots is rejected (realpath, not prefix match)
//   - benign symlinks that stay inside the roots still work
//   - browse shares the same boundary; the root view exposes only allowed roots
//   - rejection errors are actionable (list roots + name the env override)
//
// Test strategy: mirror checks/lib-workspace.check.mjs — setupMocks with an
// acp mock so pushStateFor (called inside handleWorkspaceChange) never spawns
// a real mcode client. Containment face is controlled per-test via
// MCODE_WEBUI_WORKSPACE_ROOTS (read at call time by getAllowedWorkspaceRoots,
// so tests can flip it without re-importing).

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { tmpdir, homedir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join, basename, delimiter } from "node:path";
import { setupMocks, absPath } from "../test/_setup.js";

let ws;
let config;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({
        mcode: [],
        webui: [],
        fetchedAt: 0,
        source: "test",
      }),
    },
  });
  ws = await import(absPath("lib/workspace.js"));
  config = await import(absPath("lib/config.js"));
});

const ROOTS_ENV = "MCODE_WEBUI_WORKSPACE_ROOTS";

function fakeCs(workspaceDir = "/some/default") {
  return {
    workspace: { dir: workspaceDir, branch: null, tree: null },
  };
}

// 每用例的隔离场地: root = 允许根（本次用例唯一）, outside = 允许根外目录。
function makeArena(t) {
  const root = mkdtempSync(join(tmpdir(), "webui-wsroot-"));
  const outside = mkdtempSync(join(tmpdir(), "webui-wsout-"));
  mkdirSync(join(root, "proj"));
  mkdirSync(join(outside, "secret"));
  process.env[ROOTS_ENV] = root; // 单根面（完全替换默认面）
  t.after(() => {
    delete process.env[ROOTS_ENV];
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  return { root, outside };
}

describe("getAllowedWorkspaceRoots", () => {
  test("default face (env unset): home + default workspace + tmp, realpathed", () => {
    delete process.env[ROOTS_ENV];
    const roots = ws.getAllowedWorkspaceRoots();
    // realpath 两侧对齐（macOS /tmp → /private/tmp 等）
    assert.ok(roots.includes(realpathSync(homedir())), "home in default roots");
    assert.ok(
      roots.includes(realpathSync(tmpdir())),
      "tmpdir in default roots",
    );
    assert.ok(
      roots.includes(realpathSync(config.DEFAULT_WORKSPACE)),
      "configured default workspace in default roots",
    );
  });

  test("env replaces the default face entirely; nonexistent entries skipped; deduped", () => {
    const a = mkdtempSync(join(tmpdir(), "webui-wsroots-a-"));
    const ghost = join(a, "does-not-exist");
    try {
      process.env[ROOTS_ENV] = [a, ghost, a].join(delimiter);
      const roots = ws.getAllowedWorkspaceRoots();
      assert.deepEqual(roots, [realpathSync(a)]);
      assert.ok(!roots.includes(realpathSync(homedir())), "home replaced out");
    } finally {
      delete process.env[ROOTS_ENV];
      rmSync(a, { recursive: true, force: true });
    }
  });
});

describe("handleWorkspaceChange — containment", () => {
  test("set inside allowed root: ok, cs.workspace.dir keeps the resolve() form", (t) => {
    const { root } = makeArena(t);
    const cs = fakeCs("/old");
    const r = ws.handleWorkspaceChange(cs, "cid-1", {
      action: "set",
      dir: join(root, "proj"),
    });
    assert.equal(r.ok, true);
    assert.equal(cs.workspace.dir, join(root, "proj"));
  });

  test("default face zero regression: a fresh tmp workspace stays settable (env unset)", (t) => {
    delete process.env[ROOTS_ENV];
    const scratch = mkdtempSync(join(tmpdir(), "webui-wsscratch-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const cs = fakeCs("/old");
    const r = ws.handleWorkspaceChange(cs, "cid-1", {
      action: "set",
      dir: scratch,
    });
    assert.equal(r.ok, true);
    assert.equal(cs.workspace.dir, scratch);
  });

  test("set outside allowed root: rejected with actionable error, cs untouched", (t) => {
    const { outside } = makeArena(t);
    const cs = fakeCs("/old");
    const r = ws.handleWorkspaceChange(cs, "cid-1", {
      action: "set",
      dir: outside,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("允许根"), "error lists the concept");
    assert.ok(
      r.error.includes(ROOTS_ENV),
      "error names the env override",
    );
    assert.ok(!r.error.includes("不存在"), "distinct from not-exist error");
    assert.equal(cs.workspace.dir, "/old", "cs.workspace not mutated");
  });

  test("traversal (../) out of the root resolves outside and is rejected", (t) => {
    const { root, outside } = makeArena(t);
    const sneaky = join(root, "..", basename(outside)); // resolve() → outside
    const cs = fakeCs("/old");
    const r = ws.handleWorkspaceChange(cs, "cid-1", {
      action: "set",
      dir: sneaky,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("越界"));
    assert.equal(cs.workspace.dir, "/old");
  });

  test(
    "symlink escape: link inside the root pointing outside is rejected via realpath",
    { skip: process.platform === "win32" },
    (t) => {
      const { root, outside } = makeArena(t);
      symlinkSync(outside, join(root, "lnk-out"));
      const cs = fakeCs("/old");
      const r = ws.handleWorkspaceChange(cs, "cid-1", {
        action: "set",
        dir: join(root, "lnk-out"),
      });
      assert.equal(r.ok, false);
      assert.ok(r.error.includes("越界"), "rejected as out-of-bounds");
      assert.ok(
        r.error.includes(realpathSync(outside)),
        "error shows the realpath-resolved target",
      );
      assert.equal(cs.workspace.dir, "/old");
    },
  );

  test(
    "benign symlink: link inside the root pointing INSIDE the root still works",
    { skip: process.platform === "win32" },
    (t) => {
      const { root } = makeArena(t);
      symlinkSync(join(root, "proj"), join(root, "lnk-in"));
      const cs = fakeCs("/old");
      const r = ws.handleWorkspaceChange(cs, "cid-1", {
        action: "set",
        dir: join(root, "lnk-in"),
      });
      assert.equal(r.ok, true);
      assert.equal(cs.workspace.dir, join(root, "lnk-in"));
    },
  );

  test("reset to a DEFAULT_WORKSPACE outside the env roots is rejected; inside is ok", (t) => {
    const { root } = makeArena(t);
    // 默认工作区（config 装配时定的真实目录）不可能落在本用例的 mkdtemp 根下
    const cs = fakeCs("/old");
    const rejected = ws.handleWorkspaceChange(cs, "cid-1", { action: "reset" });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.error.includes(ROOTS_ENV));

    process.env[ROOTS_ENV] = [root, config.DEFAULT_WORKSPACE].join(delimiter);
    try {
      const ok = ws.handleWorkspaceChange(fakeCs("/old"), "cid-2", {
        action: "reset",
      });
      assert.equal(ok.ok, true);
      assert.equal(ok.workspace.dir, config.DEFAULT_WORKSPACE);
    } finally {
      delete process.env[ROOTS_ENV];
    }
  });
});

describe("browseWorkspace — containment", () => {
  test("browse inside allowed root: children listed as before", (t) => {
    const { root } = makeArena(t);
    const r = ws.browseWorkspace(root);
    assert.equal(r.ok, true);
    assert.equal(r.dir, root);
    assert.ok(r.children.some((c) => c.name === "proj"));
  });

  test("browse outside allowed root: rejected with actionable error", (t) => {
    const { outside } = makeArena(t);
    const r = ws.browseWorkspace(outside);
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("越界"));
    assert.ok(r.error.includes(ROOTS_ENV));
  });

  test(
    "browse through a symlink escaping the root is rejected",
    { skip: process.platform === "win32" },
    (t) => {
      const { root, outside } = makeArena(t);
      symlinkSync(outside, join(root, "lnk-out"));
      const r = ws.browseWorkspace(join(root, "lnk-out"));
      assert.equal(r.ok, false);
      assert.ok(r.error.includes("越界"));
    },
  );

  test("no-path root view: exposes ONLY the allowed roots (enumeration oracle closed)", (t) => {
    const { root } = makeArena(t);
    const r = ws.browseWorkspace("");
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.roots));
    assert.deepEqual(r.roots, [realpathSync(root)]);
    assert.deepEqual(r.children, []);
    if (process.platform !== "win32") {
      assert.equal(r.dir, "/"); // POSIX root-view shape kept for compatibility
    } else {
      assert.equal(r.dir, null);
    }
  });

  test("no-path default face: allowed roots include home + tmpdir realpaths", () => {
    delete process.env[ROOTS_ENV];
    const r = ws.browseWorkspace("");
    assert.equal(r.ok, true);
    assert.ok(r.roots.includes(realpathSync(homedir())));
    assert.ok(r.roots.includes(realpathSync(tmpdir())));
  });

  test("parent above the allowed root is nulled (up-nav stops at the boundary)", (t) => {
    const { root } = makeArena(t);
    const r = ws.browseWorkspace(root);
    assert.equal(r.ok, true);
    assert.equal(r.parent, null, "parent (tmpdir) is outside the single root");
    // 根内子目录的 parent 正常保留
    const sub = ws.browseWorkspace(join(root, "proj"));
    assert.equal(sub.ok, true);
    assert.equal(sub.parent, root);
  });
});
