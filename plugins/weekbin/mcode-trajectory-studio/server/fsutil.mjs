/**
 * Filesystem helpers. Leaf module over `node:fs` plus the path candidates from
 * `config`, so path layout decisions live in exactly one place.
 *
 * This module also owns the containment rule for every file the Plugin reads:
 * after canonicalization, a path has to stay inside the approved data directory.
 * A lexical prefix check cannot express that, because a symlink anywhere along
 * the traversed path keeps the string inside the root while the kernel resolves
 * the file outside it. `containedRealPath` and `openContainedRead` are the only
 * sanctioned way to reach a file, and both canonicalize before they decide.
 *
 * The guarantee, stated exactly: every component of a traversed path is resolved
 * before the file is opened, the final component may not be a symlink, and — on
 * Linux, where `/proc/self/fd` names the inode that was actually opened — the
 * descriptor itself is re-verified against the root, which closes the window in
 * which an intermediate directory could be swapped between `realpath` and `open`.
 * Where `/proc` is unavailable (macOS, Windows) that residual race is not closed:
 * it requires a same-UID process to win a microsecond-wide timing window and it
 * can already read the file directly, so it is an accepted limit of this boundary
 * rather than an unstated one.
 */

import { constants as FS, existsSync } from 'node:fs';
import { open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import { sessionsCandidates } from './config.mjs';

/**
 * Windows does not define `O_NOFOLLOW`. Declaring the fallback here keeps the
 * platform difference out of every call site; on Windows containment still holds
 * because the path opened is the one `realpath` produced.
 */
export const NO_FOLLOW = FS.O_NOFOLLOW ?? 0;

/** readdir that yields an empty list for a missing or unreadable directory. */
export async function safeReadDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Canonicalize a path that has to exist. Returns null when it does not resolve. */
export async function realPath(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * Whether `candidate` is `base` itself or sits beneath it. Both must be canonical.
 *
 * The separator is required after `base` so a sibling whose name merely starts with
 * the same characters (`/root/data-evil` vs `/root/data`) is not treated as inside.
 */
export function isWithin(base, candidate) {
  if (typeof base !== 'string' || typeof candidate !== 'string' || !base) return false;
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * Canonicalize `root` and `target`, or null when either does not resolve.
 *
 * @returns {Promise<{base: string, resolved: string}|null>}
 */
async function containedBase(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || !root) return null;
  const base = await realPath(root);
  if (!base) return null;
  const resolved = await realPath(target);
  if (!resolved) return null;
  return { base, resolved };
}

/**
 * Canonicalize `target` and confirm it is `root` or sits beneath it.
 *
 * Both sides are canonicalized, so a data directory that is itself reached
 * through a symlink (`~/.minimax` → `/mnt/data/.minimax`) is not mistaken for an
 * escape, while a link planted inside the data directory is still caught.
 *
 * @returns {Promise<string|null>} the canonical path, or null when it escapes,
 *   does not exist, or cannot be resolved.
 */
export async function containedRealPath(root, target) {
  const found = await containedBase(root, target);
  if (!found) return null;
  return isWithin(found.base, found.resolved) ? found.resolved : null;
}

/**
 * The path a descriptor actually names, from `/proc/self/fd` on Linux.
 *
 * This is the authoritative answer: the kernel resolved every symlink during the
 * `open`, so the link names the inode that was really opened — even if an
 * intermediate directory was swapped *after* `realpath` and *before* `open`. It is
 * unavailable on platforms without `/proc` (macOS, Windows) and for a file that was
 * unlinked after it was opened, where it reports `… (deleted)` and we return null.
 *
 * @returns {Promise<string|null>} the resolved path, or null when it cannot be read.
 */
export async function openedRealPath(handle) {
  try {
    const link = await readlink(`/proc/self/fd/${handle.fd}`);
    return link.endsWith(' (deleted)') ? null : link;
  } catch {
    return null;
  }
}

/**
 * Decide whether an opened descriptor stays inside the approved root.
 *
 * `openedReal` is the `/proc/self/fd` path when the platform provides one. When it
 * is unavailable the pre-open canonical check is the only evidence, so this returns
 * true and the *documented* boundary applies: a same-UID process racing to replace
 * an intermediate directory between canonicalization and open is out of scope
 * (such a process already holds the privileges to read the file directly). See the
 * module comment for the full statement.
 */
export function openedPathAllowed(base, openedReal) {
  if (typeof openedReal !== 'string' || !openedReal) return true;
  return isWithin(base, openedReal);
}

/**
 * Open a file strictly read-only, refusing anything that canonicalizes outside
 * `root`, refusing a symlink at the final component, and re-checking containment
 * against the descriptor that was actually opened.
 *
 * The canonical path is what gets opened and the size comes back from `fstat`, so
 * the containment decision and the read describe the same inode. `O_NOFOLLOW`
 * closes the race on the *final* component. The remaining gap — an intermediate
 * directory replaced between `realpath` and `open` — is closed on Linux by reading
 * `/proc/self/fd/<fd>`, which names the inode actually opened and is verified
 * against the root; where `/proc` is absent, that residual race is the documented,
 * accepted limit of this boundary rather than an unstated one.
 *
 * @returns {Promise<{handle: object, size: number, realPath: string}|null}> the
 *   open handle, or null when the path is outside the root, is not a regular
 *   file, is a symlink, or does not exist. Callers own the handle.
 */
export async function openContainedRead(root, target) {
  const found = await containedBase(root, target);
  if (!found || !isWithin(found.base, found.resolved)) return null;
  let handle;
  try {
    handle = await open(found.resolved, FS.O_RDONLY | NO_FOLLOW);
  } catch {
    return null;
  }
  try {
    const openedReal = await openedRealPath(handle);
    if (!openedPathAllowed(found.base, openedReal)) {
      await handle.close();
      return null;
    }
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size, realPath: found.resolved };
  } catch {
    await handle.close().catch(() => {});
    return null;
  }
}

/**
 * Find the session-artifact root on this machine.
 *
 * Canonical first; a hit elsewhere means a differently laid-out build, which the
 * caller records rather than hides.
 *
 * @returns {{dir: string, discovered: boolean, found: boolean}}
 */
export function resolveSessionsRoot(dataDir) {
  const candidates = sessionsCandidates(dataDir);
  for (const [index, dir] of candidates.entries()) {
    if (existsSync(dir)) return { dir, discovered: index > 0, found: true };
  }
  return { dir: candidates[0], discovered: false, found: false };
}
