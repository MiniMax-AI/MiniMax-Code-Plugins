# gh 命令参考：仓库 / Issue / PR

> 按需查阅。开发核心流：repo 管理、issue 追踪、PR 生命周期。

> ⚠️ **写操作需确认**：本文件含 `create/update/delete/close/merge/dispatch` 等会改变远端状态的命令。4 条纪律（目标 / 影响 / 最小数据 / 确认）见 [SECURITY-NOTES.md](SECURITY-NOTES.md)；默认保持只读。

## 仓库 (gh repo)

```bash
# 创建
gh repo create my-repo --public --description "..." --clone --license mit

# 克隆/同步
gh repo clone owner/repo [dir] --branch main
gh repo sync                          # fork 同步上游

# 列表
gh repo list owner --limit 50 --public --source
gh repo list --json name,visibility --jq '.[].name'

# 查看
gh repo view owner/repo --json name,description,defaultBranchRef

# 编辑
gh repo edit --description "..." --visibility private
gh repo edit --enable-issues / --disable-issues
gh repo edit --default-branch main
gh repo rename new-name
gh repo archive / gh repo unarchive

# 删除
gh repo delete owner/repo --yes

# Fork / 默认 repo / autolink / deploy key
gh repo fork owner/repo --clone --remote-name upstream
gh repo set-default owner/repo
gh repo autolink add --key-prefix JIRA- --url-template https://jira.example.com/browse/<num>
gh repo deploy-key add ~/.ssh/id_ed25519.pub --title "CI"
```

## Issue (gh issue)

```bash
gh issue create --title "..." --body "..." --label bug --assignee @me
gh issue list --state all --limit 50 --search "is:open label:bug"
gh issue list --json number,title,labels --jq '.[] | [.number, .title, [.labels[].name]] | @tsv'
gh issue view 123 --comments
gh issue edit 123 --add-label stale --remove-label triage
gh issue close 123 --comment "Fixed in #456"
gh issue reopen 123
gh issue comment 123 --body "..."
gh issue pin 123 / gh issue unpin 123
gh issue lock 123 --reason off-topic
gh issue transfer 123 --repo owner/new
gh issue delete 123 --yes
gh issue develop 123 --branch fix/issue-123     # 从 issue 开 PR
```

## Pull Request (gh pr)

```bash
gh pr create --title "..." --body "..." --base main --head feature --draft
gh pr create --issue 123                         # 关联 issue
gh pr list --state all --search "is:open review:required"
gh pr view 123 --json title,state,files
gh pr diff 123
gh pr checkout 123 --branch my-branch
gh pr checks 123 --watch
gh pr merge 123 --squash --delete-branch
gh pr merge 123 --admin                           # 跳过 checks
gh pr close 123 / gh pr reopen 123
gh pr edit 123 --add-label needs-review
gh pr ready 123                                   # draft -> ready
gh pr comment 123 --body "..."
gh pr review 123 --approve --body "LGTM"
gh pr review 123 --request-changes --body "..."
gh pr update-branch 123
gh pr revert 123
```

## 常用工作流

```bash
# Issue -> PR
gh issue develop 123 --branch fix/issue-123
# 改代码后
git add . && git commit -m "Fix #123" && git push
gh pr create --title "Fix #123" --body "Closes #123"

# 批量关 stale issue
gh issue list --search "label:stale" --json number --jq '.[].number' \
  | xargs -I{} gh issue close {} --comment "Closing as stale"

# 批量打标签
gh pr list --search "review:required" --json number --jq '.[].number' \
  | xargs -I{} gh pr edit {} --add-label needs-review

# Fork 同步
gh repo fork original/repo --clone
git remote add upstream https://github.com/original/repo.git
gh repo sync
```
