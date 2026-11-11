// webui/test/routes-sessions-search.test.js
// Unit tests for handleSearchSessions — Lease C05 cross-workspace search.
//
// Why this test exists: the prior sidebar search (renderSessions in
// public/app/render.js) only filtered the already-loaded in-memory
// list — it could not surface sessions stored under a different
// `workspace` field. C05 fixes CAPABILITIES.md §7 "Cross-workspace
// session search ⚠" to ✅ by adding `GET /api/sessions/search`.
//
// Test strategy:
//   - Use setupMocks to mock lib/sessions.js (the persistent store).
//     We pre-seed it with cross-workspace rows so the handler has
//     something to filter against.
//   - The handler awaits authorize("session.search", ctx). The gate
//     fires for real on every search (the test-mode auto-approve was
//     removed in the 2026-09-20 rigor fix); the searchApproved helper
//     drives the real decision path via test/_setup.js#withDecisions.
//   - The decline path is covered twice: once via withDecisions
//     (approve:false through the real registry) and once via a
//     t.mock.module fixed-decline stub.
//   - The fakeReq/fakeRes helpers mimic the shape of node's
//     IncomingMessage and ServerResponse, matching the patterns used
//     in test/sessions.test.js and test/routes-workspace.test.js.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  setupMocks,
  absPath,
  registerSessionsStore,
  withDecisions,
} from "../test/_setup.js";

let handleSearchSessions;
let handleListSessions; // sanity: the unrelated list handler still works
let crossStore;

// Every search crosses the authorize("session.search") gate; drive the
// real decision path with a user approval.
async function searchApproved(...args) {
  return withDecisions(() => handleSearchSessions(...args), { approve: true });
}

before(async (t) => {
  await setupMocks(t, {});
  const mod = await import(absPath("routes/sessions.js"));
  handleSearchSessions = mod.handleSearchSessions;
  handleListSessions = mod.handleListSessions;
});

function fakeReq(url) {
  // _search handler reads req.url via `new URL(req.url, "http://localhost")`
  // — so the only field it touches is `url`. body / method are irrelevant.
  const stream = Readable.from([]);
  stream.url = url;
  stream.method = "GET";
  return stream;
}
function fakeRes() {
  return {
    _status: 200,
    _headers: null,
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b ? String(b) : "{}";
    },
  };
}
function readBody(res) {
  return JSON.parse(res._body || "{}");
}

beforeEach(() => {
  // Three workspaces, each with multiple sessions whose titles share
  // a common substring ("login"). The handler must:
  //   1. Match case-insensitively across all workspaces (q="LOGIN").
  //   2. Score exact > prefix > contains.
  //   3. Dedup so each workspace contributes only its best match.
  crossStore = [
    {
      id: "wsA-1",
      title: "login flow review",
      workspace: "/ws-A",
      createdAt: 1,
      updatedAt: 1,
      chat: ["● user: login flow review"],
    },
    {
      id: "wsA-2",
      title: "login screen redesign",
      workspace: "/ws-A",
      createdAt: 2,
      updatedAt: 99, // most recent in A — should win the dedup
      chat: ["● user: login screen redesign"],
    },
    {
      id: "wsB-1",
      title: "user dashboard login",
      workspace: "/ws-B",
      createdAt: 3,
      updatedAt: 3,
      chat: ["● user: user dashboard login"],
    },
    {
      // Exact match against q='login' (case-insensitive). Should
      //   outrank both ws-A (prefix) and ws-B (contains) rows.
      id: "wsC-1",
      title: "login",
      workspace: "/ws-C",
      createdAt: 4,
      updatedAt: 4,
      chat: [],
    },
    {
      id: "wsD-1",
      title: "billing portal",
      workspace: "/ws-D",
      createdAt: 5,
      updatedAt: 5,
      chat: [],
    },
  ];
  registerSessionsStore({ initial: crossStore });
});

