// claim 执行核心:三类检查、并发调度、超时、结果收敛。
//
// 收敛不变量:任何 claim 都必须 settle 成四态之一 ——
//   pass / fail / skip / uncovered
// 「没验」永远不是 pass。抛错不是第五种状态,它会被归到 fail,
// 因为 claim 自己崩了就是没验成,不是被跳过。
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

/* ---------------------------------------------------------------- 限流 */

/** 全局信号量。只用来限 exec —— source/doc 是内存操作,不占进程配额。 */
export function createSemaphore(limit) {
  let active = 0
  const waiters = []
  const next = () => {
    if (active < limit) {
      active++
      return Promise.resolve()
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = () => {
    active--
    const w = waiters.shift()
    if (w) {
      active++
      w()
    }
  }
  return {
    next,
    release,
    get active() {
      return active
    },
  }
}

/* ---------------------------------------------------------------- exec */

/**
 * 跑一条命令。永不 reject —— 失败形态(非零退出 / 超时 / 找不到命令)
 * 都编码进返回值,因为「跑不起来」和「跑起来但行为不符」必须能区分。
 */
export function runCommand(cmd, args, { timeoutMs = 20000, cwd, env, stdin } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = execFile(
        cmd,
        args,
        {
          cwd,
          env: env ? { ...process.env, ...env } : process.env,
          encoding: 'utf8',
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
            timedOut: Boolean(error?.killed) && error?.signal === 'SIGKILL',
            missing: Boolean(error) && error.code === 'ENOENT',
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            durationMs: Date.now() - started,
          })
        },
      )
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        timedOut: false,
        missing: true,
        stdout: '',
        stderr: String(error?.message ?? error),
        durationMs: Date.now() - started,
      })
      return
    }
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {})
      child.stdin?.end(stdin)
    } else {
      child.stdin?.end()
    }
  })
}

/* ---------------------------------------------------------------- source 索引 */

let sourceIndex = null

/**
 * 一次性读入所有候选源文件,后续检查在内存里找。
 * 90 个 chunk 全读是几十 MB 量级,读一次比分 N 次文件 IO 便宜得多;
 * 代价是这一轮运行内源码不会变 —— 冒烟检查本来也不该中途换版本。
 */
export function buildSourceIndex(files) {
  if (sourceIndex) return sourceIndex
  const entries = []
  for (const file of files) {
    try {
      entries.push({ file, text: readFileSync(file, 'utf8') })
    } catch {
      /* 读不到就当这个文件不存在 */
    }
  }
  sourceIndex = { entries, size: entries.length }
  return sourceIndex
}

export function resetSourceIndex() {
  sourceIndex = null
}

/* ---------------------------------------------------------------- 检查 */

/** 逐个尝试候选文件,返回首个命中的文件;都不命中返回 null。 */
function searchAny(entries, pattern, fileHint) {
  const pool = fileHint ? entries.filter((e) => e.file.endsWith(fileHint)) : entries
  for (const { file, text } of pool.length ? pool : entries) {
    if (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)) return file
  }
  return null
}

/** 在源码里数命中次数,用于「N 个事件」这类计数型主张。 */
function countMatches(entries, pattern) {
  let n = 0
  for (const { text } of entries) {
    if (typeof pattern === 'string') {
      let i = text.indexOf(pattern)
      while (i >= 0) {
        n++
        i = text.indexOf(pattern, i + pattern.length)
      }
    } else {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
      n += (text.match(new RegExp(pattern.source, flags)) ?? []).length
    }
  }
  return n
}

async function checkDoc(check, ctx) {
  // ref 指向 reference/*.md,其余走站点双站。
  // 两条主张的落点不同:面向读者的手册不写版本号,参考手册写 ——
  // 强行用同一个检查去扫两边,只会逼着人往手册里塞不该出现的东西。
  if (check.ref) {
    let body
    try {
      body = ctx.refs[check.ref]
    } catch (error) {
      return { kind: 'doc', ok: false, detail: `读不到 reference/${check.ref}:${error?.message ?? error}` }
    }
    if (body === undefined) {
      return { kind: 'doc', ok: false, detail: `未登记的 reference:${check.ref}` }
    }
    const hit =
      typeof check.text === 'string' ? body.includes(check.text) : check.text.test(body)
    return {
      kind: 'doc',
      ok: hit,
      detail: hit ? `reference/${check.ref} 命中` : `reference/${check.ref} 未含 ${String(check.text).slice(0, 50)}`,
    }
  }

  const pages = check.pages ?? ['zh', 'en']
  const text = ctx.docs
  const missing = []
  for (const page of pages) {
    const body = text[page]
    if (body === undefined) {
      missing.push(`${page}:<页面缺失>`)
      continue
    }
    const needle = check.text
    if (typeof needle === 'string' ? !body.includes(needle) : !needle.test(body)) {
      missing.push(`${page}:${JSON.stringify(String(needle)).slice(0, 60)}`)
    }
  }
  return {
    kind: 'doc',
    ok: missing.length === 0,
    detail: missing.length === 0 ? `${pages.length} 站均命中` : `未命中 ${missing.join(' / ')}`,
  }
}

