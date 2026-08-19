#!/usr/bin/env node
// tool-map / scan.mjs
// Cross-platform tool inventory scanner for the tool-map Plugin.
// Run: node scan.mjs [output.md]
//   - default output: $PLUGIN_DATA/tools.md, with .json and .summary.md siblings
//   - fallback when $PLUGIN_DATA is unset: ~/.local/share/tool-map/tools.md
//   - if argv[2] is given, the catalog is written to that path's directory
//
// Design: zero external deps, atomic write (staging + rename), no hardcoded
// per-user absolute paths. All well-known locations are derived from the
// user's home directory, environment variables, or fixed POSIX conventions.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync,
  realpathSync, renameSync, rmSync,
} from 'node:fs';
import { join, dirname, basename, sep, extname, resolve, delimiter } from 'node:path';
import { homedir, hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';

const execFileP = promisify(execFile);

const PLATFORM = platform();
const HOME = homedir();
const IS_WIN = PLATFORM === 'win32';
const ENV = process.env;

// --- Output paths ---
// PLUGIN_DATA is set by the host runtime (mcode) when running plugin scripts.
// Fall back to the XDG_DATA_HOME convention so the scanner is also usable
// standalone from a developer's shell.
const DATA_ROOT = ENV.PLUGIN_DATA || join(HOME, '.local', 'share', 'tool-map');
const outMd = resolve(process.argv[2] || join(DATA_ROOT, 'tools.md'));
const outJson = outMd.replace(/\.md$/, '') + '.json';
const outSummary = outMd.replace(/\.md$/, '') + '.summary.md';

// --- Atomic write helper ---
// Writes to a sibling staging file first, then renames onto the target. The
// rename is atomic on POSIX and on Windows when the source and target live on
// the same filesystem, which is guaranteed here because the staging path sits
// in the same directory as the target. On any failure, the staging file is
// removed and the original target (if any) is left untouched.
function atomicWriteSync(targetPath, contents) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const pid = process.pid;
  const rand = randomBytes(8).toString('hex');
  const stagingPath = join(dir, `.${basename(targetPath)}.staging-${pid}-${rand}`);
  try {
    writeFileSync(stagingPath, contents, 'utf8');
    renameSync(stagingPath, targetPath);
  } catch (err) {
    try { rmSync(stagingPath, { force: true }); } catch { /* swallow */ }
    throw err;
  }
}

// --- Scan config ---
const EXEC_EXTS = IS_WIN
  ? new Set(['.exe', '.cmd', '.ps1', '.bat', '.com', '.vbs', '.wsf', ''])
  : new Set(['', '.sh', '.bash', '.zsh']);

// On Windows also pick up *nix shim files (npm bin shims are extensionless on
// Windows too). Skip files > 50 MB (CUDA SDKs etc.) and extensionless files
// outside the 100 B to 10 KB range.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_DEPTH = 1; // for known roots, scan 1 level deep
const MAX_RESULTS = 5000; // safety cap

// --- Known tool roots (cross-platform) ---
// Every entry is home-relative, env-var-resolved, or a fixed POSIX system
// path. No per-user absolute paths.
function knownRoots() {
  if (IS_WIN) {
    const progFiles = ENV.ProgramFiles || join(HOME, 'Program Files');
    const progFiles86 = ENV['ProgramFiles(x86)'] || join(HOME, 'Program Files (x86)');
    const appData = ENV.APPDATA || join(HOME, 'AppData', 'Roaming');
    const localAppData = ENV.LOCALAPPDATA || join(HOME, 'AppData', 'Local');
    return [
      [join(HOME, '.minimax-code'), 'minimax-code'],
      [join(HOME, '.minimax'), 'minimax'],
      [join(appData, 'npm'), 'npm-global'],
      [join(HOME, '.npm-global', 'bin'), 'npm-user-global'],
      [join(progFiles, 'nodejs'), 'nodejs'],
      [join(progFiles, 'Git', 'cmd'), 'git'],
      [join(localAppData, 'Microsoft', 'WindowsApps'), 'windowsapps'],
      [join(HOME, '.Codex'), 'codex'],
      [join(HOME, '.claude'), 'claude'],
    ];
  }
  // macOS / Linux
  return [
    [join(HOME, '.minimax-code'), 'minimax-code'],
    [join(HOME, '.minimax'), 'minimax'],
    [join(HOME, '.local', 'bin'), 'user-local-bin'],
    [join(HOME, '.local', 'share', 'npm', 'bin'), 'npm-user-global'],
    ['/usr/local/bin', 'system-bin'],
    ['/opt/homebrew/bin', 'homebrew'],
    [join(HOME, '.Codex'), 'codex'],
    [join(HOME, '.claude'), 'claude'],
  ];
}

