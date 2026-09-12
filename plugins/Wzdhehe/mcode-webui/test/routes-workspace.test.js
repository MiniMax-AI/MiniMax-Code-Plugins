// webui/test/routes-workspace.test.js
// Unit tests for server/routes/workspace.js — handleWorkspace + handleWorkspaceBrowse.
//
// Why this test exists: routes/workspace.js is a thin HTTP wrapper over
// lib/workspace.js. It just unpacks req.body, calls the lib, and translates
// the {ok, error} return into an HTTP status code. The translation rule
// matters: 400 only when error includes "不存在".
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleWorkspace → handleWorkspaceChange) would
// trigger a real mcode acp client spawn on cache miss, hanging the test.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupMocks, absPath } from "./_setup.js";

let wsRoute;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  wsRoute = await import(absPath("routes/workspace.js"));
});

function fakeReq(body, withHost = true) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  if (withHost) stream.headers = { host: "localhost" };
  return stream;
}
function fakeRes() {
  const res = {
    _status: null,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}
function fakeCs(workspaceDir = null) {
  return {
    workspace: { dir: workspaceDir, branch: null, tree: null },
  };
}

describe("handleWorkspace — /api/workspace POST", () => {
  test("returns 200 on successful set", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-rws-test-"));
    try {
      const cs = fakeCs("/old");
      const res = fakeRes();
      await wsRoute.handleWorkspace(
        fakeReq({ action: "set", dir: tmp }),
        res,
        { cs, cid: "cid-1" },
      );
      assert.equal(res._status, 200);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(cs.workspace.dir, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 400 when target dir does not exist (error contains '不存在')", async () => {
    const cs = fakeCs();
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "set", dir: "C:\\nonexistent\\xyz\\abc" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
  });

  test("returns 200 on 'detect' action (detectOnly mode)", async () => {
    const cs = fakeCs("/my-current");
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "detect" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.detectOnly, true);
  });

  test("returns 200 with ok:false when dir is missing for 'set' action", async () => {
    // Note: routes/workspace.js only returns 400 when error includes "不存在".
    // For "dir 不能为空" error, the response is 200 with ok:false in the body.
    const cs = fakeCs();
    const res = fakeRes();
    await wsRoute.handleWorkspace(
      fakeReq({ action: "set" }),
      res,
      { cs, cid: "cid-1" },
    );
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.match(body.error, /不能为空/);
  });
});

describe("handleWorkspaceBrowse — /api/workspace/browse GET", () => {
  test("returns 200 + children list for existing dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "webui-browse-"));
    try {
      mkdirSync(join(tmp, "sub1"));
      mkdirSync(join(tmp, "sub2"));
      writeFileSync(join(tmp, "f.txt"), "x");
      const req = Readable.from([Buffer.from("")]);
      req.url = `/api/workspace/browse?path=${encodeURIComponent(tmp)}`;
      req.headers = { host: "localhost" };
      const res = fakeRes();
      wsRoute.handleWorkspaceBrowse(req, res, {});
      assert.equal(res._status, 200);
      const body = JSON.parse(res._body);
      assert.equal(body.ok, true);
      assert.equal(body.children.length, 2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 400 for non-existent path", () => {
    const req = Readable.from([Buffer.from("")]);
    req.url = "/api/workspace/browse?path=" + encodeURIComponent("C:\\nonexistent\\xyz");
    req.headers = { host: "localhost" };
    const res = fakeRes();
    wsRoute.handleWorkspaceBrowse(req, res, {});
    assert.equal(res._status, 400);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
  });

  test("returns 200 with roots on Windows when no path given", { skip: process.platform !== "win32" }, () => {
    const req = Readable.from([Buffer.from("")]);
    req.url = "/api/workspace/browse";
    req.headers = { host: "localhost" };
    const res = fakeRes();
    wsRoute.handleWorkspaceBrowse(req, res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.roots));
  });
});
