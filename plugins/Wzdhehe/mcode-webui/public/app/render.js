// webui/public/app/render.js — REFACTORING.md batch 4 step 2
// Owns: all render* functions, session list + actions, chat message
// parsing/rendering, ask-modal cluster, collapsed-workspace prefs.

import { applyI18n, applyTheme, currentLang, setLang, t, toggleTheme } from './i18n.js'
import { MODE_ICONS, __DBG, escapeHtml, formatNumber, formatResetTime, formatTimeUntil, nextFiveHourReset, nextWeeklyReset, parseMarkdown, showToast } from './util.js'
import { setLeftOpen, setRightOpen, API_SUFFIX, sidebarReady, CID, CID_QUERY, HEADERS, TOKEN, TOKEN_QUERY, autoRefreshTimer, connect, es, getGeneralQuota, leftOpen, refreshUsage, renderUsage, renderUsagePopover, renderUsageValue, rightOpen, sessionSearchQuery, setSearchQuery, setSidebarReady, setState, state, toggleUsagePopover, tokenParam, urlParams } from './state.js'
import { SLASH_COMMANDS, SLASH_SKILLS, attachEvents, attachModalEvents, attachedFiles, attachmentList, autoResize, checkModals, fileInput, filterSlash, hideMode, hidePerm, hidePlan, hidePlanMode, hideSettings, hideSlash, isSending, lastShownPermKey, lastShownPlanKey, lastShownPlanModeKey, modeOpen, modePopover, moveSlash, permOpen, planModeOpen, planOpen, planSending, removeAttachment, renderAttachments, renderPerm, renderPlan, selectSlash, send, sendPermAnswer, sendPlanAnswer, sendPlanModeAnswer, setMode, settingsMenu, showPerm, showPlan, showPlanMode, showSlash, slashActiveIdx, slashFiltered, slashInput, slashOpen, slashOverlay, slashQuery, slashResults, stopExec, toggleLang, toggleMode, toggleSettings, uploadFiles } from './events.js'

// v0.5.ax: 欢迎页时隐藏右侧栏（chat-area 居中铺满）
export function hideRightForWelcome(isWelcome) {
  const rp = document.getElementById('right-panel')
  if (!rp) return
  if (isWelcome) {
    rp.classList.add('welcome-hidden')
    // 同时关掉右侧栏展开状态（避免下次的"显示按钮"逻辑不一致）
    setRightOpen(false)
    rp.classList.remove('open')
  } else {
    rp.classList.remove('welcome-hidden')
  }
}


// ============================================================
// Render
// ============================================================
export function render() {
  if (!state) return
  // v0.5.ap: chip-lan — 局域网访问状态（替 v0.5.ak 的 chip-status "空闲"）
  // v0.5.at: 跟其他 btn-menu 同结构，value 位置显示 开/关
  const lanBroadcast = state.lanBroadcast !== false  // 缺省 true
  const lanChip = document.getElementById('chip-lan')
  const lanValue = document.getElementById('chip-lan-value')
  if (lanChip) {
    lanChip.setAttribute('data-lan', lanBroadcast ? 'on' : 'off')
    lanChip.title = lanBroadcast ? t('lan_title_on') : t('lan_title_off')
  }
  if (lanValue) {
    lanValue.textContent = lanBroadcast ? t('lan_on') : t('lan_off')
    lanValue.setAttribute('data-i18n', lanBroadcast ? 'lan_on' : 'lan_off')
  }
  // v0.5.bp: 顶栏 LAN 链接 chip — LAN on 时显示当前 IP，off 时隐藏
  const chipLanLink = document.getElementById('chip-lan-link')
  if (chipLanLink) {
    chipLanLink.hidden = !lanBroadcast
  } else {
    console.warn('[lan] render: chip-lan-link element NOT found in DOM')
  }

  // v1.0.1: 同步 sub-card 内容 (即使卡片是 hidden 状态, 也更新 input value
  // 这样打开时是新鲜的)
  renderLanCardContent({
    lanBroadcast,
    readOnly: state.readOnly === true,
    tokenEnabled: state.tokenEnabled !== false,
    tokenAcknowledged: state.tokenAcknowledged === true,
    currentToken: state.currentToken || '',
  })

  // v0.5.aa: TPS 还在用
  const tpsEl = document.getElementById('chip-tps')

  // v0.5.ak: 在线 webui tab 数（server sseByCid.size）
  // v0.5.bh: 走 i18n（zh: 1 台, en: 1 dev），离线时显示红点 + "offline" 文案
  const onlineCount = state.onlineCount || 1
  const isOnline = navigator.onLine !== false  // 浏览器没主动报 false = 算在线
  const onlineText = isOnline
    ? (onlineCount === 1 ? t('chip_online_single') : t('chip_online_plural').replace('{n}', onlineCount))
    : t('chip_offline')
  const onlineDot = isOnline ? '🟢' : '🔴'
  const chipOnline = document.getElementById('chip-online')
  if (chipOnline) {
    chipOnline.querySelector('span:first-child').textContent = onlineDot
    chipOnline.querySelector('#chip-online-text').textContent = onlineText
  }

  // v1.0.1: 只读模式 top-bar chip — 醒目的红色双语 chip, server readOnly=true
  // 时所有 client (包括本机) 都看得到, 远程 client 一眼就知道现在不能 send / delete
  const chipReadonly = document.getElementById('chip-readonly')
  if (chipReadonly) {
    chipReadonly.hidden = !(state && state.readOnly === true)
  }

  // v0.5.aa: chat 底部思考中指示器 + send 按钮 → stop 按钮
  const isRunning = state.running?.active === true
  const chatThinkingEl = document.getElementById('chat-thinking')
  if (chatThinkingEl) {
    chatThinkingEl.hidden = !isRunning
  }
  const btn = document.getElementById('btn-send')
  if (btn) {
    if (isRunning) {
      btn.classList.add('is-stop')
      btn.title = t('btn_stop_title')
      btn.disabled = false
    } else {
      btn.classList.remove('is-stop')
      btn.title = t('btn_send_title')
    }
  }

  if (state.context?.tps) {
    if (tpsEl) tpsEl.hidden = false
    document.getElementById('tps-value').textContent = state.context.tps
  } else {
    if (tpsEl) tpsEl.hidden = true
  }

  // Version
  if (state.version) document.getElementById('version').textContent = 'v' + state.version

  // Workspace — v0.5.ax: 顶栏 chip 挪到 chat-empty 欢迎页（启动对话后 chip 隐藏）
  // v0.5.bb: 默认 workspace 可以是 null（用户没选），chip 显示 "未选择" + 提示选工作区
  const wsDir = state.workspace?.dir
  const wsText = wsDir
    ? (() => { const parts = wsDir.split(/[\\\/]/).filter(Boolean); return parts[parts.length - 1] || wsDir })()
    : t('workspace_unset_text')
  const wsEl = document.getElementById('workspace-text')
  if (wsEl) wsEl.textContent = wsText
  const emptyWs = document.getElementById('chat-empty-ws-text')
  if (emptyWs) {
    emptyWs.textContent = wsText
    const btn = document.getElementById('chat-empty-workspace')
    if (btn) btn.title = wsDir || t('workspace_picker_hint')
  }

  // Right panel
  renderRight()

  // Model + mode in input
  if (state.model?.name) {
    const shortName = state.model.name.split('/').pop() || state.model.name
    document.getElementById('model-label').textContent = shortName
    document.getElementById('r-model').textContent = state.model.name
  }
  if (state.model?.ctx) document.getElementById('r-ctx').textContent = state.model.ctx
  if (state.model?.thinking) document.getElementById('r-thinking').textContent = state.model.thinking

  // Workspace right
  if (state.workspace?.dir) document.getElementById('r-dir').textContent = state.workspace.dir
  if (state.workspace?.branch) document.getElementById('r-branch').textContent = state.workspace.branch
  if (state.workspace?.tree) document.getElementById('r-tree').textContent = state.workspace.tree

  // Session right
  // v0.5.bx: 优先显示 mcode session id (mvs_xxx)，fallback webui randomUUID
  const rightId = state?.mcodeSessionId || state?.sessionId
  if (rightId) document.getElementById('r-session-id').textContent = rightId
  if (state.sessionTitle) document.getElementById('r-session-title').textContent = state.sessionTitle

  // Permissions → mode label + icon
  if (state.permissions) {
    let modeLabel = 'Default'
    let modeIcon = 'shield'  // full access default
    if (/完全|full/i.test(state.permissions)) { modeLabel = t('mode_full'); modeIcon = 'shield' }
    else if (/ask|询问/i.test(state.permissions)) { modeLabel = t('mode_ask'); modeIcon = 'help' }
    else if (/auto|自动/i.test(state.permissions)) { modeLabel = t('mode_auto'); modeIcon = 'check' }
    else if (/read|只读/i.test(state.permissions)) { modeLabel = t('mode_read'); modeIcon = 'eye' }
    document.getElementById('mode-label').textContent = modeLabel
    const iconEl = document.getElementById('mode-icon')
    if (iconEl) iconEl.innerHTML = MODE_ICONS[modeIcon] || MODE_ICONS.shield
  }

  // Context right (real-time usage + TPS)
  renderContext()

  // Goal (dynamic)
  renderGoal()

  // Todo (dynamic)
  renderTodo()

  // User footer: v0.5.ak 改为 GitHub 链接（静态，不需要 render）

  // Sessions list (左栏 RECENT)
  renderSessions()

  // Quota card (左下角, btn-menu 风格 + popover, mmx 直拉 + 本机时间)
  renderUsage()

  // Chat
  renderChat()

  // Modals (v0.4.0)
  checkModals()
}

export function renderRight() {
  // SESSION / MODEL / WORKSPACE 已在 render() 里单独处理
  // 这里只处理 mode popover 的 active 高亮
  document.querySelectorAll('.mode-popover-item').forEach(el => {
    const mode = el.getAttribute('data-mode')
    const perm = (state?.permissions || '').toLowerCase()
    el.classList.toggle('active',
      (mode === 'full' && /完全|full/.test(perm)) ||
      (mode === 'ask' && /ask|询问/.test(perm)) ||
      (mode === 'auto' && /auto|自动/.test(perm)) ||
      (mode === 'plan' && !!state?.planMode)  // v0.5.bx-9: Plan 模式 webui 本地 toggle
    )
  })
  // v0.5.bx-9: Plan 模式激活时, btn-mode 顶栏按钮加 active 视觉提示
  const btnMode = document.getElementById('btn-mode')
  if (btnMode) btnMode.classList.toggle('active-plan', !!state?.planMode)
}

