// 汇总:终端表 + JSON。
//
// 报告的第一职责是**可扫读**:五个数(总/pass/fail/skip/uncovered)在最上面,
// 明细在下面。CI 只看这五个数 + 退出码。
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const useColor = process.env.NO_COLOR ? () => false : () => process.stdout.isTTY === true
const paint = (color, s) => (useColor() ? `${color}${s}${C.reset}` : s)

const MARK = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', uncovered: 'UNCV' }
const COLOR = { pass: C.green, fail: C.red, skip: C.yellow, uncovered: C.gray }

/** 显示宽度:CJK 字符占 2 列,否则终端表格会错位。 */
export function displayWidth(s) {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
        ? 2
        : 1
  }
  return w
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - displayWidth(s)))
const truncate = (s, n) => (displayWidth(s) <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')

export function summarize(results) {
  const counts = { total: results.length, pass: 0, fail: 0, skip: 0, uncovered: 0 }
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1
  return counts
}

export function renderReport({ results, counts, env, durationMs, uncoveredWarning }) {
  const out = []
  const byDomain = new Map()
  for (const r of results) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, [])
    byDomain.get(r.domain).push(r)
  }

  out.push('')
  out.push(paint(C.bold, 'mcode-docs 文档校对'))
  out.push(
    paint(
      C.gray,
      `  mcode ${env.version ?? '未找到'} · 源码 ${env.sourceRoot ?? '未找到'} · ${durationMs}ms`,
    ),
  )
  out.push('')

  const head = ['域', '总', 'pass', 'fail', 'skip', 'uncovered'].map((h) => pad(h, 14))
  out.push(paint(C.dim, '  ' + head.join('')))
  for (const [domain, list] of byDomain) {
    const c = summarize(list)
    out.push(
      '  ' +
        pad(domain, 14) +
        pad(String(c.total), 14) +
        paint(c.pass ? C.green : C.dim, pad(String(c.pass), 14)) +
        paint(c.fail ? C.red : C.dim, pad(String(c.fail), 14)) +
        paint(c.skip ? C.yellow : C.dim, pad(String(c.skip), 14)) +
        paint(c.uncovered ? C.gray : C.dim, pad(String(c.uncovered), 14)),
    )
  }

  out.push('')
  out.push(
    paint(C.dim, '  ' + pad('总计', 14)) +
      paint(C.bold, pad(String(counts.total), 14)) +
      paint(C.green, pad(String(counts.pass), 14)) +
      (counts.fail ? paint(C.red, pad(String(counts.fail), 14)) : pad('0', 14)) +
      (counts.skip ? paint(C.yellow, pad(String(counts.skip), 14)) : pad('0', 14)) +
      paint(C.gray, pad(String(counts.uncovered), 14)),
  )

  const problems = results.filter((r) => r.status === 'fail' || r.status === 'uncovered')
  if (problems.length) {
    out.push('')
    out.push(paint(C.bold, `  明细(${problems.length} 条需关注)`))
    for (const r of problems) {
      const tag = paint(COLOR[r.status] ?? C.dim, MARK[r.status] ?? r.status)
      out.push(`  ${tag} ${paint(C.cyan, r.id)}`)
      out.push(paint(C.gray, `       ${truncate(r.claim, 96)}`))
      if (r.reason) out.push(paint(C.gray, `       ${truncate(r.reason, 96)}`))
    }
  }

  if (uncoveredWarning) {
    out.push('')
    out.push(paint(C.yellow, `  ⚠ ${counts.uncovered} 条 claim 未覆盖 —— 未覆盖不等于已验证`))
  }

  out.push('')
  return out.join('\n')
}

export function renderFinalLine(counts) {
  if (counts.fail) return paint(C.red + C.bold, `FAIL  ${counts.fail} 条断言未通过`)
  if (counts.uncovered) return paint(C.yellow, `PASS (${counts.uncovered} 条未覆盖)`)
  return paint(C.green + C.bold, 'PASS  全部 claim 已验证')
}
