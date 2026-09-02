// lib/lint.js — Wrap the mavis skill-creator lint script.
//
// The host linter ships at
// `~/.minimax/.builtin-skills/skill-creator/scripts/lint-skill.js`.
//
// v0.2 strategy: always spawn the linter as a child process. We avoid
// the `import(lintScript).then(mod => mod.lint(skillPath))` path
// because the linter's default behaviour, when invoked without CLI
// arguments, is to call `process.exit(2)`. `process.exit` is not
// catchable from JS, so an in-process call would kill the MCP server
// before it could return a JSON-RPC response.
//
// The temp dir MUST live under `os.tmpdir()`, NEVER under
// `~/.minimax/.builtin-skills/` or any user-install path. v0.1 was
// racy here; v0.2.1 forces a unique `sb-lint-<pid>-<rand>` directory
// and removes it on every exit path.
//
// The return shape `{ ok, code, stdout, stderr }` is the failure
// contract. The caller (the MCP server, the CLI, or a test) decides
// what to do with `ok === false`. lintSkill itself does not exit the
// process.

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

async function stageMjsInTmp(lintScript) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sb-lint-${process.pid}-`));
  const mjs = path.join(dir, `${crypto.randomBytes(4).toString('hex')}.mjs`);
  const src = await fs.readFile(lintScript, 'utf-8');
  await fs.writeFile(mjs, src, 'utf-8');
  return { dir, mjs };
}

/**
 * Run the host skill linter in a child process.
 *
 * @param {string} skillPath  absolute path to a SKILL.md file
 * @param {object} [opts]
 * @param {string} [opts.lintScript]  override the default linter path
 * @returns {Promise<{ ok: boolean, code: number, stdout: string, stderr: string }>}
 */
export async function lintSkill(skillPath, opts = {}) {
  const lintScript = opts.lintScript
    || path.join(os.homedir(), '.minimax', '.builtin-skills', 'skill-creator', 'scripts', 'lint-skill.js');

  // If the host linter is not installed, surface that as a lint failure
  // (not an exception) so the MCP server can return a clean error to
  // the caller. This also keeps stageMjsInTmp from throwing ENOENT.
  try {
    await fs.stat(lintScript);
  } catch (statErr) {
    return {
      ok: false,
      code: -1,
      stdout: '',
      stderr: `lint script not available: ${lintScript} (${statErr.code || statErr.message})`,
    };
  }

  // Always spawn a child process. A `process.exit(2)` from the linter's
  // default CLI mode would otherwise kill the MCP server. Subprocess
  // isolation keeps the JSON-RPC transport alive even when the linter
  // is misconfigured.
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
    // Always clean up the staged dir, even on early return.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
