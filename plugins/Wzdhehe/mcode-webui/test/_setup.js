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
  t.mock.module(absPath("lib/settings.js"), {
    namedExports: {
      getLanBroadcast: () => _lanBroadcast,
      getReadOnly: () => _readOnly,
      getTokenEnabled: () => _tokenEnabled,
      getCurrentToken: () => _currentToken,
      getTokenRotatedAt: () => _tokenRotatedAt,
      getTokenAcknowledged: () => _tokenAcknowledged,
      getAllowedInterfaces: () => [], // stub — feature removed in v1.0.1 cleanup
      // no-op setters (tests should use the imperative setters above)
      setLanBroadcast: (v) => { _lanBroadcast = !!v },
      setReadOnly: (v) => { _readOnly = !!v },
      setTokenEnabled: (v) => { _tokenEnabled = !!v },
      setTokenAcknowledged: (v) => { _tokenAcknowledged = !!v },
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
