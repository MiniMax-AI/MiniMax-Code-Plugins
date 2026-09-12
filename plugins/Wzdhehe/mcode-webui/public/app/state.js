// webui/public/app/state.js — REFACTORING.md batch 4 step 2
// Owns: config consts (TOKEN/CID/API_SUFFIX/HEADERS), the mutable `state`
// binding + its 3 rebinding sites (connect/refreshSessions/refreshUsage),
// SSE connection, panel flags (leftOpen/rightOpen/sidebarReady/
// sessionSearchQuery) with setters, usage quota data + popover surface.
// NOTE: cycles with render.js/events.js are intentional and safe — imported
// bindings are only touched inside functions, never at module eval time.

import { applyI18n, applyTheme, currentLang, setLang, t, toggleTheme } from './i18n.js'
import { MODE_ICONS, __DBG, escapeHtml, formatNumber, formatResetTime, formatTimeUntil, nextFiveHourReset, nextWeeklyReset, parseMarkdown, showToast } from './util.js'
import { ASK_ANSWERS_LS_KEY, ASK_DISMISSED_LS_KEY, ASK_MODAL_STATE, DISMISSED_QUESTIONS, askModalNextOrSend, askModalPqKey, askModalSkip, attachStructuredBlockHandlers, bindAskModal, buildAskUserPrompt, cancelConfirm, clearAskPresentedKeys, closeAskModal, collapsedWorkspaces, collectAskBlock, collectPlanBlock, deleteSession, hideRightForWelcome, loadAskDismissed, loadAskUserAnswers, onAskModalOptClick, onAskModalOtherInput, openAskModal, openPlanModal, parseChatLines, render, renderAskBlock, renderAskModalContent, renderAskUserToolIfChanged, renderChat, renderContext, renderGoal, renderMessage, renderPlanBlock, renderRight, renderSessions, renderTodo, renderUserFooter, resetAskDismissed, saveAskDismissed, saveAskUserAnswers, saveCollapsedWorkspaces, sendAskAnswer, setAskUserAnswer, submitAskModal, suppressAskModal, switchSession, wsShortName } from './render.js'
import { SLASH_COMMANDS, SLASH_SKILLS, attachEvents, attachModalEvents, attachedFiles, attachmentList, autoResize, checkModals, fileInput, filterSlash, hideMode, hidePerm, hidePlan, hidePlanMode, hideSettings, hideSlash, isSending, lastShownPermKey, lastShownPlanKey, lastShownPlanModeKey, modeOpen, modePopover, moveSlash, permOpen, planModeOpen, planOpen, planSending, removeAttachment, renderAttachments, renderPerm, renderPlan, selectSlash, send, sendPermAnswer, sendPlanAnswer, sendPlanModeAnswer, setMode, settingsMenu, showPerm, showPlan, showPlanMode, showSlash, slashActiveIdx, slashFiltered, slashInput, slashOpen, slashOverlay, slashQuery, slashResults, stopExec, toggleLang, toggleMode, toggleSettings, uploadFiles } from './events.js'

// ============================================================
// Config
// ============================================================
// v1.0.1: token 持久化 + URL strip
//   1. 优先用 URL query 里的 ?token=（用户从带 token 的链接进来）
//   2. fallback 到 localStorage（reload / 新 tab 时还在；F5 后 URL 没 token
//      也不会立刻 401）
//   3. 拿到 token 后立刻 history.replaceState 把 ?token= 从 URL 抹掉，
//      避免 token 长期留在地址栏、浏览器 history、Referer header
//   4. 同步写到 localStorage，下次启动继续用
//
// 注意: token 不能 log, 不能 echo back, 不能进 URL fragment, 不能进
// 任何 SSE / API 的 log。SECURITY-NOTES.md §2 完整说明了 trade-off。
const WEBUI_TOKEN_LS_KEY = 'webui_token'

function readToken() {
  // 1. URL ?token= takes precedence (user opening a link)
  const fromUrl = urlParams.get('token')
  if (fromUrl) {
    try { localStorage.setItem(WEBUI_TOKEN_LS_KEY, fromUrl) } catch {}
    return fromUrl
  }
  // 2. localStorage fallback (F5, new tab, deep-link without token)
  try {
    const fromLs = localStorage.getItem(WEBUI_TOKEN_LS_KEY)
    if (fromLs) return fromLs
  } catch {}
  return ''
}

// URL strip — must run exactly once at module load, before any
// fetch / EventSource is created (so the address bar is clean and
// the browser never sends the token via Referer to same-origin assets).
function stripTokenFromUrl() {
  if (!urlParams.has('token')) return
  try {
    const clean = window.location.pathname + (window.location.hash || '')
    window.history.replaceState(null, '', clean)
  } catch {
    // private mode etc. — token is still in localStorage so reload works
  }
}

