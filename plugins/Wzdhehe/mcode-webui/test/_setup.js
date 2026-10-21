// webui/test/_setup.js
// Shared mock infrastructure for unit tests.
//
// Usage:
//   import { test, before } from 'node:test'
//   import { setupMocks, absPath, registerAcpMock, registerSessionsStore, setLanBroadcast } from './_setup.js'
//
//   before(async (t) => {
//     await setupMocks(t, {
//       acp: { getMcodeSessionsForWorkspace: async (ws) => [...] },
//       sessions: { initial: [...] },
//       mavis: { applyMavisUsageToCs: async (cs) => { ... } },
//       lanBroadcast: true,
//     })
//     // dynamic import SUT after mocks registered
//     const { foo } = await import(absPath('lib/foo.js'))
//   })
//
// Why this design:
//   - Node 24's --experimental-test-module-mocks (Node 22.3+) registers
//     mocks on the test-context's MockTracker. Mocking from a module top
//     level (outside test/before) does NOT affect later dynamic imports
//     in the same test file. Mocking inside t.mock.module(...)
//     works.
//   - For `node:` builtins, mock.module behavior is patchy on Node 24.14
//     — node:fs mocks work, but node:child_process.spawn mock
//     does NOT actually intercept spawn (the mock function body is
//     visible via toString but never executed). Therefore tests that
//     need a fake child process should use a real sqlite3 fixture
//     instead of mocking node:child_process.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = resolve(TEST_DIR, "..", "server");
// mock.module() on Windows requires file:// URLs for filesystem paths
export const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href;

// -----------------------------------------------------------------------
// Mutable mock impls. Tests can pass overrides to setupMocks().
// -----------------------------------------------------------------------
const _acpMock = {
  getCachedMcodeCommands: () => [],
  getMcodeSessionsForWorkspace: async () => [],
  getMcodeSessionsCacheSync: () => null,
  getMcodeSessionTitle: async () => null,
  deleteMcodeSessionFromDb: () => ({ ok: true }),
  // v0.5.bx 系列 patch: 补 mcode-rpc.js 需要的 export(REFACTORING.md §3.2 坑 4)
  getMcodeAcpClient: async () => null,
  listAllMcodeSessions: async () => [],
  getMcodeServerInfo: () => null,
  invalidateMcodeSessionsCache: () => {},
  shutdownMcodeAcpSingleton: () => {},
  dropMcodeSessionFromCache: () => {}, // v1.0: 删除路由防复活用
  getMcodeSessionsStaleSync: () => null, // v1.0: 过期缓存读取 (推送防闪跌用)
  // B04 patch: interaction/commands.js#bodyHelp uses ensureMcodeCommands
  //   to list /help contents. Default stub returns an empty payload so
  //   tests that don't care about /help can ignore this; tests that DO
  //   care (test/lib-interaction.test.js) override via their own
  //   t.mock.module registration since setupMocks only allows one
  //   registration per module path per test context.
  ensureMcodeCommands: async () => ({
    mcode: [], webui: [], fetchedAt: 0, source: "test-default",
  }),
};

let _sessionsStore = [];
let _saveImpl = (arr) => {
  _sessionsStore = [...arr];
};

// v2 (2026-09-20 webui-manual-audit): mutable mcode-acp runner mock.
//   Same dispatch-through pattern as _acpMock above: mock.module()
//   throws ERR_INVALID_STATE on a second registration for the same
//   specifier, and chat.js binds its runMcodeAcp import at first
//   dynamic import — so a per-test "failed send" (ENOENT-style
//   {status:"failed", error}) can only be injected by mutating the
//   impl the registered wrapper dispatches to. Default mirrors the
//   previous fixed success mock byte-for-byte, so existing suites
//   see no behavior change.
const _mcodeAcpMock = {
  runMcodeAcp: async () => ({
    status: "succeeded",
    answer: "mocked",
    sessionId: null,
  }),
  streamAcpPrompt: async () => ({ status: "succeeded", answer: "mocked" }),
};

