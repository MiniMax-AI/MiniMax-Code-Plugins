# 共享安全说明 — 写操作规范

> 适用：所有 `commands-*.md` 写操作参考。
> 维护原则：本文件是 4 条写操作纪律的**唯一定义**。`commands-*.md` 中的警告块只能引用本文件，不能复制改写。

## 1. 适用范围

`commands-*.md`（**全部 5 个文件**：`commands-auth-config.md`、`commands-cicd.md`、`commands-misc.md`、`commands-repo-issue-pr.md`、`commands-search-format.md`）中所有会改变远端状态、本地凭据或配置的命令都属于本文件约束：

- 远端写：`create` / `update` / `delete` / `close` / `merge` / `dispatch` / `enable` / `disable` / `rerun` / `cancel` / `comment` / `edit` / `rename` / `archive` / `unarchive` / `pin` / `unpin` / `lock` / `transfer` / `reopen` / `ready` / `revert` / `set-default` / `fork` / `add-deploy-key` 等
- **认证/凭据写**（`commands-auth-config.md`，**新版起纳入本文件门禁**）：`gh auth login` / `login --web` / `logout` / `switch` / `setup-git`（设为 git credential helper） / `refresh --scopes …`（扩大 scopes = 权限提升）
- **配置写**（同上文件）：`gh config set …` / `gh config clear-cache`
- **API mutation**（`commands-search-format.md`，**新版起纳入本文件门禁**）：`gh api --method POST|PUT|DELETE|PATCH …` 任意调用；`gh api graphql` 中含 `mutation` 的 query（无 `mutation` 关键字的 query 视为只读）

> 范围扩大后，特别注意：auth/config 写和 `gh api` mutation 影响的**不只是远端仓库**——凭据 helper 与扩大 scopes 涉及本机用户身份与权限，API mutation 可触达任意 GitHub 资源（issue、discussion、project、admin endpoint），4 条纪律对它们**更**重要。

## 2. 写操作纪律（4 条）

执行任何上述写命令前，必须向用户明确：

1. **目标**（target）：具体哪个 repo / issue / PR / workflow / secret / 哪个环境变量 / 哪个 host（GHE vs github.com）
2. **影响**（impact）：会产生什么不可逆或可逆的远端变化；是否触发下游（workflow run、通知、audit log）；是否影响本机凭据/配置（auth/config 写）
3. **最小数据**（minimal data）：只传必要字段，避免 `gh pr edit --add-label x,y,z` 这种全量覆盖
4. **确认**（consent）：上述 3 条说完后，得到用户**显式确认**才执行；未得到确认前**不得**调用写命令

## 3. 默认

`github-explore` 的 9 个 discovery 脚本（`find_repos` / `discover` / `explore` / `trending` / `repo_summary` / `find_similar` / `code_search` / `search_issues` / `org_landscape`）只读，永不调用写命令。写操作仅由 agent 在用户显式驱动下临时拼装 `gh …` 命令完成。

## 4. 错误信息

**诚实声明**：raw `gh` 命令的 stderr **不会**自动脱敏。9 个发现脚本内部走 `subprocess.run(..., capture_output=True)` + `_lib.warn/die()` 的 `redact_secrets()` 路径，所以脚本自身抛错时凭据形态会被遮住；但 agent 在 Bash 工具里直接跑 `gh …` 时，stderr 原样进 transcript，**不**经过 Python wrapper。

需要在 transcript 分享前脱敏时，把命令管道接 `scripts/redact_stderr.py`：

```bash
gh <cmd> 2>&1 | python scripts/redact_stderr.py
```

`redact_stderr.py` 复用 `_lib.redact_secrets()`（fine-grained PAT、classic PAT、Bearer token、token=… 形式、`GH_TOKEN=…` / `GITHUB_TOKEN=…` 形式），对 stdin → stdout 透明过滤。脚本只读合并后的 stdin 流，**调用方需自行 `2>&1`** 把 stderr 合入。**脱敏是 best-effort**，非常规 token 形态仍可能漏出，分享前人工扫一眼。

## 5. 网络目的地 — `GH_HOST` / GitHub Enterprise

`GH_HOST` 环境变量会改变所有 `gh` 子命令的网络目的地（纯 git 操作如 `git push` 不受 `GH_HOST` 影响，跟 `git remote` 走），默认 `github.com`。`--hostname` **不是全局 flag**，只在 `auth login/status/token/switch/logout/refresh/setup-git`、`api`、`attestation *` 等 11 个子命令上存在；要用某 host 跑任意命令，正确姿势是 `GH_HOST=acme.ghe.com gh <cmd>` 或 `gh auth switch --hostname acme.ghe.com`。

- `GH_HOST=github.acme.com`（GHES on-prem）或 `GH_HOST=acme.ghe.com`（GHEC 租户）→ REST / search / GraphQL 改走该 host
- 凭据按 host 隔离：gh 的凭据存储（hosts.yml）按 host 分键，keyring 命名空间为 `gh:<host>:<user>`，一个 host 的 PAT 不会落在另一 host 的调用上
- `gh auth status` **默认枚举所有已认证 host**，不是只校验当前 host；要限定单 host 用 `--hostname X`，只要活跃账号用 `--active`

**例外（env var 优先于 hosts.yml）**：`GH_TOKEN` / `GITHUB_TOKEN` 仅当目标 host 是 `github.com` / `*.ghe.com` 租户子域 / `github.localhost` 时被 gh 读取；**GHES on-prem 实例（如 `github.acme.com`）必须用 `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN`**——设了 `GH_TOKEN` 切到 GHES，gh 不会用它，会回落到 hosts.yml，找不到就报错。GHEC（`*.ghe.com` 数据驻留租户）和 GHES（on-prem）是两套不同部署，env var 名不同。

**skill 不限制、不校验、不警告 `GH_HOST` 的值**——用户负责确保 host 是预期目的地。跨 host 误调用等同于跨凭据泄漏：写到错误组织的 issue / 在错误仓库开 PR / 用错误 token 触发 GHES workflow。

如果用户在 transcript 里看到 `gh <cmd> 2>&1` 的输出里 host 字段异常（`api.github.acme.com` 而不是 `api.github.com`），立即停下来确认目的地，不要假定是 github.com。