export const urlParams = new URLSearchParams(window.location.search)
export let TOKEN = readToken()
stripTokenFromUrl() // must run after readToken(), before any fetch/SSE
export let TOKEN_QUERY = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''

// Back-compat: events.js + render.js still import `tokenParam` from
// earlier versions. It's an alias for TOKEN_QUERY (same semantics).
// Kept as a deprecated export to avoid breaking older code that may
// have been depending on it. New code should use TOKEN_QUERY directly.
export const tokenParam = TOKEN_QUERY

// v0.5.ai: A2 per-client — 每个 webui tab 一个 client id (localStorage 持久化)
// 拼到所有 /api/xxx URL query string，server 端按 cid 路由 SSE + state
export const CID = (() => {
  let c = localStorage.getItem('webui_cid')
  if (!c) {
    c = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))
    try { localStorage.setItem('webui_cid', c) } catch {}
  }
  return c
})()
export const CID_QUERY = `cid=${encodeURIComponent(CID)}`
// API_SUFFIX = TOKEN_QUERY (if any) + '&cid=xxx' (or '?cid=xxx' first)
export let API_SUFFIX = TOKEN_QUERY ? `${TOKEN_QUERY}&${CID_QUERY}` : `?${CID_QUERY}`

// v1.0.1: HEADERS is a live object — its properties are mutated in place
// when the token rotates (SSE auth.token_rotated event). All callers use
// the object reference (not a snapshot) so they always read the current
// Authorization header at fetch time. Tokens are NEVER logged (per
// SECURITY-NOTES.md §2).
export const HEADERS = {}
if (TOKEN) HEADERS['Authorization'] = `Bearer ${TOKEN}`

// setToken — called by the SSE handler when server pushes a new token
// (auth.token_rotated). Updates module-level state + localStorage +
// recomputes the URL query suffix. The next fetch() call automatically
// picks up the new header (HEADERS is a live binding).
export function setToken(newToken) {
  const t = (typeof newToken === 'string') ? newToken : ''
  TOKEN = t
  TOKEN_QUERY = t ? `?token=${encodeURIComponent(t)}` : ''
  API_SUFFIX = TOKEN_QUERY ? `${TOKEN_QUERY}&${CID_QUERY}` : `?${CID_QUERY}`
  // Mutate the headers object in place (live binding — all importers
  // see the new Authorization header on their next fetch)
  if (t) {
    HEADERS['Authorization'] = `Bearer ${t}`
  } else {
    delete HEADERS['Authorization']
  }
  // Persist for next reload (covers rotation while the page is open)
  try {
    if (t) localStorage.setItem(WEBUI_TOKEN_LS_KEY, t)
    else localStorage.removeItem(WEBUI_TOKEN_LS_KEY)
  } catch {}
}

// ============================================================
// State
// ============================================================
export let state = null

export let leftOpen = false
export let rightOpen = false

export let sidebarReady = false // v0.5.bx-31: mcodeSessions 首次非空后 true（声明在分段时误删，此处恢复）
export let sessionSearchQuery = ''   // v0.5.x: 侧边栏会话搜索词