let _lanBroadcast = false;
let _readOnly = false;
let _tokenEnabled = true;
let _currentToken = "";
let _tokenRotatedAt = 0;
let _tokenAcknowledged = false;
// v2026-08-28 modacker: Token Plan (套餐用量) feature — mock state
//   mirrors the real settings.js vars so pushStateFor can read them
//   without each test having to re-stub. Default false/empty matches
//   a clean disk. Tests that exercise the quota fields should call
//   setQuotaEnabled / setTokenPlanApiKey before the SUT snapshot.
// v2026-08-28 modacker (A+C): external key sources — env / file.
//   _envTokenPlanKey and _fileTokenPlanKey shadow _tokenPlanApiKey
//   in getTokenPlanApiKey() (priority env > file > settings). Tests
//   can call setEnvTokenPlanKey / setFileTokenPlanKey to verify the
//   priority chain and the snapshot's `tokenPlanApiKeySource` field.
let _quotaEnabled = false;
let _tokenPlanApiKey = "";
let _envTokenPlanKey = "";
let _fileTokenPlanKey = "";
let _fileTokenPlanPath = "";
let _externalKeySource = "";

// Per-test direct handles (for tests that need to read state after the SUT)
export const acpMock = _acpMock;

// Imperative mutators — tests can use these to override between tests
// (alternative to passing `overrides` to setupMocks at before() time)
export function registerAcpMock(overrides) {
  Object.assign(_acpMock, overrides);
}
// v2 (2026-09-20 webui-manual-audit): imperative mutator for the
//   mcode-acp runner mock — see the _mcodeAcpMock declaration for why
//   dispatch-through (rather than a second mock.module) is the only
//   way to flip runMcodeAcp to a failed result after chat.js has
//   already been imported.
export function registerMcodeAcpMock(overrides) {
  Object.assign(_mcodeAcpMock, overrides);
}
export function registerSessionsStore({ initial = [], save } = {}) {
  _sessionsStore = [...initial];
  if (save) _saveImpl = save;
}
export function getSessionsStore() {
  return _sessionsStore;
}
export const _persist = (arr) => _saveImpl(arr);
export function setLanBroadcast(v) {
  _lanBroadcast = !!v;
}
export function setReadOnly(v) { _readOnly = !!v }
export function setTokenEnabled(v) { _tokenEnabled = !!v }
export function setCurrentToken(v) { _currentToken = String(v || "") }
export function setTokenRotatedAt(v) { _tokenRotatedAt = Number(v) || 0 }
export function setTokenAcknowledged(v) { _tokenAcknowledged = !!v }
// v2026-08-28 modacker: Token Plan mock mutators
//   setQuotaEnabled(false) 镜像 real settings.js: 同步清 key
//   (server/lib/settings.js:380-388 — "Disabling also clears the
//   key (don't keep credentials around if the user explicitly
//   turned the feature off)"). 任何改这俩 mock 的地方都应保持
//   这个不变量, 否则 pushStateFor 的 snapshot 会跟真实实现分叉。
//   同时 (A+C): setEnvTokenPlanKey / setFileTokenPlanKey 模拟外部
//   源 — 任意一个设了之后, getTokenPlanApiKey() 优先返回它,
//   _externalKeySource 反映最高优先级源。setQuotaEnabled(false)
//   只清 settings.json 路径, 不动 env/file — 同真实实现。
export function setQuotaEnabled(v) {
  _quotaEnabled = !!v
  if (!_quotaEnabled) _tokenPlanApiKey = ""
}
export function setTokenPlanApiKey(v) { _tokenPlanApiKey = String(v || "") }
export function setEnvTokenPlanKey(v) {
  _envTokenPlanKey = String(v || "")
  _externalKeySource = _envTokenPlanKey ? "env" : (_fileTokenPlanKey ? "file" : "")
}
export function setFileTokenPlanKey(v, p) {
  _fileTokenPlanKey = String(v || "")
  _fileTokenPlanPath = p || ""
  if (!_envTokenPlanKey) {
    _externalKeySource = _fileTokenPlanKey ? "file" : ""
  }
}