function checkSource(check, ctx) {
  if (!ctx.source) {
    return { kind: 'source', ok: false, skipped: true, detail: 'mcode 随包源码未找到' }
  }
  const { index } = ctx.source
  if (!index || index.entries.length === 0) {
    return { kind: 'source', ok: false, skipped: true, detail: '源码索引为空' }
  }
  // containsAll:多项须全部命中。单值 pattern 只能验「有一个」,
  // 验不了「四条命令线都在」这种完整性主张。
  if (check.containsAll) {
    const missing = check.containsAll.filter((n) => !searchAny(index.entries, n, check.file))
    return {
      kind: 'source',
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${check.containsAll.length} 项全部命中` : `缺少: ${missing.join(' ')}`,
    }
  }
  if (check.count != null) {
    const n = countMatches(index.entries, check.pattern)
    return {
      kind: 'source',
      ok: n === check.count,
      detail: `命中 ${n} 处,断言 ${check.count} 处`,
    }
  }
  const file = searchAny(index.entries, check.pattern, check.file)
  return {
    kind: 'source',
    ok: Boolean(file),
    detail: file ? file.split('/').slice(-2).join('/') : '未在随包源码中找到',
  }
}

async function checkExec(check, ctx) {
  await ctx.semaphore.next()
  try {
    const res = await runCommand(check.cmd, check.args ?? [], {
      timeoutMs: check.timeoutMs ?? ctx.defaultTimeoutMs,
      cwd: check.cwd ?? ctx.cwd,
      env: check.env,
      stdin: check.stdin,
    })

    if (res.missing) {
      return { kind: 'exec', ok: false, skipped: true, detail: `命令不存在:${check.cmd}` }
    }
    if (res.timedOut) {
      return {
        kind: 'exec',
        ok: false,
        detail: `超时 ${res.durationMs}ms`,
        stdout: res.stdout.slice(0, 400),
      }
    }

    const problems = []
    if (check.exit != null && res.code !== check.exit) {
      problems.push(`退出码 ${res.code},断言 ${check.exit}`)
    }
    if (check.exitNot != null && res.code === check.exitNot) {
      problems.push(`退出码 ${res.code},断言不得为该值`)
    }

    // 统一在 trim 后的输出上匹配:命令输出几乎总带尾随换行,
    // 要求每个 claim 作者都记得写 \s*$ 是陷阱,不是严谨。
    const body = `${res.stdout}\n${res.stderr}`.trim()

    const hit = (needle) =>
      typeof needle === 'string' ? body.includes(needle) : new RegExp(needle.source, needle.flags).test(body)

    if (check.expect != null && !hit(check.expect)) {
      problems.push('输出未含期望内容')
    }
    // notIn 允许给字符串、正则或字符串数组 —— 「review 不接受这些选项」天然是数组。
    const notIns = check.notIn == null ? [] : Array.isArray(check.notIn) ? check.notIn : [check.notIn]
    for (const n of notIns) {
      if (hit(n)) problems.push(`输出不应含 ${JSON.stringify(String(n)).slice(0, 50)}`)
    }
    if (check.containsAll) {
      const missing = check.containsAll.filter((n) => !body.includes(n))
      if (missing.length) problems.push(`缺少: ${missing.join(' ')}`)
    }

    // 双向集合相等:断言「help 里的选项集」== 「声明的选项集 + 显式豁免」。
    // 单向 containsAll 只能发现遗漏,发现不了文档自造;flagSet 两个方向都查。
    // 豁免写进 claim 数据而不是藏进 harness —— 豁免本身要能被 review。
    if (check.flagSet) {
      const declared = new Set(check.flagSet)
      const exempt = new Set(check.flagSetExempt ?? [])
      const found = extractFlags(body)
      found.delete('--help')
      for (const e of exempt) found.delete(e)
      const missing = [...declared].filter((f) => !found.has(f))
      const extra = [...found].filter((f) => !declared.has(f))
      if (missing.length) problems.push(`help 缺少: ${missing.join(' ')}`)
      if (extra.length) problems.push(`help 多出(未文档化): ${extra.join(' ')}`)
    }

    return {
      kind: 'exec',
      ok: problems.length === 0,
      detail: problems.length === 0 ? `退出码 ${res.code} · ${res.durationMs}ms` : problems.join('; '),
      exit: res.code,
      durationMs: res.durationMs,
      stdout: res.stdout.slice(0, 2000),
      stderr: res.stderr.slice(0, 1000),
    }
  } finally {
    ctx.semaphore.release()
  }
}

/* ---------------------------------------------------------------- claim */

const FLAG_RE = /(^|\s)(--[a-z][a-z-]*)/g

/** 从命令输出里抽出所有长选项名。 */
function extractFlags(text) {
  const out = new Set()
  for (const m of text.matchAll(FLAG_RE)) out.add(m[2])
  return out
}

/**
 * 安全读取 claim 元数据。
 * 结果对象是在 claim 跑完之后才构造的,那时读 claim.claim 仍可能抛错
 * (比如元数据由计算属性生成)。这里逐字段兜住:一条 claim 的元数据坏掉
 * 应当是它自己 fail,不能掀翻整轮运行。
 */
function safeMeta(claim) {
  const get = (k) => {
    try {
      return claim?.[k]
    } catch (e) {
      return `<读取 ${k} 抛错:${e?.message ?? e}>`
    }
  }
  return {
    id: typeof get('id') === 'string' ? get('id') : '<unknown>',
    domain: typeof get('domain') === 'string' ? get('domain') : '<unknown>',
    doc: get('doc'),
    claim: typeof get('claim') === 'string' ? get('claim') : '',
  }
}

/**
 * 跑一个 claim。所有 check 用 allSettled 收敛:一个 check 抛错不阻断同 claim 的其他 check,
 * 否则「第二条断言崩了」会连带掩盖第一条的真实结果。
 */
export async function runClaim(rawClaim, ctx) {
  const meta = safeMeta(rawClaim)
  const started = Date.now()
  let checks
  try {
    checks = Array.isArray(rawClaim?.checks) ? rawClaim.checks : []
  } catch (e) {
    return {
      ...meta,
      status: 'fail',
      reason: `读取 checks 抛错:${e?.message ?? e}`,
      checks: [],
      durationMs: 0,
    }
  }

  if (checks.length === 0) {
    return {
      ...meta,
      status: 'uncovered',
      reason: '未声明任何检查',
      checks: [],
      durationMs: 0,
    }
  }

  const settled = await Promise.allSettled(
    checks.map((c) => {
      switch (c?.kind) {
        case 'doc':
          return checkDoc(c, ctx)
        case 'source':
          return Promise.resolve(checkSource(c, ctx))
        case 'exec':
          return checkExec(c, ctx)
        default:
          return Promise.reject(new Error(`未知 check.kind: ${c?.kind}`))
      }
    }),
  )

  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? { ...s.value, label: checks[i]?.label ?? checks[i]?.kind }
      : {
          kind: checks[i]?.kind ?? '?',
          label: checks[i]?.kind ?? '?',
          ok: false,
          detail: `检查自身抛错:${s.reason?.message ?? s.reason}`,
        },
  )

  const skipped = results.filter((r) => r.skipped)
  const failed = results.filter((r) => !r.ok && !r.skipped)

  // 全 skip → skip(环境缺失);有失败 → fail;全过 → pass。
  // 部分 skip 且其余全过仍算 pass:skip 只表示这一路没验成,不是验伪。
  let status = 'pass'
  if (failed.length) status = 'fail'
  else if (skipped.length === results.length) status = 'skip'

  return {
    ...meta,
    status,
    reason: status === 'fail' ? failed.map((f) => f.detail).join('; ') : skipped.length ? '环境缺失' : '',
    checks: results,
    durationMs: Date.now() - started,
  }
}
