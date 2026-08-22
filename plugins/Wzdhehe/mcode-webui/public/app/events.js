// webui/public/app/events.js — REFACTORING.md batch 4 step 2
// Owns: attachEvents/attachModalEvents wiring, slash overlay, mode
// popover, attachments/upload, send/stopExec, plan/perm modal flows,
// keyboard nav, language toggle.

import { applyI18n, applyTheme, currentLang, setLang, t, toggleTheme } from './i18n.js'
import { MODE_ICONS, __DBG, escapeHtml, formatNumber, formatResetTime, formatTimeUntil, nextFiveHourReset, nextWeeklyReset, parseMarkdown, showToast } from './util.js'
import { refreshSessions, API_SUFFIX, CID, CID_QUERY, HEADERS, TOKEN, TOKEN_QUERY, autoRefreshTimer, connect, es, getGeneralQuota, leftOpen, refreshUsage, renderUsage, renderUsagePopover, renderUsageValue, rightOpen, sessionSearchQuery, setSearchQuery, setSidebarReady, setState, state, toggleUsagePopover, tokenParam, urlParams } from './state.js'
import { ASK_ANSWERS_LS_KEY, ASK_DISMISSED_LS_KEY, ASK_MODAL_STATE, DISMISSED_QUESTIONS, askModalNextOrSend, askModalPqKey, askModalSkip, attachStructuredBlockHandlers, bindAskModal, buildAskUserPrompt, cancelConfirm, clearAskPresentedKeys, closeAskModal, collapsedWorkspaces, collectAskBlock, collectPlanBlock, deleteSession, hideRightForWelcome, loadAskDismissed, loadAskUserAnswers, onAskModalOptClick, onAskModalOtherInput, openAskModal, openPlanModal, parseChatLines, render, renderAskBlock, renderAskModalContent, renderAskUserToolIfChanged, renderChat, renderContext, renderGoal, renderMessage, renderPlanBlock, renderRight, renderSessions, renderTodo, renderUserFooter, resetAskDismissed, saveAskDismissed, saveAskUserAnswers, saveCollapsedWorkspaces, sendAskAnswer, setAskUserAnswer, submitAskModal, suppressAskModal, switchSession, wsShortName } from './render.js'

export let slashOpen = false
export let slashQuery = ''
export let slashActiveIdx = 0
export let slashFiltered = []
export let modeOpen = false
// v0.5.ap: 旧 settingsOpen 变量已废弃（v0.5.ap 改用 settings-modal 替代旧 settings-menu）
// 保留定义兼容可能的旧代码引用，但本文件其他地方不再使用
// let settingsOpen = false
export let attachedFiles = []
export let isSending = false

// Modal state (v0.5.bx-14: askOpen/askSelectedIdx/askSending/lastShownAskKey 已删, 用 #ask-modal ASK_MODAL_STATE)
export let planOpen = false
export let planSending = false
export let planModeOpen = false
export let permOpen = false
export let lastShownPlanKey = null
export let lastShownPermKey = null
export let lastShownPlanModeKey = null

// ============================================================
// Slash commands
// v0.5.bx-23: 删掉 11 个 mcode 0.1.5 acp 不识别的"假命令"
//   之前列的 17 个里: /sessions /plan /permission /plugins /provider /feedback /steer /init /logout /quit
//   mcode 0.1.5 acp 都不识别 (availableCommands 只有 10 个, mcode 0.1.5 acp 也不暴露 goal/plan)
//   删掉避免 user 输完发现啥也没发生
// 保留: mcode 真支持 5 个 (help/new/model/status/usage) + webui 自己处理 4 个 (goal/goal-done/goal-blocked/clear)
//   + 加 mcode 真的但 webui 漏的 4 个 (doctor/skills/mcp/compact) — 让 user 知道这些命令可用
// ============================================================
export const SLASH_COMMANDS = [
  // --- mcode 0.1.5 acp 真支持 ---
  { cmd: '/help', zh: '显示可用命令', en: 'Show available commands' },
  { cmd: '/new', zh: '开启新会话', en: 'Start a fresh session' },
  { cmd: '/model', zh: '选择模型', en: 'Choose model' },
  { cmd: '/context', zh: '只读上下文', en: 'Read-only context' },
  { cmd: '/doctor', zh: '诊断 mcode 健康度', en: 'Diagnose mcode health' },
  { cmd: '/skills', zh: '管理 skills', en: 'Manage skills' },
  { cmd: '/mcp', zh: 'MCP servers', en: 'MCP servers' },
  { cmd: '/usage', zh: '会话用量', en: 'Show session usage' },
  { cmd: '/compact', zh: '压缩上下文', en: 'Compact context' },
  // --- webui 自己处理 (不走 mcode) ---
  { cmd: '/status', zh: '当前 session 状态 (webui)', en: 'Show current session status (webui)' },
  { cmd: '/goal', zh: '设定目标 (webui 改写消息, 单轮执行)', en: 'Set goal (webui rewrites msg, single-turn)' },
  { cmd: '/goal-done', zh: '标记目标完成 (webui)', en: 'Mark goal done (webui)' },
  { cmd: '/goal-blocked', zh: '标记目标阻塞 (webui)', en: 'Mark goal blocked (webui)' },
  { cmd: '/clear', zh: '清空当前对话 (webui)', en: 'Clear current chat (webui)' },
]

export const SLASH_SKILLS = [
  { name: 'plan', zh: 'Plan Mode（先出方案再执行）', en: 'Plan Mode (plan first)' },
  { name: 'context', zh: '只读当前会话上下文', en: 'Read-only session context' },
  { name: 'feedback', zh: '提交反馈', en: 'Submit feedback' },
]

export const slashOverlay = document.getElementById('slash-overlay')
export const slashInput = document.getElementById('slash-input')
export const slashResults = document.getElementById('slash-results')

export function showSlash() {
  slashOpen = true
  slashOverlay.hidden = false
  slashInput.value = slashQuery
  filterSlash()
  setTimeout(() => slashInput.focus(), 0)
}
export function hideSlash() {
  slashOpen = false
  slashOverlay.hidden = true
  slashQuery = ''
  slashActiveIdx = 0
}
export function filterSlash() {
  const q = slashQuery.toLowerCase()
  const cmds = SLASH_COMMANDS.filter(c => {
    if (!q) return true
    return c.cmd.toLowerCase().includes(q) || c.zh.includes(q) || c.en.toLowerCase().includes(q)
  })
  const skills = SLASH_SKILLS.filter(s => {
    if (!q) return true
    return s.name.toLowerCase().includes(q) || s.zh.includes(q) || s.en.toLowerCase().includes(q)
  })
  slashFiltered = [...cmds, ...skills]  // 合并，但渲染时分 section
  slashActiveIdx = 0
  if (cmds.length === 0 && skills.length === 0) {
    slashResults.innerHTML = `<div class="slash-item empty">${t('slash_no_results')}</div>`
  } else {
    let html = ''
    let idx = 0
    if (cmds.length > 0) {
      html += `<div class="slash-section-label">${t('slash_section_cmd')}</div>`
      html += cmds.map((c, i) => {
        const active = i === 0 ? 'active' : ''
        idx++
        return `<div class="slash-item ${active}" data-idx="${i}" data-cmd="${c.cmd}" data-kind="cmd">
          <span class="slash-item-cmd">${escapeHtml(c.cmd)}</span>
          <span class="slash-item-desc">${escapeHtml(currentLang === 'zh' ? c.zh : c.en)}</span>
        </div>`
      }).join('')
    }
    if (skills.length > 0) {
      html += `<div class="slash-section-label">${t('slash_section_skill')}</div>`
      html += skills.map((s, i) => {
        const active = (cmds.length === 0 && i === 0) ? 'active' : ''
        const idxGlobal = cmds.length + i
        return `<div class="slash-item slash-skill ${active}" data-idx="${idxGlobal}" data-cmd="/skill ${s.name}" data-kind="skill">
          <span class="slash-item-cmd">${escapeHtml(s.name)}</span>
          <span class="slash-item-desc">${escapeHtml(currentLang === 'zh' ? s.zh : s.en)}</span>
        </div>`
      }).join('')
    }
    slashResults.innerHTML = html
  }
}

