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

import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

async function ensureMjs(lintScript) {
  // If there's a package.json in the parent chain that says type=module,
  // we can just import the .js directly. Otherwise, copy to .mjs.
  const mjs = lintScript.replace(/\.js$/, '.sb-lint.mjs');
  const src = await fs.readFile(lintScript, 'utf-8');
  await fs.writeFile(mjs, src, 'utf-8');
  return mjs;
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

  // Try dynamic import first (works if package.json has type=module nearby).
  try {
    const mod = await import(pathToFileURL(lintScript).href);
    if (typeof mod.lint === 'function') {
      const result = await mod.lint(skillPath);
      return { ok: result.ok ?? true, code: result.code ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    }
  } catch (e) {
    // Fall through to subprocess path
  }

  // Subprocess path: stage as .mjs and run.
  const mjs = await ensureMjs(lintScript);
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [mjs, skillPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', (code) => {
      // Best-effort cleanup of staged .mjs
      fs.unlink(mjs).catch(() => {});
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.on('error', (err) => {
      fs.unlink(mjs).catch(() => {});
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\nspawn error: ' + err.message });
    });
  });
}
