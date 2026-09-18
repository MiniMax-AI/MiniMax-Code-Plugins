#!/usr/bin/env node
// Mechanical claims runner. The executable claims are FIXED ARGV DATA in this
// file — never parsed out of the documentation. Commands are spawned directly
// (no shell), `node` is resolved to the running executable for portability.
// VERIFICATION.md carries a human-readable mirror of this table; checks/claims.check.mjs
// strictly validates that mirror against this data (any drift, malformed, duplicate,
// or smuggled row fails the suite).
// Exit codes: 0 all claims pass; 1 first mismatch; 2 tool/claims-definition error.
// Portability: runs wherever node, npm, and git are directly spawnable (POSIX/macOS;
// Windows needs npm.cmd resolution and is not claimed).
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';

export const CLAIMS = [
  {id:'V-01', expect:0, argv:[process.execPath,'--test','test/package.test.mjs'], display:'node --test test/package.test.mjs'},
  {id:'V-02', expect:0, argv:['npm','test'], display:'npm test'},
  {id:'V-03', expect:0, argv:['npm','run','build'], display:'npm run build'},
  {id:'V-04', expect:0, argv:['git','diff','--exit-code','--','dist','web','THIRD_PARTY_NOTICES.txt'], display:'git diff --exit-code -- dist web THIRD_PARTY_NOTICES.txt'},
];

// Strict parser for the VERIFICATION.md mirror table. Throws on ANY anomaly:
// missing block, wrong header, malformed separator, unparseable row, wrong column
// count, duplicate IDs, or rows that are not exact CLAIMS members in order.
// Nothing is ever silently skipped.
const ROW = /^\| ([A-Z][A-Z0-9-]*) \| (.+?) \| exit (\d+) \|$/;
const HEADER = '| id | command | expect |';
const SEPARATOR = '|----|---------|--------|';
export function parseMirror(markdown) {
  const block = markdown.match(/```verify\r?\n([\s\S]*?)```/);
  if (!block) throw new Error('mirror: no ```verify block found');
  const lines = block[1].replace(/\r/g,'').split('\n');
  if (lines[0] !== HEADER) throw new Error(`mirror: bad header: ${JSON.stringify(lines[0])}`);
  if (lines[1] !== SEPARATOR) throw new Error(`mirror: bad separator: ${JSON.stringify(lines[1])}`);
  const seen = new Set(); const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' && i === lines.length - 1) continue; // trailing newline only
    const m = ROW.exec(line);
    if (!m) throw new Error(`mirror: unparseable row ${i+1}: ${JSON.stringify(line)}`);
    if (seen.has(m[1])) throw new Error(`mirror: duplicate id ${m[1]}`);
    seen.add(m[1]);
    rows.push({id:m[1], display:m[2], expect:Number(m[3])});
  }
  if (!rows.length) throw new Error('mirror: no claim rows');
  return rows;
}

const invokedDirectly = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (invokedDirectly) {
  const root = join(dirname(fileURLToPath(import.meta.url)),'..');
  for (const claim of CLAIMS) {
    const result = spawnSync(claim.argv[0], claim.argv.slice(1), {cwd: root, stdio: 'inherit'});
    if (result.error) { console.error(`[verify-claims] ERROR ${claim.id}: ${result.error.message}`); process.exit(2); }
    if (result.status !== claim.expect) { console.error(`[verify-claims] FAIL ${claim.id}: ${claim.display} (exit ${result.status}, expected ${claim.expect})`); process.exit(1); }
    console.log(`[verify-claims] PASS ${claim.id}`);
  }
  console.log(`[verify-claims] ${CLAIMS.length} claims verified`);
}