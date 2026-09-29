// 域:CLI。
// 主张来源是「mcode exec --help 逐条对齐,无遗漏、无自造」这类口径,
// 因此这里大量用 exec 检查 —— help 文本是唯一权威,比台账文字可靠。
const M = 'mcode'

/** 顶层命令全集。与 reference/cli.md 的「顶层命令」表同源。 */
const TOP_COMMANDS = ['init', 'exec', 'acp', 'login', 'logout', 'update', 'provider', 'plugin']

/** 全局选项全集。不含 --lane:见下方豁免。 */
const GLOBAL_FLAGS = ['--version', '--model', '--session', '--continue', '--tui-mode']

const EXEC_FLAGS = [
  '--input',
  '--input-format',
  '--cwd',
  '--file',
  '--model',
  '--effort',
  '--prompt-mode',
  '--session',
  '--continue',
  '--config',
  '--permission',
  '--timeout',
  '--max-steps',
  '--output-format',
  '--diagnostics-dir',
  '--output-schema',
  '--output-last-message',
]

const REVIEW_FLAGS = [
  '--cwd',
  '--model',
  '--effort',
  '--config',
  '--permission',
  '--timeout',
  '--max-steps',
  '--output-format',
  '--output-last-message',
]

export const claims = [
  {
    id: 'cli.top-commands',
    domain: 'cli',
    doc: 'site/index.html#h-top-commands',
    claim: '顶层命令为 init / exec / acp / login / logout / update / provider / plugin',
    checks: [
      { kind: 'doc', text: 'mcode exec review', label: '文档含 exec review 条目' },
      { kind: 'doc', text: 'mcode acp', label: '文档含 acp 条目' },
      {
        kind: 'exec',
        cmd: M,
        args: ['--help'],
        containsAll: TOP_COMMANDS,
        label: 'help 列出全部顶层命令',
      },
    ],
  },
  {
    id: 'cli.global-flags',
    domain: 'cli',
    doc: 'site/index.html#h-global-options',
    claim: '全局选项为 --version / --model / --session / --continue / --tui-mode',
    checks: [
      { kind: 'doc', text: '--tui-mode', label: '文档含 --tui-mode' },
      { kind: 'doc', text: 'fullscreen', label: '文档含 fullscreen 取值' },
      {
        kind: 'exec',
        cmd: M,
        args: ['--help'],
        flagSet: GLOBAL_FLAGS,
        // --lane 是构建管线路由开关,VERIFICATION.md §14.1 判定不是用户能力,
        // 故有意不进手册。豁免写在这里,任何人改动它都要在 review 里被看见。
        flagSetExempt: ['--lane'],
        label: 'help 选项集 == 文档选项集(双向)',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['--help'],
        expect: /--session \[id\][\s\S]*browse Sessions/,
        label: '省略 id 时打开 Session 选择面板',
      },
    ],
  },
  {
    id: 'cli.exec-flags',
    domain: 'cli',
    doc: 'site/index.html#h-exec-flags',
    claim: 'mcode exec 参数与 mcode exec --help 逐条对齐,无遗漏、无自造',
    checks: [
      { kind: 'doc', text: '--diagnostics-dir', label: '文档列出 --diagnostics-dir' },
      { kind: 'doc', text: '--output-schema', label: '文档列出 --output-schema' },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', '--help'],
        flagSet: EXEC_FLAGS,
        label: 'exec 选项集双向相等',
      },
    ],
  },
  {
    id: 'cli.exec-output-format',
    domain: 'cli',
    doc: 'site/index.html#h-exec-flags',
    claim: '--output-format 取 text / json / stream-json,非法值退出码 2',
    checks: [
      { kind: 'doc', text: 'stream-json', label: '文档列出 stream-json' },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', '--help'],
        expect: /text, json, or stream-json/,
        label: 'help 列出三个取值',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', '--output-format', 'bogus', 'hi'],
        exit: 2,
        expect: /--output-format must be one of/,
        label: '非法值被拒且退出码 2',
      },
    ],
  },
  {
    id: 'cli.exec-permission-policy',
    domain: 'cli',
    doc: 'site/index.html#h-exec-flags',
    claim: 'mcode exec --permission 取 smart(默认)/ full / off,ask 需 TUI/ACP',
    checks: [
      { kind: 'doc', text: 'smart', label: '文档含 smart' },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', '--help'],
        // help 会按终端宽度折行,所以「off (ask requires TUI/ACP)」中间可能有换行。
        // 断言的是语义连续,不是排版连续。
        expect: /permission policy: smart, full, or off\s+\(ask\s+requires TUI\/ACP\)/,
        label: 'help 说明 ask 需 TUI/ACP',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', '--permission', 'bogus', 'hi'],
        exit: 2,
        expect: /--permission must be one of/,
        label: '非法策略被拒且退出码 2',
      },
    ],
  },
  {
    id: 'cli.exec-input-mutex',
    domain: 'cli',
    doc: 'site/index.html#h-exec-semantics',
    claim: '--input 与提示词参数互斥,同时给出报 The prompt argument and --input cannot be combined.',
    checks: [
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', 'hi', '--input', '-'],
        exit: 2,
        expect: 'The prompt argument and --input cannot be combined.',
        label: '互斥校验报原文',
      },
    ],
  },
  {
    id: 'cli.exec-review-flags',
    domain: 'cli',
    doc: 'site/index.html#h-exec-review',
    claim: 'mcode exec review 仅支持 9 个选项,不含 --session / --input / --file',
    checks: [
      { kind: 'doc', text: 'mcode exec review', label: '文档含 review 小节' },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', 'review', '--help'],
        flagSet: REVIEW_FLAGS,
        label: 'review 选项集双向相等',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', 'review', '--help'],
        notIn: ['--session', '--continue', '--input', '--file', '--output-schema', '--diagnostics-dir'],
        label: 'review 不接受会话/输入输出类选项',
      },
    ],
  },
  {
    id: 'cli.review-not-a-skill',
    domain: 'cli',
    doc: 'site/index.html#h-exec-review',
    claim: 'exec review 是 Runtime 内置模式,不是内置 Skill:其 --help 描述审查本地改动',
    checks: [
      {
        kind: 'exec',
        cmd: M,
        args: ['exec', 'review', '--help'],
        expect: 'Review staged, unstaged, and untracked local changes',
        label: 'review 自述审查对象',
      },
      {
        kind: 'source',
        file: '.js',
        // Runtime 内置 review 模式有专门的提示词装配路径,与 Skill 加载路径不同。
        pattern: 'reviewer-system',
        label: '源码走独立 review 提示词',
      },
    ],
  },
  {
    id: 'cli.plugin-subcommands',
    domain: 'cli',
    doc: 'site/index.html#h-plugin-cli',
    claim: 'mcode plugin 子命令为 list / add / remove / enable / disable / marketplace',
    checks: [
      { kind: 'doc', text: 'mcode plugin', label: '文档含 plugin 小节' },
      {
        kind: 'exec',
        cmd: M,
        args: ['plugin', '--help'],
        containsAll: ['list', 'add', 'remove', 'enable', 'disable', 'marketplace'],
        label: 'plugin 子命令齐全',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['plugin', 'list', '--help'],
        expect: 'installed or available',
        label: 'plugin list 语义',
      },
    ],
  },
  {
    id: 'cli.provider-subcommands',
    domain: 'cli',
    doc: 'site/index.html#h-provider',
    claim: 'mcode provider 子命令为 list / add / remove / test / use / set-minimax-key',
    checks: [
      {
        kind: 'exec',
        cmd: M,
        args: ['provider', '--help'],
        containsAll: ['list', 'add', 'remove', 'test', 'use', 'set-minimax-key'],
        label: 'provider 子命令齐全',
      },
    ],
  },
  {
    id: 'cli.login-region',
    domain: 'cli',
    doc: 'site/index.html#h-top-commands',
    claim: 'mcode login --region 取 cn 或 global,并支持 --no-browser',
    checks: [
      {
        kind: 'exec',
        cmd: M,
        args: ['login', '--help'],
        expect: /account region: cn or global/,
        label: 'region 取值',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['login', '--help'],
        containsAll: ['--region', '--no-browser'],
        label: 'login 选项齐全',
      },
    ],
  },
  {
    id: 'cli.unknown-option',
    domain: 'cli',
    doc: 'site/index.html#h-troubleshooting',
    claim: '未知选项以退出码 1 失败并打印 usage',
    checks: [
      {
        kind: 'exec',
        cmd: M,
        args: ['--badflag'],
        exit: 1,
        expect: /unknown option/,
        label: '未知选项退出码 1',
      },
    ],
  },
  {
    id: 'cli.side-session-commands',
    domain: 'cli',
    doc: 'skills/mcode-docs/reference/commands.md',
    claim: '侧会话只读命令集为 help / changelog / context / status / usage / export / transcript / copy / parent',
    checks: [
      { kind: 'doc', text: '/btw', label: '文档含 /btw 条目' },
      { kind: 'doc', text: '/parent', label: '文档含 /parent 条目' },
      {
        // 压缩产物里符号名会被改写,只有字符串字面量留存 ——
        // 所以这条按**内容**取证,不按符号名。早先版本引用了
        // SIDE_MODE_READ_ONLY_COMMANDS,那个名字在 bundle 里根本不存在。
        kind: 'source',
        pattern: '"help","changelog","context","status","usage","export","transcript","copy","parent"',
        label: '源码含该命令集字面量',
      },
    ],
  },
  {
    id: 'cli.mcode-tools-installed',
    domain: 'cli',
    doc: 'skills/mcode-docs/reference/cli.md',
    claim: '安装 mcode 会同时装上 mcode-tools,且无需先启动 TUI 即在 PATH 上',
    checks: [
      {
        kind: 'exec',
        cmd: 'mcode-tools',
        args: ['--help'],
        expect: 'host-managed Connector tools',
        label: 'mcode-tools 可独立运行',
      },
    ],
  },
  {
    id: 'cli.version-baseline',
    domain: 'cli',
    doc: 'skills/mcode-docs/reference/cli.md',
    claim: '本机基线为 mcode 0.5.8',
    checks: [
      { kind: 'doc', ref: 'cli.md', text: '0.5.8', label: '参考手册记录基线版本' },
      {
        kind: 'exec',
        cmd: M,
        args: ['--version'],
        expect: /^0\.5\.8$/,
        label: '版本号与基线一致',
      },
    ],
  },
]
