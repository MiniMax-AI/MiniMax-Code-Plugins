// webui/public/app/main.js — bootstrap (REFACTORING.md batch 4 step 2)
// All app logic lives in i18n/util/state/render/events; this file only
// orchestrates startup. Debug-log panel installs itself from util.js.
import { applyI18n, applyTheme } from './i18n.js'
import { API_SUFFIX, HEADERS, state, connect, renderUsagePopover, refreshSessions, refreshUsage, setState } from './state.js'
import { render, DISMISSED_QUESTIONS, loadAskUserAnswers } from './render.js'
import { attachEvents, attachModalEvents } from './events.js'


// ============================================================
// Init
// ============================================================
function init() {
  console.log('[webui] init: applyTheme/I18n start')
  applyTheme()
  applyI18n()
  console.log('[webui] init: applyTheme/I18n done')
  // v0.5.bx-8: 从 localStorage 恢复已答状态, 避免刷新后按钮重新可点
  if (!state) setState({})
  state.askUserAnswers = loadAskUserAnswers()
  // v0.5.bx-15 (改 #3): 恢复 DISMISSED_QUESTIONS — 从 state.askUserAnswers 重建
  //   切到任何 session, 这些 question 都不再弹
  try {
    for (const q of Object.keys(state.askUserAnswers || {})) {
      if (q) DISMISSED_QUESTIONS.add(q)
    }
  } catch (e) {}
  // v0.5.bx-20: 不再恢复 askUserDismissed 标志 — 关掉即关掉, reload 后弹窗默认能正常弹
  //   v0.5.bx-15 改 #3 (loadAskDismissed) 移除 (保留函数定义兼容, 不再调用)
  // v0.5.bh: 标记当前是不是本机（仅本机显示 chip-lan，LAN 设备上隐藏）
  const host = location.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || host === '0.0.0.0'
  if (!isLocal) document.body.classList.add('is-remote')
  connect()
  attachEvents()
  // Fetch initial state
  console.log('[webui] init: fetch /api/state')
  fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
    .then(r => r.json())
    .then(s => { setState(s); console.log('[webui] init: state loaded, sessions=' + (s.sessions ? s.sessions.length : 'null')); render() })
    .catch(e => { console.error('[webui] init: /api/state FAIL', e); document.title = '⚠ /api/state FAIL' })
  // v0.4.1: 启动后自动拉一次 sessions 列表（mavis CLI 路径，不走 mcode）
  // v0.5.x: 改成立即拉，不延时轮询（避免刷新图标一直转的视觉噪音）
  refreshSessions()
  console.log('[webui] init: refreshSessions called')
  // v0.5.z: 启动后自动拉一次 quota（mmx quota show 直拉，按钮 value 用）
  refreshUsage()
  // v0.5.z: 定时刷新 popover 的本机时间倒计时（30s 一次，避免分钟级过期）
  setInterval(() => {
    const popover = document.getElementById('usage-popover')
    if (popover && !popover.hidden) renderUsagePopover()
  }, 30_000)
  // v0.5.aa: /usage 静默查询，每 2 分钟自动刷一次（按钮 value + 弹层用，chat 不污染）
  setInterval(refreshUsage, 2 * 60_000)
}


// Start
// v0.5.bx-31: 删 send() 里基于 pendingAskUser 的 Q/A 模板化兜底 + render 时设 pendingAskUser; chat 发消息永远不被套
// v0.5.bx-28: ask_user 弹窗 X / Esc / 背景 = 彻底放弃, 不发 Q/A 给 mcode; 防御性清 pendingAskUser
// v0.5.bx-27: 启动日志 + JS 错误捕获 — 让 reload 后能立刻看到 fatal error
console.log('[webui] init start, version=v1.0.0, build=2026-08-22')
window.addEventListener('error', (e) => {
  console.error('[webui FATAL]', e.error?.stack || e.message, '@', e.filename + ':' + e.lineno + ':' + e.colno)
  document.title = '⚠ JS ERR: ' + (e.error?.message || e.message).substring(0, 50)
})
try {
  init()
  attachModalEvents()
  console.log('[webui] init done')
} catch (e) {
  console.error('[webui INIT FATAL]', e?.stack || e?.message || e)
  document.body.innerHTML = '<pre style="color:red;padding:20px;font-size:14px;">⚠ webui JS 初始化失败:\n\n' + (e?.stack || e?.message || JSON.stringify(e)) + '\n\n请截图给开发</pre>'
  throw e
}

