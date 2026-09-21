---
title = "ANTI-PATTERNS-FIX-PLAN: mcode-webui 11 条反面模式修复总计划"
status = "DRAFT"
author = "Worker 子代理 (Lease A03)"
date = "2026-09-20"
session_id = "mvs_0a811f9d7a894e9ebe6ee7f4da3c788a"
lease = "A03"
upstream_inputs = [
    "docs/REVIEW-sihankor-baselines-2026-08-28.md",
    "docs/BORROW-dsh-deepseek-harness-2026-08-28.md",
]
target_fork = "/Users/moc/workspaces/MiniMax-Code-Plugins/plugins/Wzdhehe/mcode-webui/"
---

# ANTI-PATTERNS-FIX-PLAN: mcode-webui 11 条反面模式修复总计划

> **范畴**：列出 mcode-webui v1.0.0 现存的 11 条反面模式，每条给出当前代码位、影响、修复路径（指 Lease B01-B05 / C01-C08）、验收动作。
> **输入**：`REVIEW-sihankor-baselines-2026-08-28.md` + `BORROW-dsh-deepseek-harness-2026-08-28.md` + 当前源码 grep 验证。
> **不范畴**：具体代码改动（归批次 B/C 各 lease）；哲学命题（不写）。
> **继承**：批次 A 的 A01（通用 harness 借鉴）/ A02（数学骨架）独立，本文件不引用其内容。

---

## 1. 总览表

| # | 反面模式 | 当前代码位 | 影响 | 修复路径 | 验收动作 |
|---|---|---|---|---|---|
| 1 | token stdout 14 行 ASCII box 泄漏 | `server.js:55-67` | 安全 + 用户层 | **C08** | grep codebase 找不到 token stdout box；modal 出现 |
| 2 | settings.json 全文件覆盖、无 diff / hash 链 | `server/lib/settings.js:205-212` | 可验证性 | **B01** | `cat events.ndjson` 能查到 `settings.write`；改第二行 hash 报警 |
| 3 | 错误混 chat 流（`! [error]`） | `server/routes/chat.js:141` | 用户层 | **B02** | 触发 mcode 子进程 crash，bell 响 + chat 行仅作次级标记 |
| 4 | pushStateFor 每秒广播全 state | `server/lib/state-bus.js:192-279` + `server/routes/chat.js:51,146` | 可维护性 + 性能 | **C04** | 10k 消息不卡；SSE 频率受限（60Hz `requestAnimationFrame` 合并） |
| 5 | 无 anomaly 信号通道 | `server/routes/chat.js:172,177`（仅 `console.warn`） | 用户层 | **B02** | `/api/alerts` SSE 端点存在；前端 bell icon + 未读数显示 |
| 6 | runStartupCleanup 删 mcode session 无确认 | `server/cleanup.js:8-14` + `server.js:39` | 安全 + 用户层 | **B03** + **C08** | 启动不删；UI 弹"清理 N 个孤儿会话"确认 + `kind:"auth.declined"` 落痕 |
| 7 | db.js better-sqlite3 path 写死 | `server/lib/db.js:27-91`（多候选硬编码） | 可移植性 + 可维护性 | **C01** | 干净 checkout 跑通；`npm test` 5 个 fail 归零；新装布局走探测链 |
| 8 | capabilities 裸字符串（plugin.json 无 description） | `plugin.json:80-94`（13 条裸字符串） | 可发现性 | **B05** | `npm run check` 通过；每个 capability 含 description |
| 9 | README 无截图 | `README.md` / `README.zh-CN.md`（无 `![]` 语法） | 可发现性 + 用户层 | **B05** | README 含 5 张截图（startup / token modal / chat / tool call / session switch） |
| 10 | LLM 直接触发 /delete 类治理 slash 命令 | `server/lib/slash.js:100-136,233-247`（`/clear`/`/new` 无 UI gate） | 安全 + 可治理性 | **B03** + **B04** | 触发 `/clear` UI 弹确认；不点 = 不清 + `kind:"auth.declined"` 落痕 |
| 11 | v1.0.1 文档写新增 API 但代码无 export | `docs/API.md:179-205`（`POST /api/sessions/cleanup-orphans`）+ `server/routes/sessions.js:4` 注释删除 | 可验证性 + 可发现性 | **B05** | `npm run check` 文档对齐通过；router.js + API.md 双跑对表零差异 |

