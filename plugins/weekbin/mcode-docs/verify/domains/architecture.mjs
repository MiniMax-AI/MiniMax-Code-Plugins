// 域:架构。
//
// 这一域服务的对象是站点里的三张架构图。图是最容易「看着对其实错」的产物 ——
// 一条画错的边比一句写错的话更难被发现,因为读者不会去查源码。
// 所以图上的每个节点、每条边、每个路径都单独钉一条 claim。
//
// 共同的取证纪律:产物已压缩,符号名不可引用,只引字符串字面量。
const M = 'mcode'

export const claims = [
  /* ---------------------------------------------- 图 ① Runtime / client */
  {
    id: 'arch.single-dispatch',
    domain: 'architecture',
    doc: 'site/index.html#h-runtime-client',
    claim: 'main-*.js 是唯一命令分发点,TUI / exec / ACP 都从它分出',
    checks: [
      { kind: 'doc', text: 'runTuiCli', label: '文档点明唯一分发点' },
      { kind: 'source', file: 'main-', pattern: 'runTuiCli', label: '源码含 runTuiCli' },
      {
        kind: 'source',
        file: 'main-',
        containsAll: ['launcher-', 'run-exec-command', 'run-acp-command', 'auth-command'],
        label: 'main 同时分出四条命令线',
      },
    ],
  },
  {
    id: 'arch.surfaces',
    domain: 'architecture',
    doc: 'site/index.html#h-runtime-client',
    claim: '三个运行时面分别是 surface "tui" / "headless" / "acp"',
    checks: [
      { kind: 'doc', text: 'headless', label: '文档含 headless' },
      { kind: 'doc', text: 'acp', label: '文档含 acp' },
      { kind: 'source', file: 'launcher-', pattern: 'surface:"tui"', label: 'TUI 面' },
      { kind: 'source', file: 'run-exec-command-', pattern: 'surface:"headless"', label: 'exec 面' },
      { kind: 'source', file: 'run-acp-command-', pattern: 'surface:"acp"', label: 'ACP 面' },
    ],
  },
  {
    id: 'arch.adapter-seam',
    domain: 'architecture',
    doc: 'site/index.html#h-runtime-client',
    claim: 'client 唯一入口是 adapter,契约是 Thrift DesktopService,路径前缀 /minimax-desktop/api/v1/',
    checks: [
      { kind: 'doc', text: '/minimax-desktop/api/v1/', label: '文档含路径前缀' },
      { kind: 'doc', text: 'SSE', label: '文档点明流式走 SSE' },
      { kind: 'source', file: 'launcher-', pattern: '.adapter', label: 'client 消费 runtime 的 adapter' },
      { kind: 'source', pattern: 'serviceName:"DesktopService"', label: '契约服务名 DesktopService' },
      { kind: 'source', pattern: '/minimax-desktop/api/v1/', label: '契约路径前缀' },
      { kind: 'source', pattern: 'transport:"sse"', label: '流式 transport 为 sse' },
    ],
  },
  {
    id: 'arch.login-no-runtime',
    domain: 'architecture',
    doc: 'site/index.html#h-runtime-client',
    claim: 'login / logout 走 auth-command,不创建 Runtime',
    checks: [
      { kind: 'doc', pages: ['zh'], text: '不创建 Runtime', label: '中文站点明 login 不建 Runtime' },
      { kind: 'doc', pages: ['en'], text: 'creates no Runtime', label: '英文站同义表述' },
      { kind: 'source', file: 'main-', pattern: 'auth-command', label: 'auth 独立于运行时三条线' },
      { kind: 'exec', cmd: M, args: ['login', '--help'], expect: 'Sign in to use', label: 'login 自述与 Runtime 无关' },
    ],
  },

  /* ---------------------------------------------- 图 ② Plugin 生命周期 */
  {
    id: 'arch.plugin-manifest-precedence',
    domain: 'architecture',
    doc: 'site/index.html#h-life-plugin',
    claim: 'manifest 按 plugin.json → .minimax-plugin → .claude-plugin → .codex-plugin 优先级探测',
    checks: [
      { kind: 'doc', text: '.claude-plugin/', label: '文档含 .claude-plugin/' },
      { kind: 'doc', text: '.codex-plugin/', label: '文档含 .codex-plugin/' },
      { kind: 'source', pattern: 'PLUGIN_MANIFEST_MISSING', label: '源码含缺失判罚码' },
      { kind: 'source', pattern: '".minimax-plugin/plugin.json"', label: '源码含 .minimax-plugin 探测' },
      { kind: 'source', pattern: '".claude-plugin/plugin.json"', label: '源码含 .claude-plugin 探测' },
      { kind: 'source', pattern: '".codex-plugin/plugin.json"', label: '源码含 .codex-plugin 探测' },
    ],
  },
  {
    id: 'arch.plugin-capability-order',
    domain: 'architecture',
    doc: 'site/index.html#h-life-plugin',
    claim: '能力装配固定顺序 apps → mcpServers → skills → hooks → hostBindings',
    checks: [
      { kind: 'doc', text: 'hostBindings', label: '文档含 hostBindings' },
      { kind: 'doc', text: 'mcpServers', label: '文档含 mcpServers' },
      { kind: 'source', pattern: '"hostBindings"', label: '源码含 hostBindings 键' },
    ],
  },
  {
    id: 'arch.plugin-states',
    domain: 'architecture',
    doc: 'site/index.html#h-life-plugin',
    claim: '插件三态为 available / disabled / enabled,只由 installed × enabled 决定',
    checks: [
      { kind: 'doc', text: 'available', label: '文档含 available' },
      { kind: 'doc', text: 'disabled', label: '文档含 disabled' },
      { kind: 'doc', text: 'enabled', label: '文档含 enabled' },
      {
        kind: 'source',
        file: 'plugin-command-',
        pattern: '"available"',
        label: 'plugin CLI 渲染三态',
      },
      {
        kind: 'exec',
        cmd: M,
        args: ['plugin', 'list', '--help'],
        expect: 'installed or available',
        label: 'list 区分已装与可用',
      },
    ],
  },
  {
    id: 'arch.plugin-data-dir',
    domain: 'architecture',
    doc: 'site/index.html#h-life-plugin',
    claim: 'PLUGIN_DATA 落在 <数据目录>/v2/plugin-data/agent-plugins/<名称>,以 0700 创建',
    checks: [
      { kind: 'doc', text: 'v2/plugin-data/agent-plugins', label: '文档含该路径' },
      { kind: 'doc', text: '0700', label: '文档含权限位' },
      { kind: 'source', pattern: '"plugin-data","agent-plugins"', label: '源码含路径拼接' },
      {
        kind: 'source',
        file: 'chunk-LG37JEC6',
        // 0o700 的十进制是 448。Hook 子系统建 pluginDataDir 时用的就是这个值。
        pattern: 'mode:448',
        label: '目录以 0700 创建',
      },
    ],
  },

  /* ---------------------------------------------- 图 ③ MiniApp */
  {
    id: 'arch.miniapp-child-process',
    domain: 'architecture',
    doc: 'site/index.html#h-life-miniapp',
    claim: 'MiniApp 是宿主 spawn 出的独立 Node 子进程,配置经 IPC 的 miniapp:init 下发',
    checks: [
      { kind: 'doc', text: 'miniapp:init', label: '文档含 miniapp:init' },
      { kind: 'doc', text: 'startupToken', label: '文档含 startupToken' },
      { kind: 'source', pattern: '"miniapp:init"', label: '源码含下行指令' },
      { kind: 'source', pattern: '"miniapp:started"', label: '源码含上行指令' },
      { kind: 'source', pattern: '"miniapp:stopped"', label: '源码含停止回报' },
      { kind: 'source', pattern: 'startupToken', label: '源码含就绪令牌' },
    ],
  },
  {
    id: 'arch.miniapp-port-range',
    domain: 'architecture',
    doc: 'site/index.html#h-life-miniapp',
    claim: '端口由宿主在 127.0.0.1 的 49152–65535 区间分配',
    checks: [
      { kind: 'doc', text: '49152', label: '文档含端口下界' },
      { kind: 'doc', text: '65535', label: '文档含端口上界' },
      { kind: 'source', pattern: '"NO_CANDIDATE_PORT"', label: '源码含端口耗尽判罚码' },
      { kind: 'source', pattern: 'maxPortAttempts:3', label: '源码含端口探测次数' },
    ],
  },
  {
    id: 'arch.miniapp-env-narrow',
    domain: 'architecture',
    doc: 'site/index.html#h-life-miniapp',
    claim: '子进程环境几乎为空,只透传少数几个变量并加 ELECTRON_RUN_AS_NODE',
    checks: [
      { kind: 'doc', text: 'ELECTRON_RUN_AS_NODE', label: '文档点明环境极窄' },
      { kind: 'source', pattern: 'ELECTRON_RUN_AS_NODE', label: '源码含该注入变量' },
    ],
  },
  {
    id: 'arch.miniapp-storage-split',
    domain: 'architecture',
    doc: 'site/index.html#h-life-miniapp',
    claim: 'runtimeDir 在系统临时目录下、重启即失;dataDir 落在 v2/plugin-data/liveboards 下、跨重启保留',
    checks: [
      { kind: 'doc', text: 'mavis-miniapp-', label: '文档含临时目录前缀' },
      { kind: 'doc', text: 'liveboards', label: '文档含持久目录名' },
      { kind: 'source', pattern: '"mavis-miniapp-"', label: '源码含临时目录前缀' },
      { kind: 'source', pattern: '"liveboards"', label: '源码含持久目录名' },
    ],
  },
  {
    id: 'arch.miniapp-capacity',
    domain: 'architecture',
    doc: 'site/index.html#h-life-miniapp',
    claim: '同时最多运行三个不同的 MiniApp 服务',
    checks: [
      {
        kind: 'source',
        pattern: 'At most three distinct MiniApp plugin services may run concurrently',
        label: '源码含容量上限原文',
      },
    ],
  },
]