/**
 * Register all built-in + webui module mocks on the test context.
 * Must run before any SUT dynamic import in the same test file.
 *
 * @param {TestContext} t  from before((t) => ...)
 * @param {object} [overrides]
 *   - acp: partial overrides for the acp-client.js mock (named exports)
 *   - sessions: { initial, save } for the lib/sessions.js mock
 *   - mavis: partial overrides for the lib/mavis-usage.js mock
 *   - mcodeAcp: partial overrides for the lib/mcode-acp.js runner mock
 *     (runMcodeAcp / streamAcpPrompt) — e.g. a failed-send result
 *   - lanBroadcast: boolean (default false)
 */
export async function setupMocks(t, overrides = {}) {
  // 1. node:fs — DO NOT mock. mock.module REPLACES the entire builtin
  //    namespace, so any un-listed export (e.g. readFileSync used by
  //    config.js's DEFAULT_WORKSPACE IIFE) becomes undefined → SUT
  //    import hangs. The real existsSync is fine: the fixture DB exists
  //    and config.js's cwd.json exists too.

  // 2. node:child_process.spawn — DOES NOT WORK as a mock on Node 24.14
  //    (mock function is registered but never invoked when SUT calls
  //    spawn — the SUT sees the real spawn). We intentionally do NOT
  //    register this here. Tests that exercise child-process code paths
  //    must use real sqlite3 fixture DBs.

  // 3. webui/lib/acp-client.js
  //    IMPORTANT: namedExports must be stable function references that
  //    dispatch to the (mutable) _acpMock. We CANNOT spread _acpMock
  //    here — that would snapshot the functions at setupMocks() time,
  //    so later registerAcpMock() calls wouldn't take effect. Instead,
  //    each export is a thin wrapper that looks up the current impl
  //    in _acpMock at call time.
  if (overrides.acp) Object.assign(_acpMock, overrides.acp);
  t.mock.module(absPath("lib/acp-client.js"), {
    namedExports: {
      getCachedMcodeCommands: (...a) => _acpMock.getCachedMcodeCommands(...a),
      getMcodeSessionsForWorkspace: (...a) =>
        _acpMock.getMcodeSessionsForWorkspace(...a),
      getMcodeSessionsCacheSync: (...a) =>
        _acpMock.getMcodeSessionsCacheSync(...a),
      getMcodeSessionTitle: (...a) => _acpMock.getMcodeSessionTitle(...a),
      deleteMcodeSessionFromDb: (...a) =>
        _acpMock.deleteMcodeSessionFromDb(...a),
      // v0.5.bx 系列 patch: mcode-rpc.js 也 import 这俩
      getMcodeAcpClient: (...a) => _acpMock.getMcodeAcpClient(...a),
      listAllMcodeSessions: (...a) => _acpMock.listAllMcodeSessions(...a),
      getMcodeServerInfo: (...a) => _acpMock.getMcodeServerInfo(...a),
      invalidateMcodeSessionsCache: (...a) =>
        _acpMock.invalidateMcodeSessionsCache(...a),
      shutdownMcodeAcpSingleton: (...a) =>
        _acpMock.shutdownMcodeAcpSingleton(...a),
      dropMcodeSessionFromCache: (...a) =>
        _acpMock.dropMcodeSessionFromCache(...a),
      getMcodeSessionsStaleSync: (...a) =>
        _acpMock.getMcodeSessionsStaleSync(...a),
      // B04 patch: ensureMcodeCommands for interaction/commands.js
      //   #bodyHelp dispatch (see BORROW-dsh-deepseek-harness-2026-08-28 §3).
      ensureMcodeCommands: (...a) => _acpMock.ensureMcodeCommands(...a),
    },
  });

  // 4. webui/lib/sessions.js (server-side session store)
  if (overrides.sessions) {
    _sessionsStore = [...(overrides.sessions.initial || [])];
    if (overrides.sessions.save) _saveImpl = overrides.sessions.save;
  }
  t.mock.module(absPath("lib/sessions.js"), {
    namedExports: {
      loadSessions: () => [..._sessionsStore],
      saveSessions: (arr) => _saveImpl(arr),
      // The real lib/sessions.js exports these too. We provide no-op
      // defaults so handlers that import them don't blow up. Tests that
      // care about these can register their own via setupMocks overrides
      // (we'd need to add similar wrappers — not done yet).
      // v2 (2026-09-20 webui-manual-audit): mirror the REAL
      // resetContext claim reset (lib/sessions.js) — it now also drops
      // cs.running + context.thinkingStatus so a mid-run switch can't
      // park a permanent 思考中/stop-button claim. Without this parity,
      // mocked route tests would keep exercising the old "claim
      // survives the switch" contract and green-light regressions.
      resetContext: (cs) => {
        if (cs && cs.context) {
          cs.context.tokens = 0;
          cs.context.used = 0;
          cs.context.percent = 0;
          cs.context.estimated = true;
          cs.context.usageSource = null;
          cs.context.thinkingStatus = "Idle";
        }
        if (cs) {
          cs.running = {
            active: false,
            prompt: null,
            pid: null,
            startedAt: null,
            model: null,
            sessionId: null,
            lastDeltaAt: null,
            tps: 0,
          };
        }
      },
      persistCurrentChat: () => {},
      streamUpdateLine: (chat, prefix, text) => {
        if (Array.isArray(chat)) chat.push(prefix + text);
        return text;
      },
      cleanupEmptyDefaultSessions: () => {},
    },
  });

  // 5. webui/lib/settings.js
  if (overrides.lanBroadcast !== undefined)
    _lanBroadcast = !!overrides.lanBroadcast;
  if (overrides.readOnly !== undefined) _readOnly = !!overrides.readOnly;
  if (overrides.tokenEnabled !== undefined) _tokenEnabled = !!overrides.tokenEnabled;
  if (overrides.currentToken !== undefined) _currentToken = String(overrides.currentToken || "");
  if (overrides.tokenRotatedAt !== undefined) _tokenRotatedAt = Number(overrides.tokenRotatedAt) || 0;
  if (overrides.tokenAcknowledged !== undefined) _tokenAcknowledged = !!overrides.tokenAcknowledged;
  // v2026-08-28 modacker: Token Plan overrides. Default false/empty
  //   mirrors a clean-disk settings.json (quotaEnabled defaults to
  //   false in defaultState()).
  if (overrides.quotaEnabled !== undefined) _quotaEnabled = !!overrides.quotaEnabled;
  if (overrides.tokenPlanApiKey !== undefined) _tokenPlanApiKey = String(overrides.tokenPlanApiKey || "");
  // maskTokenPlanKey mirrors the real helper: "sk-cp-...XXXX" or "".
  // Reuse the same length-slice rule so a test that asserts on the
  // masked shape matches the real implementation byte-for-byte.
  // v2026-08-28 modacker (A+C): the real implementation now goes
  //   through getTokenPlanApiKey() so the masked value reflects
  //   the priority chain. The mock must do the same — without
  //   this, a test that setEnvTokenPlanKey would still see the
  //   settings.json mask in the snapshot.
  const _effectiveTokenPlanKey = () => {
    if (_envTokenPlanKey) return _envTokenPlanKey
    if (_fileTokenPlanKey) return _fileTokenPlanKey
    return _tokenPlanApiKey
  }
  const _maskTokenPlanKey = () => {
    const k = _effectiveTokenPlanKey()
    if (!k) return "";
    if (k.length <= 4) return "****";
    return "sk-cp-..." + k.slice(-4);
  };
  t.mock.module(absPath("lib/settings.js"), {
    namedExports: {
      getLanBroadcast: () => _lanBroadcast,
      getReadOnly: () => _readOnly,
      getTokenEnabled: () => _tokenEnabled,
      getCurrentToken: () => _currentToken,
      getTokenRotatedAt: () => _tokenRotatedAt,
      getTokenAcknowledged: () => _tokenAcknowledged,
      getAllowedInterfaces: () => [], // stub — feature removed in v1.0.1 cleanup
      // v2026-08-28 modacker: Token Plan feature — state-bus.js
      //   imports these to populate the snapshot. The real
      //   settings.js implements them in lines 302-318.
      // v2026-08-28 modacker (A+C): the mock's getTokenPlanApiKey
      //   mirrors the real priority chain (env > file > settings).
      //   Without this, tests asserting on `hasTokenPlanKey` /
      //   `tokenPlanApiKeySource` would see only the settings.json
      //   path even when an env/file key is "set" via the mutators
      //   above.
      getQuotaEnabled: () => _quotaEnabled,
      getTokenPlanApiKey: () => {
        if (_envTokenPlanKey) return _envTokenPlanKey
        if (_fileTokenPlanKey) return _fileTokenPlanKey
        return _tokenPlanApiKey
      },
      getTokenPlanApiKeySource: () => {
        if (_externalKeySource) return _externalKeySource
        return _tokenPlanApiKey ? "settings" : ""
      },
      getTokenPlanApiKeyFilePath: () => _fileTokenPlanPath,
      maskTokenPlanKey: () => _maskTokenPlanKey(),
      // no-op setters (tests should use the imperative setters above)
      setLanBroadcast: (v) => { _lanBroadcast = !!v },
      setReadOnly: (v) => { _readOnly = !!v },
      setTokenEnabled: (v) => { _tokenEnabled = !!v },
      setTokenAcknowledged: (v) => { _tokenAcknowledged = !!v },
      // v2026-08-28 modacker: Token Plan setters (mutate mock state
      //   like the real ones do).
      setQuotaEnabled: (v) => { _quotaEnabled = !!v; if (!_quotaEnabled) _tokenPlanApiKey = "" },
      setTokenPlanApiKey: (k) => { _tokenPlanApiKey = typeof k === "string" ? k : "" },
      setAllowedInterfaces: (_v) => { /* no-op — feature removed */ },
      rotateToken: () => {
        const t = "testtoken" + Math.random().toString(16).slice(2, 30);
        _currentToken = t;
        _tokenRotatedAt = Date.now();
        _tokenAcknowledged = false;
        return t;
      },
      init: () => {},
      generateToken: () => "testtoken" + Math.random().toString(16).slice(2, 30),
      getPersistPath: () => "/tmp/.mcode-webui/settings.json",
      getSettingsSnapshot: () => ({
        ok: true,
        lanBroadcast: _lanBroadcast,
        readOnly: _readOnly,
        tokenEnabled: _tokenEnabled,
        tokenAcknowledged: _tokenAcknowledged,
        currentToken: _tokenAcknowledged ? "" : _currentToken,
        tokenRotatedAt: _tokenRotatedAt,
        // v2026-08-28 modacker: Token Plan fields in the snapshot —
        //   the real getSettingsSnapshot includes these on lines
        //   534-536. Without them the webui's popover (which reads
        //   `hasTokenPlanKey` / `tokenPlanApiKeyMasked`) would have
        //   no data even when the feature is on.
        quotaEnabled: _quotaEnabled,
        tokenPlanApiKeyMasked: _maskTokenPlanKey(),
        // v2026-08-28 modacker (A+C): hasTokenPlanKey is computed
        //   from the priority-chain getter, not the raw var, so a
        //   test that only setEnvTokenPlanKey still sees
        //   hasTokenPlanKey === true. tokenPlanApiKeySource +
        //   tokenPlanApiKeyFilePath are new in (A+C) and let tests
        //   assert the source is correctly reported in the SSE
        //   snapshot.
        hasTokenPlanKey: (_envTokenPlanKey || _fileTokenPlanKey || _tokenPlanApiKey).length > 0,
        tokenPlanApiKeySource: _envTokenPlanKey ? "env" : (_fileTokenPlanKey ? "file" : (_tokenPlanApiKey ? "settings" : "")),
        tokenPlanApiKeyFilePath: _fileTokenPlanPath,
        port: 8080, host: "0.0.0.0", lanIp: "127.0.0.1",
        lanUrl: "http://127.0.0.1:8080", localUrl: "http://127.0.0.1:8080",
        mcodeCmd: "mcode", mcodeVersion: "0.1.2",
        defaultWorkspace: "/tmp", defaultModel: "x",
      }),
      rejectLan: () => false,
    },
  });

  // 6. webui/lib/mavis-usage.js (heavy: spawns sqlite3)
  //    NOT mocked by default — mavis-usage.test.js wants the real
  //    implementation against the fixture DB. Other tests (chat,
  //    sessions) that need to mock applyMavisUsageToCs pass
  //    overrides.mavis and we register the mock only then.
  if (overrides.mavis) {
    t.mock.module(absPath("lib/mavis-usage.js"), {
      namedExports: {
        getMavisTokenUsage:
          overrides.mavis.getMavisTokenUsage || (async () => null),
        getMavisTokenUsageModel:
          overrides.mavis.getMavisTokenUsageModel || (async () => null),
        applyMavisUsageToCs:
          overrides.mavis.applyMavisUsageToCs || (async () => {}),
        ...overrides.mavis,
      },
    });
  }

  // 7. webui/lib/mcode-{acp,exec,rpc}.js — heavy mcode spawners
  //    mcode-acp dispatches through the mutable _mcodeAcpMock (see its
  //    declaration block) so failed-send tests can inject
  //    {status:"failed"} results via overrides.mcodeAcp or
  //    registerMcodeAcpMock() without a second mock.module call
  //    (ERR_INVALID_STATE on re-registration).
  if (overrides.mcodeAcp) Object.assign(_mcodeAcpMock, overrides.mcodeAcp);
  t.mock.module(absPath("lib/mcode-acp.js"), {
    namedExports: {
      runMcodeAcp: (...a) => _mcodeAcpMock.runMcodeAcp(...a),
      streamAcpPrompt: (...a) => _mcodeAcpMock.streamAcpPrompt(...a),
    },
  });
  t.mock.module(absPath("lib/mcode-exec.js"), {
    namedExports: {
      runMcodeExec: async () => ({
        status: "succeeded",
        answer: "mocked",
        sessionId: null,
      }),
      collectExecResult: async (p) => p,
    },
  });
  t.mock.module(absPath("lib/mcode-rpc.js"), {
    namedExports: {
      cancelSession: async () => ({ ok: false, code: "unsupported" }),
      // v0.5.bx 系列 patch: routes/model.js 也 import 这俩
      mcodePermissionToWebui: () => "Full access",
      PERMISSION_MODES: ["default", "bypassPermissions", "auto", "off"],
      MCODE_ACP_CAPABILITIES: { set_mode: false, set_config_option: false },
      // 其他导出存在即可,默认 no-op
      setMode: async () => ({ ok: false, code: "unsupported" }),
      setConfigOption: async () => ({ ok: false, code: "unsupported" }),
      loadSession: async () => ({ ok: false, code: "unsupported" }),
      activateSession: async () => ({ ok: false, code: "unsupported" }),
      listSessions: async () => [],
      webuiPermissionToMcode: () => "bypassPermissions",
    },
  });
  t.mock.module(absPath("lib/models.js"), {
    namedExports: {
      getMcodeModelLimit: async () => ({ context: 512000 }),
      // v0.5.bx 系列 patch: routes/model.js 也 import 这俩
      getBuiltinModelsFromMcode: () => ["MiniMax-M3", "MiniMax-M2"],
    },
  });
  t.mock.module(absPath("lib/slash.js"), {
    namedExports: {
      handleLocalSlash: async () => ({ handled: false, continueMcode: false }),
      // routes/chat.js imports this too — a missing named export makes the
      // SUT import hang (Node 24.14 mock.module pitfall #4)
      handleCmdCommand: async () => ({ ok: true }),
      // v0.5.bx 系列 patch: lib-slash.test.js tests the real matchSlash
      // — but we still provide a stub for the mocked version
      matchSlash: (content) => {
        const m = content.match(/^\/([a-zA-Z][\w-]*)\b\s*(.*)/);
        if (!m) return null;
        return { cmd: m[1], rest: m[2] || "" };
      },
    },
  });
}