---

## 2. 各条详情

### AP1. token stdout 14 行 ASCII box 泄漏

**反面模式**：`server.js` 启动时若首次生成 token（settings.json 不存在且无 `TOKEN` env），打印 14 行 ASCII 框到 stdout，含明文 token 与 LAN URL。stdout 会进 shell history / Docker log / systemd journal / screen share。

**当前代码位**（`grep -nE "webui 首次启动|console.log.*token" server.js`）：
```
58:    console.log('  webui 首次启动 — 已生成新的鉴权 token')
60:    console.log(`  token:   ${token}`)
63:    console.log(`  提示: token 已持久化到 ${getPersistPath()}`)
64:    console.log('         远程设备必须通过该 URL (含 ?token=) 访问')
65:    console.log('         本机访问 (127.0.0.1) 无需 token')
```
外加 `57:console.log('==============================================================')`、`59`、`62`、`66`、`67` 共 10 条 `console.log` 行构成 ASCII 框（含首尾两条分割线 + token 行 + URL 行）。

**影响**：**安全 + 用户层**。明文 token 离开受控文件落地，shell history 持久化、容器日志归档、screen share 录屏都会泄漏。

**修复路径**：**Lease C08**（token onboarding 模态化）。把首次 token 改成 modal 显示（`?onboarding=1` 触发），要求用户点"我已保存"才关 + POST `/api/settings` 设 `tokenAcknowledged: true`。stdout 改成单行 `console.log("token persisted to: <path>")`，token 不再打印明文。

**验收动作**：
- `grep -nE "token:.*\\${token}|webui 首次启动" server.js public/app/main.js` 期望无 stdout box 残留。
- 首次启动：UI 弹 modal → 含 copy-to-clipboard 按钮 + LAN URL + "I have saved this token" 必点。
- 手工验证：模拟 `rm ~/.mcode-webui/settings.json && node server.js` → 仅一行 `token persisted to: …`，不出现 14 行 box。

---

### AP2. settings.json 全文件覆盖、无 diff / hash 链

**反面模式**：`server/lib/settings.js#persistNow` 每次 setter 调用都 `JSON.stringify(buildPersistBody())` 全量写盘，无 `before_hash` / `after_hash`、无 `prev_after_hash`、无差分记录。并发 `POST /api/settings` 会 race（最后写赢，丢失中间态）。

**当前代码位**（`grep -nE "writeAtomic|persistNow|JSON.stringify\(buildPersistBody" server/lib/settings.js`）：
```
139:function writeAtomic(path, content) {
205:function persistNow() {
207:    writeAtomic(_settingsPath(), JSON.stringify(buildPersistBody(), null, 2));
499:  try { persistNow(); } catch (e) { /* logged in persistNow */ }
508:  try { persistNow(); } catch {}
513:  try { persistNow(); } catch {}
537:  try { persistNow(); } catch {}
554:  try { persistNow(); } catch {}
573:  // module-level state until persistNow() returns without throwing.
584:    persistNow();
```
注意：`writeAtomic` 是 .tmp + rename 原子写（避免半写），但**不**是事件流；7 处 setter 都直接调 `persistNow()`，无任何审计落痕。

**影响**：**可验证性**。SiHankor 工程基线第 4 条（可验证性：traceable / checkable / tamper-proof）+ 禁条第 4 条（治理操作必须写事件流）双违反。运维审计时无 diff / 无 hash 链，无法判定谁改了哪些字段。

**修复路径**：**Lease B01**（append-only NDJSON 事件流 + 哈希链）。在 settings.js 的 7 处 `persistNow()` 之前 patch 进 `events.append({kind: "settings.write", target, before_hash, after_hash, data})`。事件流 schema 详见 `BORROW-dsh-deepseek-harness-2026-08-28.md §2`。

**验收动作**：
- `cat ~/.mcode-webui/events.ndjson | jq 'select(.kind=="settings.write")'` 能查到所有 7 个 setter 的写事件。
- 改第二行 `after_hash` 跑 `verify-hash` 报警（chain 断裂）。
- 并发 5 个 `POST /api/settings` 跑 50 次：`cat events.ndjson | wc -l` 等于 250 ±5（不丢写、不覆盖）。

