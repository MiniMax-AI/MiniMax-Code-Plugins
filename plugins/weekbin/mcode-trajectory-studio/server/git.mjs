/**
 * Workspace identity: which repository does a session actually belong to?
 *
 * Sessions carry a `workspaceDir`, but one repository commonly shows up as several
 * directories — worktrees, sibling checkouts, subdirectories. Grouping by the raw
 * path therefore fragments a single project across the sidebar. Resolving the git
 * common directory instead folds every worktree of one repository into one group,
 * which is the unit a reader actually thinks in.
 *
 * `git rev-parse --git-common-dir` is used rather than `--show-toplevel` because
 * worktrees share the common directory, which is exactly the merge key we want.
 * Directories that are not in a git tree fall back to path grouping.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

const GIT_TIMEOUT_MS = 3000;
const MAX_CACHE_ENTRIES = 4096;

/** dir -> identity, so repeated renders do not re-spawn git. */
const identityCache = new Map();

/**
 * The environment variables `git` legitimately needs from this process.
 *
 * The full `process.env` used to be handed to the child, so every credential the
 * host exports — provider keys, API tokens, cloud sessions — was inherited by a
 * process spawned on a directory that came out of session data. `git rev-parse`
 * needs none of them, so it gets an allowlist. HOME/USERPROFILE stay because git
 * reads them to locate its own configuration, and the platform variables stay
 * because Windows needs them to resolve the binary and its DLLs.
 *
 * The user's `~/.gitconfig` is deliberately still honoured: that is where
 * `safe.directory` lives, and cutting it would turn every foreign-owned checkout
 * into a silent grouping fallback. Only *system* config is refused. The probe reads
 * no value out of either — `rev-parse` is a plumbing command with no hooks, no pager
 * and no credential lookup — and a repository-local alias cannot shadow a builtin,
 * which was measured against a `.git/config` carrying `alias.rev-parse`.
 */
const GIT_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'WINDIR', 'LANG', 'LC_ALL',
];

export function gitChildEnv() {
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value) env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    // No prompt helper and no interactive fallback: this probe must never block.
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_PAGER: 'cat',
  };
}

/** Switches that must hold regardless of what any config file says. */
const GIT_HARDENING = ['-c', 'core.fsmonitor=false', '-c', 'credential.helper='];

function runGit(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...GIT_HARDENING, ...args], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      env: gitChildEnv(),
    }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(String(stdout).trim());
    });
  });
}

function cache(key, value) {
  if (identityCache.size >= MAX_CACHE_ENTRIES) identityCache.clear();
  identityCache.set(key, value);
  return value;
}

function looksLikePath(dir) {
  return typeof dir === 'string' && dir.length > 0 && dir.length < 4096 && path.isAbsolute(dir);
}

/**
 * Resolve one workspace directory to a grouping identity.
 *
 * @returns {{key: string, label: string, kind: 'git'|'path', repoRoot: string|null,
 *            branch: string|null, worktree: boolean}}
 */
export async function resolveWorkspaceIdentity(dir) {
  if (!looksLikePath(dir)) {
    return { key: 'path:', label: '(无工作区)', kind: 'path', repoRoot: null, branch: null, worktree: false };
  }
  if (identityCache.has(dir)) return identityCache.get(dir);

  const commonDir = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) {
    const label = path.basename(dir) || dir;
    return cache(dir, { key: `path:${dir}`, label, kind: 'path', repoRoot: null, branch: null, worktree: false });
  }

  const repoRoot = path.dirname(commonDir);
  const branch = await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const perWorktree = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  // A worktree has its own git dir under the common dir; the main checkout does not.
  const worktree = Boolean(perWorktree) && perWorktree !== commonDir;

  return cache(dir, {
    key: `git:${repoRoot}`,
    label: path.basename(repoRoot) || repoRoot,
    kind: 'git',
    repoRoot,
    branch: branch && branch !== 'HEAD' ? branch : null,
    worktree,
  });
}

/** Resolve many directories concurrently, preserving the input order. */
export async function resolveWorkspaceIdentities(dirs) {
  const unique = [...new Set(dirs.filter(looksLikePath))];
  const resolved = new Map();
  const concurrency = 8;
  for (let index = 0; index < unique.length; index += concurrency) {
    const slice = unique.slice(index, index + concurrency);
    const values = await Promise.all(slice.map((dir) => resolveWorkspaceIdentity(dir)));
    slice.forEach((dir, offset) => resolved.set(dir, values[offset]));
  }
  return (dir) => resolved.get(dir) ?? {
    key: `path:${dir ?? ''}`, label: '(无工作区)', kind: 'path', repoRoot: null, branch: null, worktree: false,
  };
}

export function clearIdentityCache() {
  identityCache.clear();
}