export function renderContext() {
  const ctx = state?.context || {}
  const spent = ctx.spent || ctx.tokens || 0
  const limit = parseInt(ctx.limit || state?.model?.ctx || 0, 10) || 0
  const percent = ctx.percent || (limit > 0 ? Math.min(100, (spent / limit) * 100) : 0)
  // v0.5.bx-9: mcode 0.1.4 acp 不发 usage_update, server 端用 thinking+answer 长度估算 (粗略)
  //   显示数字 + `~` 前缀, tooltip 说明是估算; 0.1.5+ 返 usage 时 ctx.estimated = false, 自动去掉 ~
  // v0.5.bx-10: mavis desktop db 也存了真实 token usage (local_runtime_token_usage 表)
  //   server 端在 streamAcpPrompt finalize 后 400ms 自动查 mavis db, 拿到真值会覆盖估算
  //   数据源: ctx.usageSource ('mavis-db' | 'mcode-rusage' | 'estimate')
  const isEstimated = ctx.estimated === true
  const usageSource = ctx.usageSource || (isEstimated ? 'estimate' : 'mcode-rusage')
  const hasData = spent > 0
  // v0.5.bx-20: used 显示 "264.9k/512k" 格式 (used / limit) — Wzdhehe 反馈
  //   之前只显示 used 数字 + 下面 progress bar + percent
  //   现在把限额拼到数字后面, 一眼看到 used 占 limit 的比例
  //   没有 limit (model 未识别) 时降级为只用数字
  const usedText = hasData
    ? `${isEstimated ? '≈' : ''}${formatNumber(spent)}${limit > 0 ? '/' + formatNumber(limit) : ''}`
    : '—'
  document.getElementById('r-used').textContent = usedText
  document.getElementById('r-used').title = hasData
    ? (isEstimated
        ? '估算值 (mcode 0.1.4 不返 usage, 基于输出文本长度 / 3 估算 token; 0.1.5+ 自动用真值)'
        : (usageSource === 'mavis-db'
            ? '真实用量 (来自 mavis 桌面端 sqlite: local_runtime_token_usage 表, mcode 调 LLM 时自动记录)'
            : '真实用量 (mcode 0.1.5+ 返 usage)'))
    : '暂无数据 (还没跑过任务)'
  // v0.5.bx-10: 数据源 badge — 显示 "估算" / "mavis db" / "mcode" 帮用户知道真假
  const srcEl = document.getElementById('r-usage-source')
  if (srcEl) {
    if (hasData) {
      srcEl.style.display = ''
      srcEl.textContent = usageSource === 'mavis-db' ? 'mavis db' : (isEstimated ? '估算' : 'mcode')
      srcEl.title = usageSource === 'mavis-db'
        ? '数据源: mavis 桌面端 sqlite db (C:\\Users\\you\\.minimax\\v2\\sqlite\\runtime-state.sqlite)'
        : (isEstimated
            ? '估算: mcode 0.1.4 不返 usage, 临时估算'
            : '数据源: mcode 0.1.5+ 直接返回的 usage')
      srcEl.className = 'kv-usage-source ' + (usageSource === 'mavis-db' ? 'real' : (isEstimated ? 'estimate' : 'mcode'))
    } else {
      srcEl.style.display = 'none'
    }
  }
  // v0.5.bx-10: mavis model — 拿不到就隐藏
  const mdlEl = document.getElementById('r-mavis-model')
  if (mdlEl) {
    const m = state?.usage?.mavisModel
    if (hasData && m) {
      mdlEl.style.display = ''
      mdlEl.textContent = m
      mdlEl.title = `mavis db 记录的真实 model (mavis db model 字段)`
    } else {
      mdlEl.style.display = 'none'
    }
  }
  // v0.5.bx-10: cache chip — 显示多少 token 是从 cache 来的 (input 的子集, 不算 context)
  // v0.5.bx-20: 主显示改 "cache 89%" 命中率, hover 显示详细数字 — Wzdhehe 反馈
  //   mavis db schema: input_tokens = "新" input, cache_read_tokens = 从 cache 读, 真实 total = 两者之和
  //   真实命中率 = cache_read / (input + cache_read) — server 算好塞 cs.usage.sessionCacheHitRate
  const cacheEl = document.getElementById('r-cache-read')
  if (cacheEl) {
    const cr = state?.usage?.sessionCacheRead
    const cw = state?.usage?.sessionCacheWrite
    const hitRate = state?.usage?.sessionCacheHitRate
    if (hasData && (cr > 0 || cw > 0)) {
      cacheEl.style.display = ''
      // 主显示: 命中率 (重点) + 数字 ↓
      // v0.5.bx-20 (改): 用 i18n key r_cache 跟其他 label 走 — zh="缓存 70%", en="cache 70%"
      //   命中率有值就显示 "缓存 70%", 没有就降级显示原 "缓存 ↓609.9k"
      const cacheLabel = t('r_cache') || 'cache'
      if (typeof hitRate === 'number' && hitRate > 0) {
        const pct = Math.round(hitRate * 100)
        cacheEl.textContent = `${cacheLabel} ${pct}%`
      } else {
        let parts = []
        if (cr > 0) parts.push(`↓${formatNumber(cr)}`)
        if (cw > 0) parts.push(`↑${formatNumber(cw)}`)
        cacheEl.textContent = `${cacheLabel} ${parts.join('/')}`
      }
      // hover: 显示详细 — 命中率公式 + 数字
      let titleParts = []
      if (typeof hitRate === 'number' && hitRate > 0) {
        titleParts.push(`真实 cache 命中率 (累计): ${(hitRate * 100).toFixed(1)}% = cache_read / (input + cache_read)`)
      }
      if (cr > 0) titleParts.push(`↓ ${formatNumber(cr)} tokens 从 cache 读 (input 子集, 不计入 context)`)
      if (cw > 0) titleParts.push(`↑ ${formatNumber(cw)} tokens 写入 cache`)
      cacheEl.title = titleParts.join('\n')
    } else {
      cacheEl.style.display = 'none'
    }
  }
  document.getElementById('r-percent').textContent = hasData
    ? (limit > 0 ? `${percent.toFixed(1)}%` : '—')
    : '—'
  const bar = document.getElementById('r-context-bar')
  if (bar) {
    bar.style.width = hasData ? `${Math.min(100, percent)}%` : '0%'
    bar.classList.remove('high', 'danger', 'estimated')
    if (hasData && percent > 80) bar.classList.add('danger')
    else if (hasData && percent > 50) bar.classList.add('high')
    if (hasData && isEstimated) bar.classList.add('estimated')
  }

  document.getElementById('r-tps').textContent = ctx.tps || '—'
}

export function renderGoal() {
  const section = document.getElementById('r-goal-section')
  const g = state?.goal
  if (g && g.active) {
    section.hidden = false
    const status = g.status || 'Active'
    const badge = document.getElementById('r-goal-status')
    badge.textContent = t(status === 'Active' ? 'goal_active' : status === 'Complete' ? 'goal_complete' : status === 'Paused' ? 'goal_paused' : status)
    badge.classList.toggle('complete', status === 'Complete')
    badge.classList.toggle('paused', status === 'Paused')
    document.getElementById('r-goal-text').textContent = g.text || '—'
    document.getElementById('r-goal-duration').textContent = g.duration ? `已运行 ${g.duration}` : ''
  } else {
    section.hidden = true
  }
}

export function renderTodo() {
  const section = document.getElementById('r-todo-section')
  const list = state?.todo || []
  if (list.length > 0) {
    section.hidden = false
    const html = list.map(item => `
      <div class="todo-item ${item.status}">
        <span class="todo-marker">${item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '○'}</span>
        <span class="todo-text">${escapeHtml(item.text)}</span>
      </div>
    `).join('')
    document.getElementById('r-todo-list').innerHTML = html
  } else {
    section.hidden = true
  }
}

// v0.5.ar: 已折叠的工作区（localStorage 持久化）
export let collapsedWorkspaces = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('webui_ws_collapsed_v1') || '[]')) } catch { return new Set() }
})()

// v1.0.1: 渲染 LAN sub-card (#lan-card) 的内容. 接收 settings 对象
// (从 SSE push 或 fetch /api/settings) 并更新各 input / token value /
// 接口 checklist. 即使卡片 hidden 也调用 — 这样打开时已经是最新值.
//
// 注意: token 渲染走 textContent 不用 innerHTML 防 XSS (SECURITY-NOTES.md §2).
export function renderLanCardContent(s) {
  if (!s) return
  const lanCard = document.getElementById('lan-card')
  if (!lanCard) return  // DOM 还没准备好 (在 app 启动前调用)
  const lanCardBroadcast = document.getElementById('lan-card-broadcast')
  const lanCardReadonly = document.getElementById('lan-card-readonly')
  const lanCardTokenAuth = document.getElementById('lan-card-token-auth')
  const lanCardTokenMask = document.getElementById('lan-card-token-mask')
  const lanCardTokenValue = document.getElementById('lan-card-token-value')
  const lanCardTokenWarning = document.getElementById('lan-card-token-warning')
  const lanCardTokenAck = document.getElementById('lan-card-token-ack')

  if (lanCardBroadcast) lanCardBroadcast.checked = s.lanBroadcast !== false
  if (lanCardReadonly) lanCardReadonly.checked = s.readOnly === true
  if (lanCardTokenAuth) lanCardTokenAuth.checked = s.tokenEnabled !== false

  // Token area: three states
  //  (a) token available (currentToken non-empty, !acknowledged) — value
  //      visible (or mask visible, depending on toggle), show/copy buttons
  //  (b) token not available (currentToken empty, e.g. after acknowledge)
  //      — show a "saved" placeholder, hide the show/copy buttons
  //  (c) token enabled is off — show "(disabled)" placeholder
  const lanCardTokenToggle = document.getElementById('lan-card-token-toggle')
  const lanCardTokenCopy = document.getElementById('lan-card-token-copy')
  const lanCardTokenRow = document.getElementById('lan-card-token-row')
  const tokenEnabled = s.tokenEnabled !== false
  const hasToken = typeof s.currentToken === 'string' && s.currentToken.length > 0

  if (lanCardTokenValue) lanCardTokenValue.textContent = s.currentToken || ''

  if (!tokenEnabled) {
    // (c) Token auth disabled — don't show token or toggle
    if (lanCardTokenRow) {
      lanCardTokenRow.innerHTML = `<span class="lan-card-token-placeholder">— ${escapeHtml(t('lan_card_token_disabled') || 'Token 鉴权已关闭')}</span>`
    }
  } else if (!hasToken) {
    // (b) After acknowledge (or no token on server) — show placeholder
    if (lanCardTokenRow) {
      lanCardTokenRow.innerHTML = `<span class="lan-card-token-placeholder">✓ ${escapeHtml(t('lan_card_token_saved') || '已保存')}</span>`
    }
  } else {
    // (a) Token available — make sure mask+value+buttons are rendered
    // If the row was rewritten above (case b/c), restore the original DOM
    if (lanCardTokenRow && !lanCardTokenRow.querySelector('#lan-card-token-mask')) {
      lanCardTokenRow.innerHTML =
        `<span class="lan-card-token-mask" id="lan-card-token-mask">••••••••••••••••••••••••••••••••</span>` +
        `<span class="lan-card-token-value" id="lan-card-token-value" hidden></span>` +
        `<button class="lan-card-btn" id="lan-card-token-toggle" data-i18n="lan_card_token_show">${escapeHtml(t('lan_card_token_show'))}</button>` +
        `<button class="lan-card-btn" id="lan-card-token-copy" data-i18n="lan_card_token_copy">${escapeHtml(t('lan_card_token_copy'))}</button>`
      // Click handlers are event-delegated on the row (see events.js),
      // so the new buttons pick them up automatically — no re-bind needed.
    }
  }

  // acknowledged 提示
  if (lanCardTokenWarning) lanCardTokenWarning.hidden = s.tokenAcknowledged !== false
  if (lanCardTokenAck) lanCardTokenAck.hidden = s.tokenAcknowledged !== false
}

// v2026-08-28 modacker: render the Token Plan (套餐用量) card.
// Reflects server's `quotaEnabled` and the masked key preview. The
// real key never leaves the server; this function only shows the
// masked tail + a "set" / "not set" status line.
export function renderQuotaCardContent(s) {
  if (!s) return
  const enabled = document.getElementById('quota-card-enabled')
  const input = document.getElementById('quota-card-key-input')
  const status = document.getElementById('quota-card-status')
  if (enabled) enabled.checked = s.quotaEnabled === true
  // Always clear the password input on render (don't keep typed-but-unsaved
  // values around). Show a status line that indicates current server state.
  if (input) input.value = ''
  if (status) {
    if (s.hasTokenPlanKey) {
      const masked = s.tokenPlanApiKeyMasked || 'sk-cp-...'
      status.textContent = `已保存 (${masked})`
    } else if (s.quotaEnabled) {
      status.textContent = '请填 Subscription Key'
    } else {
      status.textContent = '未启用'
    }
  }
}

// v0.5.bx-31: sidebar 首次 SSE 推 mcodeSessions 之前显示 skeleton, 避免点删除/切时 race
//   mcode acp singleton 启动要 1-3s, 期间 state.mcodeSessions=[] → render 显示空
//   用户在空 sidebar 上点删除 webui entry, mcode db 的对应 session 没删 → SSE 推过来时"又出现"
//   sidebarReady=false 时 renderSessions 显示 skeleton + 全部 click 不绑
//   SSE 推过来 mcodeSessions.length>0 时设 true (模块级 let, 跨 render 共享)
export function saveCollapsedWorkspaces() {
  try { localStorage.setItem('webui_ws_collapsed_v1', JSON.stringify([...collapsedWorkspaces])) } catch {}
}

// 取工作区短名（最后一段路径）— 桌面端风格显示
export function wsShortName(ws) {
  if (!ws) return t('workspace_unset_short')
  // 去掉尾部斜杠
  let s = ws.replace(/[\\/]+$/, '')
  if (!s) return t('workspace_unset_short')
  // 取最后一段
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}

