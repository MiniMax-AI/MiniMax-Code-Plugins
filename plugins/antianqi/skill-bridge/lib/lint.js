// lib/lint.js — Wrap the mavis skill-creator lint script.
//
// The official `lint-skill.js` ships as ES module source but is named
// with a `.js` extension and is not under a package.json with
// `"type": "module"`. Spawning `node` on it directly fails with a
// confusing SyntaxError. We avoid the problem in one of two ways:
//
//   - Fast path: dynamic import the script in-process. Works for CJS
//     modules (we read `mod.lint` and `mod.default.lint`) and for any
//     script that already exposes a `lint(skillPath)` function.
//   - Subprocess path: copy the source to a unique temp `.mjs` and run
//     it with `node`. The temp dir is created in `os.tmpdir()` and is
//     always removed, even on early return.
//
// CRITICAL: the temp dir MUST live under `os.tmpdir()`, NEVER under
// `~/.minimax/.builtin-skills/` or any user-install path. v0.1 was
// racy here; v0.2 forces a unique `sb-lint-<pid>-<rand>` directory.
//
// The return shape `{ ok, code, stdout, stderr }` is the failure
// contract. The caller (the MCP server, the CLI, or a test) decides
// what to do with `ok === false`. LintSkill itself does not exit the
// process.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

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

  // Fast path: dynamic import in-process. No files written.
  // Handle ESM (`export function lint`) and CJS interop
  // (`module.exports.lint` appears at `mod.default.lint`).
  try {
    const mod = await import(pathToFileURL(lintScript).href);
    const fn = typeof mod.lint === 'function'
      ? mod.lint
      : (mod.default && typeof mod.default.lint === 'function' ? mod.default.lint : null);
    if (fn) {
      const result = await fn(skillPath);
      return {
        ok: result.ok === true,
        code: typeof result.code === 'number' ? result.code : (result.ok ? 0 : 1),
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    }
  } catch {
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
    // Always clean up the staged dir.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