// ============================================================
// Mode popover
// ============================================================
export const modePopover = document.getElementById('mode-popover')
export function toggleMode() {
  modeOpen = !modeOpen
  modePopover.hidden = !modeOpen
}
export function hideMode() { modeOpen = false; modePopover.hidden = true }
export async function setMode(mode) {
  // v0.5.by: plan 模式本地 toggle — mcode 0.1.5 acp 不支持 session/set_mode (probe 验证 Method not found)
  //   fallback: send() 时给 prompt 加 plan 模板前缀, 强制 mcode 按 Plan: 格式输出
  //   这是 mcode 0.1.5 唯一可行的进 plan mode 路径
  //   (goal 模式: 之前是按钮, mcode 0.1.5 不支持, 删了按钮. 用 /goal slash command 代替)
  hideMode()
  if (mode === 'plan') {
    state.planMode = !state.planMode
    showToast(state.planMode ? t('plan_mode_on') : t('plan_mode_off'), 2500)
    return
  }
  // 权限 mode (ask/auto/full/read) — mcode 0.1.5 acp 不支持 mid-session 改 permissionMode
  //   server 仅更新 webui UI, mcode 实际 mode 不变 (启动时已固定)
  try {
    const r = await fetch('/api/permissions' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ mode })
    })
    const j = await r.json().catch(() => ({}))
    if (state.planMode) state.planMode = false
    if (j && j.ok === true) {
        showToast(t('perm_mode_note'), 4500)
    }
  } catch (e) { console.error(e) }
}

// ============================================================
// v0.5.aq: 旧 settings menu / modal 已全部废弃，chip-lan 自带开关
// ============================================================
export const settingsMenu = null  // 旧元素已删除，置 null 防止任何残留引用报错
export function toggleSettings() {}  // 旧 API no-op
export function hideSettings() {}

// ============================================================
// v0.5.z: 套餐用量（btn-menu 按钮 + 右侧 popover，mmx quota + 本机时间自算）
// - % 从 mmx API 拿
// - 重置时间纯前端算：5h 窗口边界 (0/5/10/15/20) + 周日半夜周刷新
// - 只展示 general（不显示 video）
// - 时间格式 "X天 Y小时 Z分 后重置"（去掉"钟"避免"分分钟"重复）
// ============================================================


export const fileInput = document.getElementById('file-input')
export const attachmentList = document.getElementById('attachment-list')

export async function uploadFiles(files) {
  for (const file of files) {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/upload' + API_SUFFIX, { method: 'POST', body: fd, headers: HEADERS })
      if (!r.ok) { alert(`Upload failed: ${r.status}`); continue }
      const data = await r.json()
      if (data.ok) {
        attachedFiles.push(data.path)
        renderAttachments()
      }
    } catch (e) { console.error('upload', e); alert(`Upload error: ${e.message}`) }
  }
}

export function renderAttachments() {
  if (attachedFiles.length === 0) {
    attachmentList.innerHTML = ''
    return
  }
  attachmentList.innerHTML = attachedFiles.map((p, i) => {
    const name = p.split(/[\\\/]/).pop()
    return `<div class="attachment-chip">
      <span>📎 ${escapeHtml(name)}</span>
      <span class="remove" data-idx="${i}">×</span>
    </div>`
  }).join('')
}

export function removeAttachment(idx) {
  attachedFiles.splice(idx, 1)
  renderAttachments()
}

// ============================================================
// Send command
// ============================================================
export async function send() {
  const textarea = document.getElementById('input-textarea')
  const text = textarea.value.trim()
  if (!text && attachedFiles.length === 0) return
  if (isSending) return
  isSending = true
  const btn = document.getElementById('btn-send')
  btn.disabled = true
  try {
    // v0.5.ax: welcome 态（无 session）发消息时先创建 session，用当前 workspace
    if (!state?.sessionId) {
      const ws = state?.workspace?.dir || undefined
      const cr = await fetch('/api/sessions' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ workspace: ws })
      })
      const cd = await cr.json()
      if (!cd.ok) { alert('创建会话失败: ' + (cd.error || '未知错误')); return }
      // 等 SSE 推 state（含新 sessionId + mcodeSessionId）
      await new Promise(r => setTimeout(r, 300))
    }
    // v0.4.2: 用 mavis comm send 真正发消息到 mcode session（替代 M11 stdin 注入）
    // 附件先注入 @file 前缀（如果 mcode 端能处理）
    let content = text
    if (attachedFiles.length > 0) {
      const atPaths = attachedFiles.map(p => `@${p}`).join(' ')
      content = `${atPaths} ${content}`.trim()
    }
    // v0.5.bx-9: Plan 模式 — mcode 0.1.4 LLM 不能自己进 plan mode, webui workaround
    //   选 plan 后给 prompt 加 plan 模板前缀, 强制 mcode 按 Plan: 标题 / ## Summary / Plan complete. 格式输出
    //   webui parseChatLines 解析 + 渲染 plan 块 + 弹 plan 弹窗 (老渲染本来就 OK)
    if (state?.planMode && !state?.pendingAskUser) {
      const planTpl = `[Plan 模式 — 请按以下 markdown 格式输出]\n` +
        `Plan: <一句话标题>\n\n` +
        `## Summary\n<2-3 句总览>\n\n` +
        `## 目标\n- <目标 1>\n- <目标 2>\n- <...>\n\n` +
        `## 非目标\n- <非目标 1>\n- <...>\n\n` +
        `## 实施步骤\n1. <步骤 1>\n2. <步骤 2>\n3. <...>\n\n` +
        `Plan complete.\n` +
        `What would you like to do?\n` +
        `1. Agree and start implementation\n` +
        `2. Skip for now\n` +
        `3. Revise with feedback\n\n` +
        `---\n` +
        `用户问题: ${content}\n` +
        `---\n` +
        `(重要: 必须严格按上面 Plan 格式输出, 不要加额外解释. webui 会自动解析你的输出并显示 plan 弹窗让用户选.)`
      content = planTpl
      // v0.5.bx-9: 用了就关掉 plan mode (一次性, 不持续)
      //   user 想再来一次再点 plan chip
      state.planMode = false
      if (typeof renderRight === 'function') renderRight()
    }
    // v0.5.bx-31: 删掉 send() 里基于 pendingAskUser 的 Q/A 模板化兜底
    //   之前: 任何有 pendingAskUser 时, 用户在 chat 框发消息会被自动套成 "Q: <q>\nA: <text>"
    //   现在: chat 输入框发消息永远走正常通路, 不被套
    //   Q/A 模板化只在弹窗 submit (submitAskModal) 时走 — 用户必须明确点 × 提交 / 跳过 / 选项 / 其他+回车
    //   这样历史 ask_user 块 (不是最新回复) 也不会触发模板化, 避免"进入对话前 N 条都被套"的 bug
    //   pendingAskUser 字段已不在 render 时被设, 这里也不再读 (防御性保留 closeAskModal 清)
    const r = await fetch('/api/send' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ content, command: 'prompt' })
    })
    if (!r.ok) { alert(`Send failed: ${r.status}`); return }
    const data = await r.json()
    if (!data.ok) { alert(`Send error: ${data.error || 'unknown'}`); return }
    // 清空
    textarea.value = ''
    attachedFiles = []
    renderAttachments()
    autoResize()
  } catch (e) { console.error('send', e); alert(`Send error: ${e.message}`) }
  finally { isSending = false; btn.disabled = false }
}

