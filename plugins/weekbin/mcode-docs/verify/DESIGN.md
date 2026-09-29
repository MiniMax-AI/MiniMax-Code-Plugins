# mcode-docs 文档校对方案

把文档里的每条主张变成**可执行的断言**。证据是跑出来的结果,不是写进仓库的文字。

## 为什么这样做

当前 `VERIFICATION.md` 有 1300+ 行取证台账,记录「某条主张在某天用某条命令验过」。
它有三个无法回避的问题:

1. **不可复现** —— 读者无法重跑验证,只能相信文字。
2. **会过期** —— 台账记录的是「当时验过」,不覆盖「现在还成立」。
3. **无法进 CI** —— 文字不能阻止一次错误的合入。

本方案把同一批主张从「文字记录」转成「断言」:同样的结论,但可重跑、
每次提交都重跑、失败即拦合入。台账保留历史结论,CI 保证当下成立,两者互补。

## 核心不变量

| 不变量 | 理由 |
| --- | --- |
| 证据不落库 | 运行结果写 `verify/evidence/`(gitignore),CI 可作为 artifact 上传,但不进仓库 |
| 文档不写证据 | 手册只留结论。取证由 `verify/` 承担,不在正文留任何等级标记或命令 |
| 未覆盖必须显式计数 | 「没验」不等于「验过」。报告永远给出覆盖数,静默通过是 bug |
| 失败不降级为跳过 | 断言失败即失败。环境缺失只能 `skip` 且必须在报告里单列 |
| 单一收敛状态 | 一次运行产出一张总表 + 一个退出码,不用翻日志 |

## Claim 模型

一条 claim 是一个对象,声明「文档某处说 X」以及「X 如何被验证」:

```js
{
  id: 'cli.exec-flags',                    // 稳定标识,CI 报告按此聚合
  domain: 'cli',                           // 并发分片键
  doc: 'site/index.html#h-exec-flags',     // 文档落点,报告里回链
  claim: 'mcode exec 参数与 --help 逐条对齐,无遗漏、无自造',
  checks: [
    { kind: 'doc',    text: 'stream-json' },   // 文档里确实这么写
    { kind: 'source', pattern: 'stream-json' },// 随包源码佐证
    { kind: 'exec',   cmd: 'mcode', args: ['exec', '--help'],
      flagSet: ['--cwd', '--effort', /* … */] }   // 实跑冒烟
  ]
}
```

三种 `kind` 各司其职,可组合:

- **`doc`** —— 断言文档确实包含该表述。防止「结论被改写后断言还绿」。
  缺省扫**站点双站**(读者手册中英各一份);给 `ref: 'cli.md'` 则改查参考手册。
  两者落点不同:手册不写版本号,参考手册写 —— 混在一起扫只会逼着人往手册里塞
  不该出现的东西。
- **`source`** —— 在 mcode 随包源码里匹配模式。证「实现确实如此」,不需要跑。
  90 个 chunk 的 grep 读一次入内存,后续检查都在内存里找。
  **匹配字符串字面量,不匹配符号名**:产物已压缩,`SIDE_MODE_READ_ONLY_COMMANDS`
  这类名字在 bundle 里根本不存在,只有 `"help","changelog",…` 这样的字面量留存。
- **`exec`** —— 真跑命令并断言。可证「实际行为如此」。

`checks` 全部通过才算 pass;任一失败即 fail;`checks` 为空即 **uncovered**。

### exec 断言原语

光有「输出包含某串」不足以验证「无遗漏、无自造」这类口径,所以给了集合级断言:

| 原语 | 语义 | 挡住什么 |
| --- | --- | --- |
| `flagSet` | help 里的长选项集 **==** 声明集,双向 | 遗漏 **和** 自造 |
| `flagSetExempt` | 从「多出」里排除的已知项 | 让豁免成为可 review 的数据,而不是藏起来的宽容 |
| `containsAll` | 多项须全部出现 | 单值 `expect` 漏掉其余项 |
| `notIn` | 字符串 / 正则 / **数组**任一出现即失败 | 「review 不接受这些选项」这类否定口径 |
| `expect` + `exit` | 输出匹配 + 退出码匹配 | 行为对但退出码错 |

匹配一律在 `trim()` 后的输出上进行:命令输出几乎总带尾随换行,
要求每个 claim 作者记得写 `\s*$` 是陷阱,不是严谨。

## 四态收敛

任何 claim 都必须 settle 成四态之一,没有第五种:

| 状态 | 含义 | 计入 |
| --- | --- | --- |
| `pass` | 全部检查通过 | pass |
| `fail` | 有检查未通过 | fail → 退出码 1 |
| `skip` | 全部检查因环境缺失而未验成(命令不存在 / 源码定位不到) | skip,报告单列 |
| `uncovered` | 没声明检查 | uncovered,永远显式计数 |

