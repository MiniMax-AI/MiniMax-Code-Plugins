#!/usr/bin/env node
// tool-map / smoke.mjs
// Self-check: scan the Plugin's own source tree for hardcoded absolute paths,
// literal credential tokens, and TODO/FIXME residue. Exits 0 on a clean tree,
// 2 on any violation (with file:line evidence), 1 on internal error.
//
// Run: node scripts/smoke.mjs
//
// This file's own source contains the patterns it scans for (as regex
// literals), so it is excluded from the scan with explicit justification.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <plugin>/scripts/smoke.mjs, so PLUGIN_ROOT is the parent
// of the scripts/ directory.
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_ROOT = join(PLUGIN_ROOT, 'skills');
const SCRIPTS_ROOT = join(PLUGIN_ROOT, 'scripts');
const SELF_REL = 'scripts/smoke.mjs';

// Patterns that smell like a hardcoded absolute path on any platform.
const PATH_PATTERNS = [
  /[A-Z]:\\(?!node_modules|\$)/g,      // Windows drive letter (not env var)
  /\/Users\/[a-zA-Z0-9._-]+/g,         // macOS user home
  /\/home\/[a-zA-Z0-9._-]+/g,          // Linux user home
  /C:\\Program Files/giu,              // Windows program files literal
  /D:\\/gu,                            // D: drive (frequent per-user path)
  /C:\\/gu,                            // C: drive literal
  /E:\\/gu,                            // E: drive literal
];

// Patterns for hardcoded credential or token literals.
const TOKEN_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_-]{16,}/g,
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret[_-]?key)\s*[=:]\s*['"][A-Za-z0-9_-]{8,}['"]/gi,
];

// TODO / FIXME / XXX residue from the scaffold.
const TODO_PATTERNS = [
  /\bTODO\b/g,
  /\bFIXME\b/g,
  /\bXXX\b/g,
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (st.isFile() && /\.(md|mjs)$/iu.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(absPath) {
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATH_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        hits.push({ line: i + 1, kind: 'hardcoded-path', match: m[0] });
      }
    }
    for (const pattern of TOKEN_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        hits.push({ line: i + 1, kind: 'hardcoded-token', match: m[0] });
      }
    }
    for (const pattern of TODO_PATTERNS) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(line)) !== null) {
        hits.push({ line: i + 1, kind: 'todo-residue', match: m[0] });
      }
    }
  }
  return hits;
}

function main() {
  const targets = [
    ...walk(SKILLS_ROOT),
    ...walk(SCRIPTS_ROOT),
  ].filter((f) => relative(PLUGIN_ROOT, f).replace(/\\/g, '/') !== SELF_REL);

  let totalHits = 0;
  for (const file of targets) {
    const hits = scanFile(file);
    if (hits.length === 0) continue;
    totalHits += hits.length;
    const rel = relative(PLUGIN_ROOT, file).replace(/\\/g, '/');
    for (const h of hits) {
      console.error(`  ${rel}:${h.line}  [${h.kind}]  ${h.match}`);
    }
  }
  if (totalHits > 0) {
    console.error(`\nFAIL ${totalHits} violation(s) found.`);
    process.exit(2);
  }
  console.log(`OK scanned ${targets.length} files, 0 violations.`);
}

main();
