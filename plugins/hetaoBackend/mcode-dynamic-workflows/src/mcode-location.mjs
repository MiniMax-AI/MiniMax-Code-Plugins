import { access, stat, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const officialRoot = (home = homedir(), env = process.env) => resolve(env.MCODE_INSTALL_DIR || join(home, '.minimax-code'));
export const managedPrefix = (home = homedir()) => join(home, '.mcode-dynamic-workflows', 'toolchain');
export const managedEntry = (home = homedir(), platform = process.platform) => join(managedPrefix(home), ...(platform === 'win32' ? [] : ['lib']), 'node_modules', '@minimax-ai', 'code', 'cli.js');
async function fileExists(file, executable = false, platform = process.platform) {
  try { await access(file, executable && platform !== 'win32' ? constants.X_OK : constants.F_OK); return (await stat(file)).isFile(); } catch { return false; }
}
export async function executablePath(command, env = process.env, platform = process.platform) {
  if (typeof command !== 'string' || !command) return null;
  const direct = /[\\/]/.test(command);
  const dirs = direct ? [''] : (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  // win32: an extensionless probe is only valid when the command itself already
  // carries a PATHEXT extension (pwsh.exe). For bare names (mcode) install roots
  // ship an extensionless POSIX shim beside mcode.cmd; matching '' first resolves
  // to a script Windows cannot spawn (ENOENT), so bare names match PATHEXT
  // variants only. POSIX keeps the bare name as the only form.
  const dotted = /\.[a-z0-9]+$/i.test(command);
  const extensions = platform === 'win32'
    ? [...(dotted ? [''] : []), ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) for (const ext of extensions) {
    const file = direct ? resolve(command + ext) : resolve(join(dir, command + ext));
    if (await fileExists(file, true, platform)) return file;
  }
  return null;
}
// Extract the cli.js entry a .mcode-launcher.cmd script references — the
// authoritative active target. Field-verified basis: on a real Windows install
// the staged installer writes mcode.cmd delegating to .mcode-launcher.cmd, and
// nothing else records "active" (.mcode-active/ is a PID heartbeat directory,
// install.json carries no version field, the package ships no launcher writer),
// so the cli.js that script invokes IS the release the installed launcher
// runs. %~dp0 (the script's own drive+path, trailing separator included) is
// expanded to the launcher directory; backslashes are normalized so the
// reference also resolves when a win32 layout is probed by a POSIX-hosted
// resolver (Windows APIs accept both separators). Returns null when no
// extractable reference points at an existing file.
async function launcherEntry(script, dir) {
  try {
    const ref = (await readFile(script, 'utf8')).match(/[^\s"'*]*node_modules[^\s"'*]*cli\.js/)?.[0];
    if (!ref) return null;
    const entry = resolve(dir, ref.replace(/%~dp0/gi, () => `${dir.replace(/\\/g, '/')}/`).replace(/\\/g, '/'));
    return await fileExists(entry) ? entry : null;
  } catch { return null; }
}
// Return argv separately: neither the installer nor the executor needs a shell.
export async function resolveMcode(command = 'mcode', { env = process.env, home = homedir(), platform = process.platform } = {}) {
  let path = await executablePath(command, env, platform);
  let source = 'path';
  if (!path && command === 'mcode') {
    path = await executablePath(join(officialRoot(home, env), ...(platform === 'win32' ? [] : ['bin']), 'mcode'), env, platform);
    source = 'official-user-install';
  }
  if (path) {
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(path)) {
      // Prefer a directly spawnable node entry over the .ps1 hop: PowerShell 5.1
      // binds flag-shaped tokens (-input, --cwd ...) as its own named parameters
      // under -File, which breaks the exec argv on real installs.
      //
      // Authoritative active target first: when .mcode-launcher.cmd sits beside
      // the resolved shim, the cli.js it references is returned verbatim, before
      // any version arithmetic — the launcher runs what it runs, so we run what
      // it runs, and rollbacks and channel switches are followed for free.
      const active = await launcherEntry(join(dirname(path), '.mcode-launcher.cmd'), dirname(path));
      if (active) return { command: process.execPath, args: [active], source };
      // No launcher pointer: fall back to ranking every coexisting layout by
      // version. When several installs coexist (PATH shim with an old sibling,
      // newer official root) a stale 0.2.x entry lacks current exec flags.
      const root = officialRoot(home, env);
      const candidates = [
        { entry: join(dirname(path), 'node_modules', '@minimax-ai', 'code', 'cli.js'), tie: '' },
        { entry: join(root, 'lib', 'node_modules', '@minimax-ai', 'code', 'cli.js'), tie: '' },
        { entry: join(root, 'node_modules', '@minimax-ai', 'code', 'cli.js'), tie: '' },
      ];
      // The staged-installer layout keeps the current CLI under
      // releases/<version>/node_modules — the same entry .mcode-launcher.cmd
      // targets. Older roots can leave a stale flat node_modules behind, so these
      // compete on version like every other candidate.
      try {
        for (const entry of await readdir(join(root, 'releases'), { withFileTypes: true }))
          if (entry.isDirectory()) candidates.push({ entry: join(root, 'releases', entry.name, 'node_modules', '@minimax-ai', 'code', 'cli.js'), tie: entry.name });
      } catch { /* no releases directory */ }
      // Ranking policy (full SemVer over each candidate's package.json version):
      // stable (no prerelease) outranks ANY prerelease, even a higher-numbered
      // one — a channel policy: the fallback never promotes a prerelease while
      // any stable is installed; within a class, SemVer core decides, then
      // prerelease identifiers compare per SemVer — numeric identifiers
      // numerically, alphanumeric lexically, numeric below alphanumeric, and a
      // longer identifier list outranks a shorter equal prefix; build metadata
      // (+...) is ignored. Versions that fail to parse rank lowest. A complete
      // tie (same SemVer in several directories, e.g. releases/0.4.12 vs
      // releases/0.4.12+build.2) breaks by directory name, lexicographically
      // greatest; flat non-release candidates carry '' and lose that tie to any
      // release directory (the staged releases layout is the current shape).
      const parseSemVer = value => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value ?? '').trim());
        if (!m) return null;
        return {
          core: [Number(m[1]), Number(m[2]), Number(m[3])],
          pre: m[4] === undefined ? null : m[4].split('.').map(id => ({ numeric: /^\d+$/.test(id), value: id })),
        };
      };
      const cmpSemVer = (a, b) => {
        if (!a || !b) return !a && !b ? 0 : a ? 1 : -1; // unparseable ranks lowest
        if (!a.pre !== !b.pre) return a.pre ? -1 : 1; // stable channel outranks any prerelease
        const core = a.core[0] - b.core[0] || a.core[1] - b.core[1] || a.core[2] - b.core[2];
        if (core) return core;
        if (!a.pre) return 0; // both stable, equal core
        for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
          const x = a.pre[i], y = b.pre[i];
          if (!x || !y) return x ? 1 : -1; // longer identifier list outranks its prefix
          if (x.numeric && y.numeric) { if (x.value !== y.value) return Number(x.value) - Number(y.value); }
          else if (x.numeric !== y.numeric) return x.numeric ? -1 : 1; // numeric < alphanumeric
          else if (x.value !== y.value) return x.value < y.value ? -1 : 1;
        }
        return 0;
      };
      const versionOf = async entry => { try { return parseSemVer(JSON.parse(await readFile(join(entry, '..', 'package.json'), 'utf8')).version); } catch { return null; } };
      let best = null;
      for (const candidate of candidates) {
        if (!await fileExists(candidate.entry)) continue;
        const version = await versionOf(candidate.entry);
        if (!best || cmpSemVer(version, best.version) > 0 || (cmpSemVer(version, best.version) === 0 && candidate.tie > best.tie)) best = { ...candidate, version };
      }
      if (best) return { command: process.execPath, args: [best.entry], source };
      const launcher = join(dirname(path), 'mcode.ps1');
      if (await fileExists(launcher)) {
        // pwsh (PS7) first: PS 5.1 binds flag-shaped argv as its own named parameters
        // under -File and does not forward piped stdin through the nested invocation.
        const powershell = await executablePath('pwsh.exe', env, platform) ?? await executablePath('powershell.exe', env, platform);
        if (!powershell) throw new Error('发现 MCode PowerShell 启动器，但找不到 PowerShell。');
        return { command: powershell, args: ['-NoProfile', '-File', launcher], source };
      }
      throw new Error(`发现 ${path}，但找不到可直接执行的 cli.js；请修复该 CLI 安装。`);
    }
    return { command: path, args: [], source };
  }
  if (command === 'mcode') {
    const entry = managedEntry(home, platform);
    if (await fileExists(entry)) return { command: process.execPath, args: [entry], source: 'workflow-managed' };
  }
  return null;
}
