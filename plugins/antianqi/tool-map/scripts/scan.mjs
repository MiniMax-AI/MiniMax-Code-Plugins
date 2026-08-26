#!/usr/bin/env node
// tool-map / scan.mjs
// Cross-platform tool inventory scanner for the tool-map Plugin.
// Run: node scan.mjs [output.md]
//   - default output: $PLUGIN_DATA/tools.md, with .json and .summary.md siblings
//   - fallback when $PLUGIN_DATA is unset: $XDG_DATA_HOME/tool-map
//   - or: $HOME/.local/share/tool-map (XDG default)
//   - if argv[2] is given, the catalog is written to that path's directory
//
// Design: zero external deps, atomic bundle write (staging dir + rename), no
// hardcoded per-user absolute paths. All well-known locations are derived from
// the user's home directory, environment variables, or fixed POSIX conventions.
//
// Side effects: probes 15 well-known CLIs with `--version` (5s timeout each).
// See README.md "Side effects" section for the explicit list and the rationale.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  readdirSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync,
  realpathSync, renameSync as _fsRename, rmSync,
} from 'node:fs';
import { join, dirname, basename, sep, extname, resolve, delimiter } from 'node:path';
import { homedir, hostname, platform } from 'node:os';
import { randomBytes } from 'node:crypto';

const execFileP = promisify(execFile);

const PLATFORM = platform();
const HOME = homedir();
const IS_WIN = PLATFORM === 'win32';
const ENV = process.env;

// --- Test hook: TOOL_MAP_FAIL_AT_RENAME=N ---
// When set to a positive integer N, the Nth call to renameSync inside
// atomicWriteBundle throws. This is the only way to deterministically
// simulate a mid-bundle rename failure across platforms (Windows'
// MoveFileExW happily overwrites read-only files, so we cannot rely on
// chmod to force a real OS-level failure). Defaults to 0 (no hook).
const _failAtRename = Number(ENV.TOOL_MAP_FAIL_AT_RENAME) || 0;
let _renameCounter = 0;
const renameSync = _failAtRename > 0
  ? (src, dst) => {
      _renameCounter += 1;
      if (_renameCounter === _failAtRename) {
        throw new Error(
          `TOOL_MAP_FAIL_AT_RENAME=${_failAtRename} triggered on rename #${_renameCounter} (${src} -> ${dst})`,
        );
      }
      return _fsRename(src, dst);
    }
  : _fsRename;

// --- Output paths ---
// PLUGIN_DATA is set by the host runtime (mcode) when running plugin scripts.
// Fall back to the XDG_DATA_HOME convention, then the XDG default
// ($HOME/.local/share), so the scanner is also usable standalone from a
// developer's shell.
const DATA_ROOT = ENV.PLUGIN_DATA
  || (ENV.XDG_DATA_HOME && join(ENV.XDG_DATA_HOME, 'tool-map'))
  || join(HOME, '.local', 'share', 'tool-map');
const outMd = resolve(process.argv[2] || join(DATA_ROOT, 'tools.md'));
const outJson = outMd.replace(/\.md$/, '') + '.json';
const outSummary = outMd.replace(/\.md$/, '') + '.summary.md';