export function renderSessions() {
  console.log('[webui] renderSessions: state.sessions=' + (state?.sessions?.length || 0) + ' mcodeSessions=' + (state?.mcodeSessions?.length || 0) + ' sidebarReady=' + sidebarReady)
  const list = document.getElementById('sessions-list')
  // v0.5.bx-31: 首次 SSE 推 mcodeSessions 之前显示 skeleton, 禁用全部 click
  //   等 SSE 推过来 mcodeSessions 第一次非空时, 消息处理那边会设 sidebarReady=true
  if (!sidebarReady) {
    list.innerHTML = `
      <div class="session-skeleton">
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
      </div>
      <div class="session-skeleton-hint">${t('sidebar_loading') || '加载会话中…'}</div>
    `
    return
  }
  // v0.5.bv: 优先显示 mcode 真实 sessions（mvs_xxx id + mcode 自动 title）
  // 合并：mcode sessions (按 cwd 过滤) + webui 自己的 sessions (还没跟 mcode 关联的)
  const mcodeSessions = Array.isArray(state?.mcodeSessions) ? state.mcodeSessions : []
  const webuiSessions = Array.isArray(state?.sessions) ? state.sessions : []
  // 用 webui session 的 mcodeSessionId 字段去重：mcode 有但 webui 也有的就归 mcode
  const webuiWithMcode = new Set()
  const merged = []
  for (const ms of mcodeSessions) {
    webuiWithMcode.add(ms.sessionId)
    merged.push({
      id: ms.sessionId,           // mcode session id (mvs_xxx)
      kind: 'mcode',
      title: ms.title || '(untitled)',
      workspace: ms.cwd || '',
      updatedAt: ms.updatedAt || 0,
    })
  }
  for (const ws of webuiSessions) {
    if (ws.mcodeSessionId && webuiWithMcode.has(ws.mcodeSessionId)) continue  // 已在 mcode 列表里
    if (ws.mcodeSessionId) {
      // webui 有 mcodeSessionId 但 mcode list 里没出现（可能 mcode 那边已删）— 仍显示
      merged.push({
        id: ws.mcodeSessionId, kind: 'webui-mcode', title: ws.title || '(untitled)',
        workspace: ws.workspace || '', updatedAt: ws.updatedAt || 0,
      })
    } else {
      // webui session 还没 prompt 过（无 mcode 关联）— 用 webui id 显示
      merged.push({
        id: ws.id, kind: 'webui', title: ws.title || '(untitled)',
        workspace: ws.workspace || '', updatedAt: ws.updatedAt || 0,
      })
    }
  }
  const sessions = merged
  // v0.5.bx-31: currentWs 改用 state.lastUsedWorkspace (独立字段)
  //   之前用 state.workspace.dir, 但 server 切 session 会同步改它 (v0.5.ar),导致 sidebar 排序把该工作区置顶
  //   现在 server 切 session 只写 lastUsedWorkspace,state.workspace.dir 保持不变 (chip-workspace 跟它无关)
  //   第一次 (没切过) lastUsedWorkspace=null, fallback 到 state.workspace.dir (chip 当前显示的工作区)
  const currentWs = (state && state.lastUsedWorkspace) || (state && state.workspace && state.workspace.dir) || ''
  const q = (sessionSearchQuery || '').trim().toLowerCase()
  let filtered = sessions
  if (q) {
    filtered = sessions.filter(s => {
      const title = (s.title || s.id || '').toLowerCase()
      return title.includes(q) || s.id.toLowerCase().includes(q)
    })
  }
  if (filtered.length === 0) {
    const msg = q ? (currentLang === 'zh' ? '没有匹配的会话' : 'No matching sessions') : t('no_sessions')
    list.innerHTML = `<div class="session-title-empty">${msg}</div>`
    return
  }
  // 按 workspace 分组
  const groups = new Map()
  for (const s of filtered) {
    const ws = (s.workspace || '').trim() || t('workspace_unset')
    if (!groups.has(ws)) groups.set(ws, [])
    groups.get(ws).push(s)
  }
  // v0.5.bx-31: 子分类置顶 — group 内按 updatedAt desc 排序
  //   之前没做, 最近触发的对话不排到第一位
  for (const [ws, items] of groups) {
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === currentWs) return -1
    if (b === currentWs) return 1
    const aMax = Math.max(...groups.get(a).map(s => s.updatedAt || 0))
    const bMax = Math.max(...groups.get(b).map(s => s.updatedAt || 0))
    return bMax - aMax
  })
  const folderSvg = '<svg class="icon workspace-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
  const html = sortedKeys.map(ws => {
    const items = groups.get(ws)
    const isCurrent = ws === currentWs
    const collapsed = collapsedWorkspaces.has(ws)
    const headerClass = `workspace-group${collapsed ? ' collapsed' : ''}`
    const badge = isCurrent ? `<span class="workspace-group-current-badge">${t('workspace_current')}</span>` : ''
    const itemsHtml = items.map(s => {
      // v0.5.bv: 空 title fallback 到 (untitled)，避免 mcode 端没生成时显示空
      const title = (s.title && s.title.trim()) || '(untitled)'
      const short = escapeHtml(title.substring(0, 28))
      // v0.5.bv: active 判断用 mcodeSessionId（mcode sessions）或 webui sessionId（webui sessions）
      const activeId = state?.mcodeSessionId || state?.sessionId
      const active = s.id === activeId ? ' active' : ''
      // mcode session id (mvs_xxx) 跟 webui randomUUID 一视同仁 — 都显示 12 字符 + 后缀
      const idLabel = escapeHtml(s.id.substring(0, 12) + '…')
      // v0.5.bx-24 (改): mcode session 也显示 X 按钮 — server DELETE 端点 v0.5.bx-5/bx-19 已支持 mvs_xxx 直接 SQL 删 mcode db
      //   之前 v0.5.bv 写死不显示是因为 webui 没能力删 mcode session; 现在能了
      //   删 mcode session 走 server DELETE → SQL 删 mcode db (8 张表事务), 不依赖 mcode TUI
      const deleteBtn = `<button class="session-delete" data-id="${escapeHtml(s.id)}" title="${t('session_delete')}">×</button>`
      return `<div class="session-item${active}" data-id="${escapeHtml(s.id)}" data-kind="${s.kind}" title="${escapeHtml(title)}">
        <div class="session-dot"></div>
        <div class="session-info">
          <div class="session-name">${short}</div>
          <div class="session-id">${idLabel}</div>
        </div>
        ${deleteBtn}
      </div>`
    }).join('')
    return `<div class="${headerClass}" data-ws="${escapeHtml(ws)}">
      <div class="workspace-group-header" data-ws="${escapeHtml(ws)}">
        <span class="workspace-group-chevron">▼</span>
        ${folderSvg}
        <span class="workspace-group-name" title="${escapeHtml(ws)}">${escapeHtml(wsShortName(ws))}</span>
        <span class="workspace-group-count">${items.length}</span>
        ${badge}
      </div>
      <div class="workspace-group-items">${itemsHtml}</div>
    </div>`
  }).join('')
  list.innerHTML = html

  // 点击 group header 折叠/展开
  list.querySelectorAll('.workspace-group-header').forEach(h => {
    h.addEventListener('click', (e) => {
      // 防止误点 group 内的 session 时触发
      if (e.target.closest('.session-item')) return
      const ws = h.getAttribute('data-ws')
      const group = h.closest('.workspace-group')
      if (!group) return
      if (collapsedWorkspaces.has(ws)) {
        collapsedWorkspaces.delete(ws)
        group.classList.remove('collapsed')
      } else {
        collapsedWorkspaces.add(ws)
        group.classList.add('collapsed')
      }
      saveCollapsedWorkspaces()
    })
  })

  // 点击 session：切到那个 session
  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-delete') || e.target.closest('.session-confirm')) return
      const id = el.getAttribute('data-id')
      switchSession(id)
    })
  })
  // 删除按钮：第一次点显示二次确认，第二次点确认按钮才真删
  list.querySelectorAll('.session-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const item = btn.closest('.session-item')
      if (item.classList.contains('confirming')) return
      item.classList.add('confirming')
      const bar = document.createElement('div')
      bar.className = 'session-confirm'
      bar.innerHTML = `<span>${t('session_delete_confirm')}</span><button class="session-confirm-yes" data-id="${btn.getAttribute('data-id')}">${t('session_delete_yes')}</button><button class="session-confirm-no" title="${t('session_delete_cancel')}">×</button>`
      item.appendChild(bar)
      const timer = setTimeout(() => cancelConfirm(item), 5000)
      item._confirmTimer = timer
      bar.querySelector('.session-confirm-yes').addEventListener('click', async (ev) => {
        ev.stopPropagation()
        clearTimeout(timer)
        const id = btn.getAttribute('data-id')
        await deleteSession(id)
      })
      bar.querySelector('.session-confirm-no').addEventListener('click', (ev) => {
        ev.stopPropagation()
        clearTimeout(timer)
        cancelConfirm(item)
      })
    })
  })
}


// v0.5.x: 点击 sidebar session 切到该会话（#1 反馈修复）
export function cancelConfirm(item) {
  if (!item) return
  if (item._confirmTimer) clearTimeout(item._confirmTimer)
  item.classList.remove('confirming')
  const bar = item.querySelector('.session-confirm')
  if (bar) bar.remove()
}

export async function deleteSession(sessionId) {
  if (!sessionId) return
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + API_SUFFIX, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
    })
    if (r.ok) {
      const data = await r.json().catch(() => ({}))
      // v0.5.bx-5: 同时按 webui id 和 mcodeSessionId 过滤（孤儿 webui-mcode session 的 id 是 mvs_xxx）
      state.sessions = (state.sessions || []).filter(s => s.id !== sessionId && s.mcodeSessionId !== sessionId)
      // v0.5.bx-31: 同时清 mcodeSessions (mvs_xxx id), 避免 SSE 推过来时"删了又出现"
      //   server 端 mcode acp cache 30s 内可能还有这 session, invalidate 后下次 list 才彻底干净
      //   但 mcodeSessions 是 server 推送的, 下次 push 会覆盖整个 state; 本地提前 filter 避免闪动
      state.mcodeSessions = (state.mcodeSessions || []).filter(s => s.sessionId !== sessionId)
      renderSessions()
      // 触发 SSE 拉取最新 state（包括 current session 是否被清空）
      // （SSE 会自动推送，但 pushState 已被 server 调过——等下一次刷新也行）
    } else {
      console.error('deleteSession failed', r.status, await r.text())
    }
  } catch (e) { console.error('deleteSession', e) }
}

export async function switchSession(sessionId) {
  if (!sessionId) return
  try {
    const r = await fetch('/api/sessions/switch' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ id: sessionId }),
    })
    if (r.ok) {
      const data = await r.json()
      if (data.ok) {
        // 直接用 server 返回的 session 数据更新本地 state（避免 SSE race condition）
        state.sessionId = data.session.id
        state.sessionTitle = data.session.title
        // v0.5.bx-20 (改): 切 session 不再关闭 ask_user 弹窗 — Wzdhehe 反馈
        //   "切换对话再切回来也保留弹窗" → 弹窗绑 module-level, 切走不清
        //   v0.5.bx-15 改 #4 移除 (之前是切 session 关弹窗, 行为反了)
        // v0.5.bx-25 (改): 切 session 关掉旧 session 的弹窗 — Wzdhehe 反馈
        //   "触发问题弹窗后, 切到其他对话, 弹窗还在" — 弹窗应属于触发它的 session, 切走就关
        //   跟 v0.5.bx-20 "保留弹窗" 立场相反, 但 v0.5.bx-20 时 Wzdhehe 没表达"切走也要保留", 是 v0.5.bx-15 改 #4 那次的原话误读
        //   现在按 "弹窗属于触发它的 session" 理解: 切走关, 切回不自动重弹 (主动点 inline ask indicator 才重开)
        if (typeof closeAskModal === 'function') {
          closeAskModal()
        }
        // v0.5.bx-24 (改): 触发 2s suppress, 避免新 session 立即 re-render 历史 ask_user 块时弹窗
        //   "明明历史对话最新的没有提问, 为什么还会弹" — 切到历史 session, 历史 ask_user 块被 parseChatLines
        //   解析为 latestAskIdx, openAskModal 弹窗. suppress 2s 让 user 先看 chat, 2s 后再弹 (如果 mcode 真在等 answer)
        if (typeof suppressAskModal === 'function') {
          suppressAskModal()
        }
        // v0.5.bx: 也同步 mcodeSessionId（之前没同步，sidebar 切后 state.mcodeSessionId 还是旧的）
        if (data.session.mcodeSessionId !== undefined) {
          state.mcodeSessionId = data.session.mcodeSessionId || null
        }
        // 关键：从 db 加载该 session 的历史 chat
        state.chat = Array.isArray(data.session.chat) ? data.session.chat : []
        // v0.5.bx-26: 把新 session chat history 里的 ask_user 块标"已答 (skipped)"
        //   切 session 后, renderChat 重新跑会调 openAskModal (source='render')
        //   如果新 session chat 里有 ask_user 块, 又会弹窗
        //   提前给 state.askUserAnswers 设占位, openAskModal allAnswered 检查会跳过
        //   不持久化 (saveAskUserAnswers 不调) — 只在内存里, 跨 session 共享
        //   click 来源 (user 主动点 inline ask indicator) 跳过此检查, 仍能打开
        if (Array.isArray(state.chat)) {
          if (!state.askUserAnswers) state.askUserAnswers = {}
          for (const line of state.chat) {
            if (typeof line !== 'string' || !line.includes('→ ask_user')) continue
            // chat 行格式: "→ ask_user  {\"mode\":\"questionnaire\",\"title\":\"...\",\"steps\":[{...}]}"
            // 提取 question 文本 — 支持单/多 step
            const stepMatches = line.match(/"question"\s*:\s*"([^"]+)"/g) || []
            for (const m of stepMatches) {
              const qm = m.match(/"question"\s*:\s*"([^"]+)"/)
              if (qm && qm[1] && !state.askUserAnswers[qm[1]]) {
                state.askUserAnswers[qm[1]] = { answer: '未回答', mode: 'skipped' }
              }
            }
          }
        }
        renderSessions()
        render()
      } else {
        console.error('switchSession data error', data.error)
      }
    } else {
      console.error('switchSession failed', r.status)
    }
  } catch (e) { console.error('switchSession', e) }
}

