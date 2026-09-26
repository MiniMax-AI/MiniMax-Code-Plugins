# ScanSci PDF 学术文献下载

给 MiniMax Code 用的学术论文获取插件：把一个 DOI、arXiv ID、关键词检索或上千行的文献清单变成下载完成的 PDF，并为每一篇报告实际来源。插件封装的是 [scansci-pdf](https://github.com/Rimagination/scansci-pdf) 引擎——20+ 数据源对冲级联竞速（出版商直链、OpenAlex / Unpaywall / Europe PMC / arXiv 开放获取解析、Sci-Hub / LibGen 镜像、用户授权的机构通道）——以两个 Skill 加一个本地 stdio MCP server 的形式提供。

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

- 本机 **Python >= 3.11**，且 `scansci-pdf` 可执行文件在 `PATH` 上：

  ```bash
  pip install scansci-pdf      # 或：uv tool install scansci-pdf
  scansci-pdf check            # 校验依赖
  ```

- PyPI wheel 自带预编译的 Cython 核心（`scansci_pdf._core`），安装无需编译器。部分兜底数据源需要无头浏览器（可选扩展 `pip install scansci-pdf[camoufox]`）。
- 平台：Windows / macOS / Linux。明确处理大陆网络环境（镜像选择、代理探测），但非必需。
- 不依赖 MiniMax Code 宿主工具；一切通过 MCP server（stdio，`scansci-pdf run` 启动）或 CLI 兜底完成。
- 机构通道需要**用户自己的凭据**：校园网环境下的 Elsevier API key，或用户在浏览器里完成的 WebVPN / CARSI 登录。灰色源（Sci-Hub / LibGen）通道上游默认开启；用户可切换 `legal_only` 策略仅用合法来源。

## 数据与网络

- 出站请求面向学术 API 与镜像：OpenAlex、Unpaywall、Crossref、Semantic Scholar、Europe PMC / PMC、arXiv、DOAJ、OpenAIRE、出版商站点与 CDN（Elsevier、Springer、MDPI 等）、Sci-Hub 镜像、LibGen，以及用户自己的机构 WebVPN / CARSI 端点。Unpaywall 要求用户真实邮箱（缺失时经 MCP 交互式索要）。
- 配置、凭据、浏览器会话 cookie 均保存在本地 `~/.scansci-pdf/`。插件目录本身只含 markdown 与 JSON——无二进制、无凭据、无遥测。
- 引擎的闭源编译核心只经 PyPI wheel 分发；项目其余源码在 GitHub（Apache-2.0）。

## 上游、许可与维护

- 上游项目：<https://github.com/Rimagination/scansci-pdf>（Apache-2.0，Copyright 2024-2026 scansci-pdf contributors）。本包再分发上游 **v1.17.0** 的两个 Skill 文档与 MCP 接线；引擎本体从 PyPI 安装，从不 vendor 进本目录。
- 由 [NkAntony777](https://github.com/NkAntony777) 在本注册表提交并维护。`scansci-sort` 中部分进阶流程引用的辅助脚本位于上游仓库，不在本目录内。
- 版本号跟随上游发布。
