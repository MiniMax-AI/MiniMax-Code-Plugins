#!/usr/bin/env node
// omarchy-audit — dependency-free stdio MCP server for static security triage
// of an Omarchy checkout.
//
// Design constraints (deliberate, and each one earned):
//
//  1. DISCOVERY IS SHEBANG-BASED, NOT EXTENSION-BASED. Omarchy's bin/ ships 444
//     scripts and *zero* of them end in .sh — they are all extensionless. The
//     464 real .sh files live in test/, migrations/, and install/. A
//     `find -name '*.sh'` hunt therefore skips the entire shipped command
//     surface and spends its budget on test fixtures. `find -name '*'` plus a
//     shebang test is the only correct discovery strategy here.
//
//  2. NEVER EXECUTES ANYTHING FROM THE TARGET TREE. shellcheck and semgrep read
//     files; they do not run them. This server only ever spawns those two
//     analyzers, never a target script.
//
//  3. NO NETWORK AT ANY POINT. The already-fixed map is embedded below rather
//     than fetched, so a sweep works offline and cannot phone home.
//
//  4. WRITES NOTHING. Read-only, so it is safe to point at a production-like
//     checkout. Its own Plugin directory is the only thing it may read.
//
//  5. NEVER SUBMITS ANYTHING. It emits a table; a human decides what to report.