两条容易搞混的边界:

- **失败不降级为跳过。** 「没验」不是「验过」。`skip` 只在环境缺失时出现。
- **部分 skip 且其余全过仍算 pass。** skip 表示这一路没验成,不是验伪。
- claim 元数据(如 `claim` 字段)取不到时退化为该条 `fail`,不掀翻整轮运行。

## 并发推进

三层并发,上限可控,避免一次性拉起几十个 mcode 进程:

```
run.mjs
 ├── 域级并发:  domains/*.mjs 全部加载后 Promise.all 跑完
 │    域之间零共享状态,文件互不重叠 → 真并行
 ├── claim 级并发: 同一域内的 claim 也并发
 └── 全局信号量:  MAX_EXEC(默认 4)限制同时运行的 exec 检查
      —— exec 会 fork 进程,source/doc 是内存操作,不占配额
```

实测(35 条 claim,同一台机器):`MAX_EXEC=1` 约 5.0s、`=2` 约 2.9s、
`=4` 约 1.9s、`=8` 约 1.7s —— 先近线性缩短后趋平,说明信号量真的在限流,
不是只记了个计数。

**收敛策略**

- 每个 claim 无论成败都必须在同一个 tick 内 settle —— 用
  `Promise.allSettled` 而非 `all`,一个 claim 抛错不拖垮整域。
- check 之间同样用 `allSettled`:第二条断言崩了,不该掩盖第一条的真实结果。
- exec 统一走 `execFile` + `timeout` + `killSignal`,不留悬挂进程。
- 报告一次性汇总,`总 claim / pass / fail / skip / uncovered` 五个数。
  **CI 只看这五个数 + 退出码**,明细作为第二层。

## 运行

```bash
node plugins/weekbin/mcode-docs/verify/run.mjs                    # 全量
node plugins/weekbin/mcode-docs/verify/run.mjs --quiet            # 只看退出码
node plugins/weekbin/mcode-docs/verify/run.mjs --domain=cli,hooks # 只跑指定域
VERIFY_MAX_EXEC=1 node .../run.mjs                               # 压测/限流
```

退出码:`0` 无断言失败(uncovered 只告警) / `1` 有断言失败 / `2` harness 自身跑不起来。

## 目录

```
verify/
├── DESIGN.md          本文件
├── run.mjs            入口:加载域 → 并发跑 → 汇总 → 退出码
├── lib/
│   ├── harness.mjs    claim 执行、并发信号量、超时、集合级断言
│   ├── source.mjs     mcode 随包源码定位与文件收集
│   ├── doc.mjs        站点可见文本 / 参考手册原文
│   └── report.mjs     汇总表(终端 + JSON)
├── domains/           各域 claim 定义,一个文件一个域,互不重叠
└── evidence/          运行结果(gitignore,不进仓库)
```

## CI 落地

工作流放 `.github/workflows/mcode-docs-verify.yml`,路径过滤
`plugins/weekbin/mcode-docs/**`。这与仓库既有的
`openclaw-acp-bridge-smoke.yml`(插件自带 smoke + 路径触发)同一范式。

CI 步骤:

1. `npm i -g @minimax-ai/code@0.5.8`(pin 到台账记录的基线版本)
2. 跑 `node plugins/weekbin/mcode-docs/verify/run.mjs`
3. `verify/evidence/report.json` 作为 artifact 上传(**不进仓库**)
4. 退出码非 0 即拦合入;`uncovered > 0` 只告警不拦

## 与 `test/` 的分工

| | `test/` | `verify/` |
| --- | --- | --- |
| 管什么 | 呈现纪律 + harness 逻辑 | 事实准确性 |
| 需要 mcode | 否 | 是 |
| 何时跑 | 每个提交(`npm test`) | 仅相关路径变更(CI) |

`test/manual-discipline.test.mjs` 是**呈现纪律**回归(取证痕迹/交付史叙事/双语配平)。

`test/verify-harness.test.mjs` 测 **harness 自身的逻辑**——四态收敛、信号量限流、
集合级断言的双向性、域定义自检(claim 字段完整、id 全局唯一、`doc` 回链真实存在)。
它不测 claim 的**内容**:那需要 mcode 与其源码,会让每个提交都付出装 mcode 的代价,
也会在没有 mcode 的机器上误红。

**一个从未见过红的检查器等于没检查**,所以回归里大半用例是**故意写错的 claim**,
断言它们必须落到预期状态:文档词不存在 → fail;源码符号不存在 → fail;
退出码断言错 → fail;超时 → 被捕获;命令不存在 → skip;`checks` 为空 → uncovered。
