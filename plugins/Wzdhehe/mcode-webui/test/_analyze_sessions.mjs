// Also check mcode's own session db
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const SQLITE3 = process.env.SQLITE3_BIN || 'sqlite3' // PATH default — see config.js#detectSqlite3Bin
const MCODE_DB = 'C:\\Users\\you\\.minimax\\v2\\sqlite\\runtime-state.sqlite'

if (!existsSync(MCODE_DB)) {
  console.log('mcode db not found')
  process.exit(0)
}

// Count mcode sessions
const out = execFileSync(SQLITE3, [MCODE_DB, '-readonly',
  `SELECT COUNT(*) FROM local_runtime_sessions`]).toString().trim()
console.log(`mcode local_runtime_sessions: ${out}`)

// List recent ones
const recent = execFileSync(SQLITE3, [MCODE_DB, '-readonly',
  `SELECT id, title, created_at FROM local_runtime_sessions ORDER BY created_at DESC LIMIT 30`]).toString().trim()
console.log('\nRecent mcode sessions:')
for (const line of recent.split('\n')) {
  if (!line) continue
  const [id, title, created] = line.split('|')
  console.log(`  ${id.slice(0, 12)}…  "${title}"  ${created}`)
}
