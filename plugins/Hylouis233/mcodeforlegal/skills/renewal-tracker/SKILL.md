---
name: renewal-tracker
description: >-
  续期登记簿维护技能（库技能，由审查技能在收尾步骤调用，不直接面向用户）。
  合同审查发现自动续期、期限、提前通知解除等时间敏感条款时，把关键日期写入
  contracts/renewal-register.yaml 登记簿：先读后写、不覆盖历史条目、id 自增，
  保证 renewal-watcher 监控 agent 有唯一、干净的数据源。同义场景词：续期登记、
  到期登记、自动续期跟踪、合同期限管理、续约提醒登记、renewal register。
user-invocable: false
metadata:
  legal_frame: cn-mainland
  last_reviewed: '2026-08-18'
---

# 续期登记簿维护（renewal-tracker）

## 目的

合同里最贵的一条往往不是写出来的条款，而是**没人记得的日期**：自动续期前
不通知就被续一年、提前解除窗口错过就要再等一年。本技能把审查过程中发现的
时间敏感条款统一登记到 `contracts/renewal-register.yaml`，供
`renewal-watcher` agent 定期扫描、分级提醒。

登记纪律三条（与 legal-core `matter-workspace` 的台账纪律同源）：

1. **先读后写**：写入前必须完整读取现有登记簿，确认不重复、不冲突；
2. **不覆盖历史条目**：已登记条目只可追加 `status` 变化（如 active →
   renewed / closed）或补充 notes，不删除、不改写原始字段——历史留痕；
3. **id 自增不复用**：新条目 id = 现有最大 id + 1，已注销条目的 id 也不
   回收。

## 前置检查

- 调用方（nda-review / sales-contract-review / contract-review 通用规程）已完成审查，
  且确认合同中**确实存在**自动续期、期限或提前通知解除条款；不登记没有
  日期抓手（到期日、通知期、期限）的合同。
- 用户已被告知并同意登记（一句提示即可：「这份合同有自动续期条款，我把
  关键日期登记一下？」）；用户不同意的，在 memo FYI 区记录「未登记，用户
  决定」，不擅自登记。
- 关键日期能从文本中明确读出；读不出具体日期的（如「续期前合理时间内
  通知」），登记时在 notes 写明「日期不确定，条款原文：……」，不得编造
  日期（G2：不静默补充）。

## 操作规程

### 第 1 步：读取现有登记簿

- 打开 `contracts/renewal-register.yaml`；文件不存在的，新建并写入文件头
  注释与 `entries: []`。
- 检查同一合同（按 counterparty + contract 名称判断）是否已有 active 条目：
  - 已有且本次是复审/修订：不新增条目，更新原条目的 cancel_by 等日期字段，
    并在 notes 追加一行「YYYY-MM-DD 修订更新」；
  - 已有且原合同已终止/重签：原条目 status 改为 `superseded`，另起新条目。

### 第 2 步：构造新条目

按 schema（见下）逐字段填：

- `counterparty`、`contract`：用合同原文名称，不简写、不意译；
- `cancel_by`：**最迟行动日**。自动续期场景 = 到期日 − notice_period_days，
  再按合同约定的通知方式留缓冲；文本没给依据的缓冲不编造，直接写
  「到期日 − 通知期」并在 notes 说明计算方式；
- `notice_period_days`：合同约定的提前通知天数；约定不明的填 null 并在
  notes 写明；
- `annual_value`：年度金额（元）；合同无明确金额的填 null，不估算；
- `status`：新登记一律 `active`；
- `notes`：条款位置（第 X 条）、通知方式要求（书面/EMS/邮件）、日期不
  确定之处；
- `source`：指向本次审查 memo 或 matter 路径；
- `registered_at`：登记日期（YYYY-MM-DD，以 `date` 命令取真实日期，不凭
  记忆猜）。

### 第 3 步：写入并回执

- 追加到 `entries:` 末尾，保持 YAML 格式与既有条目一致（两个空格缩进、
  日期加引号）；
- 写完后向调用方回执一行：「已登记 #id：<counterparty>，cancel_by
  <日期>」；调用方把这一行写进 memo 的「下一步」区。

### 第 4 步：状态维护（被 watcher 提示后或后续审查调用时）

- 合同已发出不续约通知：status → `notice_sent`，notes 注明发送日期与方式；
- 已续约：status → `renewed`，notes 注明新期限；
- 已解除/到期不再续：status → `closed`；
- 任何状态变化只追加、不改历史（纪律 2）。

### 第 5 步：写入后自检

- 重新读取登记簿，确认：YAML 可解析；新条目 id 唯一且为最大值；日期字段
  格式为带引号的 YYYY-MM-DD；status 为枚举值之一。
- 自检不通过的，立即修复并重新自检；不得把带格式错误的登记簿交给
  watcher——格式错误会让监控静默失效，比不登记更危险。

## Schema 与示例