// ============================================================
// SSE connection
// ============================================================
export let es = null
export let autoRefreshTimer = null
export function connect() {
  if (es) { try { es.close() } catch {} }
  const url = '/api/events' + API_SUFFIX
  es = new EventSource(url)

  // v1.0.1: named event "auth.token_rotated" — server pushes this when
  // an operator triggers a token rotation. The body is plain text
  // (the new token) — we use it to update localStorage + live HEADERS.
  es.addEventListener('auth.token_rotated', (ev) => {
    try {
      const newToken = (ev.data || '').trim()
      if (!newToken) return
      setToken(newToken)
      console.log('[webui] token rotated (SSE); updated HEADERS + localStorage')
    } catch (e) { console.error('[webui] token rotation handler failed', e) }
  })

  es.onmessage = (ev) => {
    try {
      // v0.5.bx-8: 保留 askUserAnswers (webui-only, server 不存) — SSE 推送整 state 会覆盖
      // v1.0: 同理保留 mcodeSessions — pushOnlineCount 等推送点若缺该字段, 整包替换后
      //   mcodeSessions 变 undefined, 侧栏闪跌; 旧值好过没值
      const preserved = state?.askUserAnswers
      const preservedMcodeSessions = state?.mcodeSessions
      state = JSON.parse(ev.data)
      if (preserved) state.askUserAnswers = preserved
      if (state.mcodeSessions === undefined && Array.isArray(preservedMcodeSessions)) {
        state.mcodeSessions = preservedMcodeSessions
      }
      // v0.5.bx-31 + v1.0: 收到权威 mcodeSessions 推送即 ready。
      //   旧门控要求 length>0 — 工作区会话被全删后列表合法为空, loading 永不消失;
      //   现在用 server 的 mcodeSessionsPending 区分占位推送 (cache miss 空数组) 与权威推送
      if (!sidebarReady && Array.isArray(state.mcodeSessions) && !state.mcodeSessionsPending) {
        console.log('[webui] sidebar ready: mcodeSessions.length=' + state.mcodeSessions.length)
        sidebarReady = true
      }
      render()
    } catch (e) { console.error('sse parse', e) }
  }
  es.onerror = () => { setTimeout(connect, 3000) }
  // v0.5.ak: user footer 已改为静态 GitHub 链接，不需要 ticker

  // 自动 /api/refresh 触发：页面打开 2s + 每 60s 拉一次
  // 避免 web UI 一直显示 "—" / "Loading..."
  const trigger = async () => {
    try { await fetch('/api/refresh' + API_SUFFIX, { method: 'POST', headers: HEADERS }) } catch {}
  }
  setTimeout(trigger, 2000)
  if (autoRefreshTimer) clearInterval(autoRefreshTimer)
  autoRefreshTimer = setInterval(trigger, 60000)
}

export function getGeneralQuota() {
  // 从 state.usage.raw 拿 general 模型的数据（不返回 video）
  const raw = state?.usage?.raw
  let data = null
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch {}
  } else if (raw && typeof raw === 'object') {
    data = raw
  }
  if (!data?.model_remains?.length) return null
  return data.model_remains.find((m) => m.model_name === 'general') || data.model_remains[0] || null
}

export function renderUsagePopover() {
  const body = document.getElementById('usage-popover-body')
  const btn = document.getElementById('usage-popover-refresh')
  if (!body) return
  const g = getGeneralQuota()
  const now = new Date()
  if (!g) {
    body.innerHTML = `<div class="usage-empty">${t('quota_loading_idle')}</div>`
    return
  }
  const ip = g.current_interval_remaining_percent
  const wp = g.current_weekly_remaining_percent
  const ipClass = (typeof ip === 'number' && ip < 20) ? ' low' : ''
  const wpClass = (typeof wp === 'number' && wp < 20) ? ' low' : ''
  const next5h = nextFiveHourReset(now)
  const nextWk = nextWeeklyReset(now)
  body.innerHTML = `
    <div class="usage-row">
      <span class="usage-row-label">${t('quota_5h_limit')}</span>
      <span class="usage-row-value${ipClass}">${ip ?? '—'}% ${t('quota_remaining')}</span>
    </div>
    <div class="usage-reset">${t('quota_next_reset')} ${escapeHtml(formatResetTime(next5h))}（${escapeHtml(formatTimeUntil(next5h, now))}）</div>
    <div class="usage-row">
      <span class="usage-row-label">${t('quota_weekly_limit')}</span>
      <span class="usage-row-value${wpClass}">${wp ?? '—'}% ${t('quota_remaining')}</span>
    </div>
    <div class="usage-reset">${t('quota_next_reset')} ${escapeHtml(formatResetTime(nextWk))}（${escapeHtml(formatTimeUntil(nextWk, now))}）</div>
  `
  if (btn) {
    btn.classList.remove('loading')
    // v0.5.av: 恢复 "Refresh" 文案
    const txt = btn.querySelector('.usage-popover-refresh-text')
    if (txt) txt.textContent = t('refresh')
  }
}

export function renderUsageValue() {
  // 按钮右侧的 value 字段，显示最关键的 5h 剩余%
  const val = document.getElementById('usage-value')
  if (!val) return
  const g = getGeneralQuota()
  if (!g || typeof g.current_interval_remaining_percent !== 'number') {
    val.textContent = '—'
    val.classList.remove('low')
    return
  }
  const ip = g.current_interval_remaining_percent
  // v0.5.aa: 加 "剩余" 后缀让"已用"和"剩余"语义明确（用户反馈）
  val.textContent = `${ip}% ${t('quota_remaining')}`
  if (ip < 20) val.classList.add('low')
  else val.classList.remove('low')
}

export function renderUsage() {
  renderUsageValue()
  // 弹层只在打开时才更新内容（避免每秒重算浪费）
  const popover = document.getElementById('usage-popover')
  if (popover && !popover.hidden) renderUsagePopover()
}