// -----------------------------------------------------------------------
// Decision-injection helper (2026-09-20 rigor fix).
//
// authorize() no longer auto-approves under `node --test` (the
// execArgv branch was removed — it meant no test ever exercised the
// real decision path). Tests that call route handlers which await
// authorize() must now drive the REAL path: this helper polls
// getPendingRequestIds() and resolves each new pending request via
// _decideForTests(id, approve) — exactly what a user's modal click
// does through POST /api/auth/decision, minus the HTTP.
//
// Properties:
//   - Touches ZERO production code (getPendingRequestIds /
//     _decideForTests are authorize.js's existing test surface).
//   - Does NOT depend on --experimental-test-module-mocks — plain
//     dynamic import of the real (or, if a test registered one, the
//     mocked) authorize module. Works in both suite modes.
//   - Robust to handlers that only reach authorize() after an await
//     (e.g. body parsing): a short interval polls while fn() runs.
//
// Usage:
//   const res = await withDecisions(
//     () => handleDeleteSession(fakeReq({}), res, ctx),
//     { approve: true },
//   );
// -----------------------------------------------------------------------
export async function withDecisions(fn, { approve = true } = {}) {
  const mod = await import(absPath("lib/authorize.js"));
  // Defensive: a test may have registered a t.mock.module replacement
  // for authorize.js that doesn't expose the pending-registry helpers
  // (e.g. the fixed-decline stub in routes-sessions-search.test.js).
  // Such stubs resolve immediately — nothing to drive.
  if (
    typeof mod.getPendingRequestIds !== "function" ||
    typeof mod._decideForTests !== "function"
  ) {
    return fn();
  }
  // Requests that were already pending when withDecisions started
  // belong to someone else — only decide requests created by fn().
  const preExisting = new Set(mod.getPendingRequestIds());
  const decided = new Set();
  // Windows event-loop liveness fix (fork preview run 35493902383):
  //   The poll interval MUST stay REF'd. Mock unit tests drive route
  //   handlers with zero real IO, so while fn() awaits authorize() this
  //   interval is the only ref'd handle in the loop. The previous
  //   unref() let the loop drain on windows-latest before the 2 ms poll
  //   could call _decideForTests, and node:test reported "Promise
  //   resolution is still pending but the event loop has already
  //   resolved" + cancelledByParent for the whole routes-export.check
  //   .mjs file (POSIX passed only because incidental IO happened to
  //   hold the loop). Same fix shape as lib-authorize's REF'd watchdog
  //   (run 35493384574) — liveness only, zero assertion change.
  const poll = setInterval(() => {
    for (const id of mod.getPendingRequestIds()) {
      if (decided.has(id) || preExisting.has(id)) continue;
      decided.add(id);
      mod._decideForTests(id, approve);
    }
  }, 2);
  // Safety self-clear: a REF'd interval that outlives a broken test
  // would hang the whole run — if fn() never settles (pending auth
  // requests never decided), release the interval and fail fast at 5 s.
  let bailOut;
  const bail = setTimeout(() => {
    clearInterval(poll);
    bailOut(new Error(
      "withDecisions: fn() did not settle within 5000ms — pending auth requests were never decided (poll interval released, failing instead of hanging)",
    ));
  }, 5000);
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        bailOut = reject;
      }),
    ]);
  } finally {
    clearTimeout(bail);
    clearInterval(poll);
  }
}