```yaml
# contracts/renewal-register.yaml
# 合同续期/期限登记簿。由 renewal-tracker 维护，renewal-watcher 定期扫描。
# 维护纪律：先读后写；不覆盖历史条目（仅追加状态变化）；id 自增不复用。
entries:
  - id: 1
    counterparty: 某科技有限公司
    contract: 软件服务框架协议
    cancel_by: '2026-12-02'        # 最迟行动日：到期日 2027-01-31 减 60 天通知期
    notice_period_days: 60
    annual_value: 480000           # 年度金额（元），无明确金额填 null
    status: active                 # active / notice_sent / renewed / closed / superseded
    notes: 第 9.2 条自动续期条款；不续约须书面通知，EMS 留痕；cancel_by 按"到期日-通知期"计算
    source: matters/ruanjian-fuwu/drafts/review-memo-v1.md
    registered_at: '2026-08-18'
  - id: 2
    counterparty: 某供应链管理有限公司
    contract: 仓储服务合同
    cancel_by: '2026-11-15'
    notice_period_days: 45
    annual_value: null             # 按实际结算，无固定年费
    status: active
    notes: 第 7 条；通知方式约定不明，已在 memo 标记项 #3 建议修订
    source: matters/cangchu-fuwu/drafts/review-memo-v1.md
    registered_at: '2026-08-18'
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | 整数 | 自增，不复用 |
| counterparty | 字符串 | 相对方全称（合同原文） |
| contract | 字符串 | 合同名称（合同原文） |
| cancel_by | 日期 | 最迟行动日（YYYY-MM-DD，加引号） |
| notice_period_days | 整数或 null | 约定提前通知天数 |
| annual_value | 数字或 null | 年度金额（元），不确定填 null |
| status | 枚举 | active / notice_sent / renewed / closed / superseded |
| notes | 字符串 | 条款位置、通知方式、不确定事项 |
| source | 字符串 | 来源 memo 或 matter 路径 |
| registered_at | 日期 | 登记日期 |

## 边界情形处理

1. **同一合同多个时间抓手**：既有质保期、又有合作期限、还有自动续期的，
   按「最早需要行动的日期」只登记一条，notes 列明其余日期，避免 watcher
   对同一合同重复报警；后续日期成为「最近行动日」时，经状态维护更新
   cancel_by 并在 notes 追加说明。
2. **多年期合同无自动续期**：只有固定到期日、无提前通知要求的，仍可登记
   （cancel_by = 到期日，notice_period_days 填 0 并在 notes 写明「到期即
   终止，无通知期」），以便 watcher 提醒到期重签。
3. **解除窗口类条款**（如「每年 X 月前可书面提出终止」）：cancel_by 取
   最近一个窗口关闭日，notes 写明窗口的周期性；本条状态维护频率高于普通
   条目。
4. **日期依赖第三方行为的**（如「以甲方验收合格日为起算」）：cancel_by
   填 null——watcher 会列入「数据异常」节提醒人工跟进；notes 写明触发
   条件与条款原文。这比编造一个日期安全（G2）。
5. **框架合同 + 订单**：框架合同登记一条；单个订单的交付/账期日期不进本
   登记簿（那是履约管理，量大且短周期），需要跟踪的订单级日期建议记入
   matters/<slug>/intake.md 的时效提醒节。
6. **相对方更名/主体变更**：不新建条目；在 notes 追加「YYYY-MM-DD 相对方
   更名为 XX」，保持历史可追溯（纪律 2）。

## 状态流转

```text
active ──(发出不续约通知)──→ notice_sent ──(到期终止确认)──→ closed
   │                           │
   │                           └──(对方回应后续约)──→ renewed
   ├──(协商续约)──────────────→ renewed
   ├──(到期自然终止)──────────→ closed
   └──(合同被新合同替代)──────→ superseded
```

- 只有 `active` 进入 watcher 的倒计时分级；`notice_sent` 列入 watcher 的
  「已闭环」简表，提示用户在到期后确认终止生效并改为 `closed`。
- `renewed` / `closed` / `superseded` 不再报警，仅留痕。

## 输出模板

本技能不产出面向用户的文件；向调用方的回执格式：

```text
[renewal-tracker] 已登记 #<id>：<counterparty>《<contract>》，
cancel_by <YYYY-MM-DD>（通知期 <N> 天）。
```

## 本技能不做什么

- 不做续期决策（续不续是业务与法务的决定，本技能只记日期）。
- 不估算缺失的金额或日期（填 null + notes 说明，不编造）。
- 不删除或改写历史条目（状态变化只追加）。
- 不直接提醒用户到期（那是 renewal-watcher 的职责；本技能只维护数据）。
- 不登记没有时间敏感条款的合同。
- 不修改 watcher 已出具的报告（报告是 watcher 的产物；发现报告与登记簿
  不一致时，修正登记簿或提示重跑 watcher，不改报告文件）。

## 收尾与下一步

1. 登记回执交给调用方写入 memo 的「下一步」区。
2. 提示用户：`renewal-watcher` 会按登记簿定期扫描并出分级提醒报告
   （reports/renewal/ 目录）。
3. 合同后续修订、解除、续约时，由新的审查流程再次调用本技能做状态维护；
   事项层面的日期同时建议在 `matters/<slug>/intake.md` 的时效提醒节登记。
4. 登记簿文件建议纳入工作区的版本管理（如 git）：变更历史即审计线索。
