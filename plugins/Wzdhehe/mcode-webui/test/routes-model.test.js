// webui/test/routes-model.test.js
// Unit tests for server/routes/model.js — handleGetModels, handleSetModel,
// handleSetPermissions, handleListPermissionModes, handleAnswer.
//
// Why this test exists: routes/model.js is the API surface for model selection
// + permission mode. handleSetPermissions has 5 mode mappings (ask/auto/read/
// off/full) that map webui labels to internal strings. handleListPermissionModes
// returns both webui-side and mcode-side enum values, used by the dropdown.
//
// Test strategy: USE setupMocks to mock lib/acp-client.js. Without this mock,
// pushStateFor (called inside handleSetModel) would trigger a real mcode acp
// client spawn via getMcodeSessionsForWorkspace on cache miss, hanging the test.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath } from "./_setup.js";

let modelRoute;
before(async (t) => {
  await setupMocks(t, {
    acp: {
      getMcodeSessionsForWorkspace: async () => [],
      getMcodeSessionsCacheSync: () => [],
      getCachedMcodeCommands: () => ({ mcode: [], webui: [], fetchedAt: 0, source: "test" }),
    },
  });
  modelRoute = await import(absPath("routes/model.js"));
});

function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  const res = {
    _status: 200,
    _headers: {},
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
function fakeCs(modelName = "minimax_api/MiniMax-M3") {
  return {
    model: { name: modelName, thinking: "On", ctx: "512k" },
    permissions: "Full access",
  };
}

describe("handleGetModels — /api/models", () => {
  test("returns ok + models array + current + source", () => {
    const ctx = { cs: fakeCs("minimax_api/MiniMax-M3") };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.models));
    assert.equal(body.current, "minimax_api/MiniMax-M3");
    assert.equal(body.source, "mcode-cli-bundle");
  });

  test("models are formatted as {id, label, provider}", () => {
    const ctx = { cs: fakeCs("minimax_api/MiniMax-M3") };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    if (body.models.length > 0) {
      const m = body.models[0];
      assert.ok(m.id, "model should have id");
      assert.ok(m.label, "model should have label");
      assert.ok(m.provider, "model should have provider");
    }
  });

  test("uses cs.model.name as the provider when set", () => {
    // cs.model.name = "custom/MiniMax-M3" → provider = "custom"
    const ctx = { cs: fakeCs("custom/MiniMax-M3") };
    const res = fakeRes();
    modelRoute.handleGetModels(null, res, ctx);
    const body = JSON.parse(res._body);
    if (body.models.length > 0) {
      assert.ok(body.models[0].id.startsWith("custom/"));
    }
  });
});

describe("handleSetModel — /api/set-model", () => {
  test("updates cs.model.name with the new model", async () => {
    const cs = fakeCs("minimax_api/MiniMax-M3");
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "minimax_api/MiniMax-M2" }),
      res,
      ctx,
    );
    assert.equal(res._status, 200);
    assert.equal(cs.model.name, "minimax_api/MiniMax-M2");
  });

  test("returns 400 if model is empty", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({ model: "" }), res, ctx);
    assert.equal(res._status, 400);
  });

  test("returns 400 if model is missing", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(fakeReq({}), res, ctx);
    assert.equal(res._status, 400);
  });

  test("trims whitespace from the model name", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetModel(
      fakeReq({ model: "  minimax_api/MiniMax-M3  " }),
      res,
      ctx,
    );
    assert.equal(cs.model.name, "minimax_api/MiniMax-M3");
  });
});

describe("handleSetPermissions — /api/permissions (5 mode mappings)", () => {
  test("'ask' maps to 'Ask' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, ctx);
    assert.equal(cs.permissions, "Ask");
  });

  test("'auto' maps to 'Auto' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "auto" }), res, ctx);
    assert.equal(cs.permissions, "Auto");
  });

  test("'read' maps to 'Read' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "read" }), res, ctx);
    assert.equal(cs.permissions, "Read");
  });

  test("'off' maps to 'Off' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "off" }), res, ctx);
    assert.equal(cs.permissions, "Off");
  });

  test("'full' maps to 'Full access' label", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "full" }), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("unknown mode defaults to 'Full access'", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "gibberish" }), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("empty mode defaults to 'full'", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({}), res, ctx);
    assert.equal(cs.permissions, "Full access");
  });

  test("response includes mcodeSynced: false (mcode 0.1.5 acp unsupported)", async () => {
    const cs = fakeCs();
    const ctx = { cs, cid: "cid-1" };
    const res = fakeRes();
    await modelRoute.handleSetPermissions(fakeReq({ mode: "ask" }), res, ctx);
    const body = JSON.parse(res._body);
    assert.equal(body.mcodeSynced, false);
  });
});

describe("handleListPermissionModes — /api/permissions-modes", () => {
  test("returns ok + webui (4 entries) + mcode arrays", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.webui));
    assert.ok(Array.isArray(body.mcode));
    assert.equal(body.webui.length, 4);
  });

  test("webui entries have value/label/mcodeValue", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    const body = JSON.parse(res._body);
    for (const entry of body.webui) {
      assert.ok(entry.value, "webui entry must have value");
      assert.ok(entry.label, "webui entry must have label");
      assert.ok(entry.mcodeValue, "webui entry must have mcodeValue");
    }
  });

  test("webui includes 'full' mapped to 'bypassPermissions'", () => {
    const res = fakeRes();
    modelRoute.handleListPermissionModes(null, res);
    const body = JSON.parse(res._body);
    const full = body.webui.find((e) => e.value === "full");
    assert.ok(full);
    assert.equal(full.mcodeValue, "bypassPermissions");
  });
});

describe("handleAnswer — /api/answer (legacy no-op)", () => {
  test("returns deprecated:true (legacy endpoint)", async () => {
    const res = fakeRes();
    await modelRoute.handleAnswer(fakeReq({ type: "x", option: 1 }), res, {});
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.deprecated, true);
  });
});