---

### AP3. 错误混 chat 流（`! [error]`）

**反面模式**：mcode 子进程出错 / 协议错时，`server/routes/chat.js:141` 把错误以 `! [error] ${msg}` 行追加进 `cs.chat`（用户可见聊天流），与正常 ● / › 行混在一起。用户得扫整段对话找错误。

**当前代码位**（`grep -nE "! \[error\]|\[error\]" server/routes/chat.js`）：
```
141:    cs.chat = [...cs.chat, `! [error] ${oneLine}${hint}`];
142:    cs.context.assistantLast = `[error] ${oneLine}`;
```

**影响**：**用户层**。错误不显眼，长会话里被淹没；与正常消息难以区分；用户感知失败延迟。

**修复路径**：**Lease B02**（独立 anomaly 通道）。`server/lib/alerts.js` + `/api/alerts` SSE 通道 + 前端 bell icon + 未读数。chat 行降级为"次级标记"（仅当对应 alert 仍 live 时高亮）。

**验收动作**：
- 触发 mcode 子进程 crash：bell 响 + 未读数 +1；chat 行存在但仅作 reference。
- `events.ndjson` 能查到 `kind:"subprocess.exit"` 与 `kind:"alert.pushed"`。
- `grep -nE "! \[error\]" server/routes/chat.js` 期望只剩注释 / 引用，chat.js 不再直接 append。

---

### AP4. pushStateFor 每秒广播全 state

**反面模式**：`pushStateFor(cid)` 每次 chat turn / token rotate / session switch / settings 改都发整包 state（含 sessions 列表 / mcode sessions / token / 配额等 ~20 字段）。长会话（10k+ 消息）每秒发 1-2 次，每次几 KB。SSE 通道成带宽瓶颈，前端每帧 parse + 整包 replace state。

**当前代码位**（`grep -nE "pushStateFor" server/routes/chat.js server/lib/state-bus.js`）：
```
server/routes/chat.js:12:import { pushStateFor, getActiveChild } from "../lib/state-bus.js";
server/routes/chat.js:51:    pushStateFor(cid);
server/routes/chat.js:146:  pushStateFor(cid);
server/lib/state-bus.js:121:// pushStateFor: 推 state 给指定 cid（或 '__broadcast__' 推给所有）
server/lib/state-bus.js:192:export function pushStateFor(cid, opts = {}) {
server/lib/state-bus.js:318:      //   see pushStateFor above. pushOnlineCount fires on every SSE
```
`pushStateFor` 在 state-bus.js:192-279 把整包 snapshot 序列化后 `res.write(\`data: ${JSON.stringify(snapshot)}\\n\\n\`)`，无 diff、无 batching、无 60Hz 合并。

**影响**：**可维护性 + 性能**。长会话跑 10k 消息时 SSE 频率失控；前端每帧 parse JSON 触发 layout。

**修复路径**：**Lease C04**（聊天列表虚拟化 + SSE 批处理）。
- 前端虚拟列表（仅渲染可见行）
- SSE 60Hz `requestAnimationFrame` 合并
- 可选：服务端 state diff（仅推变更字段，更大重构）

**验收动作**：
- 跑 10k 消息会话：浏览器 DevTools Network/SSE 频率 ≤ 60Hz；滚动 FPS ≥ 55。
- `grep -nE "JSON.stringify\(snapshot\)" server/lib/state-bus.js` 期望 `pushStateFor` 不再全量序列化（要么 diff，要么用 `JSON.stringify(diffFields)`）。
- `npm test` 包含 `test/lib-state-bus.test.js` 全绿。

---

### AP5. 无 anomaly 信号通道

**反面模式**：所有 user-facing 错误（mcode 子进程 crash、token 过期、sqlite 失败、协议不支持）只走 `console.warn`（stderr）。stderr 不进 UI。用户看不到任何 system-level 信号。