export function toggleUsagePopover(forceState) {
  const popover = document.getElementById('usage-popover')
  const btn = document.getElementById('btn-usage')
  if (!popover || !btn) return
  const willOpen = typeof forceState === 'boolean' ? forceState : popover.hidden
  popover.hidden = !willOpen
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
  if (willOpen) {
    // 打开时立即刷新一次（让时间显示是新的）
    refreshUsage()
  }
}

export async function refreshUsage(opts = {}) {
  const isManual = opts.manual === true
  const btn = document.getElementById('usage-popover-refresh')
  if (btn) {
    btn.classList.add('loading')
    // v0.5.av: loading 态显示 i18n 文案（避开 CSS ::before content 难 i18n）
    const txt = btn.querySelector('.usage-popover-refresh-text')
    if (txt) {
      txt.textContent = t('quota_loading_idle') === '点击套餐用量加载…' ? '加载中…' : 'Loading…'
    }
  }
  // v0.5.au: 改用 postTime 标记（Date.now()），避免 initial /api/state 提前 break wait loop
  // 之前用 beforeFetchedAt 比较的 bug：state 加载完成后 fetchedAt 任意变化都会 break，可能误判
  const postTime = Date.now()
  try {
    await fetch('/api/usage' + API_SUFFIX, { method: 'POST', headers: HEADERS })
    // 等真实数据到来（fetchedAt 必须 > postTime）才停转 + toast
    // v0.5.bb: deadline 18s > server 端 mmx quota 15s 超时（确保 mmx 跑完后 pushStateFor 的 fetchedAt > postTime）
    const deadline = Date.now() + 18_000
    let gotSseUpdate = false
    while (Date.now() < deadline) {
      const fetchedAt = state?.usage?.fetchedAt
      if (typeof fetchedAt === 'number' && fetchedAt > postTime) { gotSseUpdate = true; break }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!gotSseUpdate) {
      // SSE 没收到（典型场景：init 时 EventSource 还在 CONNECTING）
      // 兜底轮询 /api/state（每 1.5s 一次直到 deadline）— 避免 mmx 慢的情况下拿不到数据
      const fallbackDeadline = Date.now() + 8_000
      while (Date.now() < fallbackDeadline) {
        try {
          const r2 = await fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
          if (r2.ok) {
            state = await r2.json()
            const fa = state?.usage?.fetchedAt
            if (typeof fa === 'number' && fa > postTime) { gotSseUpdate = true; break }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    // 兜底 render
    render()
    const fetchedAt = state?.usage?.fetchedAt
    if (!(typeof fetchedAt === 'number' && fetchedAt > postTime)) {
      // 没拿到新数据
      if (isManual) showToast(t('quota_loading_fail') + '（超时）')
    } else if (isManual) {
      showToast(t('usage_refreshed'))
    }
  } catch (e) {
    const body = document.getElementById('usage-popover-body')
    if (body) body.innerHTML = `<div class="usage-error">${t('quota_loading_fail')}：${escapeHtml(e.message || String(e))}</div>`
    if (isManual) showToast(t('quota_loading_fail') + '：' + (e.message || String(e)))
  } finally {
    if (btn) {
      btn.classList.remove('loading')
      // v0.5.av: 恢复 "Refresh" 文案
      const txt = btn.querySelector('.usage-popover-refresh-text')
      if (txt) txt.textContent = t('refresh')
    }
  }
}

// v0.5.bb: 全局 toast 通知

// ---- sessions data sync (rebinds state; must own the binding) ----
export async function refreshSessions() {
  const btn = document.getElementById('btn-refresh-sessions')
  if (btn) { btn.disabled = true; btn.classList.add('loading') }
  try {
    // 双通道：先 mavis CLI（独立、快），再 mcode /sessions（兜底）
    let got = false
    try {
      const r = await fetch('/api/sessions' + API_SUFFIX, { method: 'GET', headers: HEADERS })
      if (r.ok) {
        const data = await r.json()
        if (data.ok && data.sessions && data.sessions.length > 0) {
          state = state || {}
          state.sessions = data.sessions
          render()
          got = true
        }
      }
    } catch {}
    if (!got) {
      // fallback: 触发 mcode /sessions
      try { await fetch('/api/sessions' + API_SUFFIX, { method: 'POST', headers: HEADERS }) } catch {}
    }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading') }
  }
}

// ---- cross-module setters (ESM live bindings are read-only from importers) ----
export function setState(s) { state = s }
export function setSidebarReady(v) { sidebarReady = v }
export function setLeftOpen(v) { leftOpen = v }
export function setRightOpen(v) { rightOpen = v }
export function setSearchQuery(q) { sessionSearchQuery = q }
