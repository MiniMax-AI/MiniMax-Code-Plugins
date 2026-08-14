# gh 命令参考：认证 / 配置 / CLI 结构

> 按需查阅。版本基准：gh 2.85.0。详细 flag 用 `gh <cmd> --help`。

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
gh auth login --with-token < token.txt   # token 注入
gh auth status                      # 检查（脚本 ensure_auth 用这个）
gh auth status --show-token         # 显示 token（小心）
gh auth switch --hostname github.com --user <name>   # 切换账号
gh auth logout
gh auth setup-git                   # gh 作为 git credential helper
gh auth token                       # 打印 token
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
| `GH_TOKEN` | token（自动化用） |
| `GH_HOST` | 默认 host（github.com） |
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
| `--hostname HOST` | 指定 host |
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
