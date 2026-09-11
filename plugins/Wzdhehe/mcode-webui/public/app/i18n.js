// webui/public/app/i18n.js
// Extracted from main.js (REFACTORING.md batch 4, step 1).
// Owns: I18N dictionaries, currentLang, t()/applyI18n(), theme state.
// i18n <-> theme are mutually dependent (applyI18n reads theme,
// applyTheme calls t()) so they live in the same module.
// External writers of currentLang must use setLang() — ESM live
// bindings are read-only from the importer side.

// ============================================================
// i18n
// ============================================================
const I18N = {
  zh: {
    title: 'Mcode Web UI',
    new_chat: '新建会话',
    search_placeholder: '搜索会话...',
    workspace: '工作区',
    recent: '最近会话',
    no_sessions: '暂无会话记录',
    model_picker_title: '切换模型',
    model_picker_loading: '加载中...',
    model_picker_empty: '没有可用模型',
    model_picker_hint: '回车发送 /model 命令给 mcode',
    cancel: '取消',
    usage: '套餐用量',
    usage_loading: '点击套餐用量加载...',
    quota_card_title: '套餐用量 (Token Plan)',
    quota_card_enabled: '显示套餐用量',
    quota_card_enabled_help: '关闭后,套餐用量按钮在主界面消失',
    quota_card_key: 'Subscription Key',
    quota_card_key_help: '从 platform.minimaxi.com/user-center/token-plan 获取,明文存到 settings.json',
    save: '保存',
    clear: '清空',
    quota_no_data_hint: '套餐用量暂未启用。点击下方按钮到「外观」面板配置。',
    quota_go_settings: '去外观面板设置',
    quota_disabled: '未启用',
    quota_saved: '已保存',
    quota_need_key: '请填 Subscription Key',
    quota_clear_confirm: '确定清空 Subscription Key?清空后套餐用量数据不显示。',
    quota_cleared: '已清空',
    quota_status_configured: '已配置',
    quota_status_not_configured: '未配置',
    // v2026-08-28 modacker (A+C): external key source labels — shown
    //   after the masked key in the popover + modal status line so
    //   the user can tell where the active key is coming from.
    //   "env" is short and matches the env var name; "file" pairs
    //   with the resolved file path in the modal status line.
    quota_source_env: 'env',
    quota_source_file: 'file',
    quota_delete_disabled_external: '当前 key 由外部源管理(env / file),无法在界面删除',
    quota_input_placeholder_env: 'env 优先,此处的值在 env 取消前不会被使用',
    quota_input_placeholder_file: 'file 优先,此处的值在文件移除前不会被使用',
    quota_modal_title: '配置 Subscription Key',
    delete_key: '删除',
    upgrade: '升级',
    appearance: '外观',
    language: '语言',
    settings: '设置',
    appearance_light: '明亮',
    appearance_dark: '深色',
    appearance_theme: '主题',
    appearance_theme_help: '切换亮色/深色主题',
    appearance_quota_help: '关掉后,套餐用量按钮在主界面消失',
    language_zh: '简体中文',
    language_en: 'English',
    empty_hint_1: '还没有消息 — 在下方输入开始对话',
    empty_hint_2: '按 / 触发命令检索，Ctrl+V 粘贴图片',
    welcome_tagline: '还没有消息 — 在下方输入开始对话',
    hint_help: '查看命令',
    hint_status: '查看状态',
    hint_sessions: '会话列表',
    hint_usage: '套餐用量',
    input_placeholder: '输入消息... (/ 命令 · @ 文件 · Ctrl+V 粘贴图片)',
    hint_footer: '/ 命令 · @ 文件 · Ctrl+V 粘贴图片 · Enter 发送',
    section_session: '会话',
    section_model: '模型',
    section_workspace: '工作区',
    section_context: '上下文',
    section_goal: '目标',
    section_todo: '待办',
    section_plan: '计划',
    section_thinking: '思考',
    show_thinking: '查看思考',
    lines: '行',
    ask_title: '提问',
    plan_review: '计划预览',
    plan_view_btn: '查看完整计划',
    r_title: '标题', r_dir: '目录', r_branch: '分支', r_tree: '状态',
    r_used: '已用', r_percent: '占比', r_tps: '速度', r_cache: '缓存',
    status_idle: '空闲',
    status_offline: '离线',
    status_thinking: '思考中',
    status_running: '运行中',
    status_completed: '完成',
    tps_label: 'tok/s',
    goal_active: '进行中',
    goal_complete: '完成',
    goal_paused: '暂停',
    todo_done: '已完成',
    todo_pending: '待办',
    user_loading: 'Mcode Web',
    user_default: 'Mcode',
    mode_default: '默认',
    mode_ask: '询问', mode_ask_desc: '敏感操作确认',
    mode_auto: '自动', mode_auto_desc: '仅高风险询问',
    mode_full: '完全 访问', mode_full_desc: '无需确认',
    // v0.5.bx-9: Plan 模式 — webui 端 toggle, 给 prompt 加 plan 模板前缀, 强制 mcode 按 Plan: 格式输出
    mode_plan: 'Plan 模式', mode_plan_desc: '强制 mcode 按 Plan: 格式输出',
    drop_hint: '松开上传文件',
    toggle_theme: '切换主题',
    toggle_lang: '中 / English',
    network: '局域网访问',
    slash_no_results: '没有匹配的命令',
    slash_section_cmd: '命令',
    slash_section_skill: '技能',
    perm_full: '完全 访问',
    perm_ask: '询问',
    perm_read: '只读',
    plan_mode_continue: '继续 plan',
    plan_mode_deny: '拒绝',
    // v0.5.av: 新增 i18n 键
    lan_access: '局域网访问',
    lan_on: '开',
    lan_off: '关',
    // v0.5.bp: 顶栏 LAN 链接 chip
    lan_link_title: '点击复制局域网访问 URL',
    // v0.5.br: copy / model-switch toast 文案
    copy_success: '已复制',
    copy_failed: '复制失败',
    copy_failed_manual: '复制失败，请手动复制',
    model_switched: '已切到',
    sessions_list: '会话列表',
    refresh: '刷新',
    quota_remaining: '剩余',
    quota_5h_limit: '5 小时限额',
    quota_weekly_limit: '每周限额',
    quota_next_reset: '下次重置',
    quota_loading_fail: '加载失败',
    quota_loading_idle: '点击套餐用量加载…',
    usage_refreshed: '用量已刷新',
    lan_title_on: '局域网已开启 — 局域网内其他设备可访问',
    lan_title_off: '局域网已关闭 — 只有本电脑能访问',
    // v1.0: 之前硬编码中文且用旧三参 showToast 签名 (msg, 'info', ms) — 新签名是 (msg, ms)
    plan_mode_on: '已开 Plan 模式（下次发消息时 mcode 会按 Plan: 格式输出）',
    plan_mode_off: '已关 Plan 模式',
    perm_mode_note: '权限 mode 仅更新 webui UI，mcode 实际 mode 由启动 --permission 标志决定（0.1.5 不支持中途改）',
    ask_reopened: '✓ ask_user 弹窗已重新开启（清空 presentedKeys）',
    ask_no_reset: 'ask_user 弹窗未开启过（无需重置）',
    // v0.5.aw: 工作区/会话相关
    workspace_unset: '（未设置）',
    workspace_unset_short: '未设置',
    workspace_current: '当前',
    workspace_switch: '点击切换工作区',
    // v0.5.bx-31: sidebar 首次加载骨架屏文案
    sidebar_loading: '加载会话中…',
    workspace_picker_title: '切换工作区',
    workspace_picker_select: '选择工作区',
    workspace_picker_current: '当前：',
    session_delete: '删除此会话',
    session_delete_confirm: '删除?',
    session_delete_yes: '删',
    session_delete_cancel: '×',
    btn_send_title: '发送 (Enter)',
    btn_stop_title: '停止 (/stop)',
    workspace_unset_text: '未选择（点击选择）',
    chip_online_title: '当前连到 webui server 的 tab 数',
    chip_online_single: '1 台',
    chip_online_plural: '{n} 台',
    // v0.5.bx-37: 顶栏 BETA 标识 + 强制刷新按钮 i18n
    topbar_beta_title: 'Beta 测试版',
    force_reload: '强制刷新',
    force_reload_title: '强制刷新 (绕过浏览器缓存)',
    chip_offline: '离线',
    workspace_use_tui: '切换到 mcode TUI 当前的工作区',
    workspace_reset: '恢复 webui 启动时检测到的默认工作区',
    workspace_locked_in_chat: '对话已开始，工作区已锁定。点击左侧「新建会话」可重新选择工作区。',
    workspace_picker_hint: '点击选择工作区',
    // v0.5.bx-8: ask_user 工具 (mcode 0.1.4 ask_user) — 学 mavis 桌面端弹窗布局文案
    ask_user_other_placeholder: '其他...',
    ask_user_clear: '清空',
    ask_user_skip: '跳过',
    ask_user_send: '发送',
    ask_user_resend: '已答完 (点重发)',
    ask_user_step_count: '共 {n} 步',
    ask_user_answered: '已答: {answer}',
    ask_user_skipped: '已跳过',
    ask_user_no_options_hint: '无预设选项 — 用下方"其他"输入回答',
    ask_user_send_count: '发送 ({n} 题)',
    ask_user_resend_count: '已答完 ({n} 题, 点重发)',
    // v1.0.1: 顶栏只读模式 chip (双语)
    topbar_readonly_zh: '只读',
    topbar_readonly_en: 'READ ONLY',
    topbar_readonly_title: 'webui 当前处于只读模式 (远程客户端不能发送/删除)',
    // v1.0.1: 二级 LAN 卡片 (sub-card) — 只读/Token 鉴权/接口过滤
    lan_card_title: '局域网安全设置',
    lan_card_readonly: '只读模式',
    lan_card_readonly_help: '远程客户端只能读取，不能发送消息/删除会话',
    lan_card_token_auth: 'Token 鉴权',
    lan_card_token_auth_help: '需要 ?token= 或 Authorization header；本机不受限',
    lan_card_reset_token: '重置 token',
    lan_card_reset_token_confirm: '确定要重置 token? 旧 token 会立即失效',
    lan_card_token_value: '当前 token',
    lan_card_token_show: '显示',
    lan_card_token_hide: '隐藏',
    lan_card_token_saved: '已保存 — 查看请点"重置"',
    // v1.0.1 round 8: the server no longer returns the token over
    // HTTP. The placeholder text now points the operator to the
    // out-of-band delivery channels (server stdout + the on-disk
    // ~/.mcode-webui/settings.json file).
    lan_card_token_saved_v2: '已保存 — token 在 server stdout 或 ~/.mcode-webui/settings.json',
    // Toast shown when the server rotates the token (round 8 SSE event).
    // The new value is NOT pushed over SSE — operator must read it
    // from stdout/settings.json and re-open the URL.
    token_rotated_toast: 'Token 已轮换 — 请从 server stdout 或 ~/.mcode-webui/settings.json 读取新 token，然后重新打开 URL（含 ?token=...）',
    lan_card_token_disabled: 'Token 鉴权已关闭',
    lan_card_token_copy: '复制',
    lan_card_token_copied: '已复制到剪贴板',
    lan_card_token_new_warning: '新的 token — 请在另一台设备用上面的 URL 打开',
    lan_card_token_ack: '我已保存',
    lan_card_token_ack_help: '保存后 token 不会再次显示；下次需要查看可点"重置"',
    lan_card_token_rotated_toast: 'token 已重置，新值已自动同步',
  },
  en: {
    title: 'Mcode Web UI',
    new_chat: 'New Chat',
    search_placeholder: 'Search sessions...',
    workspace: 'Workspace',
    recent: 'Recent',
    no_sessions: 'No sessions yet',
    model_picker_title: 'Switch Model',
    model_picker_loading: 'Loading...',
    model_picker_empty: 'No models available',
    model_picker_hint: 'Press Enter to send /model command to mcode',
    cancel: 'Cancel',
    usage: 'Usage',
    usage_loading: 'Click to load usage...',
    quota_card_title: 'Quota (Token Plan)',
    quota_card_enabled: 'Show usage',
    quota_card_enabled_help: 'When off, the usage button disappears from the main UI',
    quota_card_key: 'Subscription Key',
    quota_card_key_help: 'Get from platform.minimaxi.com/user-center/token-plan. Stored in plain text in settings.json',
    save: 'Save',
    clear: 'Clear',
    quota_no_data_hint: 'Quota feature is not enabled. Click the button below to open Appearance settings.',
    quota_go_settings: 'Open Appearance settings',
    quota_disabled: 'Disabled',
    quota_saved: 'Saved',
    quota_need_key: 'Enter Subscription Key',
    quota_clear_confirm: 'Clear Subscription Key? Quota data will stop showing.',
    quota_cleared: 'Cleared',
    quota_status_configured: 'Configured',
    quota_status_not_configured: 'Not configured',
    // v2026-08-28 modacker (A+C): external key source labels
    quota_source_env: 'env',
    quota_source_file: 'file',
    quota_delete_disabled_external: 'Key is managed externally (env / file); cannot be deleted from the UI',
    quota_input_placeholder_env: 'env takes priority — this value is ignored while the env var is set',
    quota_input_placeholder_file: 'file takes priority — this value is ignored while the file is present',
    quota_modal_title: 'Configure Subscription Key',
    delete_key: 'Delete',
    upgrade: 'Upgrade',
    appearance: 'Appearance',
    language: 'Language',
    settings: 'Settings',
    appearance_light: 'Light',
    appearance_dark: 'Dark',
    appearance_theme: 'Theme',
    appearance_theme_help: 'Toggle light/dark theme',
    appearance_quota_help: 'When off, the usage button disappears from the main UI',
    language_zh: '中文',
    language_en: 'English',
    empty_hint_1: 'No messages yet — start typing below',
    empty_hint_2: 'Press / for commands, Ctrl+V to paste image',
    welcome_tagline: 'No messages yet — start typing below',
    hint_help: 'Show commands',
    hint_status: 'Show status',
    hint_sessions: 'Sessions',
    hint_usage: 'Usage',
    input_placeholder: 'Type a message... (/ commands · @ files · Ctrl+V images)',
    hint_footer: '/ commands · @ files · Ctrl+V images · Enter to send',
    section_session: 'SESSION',
    section_model: 'MODEL',
    section_workspace: 'WORKSPACE',
    section_context: 'CONTEXT',
    section_goal: 'GOAL',
    section_todo: 'TODO',
    section_plan: 'Plan',
    section_thinking: 'Thinking',
    show_thinking: 'Show thinking',
    lines: 'lines',
    ask_title: 'Ask',
    plan_review: 'Plan Review',
    plan_view_btn: 'View full plan',
    r_title: 'Title', r_dir: 'Directory', r_branch: 'Branch', r_tree: 'Status',
    r_used: 'Used', r_percent: 'Percent', r_tps: 'Speed', r_cache: 'cache',
    status_idle: 'Idle',
    status_offline: 'Offline',
    status_thinking: 'Thinking',
    status_running: 'Running',
    status_completed: 'Done',
    tps_label: 'tok/s',
    goal_active: 'Active',
    goal_complete: 'Complete',
    goal_paused: 'Paused',
    todo_done: 'Done',
    todo_pending: 'Pending',
    user_loading: 'Mcode Web',
    user_default: 'Mcode',
    mode_default: 'Default',
    mode_ask: 'Ask', mode_ask_desc: 'Confirm sensitive',
    mode_auto: 'Auto', mode_auto_desc: 'Only high-risk',
    mode_full: 'Full Access', mode_full_desc: 'No confirm',
    // v0.5.bx-9: Plan 模式
    mode_plan: 'Plan Mode', mode_plan_desc: 'Force mcode to output Plan: format',
    drop_hint: 'Drop file to upload',
    toggle_theme: 'Toggle theme',
    toggle_lang: '中 / English',
    network: 'Network access',
    slash_no_results: 'No matching commands',
    slash_section_cmd: 'Commands',
    slash_section_skill: 'Skills',
    perm_full: 'Full access',
    perm_ask: 'Ask',
    perm_read: 'Read-only',
    // v0.5.av: 新增 i18n 键
    lan_access: 'LAN Access',
    lan_on: 'On',
    lan_off: 'Off',
    // v0.5.bp: 顶栏 LAN 链接 chip
    lan_link_title: 'Click to copy LAN access URL',
    // v0.5.br: copy / model-switch toast 文案
    copy_success: 'Copied',
    copy_failed: 'Copy failed',
    copy_failed_manual: 'Copy failed, please copy manually',
    model_switched: 'Switched to',
    sessions_list: 'Sessions',
    refresh: 'Refresh',
    quota_remaining: 'left',
    quota_5h_limit: '5-Hour Limit',
    quota_weekly_limit: 'Weekly Limit',
    quota_next_reset: 'Next reset',
    quota_loading_fail: 'Load failed',
    quota_loading_idle: 'Click to load usage…',
    usage_refreshed: 'Usage refreshed',
    lan_title_on: 'LAN access on — other devices on this network can access',
    lan_title_off: 'LAN access off — only this computer can access',
    plan_mode_on: 'Plan mode on (next message will use Plan: format for mcode)',
    plan_mode_off: 'Plan mode off',
    perm_mode_note: 'Permission mode only updates the webui UI; mcode\'s actual mode comes from the --permission launch flag (no mid-session change in 0.1.5)',
    ask_reopened: '✓ ask_user modal re-enabled (presentedKeys cleared)',
    ask_no_reset: 'ask_user modal was never dismissed (nothing to reset)',
    // v0.5.aw: 工作区/会话相关
    workspace_unset: '(Unset)',
    workspace_unset_short: 'Unset',
    workspace_current: 'Current',
    workspace_switch: 'Click to switch workspace',
    // v0.5.bx-31: sidebar 首次加载骨架屏文案
    sidebar_loading: 'Loading sessions…',
    workspace_picker_title: 'Switch Workspace',
    workspace_picker_select: 'Select Workspace',
    workspace_picker_current: 'Current: ',
    session_delete: 'Delete this session',
    session_delete_confirm: 'Delete?',
    session_delete_yes: 'Delete',
    session_delete_cancel: '×',
    btn_send_title: 'Send (Enter)',
    btn_stop_title: 'Stop (/stop)',
    workspace_unset_text: 'Unset (click to select)',
    chip_online_title: 'WebUI tabs currently connected to server',
    chip_online_single: '1 dev',
    chip_online_plural: '{n} devs',
    // v0.5.bx-37: 顶栏 BETA 标识 + 强制刷新按钮 i18n
    topbar_beta_title: 'Beta version',
    force_reload: 'Force reload',
    force_reload_title: 'Force reload (bypass browser cache)',
    chip_offline: 'offline',
    workspace_use_tui: 'Use mcode TUI\'s current workspace',
    workspace_reset: 'Reset to default workspace detected at startup',
    workspace_locked_in_chat: 'Chat already started — workspace locked. Click "New Chat" in the sidebar to pick a new workspace.',
    workspace_picker_hint: 'Click to select workspace',
    // v0.5.bx-8: ask_user 工具 (mcode 0.1.4 ask_user) — 学 mavis 桌面端弹窗布局文案
    ask_user_other_placeholder: 'Other...',
    ask_user_clear: 'Clear',
    ask_user_skip: 'Skip',
    ask_user_send: 'Send',
    ask_user_resend: 'Answered (click to resend)',
    ask_user_step_count: 'of {n} steps',
    ask_user_answered: 'Answered: {answer}',
    ask_user_skipped: 'Skipped',
    ask_user_no_options_hint: 'No preset options — type in "Other" below',
    ask_user_send_count: 'Send ({n} questions)',
    ask_user_resend_count: 'Answered ({n} questions, click to resend)',
    // v1.0.1: Top-bar read-only chip (bilingual)
    topbar_readonly_zh: '只读',
    topbar_readonly_en: 'READ ONLY',
    topbar_readonly_title: 'webui is in read-only mode (remote clients cannot send or delete)',
    // v1.0.1: Secondary LAN card (sub-card) — read-only / token auth / interface filter
    lan_card_title: 'LAN Security',
    lan_card_readonly: 'Read-only mode',
    lan_card_readonly_help: 'Remote clients can only read; cannot send or delete',
    lan_card_token_auth: 'Token auth',
    lan_card_token_auth_help: 'Requires ?token= or Authorization header; loopback exempt',
    lan_card_reset_token: 'Reset token',
    lan_card_reset_token_confirm: 'Reset the token? The old token becomes invalid immediately.',
    lan_card_token_value: 'Current token',
    lan_card_token_show: 'Show',
    lan_card_token_hide: 'Hide',
    lan_card_token_saved: 'Saved — click "Reset" to view again',
    // v1.0.1 round 8 (mirror of zh-CN key above)
    lan_card_token_saved_v2: 'Saved — token lives in server stdout or ~/.mcode-webui/settings.json',
    token_rotated_toast: 'Token rotated — read the new value from server stdout or ~/.mcode-webui/settings.json, then re-open the URL with ?token=...',
    lan_card_token_disabled: 'Token auth disabled',
    lan_card_token_copy: 'Copy',
    lan_card_token_copied: 'Copied to clipboard',
    lan_card_token_new_warning: 'New token — open the URL on another device to test',
    lan_card_token_ack: 'I have saved it',
    lan_card_token_ack_help: 'After saving the token will not be shown again; reset to view again',
    lan_card_token_rotated_toast: 'Token rotated, new value auto-synced',
  }
}
// v0.5.bh: 首次加载默认英文（用户反馈），有缓存时读缓存
export let currentLang = localStorage.getItem('webui-lang') || 'en'
export function t(key) { return (I18N[currentLang] && I18N[currentLang][key]) || key }
export function applyI18n() {
  document.documentElement.setAttribute('lang', currentLang)
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n')
    el.textContent = t(key)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder')
    el.placeholder = t(key)
  })
  // v0.5.av: 支持 title / aria-label i18n
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'))
  })
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')))
  })
  document.getElementById('language-value').textContent = t(currentLang === 'zh' ? 'language_zh' : 'language_en')
  document.getElementById('appearance-value').textContent = t(theme === 'light' ? 'appearance_light' : 'appearance_dark')
}

