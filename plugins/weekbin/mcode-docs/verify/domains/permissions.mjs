// 域:权限。
// 核心主张是「三套命名空间,不要混用」—— 这是最容易在文档改写时被抹平的一条,
// 所以每套命名空间都同时钉住文档表述与实现。
export const claims = [
  {
    id: 'perm.mode-values',
    domain: 'permissions',
    doc: 'skills/mcode-docs/reference/permissions.md',
    claim: 'PermissionMode 五个取值 default / acceptEdits / bypassPermissions / auto / off',
    checks: [
      { kind: 'doc', text: 'acceptEdits', label: '文档含 acceptEdits' },
      { kind: 'doc', text: 'bypassPermissions', label: '文档含 bypassPermissions' },
      { kind: 'source', file: '.js', pattern: 'bypassPermissions', label: '源码含 bypassPermissions' },
      { kind: 'source', file: '.js', pattern: 'acceptEdits', label: '源码含 acceptEdits' },
    ],
  },
  {
    id: 'perm.three-namespaces',
    domain: 'permissions',
    doc: 'skills/mcode-docs/reference/permissions.md',
    claim: 'TUI 用 ask/auto/full,config.yaml 用 default/…/off,exec --permission 用 smart/full/off',
    checks: [
      { kind: 'doc', text: 'smart', label: '文档含 exec 命名空间' },
      { kind: 'doc', text: 'bypassPermissions', label: '文档含 config 命名空间' },
      {
        kind: 'exec',
        cmd: 'mcode',
        args: ['exec', '--help'],
        expect: /smart, full, or off/,
        label: 'exec 命名空间与文档一致',
      },
    ],
  },
  {
    id: 'perm.tui-slash-commands',
    domain: 'permissions',
    doc: 'site/index.html',
    claim: '单次决策入口为 /allow / always / deny / decision / permissions',
    checks: [
      { kind: 'doc', text: '/always', label: '文档含 /always' },
      { kind: 'doc', text: '/decision', label: '文档含 /decision' },
      { kind: 'doc', text: '/permissions', label: '文档含 /permissions' },
    ],
  },
  {
    id: 'perm.always-is-action-class',
    domain: 'permissions',
    doc: 'skills/mcode-docs/reference/permissions.md',
    claim: '/always 授予的是操作类别级别的永久允许,范围大于单次工具',
    checks: [{ kind: 'doc', text: '/always', label: '文档陈述该语义' }],
  },
  {
    id: 'perm.plan-mode',
    domain: 'permissions',
    doc: 'skills/mcode-docs/reference/permissions.md',
    claim: '/plan 取 on / off / status / view',
    checks: [
      { kind: 'doc', text: '/plan', label: '文档含 /plan' },
      { kind: 'doc', text: 'Keep my draft', label: '文档含恢复流程文案' },
    ],
  },
]
