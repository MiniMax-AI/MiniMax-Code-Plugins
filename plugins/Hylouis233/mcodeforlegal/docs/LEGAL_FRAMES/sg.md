---
legal_frame: sg
last_reviewed: 2026-08-19
status: baseline
---

# 新加坡法域基线（sg）

> **文件性质与使用限制**
>
> 本文件是 mcodeforlegal 插件集的新加坡法域**框架性基线**，内容为模型训练知识的结构化整理，仅供 skill 运行时定位法源、提示核验路径之用。
>
> **本文件为框架性指引，不构成对新加坡法律的意见，亦不构成任何法律意见。** 涉及新加坡法律实务的任何问题，必须经**新加坡执业律师（Singapore-qualified lawyer）**与**官方来源**（Singapore Statutes Online 等）核验后方可依赖。
>
> 编写原则：结构完整、体系性描述优先；确定性高的内容给出法例名称（如 Contracts (Rights of Third Parties) Act）；把握不准的细节一律标注「[模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]」，**绝不编造条文号**。

---

## 1. 法源体系

### 1.1 法源构成

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

1. **新加坡共和国宪法（Constitution of the Republic of Singapore）**——最高法律，确立议会制政体与基本自由（确定性高）。
2. **英国普通法传统（English common law heritage）**——新加坡承袭英国普通法与衡平法；判例有约束力，上诉法院（Court of Appeal）判例约束下级法院。英国法继受范围受本地立法界定（如 Application of English Law Act）[模型知识—待核实]，本地判例逐步发展独立体系。
3. **成文法（Acts of Parliament）**——国会制定，经修订版（Revised Edition）整合发布；近年修订版改以制定年份命名（如 Companies Act 1967）（确定性高）。
4. **附属立法（subsidiary legislation）**——部长等依成文法授权制定，效力低于成文法（确定性高）。
5. **国际条约**——须经本地立法转化方在国内直接适用（二元论倾向）[模型知识—待核实]。

实务提示：

- 检索成文法时注意区分「现行整合文本」与「尚未整合的修正文本」，Singapore Statutes Online 提供版本沿革 [模型知识—待核实]。
- 判例检索时须注意新加坡法院对部分英国判例的偏离，引用英国判例前先查本地对应判例 [模型知识—待核实]。
- 法院架构与程序规则近年有重组（如高等法院分设 Appellate Division），引用程序规则前须核验现行法院架构 [模型知识—待核实]。

### 1.2 语言

- 新加坡法律以**英文**为唯一权威工作语言：成文法、判例、法庭程序均以英文进行（确定性高）。本文件的中文概述仅作导航，任何援引必须回到英文原文。

---

## 2. 司法机构层级

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

1. **最高法院（Supreme Court）**——含**上诉法院（Court of Appeal，终审）**与**高等法院（High Court）**；高等法院近年分设 General Division 与 Appellate Division [模型知识—待核实]。
2. **国家法院（State Courts）**——审理大部分一审刑事与民事案件（确定性较高）。
3. **家事司法法院（Family Justice Courts）**[模型知识—待核实]。
4. **新加坡国际商事法庭（Singapore International Commercial Court, SICC）**——高等法院的组成部分，审理国际商事争议，允许符合条件的外国律师有限出庭，是中国企业跨境争议条款中的常见选项（确定性较高，程序细节待核实）。
5. **审裁处体系**——小额审裁处（Small Claims Tribunals）、雇佣索偿审裁处（Employment Claims Tribunals）等处理小额或专门纠纷 [模型知识—待核实]。

---

## 3. 核心部门法要点

### 3.1 合同法

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- 新加坡合同法以**普通法与衡平法**为主体（要约/承诺、对价 consideration、条款、错误、失实陈述、违约救济等源自判例），无成文合同法典（确定性高）。
- 主要成文法补充：
  - **Contracts (Rights of Third Parties) Act**——合同第三人权利（确定性高）；
  - **Unfair Contract Terms Act**——免责条款控制（名称确定性高）；
  - Misrepresentation Act、Frustrated Contracts Act、Sale of Goods Act 等——名称确定性较高，章节细节待核实。
- 消费者保护：Consumer Protection (Fair Trading) Act [模型知识—待核实]。
- 效力相关概念（体系级，细节待核实）：普通法区分 **void（无效）/ voidable（可撤销）/ unenforceable（不可强制执行）**；mistake（错误）、misrepresentation（失实陈述）、duress（胁迫）、undue influence（不当影响）、illegality（违法）各有独立教义；未成年人合同另有规则 [模型知识—待核实]。
- 与大陆差异：无「违约责任」法典化体系；损害赔偿为原则救济，实际履行（specific performance）与禁制令（injunction）为衡平法裁量救济 [模型知识—待核实]。

### 3.2 公司法

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- **Companies Act 1967**——公司法的核心成文法（确定性高）。
- 主管与登记机关：**ACRA**（Accounting and Corporate Regulatory Authority，会计与企业管理局）（确定性高）。
- 要点：最常见形式为**私人股份有限公司（private company limited by shares，"Pte Ltd"）**；至少一名通常居住于新加坡的本地董事 [模型知识—待核实]；须委任公司秘书；年度申报（annual return）与年度股东大会要求 [模型知识—待核实]。
- 公司形态细分（如豁免私人公司 exempt private company、公众公司等）影响合规义务范围 [模型知识—待核实]；外国公司可注册分公司（branch）或设子公司，两者责任与申报义务不同 [模型知识—待核实]。
- 无大陆式「认缴出资五年实缴」规则；资本维持（capital maintenance）与减资规则依普通法传统设计 [模型知识—待核实]。

