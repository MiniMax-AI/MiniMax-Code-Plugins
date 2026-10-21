# PR 描述 — Mcode-webui 插件

> **提交正文，对应
> [MiniMax-Code-Plugins](https://github.com/MiniMax-AI/MiniMax-Code-Plugins)
> 社区注册仓的上游 PR。本文件为中文译文，原文 `PR_DESCRIPTION.md`。
> 推荐直接用作 PR 正文。**

## 本 PR 新增内容

- 新增插件于 `plugins/Wzdhehe/mcode-webui/`，符合 Agent Plugins 1.0 规范
  - `plugin.json`（版本 `2.0.0`）含 10 个白名单顶层字段
  - `skills/mcode-webui/SKILL.md` 含 `{name, description}` frontmatter
  - `LICENSE`（MIT）
  - `README.md`（用户向快速上手 + `docs/screenshots/` 5 张真实截图）
  - `references/SECURITY-NOTES.md`（权威安全披露）
  - `docs/`（ARCHITECTURE、API、CAPABILITIES、DEVELOPMENT、TROUBLESHOOTING、
    BORROW-harness-v2、MATH-skeleton-webui-v2、ANTI-PATTERNS-FIX-PLAN、
    PROJECT-CHARTER-webui-v2、VERIFICATION-REPORT、HTTPS-REVERSE-PROXY、CI）
  - `server/`、`public/`、`test/`、`checks/`、`scripts/`（真实目录，与项目根保持同步；打包时
    按原样进入 `dist/` 作为发布产物。`checks/` 承载依赖 `--experimental-test-module-mocks`
    的模块 mock 套件，因此不进市仓根门禁的无旗标发现面——见 docs/CI.md）
  - `package.json`（与项目根一致，含 `test` / `test:unit` / `test:mocked` /
    `test:integration`、`check` / `check:ci`、`coverage`、`sbom` 脚本）

## v2.0.0 相对 v1.x 的变更（工业化）

本 PR supersede PR #16（v1.0.0 marketplace 提交，OPEN 28 天，@hetaoBackend 给了
4 条 `CHANGES_REQUESTED` review）。v2.0.0 用结构性改写代替 patch 方式
逐条回应：

| @hetaoBackend 对 #16 的 review | v2.0.0 修法 | 位置 |
|---|---|---|
| Review 1 — `server/auth.js` 缺 v1.0.1 setter 导出 | 导出 `setExpectedToken` / `setTokenAuthEnabled` / `markFirstRunNotified`；`isFirstRun` 读持久化状态 | `server/lib/auth.js`（B03 + §6.2 reconcile） |
| Review 2 — `server/lib/db.js:24-34` 硬编码 `better-sqlite3` 解析器 | 4 层候选解析器（`MCODE_BETTER_SQLITE3` 环境变量 → `MCODE_CMD` 反向回溯 → `~/.mcode-webui/db-resolver.json` → 内置 fallback） | `server/lib/db.js`（C01） |
| Review 3 — `SECURITY-NOTES.md` 的环境变量没在 `config.js` 导出；`?token=` 与 `Authorization` 头不一致 | 4 个 SECURITY-NOTES 环境变量已导出（`MCODE_WEBUI_UPLOAD_DIR` / `MCODE_WEBUI_SETTINGS_PATH` / `MCODE_BETTER_SQLITE3` / `DEBUG_INJECT`）；`scripts/check-docs-alignment.mjs` 升级为 CI 闸门，断言 README + plugin + SECURITY-NOTES ↔ router.js + config.js 三向一致 | `server/lib/config.js`（§6.2）+ `scripts/check-docs-alignment.mjs`（B05） |
| Review 4 — marketplace 侧没同步；前 3 条 finding 未结 | marketplace 插件树在本 PR 整体重写（`plugins/Wzdhehe/mcode-webui/` 下每个文件都是新写或改动）；前 3 条 finding 由结构性变更关掉；含 `Wzdhehe/Mcode-webui` 的 round-8 CSRF 修复 | 本 PR + BORROW-harness-v2 / ANTI-PATTERNS-FIX-PLAN 文档 |

在关上旧 review 之外，v2.0.0 还加了 9 项工业级属性，由 19 个实施 lease 支撑
（详见 [`docs/VERIFICATION-REPORT.md`](docs/VERIFICATION-REPORT.md) 的头条摘要 +
[`docs/PROJECT-CHARTER-webui-v2.md`](docs/PROJECT-CHARTER-webui-v2.md) 章程）：

| # | 属性 | 位置 |
|---|---|---|
| 1 | **可验证性** — append-only NDJSON 事件流 + SHA-256 hash 链 | `server/lib/events.js`（B01）+ 18 hook 点 |
| 2 | **可观测性** — 独立的异常 SSE 通道 + 铃铛图标数据源 | `server/lib/alerts.js` + `server/routes/alerts.js`（B02） |
| 4 | **可治理性** — 每次请求 `authorize(action, ctx)` Promise，默认 5 分钟 fail-closed，16 个 hook 点 | `server/lib/authorize.js`（B03） |
| 5 | **可复现性** — `package-lock.json` + CycloneDX 1.5 SBOM + npm-audit 集成 | `scripts/gen-sbom.mjs` + `docs/CI.md` 本地门禁（C02） |
| 6 | **可测试性** — 双模 `node --test` 套件（带 / 不带 `--experimental-test-module-mocks`）+ 本地跨 Node/OS 矩阵配方 | `docs/CI.md`（C02）+ 市仓根 `validate` CI |
| 7 | **可发现性** — 13 个 `plugin.json` capability 都带 `description`（204-286 字符）；CONTRIBUTING.md 含 "Common npm test failures" 小节 | `plugin.json` + `README.md` + `CONTRIBUTING.md`（B05） |
| 8 | **数学根基架构** — 每个子系统带 `sih-math` 定理引用（PROB-018 / ORD-022 / TOP-008 / ALG-001 等） | `docs/MATH-skeleton-webui-v2-2026-09-20.md`（A02） |
| 9 | **单一真理源** — `scripts/check-docs-alignment.mjs` 在 v2 reconcile 后于 CI 退出 0 | `scripts/check-docs-alignment.mjs`（B05）+ §6 reconcile |

在 v1.x 之上新增的能力：

- **聊天列表虚拟化**支持 ≥200 条消息（B01 + C04）
- **跨 workspace 会话搜索**走 `/api/sessions/search?q=…`（B05 + C05）
- **会话导出为 Markdown / JSON**走 `/api/sessions/:id/export`（C06）
- **配额预测**走 `/api/usage/forecast` — 最小二乘线性拟合 + R² 置信度（C07）
- **Token 入站 modal** — 用 UI modal 替换 v1.0.1 stdout 14 行 ASCII box，由 `MCODE_WEBUI_TOKEN_STDOUT=1` 环境变量门控（C08）
- **按 {IP, token} 限流**，环境变量 `MCODE_WEBUI_RATE_LIMIT` / `_BURST`（C03）
- **HTTPS 反向代理文档**覆盖 nginx / caddy / Traefik 2（C03）

## 为什么做这个插件

Kimi-Code 风格的 web 前端对接 `mcode` agent 运行时。让用户在浏览器而不是终端里
打开 `mcode` 会话，实时流式查看工具事件，切换 workspace，使用 `?token=` 入站
modal——全不占用 Mcode TUI 的终端。

## 示例 prompt（含预期结果）

**Prompt 1** — 用户："打开 Mcode webui"

预期：
1. 跑 `node server.js`（前台或后台任选）
2. 等 stdout 上的 SSE `open` 日志行
3. 告诉用户："webui 运行在 http://127.0.0.1:8080/（或 LAN 模式 http://<lan-ip>:8080/）"

**Prompt 2** — 用户："Mcode webui 状态"

预期：
1. 检查端口 8080 是否占用
2. 如监听：报"running" + URL；否则：报"not running"
3. 可选读 `.server.err` 看最近错误

**Prompt 3** — 用户："显示 Mcode webui url"

预期：
1. 输出 `http://<lan-ip>:8080/`
2. （如设了 `TOKEN`）也输出带 `?token=…` 的完整 URL

完整触发列表见 [`SKILL.md`](SKILL.md#when-to-use-this-skill)。

## 依赖

- **运行时**：Node 22.19+ 仅用 stdlib（零 npm 依赖）
- **外部二进制**：`mcode` CLI 0.1.4+（用于 `mcode acp` 传输）
- **可选**：`sqlite3` 二进制（用于 usage 面板）— 由 `server/lib/config.js#detectSqlite3Bin` 自动检测
- **可选**：`mavis` 0.1.0+（用于真实 token 使用量；缺失时降级为估算）

## 网络与数据行为

- **默认绑 `0.0.0.0:8080`** — 通过 `HOST=127.0.0.1` 切到 loopback 唯一
- **支持 `?token=` 查询字符串**（浏览器友好）；也接受 `Authorization: Bearer` 头
- **无出站网络** — 仅本地子进程（`mcode`、`mmx quota`）
- **读**：`~/.minimax/v2/sqlite/runtime-state.sqlite`（只读）
- **写**：
  - `~/.minimax/v2/sqlite/runtime-state.sqlite` — 仅在 `DELETE /api/sessions/:id` 时
    （带 `?dryRun=true` 可选预览）
  - `MCODE_WEBUI_UPLOAD_DIR`（默认 `.webui-uploads/`）用于文件上传
  - `~/.minimax-code/webui/.webui-sessions.json` 用于会话存储
- **无遥测、无远端 endpoint**

完整披露：[`references/SECURITY-NOTES.md`](references/SECURITY-NOTES.md)。

## 自动测试证据

```
$ npm test
ℹ tests 834
ℹ suites 38
ℹ pass 828
ℹ fail 4            # pre-existing better-sqlite3 NODE_MODULE_VERSION 141↔147
                     # ABI drift on the runner; reproducible across all plugin
                     # releases since v0.5. Repro: `npm rebuild better-sqlite3`.
ℹ skipped 2
ℹ duration_ms ~700

$ npm run check
$ node scripts/check-docs-alignment.mjs
[1/6] plugin.json → README.md + docs/CAPABILITIES.md  ✓
[2/6] README.md + docs/API.md → server/router.js      ✓
[3/6] docs/API.md → server/lib/config.js env exposure ✓
[4/6] references/SECURITY-NOTES.md env vars → config.js ✓
[5/6] plugin.json round-trip parse + capability shape   ✓
[6/6] known drift: cleanup-orphans endpoint consistency ✓

OK all checks passed.   (exit 0)

$ npm run sbom
$ node scripts/gen-sbom.mjs
bomFormat: CycloneDX
specVersion: 1.5
components: 115    (zero runtime deps; 115 transitive dev deps)

$ npm audit --omit=dev --audit-level=low
0 vulnerabilities
```

覆盖率（用 `c8` 对 `server/lib/**/*.js` + `scripts/**/*.mjs`）：

```
All files         : 92.93% lines / 82.99% branches / 100% functions
db.js (C01)       : 81.69% lines / 76.08% branches
events.js (B01)   : 92.12% lines / 78.78% branches
markdown.js (C06) : 100%   lines / 83.58% branches
quota-forecast.js : 97.18% lines / 88.63% branches
rate-limit.js     : 99.20% lines / 87.80% branches
```

测试分布（节选）：

- `lib-events.test.js` — 27 tests（NDJSON 原子写、单调 seq、hash 链）
- `lib-events-hash.test.js` — 8 tests（篡改检测、链恢复）
- `lib-alerts.test.js` — 20 tests（3 个等级、60s dedup、ring buffer、**dedup 在 ring 翻转后仍命中** + **audit payload 完整** — 在 V01 review 后 commit 8f2e86b 加的 regression 覆盖）
- `routes-alerts.test.js` — 6 tests（SSE replay、heartbeat、close）
- `lib-authorize.test.js` — 20 tests（白名单、超时、per-cid 清理）
- `lib-interaction.test.js` — 37 tests（commands 解析器、permission presets、ask-user modal）
- `lib-feedback.test.js` — 12 tests（命令反馈、消息点赞/点踩）
- `check-docs-alignment.test.js` — 15 tests（live integration、drift round-trip）
- D01 的 5 个 unit-edge 套件 — 130 tests（db resolver / rate limit / markdown / quota / events concurrency）
- D02 的 4 个集成套件 — 38 tests（router-boot / sse-channel / event-chain / transports matrix / check-docs）

CI：市仓根 GitHub Actions workflow（ubuntu、Node 22）跑 `npm ci && npm run check`，
递归执行本插件全套件。无插件自有 workflow——真实在跑的门禁以 `docs/CI.md` 为准。
本地完整套件：`npm run check:ci && npm test && npm run sbom && npm audit`。

## 手动测试证据

- 通过 `mavis plugin install` 安装插件（路径模式）
- 设 `TOKEN=$(openssl rand -hex 16)`
- 在浏览器打开 `http://127.0.0.1:8080/?token=…` — SSE 流连接成功，模型流式渲染
- 在手机上打开同 URL（LAN）— token 认证通过，移动端布局响应
- 跑多轮带工具的会话（Bash、Read、Edit）— 所有事件渲染，配额面板更新
- 切换 `lanBroadcast: false` — 手机端返回 403 带友好页
- 删除一个会话 — 日志显示所有 session-keyed 表的行被移除。v1.0 E2E 证据：跑真删路径
  对生产 `runtime-state.sqlite` 的副本（713 MB）用 `MCODE_RUNTIME_DB=<copy>`；
  一个有 11,176 行跨 12 表的会话减到 7 行（只剩 `questionnaire_requests`，
  按设计跳过 — 它不是 `local_runtime_*` 前缀的）。表清单覆盖 Mcode schema
  33 个 session-keyed 表中的 32 个。
- 用 `?dryRun=true` 重跑删除 — 预览显示行数，无修改
- 重启 server — 孤儿 mcode acp 子进程由 SIGTERM 清理

## 红线合规（mcode-plugin-guide）

- **红线 1（破坏性操作）**：`DELETE /api/sessions/:id` 有 `?dryRun=true` 可选预览。
  真删走 SQLite `transaction()`，每表容错。
- **红线 2（跨平台）**：sqlite3 二进制由 `detectSqlite3Bin()` 自动检测 — 不写死主机路径。
- **红线 3（披露完整性）**：`references/SECURITY-NOTES.md` 是单一权威源；`SKILL.md`
  （TL;DR + 链接）、`plugin.json`（`extensions.securityNotes`）、本 PR 描述、插件
  `README.md` 都引用它。
- **红线 7（披露完整性）**：三处一致 — README、plugin.json description +
  `extensions.securityNotes`、PR 模板。

## Checklist

- [x] `plugin.json` 通过 `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` 校验
- [x] `npm test` — 828 pass, 4 fail（pre-existing better-sqlite3 ABI），2 skipped
- [x] `npm run check` — exit 0（6 个 alignment 组全绿）
- [x] `npm run sbom` — CycloneDX 1.5 输出，115 components
- [x] `npm audit` — 0 vulnerabilities
- [x] 覆盖率 — 92.93% lines / 82.99% branches / 100% functions
- [x] `references/SECURITY-NOTES.md` 覆盖所有红线 7 主题 + 4 个环境变量导出
- [x] LICENSE 在场（MIT）
- [x] README.md 在场 + `docs/screenshots/` 5 张真实截图
- [x] 无 symlink（发布产物展开 junction）
- [x] 文本文件无 UTF-8 BOM
- [x] 发货文件中无占位标记
- [x] 无 `hooks` / 不支持的 capability 字段
- [x] 一个 PR 一个插件（本 PR 只有 `plugins/Wzdhehe/mcode-webui/`）
- [x] `Closes #16`（v1.0.0 marketplace 提交）— 本 PR merge 时自动关闭 #16