export function renderUserFooter() {
  // v0.5.ak: 完全改用动态有效信息
  // 第 1 行（粗体）：实时状态 + 短 session id（mcode session 而不是 webui session）
  //   不显示 model name（已在右栏）+ 不显示 sessionTitle（已在左栏最近会话）
  // 第 2 行（灰）：当前时间 + 累计 chat lines 数（实时变）
  const running = state?.running?.active
  const tps = state?.running?.tps || 0
  const thinkingStatus = state?.context?.thinkingStatus || 'Idle'
  let status, dot
  if (running && thinkingStatus === 'Running') { status = '运行中'; dot = '🔵' }
  else if (running && thinkingStatus === 'Loading') { status = '加载中'; dot = '🟡' }
  else if (thinkingStatus && thinkingStatus !== 'Idle') { status = thinkingStatus; dot = '🟡' }
  else { status = '空闲'; dot = '🟢' }
  // mcode session 短 hash（12 字符）— 让用户知道现在用哪个 mcode 会话
  const mcodeSid = state?.mcodeSessionId || ''
  const sidShort = mcodeSid ? mcodeSid.substring(0, 12) : '—'
  const tpsSuffix = running && tps > 0 ? ` · ${tps}tps` : ''
  const name = `${dot} ${status} · ${sidShort}${tpsSuffix}`
  const avatar = (state?.context?.thinkingStatus === 'Running') ? '⋯' : 'M'
  document.getElementById('user-avatar').textContent = avatar
  document.getElementById('user-name').textContent = name
  // 第 2 行：当前时间 + 累计 chat 行数（实时变）
  const chatLines = (state?.chat || []).filter(l => l && l.trim()).length
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const timeStr = `${hh}:${mm}`
  const planLine = `${timeStr} · ${chatLines} 行`
  document.getElementById('user-plan').textContent = planLine
}

// v0.5.ak: User footer 已改为静态 GitHub 链接，renderUserFooter / startUserFooterTicker 不再需要
// 保留 renderUserFooter 旧定义兼容（CSS 已 hide 其内容），但不再被调用

export function renderChat() {
  const inner = document.getElementById('chat-inner')
  const empty = document.getElementById('chat-empty')
  let lines = state?.chat || []
  // 过滤掉 mcode TUI 的 placeholder / 空 prompt 标记（shim 偶尔会误抓）
  lines = lines.filter(l => {
    if (!l) return false
    const t = l.trim()
    if (!t) return false
    if (/^Message\s*·\s*Enter\s*send/i.test(t)) return false
    if (/Shift\+Enter\s*newline/i.test(t)) return false
    if (/^Start\s*[·•]/i.test(t)) return false
    if (/^autocomplete\s*[·•]/i.test(t)) return false
    if (/^@ file\s*[·•]/i.test(t)) return false
    if (/^Ready$/i.test(t)) return false
    // 空 prompt 标记：只有 › / ● / ○ / > 但没内容
    if (/^[›>●•○◯]\s*$/.test(t)) return false
    return true
  })
  if (lines.length === 0) {
    if (empty) empty.style.display = ''
    // v0.5.x: 切到空 chat 的 session 时必须清空 inner，否则会残留上一个 session 的 messages
    if (inner) inner.innerHTML = ''
    // v0.5.ae: 空 chat 时清空 right panel todo
    if (state) { state.todo = []; renderTodo() }
    // v0.5.ax: 欢迎页时隐藏右侧栏
    hideRightForWelcome(true)
    // v0.5.bd: 切到欢迎页布局（chat-empty + input-area 居中堆叠）
    const chatArea = document.getElementById('chat-area')
    if (chatArea) chatArea.classList.add('is-welcome')
    // v0.5.bx: 欢迎页才显示"选工作区"chip，已有对话时整个 row 隐藏
    const wsRow = document.getElementById('input-workspace-row')
    if (wsRow) wsRow.hidden = false
    // v0.5.bx-2: mcode session 切过来 + chatLen=0（acp session/load 不带 chat 历史）→ 显示"已切到 mcode session,没历史"空状态
    // 区别于 welcome 页（无 mcodeSessionId）
    if (state && state.mcodeSessionId && state.sessionTitle) {
      if (inner) {
        inner.innerHTML = `<div class="chat-empty-mcode">
          <div class="chat-empty-mcode-icon">📭</div>
          <div class="chat-empty-mcode-title">${escapeHtml(state.sessionTitle)}</div>
          <div class="chat-empty-mcode-text">已切到这个 mcode session，但 webui 没有它的历史 chat。</div>
          <div class="chat-empty-mcode-hint">mcode acp <code>session/load</code> 协议不返回历史消息，只在 mcode TUI 里能看。发新消息会续接这个 mcode session。</div>
        </div>`
      }
      return
    }
    return
  }
  if (empty) empty.style.display = 'none'
  // v0.5.ax: 欢迎页隐藏右侧栏（chat-area 居中）
  hideRightForWelcome(false)
  // v0.5.bd: 退出欢迎页布局（恢复 input-area 吸底）
  const chatArea2 = document.getElementById('chat-area')
  // v0.5.bx: 有对话时隐藏"选工作区"chip — 已选工作区不让改，要改点 sidebar "New Chat"
  const wsRow2 = document.getElementById('input-workspace-row')
  if (wsRow2) wsRow2.hidden = true
  if (chatArea2) chatArea2.classList.remove('is-welcome')

  // Parse chat lines into messages
  const messages = parseChatLines(lines)
  // v0.5.bx-20: 找"最新"包含 ask_user tool 的 message index — 只有它能弹窗
  //   旧 chat history 里的 ask_user 全部不弹, 避免 mcode LLM 死循环反复弹同一题
  let latestAskIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'tool' && messages[i].name === 'ask_user') {
      latestAskIdx = i
      break
    }
  }
  // 渲染时把 isLatestAsk 透传给 renderMessage
  inner.innerHTML = messages.map((m, i) => renderMessage(m, { isLatestAsk: i === latestAskIdx })).join('')
  // v0.5.ab: 绑定 Ask/Plan 块的点击事件（事件委托）
  attachStructuredBlockHandlers(inner)
  // v0.5.ae: 把 chat 内的 todo block 实时同步到 state.todo（right panel 用）
  // dedup by text：同一个 todo 在多轮里可能重复，最后一次状态生效
  if (state) {
    const todos = []
    const seen = new Set()
    for (const m of messages) {
      if (m.role === 'todo' && Array.isArray(m.items)) {
        for (const it of m.items) {
          if (it && it.text && !seen.has(it.text)) {
            seen.add(it.text)
            todos.push(it)
          }
        }
      }
    }
    state.todo = todos
    renderTodo()
  }
  // scroll to bottom
  const scroll = document.getElementById('chat-scroll')
  scroll.scrollTop = scroll.scrollHeight
}

// v0.5.ab: 事件委托 — Ask 选项点击发送 / Plan 选项点击发送 / "查看完整计划" 打开弹窗
export function attachStructuredBlockHandlers(root) {
  if (!root) return
  // v0.5.bx-13: click inline ask indicator → 重新打开弹窗
  root.querySelectorAll('.msg-ask-indicator').forEach(el => {
    el.addEventListener('click', () => {
      // 找最近的 tool 块 (data-ask-tool 属性保存了 first question)
      const q = el.getAttribute('data-ask-tool') || ''
      if (!q) return
      // 从 state.askUserAnswers 反查 pq
      // 简单做法: 找当前 chat 里最新的同 question 的 tool
      if (state?.chat) {
        // 暂时重新解析整个 chat 找 pq
        const lines = state.chat
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] && lines[i].includes('→ ask_user')) {
            // 用 parseChatLines 太重, 这里只重新打开 — 弹窗里的答案会从 state.askUserAnswers 读
            // openAskModal 内部会用 state.askUserAnswers 状态判断是否已答
            // 构造一个最小的 pq
            // v0.5.bx-20: source:'click' 不受 isLatestAsk 限制 — 主动点历史 ask indicator 应能重新打开
            const fakePq = { steps: [{ question: q, options: [] }], mode: 'single' }
            openAskModal(fakePq, { source: 'click' })
            return
          }
        }
      }
    })
  })
  // Ask 选项
  root.querySelectorAll('.ask-option').forEach(el => {
    el.addEventListener('click', () => {
      const label = el.getAttribute('data-ask-opt') || ''
      const isOther = el.getAttribute('data-ask-other') === '1'
      if (isOther) {
        // "Other" 自由输入：弹个小输入框在 chat 里
        const input = prompt('请输入自定义回答：', '')
        if (input == null) return
        sendAskAnswer(input)
      } else {
        sendAskAnswer(label)
      }
    })
  })
  // Plan 选项（Agree/Skip/Revise）
  root.querySelectorAll('[data-plan-opt]').forEach(el => {
    el.addEventListener('click', () => {
      const text = el.getAttribute('data-plan-opt') || ''
      sendPlanAnswer(text)
    })
  })
  // Plan 弹窗
  root.querySelectorAll('[data-plan-view]').forEach(el => {
    el.addEventListener('click', () => {
      const title = el.getAttribute('data-plan-view') || ''
      // 从 messages 中找到这个 plan 的 content
      const planMsg = (state?.chat ? parseChatLines(state.chat) : []).find(m => m.role === 'plan' && m.title === title)
      if (planMsg) openPlanModal(planMsg)
    })
  })
  // v0.5.bx-6: tool 涉及的本地文件路径 — 点击复制到剪贴板
  root.querySelectorAll('.msg-tool-loc').forEach(el => {
    el.addEventListener('click', async () => {
      const p = el.getAttribute('data-path') || ''
      if (!p) return
      try {
        await navigator.clipboard.writeText(p)
        el.classList.add('copied')
        setTimeout(() => el.classList.remove('copied'), 800)
      } catch (e) {
        // fallback: 用 textarea 选中文本
        const ta = document.createElement('textarea')
        ta.value = p
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(ta)
      }
    })
  })
  // v0.5.bx-7: ask_user 问卷选项 — 点击 label 作为下一次 prompt 发给 mcode
  // v0.5.bx-8: 单 step 模式选项 click 自动 send; 多 step 模式选项 click 只 highlight, 等底部"发送"按钮模板化发
  //   状态持久化到 state.askUserAnswers (跨 render 保留, 不被 parseChatLines 重建对象丢)
  root.querySelectorAll('.ask-questionnaire').forEach(questionnaire => {
    const mode = questionnaire.getAttribute('data-mode') || 'single'

    // 选项 click
    questionnaire.querySelectorAll('.ask-opt').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return
        const label = btn.getAttribute('data-ask-label') || ''
        const q = btn.getAttribute('data-ask-q') || ''
        if (!label) return
        if (!state.askUserAnswers) state.askUserAnswers = {}
        if (state.askUserAnswers[q]) return  // 已答过
        // 持久化 (state + localStorage)
        setAskUserAnswer(q, { answer: label, mode: 'answered' })
        // 清 pending (只清 single step 模式的)
        if (mode === 'single' && state?.pendingAskUser) {
          state.pendingAskUser = null
        }
        if (mode === 'single') {
          // 单 step: 选项 click 自动 send
          const prompt = `Q: ${q}\nA: ${label}`
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-opt] send failed', r.status)
          } catch (e) { console.error('[ask-opt] send error', e) }
        } else {
          // 多 step: 只 highlight, 不发
        }
        renderAskUserToolIfChanged()
      })
    })

    // 跳过按钮 (单 step 模式)
    if (mode === 'single') {
      const skipBtn = questionnaire.querySelector('.ask-skip')
      if (skipBtn) {
        skipBtn.addEventListener('click', async () => {
          if (skipBtn.disabled) return
          // v0.5.bx-8: .ask-skip 自身有 data-ask-q, 直接读
          const q = skipBtn.getAttribute('data-ask-q') || ''
          if (!q) return
          if (!state.askUserAnswers) state.askUserAnswers = {}
          if (state.askUserAnswers[q]) return
          setAskUserAnswer(q, { answer: '未回答', mode: 'skipped' })
          if (state?.pendingAskUser) state.pendingAskUser = null
          // 自动 send "Q: ... A: 未回答"
          const prompt = `Q: ${q}\nA: 未回答`
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-skip] send failed', r.status)
          } catch (e) { console.error('[ask-skip] send error', e) }
          renderAskUserToolIfChanged()
        })
      }
    }

    // "其他"输入框 input 监听 — 设 state.askUserAnswers (highlight 当前 step 的回答为"其他")
    questionnaire.querySelectorAll('.ask-step-other-input').forEach(input => {
      const update = () => {
        const step = input.closest('.ask-step')
        const firstOpt = step?.querySelector('.ask-opt')
        const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
        if (!q) return
        if (!state.askUserAnswers) state.askUserAnswers = {}
        const text = input.value.trim()
        if (text) {
          setAskUserAnswer(q, { answer: text, mode: 'answered-other' })
        } else {
          // 清空 = 清除"其他"回答 (回到未答)
          if (state.askUserAnswers[q]?.mode === 'answered-other') {
            setAskUserAnswer(q, null)  // null = 删除
          }
        }
        // 只 highlight, 不发 (也不重渲染 — input 事件触发太频繁, 直接改 class)
        // 重渲染只更新样式, 不发请求
        if (mode === 'single') {
          // 单 step: 清除其他选项的 .clicked
          step.querySelectorAll('.ask-opt').forEach(o => o.classList.remove('clicked'))
        }
        renderAskUserToolIfChanged()
      }
      input.addEventListener('input', update)
      input.addEventListener('change', update)
      // Enter 键 — 单 step 模式自动 send, 多 step 模式只 highlight (再点发送才发)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (mode === 'single') {
            const text = input.value.trim()
            if (!text) return
            // 走 sendAskUserAnswer
            const step = input.closest('.ask-step')
            const firstOpt = step?.querySelector('.ask-opt')
            const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
            if (!q) return
            if (!state.askUserAnswers) state.askUserAnswers = {}
            setAskUserAnswer(q, { answer: text, mode: 'answered-other' })
            if (state?.pendingAskUser) state.pendingAskUser = null
            const prompt = `Q: ${q}\nA: ${text}`
            fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            }).then(r => {
              if (!r.ok) console.warn('[ask-other] send failed', r.status)
            }).catch(e => console.error('[ask-other] send error', e))
            renderAskUserToolIfChanged()
          }
        }
      })
    })

    // 发送按钮 (多 step 模式)
    if (mode === 'multi') {
      const submitBtn = questionnaire.querySelector('.ask-submit')
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          // 收集所有 step 的 answer (没答的 = "未回答")
          const stepEls = questionnaire.querySelectorAll('.ask-step')
          const blocks = []
          for (const stepEl of stepEls) {
            const firstOpt = stepEl.querySelector('.ask-opt')
            const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
            if (!q) continue
            const ans = state?.askUserAnswers?.[q]
            const otherInput = stepEl.querySelector('.ask-step-other-input')
            const otherText = otherInput?.value.trim() || ''
            // 优先用 state.askUserAnswers, 其次从 input 读 (实时未触发 input 事件的情况)
            let finalAnswer
            if (ans && ans.mode === 'skipped') {
              finalAnswer = '未回答'
            } else if (otherText) {
              finalAnswer = otherText
            } else if (ans) {
              finalAnswer = ans.answer
            } else {
              finalAnswer = '未回答'
            }
            blocks.push(`Q: ${q}\nA: ${finalAnswer}`)
            // 持久化到 state + localStorage
            if (!state.askUserAnswers) state.askUserAnswers = {}
            setAskUserAnswer(q, { answer: finalAnswer, mode: otherText ? 'answered-other' : (ans?.mode === 'skipped' ? 'skipped' : 'answered') })
          }
          if (blocks.length === 0) return
          // 清 pending
          if (state?.pendingAskUser) state.pendingAskUser = null
          // 模板化发
          const prompt = blocks.join('\n')
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-submit] send failed', r.status)
          } catch (e) { console.error('[ask-submit] send error', e) }
          renderAskUserToolIfChanged()
        })
      }
    }
  })
}