// --- Extra roots via env (colon/semicolon-separated) ---
function parseExtraRoots() {
  const raw = ENV.TOOL_MAP_ROOTS;
  if (!raw) return [];
  return raw.split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
}

// --- Version probes (with timeout, never throw) ---
const VERSION_PROBES = [
  ['node', ['node', '--version']],
  ['npm', ['npm', '--version']],
  ['pnpm', ['pnpm', '--version']],
  ['yarn', ['yarn', '--version']],
  ['mcode', ['mcode', '--version']],
  ['openclaw', ['openclaw', '--version']],
  ['clawhub', ['clawhub', '--version']],
  ['codex', ['codex', '--version']],
  ['git', ['git', '--version']],
  ['python', ['python', '--version']],
  ['python3', ['python3', '--version']],
  ['gh', ['gh', '--version']],
  ['docker', ['docker', '--version']],
  ['pwsh', ['pwsh', '--version']],
  ['powershell', ['powershell', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']],
];

async function probeVersion(cmd) {
  try {
    const { stdout } = await execFileP(cmd[0], cmd.slice(1), {
      timeout: 5000,
      windowsHide: true,
      shell: IS_WIN,
    });
    const first = (stdout || '').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* timeout, missing, or non-zero exit - all OK */ }
  return null;
}

// --- File walker ---
const NPM_BIN_HINT = /minimax-code[\\\/]|openclaw[\\\/]|minimax[\\\/]bin|node_modules[\\\/]|\.Codex[\\\/]|\.claude[\\\/]|[\\\/]npm[\\\/]|tauri[\\\/]/i;
function isToolFile(name, size, dirLower) {
  if (name.startsWith('.')) return false; // dotfiles (.gitignore, .npmrc, ...) are not tools
  const ext = extname(name).toLowerCase();
  if (ext !== '') return EXEC_EXTS.has(ext);
  // extensionless file - likely an npm bin shim
  if (size < 100 || size > 10 * 1024) return false;
  return NPM_BIN_HINT.test(dirLower);
}

function classify(p) {
  const norm = p.toLowerCase();
  if (norm.includes('.minimax-code')) return 'minimax-code';
  if (norm.includes('.minimax')) return 'minimax';
  if (norm.includes('openclaw')) return 'openclaw';
  if (norm.includes('.codex')) return 'codex';
  if (norm.includes('.claude')) return 'claude';
  if (norm.includes('nodejs')) return 'nodejs';
  if (norm.includes('github cli')) return 'gh-cli';
  if (norm.includes('git\\cmd') || norm.includes('git/cmd')) return 'git';
  if (norm.includes('python')) return 'python';
  if (norm.includes('node_modules') || norm.includes('npm-global')) return 'npm';
  return 'extra';
}

function walk(dir, opts, out) {
  if (!existsSync(dir)) return;
  if (out.length >= MAX_RESULTS) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_RESULTS) break;
    const full = join(dir, e.name);
    if (e.isFile()) {
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.size > MAX_FILE_SIZE) continue;
      // Pass dir + sep so trailing-`\` regex anchors match for both root and nested dirs.
      if (!isToolFile(e.name, st.size, (dir + sep).toLowerCase())) continue;
      const ext = extname(e.name);
      out.push({
        name: basename(e.name, ext),
        type: ext.replace(/^\./, '') || (IS_WIN ? 'exe' : 'bin'),
        path: full,
        size: st.size,
        modified: st.mtime.toISOString().slice(0, 10),
        category: opts.category,
      });
    } else if (e.isDirectory() && !e.isSymbolicLink() && opts.depth > 0) {
      // For known roots, recurse subdirs at the configured depth.
      // Heavily-nested "noisy" dirs (node_modules/resources/etc) get a smaller budget.
      const dn = e.name.toLowerCase();
      if (/^(node_modules|app-|app\.|resources|locales|dll|swiftshader)/.test(dn)) {
        walk(full, { ...opts, depth: Math.max(0, opts.depth - 1) }, out);
      } else {
        walk(full, { ...opts, depth: opts.depth - 1 }, out);
      }
    }
  }
}

