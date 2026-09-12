// webui/public/app/util.js
// Extracted from main.js (REFACTORING.md batch 4, step 1).
// Pure helpers: markdown/html formatting + usage-window date math.
// No app-state dependencies.

export function parseMarkdown(text) {
  if (!text) return ''
  if (window.marked) {
    try {
      const html = marked.parse(text)
      // 链接外链化 + 中文化 title
      return html.replace(/<a\s+href="([^"]+)"/g, (m, href) =>
        `<a href="${href}" target="_blank" rel="noopener"`)
    } catch (e) {
      console.error('marked error', e)
      return `<pre>${escapeHtml(text)}</pre>`
    }
  }
  return `<pre>${escapeHtml(text)}</pre>`  // 库没加载时的降级
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function formatNumber(n) {
  if (n == null) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

// 5h 窗口边界（最后一个是 4h 20→24）
export const FIVE_HOUR_BOUNDARIES = [5, 10, 15, 20, 24]

export function nextFiveHourReset(now = new Date()) {
  // 返回下一次 5h 窗口的本地时间
  const h = now.getHours()
  const m = now.getMinutes()
  const s = now.getSeconds()
  for (const b of FIVE_HOUR_BOUNDARIES) {
    if (h < b) {
      const t = new Date(now)
      t.setHours(b, 0, 0, 0)
      return t
    }
  }
  // h >= 20 但 < 24：b=24 (今日午夜)
  // 实际上 h<24 时已经会被 b=20 截掉当 h<20
  // 如果 h>=24 不可能 (setHours clamp)，兜底：
  const t = new Date(now)
  t.setDate(t.getDate() + 1)
  t.setHours(5, 0, 0, 0)
  return t
}

export function nextWeeklyReset(now = new Date()) {
  // 周日半夜 (周日 00:00) 刷新周限额
  // 如果现在还没到本周周日 00:00：days = (7 - day) % 7, 0 = 今天就是周日
  // 如果今天是周日且已过 00:00 (0:00 ~ 现在)，下一次是下周日
  const t = new Date(now)
  t.setHours(0, 0, 0, 0)
  const day = now.getDay()  // 0=周日
  let daysUntil = (7 - day) % 7
  if (daysUntil === 0) {
    // 今天就是周日，看是否已过 00:00
    if (now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() === 0) {
      return t  // 正好 0 点
    }
    // 已过 0 点，下一次是下周日
    daysUntil = 7
  }
  t.setDate(t.getDate() + daysUntil)
  return t
}

export function formatTimeUntil(target, now = new Date()) {
  // 输出 "X天 Y小时 Z分 后重置"，去掉"钟"避免"分 分钟"重复
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return '现在'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0 || parts.length === 0) parts.push(`${m}分`)
  return `${parts.join(' ')} 后重置`
}

export function formatResetTime(target) {
  // 显示绝对时间 "15:00" 或 "周日 00:00"（比"X小时Y分"更直观）
  const h = target.getHours()
  const m = target.getMinutes()
  const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  // 检查是否本周日（day === 0）
  const today = new Date()
  if (target.getDay() === 0) return `周日 ${hm}`
  return hm
}

// ---- batch 4 step 2 additions (from main.js) ----

// ============================================================
// Debug log (in-page) — v0.5.bx-NN
// 默认收起 (hidden), 首次报错自动弹出; 用户可关闭; 关闭后只显小红点提示
// ============================================================
export const __DBG = (() => {
  const buf = []
  const MAX = 30
  const panel = () => document.getElementById('debug-log-panel')
  const pre = () => document.getElementById('debug-log')
  const titleEl = () => document.getElementById('debug-log-title')

  const flush = () => {
    const el = pre()
    if (el) el.textContent = buf.map(e => `[${e.t}] ${e.msg}`).join('\n')
  }
  const hasError = () => buf.some(e => /^❌/.test(e.msg))
  const updateBadge = () => {
    const p = panel()
    if (!p) return
    // 报错时: 自动展开面板 (除非用户主动收起过)
    if (hasError() && !p.dataset.userClosed) {
      p.hidden = false
    }
    if (titleEl()) {
      const errCount = buf.filter(e => /^❌/.test(e.msg)).length
      titleEl().textContent = errCount > 0
        ? `📋 webui log (${errCount} ❌ + ${buf.length - errCount} info)`
        : `📋 webui log (${buf.length} lines)`
    }
  }
  const log = (msg) => {
    const t = new Date().toTimeString().slice(0, 8)
    buf.push({ t, msg: String(msg) })
    if (buf.length > MAX) buf.shift()
    flush()
    updateBadge()
    try { console.log('[webui]', msg) } catch {}
  }
  return { log, buf, flush, hasError, updateBadge, panel }
})()
window.__DBG = __DBG
window.addEventListener('error', (e) => {
  __DBG.log('❌ERR: ' + (e.error?.message || e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?'))
})
window.addEventListener('unhandledrejection', (e) => {
  __DBG.log('❌REJ: ' + (e.reason?.message || e.reason?.toString() || e.reason))
})
document.addEventListener('DOMContentLoaded', () => {
  // copy: 全部 buffer → clipboard
  document.getElementById('debug-log-copy')?.addEventListener('click', () => {
    const txt = __DBG.buf.map(e => `[${e.t}] ${e.msg}`).join('\n')
    navigator.clipboard?.writeText(txt).then(() => __DBG.log('✓ copied ' + __DBG.buf.length + ' lines'))
  })
  // clear: 清空 buffer (不隐藏面板, 让用户看到空状态)
  document.getElementById('debug-log-clear')?.addEventListener('click', () => {
    __DBG.buf.length = 0
    __DBG.flush()
    __DBG.updateBadge()
  })
  // close: 隐藏面板 + 标记 user-closed, 不再自动展开
  document.getElementById('debug-log-close')?.addEventListener('click', () => {
    const p = document.getElementById('debug-log-panel')
    if (p) { p.hidden = true; p.dataset.userClosed = '1' }
  })
  // 调试入口: 在 console 输 __DBG.show() 可手动展开
  __DBG.show = () => { const p = __DBG.panel(); if (p) { p.hidden = false; delete p.dataset.userClosed } }
  // URL 里有 ?debug=1 时强制显示 (开发用)
  try {
    if (new URLSearchParams(window.location.search).get('debug') === '1') {
      __DBG.show()
    }
  } catch {}
})

// 权限模式图标（按当前 permissions 状态切换）
// shield=完全访问 / help=询问 / check=自动 / eye=只读
export const MODE_ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
}

export function showToast(msg, duration = 2200) {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), duration)
}
