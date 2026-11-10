#!/usr/bin/env node
// minimax-code-badge: idempotently add, replace, or remove the
// "powered by MiniMax Code" badge at the end of a GitHub PR description.
// Zero dependencies; Node.js >= 18. Uses the GitHub CLI (gh) only for --pr.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const START = '<!-- minimax-code-badge:start -->';
export const END = '<!-- minimax-code-badge:end -->';
export const BADGE_IMAGE_URL =
  'https://img.shields.io/badge/powered_by-MiniMax_Code-E73562?style=flat-square&logo=minimax&logoColor=white';
export const BADGE_LINK = 'https://github.com/MiniMax-AI/minimax-code';
export const DEFAULT_SNIPPET = '[![powered by MiniMax Code](' + BADGE_IMAGE_URL + ')](' + BADGE_LINK + ')';

// A line that is nothing but a MiniMax Code badge (linked or not), even
// without markers: an older hand-written copy, a bundled-asset copy, or a
// customised copy that still uses the bundled file names.
const BARE_BADGE_LINE =
  /^\s*\[?!\[[^\]]*\]\([^)\s]*(?:img\.shields\.io\/badge\/powered[_ -]by-MiniMax[_ -]Code|minimax-code-badge\.(?:svg|png))[^)]*\)(?:\]\([^)]*\))?\s*$/i;