export async function sendAskAnswer(text) {
  // 走 /api/send 通路（跟正常发消息一致）
  // v0.5.bx-13: isAskAnswer:true 告诉 server 不要把 Q/A 当 user message 加到 chat
  const r = await fetch('/api/send' + API_SUFFIX, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ content: text, command: 'prompt', isAskAnswer: true })
  })
  if (!r.ok) console.warn('sendAskAnswer failed', r.status)
}

// ============================================================
// v0.5.bx-13: ask_user 真弹窗 (替代内嵌 questionnaire)
// - 弹窗打开后, chat 里只显示紧凑 "ask_user · 待答/已答" 标记
// - 选项 / 其他 / 跳过 / 关闭 全部在弹窗里操作
// - 提交后 sendAskAnswer(isAskAnswer:true), server 不把 Q/A 加到 chat
// - 答完自动关弹窗, 重新进来不重复弹
// v0.5.bx-14: 加 presentedKeys 集合 — 同一 ask (pq key) 只弹一次, 进历史 session / re-render 不重弹
// v0.5.bx-15 (改 #3): 加 DISMISSED_QUESTIONS 集合 — 按 question 文本去重 (跨 pq key / 跨 session)
// ============================================================
export const ASK_MODAL_STATE = {
  open: false,            // 弹窗当前是否显示
  pqKey: null,            // 当前弹窗对应的 pq 指纹 (steps[0].question 拼接), 用于去重
  pq: null,               // parsedQuestionnaire
  currentStep: 0,         // 多 step 模式下的当前题 index
  answers: {},            // 当前弹窗的临时 answers (question -> {answer, mode})
  presentedKeys: new Set(),  // v0.5.bx-14: 已经"展示过" (弹过/跳过/答过) 的 pq key, 同 key 不重弹
  suppressUntilTs: 0,        // v0.5.bx-24: 切 session 后 2s 内不弹窗 (避免重复弹历史 ask_user)
}
// v0.5.bx-15 (改 #3): module-level "已答过/已 dismiss" 的 question 集合
//   切到任何 mcode session, 该 question 都不会再弹 (即使 pq key 不同)
//   init() 时从 localStorage.askUserAnswers 恢复
export const DISMISSED_QUESTIONS = new Set()

export function askModalPqKey(pq) {
  if (!pq || !Array.isArray(pq.steps) || pq.steps.length === 0) return null
  return pq.steps.map(s => s.question).join('||')
}

export function openAskModal(pq, opts) {
  if (!pq || !Array.isArray(pq.steps) || pq.steps.length === 0) return
  // v0.5.bx-24: 切 session 后 2s 内不弹窗 (suppressUntilTs)
  //   解决"切到历史 session, 历史 ask_user 块立即弹窗"问题
  //   2s 后再弹 (如果 mcode 端真在等 answer, user 切回来看几眼确认是历史 ask 后, 弹窗会自己出)
  if (Date.now() < (ASK_MODAL_STATE.suppressUntilTs || 0)) {
    return
  }
  // v0.5.bx-20: 守卫 — 只有"最新一条 agent 回复"里的 ask_user 才弹窗
  //   旧 chat history 里的 ask 不弹, 避免 mcode LLM 死循环时反复弹同一题
  //   opts = { isLatestAsk: true/false, source: 'render' | 'click' }
  //   'click' 来源 (点 inline ask indicator 重新打开) 不受 isLatestAsk 限制
  const source = (opts && opts.source) || 'render'
  if (source === 'render' && opts && opts.isLatestAsk === false) {
    return  // 历史 ask 不弹窗
  }
  const key = askModalPqKey(pq)
  if (!key) return
  // v0.5.bx-15 (改 #3): 按 question 文本去重 — 切到任何 mcode session, 该 question 都不再弹
  //   即使 mcode 重发不同 pq key 但相同 question 文本, 也视为已 dismiss
  //   (DISMISSED_QUESTIONS 在 init() 从 localStorage 恢复, 在 setAskUserAnswer 加)
  if (pq.steps.every(s => DISMISSED_QUESTIONS.has(s.question))) {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-14: 已经"展示过" (弹过/答过/跳过) 的 ask 不再弹 — 解决历史 session / re-render 重复弹窗
  //   同一个 pq key 在整个 session 生命周期只弹一次
  //   想要重新答, 点 chat 里的 inline ask indicator 即可
  if (ASK_MODAL_STATE.presentedKeys.has(key)) {
    // 已经展示过, 什么都不做 (不刷内容, 不重开)
    return
  }
  // v0.5.bx-26: chat history 里的 ask_user 块被切 session 时标"已答 (skipped)" —
  //   render 来源 (source='render') 命中 allAnswered=true 跳过; click 来源跳过此检查
  //   避免 "切到历史 session, 弹窗又开" 的 race
  const allAnswered = pq.steps.every(s => state?.askUserAnswers?.[s.question])
  if (allAnswered && source !== 'click') {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-15 (改 #3): 按 question 文本去重 — 切到任何 mcode session, 该 question 都不再弹
  //   即使 mcode 重发不同 pq key 但相同 question 文本, 也视为已 dismiss
  //   (DISMISSED_QUESTIONS 在 init() 从 localStorage 恢复, 在 setAskUserAnswer 加)
  if (pq.steps.every(s => DISMISSED_QUESTIONS.has(s.question))) {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-14: 已经"展示过" (弹过/答过/跳过) 的 ask 不再弹 — 解决历史 session / re-render 重复弹窗
  //   同一个 pq key 在整个 session 生命周期只弹一次
  //   想要重新答, 点 chat 里的 inline ask indicator 即可
  if (ASK_MODAL_STATE.presentedKeys.has(key)) {
    // 已经展示过, 什么都不做 (不刷内容, 不重开)
    return
  }
  // 第一次见这个 ask → 标记 + 弹窗
  ASK_MODAL_STATE.presentedKeys.add(key)
  ASK_MODAL_STATE.open = true
  ASK_MODAL_STATE.pqKey = key
  ASK_MODAL_STATE.pq = pq
  ASK_MODAL_STATE.currentStep = 0
  ASK_MODAL_STATE.answers = {}
  const modal = document.getElementById('ask-modal')
  if (modal) modal.style.display = 'flex'
  // v0.5.bx-15 (改 #3): 顶替输入框 — 弹窗出现时 input 区域隐藏
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = 'none'
  renderAskModalContent()
}

export function closeAskModal() {
  ASK_MODAL_STATE.open = false
  ASK_MODAL_STATE.pq = null
  ASK_MODAL_STATE.pqKey = null
  ASK_MODAL_STATE.currentStep = 0
  ASK_MODAL_STATE.answers = {}
  const modal = document.getElementById('ask-modal')
  if (modal) modal.style.display = 'none'
  // v0.5.bx-15 (改 #3): 恢复输入框
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = ''
  // 清空 other input
  const other = document.getElementById('ask-modal-other')
  if (other) other.value = ''
  // v0.5.bx-28: 防御性清 pendingAskUser — 任何关弹窗路径 (X / Esc / 背景 / 切会话) 都要清,
  //   否则 send() 会把后续正常消息包成 Q/A 模板 ("Q: <question>\nA: <user input>")
  //   X / Esc / 背景 现在都绑 closeAskModal (不再过 askModalSkip), 语义是"我放弃这题, 让我正常发消息"
  if (state && state.pendingAskUser) state.pendingAskUser = null
}

// v0.5.bx-14: 清掉"已展示"记录 (调试/重置用, 切 session 时也调, 让历史 ask 重新可答)
// v0.5.bx-24: 加 suppressUntilTs — 切 session 时设 = now + 2s, openAskModal 检查后早 return
//   解决"切 session 立即重弹 ask_user 弹窗"问题 — 切到历史 session, 历史里的 ask_user 块被新 session 解析又弹一次
export function clearAskPresentedKeys() {
  ASK_MODAL_STATE.presentedKeys.clear()
}
// v0.5.bx-24: 切 session 后 2s 内不弹 ask_user 弹窗 (给 user 时间看 chat 内容, 不被弹窗打断)
export function suppressAskModal() {
  ASK_MODAL_STATE.suppressUntilTs = Date.now() + 2000
}

export function renderAskModalContent() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const stepIdx = Math.min(ASK_MODAL_STATE.currentStep, pq.steps.length - 1)
  const step = pq.steps[stepIdx]
  if (!step) return
  const isMulti = pq.steps.length > 1
  const counter = document.getElementById('ask-modal-step-counter')
  const qEl = document.getElementById('ask-modal-question')
  const optsEl = document.getElementById('ask-modal-options')
  const sendBtn = document.getElementById('ask-modal-send')
  const other = document.getElementById('ask-modal-other')
  if (counter) counter.textContent = isMulti ? `第 ${stepIdx + 1} / ${pq.steps.length} 题` : ''
  if (qEl) qEl.textContent = step.question
  // 选项
  if (optsEl) {
    if (!Array.isArray(step.options) || step.options.length === 0) {
      optsEl.innerHTML = '<div class="ask-modal-no-options">无预设选项 — 在下方"其他"输入回答后按回车或点"发送"</div>'
    } else {
      const cur = ASK_MODAL_STATE.answers[step.question]
      optsEl.innerHTML = step.options.map((o, oi) => {
        const letter = String.fromCharCode(65 + oi)
        const isPicked = cur && cur.mode === 'answered' && cur.answer === o.label
        return `<button class="ask-modal-opt${isPicked ? ' clicked' : ''}" data-opt-idx="${oi}" data-opt-label="${escapeHtml(o.label)}">
          <span class="ask-modal-opt-letter">${letter}</span>
          <span class="ask-modal-opt-label">${escapeHtml(o.label)}</span>
        </button>`
      }).join('')
    }
  }
  // 恢复 other input (answered-other 模式)
  if (other) {
    const cur = ASK_MODAL_STATE.answers[step.question]
    other.value = (cur && cur.mode === 'answered-other') ? cur.answer : ''
  }
  // 发送按钮文案
  if (sendBtn) {
    if (isMulti) {
      const allDone = pq.steps.every(s => ASK_MODAL_STATE.answers[s.question] || state?.askUserAnswers?.[s.question])
      sendBtn.textContent = allDone ? '已答完 (点重发)' : `发送 (${pq.steps.length} 题)`
    } else {
      sendBtn.textContent = '发送'
    }
  }
}

// 弹窗内选项 click
export function onAskModalOptClick(btn) {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  if (!step) return
  const label = btn.getAttribute('data-opt-label') || ''
  if (!label) return
  // 设 answer (answered 模式)
  ASK_MODAL_STATE.answers[step.question] = { answer: label, mode: 'answered' }
  // 同步到全局 state.askUserAnswers (持久化)
  if (!state.askUserAnswers) state.askUserAnswers = {}
  setAskUserAnswer(step.question, { answer: label, mode: 'answered' })
  // 单 step: 选项 click 后自动 send
  if (pq.steps.length === 1) {
    submitAskModal()
  } else {
    // 多 step: 高亮 + 不发, 让用户能继续选下一题
    renderAskModalContent()
  }
}

// 弹窗 "其他" input 输入时
export function onAskModalOtherInput() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  if (!step) return
  const other = document.getElementById('ask-modal-other')
  if (!other) return
  const text = other.value.trim()
  if (text) {
    ASK_MODAL_STATE.answers[step.question] = { answer: text, mode: 'answered-other' }
    if (!state.askUserAnswers) state.askUserAnswers = {}
    setAskUserAnswer(step.question, { answer: text, mode: 'answered-other' })
  } else {
    delete ASK_MODAL_STATE.answers[step.question]
    if (state.askUserAnswers && state.askUserAnswers[step.question]?.mode === 'answered-other') {
      setAskUserAnswer(step.question, null)
    }
  }
}

// 弹窗 "发送" / 跳到下一题
export function askModalNextOrSend() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  // 先把 other input 同步进来
  onAskModalOtherInput()
  // 多 step: 还没到最后一题 → 切下一题
  if (pq.steps.length > 1 && ASK_MODAL_STATE.currentStep < pq.steps.length - 1) {
    ASK_MODAL_STATE.currentStep += 1
    renderAskModalContent()
    return
  }
  // 单 step / 多 step 最后一题 → 提交
  submitAskModal()
}

// 弹窗 "跳过" — 整个 questionnaire 跳过 (提交所有未答题为 "未回答" 给 mcode)
// v0.5.bx-15 (改): 之前是 "跳当前题 + 进下一题", 用户反馈 "问题弹窗关不掉" — 改成整个跳过
// v0.5.bx-20 (改): 关闭弹窗不持久化 dismiss — Wzdhehe 反馈
//   "如果跳过, 点叉号关掉, 回复未回答就可以" → 关闭即关, 下次 mcode 发新 ask_user 仍要弹窗
//   v0.5.bx-15 改 #3 (state.askUserDismissed + saveAskDismissed 持久化) 移除
export function askModalSkip() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  if (!state.askUserAnswers) state.askUserAnswers = {}
  // 所有 step 都标 skipped
  for (const step of pq.steps) {
    ASK_MODAL_STATE.answers[step.question] = { answer: '未回答', mode: 'skipped' }
    setAskUserAnswer(step.question, { answer: '未回答', mode: 'skipped' })
  }
  // 清 other input
  const other = document.getElementById('ask-modal-other')
  if (other) other.value = ''
  // 整个 questionnaire 提交
  submitAskModal()
}

