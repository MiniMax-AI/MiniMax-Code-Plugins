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
};

let _sessionsStore = [];
let _saveImpl = (arr) => {
  _sessionsStore = [...arr];
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
      resetContext: (cs) => {
        if (cs && cs.context) {
          cs.context.tokens = 0;
          cs.context.used = 0;
          cs.context.percent = 0;
          cs.context.estimated = true;
          cs.context.usageSource = null;
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
  t.mock.module(absPath("lib/mcode-acp.js"), {
    namedExports: {
      runMcodeAcp: async () => ({
        status: "succeeded",
        answer: "mocked",
        sessionId: null,
      }),
      streamAcpPrompt: async () => ({ status: "succeeded", answer: "mocked" }),
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