**当前代码位**（`grep -nE "console\.warn" server/routes/chat.js`）：
```
172:        console.warn(
177:      console.warn(`[stop] session/cancel threw cid=${cid}: ${e.message}`);
```
仅 2 处 stderr 输出。**无 `/api/alerts` 端点**（grep `router.js` 全路由表无 alerts）：
```
$ grep "alerts" server/router.js
（空输出）
```

**影响**：**用户层**。System-level 信号不显眼；用户得去终端 / docker log 看 stderr；SIEM 接入无 hook。

**修复路径**：**Lease B02**（独立 anomaly 通道）。新增 `server/lib/alerts.js` + `/api/alerts` SSE 端点 + 前端 bell icon + 未读数；替换 `console.warn` 为 `pushAlert({level, msg, src})`。

**验收动作**：
- `grep -nE "/api/alerts" server/router.js` 期望命中 1 处（GET SSE 端点）。
- 触发 mcode 子进程 crash：bell 响；未读数 +1；点开看历史 toast。
- `events.ndjson` 能查到 `kind:"alert.pushed"` 与 `level` 字段。

---

### AP6. runStartupCleanup 删 mcode session 无确认

**反面模式**：`server.js:39 runStartupCleanup()` 在每次启动时调 `cleanupEmptyDefaultSessions()`（默认名 session / 24h+ 未用直接 DELETE sqlite）。无用户确认、无 dryRun、无事件落痕（除 mcode 内部 sqlite 删除本身）。

**当前代码位**（`grep -nE "runStartupCleanup|cleanupEmptyDefaultSessions" server/cleanup.js server.js`）：
```
server/cleanup.js:4:import { cleanupEmptyDefaultSessions } from "./lib/sessions.js";
server/cleanup.js:8:export function runStartupCleanup() {
server/cleanup.js:9:  cleanupEmptyDefaultSessions();
server.js:24:import { runStartupCleanup } from './server/cleanup.js'
server.js:39:runStartupCleanup()
```

**影响**：**安全 + 用户层**。误删 / 误启动都可能清空用户未备份的会话；与 `deleteMcodeSessionFromDb` 的 dryRun 语义不一致（DB 删除可预览，启动清理不能）。

**修复路径**：**Lease B03**（per-request authorize）+ **Lease C08**（token onboarding 模态化借用 modal 机制）。
- 启动时改为 dryRun：算出"将删 N 个孤儿会话 / 共 M 行"，写 `events.ndjson` 一行 `kind:"cleanup.dry_run"`，**不真删**。
- 真删走 authorize 流程：UI 启动 banner 提示"发现 N 个孤儿会话，是否清理？" + 5 分钟默认超时 + 确认才落 `kind:"cleanup.commit"` + 落 sqlite。
- 不点 / 超时：`kind:"auth.declined"` 落痕 + 会话保留。

**验收动作**：
- 模拟有 3 个默认名孤儿 session 的 mcode db：启动 server → UI banner 提示 → 不点 = `events.ndjson` 查到 `kind:"auth.declined"`，sqlite 会话保留；点 = 查到 `kind:"cleanup.commit"` + `kind:"auth.approved"` + sqlite 会话消失。
- `grep -nE "cleanupEmptyDefaultSessions\(\)" server/cleanup.js` 期望改为 dryRun 形态。

---

### AP7. db.js better-sqlite3 path 写死

**反面模式**：`server/lib/db.js#_getBetterSqlite3Candidates` 用 4 个候选路径：env > mcode cmd relative > home layout > dev layout fallback。前 3 个为硬编码字符串拼接；不同 install layout 漏选仍 fatal。环境变量 `MCODE_BETTER_SQLITE3` 只能整体覆盖，不能"加一个候选"。

**当前代码位**（`grep -nE "better-sqlite3|MCODE_RUNTIME_DB" server/lib/db.js`）：
```
27://   2. <MCODE_CMD>/../../node_modules/@minimax-ai/code/node_modules/better-sqlite3
29://   3. <__dirname>/../../../node_modules/@minimax-ai/code/node_modules/better-sqlite3
63:        "better-sqlite3",
70:        "better-sqlite3",
82:        "better-sqlite3",
91:        "better-sqlite3",
```
路径构造全在 `_getBetterSqlite3Candidates()` 函数内（line 36-95）。