// 提交弹窗答案 — 模板化 Q/A → sendAskAnswer → 关弹窗 → re-render
export function submitAskModal() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  // 收集所有 step 的最终 answer
  const blocks = []
  for (const step of pq.steps) {
    // 优先用弹窗临时答案, fallback 到全局 state.askUserAnswers
    const fromModal = ASK_MODAL_STATE.answers[step.question]
    const fromState = state?.askUserAnswers?.[step.question]
    const entry = fromModal || fromState
    const ans = entry ? entry.answer : '未回答'
    blocks.push(`Q: ${step.question}\nA: ${ans}`)
    // 持久化到全局 (用 final answer 兜底)
    if (!state.askUserAnswers) state.askUserAnswers = {}
    setAskUserAnswer(step.question, { answer: ans, mode: entry?.mode || 'skipped' })
  }
  if (blocks.length === 0) return
  const prompt = blocks.join('\n')
  // 清 pending (老 send() 入口检测用, 现在 modal 提交不走 send(), 但还是清一下)
  if (state?.pendingAskUser) state.pendingAskUser = null
  // 发给 mcode (isAskAnswer:true, server 不把 Q/A 加到 chat)
  sendAskAnswer(prompt)
  // 关弹窗
  closeAskModal()
  // re-render chat (让 inline 指示从"待答"变成"已答")
  renderAskUserToolIfChanged()
}

// 弹窗事件绑定 (一次性, 在 DOM ready 时)
export function bindAskModal() {
  const modal = document.getElementById('ask-modal')
  if (!modal) return
  const close = document.getElementById('ask-modal-close')
  const skip = document.getElementById('ask-modal-skip')
  const send = document.getElementById('ask-modal-send')
  const other = document.getElementById('ask-modal-other')
  const backdrop = document.getElementById('ask-modal-backdrop')
  const opts = document.getElementById('ask-modal-options')
  // v0.5.bx-28: X / Esc / 点背景 = 彻底放弃 (dismiss) — 关弹窗 + 清 pendingAskUser, 不发任何 Q/A 给 mcode
  //   用户明确说"我不回答这个问题, 让我正常发消息", 后续 chat 走 send() 正常通路, 不会被套 Q/A 模板
  //   "跳过" 按钮 (skip) 才是明确动作: 发 "Q: ... A: 未回答" 给 mcode, 走 askModalSkip → submitAskModal
  //   "发送" 按钮 (send) 走 askModalNextOrSend → submitAskModal: 模板化所有题目, 已答正常 Q/A, 未答 "未回答"
  if (close) close.addEventListener('click', closeAskModal)  // × 彻底放弃当前 ask
  if (skip) skip.addEventListener('click', askModalSkip)
  if (send) send.addEventListener('click', askModalNextOrSend)
  if (other) {
    other.addEventListener('input', onAskModalOtherInput)
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        askModalNextOrSend()
      }
    })
  }
  if (backdrop) backdrop.addEventListener('click', closeAskModal)  // 点背景 = 彻底放弃
  if (opts) {
    opts.addEventListener('click', (e) => {
      const btn = e.target.closest('.ask-modal-opt')
      if (!btn) return
      onAskModalOptClick(btn)
    })
  }
  // Esc 关闭 = 彻底放弃
  document.addEventListener('keydown', (e) => {
    if (ASK_MODAL_STATE.open && e.key === 'Escape') {
      e.preventDefault()
      closeAskModal()
    }
  })
}
// v0.5.bx-13: 立即绑定弹窗 (modal HTML 已在 script 之前, 直接能 getElementById)
bindAskModal()

// ============================================================
// Ask User Tool (v0.5.bx-8: mcode 0.1.4 ask_user 工具 — 内嵌选项 + 跳过)
// 选项 click → 自动 send "Q: <q> A: <label>"
// 跳过 click → 自动 send "Q: <q> A: 未回答"
// 弹窗外的 chat 消息 → send() 入口检测 state.pendingAskUser, 模板化
// 已答状态持久化: state.askUserAnswers[question] (跨 render 保留, 不被 parseChatLines 重建对象丢)
// v0.5.bx-8 (持久化): state.askUserAnswers 也写 localStorage, 刷新后能恢复
// ============================================================

// 模板化: 把 user answer 包装成 "Q: <question> A: <answer>" 发给 mcode
// mcode/LLM 看到这是 ask_user 工具的 result 上下文
export function buildAskUserPrompt(question, answer) {
  return `Q: ${question}\nA: ${answer}`
}

// 重渲染 chat (让已答状态 ✓ 立刻显示)
export function renderAskUserToolIfChanged() {
  if (typeof renderChat === 'function') renderChat()
  else if (typeof render === 'function') render()
}

// localStorage 持久化 — 刷新页面后能恢复已答状态, 避免按钮重新可点
export const ASK_ANSWERS_LS_KEY = 'webui-askUserAnswers'
export function loadAskUserAnswers() {
  try {
    const raw = localStorage.getItem(ASK_ANSWERS_LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (e) {
    console.warn('[ask-user] loadAskUserAnswers failed', e)
    return {}
  }
}
export function saveAskUserAnswers(answers) {
  try {
    localStorage.setItem(ASK_ANSWERS_LS_KEY, JSON.stringify(answers || {}))
  } catch (e) {
    console.warn('[ask-user] saveAskUserAnswers failed', e)
  }
}
// 包装函数: 设 state.askUserAnswers[q] = entry 时同步写 localStorage
//   注意: 不会覆盖整个 state.askUserAnswers, 只 set/delete 单个 key
//   额外 (v0.5.bx-15 改 #3): 把 question 加到 module-level DISMISSED_QUESTIONS set
//     这样切到任何 mcode session, 该 question 都不会再弹 (即使 pq key 不同)
export function setAskUserAnswer(question, entry) {
  if (!state) return
  if (!state.askUserAnswers) state.askUserAnswers = {}
  if (entry === null || entry === undefined) {
    delete state.askUserAnswers[question]
  } else {
    state.askUserAnswers[question] = entry
    if (typeof DISMISSED_QUESTIONS !== 'undefined' && question) {
      DISMISSED_QUESTIONS.add(question)
    }
  }
  saveAskUserAnswers(state.askUserAnswers)
}

// v0.5.bx-15 (改): localStorage 持久化 "弹窗已 dismiss" 标志 — reload 后还能拦住
//   per-CID 存, 不同浏览器 tab / 设备独立
export const ASK_DISMISSED_LS_KEY = () => `webui-askDismissed-${CID}`
export function loadAskDismissed() {
  try {
    return localStorage.getItem(ASK_DISMISSED_LS_KEY()) === '1'
  } catch (e) { return false }
}
export function saveAskDismissed(v) {
  try {
    if (v) localStorage.setItem(ASK_DISMISSED_LS_KEY(), '1')
    else localStorage.removeItem(ASK_DISMISSED_LS_KEY())
  } catch (e) {
    console.warn('[ask-user] saveAskDismissed failed', e)
  }
}
// 重置入口 (用户在 logo 上长按 3 秒触发) — 让用户能反悔重新看到弹窗
export function resetAskDismissed() {
  saveAskDismissed(false)
  if (state) state.askUserDismissed = false
  ASK_MODAL_STATE.presentedKeys.clear()
}

// v0.5.bx-NN: removed dead sendPlanAnswer declaration (was at line ~1850 in original).
//   The original inline <script> had two declarations of sendPlanAnswer; non-strict script
//   mode let the second declaration (line 4108, modal flow, calls /api/answer) overwrite
//   the first (simple /api/send). ES modules are strict — duplicate function declarations
//   throw SyntaxError. Removed the dead first declaration to preserve original behavior.

export function openPlanModal(planMsg) {
  const root = document.getElementById('modal-root')
  if (!root) return
  // v0.5.ab: 弹窗打开时让 modal-root 接收 pointer-events（之前用 pointer-events:none 防止平时挡点击，
  // 但子元素没显式 auto 就继承 none，导致 X 按钮、背景点击全失效）
  root.style.pointerEvents = 'auto'
  root.innerHTML = `
    <div class="modal-overlay" id="plan-modal">
      <div class="modal" role="dialog" aria-label="Plan Review">
        <div class="modal-header">
          <span>📋</span>
          <span class="modal-header-title">${t('plan_review')} · ${escapeHtml(planMsg.title)}</span>
          <span class="modal-header-meta">Frozen Runtime snapshot</span>
          <button class="modal-close" id="plan-modal-close" aria-label="关闭">×</button>
        </div>
        <div class="modal-body" id="plan-modal-body">${parseMarkdown(planMsg.content || '*（空）*')}</div>
        <div class="modal-footer">
          <span>↑↓ select · Enter confirm · Esc skip · PgUp/PgDn scroll</span>
          <span class="modal-footer-spacer"></span>
          ${planMsg.options.map(o => `<button class="plan-action ${o.selected ? 'primary' : ''}" data-modal-opt="${escapeHtml(o.text)}">${escapeHtml(o.text)}</button>`).join('')}
        </div>
      </div>
    </div>
  `
  const close = () => {
    root.innerHTML = ''
    root.style.pointerEvents = 'none'  // 关闭后恢复不挡点击
  }
  document.getElementById('plan-modal-close').addEventListener('click', close)
  document.getElementById('plan-modal').addEventListener('click', (e) => {
    // 点 overlay 背景（非 modal 内容）关闭
    if (e.target.id === 'plan-modal') close()
  })
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) }
  })
  root.querySelectorAll('[data-modal-opt]').forEach(el => {
    el.addEventListener('click', async () => {
      const text = el.getAttribute('data-modal-opt')
      close()
      await sendPlanAnswer(text)
    })
  })
}

