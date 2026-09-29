// 定位 mcode 随包源码。
//
// 只做「找到哪一份」这一件事,不缓存结果 —— CI 每次都是干净进程,
// 本地连续跑时缓存会掩盖版本切换,反而制造假绿。
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PKG = '@minimax-ai/code'

/** npm global root;失败返回 null 而不是抛 —— 缺环境应表现为 skip,不是崩。 */
function npmGlobalRoot() {
  try {
    return execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    }).trim()
  } catch {
    return null
  }
}

/**
 * 解析 mcode 随包源码根目录。
 * 候选顺序:mcode 可执行文件同级的 lib/node_modules → npm root -g。
 * 同级优先,因为 PATH 上可能存在多份 mcode(mcode update 场景),而
 * npm root -g 未必与 PATH 命中的那一份一致。
 */
export function resolveSourceRoot() {
  const candidates = []

  try {
    const bin = execFileSync('command', ['-v', 'mcode'], { encoding: 'utf8', timeout: 5000 })
      .toString()
      .trim()
    if (bin) candidates.push(join(bin, '..', '..', 'lib', 'node_modules', PKG))
  } catch {
    /* command 内建在部分 shell 不可用,忽略 */
  }

  const globalRoot = npmGlobalRoot()
  if (globalRoot) candidates.push(join(globalRoot, PKG))

  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir
  }
  return null
}

/** 随包版本号;取不到返回 null。 */
export function resolveSourceVersion(root) {
  if (!root) return null
  try {
    const pkg = JSON.parse(
      execFileSync('cat', [join(root, 'package.json')], { encoding: 'utf8', timeout: 5000 }),
    )
    return pkg.version ?? null
  } catch {
    return null
  }
}

/**
 * 递归收集待 grep 的源文件。
 * 刻意**排除** node_modules:90 个 chunk 里没有任何一个依赖第三方包,
 * 而依赖树里同名符号会产生假阳性。
 */
export function collectSourceFiles(root, { maxBytes = 12 * 1024 * 1024 } = {}) {
  const out = []
  const skipDirs = new Set(['node_modules', '.git', 'native', 'internal-bin'])

  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        walk(full)
      } else if (e.isFile() && e.name.endsWith('.js')) {
        try {
          if (statSync(full).size <= maxBytes) out.push(full)
        } catch {
          /* 权限或竞态,跳过 */
        }
      }
    }
  }

  if (root) walk(root)
  return out
}
