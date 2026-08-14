# gh 命令参考：搜索 / 输出格式化 / API

> 按需查阅。脚本已封装 repo/issue 搜索；裸 `gh search` 用于脚本覆盖不到的查询或快速查看。JSON 字段命名注意：`gh search repos` 用复数（`stargazersCount`），`gh repo view` 用单数（`stargazerCount`）。

## 搜索 (gh search)

```bash
# 仓库（脚本 find_repos/explore 底层）
gh search repos "stars:>1000 language:python" --limit 50 --sort stars --order desc
gh search repos "topic:api" --json name,description,stargazers
gh search repos "user:octocat fork:true"

# 代码
gh search code "import" --extension py --repo owner/repo
gh search code "FIXME" --filename '*_test.go' --path 'src/'

# Issue/PR
gh search issues "is:open is:issue label:bug" --repo owner/repo
gh search prs "is:open is:pr review:required"

# Commits
gh search commits "fix bug" --author octocat
```

> **代码搜索专属 qualifier**：`language:`、`extension:`、`filename:`、`path:`、`repo:`、`user:`、`org:`。`--min-stars` 需脚本后处理（code search 本身不支持 stars qualifier）。

## 输出格式化

```bash
# JSON + jq（脚本用这种方式拿结构化数据）
gh repo view --json name,description --jq '.name + ":" + .description'
gh pr list --json number,title --jq '.[] | select(.title | contains("fix"))'

# 模板
gh pr view 123 --template '{{.title}} ({{.state}})'

# 常用 --json 字段（camelCase，单复数注意）：
#   search repos: stargazersCount / forksCount（复数）
#   repo view:    stargazerCount / forkCount（单数）
```

## API (gh api)

```bash
# REST
gh api /user
gh api --method POST /repos/o/r/issues -f title="..." -f body="..."
gh api /repos/o/r --jq '.stargazers_count'
gh api --paginate /orgs/o/repos          # 翻页
gh api /user/repos --paginate > all.json

# GraphQL
gh api graphql -f query='{ viewer { login repositories(first:5){ nodes { name } } } }'
```