export function parseChatLines(lines) {
  // › user / ● assistant / ○ system / ◎ Goal/Ask / ✓ todo / Plan: 标题 块
  const messages = []
  let current = null
  let currentType = null
  let i = 0

  const isNewBlockStart = (l) => /^[›>●•○◯◎✓✔◌✗✘×▲!→]/.test(l) || /^Plan\s*[:：]/i.test(l.trim()) || /^Ask\b/i.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]
    if (!line) { i++; continue }

    // Plan block（以 "Plan: 标题" 开头，到 "Plan complete." 之后 + 3 个选项，到下一行 prefix）
    if (/^Plan\s*[:：]\s*.+/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const plan = collectPlanBlock(lines, i)
      messages.push({ role: 'plan', ...plan })
      i = plan.endIdx
      continue
    }

    // Ask block（以 ◎ Ask / Ask 开头，到下一行 prefix 或 footer hint）
    if (/^[\u25ce]\s*Ask\b/i.test(line.trim()) || /^Ask\b\s*[:：]?/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const ask = collectAskBlock(lines, i)
      messages.push({ role: 'ask', ...ask })
      i = ask.endIdx
      continue
    }

    // Goal block
    if (/^[\u25ce]\s*Goal\b/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const goal = { role: 'goal', text: line, items: [] }
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (!l) break
        if (isNewBlockStart(l)) break
        goal.text += '\n' + l
        j++
      }
      messages.push(goal)
      i = j
      current = null; currentType = null
      continue
    }

    // User message
    if (/^[›>]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'user', text: line.replace(/^[›>]\s+/, '') }
      currentType = 'user'
      i++
      continue
    }

    // Assistant message
    if (/^[●•]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'assistant', text: line.replace(/^[●•]\s+/, '') }
      currentType = 'assistant'
      i++
      continue
    }

    // Todo item（v0.5.ab: 必须放在 system 前面，否则 ○ 会被先匹配成 system）
    // v0.5.ag: 之前会吞掉 system 错误（[error] / Questionnaire）— 提到 todo 之前先排除
    if (/^[✓✔○◌◯✗✘×]\s+/.test(line)) {
      const tm = line.match(/^([✓✔○◌◯✗✘×])\s+(.+)$/)
      const ttext = tm ? tm[2] : ''
      // 看起来像 system 的（!前缀 [新] / ○ [error|warning|info] [旧] / ○ Questionnaire/requires [旧]）→ 走 system 分支
      if (tm && (/^\[(error|warning|info|system)\]/i.test(ttext) || /Questionnaire|requires.*user input|requires.*interactive/i.test(ttext))) {
        if (current) messages.push(current)
        current = { role: 'system', text: ttext }
        currentType = 'system'
        i++
        continue
      }
      if (currentType !== 'todo' || !current) {
        if (current) messages.push(current)
        current = { role: 'todo', text: '', items: [] }
        currentType = 'todo'
      }
      const m = tm
      if (m) {
        const status = m[1] === '✓' || m[1] === '✔' ? 'done' : m[1] === '✗' || m[1] === '✘' || m[1] === '×' ? 'failed' : 'pending'
        current.items.push({ status, text: m[2] })
      }
      i++
      continue
    }

    // System message
    if (/^[○◯]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'system', text: line.replace(/^[○◯]\s+/, '') }
      currentType = 'system'
      i++
      continue
    }

    // v0.5.ag: 错误/系统提示（! 前缀，避免与 todo 的 ○ 冲突）
    if (/^!\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'system', text: line.replace(/^!\s+/, '') }
      currentType = 'system'
      i++
      continue
    }

    // v0.5.ac: Thinking block（▲ 前缀）。连续多行 ▲ 聚成单个 thinking 块
    if (/^▲\s+/.test(line)) {
      if (currentType !== 'thinking' || !current) {
        if (current) messages.push(current)
        current = { role: 'thinking', text: line.replace(/^▲\s+/, '') }
        currentType = 'thinking'
      } else {
        current.text += '\n' + line.replace(/^▲\s+/, '')
      }
      i++
      continue
    }

    // v0.5.bw: Tool call block（→ 前缀）。
    //   格式：→ toolName  {input}     ← tool 块头
    //         [status]                 ← server v0.5.bs 写的 `  [completed]`
    //         output line 1            ← server v0.5.bs 写的 `  text`
    //         output line 2
    //         @ /path/to/file          ← server v0.5.bx-6 写的 tool locations
    //         ! error text             ← server v0.5.bs 写的 `  ! ...`
    // 收集直到下一个非 `  ` 缩进行
    if (/^→\s+/.test(line)) {
      if (current) { messages.push(current); current = null; currentType = null }
      // 解析 → toolName [input]
      const tm = line.match(/^→\s+(\S+?)(?:\s{2}(.+))?$/)
      const tool = {
        role: 'tool',
        name: tm ? tm[1] : 'tool',
        input: (tm && tm[2]) ? tm[2] : '',
        status: 'pending',
        output: [],
        locations: [],   // v0.5.bx-6: tool 涉及的本地文件路径
        error: null,
        streaming: false,  // v0.5.bw: 流式中默认展开
      }
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (l == null) { j++; continue }
        // 2+ 空格缩进 = 属于本 tool 块
        if (/^\s{2,}\S/.test(l)) {
          const stripped = l.replace(/^\s{2,}/, '')
          const statusMatch = stripped.match(/^\[([^\]]+)\]$/)
          if (statusMatch) {
            tool.status = statusMatch[1]
            // v0.5.bw: status=in_progress 时默认展开
            if (statusMatch[1] === 'in_progress') tool.streaming = true
          } else if (/^!\s+/.test(stripped)) {
            tool.error = stripped.replace(/^!\s+/, '')
          } else if (/^@\s+/.test(stripped)) {
            // v0.5.bx-6: 路径行 — 跟输出分开存
            const p = stripped.replace(/^@\s+/, '').trim()
            if (p && !tool.locations.includes(p)) tool.locations.push(p)
          } else {
            tool.output.push(stripped)
          }
          j++
        } else {
          break
        }
      }
      messages.push(tool)
      i = j
      current = null; currentType = null
      continue
    }

    // Continuation of current message
    if (current) {
      current.text += (current.text ? '\n' : '') + line
    }
    i++
  }
  if (current) messages.push(current)
  return messages
}

