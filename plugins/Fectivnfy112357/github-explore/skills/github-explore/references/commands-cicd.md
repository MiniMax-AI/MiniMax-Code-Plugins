# gh 命令参考：CI/CD（Actions / Releases）

> 按需查阅。workflow 运行、缓存、密钥、变量、发布管理。

## Runs / Workflows

```bash
# Runs
gh run list --workflow ci.yml --branch main
gh run view 123456789 --log
gh run watch 123456789 --interval 5
gh run rerun 123456789
gh run cancel 123456789
gh run download 123456789 --dir ./artifacts

# Workflows
gh workflow list / gh workflow view ci.yml --yaml
gh workflow enable ci.yml / gh workflow disable ci.yml
gh workflow run ci.yml --ref main -f env=prod
```

## Caches

```bash
gh cache list --limit 50
gh cache delete <id> / gh cache delete --all
```

## Secrets / Variables

```bash
# Secrets
gh secret set MY_SECRET
gh secret set MY_SECRET --env production
gh secret list / gh secret delete MY_SECRET

# Variables
gh variable set MY_VAR "value"
gh variable get MY_VAR / gh variable list
```

## Releases

```bash
gh release create v1.0.0 --notes "..." --notes-file notes.md --target main --draft
gh release list / gh release view v1.0.0
gh release upload v1.0.0 ./file.tar.gz
gh release download v1.0.0 --pattern "*.zip" --dir ./out
gh release delete v1.0.0 --yes
```
