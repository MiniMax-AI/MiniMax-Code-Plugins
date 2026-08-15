// lib/lint.js — Wrap the mavis skill-creator lint script.
//
// The official `lint-skill.js` ships as ES module source but is named
// with a `.js` extension and is not under a package.json with
// `"type": "module"`. Spawning `node` on it fails with a confusing
// SyntaxError. We avoid the problem by importing the source via the
// data: URL trick (Node will parse it as ESM when the import assertion
// says so) or by reading the source and eval-ing it.
//
// v0.1 uses the dynamic import path: read the file, write a temp
// `.mjs` next to it, then dynamic-import that. This stays compatible
// with all Node 22+ setups.
//
// IMPORTANT: the staged `.mjs` MUST NOT live in `~/.minimax/.builtin-skills/`
// or any other user-install location. We use a unique temp dir under
// `os.tmpdir()` and remove it in a `finally` block on every code path
// (success, lint failure, spawn error).

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

/**
 * Stage `lintScript` as a `.mjs` in a fresh temp directory.
 *
 * Returns `{ dir, mjs }`. Caller is responsible for `fs.rm(dir, ...)`
 * when done. Never writes into the user's install area.
 */
async function stageMjsInTmp(lintScript) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-lint-${process.pid}-`));
  const mjs = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.mjs`);
  const src = await fs.readFile(lintScript, 'utf-8');
  await fs.writeFile(mjs, src, 'utf-8');
  return { dir, mjs };
}

/**
 * @param {string} skillPath
 * @param {object} [opts]
 * @param {string} [opts.lintScript]
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string }>}
 */
export async function lintSkill(skillPath, opts = {}) {
  const lintScript = opts.lintScript
    || path.join(os.homedir(), '.minimax', '.builtin-skills', 'skill-creator', 'scripts', 'lint-skill.js');

  // Fast path: dynamic import the script in-process. No files written.
  // Handle both ESM (`export function lint`) and CJS interop
  // (`module.exports.lint` shows up at `mod.default.lint`).
  try {
    const mod = await import(pathToFileURL(lintScript).href);
    const fn = typeof mod.lint === 'function'
      ? mod.lint
      : (mod.default && typeof mod.default.lint === 'function' ? mod.default.lint : null);
    if (fn) {
      const result = await fn(skillPath);
      return { ok: result.ok ?? true, code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
  } catch (e) {
    // Fall through to subprocess path
  }

  // Subprocess path: stage as .mjs in a unique temp dir, then run.
  // The temp dir is always removed, regardless of how the subprocess exits.
  const { dir, mjs } = await stageMjsInTmp(lintScript);
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [mjs, skillPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const settle = (payload) => {
        if (settled) return;
        settled = true;
        // Drop the stdio handles so node's test runner doesn't see a
        // still-tracked child (which would fail the surrounding test on
        // non-zero exit). On Windows the handles keep the child process
        // pinned if not explicitly destroyed.
        try { child.stdout?.destroy(); } catch {}
        try { child.stderr?.destroy(); } catch {}
        resolve(payload);
      };
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => {
        settle({ ok: code === 0, code, stdout, stderr });
      });
      child.on('error', (err) => {
        settle({ ok: false, code: -1, stdout, stderr: stderr + '\nspawn error: ' + err.message });
      });
    });
  } finally {
    // Always clean up the staged dir, even on early return / thrown error.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