// v0.5.ab: 收集 Plan 块（"Plan: 标题" → Summary/目标/非目标 → "Plan complete." → 选项）
export function collectPlanBlock(lines, startIdx) {
  const titleMatch = lines[startIdx].trim().match(/^Plan\s*[:：]\s*(.+)$/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const contentLines = []
  const options = []
  let phase = 'content'  // 'content' | 'options'
  let i = startIdx + 1

  while (i < lines.length) {
    const l = lines[i]
    if (!l) { i++; continue }
    const trimmed = l.trim()
    // 遇新块：用户/助手/系统/todo/新 ask/新 plan → 停
    // 注意：在 options 阶段，" > 1. xxx" 形式不能算 user message，要继续
    const isOptionLine = phase === 'options' && /^[>\s]*\d+\.\s+/.test(l)
    if (!isOptionLine) {
      if (/^[›>●•○◯◎✓✔◌✗✘×]/.test(l)) break
      if (/^Plan\s*[:：]/i.test(trimmed)) break
      if (/^Ask\b/i.test(trimmed)) break
    }

    if (/^Plan complete\./i.test(trimmed)) {
      phase = 'options'
      i++
      // 跳过 "What would you like to do?" 一行
      if (i < lines.length && /what would you like to do/i.test(lines[i])) i++
      continue
    }

    if (phase === 'options') {
      // 形如 "  1. Agree and start implementation" 或 "> 1. Agree ..." 或 "> Agree ..."
      const optMatch = l.match(/^[>\s]*(\d+)\.\s+(.+)$/) || l.match(/^>\s+(.+)$/) || l.match(/^\s*[-*]\s+(.+)$/)
      if (optMatch) {
        options.push({ num: (optMatch[1] || '1').toString(), text: optMatch[2].trim(), selected: l.trimStart().startsWith('>') })
      } else if (trimmed) {
        // 兜底：非空行也作为选项
        options.push({ num: String(options.length + 1), text: trimmed, selected: false })
      }
    } else {
      contentLines.push(l)
    }
    i++
  }
  return { title, content: contentLines.join('\n'), options, endIdx: i }
}

// v0.5.ab: 收集 Ask 块（"◎ Ask" / "Ask" → 标签/问题/编号选项）
export function collectAskBlock(lines, startIdx) {
  const blockLines = []
  let i = startIdx
  while (i < lines.length) {
    const l = lines[i]
    if (!l) { i++; continue }
    // tab 行（含 ● 和 ○，如 "● 故事类型  ○ 长度"）是 ask 的多问题标签，不能算新消息
    const isTabLine = /[●•].*[○◯]|[○◯].*[●•]/.test(l)
    if (!isTabLine) {
      if (/^[›>●•○◯◎✓✔◌✗✘×]/.test(l) && !/^[\u25ce]\s*Ask\b/i.test(l.trim())) break
      if (/^Plan\s*[:：]/i.test(l.trim())) break
      // 底部快捷键提示 "↑↓ move" / "1-5 select" / "Esc cancel" / "Tab/←/→" → 停
      if (/^↑↓\s/.test(l.trim()) || /^\d+-\d+\s+select/i.test(l.trim()) ||
          /^Esc\s+(cancel|back|deny)/i.test(l.trim()) || /^Tab\//i.test(l.trim())) break
    }
    blockLines.push(l)
    i++
  }
  return { raw: blockLines, endIdx: i }
}

export function renderMessage(msg, ctx) {
  if (msg.role === 'goal') {
    return `<div class="goal-block">
      <div class="goal-block-label">◎ ${t('section_goal')}</div>
      <div class="goal-block-text">${escapeHtml(msg.text)}</div>
    </div>`
  }
  // v0.5.bw: 工具调用块（→ toolName + output/status/error）
  // 模仿 mcode TUI 的样式：tool 块独立成块，header 显示 tool name + status
  // 默认折叠（点开看 input/output），流式中（status=in_progress）默认展开
  if (msg.role === 'tool') {
    const statusClass = msg.status === 'completed' ? 'done'
      : msg.status === 'failed' ? 'failed'
      : msg.status === 'in_progress' ? 'running'
      : 'pending'
    const statusLabel = msg.status === 'completed' ? '✓'
      : msg.status === 'failed' ? '✗'
      : msg.status === 'in_progress' ? '…'
      : '○'
    // input 尝试 JSON 解析（pretty）— 失败就原样显示
    let inputHtml = ''
    if (msg.input) {
      let pretty = msg.input
      try {
        const parsed = JSON.parse(msg.input)
        pretty = JSON.stringify(parsed, null, 2)
      } catch {}
      inputHtml = `<div class="msg-tool-input"><span class="msg-tool-label">input</span><pre>${escapeHtml(pretty)}</pre></div>`
    }
    const outputText = msg.output.join('\n')
    let outputHtml = ''
    // v0.5.bx-7: ask_user 工具的特殊渲染 — 检测 INPUT 里的 questionnaire JSON
    //   mcode 0.1.4 调 ask_user 时 INPUT 是 { mode: "questionnaire", ... }（output 是 "waiting" 文本）
    //   解析成 question + options，渲染成可点击按钮 (内嵌在 tool 块里)
    // v0.5.bx-8: 选项 click → 自动 send (不走输入框); 加 .ask-skip 跳过按钮 → 发 "Q: ... A: 未回答";
    //   加 .ask-answered 状态条; 设 state.pendingAskUser 让 send() 模板化后续 chat 消息
    let questionnaireHtml = ''
    if (msg.name === 'ask_user' && msg.input && !msg.parsedQuestionnaire) {
      try {
        let inputStr = msg.input
        if (typeof inputStr === 'string') {
          const jsonStart = inputStr.indexOf('{')
          if (jsonStart >= 0) inputStr = inputStr.slice(jsonStart)
        }
        const q = typeof inputStr === 'string' ? JSON.parse(inputStr) : inputStr
        if (q && (q.mode === 'questionnaire' || q.steps)) {
          const rawSteps = Array.isArray(q.steps) ? q.steps : [q]
          // v0.5.bx-8: 存所有 step, 区分单/多模式
          //   单 step (rawSteps.length === 1): 选项 click 自动 send, 跳过按钮自动发 — 跟之前一致
          //   多 step (rawSteps.length > 1): 选项 click 只 highlight, 底部"发送"按钮模板化发, 没选 = 未回答
          const steps = rawSteps.map(step => ({
            question: step.question || step.title || '',
            options: (Array.isArray(step.options) ? step.options : []).map((o, oi) => ({
              label: (o && (o.label || o.text)) || `Option ${oi + 1}`,
              desc: (o && o.description) || '',
            })),
          }))
          msg.parsedQuestionnaire = {
            steps,
            mode: steps.length > 1 ? 'multi' : 'single',
          }
        }
      } catch {}
    }
    if (msg.parsedQuestionnaire) {
      const pq = msg.parsedQuestionnaire
      const isMulti = pq.mode === 'multi'
      const allAnswered = isMulti
        ? pq.steps.every(s => state?.askUserAnswers?.[s.question])
        : !!state?.askUserAnswers?.[pq.steps[0].question]

      // v0.5.bx-13: 弹窗模式 — inline 只显示紧凑指示 (不再内嵌 questionnaire HTML)
      //   实际交互走 #ask-modal 弹窗
      const firstQ = pq.steps[0]?.question || ''
      const statusText = allAnswered
        ? (isMulti ? '已答完' : `已答: ${(state.askUserAnswers[firstQ] && state.askUserAnswers[firstQ].answer) || '—'}`)
        : (isMulti ? `${pq.steps.length} 题待答` : '待答')
      questionnaireHtml = `<div class="msg-ask-indicator" data-ask-tool="${escapeHtml(firstQ)}" title="${escapeHtml(firstQ)}">
        <span class="msg-ask-indicator-icon">❓</span>
        <span>ask_user</span>
        <span class="msg-ask-indicator-status">· ${escapeHtml(statusText)}</span>
        ${!allAnswered ? '<span style="color:var(--text-tertiary);font-size:11px">· 弹窗已弹出</span>' : ''}
      </div>`
      // v0.5.bx-13: 首次解析时自动打开弹窗 (去重: 同 key 的 ask 不重复弹)
      // v0.5.bx-20: 只有"最新"包含 ask_user 的 message 才弹窗 (ctx.isLatestAsk)
      //   旧 chat history 里的 ask 不弹, 避免 mcode LLM 死循环反复弹同一题
      //   点 chat 里的 inline ask indicator 重新打开弹窗走 source:'click', 不受 isLatestAsk 限制 (见 attachStructuredBlockHandlers)
      const isLatestAsk = !!(ctx && ctx.isLatestAsk)
      openAskModal(pq, { isLatestAsk, source: 'render' })

      // v0.5.bx-31: 删掉 render 时设 state.pendingAskUser 的逻辑
      //   之前: 给每个未答的 ask_user 块都设 pendingAskUser, 让 send() 把下一条 chat 套成 Q/A 模板
      //         副作用: 历史 ask_user 块 (不是最新回复) 也触发模板化 — 进入有 N 个历史 ask 的对话,
      //         前 N 条 chat 都会被套成 "Q: Qx\nA: <输入>" 当假答案, 用户体验极差
      //   现在: Q/A 模板化只在弹窗 submit / skip / option click / 其他输入 时走 submitAskModal
      //         chat 输入框发消息永远走正常通路, 不被套
      //   pendingAskUser 字段保留 (closeAskModal 防御性清) 但不再被设也不再被 send() 读
    }
    if (outputText) {
      outputHtml = `<div class="msg-tool-output"><span class="msg-tool-label">output</span><pre>${escapeHtml(outputText)}</pre></div>`
    }
    // v0.5.bx-6: tool 涉及的本地文件路径 — 点击复制到剪贴板，hover 显示完整路径
    let locationsHtml = ''
    if (Array.isArray(msg.locations) && msg.locations.length > 0) {
      const items = msg.locations.map(p => {
        const safe = escapeHtml(p)
        return `<div class="msg-tool-loc" data-path="${safe}" title="点击复制：${safe}">
          <span class="msg-tool-loc-icon">📄</span><span class="msg-tool-loc-path">${safe}</span>
        </div>`
      }).join('')
      locationsHtml = `<div class="msg-tool-locations"><span class="msg-tool-label">files</span>${items}</div>`
    }
    let errorHtml = ''
    if (msg.error) {
      errorHtml = `<div class="msg-tool-error">${escapeHtml(msg.error)}</div>`
    }
    // 默认展开规则：completed (看 output) / streaming / 有 error → 展开；pending + 无 output → 折叠
    const hasContent = !!(msg.input || outputText || msg.error || questionnaireHtml || (msg.locations && msg.locations.length))
    const open = msg.streaming || msg.status === 'in_progress' || msg.status === 'failed' || hasContent
    // v0.5.bx-7: 问卷模式下隐藏 raw input + output（避免重复显示 JSON + 按钮）
    const finalInputHtml = msg.parsedQuestionnaire ? '' : inputHtml
    const finalOutputHtml = msg.parsedQuestionnaire ? '' : outputHtml
    return `<details class="msg-tool"${open ? ' open' : ''}>
      <summary>
        <span class="msg-tool-toggle">▸</span>
        <span class="msg-tool-icon">🔧</span>
        <span class="msg-tool-name">${escapeHtml(msg.name)}</span>
        <span class="msg-tool-status ${statusClass}">${statusLabel} ${escapeHtml(msg.status)}</span>
      </summary>
      <div class="msg-tool-body">
        ${finalInputHtml}
        ${questionnaireHtml}
        ${finalOutputHtml}
        ${locationsHtml}
        ${errorHtml}
      </div>
    </details>`
  }
  if (msg.role === 'todo') {
    return `<div class="todo-block">
      ${msg.items.map(i => `<div class="todo-item ${i.status}">
        <span class="todo-marker">${i.status === 'done' ? '✓' : i.status === 'failed' ? '✗' : '○'}</span>
        <span class="todo-text">${escapeHtml(i.text)}</span>
      </div>`).join('')}
    </div>`
  }
  if (msg.role === 'plan') return renderPlanBlock(msg)
  if (msg.role === 'ask')  return renderAskBlock(msg)
  // v0.5.ad: 检测末尾 ▍ 流式光标 — 拆出 text 和光标 span 单独渲染
  let body = msg.text
  let cursorHtml = ''
  if (body && body.endsWith(' ▍')) {
    body = body.slice(0, -2)
    cursorHtml = '<span class="msg-cursor">▍</span>'
  }
  // v0.5.af: 思考内容 — 紧凑内联 toggle，无 avatar 无双层标题
  if (msg.role === 'thinking') {
    const isStreaming = !!cursorHtml
    const lineCount = body.split('\n').filter(l => l.trim()).length
    const lineHint = lineCount > 1 ? ` <span class="msg-thinking-count">${lineCount} ${t('lines') || '行'}</span>` : ''
    return `<details class="msg-thinking-inline"${isStreaming ? ' open' : ''}>
      <summary>
        <span class="msg-thinking-toggle">▸</span>
        <span>${t('section_thinking') || '思考'}</span>${lineHint}
      </summary>
      <div class="msg-thinking">${parseMarkdown(body)}${cursorHtml}</div>
    </details>`
  }
  // v0.5.bs: assistant 消息的 avatar 改成 brand logo 图（user/system 仍是字母）
  const avatar = msg.role === 'user' ? 'You' : msg.role === 'assistant'
    ? '<img class="msg-avatar-img" src="/brand-logo.png" alt="MiniMax Code" />'
    : 'i'
  const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Mcode' : 'System'
  return `<div class="msg ${msg.role}">
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-content">
      <div class="msg-role">${role}</div>
      <div class="msg-body">${parseMarkdown(body)}${cursorHtml}</div>
    </div>
  </div>`
}

// v0.5.ab: 渲染 Plan 块（内联 + "查看完整计划" 按钮触发弹窗）
export function renderPlanBlock(msg) {
  const optsHtml = msg.options.map(o => `
    <div class="plan-action ${o.selected ? 'primary' : ''}" data-plan-opt="${escapeHtml(o.text)}">
      ${escapeHtml(o.text)}
    </div>`).join('')
  return `<div class="plan-block" data-plan-id="${msg.title}">
    <div class="plan-block-header">
      <span>📋</span>
      <span class="plan-block-title">Plan: ${escapeHtml(msg.title)}</span>
      <span class="plan-block-meta">${msg.content.split('\n').length} 行</span>
    </div>
    <div class="plan-block-summary">${parseMarkdown(msg.content || '*（无内容预览）*')}</div>
    ${msg.options.length > 0 ? `<div class="plan-block-actions">${optsHtml}</div>` : ''}
    <div class="plan-block-actions" style="margin-top:6px">
      <button class="plan-action" data-plan-view="${escapeHtml(msg.title)}">查看完整计划（弹窗）</button>
    </div>
  </div>`
}

// v0.5.ab: 渲染 Ask 块（内联 + 点击选项触发 send）
export function renderAskBlock(msg) {
  // 解析 raw 行：① header (◎ Ask / Ask) ② 标签行 (● X  ○ Y) ③ 问题 ④ 选项 1..N
  const raw = msg.raw
  let headerText = ''
  let tabsText = ''
  let question = ''
  const options = []
  let hasOther = false

  for (const line of raw) {
    const t = line.trim()
    if (/^[\u25ce]\s*Ask\b/i.test(t) || /^Ask\s*[:：]?/i.test(t)) {
      if (!headerText) headerText = t
      continue
    }
    // 标签行: "● 故事类型  ○ 长度"（含 ● 和 ○）
    if (/[●•]/.test(t) && /[○◯]/.test(t) && !/^\d+\./.test(t)) {
      tabsText = t
      continue
    }
    // 编号选项: "  1  温暖治愈（生活/友情）  贴近日常..." 或 "  1. xxx"
    const optMatch = t.match(/^(\d+)\s+(.+)$/) || t.match(/^(\d+)\.\s+(.+)$/)
    if (optMatch) {
      const num = optMatch[1]
      // 剩余部分可能含 label + description
      const rest = optMatch[2]
      // 检测 Other
      if (/^Other\b/i.test(rest) || /^Others\b/i.test(rest)) {
        hasOther = true
        options.push({ num, label: rest.split(/\s{2,}|\s+/)[0] || 'Other', desc: rest, isOther: true })
      } else {
        // label 和 description 用 2+ 空格或 description 里常见词分割
        const parts = rest.split(/\s{2,}/)
        if (parts.length >= 2) {
          options.push({ num, label: parts[0], desc: parts.slice(1).join('  ') })
        } else {
          // 单段就当 label
          options.push({ num, label: rest, desc: '' })
        }
      }
      continue
    }
    // 其它行作为问题（直到编号选项出现）
    if (options.length === 0) {
      question = question ? question + '\n' + t : t
    }
  }

  const total = options.length || 1
  const optsHtml = options.map(o => `
    <div class="ask-option" data-ask-opt="${escapeHtml(o.label)}" data-ask-other="${o.isOther ? '1' : '0'}">
      <span class="ask-option-num">${o.num}</span>
      <span class="ask-option-label">${escapeHtml(o.label)}</span>
      ${o.desc ? `<span class="ask-option-desc">${escapeHtml(o.desc)}</span>` : ''}
    </div>`).join('')

  return `<div class="ask-block">
    <div class="ask-block-header">
      <span>◎</span>
      <span>${t('ask_title') || 'Ask'}</span>
      <span class="ask-block-progress">0/${total}</span>
    </div>
    ${tabsText ? `<div class="ask-block-tabs" style="margin-bottom:8px;color:var(--text-tertiary);font-size:12px">${escapeHtml(tabsText)}</div>` : ''}
    ${question ? `<div class="ask-block-question">${escapeHtml(question)}</div>` : ''}
    ${optsHtml}
  </div>`
}

// ============================================================
// Markdown (v0.5.ab: 用 marked + highlight.js 替换原 inline parser)
// ============================================================
// 注：bash.min.js / javascript.min.js / json.min.js 加载时已经自动调
// window.hljs.registerLanguage(...)，所以这里不用再手动注册。
if (window.marked) {
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value } catch {}
      }
      return window.escapeHtml ? escapeHtml(code) : code
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  })
}
// ============================================================
// Slash command overlay
// ============================================================