// -----------------------------------------------------------------------
// decideNextAuthorization — HTTP-level decision driver for integration
// tests that spawn the REAL server.js in a child process. Subscribes
// to the SSE stream, waits for the next `needs_authorization` frame,
// extracts the requestId, and POSTs /api/auth/decision — the exact
// wire path the production modal uses.
//
// Resolves { requestId, decision } where decision is the parsed
// /api/auth/decision response. Rejects if no auth request arrives
// within `timeoutMs` (default 3s).
//
// IMPORTANT: start this helper BEFORE firing the gated HTTP request
// and allow a short delay for the SSE subscription to register —
// needs_authorization broadcasts are NOT replayed to late subscribers
// (the pending-request SSE frame is fire-once).
// -----------------------------------------------------------------------
export function decideNextAuthorization({ port, approve = true, cid, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    import("node:http").then((http) => {
      // settled:  outer promise has resolved/rejected.
      // deciding: a needs_authorization frame was seen and the decision
      //   POST is in flight — from that point, teardown noise from our own
      //   SSE destroy() must NOT reject the outer promise; the POST's
      //   outcome is the answer.
      let settled = false;
      let deciding = false;
      let sseReq = null;
      let postReq = null;
      // U4 (2026-09-20): settlement guarantee — the bail-out timer now covers
      // BOTH phases (waiting for the SSE frame AND the decision POST). The
      // old code cleared it as soon as the frame arrived, so a server that
      // accepted the POST but never responded left this promise pending
      // forever with no timeout. On fire, everything is destroyed and the
      // promise rejects — waiting sides must never depend on the peer (or
      // incidental event-loop handles) for liveness.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { if (sseReq) sseReq.destroy(); } catch {}
        try { if (postReq) postReq.destroy(); } catch {}
        reject(new Error(
          `decideNextAuthorization: no completed needs_authorization decision within ${timeoutMs}ms`,
        ));
      }, timeoutMs);
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      sseReq = http.request(
        {
          method: "GET",
          host: "127.0.0.1",
          port,
          path: "/api/events" + (cid ? `?cid=${encodeURIComponent(cid)}` : ""),
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (deciding) return; // POST already dispatched; ignore trailing data
            body += chunk;
            // Frames arrive as `event: needs_authorization\ndata: {...}\n\n`.
            // Scan the accumulated body each chunk — cheap at test scale.
            const frames = body.split("\n\n");
            for (const frame of frames) {
              const evMatch = frame.match(/^event: needs_authorization$/m);
              if (!evMatch) continue;
              const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              let payload;
              try { payload = JSON.parse(dataLine.slice("data: ".length)); } catch { continue; }
              const requestId = payload && payload.requestId;
              if (!requestId) continue;
              deciding = true; // decision POST in flight — ignore SSE teardown noise
              try { sseReq.destroy(); } catch {}
              const data = JSON.stringify({ requestId, approve });
              postReq = http.request(
                {
                  method: "POST",
                  host: "127.0.0.1",
                  port,
                  path: "/api/auth/decision",
                  headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data),
                  },
                },
                (postRes) => {
                  const chunks = [];
                  postRes.on("data", (c) => chunks.push(c));
                  postRes.on("end", () => {
                    let decision;
                    try { decision = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
                    settle(resolve, { requestId, decision, status: postRes.statusCode });
                  });
                  postRes.on("error", (e) => {
                    settle(resolve, { requestId, decision: null, status: postRes.statusCode, error: e.message });
                  });
                },
              );
              postReq.on("error", (e) => settle(reject, e));
              postReq.write(data);
              postReq.end();
              return;
            }
          });
          res.on("error", (e) => {
            if (settled || deciding) return; // our own destroy()
            settle(reject, e);
          });
        },
      );
      sseReq.on("error", (e) => {
        if (settled || deciding) return; // our own destroy()
        settle(reject, e);
      });
      sseReq.end();
    }).catch(reject);
  });
}
