# gh 命令参考：认证 / 配置 / CLI 结构

> 按需查阅。版本基准：gh 2.85.0。详细 flag 用 `gh <cmd> --help`。

> ⚠️ **写操作需确认**（新版纳入统一门禁）：本文件含 `gh auth login/logout/switch/setup-git/refresh --scopes`（凭据/凭证 helper/scopes 变更）与 `gh config set/clear-cache`（配置文件写入）等写命令——影响本机用户身份、git credential helper、scope 权限与 gh 配置，不只是远端状态。4 条纪律（目标 / 影响 / 最小数据 / 确认）见 [SECURITY-NOTES.md](SECURITY-NOTES.md)。特别注意：`gh auth refresh --scopes …` 是**权限提升**，与 `repo/issue/PR/workflow` 写操作同等敏感。

> ⚠️ **认证诊断只允许 `gh auth status`（不回显 token）。** 禁止 `gh auth token`、`gh auth status --show-token`、`gh auth login --with-token` 等回显/打印 token 的命令；`GH_TOKEN` 仅用于自动化（CI），不得打印到 transcript。

## 安装

```bash
brew install gh            # macOS
winget install --id GitHub.cli   # Windows
sudo apt install gh        # Debian/Ubuntu（先加官方 apt 源）
gh --version               # 验证
```

## 认证 (gh auth)

```bash
gh auth login                       # 交互登录
gh auth login --web                 # 浏览器授权
gh auth status                      # 检查（脚本 ensure_auth 用这个；唯一允许的认证诊断，不回显 token）
gh auth switch --hostname github.com --user <name>   # 切换账号
gh auth logout
gh auth setup-git                   # gh 作为 git credential helper
gh auth refresh --scopes write:org,read:public_key   # 加 scope
```

## CLI 结构

```
gh
├── auth       登录/登出/切换账号/token
├── browse     浏览器打开
├── codespace  Codespaces
├── gist       代码片段
├── issue      Issues
├── org        组织
├── pr         Pull Requests
├── project    项目(Projects)
├── release    发布
├── repo       仓库
├── cache      Actions caches
├── run        Workflow runs
├── workflow   Workflows
├── agent-task Agent tasks
├── alias      别名
├── api        REST/GraphQL API
├── attestation 签名证明
├── completion shell 补全
├── config     配置
├── extension  扩展
├── gpg-key    GPG 密钥
├── label      标签
├── preview    预览特性
├── ruleset    Rulesets
├── search     搜索(code/commits/issues/prs/repos)
├── secret     Secrets
├── ssh-key    SSH 密钥
├── status     状态总览
└── variable   Variables
```

## 配置与环境变量

```bash
gh config list
gh config get editor
gh config set editor vim
gh config set git_protocol ssh
gh config set prompt disabled
gh config clear-cache
```

| 变量 | 作用 |
|---|---|
| `GH_TOKEN` / `GITHUB_TOKEN` | token（仅 `github.com` + `*.ghe.com` + `github.localhost` 用；仅自动化/CI；禁止回显） |
| `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` | token（GHES on-prem 用，作用域与上不同；仅自动化/CI；禁止回显） |
| `GH_HOST` | 默认 host（github.com）；亦可用 `--hostname`，但 `--hostname` 不是全局 flag、只在 11 个子命令上存在 |
| `GH_PROMPT_DISABLED` | 禁用交互提示 |
| `GH_EDITOR` / `GH_PAGER` | 编辑器/分页器 |
| `GH_TIMEOUT` | HTTP 超时（秒） |
| `GH_REPO` | 默认 owner/repo |

## 全局 flag

| Flag | 作用 |
|---|---|
| `--help` / `-h` | 帮助 |
| `--version` | 版本 |
| `--repo HOST/OWNER/REPO` | 指定仓库 |
| `--hostname HOST` | 指定 host（**非全局**：仅 `auth` / `api` / `attestation` 等约 11 个子命令支持；通用切换用 `GH_HOST=... gh <cmd>`） |
| `--jq EXPR` | JSON 过滤 |
| `--json FIELDS` | JSON 输出字段 |
| `--template STR` | Go 模板格式化 |
| `--web` | 浏览器打开 |
| `--paginate` | 自动翻页 |
| `--verbose` / `--debug` | 详细/调试 |
| `--timeout SECONDS` | 请求超时 |
| `--cache MODE` | 缓存控制(default/force/bypass) |

```bash
gh --help
gh pr --help
gh help formatting / gh help environment / gh help exit-codes
```