// --- Markdown rendering ---
function renderMarkdown({ scanned, pf, host, core, extras, tools }) {
  const sb = [];
  sb.push('# Tool Inventory');
  sb.push('');
  sb.push(`- Scanned: ${scanned}`);
  sb.push(`- Platform: ${pf}  (${IS_WIN ? 'Windows' : 'POSIX'})`);
  sb.push(`- Host: ${host}`);
  sb.push(`- Total: ${tools.length} entries across ${new Set(tools.map((t) => t.category)).size} categories`);
  sb.push('');
  sb.push('## Core Versions');
  sb.push('');
  sb.push('| Tool | Version |');
  sb.push('|------|---------|');
  for (const [k, v] of Object.entries(core).sort()) sb.push(`| ${k} | ${v} |`);
  if (extras.git_user || extras.git_email || (extras.ssh_keys && extras.ssh_keys.length)) {
    sb.push('');
    sb.push('## Identity & Keys');
    sb.push('');
    if (extras.git_user) sb.push(`- **GitHub user**: \`${extras.git_user}\``);
    if (extras.git_email) sb.push(`- **Git email**: \`${extras.git_email}\``);
    if (extras.ssh_keys && extras.ssh_keys.length) sb.push(`- **SSH key filenames** (contents not read): ${extras.ssh_keys.map((k) => '`' + k + '`').join(', ')}`);
  }
  sb.push('');
  // Group by category
  const byCat = new Map();
  for (const t of tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  for (const [cat, items] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sb.push(`## ${cat} (${items.length})`);
    sb.push('');
    sb.push('| Name | Type | Size(KB) | Modified | Path |');
    sb.push('|------|------|---------:|----------|------|');
    for (const e of items.sort((a, b) => a.name.localeCompare(b.name))) {
      sb.push(`| ${e.name} | ${e.type} | ${(e.size / 1024).toFixed(1)} | ${e.modified} | ${e.path} |`);
    }
    sb.push('');
  }
  sb.push('---');
  sb.push('');
  sb.push('## Scan Notes');
  sb.push('');
  sb.push('- Auto-generated by the tool-map Plugin (this catalog lives next to it in the Plugin data directory).');
  sb.push('- To refresh: re-run the scanner, or trigger the `tool-map` Skill.');
  sb.push('- Cross-platform: works on Windows / macOS / Linux. Pure Node, no external dependencies.');
  sb.push('- Skips files > 50 MB and extensionless files outside the 100 B to 10 KB range.');
  sb.push('- Writes are atomic (staging + rename) so a crash mid-scan never leaves a partial catalog.');
  sb.push('');
  return sb.join('\n');
}

// --- Summary rendering ---
function renderSummary({ scanned, pf, core, extras, tools }) {
  const sb = [];
  sb.push('# Tool Map (Summary)');
  sb.push('');
  sb.push(`> Scanned: ${scanned}  |  Platform: ${pf}  |  Tools: ${tools.length}`);
  sb.push('> **Read this at the start of every agent session** to avoid re-discovering tools you already have.');
  sb.push('');
  // Top-N most useful tools (CLI shortcuts the agent is likely to need)
  sb.push('## Core CLI (run `cmd --version` to confirm)');
  sb.push('');
  sb.push('| Tool | Version |');
  sb.push('|------|---------|');
  for (const [k, v] of Object.entries(core).sort()) sb.push(`| \`${k}\` | ${v} |`);
  sb.push('');
  // Quick lookup by category
  const byCat = new Map();
  for (const t of tools) {
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  sb.push('## Quick Lookup by Category');
  sb.push('');
  for (const [cat, items] of [...byCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sb.push(`### ${cat} (${items.length})`);
    sb.push('');
    for (const e of items.slice(0, 20).sort((a, b) => a.name.localeCompare(b.name))) {
      sb.push(`- \`${e.name}\` - ${e.path}`);
    }
    if (items.length > 20) sb.push(`- _...and ${items.length - 20} more, see tools.md_`);
    sb.push('');
  }
  if (extras.git_user) sb.push(`GitHub user: \`${extras.git_user}\`  `);
  if (extras.git_email) sb.push(`Git email: \`${extras.git_email}\`  `);
  if (extras.ssh_keys && extras.ssh_keys.length) sb.push(`SSH key filenames: ${extras.ssh_keys.join(', ')}  `);
  sb.push('');
  return sb.join('\n');
}

// --- Main ---
async function main() {
  const startTs = new Date().toISOString();

  // 1) PATH directories
  const pathDirs = (ENV.PATH || '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);

  // 2) Known roots + extra roots from env
  const known = [
    ...knownRoots(),
    ...parseExtraRoots().map((p) => [p, 'extra-root']),
  ].filter(([p]) => existsSync(p));

  // 3) Walk - known roots first (more specific categories win over PATH)
  const out = [];
  for (const [p, cat] of known) {
    walk(p, { category: cat, depth: MAX_DEPTH }, out);
  }
  for (const d of pathDirs) {
    walk(d, { category: 'PATH', depth: 0 }, out);
  }

  // 4) Dedupe by full path (prefer real path)
  const seen = new Map();
  for (const t of out) {
    let real;
    try { real = realpathSync(t.path); } catch { real = t.path; }
    const key = real.toLowerCase();
    if (!seen.has(key)) seen.set(key, { ...t, path: real });
  }
  const tools = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));

  // 5) Version probes (parallel)
  const coreEntries = await Promise.all(
    VERSION_PROBES.map(async ([name, cmd]) => {
      const v = await probeVersion(cmd);
      return v ? [name, v] : null;
    }),
  );
  const core = Object.fromEntries(coreEntries.filter(Boolean));

  // 6) GitHub / env extras
  const extras = {};
  try {
    const gitconfig = join(HOME, '.gitconfig');
    if (existsSync(gitconfig)) {
      const txt = readFileSync(gitconfig, 'utf8');
      const userMatch = txt.match(/\[user\][\s\S]*?name\s*=\s*([^\n]+)/);
      const emailMatch = txt.match(/\[user\][\s\S]*?email\s*=\s*([^\n]+)/);
      if (userMatch) extras.git_user = userMatch[1].trim();
      if (emailMatch) extras.git_email = emailMatch[1].trim();
    }
  } catch { /* unreadable .gitconfig - skip */ }
  try {
    const sshDir = join(HOME, '.ssh');
    if (existsSync(sshDir)) {
      const keys = readdirSync(sshDir).filter((f) => /^id_/.test(f) && !f.endsWith('.pub'));
      extras.ssh_keys = keys;
    }
  } catch { /* unreadable .ssh - skip */ }

  // 7) Render and write atomically
  const md = renderMarkdown({ scanned: startTs, pf: PLATFORM, host: hostname(), core, extras, tools });
  const json = { scanned: startTs, platform: PLATFORM, host: hostname(), core, extras, tools };
  const summary = renderSummary({ scanned: startTs, pf: PLATFORM, core, extras, tools });

  atomicWriteSync(outMd, md);
  atomicWriteSync(outJson, JSON.stringify(json, null, 2));
  atomicWriteSync(outSummary, summary);

  // 8) Console report
  const byCat = tools.reduce((acc, t) => { acc[t.category] = (acc[t.category] || 0) + 1; return acc; }, {});
  console.log(`WROTE  ${outMd}  (${md.length} bytes)`);
  console.log(`WROTE  ${outJson}  (${JSON.stringify(json).length} bytes)`);
  console.log(`WROTE  ${outSummary}  (${summary.length} bytes)`);
  console.log(`TOOLS  ${tools.length} unique entries across ${Object.keys(byCat).length} categories`);
  for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(15)} ${n}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