import { readdir, readFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const SERVER = 'omarchy-audit';
const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// The already-fixed map.
//
// Omarchy shipped 27 security fixes across v4.0.1, v4.0.2 and v4.0.3. Only 8
// of them appear in most summaries, which is how a family gets re-reported. Each
// entry below is (file, family) where "family" is the REMEDY, because the hunt is
// for siblings that lack the remedy, not for restatements of the same fix.
//
// Sourced from the v4.0.1/4.0.2/4.0.3 release notes and the corresponding
// commits, verified against the v4.0.4 tree.
// ---------------------------------------------------------------------------
const KNOWN_FIXED = [
  { file: 'bin/omarchy-dns', pr: 8172, family: 'root-helper-path-pinning', remedy: 'export PATH= to trusted system dirs when EUID == 0' },
  { file: 'bin/omarchy-theme-set-browser-policy', pr: 8172, family: 'root-helper-path-pinning', remedy: 'export PATH= when EUID == 0' },
  { file: 'etc/sudoers.d/omarchy-tzupdate', pr: 8194, family: 'sudoers-argument-allowlist', remedy: 'anchor the argument with a regex in sudoers itself' },
  { file: 'etc/sudoers.d/omarchy-theme-browser', pr: null, family: 'sudoers-argument-allowlist', remedy: 'constrain the argument to exactly 6 hex chars' },
  { file: 'etc/sudoers.d/omarchy-dns', pr: null, family: 'sudoers-argument-allowlist', remedy: 'bare-word argument list' },
  { file: 'bin/omarchy-setup-security-fido2', pr: 7904, family: 'predictable-temp-path', remedy: 'mktemp with a template instead of a fixed /tmp path' },
  { file: 'bin/omarchy-remove-security-fido2', pr: 7904, family: 'predictable-temp-path', remedy: 'mktemp with a template' },
  { file: 'migrations/1787494718.sh', pr: 7904, family: 'predictable-temp-path', remedy: 'mktemp with a template' },
  { file: 'bin/omarchy-hyprland-monitor-clamshell', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'escape backslash and quote before embedding in Lua' },
  { file: 'bin/omarchy-hyprland-monitor-internal', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'escape before embedding in Lua' },
  { file: 'bin/omarchy-hyprland-monitor-internal-mirror', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'escape before embedding in Lua' },
  { file: 'bin/omarchy-hyprland-monitor-scaling', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'escape before embedding in Lua' },
  { file: 'bin/omarchy-toggle-input-device', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'Lua-escape the device name and reject control characters' },
  { file: 'default/hypr/disabled-input-device.lua', pr: 8129, family: 'untrusted-name-into-script-engine', remedy: 'read the name back as data, not code' },
  { file: 'bin/omarchy-chromium-ytdlp-host', pr: 7847, family: 'media-metadata-into-command', remedy: 'do not let a video title become a play command' },
  { file: 'bin/omarchy-install-and-launch', pr: 7843, family: 'unquoted-name-into-command', remedy: 'quote the app name' },
  { file: 'bin/omarchy-install-app', pr: 7843, family: 'unquoted-name-into-command', remedy: 'quote the app name' },
  { file: 'bin/omarchy-install-font', pr: 7843, family: 'unquoted-name-into-command', remedy: 'quote the font name' },
  { file: 'bin/omarchy-webapp-install', pr: 8496, family: 'untrusted-url-into-desktop-entry', remedy: 'validate the URL and escape desktop entry values' },
  { file: 'bin/omarchy-hibernation-setup', pr: null, family: 'installed-file-ownership', remedy: 'chown/chmod the installed sleep hook' },
  { file: 'bin/omarchy-toggle-hybrid-gpu', pr: null, family: 'installed-file-ownership', remedy: 'chown/chmod the installed hook' },
  { file: 'bin/omarchy-sudo-passwordless', pr: 9387, family: 'sudo-grant-lifetime', remedy: 'fail closed without an expiry' },
  { file: 'etc/tmpfiles.d/omarchy-nopasswd-sudo.conf', pr: 9387, family: 'sudo-grant-lifetime', remedy: 'expiry enforced by tmpfiles' },
  { file: 'bin/omarchy-sudo-reset', pr: 8046, family: 'dangerous-privileged-helper-removed', remedy: 'helper deleted outright' },
  { file: 'shell/Ui/PluginBarApi.qml', pr: 9618, family: 'plugin-privilege-boundary', remedy: 'restrict plugin access to auth services' },
  { file: 'bin/omarchy-apply-lock', pr: 10225, family: 'privileged-command-lookup', remedy: 'do not resolve the helper from a mutable PATH' },
  { file: 'bin/omarchy-upgrade-to-quattro', pr: 10225, family: 'privileged-command-lookup', remedy: 'do not resolve the helper from a mutable PATH' },
  { file: 'bin/omarchy-setup-security-sshd', pr: 9200, family: 'unprivileged-input-escalation', remedy: 'close unprivileged input and SSH escalation paths' },
  { file: 'bin/omarchy-provision-owner', pr: 9200, family: 'unprivileged-input-escalation', remedy: 'close unprivileged input paths' },
  { file: 'bin/omarchy-refresh-plymouth', pr: 8934, family: 'privileged-file-publication', remedy: 'fix the publication race / ownership' },
  { file: 'bin/omarchy-refresh-sddm', pr: 8934, family: 'privileged-file-publication', remedy: 'fix the publication race / ownership' },
  { file: 'bin/omarchy-plymouth-set', pr: 8934, family: 'privileged-file-publication', remedy: 'fix the publication race / ownership' },
  { file: 'bin/omarchy-dev-link', pr: 8934, family: 'privileged-file-publication', remedy: 'fix the publication race / ownership' },
  { file: 'bin/omarchy-windows-vm', pr: 8419, family: 'mount-boundary', remedy: 'constrain the Windows VM host mounts' },
  { file: 'etc/cups/cups-browsed.conf', pr: 8627, family: 'privileged-service-surface', remedy: 'harden CUPS printer discovery' },
  { file: 'etc/systemd/system/cups-browsed.service.d/10-omarchy.conf', pr: 8627, family: 'privileged-service-surface', remedy: 'harden CUPS printer discovery' },
  { file: 'bin/omarchy-notification-send', pr: 7926, family: 'notification-into-command', remedy: 'call the D-Bus API directly instead of notify-send argv' },
];

// A hit in one of these files is almost never a new finding on its own: it is
// either the fix itself or a line adjacent to it.
const FIXED_FILES = new Set(KNOWN_FIXED.map((e) => e.file));

// ---------------------------------------------------------------------------

const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules', 'test', 'tests', 'vendor']);

/** Read the first bytes of a file to test for an interpreter shebang. */
async function shebangOf(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buf = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buf, 0, 256, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const m = head.match(/^#!\s*(\S+)(?:\s+(\S+))?/);
    if (!m) return null;
    const interp = path.basename(m[1]);
    // An explicit interpreter on the shebang line wins; otherwise assume bash,
    // which is what omarchy's bin/ uses.
    if (m[2] && !m[2].startsWith('-')) return m[2];
    if (interp === 'env') return null;
    return /^(ba|z|k|da)?sh$/.test(interp) ? 'sh' : null;
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Walk `root` and return every shell script, found by shebang. */
async function discoverScripts(root, { includeSkipped = false } = {}) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the target
      if (e.isDirectory()) {
        if (!includeSkipped && DEFAULT_SKIP_DIRS.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (await shebangOf(full)) {
        out.push({
          path: path.relative(root, full),
          kind: path.relative(root, full).split(path.sep)[0],
        });
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: String(e) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Batch shellcheck over discovered scripts. Reads files; never runs them. */
async function shellcheckRun(root, severity = 'warning') {
  const scripts = await discoverScripts(root);
  if (scripts.length === 0) return { findings: [], scriptsChecked: 0, note: 'no shebang scripts found' };
  const files = scripts.map((s) => path.join(root, s.path));
  const res = await run('shellcheck', ['-s', 'bash', '-S', severity, '-f', 'gcc', ...files], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.code === -1) {
    return { findings: [], scriptsChecked: scripts.length, note: `shellcheck unavailable: ${res.stderr.trim()}` };
  }
  const findings = res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      // gcc format: path:line:col: severity: message [SC####]
      const m = line.match(/^(.*?):(\d+):(\d+):\s*(\w+):\s*(.*?)\s*\[(SC\d+)\]$/);
      if (!m) return null;
      return {
        file: path.relative(root, m[1]),
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4],
        message: m[5],
        rule: m[6],
      };
    })
    .filter(Boolean)
    .map((f) => ({ ...f, status: classify(f.file, f.line) }));
  return { findings, scriptsChecked: scripts.length, note: 'shellcheck never executes target scripts' };
}

/** Tag a hit as already-fixed-pattern or new, by file. */
function classify(file, _line) {
  const norm = file.replace(/^\.\//, '');
  if (FIXED_FILES.has(norm)) return 'already-fixed-pattern';
  return 'new';
}

function table(findings) {
  const rows = findings.map((f) => ({
    component: f.file,
    'file:line': `${f.file}:${f.line}`,
    rule: f.rule,
    severity: f.severity,
    status: f.status,
  }));
  return { columns: ['component', 'file:line', 'rule', 'severity', 'status'], rows };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC 2.0 over stdio, Content-Length framing not required by MCP
// (MCP stdio uses newline-delimited JSON).
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'discover_scripts',
    description:
      'Walk a target tree and return every shell script, detected by shebang rather than file extension. Use this first: omarchy ships 444 extensionless scripts under bin/ and a *.sh glob finds none of them.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Path to the checkout root' },
        includeSkipped: { type: 'boolean', description: 'Also walk test/, tests/, vendor/ (off by default)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'shellcheck_run',
    description: 'Run shellcheck over every shebang-discovered script and return findings, each tagged already-fixed-pattern or new.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        severity: { type: 'string', enum: ['error', 'warning', 'info', 'style'], default: 'warning' },
      },
      required: ['root'],
    },
  },
  {
    name: 'classify',
    description: 'Tag a file (and optionally a line) as already-fixed-pattern or new, using the embedded 4.0.1-4.0.3 fix map.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' } },
      required: ['file'],
    },
  },
  {
    name: 'findings_table',
    description: 'Format shellcheck findings as component | file:line | rule | severity | status.',
    inputSchema: {
      type: 'object',
      properties: { findings: { type: 'array', items: { type: 'object' } } },
      required: ['findings'],
    },
  },
  {
    name: 'known_fixed',
    description: 'Return the embedded already-fixed map: file, PR, family, and the remedy used. Consult before writing any report so an already-patched issue is not re-reported.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  switch (name) {
    case 'discover_scripts':
      return { scripts: await discoverScripts(args.root, { includeSkipped: args.includeSkipped }) };
    case 'shellcheck_run': {
      const r = await shellcheckRun(args.root, args.severity || 'warning');
      return { ...r, table: table(r.findings) };
    }
    case 'classify':
      return { file: args.file, line: args.line ?? null, status: classify(args.file, args.line) };
    case 'findings_table':
      return table(args.findings || []);
    case 'known_fixed':
      return { count: KNOWN_FIXED.length, entries: KNOWN_FIXED };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER, version: VERSION },
      } });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      try {
        const out = await callTool(params.name, params.arguments || {});
        return send({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } });
      }
    }
    default:
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line)).catch((e) => send({ jsonrpc: '2.0', method: 'error', params: { message: String(e) } }));
  }
});
