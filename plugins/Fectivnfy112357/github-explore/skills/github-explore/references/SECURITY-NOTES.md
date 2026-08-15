# 共享安全说明 — 写操作规范

> 适用：所有 `commands-*.md` 写操作参考。
> 维护原则：本文件是 4 条写操作纪律的**唯一定义**。`commands-*.md` 中的警告块只能引用本文件，不能复制改写。

## 1. 适用范围

`commands-cicd.md`、`commands-misc.md`、`commands-repo-issue-pr.md` 中列出的所有 `gh` 写命令（create / update / delete / close / merge / dispatch / enable / disable / rerun / cancel 等会改变远端状态或密钥的命令）。

`commands-auth-config.md` 涉及的是认证/凭据，规则不同（见该文件顶部警告），**不**受本文件约束。

## 2. 写操作纪律（4 条）

执行任何上述写命令前，必须向用户明确：

1. **目标**（target）：具体哪个 repo / issue / PR / workflow / secret / 哪个环境变量
2. **影响**（impact）：会产生什么不可逆或可逆的远端变化；是否触发下游（workflow run、通知、audit log）
3. **最小数据**（minimal data）：只传必要字段，避免 `gh pr edit --add-label x,y,z` 这种全量覆盖
4. **确认**（consent）：上述 3 条说完后，得到用户**显式确认**才执行；未得到确认前**不得**调用写命令

## 3. 默认

`github-explore` 的 9 个 discovery 脚本（`find_repos` / `discover` / `explore` / `trending` / `repo_summary` / `find_similar` / `code_search` / `search_issues` / `org_landscape`）只读，永不调用写命令。写操作仅由 agent 在用户显式驱动下临时拼装 `gh …` 命令完成。

## 4. 错误信息

写命令的 stderr 输出会经 `_lib.redact_secrets()` 过滤（fine-grained PAT、classic PAT、Bearer token、token=… 形式、`GH_TOKEN=…` 形式），不会把凭据打回 transcript。
