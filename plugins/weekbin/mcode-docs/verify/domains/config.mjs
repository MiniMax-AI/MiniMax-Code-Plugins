// 域:配置。
// 这里的主张多是「某个键存在 / 某条路径成立」,源码 grep 就够 ——
// 真去解析用户的 config.yaml 既越界又会把凭据带进证据,所以不做。
export const claims = [
  {
    id: 'config.data-dir-env',
    domain: 'config',
    doc: 'skills/mcode-docs/reference/config.md',
    claim: '数据目录为用户主目录下的 .minimax,可用 MINIMAX_DATA_DIR 改写',
    checks: [
      { kind: 'doc', text: 'MINIMAX_DATA_DIR', label: '文档含该环境变量' },
      { kind: 'source', file: '.js', pattern: 'MINIMAX_DATA_DIR', label: '源码含该环境变量' },
    ],
  },
  {
    id: 'config.top-level-keys',
    domain: 'config',
    doc: 'skills/mcode-docs/reference/config.md',
    claim: '已验证的顶层键含 defaultModelContextWindow / defaultModelThinking / statusLine',
    checks: [
      { kind: 'source', file: '.js', pattern: 'defaultModelContextWindow', label: 'defaultModelContextWindow' },
      { kind: 'source', file: '.js', pattern: 'defaultModelThinking', label: 'defaultModelThinking' },
      { kind: 'source', file: '.js', pattern: 'customStatusLine', label: 'customStatusLine' },
    ],
  },
  {
    id: 'config.custom-command-required',
    domain: 'config',
    doc: 'skills/mcode-docs/reference/config.md',
    claim: 'custom-command 状态栏项只有 command 是必填',
    checks: [
      { kind: 'doc', text: 'customStatusLine', label: '文档含 customStatusLine' },
      { kind: 'source', file: '.js', pattern: 'custom-command', label: '源码含 custom-command 项名' },
    ],
  },
  {
    id: 'config.statusline-items',
    domain: 'config',
    doc: 'site/index.html',
    claim: '状态栏合法项含 cache-read-ratio / context-remaining / context-meter / custom-command',
    checks: [
      { kind: 'doc', text: 'cache-read-ratio', label: '文档含 cache-read-ratio' },
      { kind: 'doc', text: 'context-remaining', label: '文档含 context-remaining' },
      { kind: 'source', file: '.js', pattern: 'cache-read-ratio', label: '源码含 cache-read-ratio' },
      { kind: 'source', file: '.js', pattern: 'context-remaining', label: '源码含 context-remaining' },
    ],
  },
  {
    id: 'config.effort-values',
    domain: 'config',
    doc: 'site/index.html',
    claim: 'CLAUDE_EFFORT 取 low / medium / high / xhigh / max',
    checks: [
      { kind: 'doc', text: 'CLAUDE_EFFORT', label: '文档含该变量' },
      { kind: 'source', file: '.js', pattern: 'CLAUDE_EFFORT', label: '源码含该变量' },
      { kind: 'source', file: '.js', pattern: 'xhigh', label: '源码含 xhigh 取值' },
    ],
  },
]
