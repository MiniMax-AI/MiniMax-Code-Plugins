// mcode-webui HTTP/SSE server — bootstrap.
//
// All actual logic lives in server/lib/* + server/routes/* + server/router.js.
// This file only wires up:
//   - installGlobalErrorHandlers (uncaughtException / unhandledRejection)
//   - preflight checks (mcode.cmd exists, upload dir)
//   - initSettings() — load persistent settings, generate default token if needed
//   - http.createServer(handleRequest) + listen
//   - SIGINT / SIGTERM cleanup (close ACP singleton, close server)
//
// API surface is unchanged from the original monolithic server.js — see server/router.js
// for the URL → handler mapping.
//
// Run from inside the .minimax-code root:
//   cd ~/.minimax-code/webui
//   node server.js

import http from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'

import { installGlobalErrorHandlers, MCODE_CMD, UPLOAD_DIR, PORT, HOST, DEFAULT_MODEL, DEFAULT_WORKSPACE, SESSIONS_DB } from './server/lib/config.js'
import { LAN_IP } from './server/lib/lan.js'
import { handleRequest } from './server/router.js'
import { runStartupCleanup } from './server/cleanup.js'
import { shutdownMcodeAcpSingleton } from './server/lib/acp-client.js'
import { init as initSettings, getPersistPath, getTokenEnabled } from './server/lib/settings.js'
import { setTokenAuthEnabled as setAuthTokenEnabled } from './server/lib/auth.js'

installGlobalErrorHandlers()

// v0.5.ai: preflight — uploads 目录必须能写
// v1.0: mcode 不在已知位置时降级启动 (UI/静态资源仍可用, mcode 相关功能请求时报错) —
//   之前直接 process.exit(1), 插件装到非 .minimax-code 布局的目录时整包不可用
if (!existsSync(MCODE_CMD) && MCODE_CMD !== 'mcode') {
  console.warn(`[webui] mcode.cmd not found at ${MCODE_CMD} — chat features will fail; set MCODE_CMD or install mcode`)
}
mkdirSync(UPLOAD_DIR, { recursive: true })

runStartupCleanup()

// v1.0.1: 初始化 settings (load from disk, generate default token if needed,
//   sync auth module). The printToken callback fires ONLY on first-ever
//   startup (when the token didn't exist on disk). After that, the token
//   value lives only in the settings file; if the operator rotates via
//   the settings card, the new value is broadcast over SSE and shown in
//   the settings card until acknowledged.
let _printedFirstToken = false
initSettings({
  printToken: (token) => {
    if (_printedFirstToken) return
    _printedFirstToken = true
    // Print to stdout, NOT to .server.log — operators running interactively
    // can copy/paste; headless / service-mode users can `cat` the settings
    // file at the path printed below.
    const url = `http://${LAN_IP}:${PORT}/?token=${token}`
    console.log('')
    console.log('==============================================================')
    console.log('  webui 首次启动 — 已生成新的鉴权 token')
    console.log('==============================================================')
    console.log(`  token:   ${token}`)
    console.log(`  远程 URL: ${url}`)
    console.log('')
    console.log(`  提示: token 已持久化到 ${getPersistPath()}`)
    console.log('         远程设备必须通过该 URL (含 ?token=) 访问')
    console.log('         本机访问 (127.0.0.1) 无需 token')
    console.log('==============================================================')
    console.log('')
  },
})
// Sync tokenAuth master switch from settings → auth module
setAuthTokenEnabled(getTokenEnabled())

const server = http.createServer(handleRequest)
server.listen(PORT, HOST, () => {
  console.log(`[webui] listening on http://${HOST}:${PORT}`)
  console.log(`[webui] LAN url: http://${LAN_IP}:${PORT}`)
  console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
  console.log(`[webui] default model: ${DEFAULT_MODEL}`)
  console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
  console.log(`[webui] uploads: ${UPLOAD_DIR}`)
  console.log(`[webui] sessions: ${SESSIONS_DB}`)
  console.log(`[webui] settings: ${getPersistPath()}`)
})

process.on('SIGINT', () => {
  console.log('[webui] SIGINT, shutting down...')
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  console.log('[webui] SIGTERM, shutting down...')
  shutdownMcodeAcpSingleton()
  server.close(() => process.exit(0))
})