**影响**：**可移植性 + 可维护性**。round 5/6 修了多候选探测（review doc 提到），但仍是硬编码字符串。npm-global mcode / Linux 扁平 layout / Windows 包管理器 layout 仍可能漏。

**修复路径**：**Lease C01**（db.js path resolver 修）。引入 `~/.minimax-code/webui/db-resolver.json` 用户配置（候选路径数组 + 探测函数），server 启动读一次，无配置走探测链。测试夹具覆盖 npm-global / 扁平 layout / 干净 checkout 三种。

**验收动作**：
- 干净 checkout（无 `<home>/.minimax-code/lib/node_modules/...`、无 mcode cmd）：`npm test` 全绿（5 个 fail 归零）。
- 用户自定义 resolver json 指向全局 better-sqlite3：启动不报 `better_sqlite3_not_loaded`。
- `grep -nE "join\([^,]+,\s*['\"]better-sqlite3['\"]\)" server/lib/db.js` 期望只剩 1-2 处（探测链骨架），其余走 resolver。

---

### AP8. capabilities 裸字符串（plugin.json 无 description）

**反面模式**：`plugin.json#extensions.capabilities` 是 13 条裸字符串（`"chat-streaming"` / `"tool-execution"` 等），无 `description` 字段。registry viewer / IDE 自动补全 / 搜索都看不出 capability 是干什么的。

**当前代码位**（`grep -nE "\"capabilities\"|chat-streaming" plugin.json`）：
```
80:    "capabilities": [
81:      "chat-streaming",
```
13 条全部为裸字符串（line 81-93）：
```
"chat-streaming", "tool-execution", "plan-mode", "ask-user-tool",
"permission-prompts", "workspace-switching", "session-management",
"file-attachments", "quota-usage", "bilingual-ui", "lan-sharing",
"token-auth", "mobile-responsive"
```

**影响**：**可发现性**。SiHankor 工程基线第 7 条（可发现性：capabilities 元数据）违反。registry viewer 与其他 plugin 对比时无法判断功能。

**修复路径**：**Lease B05**（plugin.json 元数据 + CI 校验）。把裸字符串改为 `{name, description}` 对象；新增 `scripts/check-docs-alignment.mjs` CI 校验（plugin.json round-trip + capabilities 必有 description）。

**验收动作**：
- `npm run check` 通过（plugin.json round-trip parse + capabilities 校验）。
- `jq '.extensions.capabilities[0]' plugin.json` 期望输出 `{name, description}` 对象，含 description 字段。
- `grep -c "\"chat-streaming\"" plugin.json` 期望为 0（改为对象后字符串消失）。

---

### AP9. README 无截图

**反面模式**：`README.md` / `README.zh-CN.md` 没有任何 `![...](...)` 语法，纯文本 + 表格。用户安装前看不到 UI 长什么样。

**当前代码位**（`grep -nE "!\[" README.md README.zh-CN.md`）：
```
（空输出）
```
README.zh-CN.md 同理（同步未截）。

**影响**：**可发现性 + 用户层**。GitHub / registry 渲染无 preview；用户判断"是否值得装"全凭描述。

**修复路径**：**Lease B05**（plugin.json 元数据 + CI 校验，同批次）。新增 `docs/screenshots/` 目录 + 5 张截图（startup / token modal / chat / tool call / session switch），README + README.zh-CN.md 加 `![X](docs/screenshots/x.png)` 引用。

**验收动作**：
- `grep -c "!\[" README.md README.zh-CN.md` 期望 ≥ 5（每文件）。
- `ls docs/screenshots/*.png` 期望 ≥ 5 个文件（占位 / 真实截图均可，CI 校验存在性）。
- GitHub 渲染 README 时能看到图片。

---

### AP10. LLM 直接触发 /delete 类治理 slash 命令

**反面模式**：`server/lib/slash.js` 在 `handleLocalSlash(content, cs, cid)` 里处理 `/clear`（line 100）/ `/new`（line 100-136）/ `/cmd` 端 `/clear`（line 233-247）/ `/sessions` 等。这些命令从 `routes/chat.js:72 handleLocalSlash(content, cs, cid)` 调用，content 是 `/api/send` 的 `payload.content`，**任何**用户输入（含 LLM 复读的字符串 / mcode 的 output 文本若被回环）都会触发。无 UI gate、无 authorize。

