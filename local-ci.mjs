#!/usr/bin/env node
// local-ci.mjs — Local mirror of the repository CI gates. UNTRACKED helper: never commit.
// Mirrors:
//   CI / validate (ubuntu-latest)   -> clean-checkout `npm run check` (validate + full suite)
//   Dynamic Workflow source-and-package -> build reproducibility + packaged smoke
//   plugin extras                   -> verify-claims (when present on the branch)
// GitHub-only (cannot run locally): CodeQL, Windows process-lifecycle job.
// Usage: node local-ci.mjs [--quick]   (--quick skips the full root suite)
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname);
const plugin = join(root, 'plugins/hetaoBackend/mcode-dynamic-workflows');
const nm = join(plugin, 'node_modules');
const quick = process.argv.includes('--quick');
let failed = '';

const step = (name, cwd, fn) => {
  process.stdout.write(`\n=== ${name} ===\n`);
  if (failed) { console.log(`SKIP ${name} (earlier failure: ${failed})`); return; }
  const code = fn();
  if (code !== 0) failed = name;
  console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name}`);
};
const run = (cmd, args, cwd = root) => spawnSync(cmd, args, { cwd, stdio: 'inherit' }).status ?? 1;

const major = Number(process.versions.node.split('.')[0]);
if (major !== 22) {
  console.log(`NOTE: CI runs Node 22 (ubuntu-latest); local Node is ${process.versions.node}. Version drift possible.`);
}
if (!existsSync(join(plugin, 'package.json'))) {
  console.error(`plugin not found: ${plugin}`); process.exit(2);
}

step('plugin source suite (node --test checks/*.check.mjs)', plugin,
  () => run('npm', ['test'], plugin));
step('packaged MCP smoke (test:package)', plugin,
  () => run('npm', ['run', 'test:package'], plugin));
step('bundle build (build.mjs)', plugin,
  () => run('npm', ['run', 'build'], plugin));
step('bundle reproducibility (git diff --exit-code)', plugin,
  () => run('git', ['diff', '--exit-code', '--', 'dist', 'web', 'THIRD_PARTY_NOTICES.txt'], plugin));
if (existsSync(join(plugin, 'scripts/verify-claims.mjs'))) {
  step('mechanical claims (verify-claims)', plugin,
    () => run('node', ['scripts/verify-claims.mjs'], plugin));
}
// Clean-checkout simulation: the validator rejects plugin node_modules (symlink rule),
// and the root suite must pass without it — same as the CI runner.
step('stash plugin node_modules (clean-checkout simulate)', root, () => {
  if (existsSync(nm)) rmSync(nm, { recursive: true, force: true });
  return 0;
});
if (!quick) step('root gate: npm run check (validate + full suite)', root,
  () => run('npm', ['run', 'check'], root));
else console.log('\n=== SKIP root gate (--quick) ===');
step('restore plugin node_modules (npm ci)', plugin,
  () => run('npm', ['ci'], plugin));

console.log(`\n=== local-ci summary: ${failed ? `FAILED at ${failed}` : 'all gates green'} ===`);
if (failed) console.log('GitHub-only gates not mirrored here: CodeQL, Windows process-lifecycle.');
process.exit(failed ? 1 : 0);