### 3.3 雇佣法

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- **Employment Act**——雇佣条件的基础成文法（工时、休息日、加班、年假、病假、解雇通知等）（名称确定性高，适用范围与细节待核实）。
- 主管机关：**MOM**（Ministry of Manpower，人力部）（确定性高）。
- 适用范围有薪资与职位区分（部分条款不适用于高薪管理层等）[模型知识—待核实]。
- 不当解雇（wrongful dismissal）索偿可经 Employment Claims Tribunals 处理 [模型知识—待核实]；工会与集体协议制度受 Industrial Relations Act 规管 [模型知识—待核实]。
- 配套制度：CPF（Central Provident Fund，中央公积金）强制供款；外籍雇员受 Employment of Foreign Manpower Act 与工作准证制度约束 [模型知识—待核实]。

### 3.4 数据保护法

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- **Personal Data Protection Act 2012（PDPA）**——个人数据保护的核心成文法（确定性高）。
- 执法机关：**PDPC**（Personal Data Protection Commission，个人数据保护委员会）（确定性高）。
- 核心义务：同意（consent）、通知（notification）、目的限制、保护（protection）、保留限制、跨境转移限制、数据泄露通知（经修正引入）[模型知识—待核实]。
- 罚则：经修正引入与营业额挂钩的罚款上限 [模型知识—待核实]。
- 配套制度：Do Not Call Registry（谢绝来电登记）、business contact information 例外等 [模型知识—待核实]。
- 与大陆《个人信息保护法》差异：PDPA 采较灵活的义务进路，以「同意+例外」为主干；两法域数据合规体系不可互相套用 [模型知识—待核实]。

### 3.5 知识产权与其他高频领域（清单级）

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- 知识产权主管机关：IPOS（Intellectual Property Office of Singapore）；主要法例为 Trade Marks Act、Patents Act、Copyright Act 等（名称确定性较高，条文细节待核实）；在新加坡的注册与大陆的注册相互独立。
- 竞争法：Competition Act，主管机关 CCCS [模型知识—待核实]。
- 证券与金融监管：Securities and Futures Act，主管机关 MAS（新加坡金融管理局）[模型知识—待核实]。

---

## 4. 关键时效（Limitation）

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

- **Limitation Act**——诉讼时效的核心成文法。
- 合同与侵权诉讼：一般为诉因产生之日起 **6 年** [模型知识—待核实]；人身伤害 3 年 [模型知识—待核实]；契据（deed）12 年 [模型知识—待核实]。
- 时效可因债务人承认债务（acknowledgment）或部分清偿而重新起算 [模型知识—待核实]。
- 与大陆差异：普通时效 6 年 vs 大陆 3 年；时效为程序性抗辩，法院不主动援引 [模型知识—待核实]。

---

## 5. 与中国企业出海相关的提示

> ⚠️ [模型知识—待核实，使用前必须经 statute-verify 或当地官方法律数据库核验]

1. **仲裁地选择（SIAC）**——新加坡国际仲裁中心（Singapore International Arbitration Centre）是亚洲主要仲裁机构之一；新加坡为《承认及执行外国仲裁裁决公约》（纽约公约）缔约方，仲裁裁决跨境执行便利（确定性高）。涉中新合同常见「SIAC 仲裁 + 新加坡法/其他准据法」组合。
2. **国际仲裁与国内仲裁双轨**——International Arbitration Act（采纳 UNCITRAL 示范法）与 Arbitration Act 分别适用于国际/国内仲裁 [模型知识—待核实]。
3. **普通法管辖条款**——选择新加坡法院（含 SICC）管辖时，注意普通法下的 forum non conveniens 审查与专属管辖条款效力规则 [模型知识—待核实]。
4. **判决执行**——新加坡对外国判决的承认与执行有成文相互执行机制与普通法路径 [模型知识—待核实]；中新之间有商事案件金钱判决承认与执行的指导性备忘录安排 [模型知识—待核实]。
5. **数据跨境**——中国业务数据出境与新加坡 PDPA 跨境转移规则需双端合规设计，两套制度不可互相替代 [模型知识—待核实]。
6. **控股与税务架构**——新加坡常作为区域控股与融资平台；税务、外汇、行业准入问题超出本基线范围，须另行专项核验。
7. **语言与文本**——涉新加坡法的合同审查必须以英文文本进行，中文译本仅作参考。

---

## 6. 官方与权威检索入口

1. **Singapore Statutes Online（SSO）**——https://sso.agc.gov.sg ——新加坡成文法与附属立法的官方现行版本检索，总检察署（AGC）维护（确定性高）。
2. **判例检索**——eLitigation（https://www.elitigation.sg）等渠道提供新加坡法院判决 [模型知识—待核实]。
3. **主管机关官网**——ACRA（https://www.acra.gov.sg）、MOM（https://www.mom.gov.sg）、PDPC（https://www.pdpc.gov.sg）、SIAC（https://siac.org.sg）（确定性较高）。

---

## 7. 使用前核验指引

**任何 skill 引用本基线内容前，必须执行以下核验流程：**

1. **成文法核验**：经 Singapore Statutes Online（见第 6 节）检索法例现行版本（含 Revised Edition 与未整合修正），确认条文内容与生效状态。
2. **判例核验**：涉普通法规则的，检索相关判例是否仍具约束力、是否被后续判决推翻或限缩。
3. **语言核验**：所有援引回到英文原文。
4. **专业核验**：涉新加坡实务的结论性内容，须经新加坡执业律师确认。
5. **记录留痕**：核验结果写入事项目录下的 `verification-log.md`（来源、检索时间、时效状态、原文摘要）。

**标记说明**：本文件中所有「待核实」标记均代表模型知识的不确定性声明——**标注了法例名称不等于已核验，未标注法例名称代表不得直接引用**。本基线不构成对新加坡法律的意见。