**当前代码位**（`grep -nE "cmd ===|cs.chat = \[\]" server/lib/slash.js`）：
```
100:  if (cmd === "clear" || cmd === "new") {
101:    if (cmd === "new") {
116:      cs.chat = [];
119:    cs.chat = [];
181:  if (cmd === "/new") {
215:    cs.chat = [];
233:  if (cmd === "/clear") {
234:    cs.chat = [];
```
`/clear` / `/new` 直接 `cs.chat = []` + `cs.mcodeSessionId = null` + `resetContext(cs)`，无 confirm。

**影响**：**安全 + 可治理性**。SiHankor 工程基线第 4 条（可治理性：LLM 不能直接改东西）+ 禁条第 1 条（LLM must not directly modify knowledge/intent）双违反。LLM 转述或 prompt injection 攻击可借 `/clear` 清空当前会话（用户不可见恢复点）。

**修复路径**：**Lease B03**（per-request authorize）+ **Lease B04**（interaction/feedback 拆分）。
- `authorize({action: "clear-local", cid})` 在 `/clear` / `/new` 处理前调；UI 弹确认 modal。
- 不点 / 超时：`kind:"auth.declined"` 落痕 + `cs.chat` 不动。
- LLM 触发的输入（同 cid token）走 authorize 链路。

**验收动作**：
- 输入 `/clear`：UI 弹 modal"确认清空当前会话？"；不点 = 不清 + `events.ndjson` 查 `kind:"auth.declined"`。
- 点确认 = `kind:"auth.approved"` + `kind:"chat.clear"` + cs.chat = []。
- `grep -nE "cs.chat = \[\]" server/lib/slash.js` 期望在 `/clear` / `/new` 处理前多出 `await authorize(...)` 调用。

---

### AP11. v1.0.1 文档写新增 API 但代码无 export（事件流不存在的根因）

**反面模式**：`docs/API.md:179-205` 文档化 `POST /api/sessions/cleanup-orphans` 端点（含 request / response schema），但 `server/router.js` 路由表无此端点，`server/routes/sessions.js:4` 注释明确写"删 POST /api/sessions/cleanup-orphans — Wzdhehe 不要这个 UI,API 一起删"。文档与代码不同步。

**当前代码位**（`grep -n "cleanup-orphans" docs/API.md server/router.js`）：
```
docs/API.md:179:### `POST /api/sessions/cleanup-orphans`
```
（router.js 无任何匹配）

`server/routes/sessions.js:4` 注释：
```
// (v0.5.bx-33: 删 POST /api/sessions/cleanup-orphans — Wzdhehe 不要这个 UI,API 一起删)
```

**影响**：**可验证性 + 可发现性**。代码删了，文档未删；外部读者按文档调端点会 404；这种"文档说有的能力不存在"是事件流不存在（即无 anomaly / 无 audit）这一更深层问题的表征 — 治理动作删除时无事件落痕。

**修复路径**：**Lease B05**（plugin.json 元数据 + CI 校验）。新增 `scripts/check-docs-alignment.mjs`：扫描 `docs/API.md` 内的端点路径，与 `server/router.js` 路由表 diff；任何文档化但未实现的端点 CI 失败 + 提示"删除 / 实现"二选一。

**验收动作**：
- `npm run check` 跑 docs-alignment 校验：通过（要么删 API.md §`POST /api/sessions/cleanup-orphans`，要么实现路由）。
- `grep -n "cleanup-orphans" docs/API.md server/router.js` 期望只命中一处（修后）。
- CI 配置里 `docs-alignment` 与 `plugin.json round-trip` 同跑。

---

## 3. 修复路径与 Lease 总览（交叉对位）

| Anti-pattern | 主要修复 Lease | 依赖 Lease | 验收批次 |
|---|---|---|---|
| AP1 token stdout | **C08** | B05（事件流） | D02 |
| AP2 settings 全覆盖 | **B01** | A02（数学骨架） | D01 |
| AP3 错误混 chat | **B02** | B01 | D01 |
| AP4 pushStateFor 全广播 | **C04** | B02（SSE schema） | D02 |
| AP5 无 anomaly 通道 | **B02** | B01 | D01 |
| AP6 启动清理无确认 | **B03** + **C08** | B01 | D01 |
| AP7 db.js path | **C01** | 无（独立 bug） | D01 |
| AP8 capabilities 裸字符串 | **B05** | 无 | D02 |
| AP9 README 无截图 | **B05** | 无 | D02 |
| AP10 slash 治理 | **B03** + **B04** | B01 + A01 | D01 |
| AP11 文档与代码不同步 | **B05** | 无 | D02 |

