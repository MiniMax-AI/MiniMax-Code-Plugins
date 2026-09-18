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
      // under -File, which breaks the exec argv on real installs. When several
      // installs coexist (PATH shim with an old sibling, newer official root),
      // resolve the NEWEST cli.js across layouts instead of whatever sits next to
      // the resolved shim — a stale 0.2.x entry lacks current exec flags.
      const root = officialRoot(home, env);
      const candidates = [
        join(dirname(path), 'node_modules', '@minimax-ai', 'code', 'cli.js'),
        join(root, 'lib', 'node_modules', '@minimax-ai', 'code', 'cli.js'),
        join(root, 'node_modules', '@minimax-ai', 'code', 'cli.js'),
      ];
      // The staged-installer layout keeps the current CLI under
      // releases/<version>/node_modules — the same entry .mcode-launcher.cmd
      // targets. Older roots can leave a stale flat node_modules behind, so these
      // compete on version like every other candidate.
      try {
        for (const entry of await readdir(join(root, 'releases'), { withFileTypes: true }))
          if (entry.isDirectory()) candidates.push(join(root, 'releases', entry.name, 'node_modules', '@minimax-ai', 'code', 'cli.js'));
      } catch { /* no releases directory */ }
      const versionOf = async entry => { try {
        const pkg = JSON.parse(await readFile(join(entry, '..', 'package.json'), 'utf8'));
        return String(pkg.version ?? '0.0.0').split('.').map(n => Number.parseInt(n, 10) || 0);
      } catch { return [0, 0, 0]; } };
      const cmp = (a, b) => a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0) || b.length - a.length;
      let best = null, bestVersion = null;
      for (const entry of candidates) {
        if (!await fileExists(entry)) continue;
        const version = await versionOf(entry);
        if (!best || cmp(version, bestVersion) > 0) { best = entry; bestVersion = version; }
      }
      if (best) return { command: process.execPath, args: [best], source };
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
