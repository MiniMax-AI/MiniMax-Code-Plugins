# ScanSci PDF 学术文献下载

给 MiniMax Code 用的学术论文获取插件：把一个 DOI、arXiv ID、关键词检索或上千行的文献清单变成下载完成的 PDF，并为每一篇报告实际来源。插件封装的是 [scansci-pdf](https://github.com/Rimagination/scansci-pdf) 引擎——20+ 数据源对冲级联竞速（出版商直链、OpenAlex / Unpaywall / Europe PMC / arXiv 开放获取解析、Sci-Hub / LibGen 镜像、用户授权的机构通道）——以两个 Skill 加一个本地 stdio MCP server 的形式提供。插件内置本次修补的纯源码引擎副本，启动时不会调用 PATH 上不确定版本的可执行文件。

包含两个 Skill：

- **scansci-pdf** —— 单篇下载、检索与引文、批量车道调度下载、机构渠道配置（Elsevier API、WebVPN / CARSI）与排障（Cloudflare / Turnstile、代理、会话过期）。
- **scansci-sort** —— 大清单摸底（数百到数千条 DOI）：先只嗅探不下载，分类为"开源 OA / 灰色源可得 / 需机构权限"三桶，再按桶路由批量下载。

## 试试看

```text
帮我下载这篇论文：10.1038/s41586-024-07386-0，顺便给我 BibTeX 条目。
```

预期结果：agent 解析 DOI、下载 PDF 并报告来源（通常是开放获取直链，几秒内完成）、保存到工作目录，并返回经过校验的 BibTeX 记录。

```text
这是 reading_list.xlsx，约 800 个 DOI。先分清哪些开源、哪些 Sci-Hub 有、哪些要走我校登录，然后把能下的都下了。
```

预期结果：agent 执行嗅探优先的摸底流程，产出分类报告（UTF-8 CSV）和分桶队列文件，批量下载 OA 桶和灰色桶，并列出仍需机构权限的论文。

## 环境要求

- 本机 **Python >= 3.11 和 Node >=22**。请在 MiniMax Code 使用的 Python 环境中安装 `vendor/scansci-pdf/pyproject.toml` 声明的依赖：

  ```bash
  python -m pip install --require-hashes -r <PLUGIN_ROOT>/vendor/scansci-pdf/requirements.lock
  # 在项目工作目录运行：
  node <PLUGIN_ROOT>/vendor/scansci-pdf/launch_secure.mjs --verify
  ```

  浏览器流程安装带哈希的可选依赖集：`python -m pip install --require-hashes -r <PLUGIN_ROOT>/vendor/scansci-pdf/requirements-browser.lock`，使用已安装的 Chrome/Edge 或明确安装选定后端内核。

- 使用源码 fallback，无需编译器。浏览器回退和机构登录通过带认证的本机 CONNECT 代理访问公网，TLS 保持端到端验证。浏览器需单独安装可选依赖及内核；Chromium 已有真实集成测试，Camoufox/Firefox 仍需平台集成验证。
- 远程 CamoFox/FlareSolverr 服务无法强制该安全策略，Hosted 模式改用受保护的本地浏览器；这两种远程服务接入仍受限。
- 平台：Windows / macOS / Linux。明确处理大陆网络环境（镜像选择、代理探测），但非必需。
- 不依赖 MiniMax Code 宿主工具；一切通过 MCP server（stdio，由包内 Node bootstrap 启动）或同一 bootstrap 的 CLI 兜底完成。
- 机构通道需要**用户自己的凭据**：校园网环境下的 Elsevier API key，或用户在浏览器里完成的 WebVPN / CARSI 登录。灰色源（Sci-Hub / LibGen）通道上游默认开启；用户可切换 `legal_only` 策略仅用合法来源。

## 官方开发环境

官方开发环境是位于 `vendor/scansci-pdf/.venv`（已被 git 忽略）的 CPython 3.11 虚拟环境，
按 CI workflow 相同的方式从带哈希锁定的浏览器依赖集安装。3.11 是声明的依赖下限；所有本地
验证都在这个环境里跑，结果才能与 CI 对齐：

```bash
cd <PLUGIN_ROOT>/vendor/scansci-pdf
py -V:Astral/CPython3.11.17 -m venv .venv    # 任意 CPython 3.11；POSIX 下：python3.11 -m venv .venv
.venv/Scripts/python -m pip install --require-hashes -r requirements-browser.lock
.venv/Scripts/python -m pip install pytest cryptography
```

日常校验，顺序与 workflow CI 一致（POSIX 下用 `.venv/bin/python`）：

```bash
.venv/Scripts/python -I run_secure.py --verify    # 源码清单 + 锁定的依赖版本
.venv/Scripts/python -m pytest tests -q -rs       # 完整引擎回归套件
```

修改 `src/` 下源码或启动器/锁定文件后，重新生成源码哈希清单并与改动一起提交：

```bash
.venv/Scripts/python scripts/hash_sources.py
```

Tor Expert Bundle 升级是受源码管理的 pin 更新：按对应版本的 Tor Project
`sha256sums-signed-build.txt` 更新 `src/scansci_pdf/embedded_tor.py` 中的 `TOR_VERSION`
和六个 `TOR_HASHES`（运行时绝不联网取 pin），然后重新生成清单并重跑测试套件。

## 数据与网络

- 出站请求面向学术 API 与镜像：OpenAlex、Unpaywall、Crossref、Semantic Scholar、Europe PMC / PMC、arXiv、DOAJ、OpenAIRE、出版商站点与 CDN（Elsevier、Springer、MDPI 等）、Sci-Hub 镜像、LibGen，以及用户自己的机构 WebVPN / CARSI 端点。Unpaywall 要求用户真实邮箱（缺失时经 MCP 交互式索要）。
- 配置和凭据保存在当前工作区私有的 `.scansci-pdf/` 目录中；配置与 cookie 使用原子私有写入，并拒绝已有符号链接。
- 严格网络层只允许公网 HTTPS，在实际连接时校验对端 IP，逐跳检查重定向，并把论文正文/元数据视为不可信外部内容。
- 引擎来源固定在 `vendor/scansci-pdf/SOURCE-COMMIT.txt`。每个工作线程复用 HTTP 连接池，保留批量并发、元数据缓存和流式原子写入。
- 支持用户明确配置的 HTTP(S)/SOCKS5 代理；目标 DNS 在本机解析并校验，代理只能连接校验后的数字 IP，TLS 仍验证原站点名称。Tor 使用固定 SHA-256 的安装包，检查解压路径和已安装文件，安装需用户确认；已有外部 Tor 服务可继续使用。
- 分类脚本通过 `node <PLUGIN_ROOT>/vendor/scansci-pdf/launch_secure.mjs --helper <脚本名>` 执行。原地回写 Excel 需明确同意并传入 `--confirm-writeback`，保存采用原子替换。
- 性能数据、回归测试和验证边界见 `REVIEW-NOTES.md`。

## 隔离启动与第四轮安全迁移

- MCP 使用 `launch_secure.mjs`，通过隔离且不加载 site 的探测检查 `python3` / `python`，绑定返回的绝对解释器路径，再以 `-I` 启动引擎。建议在宿主环境设置 `SCANSCI_PDF_PYTHON`，指向已安装固定依赖的虚拟环境解释器绝对路径。
- Hosted 模式不会重新打开或复制原生浏览器 profile，也不会删除旧 profile。SSO 登录在同一存活 context 内可继续使用，跨运行可能需要重新登录；仅恢复目标域、完整安全属性的 Cookie。localStorage 需要明确开启，且按完整 origin（协议、主机、端口）限制。
- 代理、后端、可执行文件、摘要和机构登录来源的更新都在配置文件真正写入前检查用户确认，包括批量直接保存。MCP 传 `confirmed: true`，CLI 使用 `--confirm-trust`；此参数必须建立在用户实际同意的基础上。
- 学校选择器及旧版 `instsci_school` 同样决定机构地址，需要明确确认。用户同意后才可调用 `scansci_pdf_schools(action="set", school="...", confirmed=true)`；学校、机构地址和启用状态一次原子保存，拒绝时不留下部分改动。
- Zotero 上传地址受显式 origin 白名单限制，API 凭据不会发给存储服务，上传也不会跟随重定向。上传与 API 登记分别检查，失败不会被报告为完整成功。
- 直接使用 Python 时须执行 `python -I <PLUGIN_ROOT>/vendor/scansci-pdf/run_secure.py`。不支持继承 Python 启动钩子；bootstrap 在 Python 启动前清除 `PYTHON*` 设置。不声称对解释器二进制做签名认证。
- 引擎模块仅从源码清单载入。旧字节码会被忽略而不删除；缺失的可选编译模块使用源码 fallback，不会转而载入相邻的 `.pyc`。

## 安全升级与凭据迁移

- 浏览器和 requests 恢复 Cookie 时保留 `HttpOnly`、`Secure`、`SameSite`、过期时间及会话语义；保存、合并与恢复均需明确授权目标。升级前仅含四字段的 Cookie 记录会被拒绝，请重新登录一次，重新生成完整属性；本插件 Netscape 导出通过专有注释保留 SameSite，第三方工具不保证保留该注释。
- `browser_persist_localstorage` 默认 `false`，仅在明确开启时保存/恢复授权来源的 localStorage，字符串 `"false"` 不会开启。修改浏览器二进制信任哈希需要用户明确确认，可写缓存内的程序必须匹配已批准的摘要。
- 未认证的 streamable HTTP 仅允许 loopback 监听；Web 初始 HTML 不嵌入登录 token，两种 Web 启动入口均禁用访问日志，避免查询参数 token 被记录。Elsevier 凭据逐跳限制在签发来源，代理认证信息在结果、日志与控制台出口统一遮蔽。

## 上游、许可与维护

- 上游项目：<https://github.com/Rimagination/scansci-pdf>（Apache-2.0，Copyright 2024-2026 scansci-pdf contributors）。本包内置上游 **v1.18.0** 源码及本次安全补丁，具体来源见 `vendor/scansci-pdf/SOURCE-COMMIT.txt`。
- 由 [NkAntony777](https://github.com/NkAntony777) 在本注册表提交并维护。`scansci-sort` 引用的辅助脚本已随包放在 `vendor/scansci-pdf/scripts/`。
- 插件版本 `1.18.0-minimax.2`，内置引擎版本 `1.18.0.post2`，基于上游 v1.18.0。