// --- Bundle atomic write ---
// Two-phase commit: every existing target file is first moved to a private
// backup directory, then the new contents are written into a staging
// directory, then each staging file is renamed onto its target. If any
// step fails, the previous bundle is restored exactly: names that had a
// target get their old contents back, and names that did NOT have a
// target are left absent (any partially-installed new content is removed).
// Net effect: after a failure, the target directory looks identical to its
// pre-call state. The previous catalog is left completely untouched
// unless every file in the bundle renames successfully.
//
// On POSIX `rename(2)` is atomic. On Windows `fs.renameSync` calls
// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`; same-volume moves are
// atomic from the caller's point of view. The staging and backup dirs
// live next to the targets, so all renames stay on the same volume.
//
// Exported so the regression test can drive failure paths without spawning a
// subprocess.
function atomicWriteBundle(targetDir, files) {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const pid = process.pid;
  const rand = randomBytes(8).toString('hex');
  const stagingDir = join(targetDir, `.bundle.staging-${pid}-${rand}`);
  const backupDir = join(targetDir, `.bundle.backup-${pid}-${rand}`);
  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  // Per-name state tracked across the three phases. Both start empty.
  //   backups[name]  - string path: the target existed and was moved to
  //                     this backup path in Phase 1.
  //                   - null: the target did NOT exist before Phase 1.
  //   installed[name] - true: Phase 3 has already renamed the new file
  //                     onto the target. Used to know whether a brand-new
  //                     file needs to be deleted on rollback.
  const backups = {};
  const installed = {};

  // Inverse of Phases 1+3: put every name back into the state it was in
  // before this call. Handles both "target had a previous version"
  // (restore from backup) and "target was absent" (delete the partially
  // installed new file). Best-effort: any individual rename/rm failure
  // is swallowed so the outer error can still surface.
  const restore = () => {
    for (const [name, backupPath] of Object.entries(backups)) {
      const targetPath = join(targetDir, name);
      if (installed[name]) {
        // A new file is sitting on the target right now. Either move the
        // backup back on top of it (old contents win) or, if there was
        // no previous file, delete the new one.
        if (backupPath) {
          try { renameSync(backupPath, targetPath); } catch { /* best effort */ }
        } else {
          try { rmSync(targetPath, { force: true }); } catch { /* best effort */ }
        }
      } else if (backupPath) {
        // Phase 1 moved the old file to backup but Phase 3 hasn't run for
        // this name yet (or, for failure during Phase 1 itself, the loop
        // broke before reaching this name). Move the old file back.
        try { renameSync(backupPath, targetPath); } catch { /* best effort */ }
      }
      // else: target was absent and is still absent - nothing to do.
    }
  };

  // Phase 1: back up any existing target files. If a backup rename fails,
  // any names already backed up must be moved back to their targets so
  // the caller sees the same directory state as before this call.
  try {
    for (const name of Object.keys(files)) {
      const targetPath = join(targetDir, name);
      if (existsSync(targetPath)) {
        const backupPath = join(backupDir, name);
        renameSync(targetPath, backupPath);
        backups[name] = backupPath;
      } else {
        backups[name] = null;
      }
    }
  } catch (err) {
    restore();
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* swallow */ }
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* swallow */ }
    throw err;
  }

  // Phase 2 + 3: write all new content into the staging dir, then rename
  // each onto its target. Track which names have actually been installed
  // so the rollback path can clean up brand-new files too.
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(stagingDir, name), contents, 'utf8');
    }
    for (const name of Object.keys(files)) {
      renameSync(join(stagingDir, name), join(targetDir, name));
      installed[name] = true;
    }
  } catch (err) {
    restore();
    try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* swallow */ }
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* swallow */ }
    throw err;
  }

  // Phase 4: success. Remove the backup and staging directories.
  try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* swallow */ }
  try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* swallow */ }
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
// The hardcoded list of names is the security boundary: only these exact
// basename strings are ever spawned. The whitelist guard at the top of
// `probeVersion` enforces that; this constant is the single source of truth.
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

const ALLOWED_PROBE_NAMES = new Set(VERSION_PROBES.map(([n]) => n));

// --- Per-program shell decision ---
// On Windows, .cmd and .bat files cannot be spawned via `execFile`
// without `shell: true` (CVE-2024-27980; Node.js >= 21.7.3). This Plugin
// requires Node >= 22, so the CVE fix is in force. Native .exe binaries
// and programs whose resolved extension is anything else are spawned
// directly with separate argv. POSIX never needs a shell for any of the
// whitelisted probes.
//
// The decision is per-program: it is made by walking $PATH and $PATHEXT
// to find the actual file the OS will execute when the user types the
// program name. A same-named wrapper that resolves to an `.exe` is
// treated as a native binary; a wrapper that resolves to a `.cmd` is
// treated as a shim and routed through `cmd.exe`.
//
// `shellForFile` is the pure decision over a single resolved path.
// `resolveProgram` walks $PATH/$PATHEXT to find the actual file.
// `shouldUseShell` composes the two. All three are exported so the
// regression test can exercise the path-and-extension logic without
// spawning a subprocess.

function shellForFile(resolvedPath) {
  if (!IS_WIN) return false;
  if (!resolvedPath) return false;
  return /\.(cmd|bat)$/i.test(resolvedPath);
}