const FENCE = /^\s{0,3}(```+|~~~+)/;

export function buildBlock(snippet = DEFAULT_SNIPPET) {
  const line = String(snippet).trim();
  if (!line || /[\r\n]/.test(line)) throw new Error('badge snippet must be a single non-empty line');
  return START + '\n' + line + '\n' + END;
}

// Remove every badge block / bare badge line outside fenced code blocks.
export function stripBadge(body) {
  const lines = body.split('\n');
  const out = [];
  let fence = null;
  let found = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = line.match(FENCE);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push(line);
      continue;
    }
    if (f) { fence = f[1]; out.push(line); continue; }
    if (line.trim() === START) {
      let end = -1;
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
        if (lines[j].trim() === END) { end = j; break; }
      }
      found++;
      if (end >= 0) i = end; // drop START..END
      continue; // an unmatched START only drops itself
    }
    if (line.trim() === END) { found++; continue; }
    if (BARE_BADGE_LINE.test(line)) { found++; continue; }
    out.push(line);
  }
  // Only badge lines are dropped; every other line (including blank-line
  // runs) is kept byte-for-byte.
  return { body: out.join('\n'), found };
}

/**
 * mode: 'add' (default) | 'remove'
 * returns { body, status } with status in added | replaced | unchanged | removed | absent
 */
export function applyBadge(input, { snippet = DEFAULT_SNIPPET, mode = 'add' } = {}) {
  const original = String(input ?? '');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const { body: stripped, found } = stripBadge(lf);
  const content = stripped.replace(/\s+$/, '');
  let next;
  if (mode === 'remove') {
    next = content ? content + '\n' : '';
  } else {
    const block = buildBlock(snippet);
    next = (content ? content + '\n\n' : '') + block + '\n';
  }
  if (crlf) next = next.replace(/\n/g, '\r\n');
  let status;
  if (next === original) status = mode === 'remove' ? 'absent' : 'unchanged';
  else if (mode === 'remove') status = found ? 'removed' : 'absent';
  else status = found ? 'replaced' : 'added';
  // "absent" with a whitespace-only diff: still report absent but keep text untouched
  if (status === 'absent') next = original;
  return { body: next, status };
}

function parseArgs(argv) {
  const o = { mode: 'add', dryRun: false };
  const need = (i) => { if (i + 1 >= argv.length) throw new Error(argv[i] + ' needs a value'); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--body-file': o.bodyFile = need(i); i++; break;
      case '--pr': o.pr = need(i); i++; break;
      case '--repo': case '-R': o.repo = need(i); i++; break;
      case '--stdin': o.stdin = true; break;
      case '--remove': o.mode = 'remove'; break;
      case '--dry-run': o.dryRun = true; break;
      case '--check': o.check = true; break;
      case '--print': o.print = true; break;
      case '--snippet': o.snippet = need(i); i++; break;
      case '--snippet-file': o.snippet = readFileSync(need(i), 'utf8').trim(); i++; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error('unknown argument: ' + a);
    }
  }
  return o;
}

const HELP = `Usage:
  node badge.mjs --body-file <path> [--dry-run] [--remove|--check]
  node badge.mjs --pr <number|url|branch> [--repo owner/name] [--dry-run] [--remove|--check]
  node badge.mjs --stdin [--remove]          (body on stdin, result on stdout)
  node badge.mjs --print                     (print the badge block)
Options:
  --snippet <md> / --snippet-file <path>     use another one-line badge Markdown
Env:
  MINIMAX_CODE_BADGE_DISABLE=1               no-op, prints "disabled"
  MINIMAX_CODE_BADGE_MARKDOWN=<md>           default snippet override
  GH_BIN=<path>                              gh executable (default: gh)
Status (stderr): added | replaced | unchanged | removed | absent | disabled
Exit: 0 ok; 1 --check found the body not up to date; 2 usage or gh error`;

function gh(args, opts = {}) {
  const bin = process.env.GH_BIN || 'gh';
  const r = spawnSync(bin, args, { encoding: 'utf8', ...opts });
  if (r.error) throw new Error('cannot run ' + bin + ': ' + r.error.message);
  if (r.status !== 0) throw new Error(bin + ' ' + args.slice(0, 2).join(' ') + ' failed: ' + (r.stderr || r.stdout).trim());
  return r.stdout;
}

export function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(e.message + '\n' + HELP + '\n'); return 2; }
  if (o.help) { process.stdout.write(HELP + '\n'); return 0; }
  const snippet = o.snippet || process.env.MINIMAX_CODE_BADGE_MARKDOWN || DEFAULT_SNIPPET;
  if (o.print) { process.stdout.write(buildBlock(snippet) + '\n'); return 0; }
  const targets = [o.bodyFile, o.pr, o.stdin].filter(Boolean).length;
  if (targets !== 1) { process.stderr.write('choose exactly one of --body-file, --pr, --stdin\n' + HELP + '\n'); return 2; }
  if (o.mode === 'add' && /^(1|true|yes)$/i.test(process.env.MINIMAX_CODE_BADGE_DISABLE || '')) {
    process.stderr.write('disabled\n');
    if (o.stdin) process.stdout.write(readFileSync(0, 'utf8'));
    return 0;
  }
  try {
    let before; let label;
    if (o.bodyFile) { before = readFileSync(o.bodyFile, 'utf8'); label = o.bodyFile; }
    else if (o.stdin) { before = readFileSync(0, 'utf8'); label = 'stdin'; }
    else {
      const args = ['pr', 'view', o.pr, '--json', 'body,url'];
      if (o.repo) args.push('--repo', o.repo);
      const info = JSON.parse(gh(args));
      before = info.body || ''; label = info.url || o.pr;
    }
    const { body, status } = applyBadge(before, { snippet, mode: o.mode });
    if (o.check) {
      const ok = o.mode === 'remove' ? status === 'absent' : status === 'unchanged';
      process.stderr.write((ok ? 'ok' : 'stale') + ' ' + label + '\n');
      return ok ? 0 : 1;
    }
    const changed = body !== before;
    if (o.stdin) { process.stdout.write(body); process.stderr.write(status + '\n'); return 0; }
    if (o.dryRun) {
      process.stdout.write(body);
      process.stderr.write(status + ' (dry-run, nothing written) ' + label + '\n');
      return 0;
    }
    if (changed) {
      if (o.bodyFile) writeFileSync(o.bodyFile, body, 'utf8');
      else {
        const dir = mkdtempSync(join(tmpdir(), 'mmc-badge-'));
        try {
          const f = join(dir, 'body.md');
          writeFileSync(f, body, 'utf8');
          const args = ['pr', 'edit', o.pr, '--body-file', f];
          if (o.repo) args.push('--repo', o.repo);
          gh(args);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }
    }
    process.stderr.write(status + ' ' + label + '\n');
    return 0;
  } catch (e) {
    process.stderr.write('error: ' + e.message + '\n');
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
