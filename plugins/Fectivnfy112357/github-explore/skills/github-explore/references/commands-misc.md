# gh 命令参考：杂项（组织 / 标签 / 密钥 / Gist / Codespaces / 别名 / 扩展）

> 按需查阅。零散管理操作集合。

## 组织 (gh org)

```bash
gh org list --user octocat
gh org view orgname --json members --jq '.members[].login'
```

## 标签 (gh label)

```bash
gh label create bug --color d73a4a --description "..."
gh label edit bug --name bug-report
gh label clone owner/repo    # 复制另一仓库的标签
gh label delete bug
```

## SSH / GPG 密钥

```bash
gh ssh-key add ~/.ssh/id_ed25519.pub --title "laptop"
gh ssh-key list / gh ssh-key delete <id>
gh gpg-key add ~/.ssh/id_rsa.pub
gh gpg-key list / gh gpg-key delete <id>
```

## Gist / Codespaces

```bash
# Gists
gh gist create script.py --desc "..." --public
gh gist list / gh gist view abc123
gh gist edit abc123 / gh gist delete abc123
gh gist rename abc123 --filename old.py new.py

# Codespaces
gh codespace create --repo owner/repo
gh codespace list / gh codespace ssh
gh codespace stop <name> / gh codespace delete <name>
gh codespace cp local.txt :/workspaces/file.txt
```

## 别名 / 扩展 / Ruleset

```bash
# 别名
gh alias set prview 'pr view --web'
gh alias set co 'pr checkout' --shell
gh alias list / gh alias delete prview

# 扩展
gh extension install owner/repo --branch main
gh extension list / gh extension upgrade ext-name / gh extension remove ext-name

# Ruleset
gh ruleset list / gh ruleset view 123
gh ruleset check --branch feature
```

## 其他

```bash
gh browse                # 浏览器打开
gh status                # 状态总览
gh completion -s bash > ~/.gh-complete.bash   # shell 补全
gh preview prompter      # 预览特性
gh attestation verify owner/repo --artifact-id 123   # 签名验证
```