---

## 4. 不范畴

- **不写** D：criteria = 11 条已穷尽 v1.0.0 review 范围内所有 plugin-scope 反面模式；host-scope（mcode 内部）反面对位见 `REVIEW-sihankor-baselines-2026-08-28.md § Part 5`。
- **不写** E：实现细节（具体 patch 代码）归各 lease；本文件只到"修复路径引用 Lease 号"为止。
- **不写** F：哲学命题（A02 数学骨架）与借鉴源（A01 通用 harness）独立，本文件不引用其具体内容。

---

## 5. 验收执行（worker 跑过的命令）

执行时间：2026-09-20（本会话）。

```
$ grep -nE "webui 首次启动|console.log.*token" server.js
58:    console.log('  webui 首次启动 — 已生成新的鉴权 token')
60:    console.log(`  token:   ${token}`)

$ grep -nE "writeAtomic|persistNow|JSON.stringify\(buildPersistBody" server/lib/settings.js
139:function writeAtomic
207:    writeAtomic(_settingsPath(), JSON.stringify(buildPersistBody(), null, 2));

$ grep -nE "! \[error\]" server/routes/chat.js
141:    cs.chat = [...cs.chat, `! [error] ${oneLine}${hint}`];

$ grep -nE "pushStateFor" server/lib/state-bus.js | head -3
121:// pushStateFor: 推 state 给指定 cid（或 '__broadcast__' 推给所有）
192:export function pushStateFor(cid, opts = {}) {

$ grep -nE "console\.warn" server/routes/chat.js
172:        console.warn(
177:      console.warn(`[stop] session/cancel threw cid=${cid}: ${e.message}`);

$ grep -nE "runStartupCleanup" server.js server/cleanup.js
server/cleanup.js:8:export function runStartupCleanup() {
server.js:39:runStartupCleanup()

$ grep -nE "better-sqlite3" server/lib/db.js | head -4
27://   2. <MCODE_CMD>/../../node_modules/@minimax-ai/code/node_modules/better-sqlite3
29://   3. <__dirname>/../../../node_modules/@minimax-ai/code/node_modules/better-sqlite3
63:        "better-sqlite3",
70:        "better-sqlite3",

$ grep -nE "\"capabilities\"|chat-streaming" plugin.json
80:    "capabilities": [
81:      "chat-streaming",

$ grep -nE "!\[" README.md README.zh-CN.md
（空输出）

$ grep -nE "cmd ===|cs.chat = \[\]" server/lib/slash.js | head -8
100:  if (cmd === "clear" || cmd === "new") {
116:      cs.chat = [];
119:    cs.chat = [];
181:  if (cmd === "/new") {
215:    cs.chat = [];
233:  if (cmd === "/clear") {
234:    cs.chat = [];

$ grep -n "cleanup-orphans" docs/API.md server/router.js
docs/API.md:179:### `POST /api/sessions/cleanup-orphans`
（router.js 无匹配）
```

全部 11 条 grep 命中，AP9 grep 失败因当前无截图（确认存在该反面模式），其余 10 条直接命中。

---

## 6. 退出条件

- **退出码 0**：11 条反面模式全部列出，每条当前代码位 grep 验证命中；修复路径引用具体 Lease 号（B01-B05 / C01 / C02 / C04 / C08）；A01/A02/A04 不被引入为本文件依赖。
- **退出码 1**：N 条 grep 失败（当前 AP9 是反向验证 —— 反面模式存在性靠"grep 无输出"证明；其余 10 条靠"有输出"证明）。
- **退出码 2**：工具异常（本会话未触发）。

---

## 变更日志

- 2026-09-20：初版（Lease A03 worker 子代理产出）。11 条反面模式 + 修复路径 + grep 验证。