// v0.5.aa: 停止按钮 — POST /api/stop，server kill 子进程
export async function stopExec() {
  const btn = document.getElementById('btn-send')
  if (btn) btn.disabled = true
  try {
    const r = await fetch('/api/stop' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({})
    })
    const data = await r.json()
    if (!data.ok) console.warn('stop failed', data)
    // 状态由 server pushState 推送回来（state.running.active 变 false，render 切回 send）
  } catch (e) {
    console.error('stop', e)
  } finally {
    if (btn) btn.disabled = false
  }
}

export function autoResize() {
  const ta = document.getElementById('input-textarea')
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.min(200, ta.scrollHeight) + 'px'
}

export function attachEvents() {
  // Input textarea
  const textarea = document.getElementById('input-textarea')
  textarea.addEventListener('input', () => {
    autoResize()
    // Slash command detection
    const v = textarea.value
    // v0.5.bx-21: 含空格的输入不再开 slash overlay — 允许 "/goal 帮我" 这种 命令+参数 格式
    //   之前 v.startsWith('/') 永远 true, 导致 "/goal 帮我" 还显示 "No matching commands" 干扰 user
    //   修后: 只有 / 开头且无空格才开 slash (完整命令后空格 = 命令已选, 进入自然语言补充)
    if (v === '/' || (v.startsWith('/') && !v.includes(' '))) {
      slashQuery = v.slice(1)
      if (!slashOpen) showSlash()
      else filterSlash()
    } else if (slashOpen) {
      hideSlash()
    }
  })
  textarea.addEventListener('keydown', (e) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); selectSlash() }
      else if (e.key === 'Escape') { e.preventDefault(); hideSlash() }
    } else {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    }
  })
  textarea.addEventListener('paste', async (e) => {
    // Paste any file from clipboard (image, video, document)
    // 终端页面只能 ctrl+v 粘贴，所以这里要处理所有附件
    if (e.clipboardData?.files?.length > 0) {
      const files = Array.from(e.clipboardData.files)
      if (files.length > 0) {
        e.preventDefault()
        await uploadFiles(files)
      }
    }
  })

  // Send button
  // v0.5.aa: send 按钮根据 is-running 切 send / stop
  document.getElementById('btn-send').addEventListener('click', () => {
    if (state?.running?.active) stopExec()
    else send()
  })

  // Refresh sessions button
  document.getElementById('btn-refresh-sessions')?.addEventListener('click', refreshSessions)

  // Quota card refresh button (手动刷新 → 弹 toast)
  document.getElementById('usage-popover-refresh')?.addEventListener('click', () => refreshUsage({ manual: true }))

  // Search sessions input — 实时过滤 sidebar 列表
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    sessionSearchQuery = e.target.value || ''
    renderSessions()
  })

  // Attach
  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length > 0) {
      uploadFiles(e.target.files)
      e.target.value = ''
    }
  })
  attachmentList.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove')) {
      removeAttachment(parseInt(e.target.getAttribute('data-idx'), 10))
    }
  })

  // Mode
  document.getElementById('btn-mode').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMode()
  })
  modePopover.addEventListener('click', (e) => {
    const item = e.target.closest('.mode-popover-item')
    if (item) setMode(item.getAttribute('data-mode'))
  })

  // Settings
  // v0.4.0: btn-settings 已移除（外观/语言/局域网在主栏已暴露）
  // document.getElementById('btn-settings').addEventListener('click', (e) => {
  //   e.stopPropagation()
  //   toggleSettings()
  // })

  // Appearance / Language buttons
  document.getElementById('btn-appearance').addEventListener('click', () => { toggleTheme() })
  document.getElementById('btn-language').addEventListener('click', () => { toggleLang() })

  // Usage button → toggle popover
  document.getElementById('btn-usage').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleUsagePopover()
  })

  // v0.5.ak: 模型切换 — btn-model click 弹 model-picker popover
  // v0.5.bh: 拉 /api/models 显示可选列表，点一个直接切（用户反馈：不想手输）
  const modelPicker = document.getElementById('model-picker')
  const modelPickerInput = document.getElementById('model-picker-input')
  const modelPickerList = document.getElementById('model-picker-list')
  async function loadModelList() {
    if (!modelPickerList) return
    modelPickerList.innerHTML = '<div class="model-picker-loading">' + t('model_picker_loading') + '</div>'
    try {
      const r = await fetch('/api/models' + API_SUFFIX, { headers: HEADERS })
      const d = await r.json()
      if (!d.ok || !Array.isArray(d.models) || d.models.length === 0) {
        // v0.5.bj: TUI 没配 model — 显示 server hint（提示用户手输）
        const hint = d.hint || t('model_picker_empty')
        modelPickerList.innerHTML = '<div class="model-picker-empty">' + hint + '</div>'
        return
      }
      const currentName = (d.current || '').toLowerCase()
      modelPickerList.innerHTML = d.models.map(m => {
        const isCurrent = (m.id || '').toLowerCase() === currentName
        return '<button class="model-picker-item-btn' + (isCurrent ? ' current' : '') + '" data-model-id="' + (m.id || '').replace(/"/g, '&quot;') + '">' +
               '<span>' + (m.label || m.id) + '</span>' +
               '<span class="provider">' + (m.provider || '') + '</span>' +
               '</button>'
      }).join('')
      // 绑定 click — 直接调 /api/set-model（v0.5.bk: 不再发 /model 命令，避免 mcode 报 invalid params + 新开对话）
      modelPickerList.querySelectorAll('.model-picker-item-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-model-id') || ''
          modelPickerInput.value = id
          modelPickerInput.dataset.fullName = id
          modelPicker.hidden = true
          try {
            await fetch('/api/set-model' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ model: id }),
            })
            // 服务端 pushStateFor 自动更新 state，render() 会被 SSE 推过来触发
            // 但保险起见主动 fetch 一次
            const r = await fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
            if (r.ok) { state = await r.json(); render() }
            showToast && showToast(t('model_switched') + ' ' + id, 1500)
          } catch (e) { console.error('[set-model]', e) }
        })
      })
    } catch (e) {
      console.error('[models] load failed', e)
      modelPickerList.innerHTML = '<div class="model-picker-empty">' + t('model_picker_empty') + '</div>'
    }
  }
  document.getElementById('btn-model').addEventListener('click', (e) => {
    e.stopPropagation()
    const wasHidden = modelPicker.hidden
    // 关掉其他 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker').forEach(el => { if (el !== modelPicker) el.hidden = true })
    modelPicker.hidden = !wasHidden
    if (!modelPicker.hidden) {
      // 预填当前 model（只显示短名，去掉 provider/ 前缀）
      const fullName = (state && state.model && state.model.name) || ''
      const shortName = fullName.includes('/') ? fullName.split('/').pop() : fullName
      modelPickerInput.value = shortName
      modelPickerInput.dataset.fullName = fullName  // 保留完整路径作 fallback
      // v0.5.bh: 拉可选模型列表
      loadModelList()
      setTimeout(() => modelPickerInput.focus(), 0)
    }
  })
  document.getElementById('model-picker-cancel').addEventListener('click', (e) => {
    e.stopPropagation()
    modelPicker.hidden = true
  })
  modelPickerInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const v = modelPickerInput.value.trim()
      if (!v) return
      modelPicker.hidden = true
      // 直接调 /api/send 发 "/model <v>" 给 mcode acp
      try {
        await fetch('/api/send' + API_SUFFIX, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...HEADERS },
          body: JSON.stringify({ content: '/model ' + v }),
        })
      } catch (e) { console.error(e) }
    } else if (e.key === 'Escape') {
      modelPicker.hidden = true
    }
  })
  // 点击 popover 外关掉
  document.addEventListener('click', (e) => {
    if (modelPicker && !modelPicker.hidden && !modelPicker.contains(e.target) && e.target.id !== 'btn-model') {
      modelPicker.hidden = true
    }
  })

  // v0.5.al: workspace 切换 — chip-workspace click 弹 popover
  const wsPicker = document.getElementById('workspace-picker')
  const wsInput = document.getElementById('workspace-picker-input')
  const wsCurrent = document.getElementById('workspace-picker-current')
  const wsChip = document.getElementById('chip-workspace')
  const wsRecentsEl = document.getElementById('workspace-picker-recents')
  const wsRecentsList = document.getElementById('workspace-picker-recents-list')
  const wsSyncCheckbox = document.getElementById('workspace-picker-sync')

  // localStorage 工具：保存/读取 recents
  const WS_RECENTS_KEY = 'webui_workspace_recents_v1'
  const WS_LAST_KEY = 'webui_workspace_last_v1'
  function loadWsRecents() {
    try { return JSON.parse(localStorage.getItem(WS_RECENTS_KEY) || '[]') } catch { return [] }
  }
  function saveWsRecents(arr) {
    try { localStorage.setItem(WS_RECENTS_KEY, JSON.stringify(arr.slice(0, 5))) } catch {}
  }
  function pushWsRecent(dir) {
    if (!dir) return
    const cur = loadWsRecents().filter(d => d !== dir)
    cur.unshift(dir)
    saveWsRecents(cur)
  }
  function renderWsRecents() {
    const recents = loadWsRecents()
    if (recents.length === 0) {
      wsRecentsEl.hidden = true
      return
    }
    wsRecentsEl.hidden = false
    wsRecentsList.innerHTML = ''
    for (const dir of recents) {
      const btn = document.createElement('div')
      btn.className = 'workspace-picker-recent'
      btn.textContent = dir
      btn.title = dir
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        wsInput.value = dir
        submitWorkspaceChange({ dir })
      })
      wsRecentsList.appendChild(btn)
    }
  }

  function positionWsPicker() {
    // v0.5.bg: 用户反馈"显示不全" — 改成屏幕居中显示（fixed + 50% translate），不再跟 chip
    if (!wsPicker) return
    // 居中定位（fixed + transform）
    wsPicker.style.top = '50%'
    wsPicker.style.left = '50%'
    wsPicker.style.transform = 'translate(-50%, -50%)'
  }

  async function submitWorkspaceChange(payload) {
    try {
      const r = await fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (data.ok) {
        if (payload && payload.dir) {
          pushWsRecent(data.workspace.dir)
          try { localStorage.setItem(WS_LAST_KEY, data.workspace.dir) } catch {}
        }
        wsPicker.hidden = true
        // server 会 push state，render() 自动更新 chip + 输入区
        // 立即本地 fallback（不等 SSE）
        if (state) {
          state.workspace = data.workspace
          render()
        }
      } else {
        alert('切换失败: ' + (data.error || '未知错误'))
      }
    } catch (e) {
      console.error('[ws] submit failed', e)
      alert('切换失败: ' + e.message)
    }
  }

  wsChip?.addEventListener('click', (e) => {
    e.stopPropagation()
    openWsPicker()
  })

  // v0.5.ax: 欢迎页的工作区 chip 也触发同样的 popover
  const emptyWsBtn = document.getElementById('chat-empty-workspace')
  if (emptyWsBtn) {
    emptyWsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // v0.5.ax: 仅在 welcome 态（无消息）允许改工作区
      const hasMessages = (state?.chat?.length || 0) > 0
      if (hasMessages) {
        showToast(t('workspace_locked_in_chat'))
        return
      }
      openWsPicker()
    })
  }

  function openWsPicker() {
    const wasHidden = wsPicker.hidden
    // 关掉其他 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker').forEach(el => { if (el !== wsPicker) el.hidden = true })
    wsPicker.hidden = !wasHidden
    if (!wsPicker.hidden) {
      // 显示当前工作区全路径
      const cur = (state && state.workspace && state.workspace.dir) || ''
      wsCurrent.textContent = cur || t('workspace_unset')
      wsInput.value = cur
      renderWsRecents()
      // 探测 TUI cwd，让 "跟随 TUI" 按钮显示真实路径（tooltip）
      fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ action: 'detect' }),
      }).then(r => r.json()).then(data => {
        if (data && data.tuiCwd) {
          const tuiBtn = document.getElementById('workspace-picker-tui')
          if (tuiBtn) tuiBtn.title = 'mcode TUI 当前在: ' + data.tuiCwd
        }
      }).catch(() => {})
      setTimeout(() => {
        positionWsPicker()
        wsInput.focus()
        wsInput.select()
      }, 0)
    }
  }

  // 输入框回车 = 切换
  wsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const dir = wsInput.value.trim()
      if (!dir) return
      submitWorkspaceChange({ dir, syncTui: wsSyncCheckbox.checked })
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      wsPicker.hidden = true
    }
  })

  // v0.5.by: 3 按钮 (workspace-picker-confirm/tui/reset) HTML 已删 — Enter 键提交已覆盖
  //   (见上方 wsInput.addEventListener('keydown') Enter 分支)

  // v0.5.am: 可视化目录树浏览（懒加载）
  const browseToggle = document.getElementById('workspace-picker-browse-toggle')
  const browsePanel = document.getElementById('workspace-picker-browse-panel')
  const browseChevron = document.getElementById('workspace-picker-browse-chevron')
  const breadcrumb = document.getElementById('workspace-picker-breadcrumb')
  const treeEl = document.getElementById('workspace-picker-tree')
  const treeLoading = document.getElementById('workspace-picker-tree-loading')
  // 内存缓存：path -> {ok, children, roots}  避免重复请求
  const browseCache = new Map()
  // 当前浏览的目录
  let browseCurrent = null  // absolute path or null (= roots)
  let browseOpen = false

  function fetchBrowse(path) {
    const key = path || '__roots__'
    if (browseCache.has(key)) return Promise.resolve(browseCache.get(key))
    const url = '/api/workspace/browse' + API_SUFFIX + (path ? '&path=' + encodeURIComponent(path) : '')
    return fetch(url, { headers: HEADERS })
      .then(r => r.json())
      .then(data => { browseCache.set(key, data); return data })
  }

  function renderBreadcrumb(dir) {
    breadcrumb.innerHTML = ''
    if (!dir) {
      // 根盘符视图
      const span = document.createElement('span')
      span.className = 'workspace-picker-breadcrumb-item'
      span.textContent = '盘符'
      span.title = '根盘符'
      breadcrumb.appendChild(span)
      return
    }
    // 拆路径：["C:", "Users", "<user>", ...]
    const sep = dir.includes('\\') ? '\\' : '/'
    const isWin = dir.match(/^[A-Z]:/i)
    const parts = dir.split(/[\\\/]/).filter(Boolean)
    let acc = ''
    if (isWin) {
      acc = parts.shift() + sep  // "C:\"
    } else {
      acc = sep  // "/"
    }
    const firstCrumb = document.createElement('span')
    firstCrumb.className = 'workspace-picker-breadcrumb-item'
    firstCrumb.textContent = acc
    firstCrumb.title = isWin ? '回到根盘符' : '/'
    // 关键修复：firstCrumb 始终跳回根盘符视图（Windows = loadBrowse(null)，Linux = loadBrowse('/')）
    firstCrumb.addEventListener('click', (e) => {
      e.stopPropagation()
      loadBrowse(isWin ? null : '/')
    })
    breadcrumb.appendChild(firstCrumb)
    // 关键修复：第一个 part 之前不加 sep1（firstCrumb 已经以 sep 结尾，否则会出现 "C:\\" 双反斜杠）
    let isFirst = true
    for (const p of parts) {
      if (!isFirst) {
        const sep1 = document.createElement('span')
        sep1.className = 'workspace-picker-breadcrumb-sep'
        sep1.textContent = sep
        breadcrumb.appendChild(sep1)
      }
      isFirst = false
      acc = joinPath(acc, p, sep)
      const item = document.createElement('span')
      item.className = 'workspace-picker-breadcrumb-item'
      item.textContent = p
      item.title = acc
      item.addEventListener('click', (e) => { e.stopPropagation(); loadBrowse(acc) })
      breadcrumb.appendChild(item)
    }
  }
  function joinPath(base, part, sep) {
    if (base.endsWith(sep)) return base + part
    return base + sep + part
  }

  function renderTreeNodes(parent, children, currentDir) {
    parent.innerHTML = ''
    if (!children || children.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'workspace-picker-tree-empty'
      empty.textContent = '（无子目录）'
      parent.appendChild(empty)
      return
    }
    for (const c of children) {
      const node = document.createElement('div')
      node.className = 'workspace-tree-node'
      if (c.path === currentDir) node.classList.add('current')
      const chev = document.createElement('span')
      chev.className = 'workspace-tree-chevron'
      chev.textContent = '▶'
      const name = document.createElement('span')
      name.className = 'workspace-tree-name'
      name.textContent = c.name
      name.title = c.path
      const setBtn = document.createElement('button')
      setBtn.className = 'workspace-tree-set-btn'
      setBtn.textContent = '选'
      setBtn.title = '切换到此目录'
      const childrenBox = document.createElement('div')
      childrenBox.className = 'workspace-tree-children'
      childrenBox.hidden = true

      // 展开 / 收起
      chev.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (childrenBox.hidden) {
          // 展开
          if (!childrenBox.dataset.loaded) {
            chev.classList.add('loading')
            chev.textContent = '…'
            const data = await fetchBrowse(c.path)
            chev.classList.remove('loading')
            chev.textContent = '▶'
            if (data.ok) {
              childrenBox.innerHTML = ''
              // 递归：子节点也用同样渲染（但要传入 currentDir 包含关系判断）
              renderTreeNodes(childrenBox, data.children, currentDir)
              childrenBox.dataset.loaded = '1'
            } else {
              const err = document.createElement('div')
              err.className = 'workspace-picker-tree-error'
              err.textContent = '加载失败: ' + (data.error || '未知')
              childrenBox.innerHTML = ''
              childrenBox.appendChild(err)
            }
          }
          childrenBox.hidden = false
          chev.classList.add('open')
        } else {
          childrenBox.hidden = true
          chev.classList.remove('open')
        }
      })
      // 点击 name = 进入该目录（重渲染树为该目录的子目录）
      name.addEventListener('click', (e) => {
        e.stopPropagation()
        loadBrowse(c.path)
      })
      // 选 = 切换工作区
      setBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        submitWorkspaceChange({ dir: c.path, syncTui: wsSyncCheckbox.checked })
      })

      node.appendChild(chev)
      node.appendChild(name)
      node.appendChild(setBtn)
      parent.appendChild(node)
      parent.appendChild(childrenBox)
    }
  }

  async function loadBrowse(path) {
    browseCurrent = path
    renderBreadcrumb(path)
    treeEl.innerHTML = '<div class="workspace-picker-tree-loading">加载中…</div>'
    const data = await fetchBrowse(path)
    if (!data.ok) {
      treeEl.innerHTML = `<div class="workspace-picker-tree-error">加载失败: ${data.error || '未知'}</div>`
      return
    }
    treeEl.innerHTML = ''
    if (data.roots) {
      // 根盘符视图
      const cur = (state && state.workspace && state.workspace.dir) || ''
      renderTreeNodes(treeEl, data.roots.map(r => ({ name: r, path: r })), cur)
    } else {
      const cur = (state && state.workspace && state.workspace.dir) || ''
      renderTreeNodes(treeEl, data.children, cur)
    }
  }

  browseToggle.addEventListener('click', async (e) => {
    e.stopPropagation()
    browseOpen = !browseOpen
    browsePanel.hidden = !browseOpen
    browseToggle.classList.toggle('open', browseOpen)
    if (browseOpen) {
      // 初始：从当前工作区（或根盘符）开始
      const cur = (state && state.workspace && state.workspace.dir) || null
      await loadBrowse(cur)
    }
  })

  // 点击 popover 外关掉
  document.addEventListener('click', (e) => {
    if (wsPicker && !wsPicker.hidden && !wsPicker.contains(e.target) && e.target.id !== 'chip-workspace' && !(wsChip && wsChip.contains(e.target))) {
      wsPicker.hidden = true
    }
  })
  // 窗口 resize / scroll 重新定位
  window.addEventListener('resize', () => { if (!wsPicker.hidden) positionWsPicker() })

  // v0.5.bh: 监听网络状态变化，实时更新顶栏在线指示
  window.addEventListener('online',  () => { try { render() } catch (e) {} })
  window.addEventListener('offline', () => { try { render() } catch (e) {} })

  // v0.5.al: 启动时恢复 localStorage 保存的工作区
  try {
    const last = localStorage.getItem(WS_LAST_KEY)
    if (last) {
      // 等首屏 render 完再切（state 已有 workspace 时不覆盖）—— 但 server 端默认 workspace 跟 saved 不同才切
      fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ action: 'detect' }),
      }).then(r => r.json()).then(data => {
        if (data && data.current !== last) {
          // server 默认跟 saved 不一样 → 恢复
          return fetch('/api/workspace' + API_SUFFIX, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...HEADERS },
            body: JSON.stringify({ dir: last, syncTui: false }),
          })
        }
      }).catch(() => {})
    }
  } catch {}

  // v0.5.aq: chip-lan toggle — 点 chip 切换 LAN 访问（访问 URL 在顶栏 chip，点击复制）
  const chipLan = document.getElementById('chip-lan')
  // v0.5.bp: 顶栏 LAN 访问链接 chip（LAN on 时显示当前 IP，点复制完整 URL）
  const chipLanLink = document.getElementById('chip-lan-link')
  const chipLanLinkText = document.getElementById('chip-lan-link-text')

  async function loadLanInfo() {
    try {
      const r = await fetch('/api/settings' + API_SUFFIX, { headers: HEADERS })
      const d = await r.json()
      if (!d.ok) return
      // v0.5.bp: 顶栏链接 chip 始终更新 URL（data-lan-url 留着点复制时用），可见性由 render() 决定
      if (chipLanLink) {
        chipLanLink.setAttribute('data-lan-url', d.lanUrl || '')
        if (chipLanLinkText) {
          // 只显示 host:port（去掉 http:// 前缀，紧凑）
          const u = (d.lanUrl || '').replace(/^https?:\/\//, '')
          chipLanLinkText.textContent = u || '—'
        }
      } else {
        console.warn('[lan] chipLanLink NOT found in DOM — element missing?')
      }
    } catch (e) { console.error('[lan] load failed', e) }
  }
  loadLanInfo()  // 启动时拉一次（hover 时再刷新一次也 OK）

  // v0.5.bp: 顶栏 LAN 链接点击 = 复制完整 URL 到剪贴板（data-lan-url 由 loadLanInfo 填入，URL 来自 server 的 detectLanIp()，非硬编码）
  if (chipLanLink) {
    chipLanLink.addEventListener('click', async (e) => {
      e.preventDefault()
      const url = chipLanLink.getAttribute('data-lan-url') || ''
      if (!url) return
      try {
        await navigator.clipboard.writeText(url)
        showToast(t('copy_success') + ': ' + url, 1500)
      } catch (err) {
        showToast(t('copy_failed') + ': ' + err.message, 2000)
      }
    })
  }

  // 点击 chip = 切换 LAN 访问 on/off
  if (chipLan) {
    chipLan.addEventListener('click', async (e) => {
    e.stopPropagation()
    const wasOn = chipLan.getAttribute('data-lan') === 'on'
    const enabled = !wasOn
    try {
      const r = await fetch('/api/settings' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ lanBroadcast: enabled }),
      })
      const d = await r.json()
      if (!d.ok) { alert('切换失败: ' + (d.error || '未知错误')); return }
      if (state) state.lanBroadcast = enabled
      render()
      showToast(enabled ? t('lan_title_on') : t('lan_title_off'))
    } catch (e) {
      console.error('[lan] toggle failed', e)
      alert('切换失败: ' + e.message)
    }
  })
  }

  // v0.5.bx-40: LAN URL hover popover 已删除 — 顶栏 chip-lan-link 已展示访问地址（点击复制），
  //   且旧 popover 定位在 LAN 卡片正下方，会盖住 GitHub 链接

  // New chat
  // v0.5.ar: 新建会话 → 弹工作区选择 popover（选完工作区再调 /api/sessions）
  const newChatPicker = document.getElementById('new-chat-ws-picker')
  const newChatCurrent = document.getElementById('new-chat-current-ws')
  const newChatList = document.getElementById('new-chat-ws-list')
  const newChatCancel = document.getElementById('new-chat-ws-cancel')
  const newChatOther = document.getElementById('new-chat-ws-other')
  function positionNewChatPicker() {
    const btn = document.getElementById('btn-new-chat')
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    newChatPicker.style.top = (rect.bottom + 6) + 'px'
    newChatPicker.style.left = rect.left + 'px'
  }
  function openNewChatPicker() {
    // 收集所有已知 workspace（当前 + 所有 session 所属 workspace，去重）
    const currentWs = (state && state.workspace && state.workspace.dir) || ''
    const wsSet = new Set()
    if (currentWs) wsSet.add(currentWs)
    ;(state && state.sessions || []).forEach(s => { if (s.workspace) wsSet.add(s.workspace) })
    const wsList = [...wsSet]
    newChatCurrent.textContent = currentWs || '—'
    // 渲染列表（按当前工作区在顶 + 字母序）
    wsList.sort((a, b) => {
      if (a === currentWs) return -1
      if (b === currentWs) return 1
      return a.localeCompare(b)
    })
    newChatList.innerHTML = wsList.map(ws => {
      const count = (state.sessions || []).filter(s => s.workspace === ws).length
      const isCurrent = ws === currentWs
      const folderSvg = '<svg class="icon ws-picker-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      return `<button class="ws-picker-item${isCurrent ? ' current' : ''}" data-ws="${escapeHtml(ws)}">
        ${folderSvg}
        <span class="ws-picker-item-text" title="${escapeHtml(ws)}">${escapeHtml(ws)}</span>
        <span class="ws-picker-item-count">${count}</span>
      </button>`
    }).join('')
    newChatList.querySelectorAll('.ws-picker-item').forEach(it => {
      it.addEventListener('click', async (e) => {
        e.stopPropagation()
        const ws = it.getAttribute('data-ws')
        newChatPicker.hidden = true
        await createNewSession(ws)
      })
    })
    positionNewChatPicker()
    newChatPicker.hidden = false
  }
  newChatCancel.addEventListener('click', () => { newChatPicker.hidden = true })
  newChatOther.addEventListener('click', async () => {
    // 走现有的 workspace-picker 流程：调 /api/workspace set 后再创建
    const dir = prompt('输入工作区路径（例如 D:\\\\projects\\\\myapp）')
    if (!dir || !dir.trim()) return
    newChatPicker.hidden = true
    try {
      const r = await fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ dir: dir.trim(), syncTui: true }),
      })
      const d = await r.json()
      if (!d.ok) { alert('切换工作区失败: ' + (d.error || '未知错误')); return }
    } catch (e) { alert('切换工作区失败: ' + e.message); return }
    await createNewSession(dir.trim())
  })
  // 点击 popover 外关闭
  document.addEventListener('click', (e) => {
    if (newChatPicker.hidden) return
    if (!newChatPicker.contains(e.target) && e.target.id !== 'btn-new-chat' && !e.target.closest('#btn-new-chat')) {
      newChatPicker.hidden = true
    }
  })

  async function createNewSession(workspace) {
    // v0.5.ak: mcode 还在跑时禁止清空 chat
    if (state && state.running && state.running.active) {
      alert('AI 还在回复中，请先等回复完成或点 ⏹ 停止。\n\n如果要开启新话题，先停止当前任务。')
      return
    }
    try {
      const r = await fetch('/api/sessions' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ workspace: workspace || undefined })
      })
      const d = await r.json()
      if (!d.ok) { alert('创建会话失败: ' + (d.error || '未知错误')); return }
      // 触发 SSE 拉取 state（server 端会推）
      if (typeof loadState === 'function') loadState()
    } catch (e) { console.error(e) }
  }

  document.getElementById('btn-new-chat').addEventListener('click', (e) => {
    e.stopPropagation()
    if (state && state.running && state.running.active) {
      alert('AI 还在回复中，请先等回复完成或点 ⏹ 停止。\n\n如果要开启新话题，先停止当前任务。')
      return
    }
    // v0.5.ax: "新建会话" = 切回 welcome 状态（清空当前 sessionId + chat 数组）
    // 真正的 session 创建推迟到用户发第一条消息时（带当前 workspace）
    clearCurrentSession()
  })

  // v0.5.bx-33: 删 "清理孤儿" 按钮 (用户反馈不要这个功能) — 按钮 + handler + API 一起删
  //   之前: index.html btn-cleanup-orphans + main.js click handler + router.js 路由 + handleCleanupOrphans
  //   现在: 全部清掉,代码干净,用户改主意找 git history

  // v0.5.ax: 清空当前 session，回到 welcome 页（不创建新 session，等用户发消息时再创建）
  function clearCurrentSession() {
    if (state) {
      state.sessionId = null
      state.mcodeSessionId = null
      state.sessionTitle = 'Untitled'
      state.chat = []
      state.goal = { active: false, text: null, status: null, duration: null }
      state.todo = []
      // 不改 state.workspace — 保留当前工作区（welcome 页显示短名）
    }
    // 关掉所有 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker, .new-chat-picker').forEach(el => { el.hidden = true })
    newChatPicker.hidden = true
    render()
  }

  // Mobile toggles
  // v0.5.bx-37: 强制刷新按钮 — 手机/平板浏览器 hard refresh 麻烦, 一键绕过 HTTP cache
  //   行为: fetch 关键资源 (main.js/main.css/index.html) 用 cache:'reload' 覆盖 HTTP cache
  //   之后再 location.reload() 加载新版本
  document.getElementById('chip-force-reload').addEventListener('click', async () => {
    const btn = document.getElementById('chip-force-reload')
    if (btn) { btn.disabled = true; btn.classList.add('loading') }
    try {
      await Promise.allSettled([
        fetch('/app/main.js', { cache: 'reload' }),
        fetch('/styles/main.css', { cache: 'reload' }),
        fetch('/', { cache: 'reload' }),
      ])
    } catch {}
    location.reload()
  })
  document.getElementById('btn-toggle-left').addEventListener('click', () => {
    setLeftOpen(!leftOpen)
    document.getElementById('left-panel').classList.toggle('open', leftOpen)
    document.getElementById('drawer-backdrop').classList.toggle('show', leftOpen || rightOpen)
  })
  document.getElementById('btn-toggle-right').addEventListener('click', () => {
    setRightOpen(!rightOpen)
    document.getElementById('right-panel').classList.toggle('open', rightOpen)
    document.getElementById('drawer-backdrop').classList.toggle('show', leftOpen || rightOpen)
  })
  document.getElementById('drawer-backdrop').addEventListener('click', () => {
    setLeftOpen(false); setRightOpen(false)
    document.getElementById('left-panel').classList.remove('open')
    document.getElementById('right-panel').classList.remove('open')
    document.getElementById('drawer-backdrop').classList.remove('show')
  })

  // Chat hints
  document.querySelectorAll('.chat-hint').forEach(h => {
    h.addEventListener('click', () => {
      const cmd = h.getAttribute('data-cmd')
      fetch('/api/cmd' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ cmd })
      })
    })
  })

  // Drop zone
  const chatArea = document.getElementById('chat-area')
  const dropOverlay = document.getElementById('dropzone-overlay')
  ;['dragenter', 'dragover'].forEach(ev => {
    chatArea.addEventListener(ev, (e) => {
      e.preventDefault()
      dropOverlay.classList.add('show')
    })
  })
  ;['dragleave', 'drop'].forEach(ev => {
    chatArea.addEventListener(ev, (e) => {
      e.preventDefault()
      if (ev === 'dragleave' && e.relatedTarget) return
      dropOverlay.classList.remove('show')
    })
  })
  chatArea.addEventListener('drop', async (e) => {
    e.preventDefault()
    if (e.dataTransfer?.files?.length > 0) {
      await uploadFiles(e.dataTransfer.files)
    }
  })

  // Slash overlay click
  slashResults.addEventListener('click', (e) => {
    const item = e.target.closest('.slash-item')
    if (item?.getAttribute('data-cmd')) {
      const cmd = item.getAttribute('data-cmd')
      slashQuery = cmd
      selectSlash()
    }
  })
  // v0.5.bx-21: 鼠标 hover slash item 切 active idx (跟键盘 ArrowUp/Down 一致)
  //   之前只有 click → 直接 selectSlash, 没切换高亮. Wzdhehe 反馈 "鼠标点别的, 只会选中help"
  //   修: mouseenter 切 slashActiveIdx + 重新渲染 active class
  //   注意: 不绑 mouseleave, 否则用户键盘移到 /new 后鼠标移走又跳回 /help
  slashResults.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.slash-item')
    if (!item || !item.getAttribute('data-cmd')) return
    const idx = parseInt(item.getAttribute('data-idx') || '-1', 10)
    if (idx < 0 || idx === slashActiveIdx) return
    slashActiveIdx = idx
    slashResults.querySelectorAll('.slash-item').forEach((el, i) => {
      el.classList.toggle('active', i === slashActiveIdx)
    })
  })
  slashInput.addEventListener('input', (e) => {
    slashQuery = e.target.value
    filterSlash()
  })
  slashInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); selectSlash() }
    else if (e.key === 'Escape') { e.preventDefault(); hideSlash(); textarea.focus() }
    else if (e.key === 'Tab') { e.preventDefault(); selectSlash() }
  })

  // Document click to close popovers
  document.addEventListener('click', (e) => {
    if (modeOpen && !modePopover.contains(e.target) && e.target.id !== 'btn-mode' && !document.getElementById('btn-mode').contains(e.target)) {
      hideMode()
    }
    // v0.5.z: 点 popover 外面就关（btn-usage click 用 stopPropagation 自己处理开关）
    const up = document.getElementById('usage-popover')
    const ub = document.getElementById('btn-usage')
    if (up && !up.hidden && ub && !up.contains(e.target) && !ub.contains(e.target)) {
      toggleUsagePopover(false)
    }
    // v0.5.aq: settings modal 已删，不再需要这层 backdrop 检查
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Modal shortcuts 优先
    // v0.5.bx-14: 旧 askOpen keydown 块已删, ask_user 弹窗自己有 keydown 监听 (bindAskModal)
    if (planOpen) {
      if (e.key >= '1' && e.key <= '3') {
        e.preventDefault()
        const actions = ['agree', 'skip', 'add']
        const action = actions[parseInt(e.key, 10) - 1]
        if (action === 'add') {
          const ta = document.getElementById('plan-add-context')
          ta.hidden = !ta.hidden
          if (!ta.hidden) ta.focus()
        }
        sendPlanAnswer(action)
        return
      } else if (e.key === 'Enter') {
        e.preventDefault()
        sendPlanAnswer('agree')
        return
      }
    }
    if (planModeOpen) {
      if (e.key === '1' || e.key === 'Enter') { e.preventDefault(); sendPlanModeAnswer('continue'); return }
      else if (e.key === '2' || e.key === 'Escape') { e.preventDefault(); sendPlanModeAnswer('deny'); return }
    }
    if (permOpen) {
      const map = { '1': 'ask', '2': 'auto', '3': 'full' }
      if (map[e.key]) { e.preventDefault(); sendPermAnswer(map[e.key]); return }
    }
    // Esc 关所有浮层
    if (e.key === 'Escape') {
      if (slashOpen) hideSlash()
      else if (modeOpen) hideMode()
      else { const up2 = document.getElementById('usage-popover'); if (up2 && !up2.hidden) toggleUsagePopover(false) }
    }
    // Ctrl+K / Cmd+K 聚焦输入
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      textarea.focus()
    }
  })
}

export function moveSlash(delta) {
  if (slashFiltered.length === 0) return
  slashActiveIdx = (slashActiveIdx + delta + slashFiltered.length) % slashFiltered.length
  slashResults.querySelectorAll('.slash-item').forEach((el, i) => {
    el.classList.toggle('active', i === slashActiveIdx)
    if (i === slashActiveIdx) el.scrollIntoView({ block: 'nearest' })
  })
}

export function selectSlash() {
  if (slashFiltered.length === 0) return
  const cmd = slashFiltered[slashActiveIdx].cmd
  const textarea = document.getElementById('input-textarea')
  textarea.value = cmd
  textarea.focus()
  hideSlash()
}

export function toggleLang() {
  setLang(currentLang === 'zh' ? 'en' : 'zh')
  localStorage.setItem('webui-lang', currentLang)
  applyI18n()
  render()
}

// ============================================================
// v0.5.bx-14: 旧 Ask Modal (v0.4.0) 已删除 — showAsk/hideAsk/renderAsk/sendAskAnswer
//   旧代码用 /api/answer endpoint (server 没实现, 一直 404)
//   新 ask_user 弹窗用 v0.5.bx-13 的 #ask-modal + /api/send (isAskAnswer:true)
// ============================================================

// ============================================================
// Plan Review Modal (v0.4.0)
// ============================================================
export function showPlan() {
  if (!state?.plan?.active) return
  planOpen = true
  document.getElementById('plan-modal').classList.add('show')
  renderPlan()
}
export function hidePlan() {
  planOpen = false
  document.getElementById('plan-modal').classList.remove('show')
}
export function renderPlan() {
  const p = state?.plan
  if (!p || !p.active) { hidePlan(); return }
  document.getElementById('plan-title').textContent = p.title || 'Plan'
  const summaryEl = document.getElementById('plan-summary')
  if (p.summary) {
    summaryEl.textContent = p.summary
    summaryEl.classList.remove('plan-summary-empty')
  } else {
    summaryEl.innerHTML = '<div class="plan-summary-empty">没有 Summary</div>'
  }
  document.getElementById('plan-frozen').textContent = p.totalLines > 0
    ? `Frozen · Lines 1-${Math.min(p.totalLines, 9999)} of ${p.totalLines}`
    : 'Frozen Runtime snapshot'
  const optsEl = document.getElementById('plan-options')
  const labels = (p.options && p.options.length > 0)
    ? p.options.map(o => o.label)
    : ['Agree and start implementation', 'Skip for now', 'Add context to revise']
  optsEl.innerHTML = labels.map((label, i) => {
    const primary = i === 0 ? ' primary' : ''
    return `<button class="plan-option${primary}" data-action="${['agree', 'skip', 'add'][i] || 'agree'}">
      <span class="plan-option-num">${i + 1}</span>
      <span class="plan-option-label">${escapeHtml(label)}</span>
    </button>`
  }).join('')
  optsEl.querySelectorAll('.plan-option').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.getAttribute('data-action')
      if (action === 'add') {
        const ta = document.getElementById('plan-add-context')
        ta.hidden = !ta.hidden
        if (!ta.hidden) ta.focus()
      }
      sendPlanAnswer(action)
    })
  })
}
export async function sendPlanAnswer(action) {
  if (planSending) return
  planSending = true
  try {
    const ta = document.getElementById('plan-add-context')
    const extra = (action === 'add' && ta?.value) ? `\n${ta.value}` : ''
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'plan', option: action })
    })
    hidePlan()
  } catch (e) {
    console.error('plan answer', e)
  } finally {
    planSending = false
  }
}

// ============================================================
// EnterPlanMode Modal (v0.4.0)
// ============================================================
export function showPlanMode() {
  if (!state?.enterPlanMode?.active) return
  planModeOpen = true
  document.getElementById('planmode-modal').classList.add('show')
}
export function hidePlanMode() {
  planModeOpen = false
  document.getElementById('planmode-modal').classList.remove('show')
}
export async function sendPlanModeAnswer(choice) {
  try {
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'planmode', option: choice })
    })
    hidePlanMode()
  } catch (e) { console.error('planmode answer', e) }
}

// ============================================================
// Permission Modal (v0.4.0)
// ============================================================
export function showPerm() {
  if (!state?.permissionChoice?.active) return
  permOpen = true
  document.getElementById('perm-modal').classList.add('show')
  renderPerm()
}
export function hidePerm() {
  permOpen = false
  document.getElementById('perm-modal').classList.remove('show')
}
export function renderPerm() {
  const p = state?.permissionChoice
  if (!p || !p.active) { hidePerm(); return }
  document.getElementById('perm-current').textContent = `Current · ${p.current || '—'}`
}
export async function sendPermAnswer(choice) {
  try {
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'permission', option: choice })
    })
    hidePerm()
  } catch (e) { console.error('perm answer', e) }
}

// ============================================================
// 弹窗触发（render 时自动检测）
// ============================================================
export function checkModals() {
  // v0.5.bx-14: 旧 Ask 分支已删 (旧 modal 删了, 用 v0.5.bx-13 的 #ask-modal 替代, 由 openAskModal 触发)
  // Plan
  const p = state?.plan
  if (p?.active) {
    const key = `p-${p.title}-${p.summaryLines}-${p.totalLines}`
    if (key !== lastShownPlanKey) { lastShownPlanKey = key; showPlan() }
  } else {
    lastShownPlanKey = null
    if (planOpen) hidePlan()
  }
  // EnterPlanMode
  const pm = state?.enterPlanMode
  if (pm?.active) {
    if (lastShownPlanModeKey !== 'on') { lastShownPlanModeKey = 'on'; showPlanMode() }
  } else {
    lastShownPlanModeKey = null
    if (planModeOpen) hidePlanMode()
  }
  // Permission
  const pe = state?.permissionChoice
  if (pe?.active) {
    const key = `pe-${pe.current}-${pe.options?.length || 0}`
    if (key !== lastShownPermKey) { lastShownPermKey = key; showPerm() }
  } else {
    lastShownPermKey = null
    if (permOpen) hidePerm()
  }
}

// ============================================================
// Modal 事件绑定
// ============================================================
export function attachModalEvents() {
  // v0.5.bx-27: 所有 getElementById 加 null check — 老 modal 元素 (ask-close/plan-modal 等) v0.5.bx-14 已删,
  //   但 attachModalEvents 还在引用 → null.addEventListener 报 TypeError → 整个 init 失败 → 页面没 JS
  //   现在每个都检查, 元素不存在就跳过 — 单个缺失不影响整体
  const $ = (id) => document.getElementById(id)
  const on = (id, evt, fn) => { const e = $(id); if (e) e.addEventListener(evt, fn) }

  // Ask (v0.5.bx-14: 旧 ask-close 元素已删, ask-modal 是新元素)
  on('ask-close', 'click', () => {
    fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'ask', option: 'esc' })
    }).catch(() => {})
    closeAskModal()
  })
  on('ask-modal', 'click', (e) => {
    if (e.target.id === 'ask-modal') closeAskModal()
  })
  // Plan
  on('plan-close', 'click', () => {
    fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'plan', option: 'skip' })
    }).catch(() => {})
    hidePlan()
  })
  on('plan-modal', 'click', (e) => {
    if (e.target.id === 'plan-modal') hidePlan()
  })
  // PlanMode
  on('planmode-close', 'click', () => sendPlanModeAnswer('deny'))
  on('planmode-modal', 'click', (e) => {
    if (e.target.id === 'planmode-modal') sendPlanModeAnswer('deny')
  })
  document.querySelectorAll('#planmode-options .choice-option').forEach(el => {
    el.addEventListener('click', () => sendPlanModeAnswer(el.getAttribute('data-choice')))
  })
  // Permission
  on('perm-close', 'click', () => hidePerm())
  on('perm-modal', 'click', (e) => {
    if (e.target.id === 'perm-modal') hidePerm()
  })
  document.querySelectorAll('#perm-options .choice-option').forEach(el => {
    el.addEventListener('click', () => sendPermAnswer(el.getAttribute('data-choice')))
  })
  // Esc 关弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (planOpen) { hidePlan() }
      else if (planModeOpen) { hidePlanMode() }
      else if (permOpen) { hidePerm() }
    }
  })
  // v0.5.bx-15 (改): 双击 logo 重置 ask_user 弹窗
  const topbarLogo = $('topbar-logo')
  if (topbarLogo) {
    topbarLogo.addEventListener('dblclick', () => {
      const hadKeys = ASK_MODAL_STATE.presentedKeys.size > 0
      ASK_MODAL_STATE.presentedKeys.clear()
      if (typeof showToast === 'function') {
        showToast(hadKeys ? t('ask_reopened') : t('ask_no_reset'))
      }
    })
  }
}

