// 域:Hook。
// Hook 主张最密集,也最依赖随包源码 —— 注册格式、诊断码、上限、变量白名单
// 全都没有用户可见的命令行入口,只能回到源码取证。
/** 事件全集。与 reference/plugins.md「事件全集」代码块逐项对应。 */
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'PostCompact',
]

export const claims = [
  {
    id: 'hook.events',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'Hook 事件为 SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / SubagentStart / SubagentStop / Stop / PreCompact / PostCompact',
    checks: [
      ...EVENTS.map((e) => ({
        kind: 'doc',
        text: e,
        label: `文档含 ${e}`,
      })),
      { kind: 'source', file: '.js', pattern: 'SessionStart', label: '源码含 SessionStart' },
      { kind: 'source', file: '.js', pattern: 'SubagentStop', label: '源码含 SubagentStop' },
      { kind: 'source', file: '.js', pattern: 'PostCompact', label: '源码含 PostCompact' },
    ],
  },
  {
    id: 'hook.sessionstart-sources',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'SessionStart 来源取 startup / resume / clear / compact / fork / plugin_activation',
    checks: [
      { kind: 'doc', text: 'plugin_activation', label: '文档含 plugin_activation' },
      { kind: 'source', file: '.js', pattern: 'plugin_activation', label: '源码含 plugin_activation' },
    ],
  },
  {
    id: 'hook.sources-formats',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'Hook 来源格式支持 MINIMAX / CLAUDE / CODEX 三种',
    checks: [
      { kind: 'doc', text: 'MINIMAX', label: '文档含 MINIMAX' },
      { kind: 'doc', text: 'CLAUDE', label: '文档含 CLAUDE' },
      { kind: 'doc', text: 'CODEX', label: '文档含 CODEX' },
    ],
  },
  {
    id: 'hook.diagnostic-codes',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'Hook 诊断码含 HOOK_HANDLER_UNSUPPORTED / HOOK_SCHEMA_INVALID / HOOK_HANDLER_LIMIT_EXCEEDED',
    checks: [
      { kind: 'doc', text: 'HOOK_HANDLER_UNSUPPORTED', label: '文档含 UNSUPPORTED' },
      { kind: 'doc', text: 'HOOK_SCHEMA_INVALID', label: '文档含 SCHEMA_INVALID' },
      { kind: 'doc', text: 'HOOK_HANDLER_LIMIT_EXCEEDED', label: '文档含 LIMIT_EXCEEDED' },
      { kind: 'source', file: '.js', pattern: 'HOOK_HANDLER_UNSUPPORTED', label: '源码含 UNSUPPORTED' },
      { kind: 'source', file: '.js', pattern: 'HOOK_SCHEMA_INVALID', label: '源码含 SCHEMA_INVALID' },
      { kind: 'source', file: '.js', pattern: 'HOOK_HANDLER_LIMIT_EXCEEDED', label: '源码含 LIMIT_EXCEEDED' },
    ],
  },
  {
    id: 'hook.sync-only',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: '只支持同步 command 处理器,写 async 会被判 HOOK_HANDLER_UNSUPPORTED',
    checks: [
      { kind: 'doc', text: 'HOOK_HANDLER_UNSUPPORTED', label: '文档给出判罚码' },
      { kind: 'source', file: '.js', pattern: 'HOOK_HANDLER_UNSUPPORTED', label: '源码实现该判罚' },
    ],
  },
  {
    id: 'hook.timeout-bounds',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'timeout 为整数秒,取值 1–10,缺省 5000 ms,上限 10000 ms',
    checks: [
      { kind: 'doc', text: '5000', label: '文档含缺省 5000ms' },
      { kind: 'doc', text: '10000', label: '文档含上限 10000ms' },
    ],
  },
  {
    id: 'hook.envelope-forms',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: "manifest 的 hooks 字段接受五种形式(字符串/对象/数组/内联对象/省略)",
    checks: [
      { kind: 'doc', text: 'sourcePath', label: '文档提到内联形式的 sourcePath' },
      { kind: 'doc', text: 'hooks/notify.json', label: '文档给出引用示例' },
    ],
  },
  {
    id: 'hook.env-whitelist',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'Hook 进程继承白名单仅 17 个环境变量,宿主另行注入 PLUGIN_ROOT / PLUGIN_DATA 等',
    checks: [
      { kind: 'doc', text: 'PLUGIN_DATA', label: '文档含 PLUGIN_DATA' },
      { kind: 'source', file: '.js', pattern: 'PLUGIN_DATA', label: '源码注入 PLUGIN_DATA' },
      { kind: 'source', file: '.js', pattern: 'MINIMAX_PLUGIN_ROOT', label: '源码注入 MINIMAX_PLUGIN_ROOT' },
      { kind: 'source', file: '.js', pattern: 'MINIMAX_PROJECT_DIR', label: '源码注入 MINIMAX_PROJECT_DIR' },
    ],
  },
  {
    id: 'hook.claude-only-fields',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: 'args / shell / if 仅 CLAUDE 格式生效,additionalContextLimit 仅 CODEX 生效',
    checks: [
      { kind: 'doc', text: 'additionalContextLimit', label: '文档含 CODEX 专有字段' },
      { kind: 'doc', text: 'commandWindows', label: '文档含 win32 专有字段' },
      { kind: 'source', file: '.js', pattern: 'additionalContextLimit', label: '源码含该字段' },
      { kind: 'source', file: '.js', pattern: 'commandWindows', label: '源码含该字段' },
    ],
  },
  {
    id: 'hook.handler-limit',
    domain: 'hooks',
    doc: 'skills/mcode-docs/reference/plugins.md',
    claim: '单个插件可执行处理器至多 64 个,超出记 HOOK_HANDLER_LIMIT_EXCEEDED',
    checks: [
      { kind: 'doc', text: 'HOOK_HANDLER_LIMIT_EXCEEDED', label: '文档给出上限判罚' },
      { kind: 'source', file: '.js', pattern: 'HOOK_HANDLER_LIMIT_EXCEEDED', label: '源码实现该上限' },
    ],
  },
  {
    id: 'hook.permission-fields',
    domain: 'hooks',
    doc: 'site/index.html',
    claim: 'Hook 决策字段含 behavior / destination / mode / permissionDecision / permissionAutoApproval / interrupt / toolPermissionDecision',
    checks: [
      { kind: 'doc', text: 'permissionAutoApproval', label: '文档含 permissionAutoApproval' },
      { kind: 'doc', text: 'ordinary_only', label: '文档含 ordinary_only 取值' },
      { kind: 'source', file: '.js', pattern: 'permissionAutoApproval', label: '源码含该字段' },
    ],
  },
]