describe("handleSearchSessions — basic happy path", () => {
  test("returns 200 + { ok:true, results: [...] }", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    assert.equal(res._status, 200);
    const body = readBody(res);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.results));
    assert.ok(body.results.length > 0, "should match at least one row");
  });

  test("case-insensitive substring match (q=LOGIN matches lowercase titles)", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=LOGIN"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    // wsA-1, wsA-2 (both contain 'login'), wsB-1 (contains 'login'),
    // wsC-1 (exactly 'Login' = case-insensitive exact). D is excluded.
    assert.equal(body.results.length, 3, "one row per unique workspace (A/B/C)");
    const ids = body.results.map((r) => r.id).sort();
    assert.deepEqual(ids, ["wsA-2", "wsB-1", "wsC-1"].sort());
  });

  test("dedup by workspace: same workspace contributes at most one row", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    // ws-A has TWO matches (wsA-1, wsA-2); only the best survives.
    // Best = highest matchScore; on tie, most recent updatedAt.
    // Both wsA-* have the same score (contains q) → wsA-2 wins on
    // updatedAt (99 vs 1).
    assert.equal(
      body.results.filter((r) => r.workspace === "/ws-A").length,
      1,
      "ws-A appears exactly once",
    );
    const wsARow = body.results.find((r) => r.workspace === "/ws-A");
    assert.equal(wsARow.id, "wsA-2", "ws-A wins the row with updatedAt=99");
  });

  test("score hierarchy: exact > prefix > contains", async () => {
    // Make three rows across three workspaces with the same query
    // producing three different score tiers. The exact match
    // (ws-C 'Login' == q='login') should outrank the prefix matches
    // (if any) and the contains matches.
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    const wsC = body.results.find((r) => r.workspace === "/ws-C");
    const wsA = body.results.find((r) => r.workspace === "/ws-A");
    assert.ok(wsC, "ws-C exact-match row present");
    assert.ok(wsA, "ws-A contains-match row present");
    assert.ok(wsC.matchScore > wsA.matchScore, "exact beats contains");
    // results are sorted by score desc — ws-C should be first
    assert.equal(body.results[0].id, wsC.id, "exact-match row is rank 1");
  });

  test("id-fallback scoring: typing part of a session id still finds it", async () => {
    // q matches no title but matches wsA-1's id prefix.
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=wsA-1"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.ok(body.results.length >= 1);
    const hit = body.results.find((r) => r.id === "wsA-1");
    assert.ok(hit, "id-fallback row present");
    assert.ok(hit.matchScore >= 1, "id-fallback score is non-zero");
  });
});

describe("handleSearchSessions — query params", () => {
  test("workspace filter narrows the result to one workspace", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&workspace=/ws-A"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].workspace, "/ws-A");
  });

  test("workspace filter excludes rows from other workspaces", async () => {
    // Pick a workspace that does not exist in our fixture.
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&workspace=/no-such-ws"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.deepEqual(body.results, []);
  });

  test("limit=2 caps the result array", async () => {
    // We have 3 workspaces that match; limit=2 should keep the top 2.
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&limit=2"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.equal(body.results.length, 2);
  });

  test("limit > 100 is clamped to 100", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&limit=9999"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    // We only have 3 matching rows; the clamp is internal — what we
    // can assert externally is that the handler didn't blow up and
    // returned the full set (clamp only affects ceiling, not what it
    // returns when there are fewer matches).
    assert.ok(body.results.length <= 100);
    assert.equal(body.results.length, 3);
  });

  test("limit < 1 is clamped to 1", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&limit=0"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.ok(body.results.length >= 1);
  });

  test("non-numeric limit falls back to default (20)", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login&limit=abc"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    // 3 matching rows; default 20 does not cap us.
    assert.equal(body.results.length, 3);
  });

  test("empty q returns empty results (not a list-all endpoint)", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q="),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    assert.equal(res._status, 200);
    const body = readBody(res);
    assert.equal(body.ok, true);
    assert.deepEqual(body.results, []);
  });

  test("missing q parameter returns empty results", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.deepEqual(body.results, []);
  });

  test("q with no matches returns empty results", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=zzzzzzzz_no_match"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    assert.equal(body.results.length, 0);
  });
});

describe("handleSearchSessions — response shape", () => {
  test("every result row carries id, title, workspace, updatedAt, matchScore", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    for (const row of body.results) {
      assert.ok(typeof row.id === "string" && row.id.length > 0, "id present");
      assert.ok(typeof row.title === "string", "title present (string, possibly empty)");
      assert.ok(typeof row.workspace === "string", "workspace present (string, possibly empty)");
      assert.ok(typeof row.updatedAt === "number", "updatedAt is a number");
      assert.ok(typeof row.matchScore === "number" && row.matchScore > 0, "matchScore > 0");
    }
  });

  test("matchScore is sorted desc, with updatedAt desc as tiebreak", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    for (let i = 1; i < body.results.length; i++) {
      const prev = body.results[i - 1];
      const cur = body.results[i];
      if (prev.matchScore !== cur.matchScore) {
        assert.ok(
          prev.matchScore >= cur.matchScore,
          `score desc: ${prev.matchScore} >= ${cur.matchScore}`,
        );
      } else {
        assert.ok(
          prev.updatedAt >= cur.updatedAt,
          `updatedAt desc on tie: ${prev.updatedAt} >= ${cur.updatedAt}`,
        );
      }
    }
  });
});