function resolveProgram(name) {
  const pathDirs = (ENV.PATH || '')
    .split(delimiter)
    .map((d) => d.trim())
    .filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(name);
  let candidates;
  if (IS_WIN) {
    if (hasExt) {
      candidates = [name];
    } else {
      const pathext = (ENV.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC')
        .split(';')
        .map((e) => e.trim())
        .filter(Boolean);
      candidates = pathext.map((ext) => name + ext);
    }
  } else {
    candidates = [name];
  }
  for (const dir of pathDirs) {
    for (const cand of candidates) {
      const full = join(dir, cand);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function shouldUseShell(name) {
  return shellForFile(resolveProgram(name));
}

async function probeVersion(cmd) {
  // Defence-in-depth: even if a future caller misuses this function, only
  // whitelisted basenames can ever be spawned. fail-closed.
  if (!ALLOWED_PROBE_NAMES.has(cmd[0])) return null;
  try {
    const { stdout } = await execFileP(cmd[0], cmd.slice(1), {
      timeout: 5000,
      windowsHide: true,
      shell: shouldUseShell(cmd[0]),
    });
    const first = (stdout || '').split(/\r?\n/)[0].trim();
    if (first) return first;
  } catch { /* timeout, missing, or non-zero exit - all OK */ }
  return null;
}

// --- File walker ---
const NPM_BIN_HINT = /minimax-code[\\\/]|openclaw[\\\/]|minimax[\\\/]bin|node_modules[\\\/]|\.Codex[\\\/]|\.claude[\\\/]|[\\\/]npm[\\\/]|tauri[\\\/]/i;
function isToolFile(name, size, dirLower, stat) {
  if (name.startsWith('.')) return false; // dotfiles (.gitignore, .npmrc, ...) are not tools
  const ext = extname(name).toLowerCase();
  if (ext !== '') {
    if (!EXEC_EXTS.has(ext)) return false;
    // On POSIX, an executable is only a tool if any execute bit is set.
    // Windows ignores the execute bit, so skip the check there.
    if (!IS_WIN && !(stat.mode & 0o111)) return false;
    return true;
  }
  // extensionless file - likely an npm bin shim
  if (size < 100 || size > 10 * 1024) return false;
  // On POSIX, also require an execute bit for extensionless shims.
  if (!IS_WIN && !(stat.mode & 0o111)) return false;
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
      if (!isToolFile(e.name, st.size, (dir + sep).toLowerCase(), st)) continue;
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
  sb.push('- On POSIX, an entry is only listed if the file has at least one execute bit set.');
  sb.push('- Writes are bundle-atomic: staging dir + per-file rename + rollback. A failure mid-bundle leaves the previous catalog untouched.');
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

  // 4) Dedupe by full path (preserve case). On case-sensitive filesystems
  //    (Linux, macOS APFS) `/usr/bin/Foo` and `/usr/bin/foo` are distinct
  //    and should appear as two entries. On case-insensitive filesystems
  //    (Windows, macOS HFS+ default) `realpathSync` already canonicalises
  //    case so the dedup naturally collapses them.
  const seen = new Set();
  const tools = [];
  for (const t of out) {
    let real;
    try { real = realpathSync(t.path); } catch { real = t.path; }
    if (seen.has(real)) continue;
    seen.add(real);
    tools.push({ ...t, path: real });
  }
  tools.sort((a, b) => a.path.localeCompare(b.path));

  // 5) Version probes (parallel). Each name is whitelisted in
  //    ALLOWED_PROBE_NAMES inside probeVersion.
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

  // 7) Render and write the bundle atomically
  const md = renderMarkdown({ scanned: startTs, pf: PLATFORM, host: hostname(), core, extras, tools });
  const json = { scanned: startTs, platform: PLATFORM, host: hostname(), core, extras, tools };
  const summary = renderSummary({ scanned: startTs, pf: PLATFORM, core, extras, tools });
  const outDir = dirname(outMd);
  atomicWriteBundle(outDir, {
    [basename(outMd)]: md,
    [basename(outJson)]: JSON.stringify(json, null, 2),
    [basename(outSummary)]: summary,
  });

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

// Detect "run directly" vs "imported" so the regression test can import
// `atomicWriteBundle` etc. without spawning a subprocess.
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
})();

export {
  atomicWriteBundle, ALLOWED_PROBE_NAMES, VERSION_PROBES,
  isToolFile, classify, walk,
  renderMarkdown, renderSummary,
  resolveProgram, shellForFile, shouldUseShell,
  probeVersion,
};

if (isMain) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