// ============================================================
// Theme
// ============================================================
// v0.5.bh: 首次加载跟随系统（prefers-color-scheme），有缓存时用缓存
let theme = localStorage.getItem('webui-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
// v0.5.bx-34: 外观按钮 icon 跟随主题切换 (亮色=太阳,暗色=月亮)
//   之前: applyTheme 只改 data-theme 跟文字, 按钮的 SVG 永远是太阳, 暗色模式下不直观
//   修法: applyTheme 同步切 #appearance-icon 的 innerHTML (sun SVG ↔ moon SVG)
const APPEARANCE_ICON_SUN = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
const APPEARANCE_ICON_MOON = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
export function applyTheme() {
  document.documentElement.setAttribute('data-theme', theme)
  document.getElementById('appearance-value').textContent = t(theme === 'light' ? 'appearance_light' : 'appearance_dark')
  // v2026-08-28 modacker: sync the appearance-card's theme checkbox
  // (the new "外观" popover) with the current theme.
  const cardCheckbox = document.getElementById('appearance-card-theme')
  if (cardCheckbox) cardCheckbox.checked = theme === 'dark'
  const icon = document.getElementById('appearance-icon')
  if (icon) icon.innerHTML = (theme === 'light') ? APPEARANCE_ICON_SUN : APPEARANCE_ICON_MOON
}
export function toggleTheme() {
  theme = theme === 'light' ? 'dark' : 'light'
  localStorage.setItem('webui-theme', theme)
  applyTheme()
}

export function setLang(lang) { currentLang = lang }