describe("handleSearchSessions — B03 authorize gate", () => {
  test("approved via the real decision path (withDecisions injection)", async () => {
    // 2026-09-20 rigor fix: the test-mode auto-approve is gone. The
    // gate fires for every search; searchApproved drives the REAL
    // pending-registry decision path (what a user's modal click does).
    // If this wiring breaks, the request would 403 (or hang) — this
    // test is the canary.
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    assert.equal(res._status, 200, "approved search must NOT 403");
    const body = readBody(res);
    assert.equal(body.ok, true);
  });

  test("user decline via the real decision path → 403, empty results", async () => {
    // New coverage: drive an explicit user rejection through
    // authorize's real registry — the search must not run.
    const res = fakeRes();
    await withDecisions(
      () => handleSearchSessions(
        fakeReq("/api/sessions/search?q=login"),
        res,
        { cid: "cid-1", pathname: "/api/sessions/search" },
      ),
      { approve: false },
    );
    assert.equal(res._status, 403);
    const body = readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /authorize declined/);
    assert.equal(body.decidedBy, "user");
  });

  test("whitelist contains session.search (integration touchpoint)", async () => {
    // The handler calls authorize("session.search", ctx). If the
    // action isn't on AUTHORIZE_ACTIONS, authorize() returns
    // approved:false synchronously and the handler replies 403
    // even under --test. We assert the whitelist directly so a
    // future B03 patch that drops the entry fails this test before
    // it can fail the search endpoint.
    const authMod = await import(absPath("lib/authorize.js"));
    assert.ok(
      authMod.AUTHORIZE_ACTIONS.includes("session.search"),
      "AUTHORIZE_ACTIONS must include session.search",
    );
  });

  test("rejects when authorize returns approved:false (force-decline path)", async (t) => {
    // Force-decline via t.mock.module on lib/authorize.js. ESM module
    //   namespace bindings are immutable, so a monkey-patch on the
    //   imported object does not propagate to the SUT's import
    //   binding. Instead we register a fresh module mock that
    //   replaces authorize with a fixed-decline stub, then re-import
    //   the route handler under that mock with a cache-busting query
    //   so node ESM does not serve the cached module from earlier
    //   tests in this file.
    t.mock.module(absPath("lib/authorize.js"), {
      namedExports: {
        authorize: async () => ({
          approved: false,
          decidedBy: "user",
          decidedAt: Date.now(),
        }),
        // AUTHORIZE_ACTIONS still needs to be exported so callers that
        //   touch it don't crash. The handler doesn't read it, but
        //   import side-effects might.
        AUTHORIZE_ACTIONS: Object.freeze(["session.search"]),
        DEFAULT_TIMEOUT_MS: 5 * 60 * 1000,
        handleAuthDecision: async () => {},
        getPendingCount: () => 0,
        getPendingRequestIds: () => [],
        _resetForTests: () => {},
        _decideForTests: () => false,
        clearPendingForCid: () => 0,
      },
    });
    // Re-import under the new mock with a cache-busting query so
    //   Node ESM doesn't serve the cached binding from earlier tests.
    const cacheBusted = absPath("routes/sessions.js") + "?decline=" + Date.now();
    const freshMod = await import(cacheBusted);
    const res = fakeRes();
    await freshMod.handleSearchSessions(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    assert.equal(res._status, 403);
    const body = readBody(res);
    assert.equal(body.ok, false);
    assert.match(body.error, /authorize declined/);
    assert.equal(body.decidedBy, "user");
  });
});

describe("handleSearchSessions — defensive", () => {
  test("missing cid in ctx still works (empty cid is broadcast)", async () => {
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { pathname: "/api/sessions/search" }, // no cid
    );
    assert.equal(res._status, 200);
  });

  test("a malformed session row (no id) is skipped, not crashed on", async () => {
    // Mix in a degenerate row to ensure the loop guards against bad input.
    registerSessionsStore({
      initial: [
        ...crossStore,
        { title: "no-id row", workspace: "/ws-A", updatedAt: 100 },
        null,
        { id: "" }, // empty id
      ],
    });
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=login"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    assert.equal(res._status, 200);
    const body = readBody(res);
    // Should still produce the same 3 deduped rows we had before.
    assert.equal(body.results.length, 3);
  });

  test("session with empty title falls back to id-only scoring", async () => {
    registerSessionsStore({
      initial: [
        ...crossStore,
        {
          id: "wsE-empty-title-xyz",
          title: "",
          workspace: "/ws-E",
          updatedAt: 5,
          chat: [],
        },
      ],
    });
    const res = fakeRes();
    await searchApproved(
      fakeReq("/api/sessions/search?q=wsE-empty-title-xyz"),
      res,
      { cid: "cid-1", pathname: "/api/sessions/search" },
    );
    const body = readBody(res);
    const hit = body.results.find((r) => r.id === "wsE-empty-title-xyz");
    assert.ok(hit, "id-only match found even with empty title");
  });
});

// Sanity check: the search handler does not break the existing
// handleListSessions. C05 is supposed to be additive, not invasive.
describe("handleListSessions — non-regression sanity", () => {
  test("list still returns the seeded sessions", async () => {
    const res = fakeRes();
    handleListSessions(undefined, res);
    assert.equal(res._status, 200);
    const body = readBody(res);
    assert.equal(body.ok, true);
    assert.equal(body.sessions.length, crossStore.length);
  });
});