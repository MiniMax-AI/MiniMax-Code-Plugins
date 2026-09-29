#!/usr/bin/env node
// 入口:加载各域 claim → 并发跑 → 汇总 → 退出码。
//
// 退出码是 CI 唯一的判据:
//   0  无断言失败(uncovered 只告警)
//   1  有断言失败
//   2  harness 自身无法运行(缺 mcode 且域里全是 exec)
import { mkdirSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { createSemaphore, runClaim, runCommand, buildSourceIndex } from './lib/harness.mjs'
import { docText, loadReferences } from './lib/doc.mjs'
import { resolveSourceRoot, resolveSourceVersion, collectSourceFiles } from './lib/source.mjs'
import { renderReport, renderFinalLine, summarize } from './lib/report.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DOMAIN_DIR = join(HERE, 'domains')
const EVIDENCE_DIR = join(HERE, 'evidence')

const MAX_EXEC = Number(process.env.VERIFY_MAX_EXEC ?? 4)
const DEFAULT_TIMEOUT_MS = 20000

const argv = process.argv.slice(2)
const hasFlag = (f) => argv.includes(f)
const only = (f) => {
  const hit = argv.find((a) => a.startsWith(f))
  return hit ? hit.slice(f.length).split(',').filter(Boolean) : null
}

async function main() {
  const started = Date.now()

  /* 1. 环境 */
  const versionRes = await runCommand('mcode', ['--version'], { timeoutMs: 10000 })
  const version = versionRes.ok ? versionRes.stdout.trim() : null
  const sourceRoot = resolveSourceRoot()
  const sourceVersion = resolveSourceVersion(sourceRoot)
  const sourceFiles = collectSourceFiles(sourceRoot)
  const source = sourceRoot ? { root: sourceRoot, index: buildSourceIndex(sourceFiles) } : null

  if (!version && !source) {
    console.error('harness 无法运行:既找不到 mcode 可执行文件,也定位不到随包源码。')
    return 2
  }

  /* 2. 载入域 */
  const domainFilter = only('--domain=')
  const files = readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .filter((f) => !domainFilter || domainFilter.includes(f.replace(/\.mjs$/, '')))
    .sort()

  if (files.length === 0) {
    console.error(`没有匹配的域:${domainFilter?.join(',') ?? '(全部为空)'}`)
    return 2
  }

  const domains = await Promise.all(
    files.map(async (f) => {
      const mod = await import(join(DOMAIN_DIR, f))
      return { name: f.replace(/\.mjs$/, ''), claims: mod.claims ?? [] }
    }),
  )

  const ctx = {
    version,
    source,
    docs: docText(),
    refs: loadReferences(),
    semaphore: createSemaphore(MAX_EXEC),
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    cwd: process.cwd(),
  }

  /* 3. 并发跑:域级真并行,域内 claim 并发,exec 受全局信号量限制 */
  const domainResults = await Promise.all(
    domains.map((d) =>
      Promise.allSettled(d.claims.map((claim) => runClaim(claim, ctx))).then((settled) => ({
        name: d.name,
        results: settled.map((s, i) => {
          if (s.status === 'fulfilled') return s.value
          // runClaim 理论上不会 reject(它自己兜住了),这里是最后一道防线:
          // 宁可这一条报 fail,也不要掀翻整域。
          return {
            id: typeof d.claims[i]?.id === 'string' ? d.claims[i].id : '<unknown>',
            domain: d.name,
            doc: d.claims[i]?.doc,
            claim: '',
            status: 'fail',
            reason: `claim 抛错:${s.reason?.message ?? s.reason}`,
            checks: [],
            durationMs: 0,
          }
        }),
      })),
    ),
  )

  const results = domainResults.flatMap((d) => d.results)
  const counts = summarize(results)
  const durationMs = Date.now() - started

  /* 4. 证据落盘(gitignore,CI 可作 artifact) */
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  const evidence = {
    startedAt: new Date(started).toISOString(),
    durationMs,
    env: { mcode: version, sourceRoot, sourceVersion, sourceFiles: sourceFiles.length, node: process.version },
    counts,
    domains: domainResults.map((d) => ({ name: d.name, ...summarize(d.results) })),
    results,
  }
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), JSON.stringify(evidence, null, 2) + '\n')

  if (!hasFlag('--quiet')) {
    console.log(
      renderReport({
        results,
        counts,
        env: { version, sourceRoot },
        durationMs,
        uncoveredWarning: counts.uncovered > 0,
      }),
    )
    console.log(`  证据:verify/evidence/report.json`)
    console.log(renderFinalLine(counts))
    console.log('')
  }

  return counts.fail > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('harness 崩溃:', error)
    process.exit(2)
  },
)
