// tests/lint.test.mjs — regression tests for the review blockers:
//
//   1. `lib/lint.js` MUST NOT write a staged `.mjs` next to
//      `~/.minimax/.builtin-skills/skill-creator/scripts/lint-skill.js`.
//      That's the user's install area; polluting it is rude and racy.
//
//   2. The temp dir we DO write to must be removed on every code path.
//
//   3. The fast path (in-process dynamic import) must also surface a
//      failed lint result faithfully, without touching the install dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { lintSkill } from '../lib/lint.js';

// A lint script that does NOT export a `lint` function, forcing the
// subprocess path. Pure CJS, no ESM `import` syntax, so the fast path's
// `import()` of the .js file succeeds and returns an empty module
// (`mod.lint` undefined → fall through). When staged to a .mjs and run
// by node, the same `console.log` works fine in ESM mode.
const FAULT_FREE_LINT = `
console.log('lint ok for ' + process.argv[2]);
`;

// A lint script that DOES export a `lint` function (CJS). This drives
// the fast path in-process, returning a failing result without spawning
// a subprocess. Used to verify the install dir is not touched on the
// failure path either.
const FAILING_FAST_LINT = `
module.exports = {
  lint: (p) => ({ ok: false, code: 2, stdout: 'lint failed for ' + p, stderr: '' }),
};
`;

async function writeLintScript(content) {
  // This directory stands in for ~/.minimax/.builtin-skills/... in real use.
  // We never let lintSkill write into it — that's the whole point of this test.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-lint-fixture-'));
  const lintScript = path.join(dir, 'lint-skill.js');
  await fs.writeFile(lintScript, content, 'utf-8');
  return { dir, lintScript };
}

async function assertNoLeftoverStagingInTmp() {
  // lintSkill uses prefix `sb-lint-${pid}-`. After it resolves, no such
  // directory created by *this* test process should remain.
  const tmpRoot = os.tmpdir();
  const entries = await fs.readdir(tmpRoot);
  const leftover = entries.filter((e) => e.startsWith(`sb-lint-${process.pid}-`));
  assert.equal(
    leftover.length,
    0,
    `temp staging dirs left behind: ${leftover.join(', ')}`,
  );
}

test('lintSkill (subprocess path) stages the .mjs in os.tmpdir() — install dir is untouched', async () => {
  const { dir, lintScript } = await writeLintScript(FAULT_FREE_LINT);
  let skillPath;
  try {
    skillPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-lint-target-'));
    const r = await lintSkill(skillPath, { lintScript });
    assert.equal(r.ok, true, `expected ok, stderr was:\n${r.stderr}`);
    assert.ok(/lint ok/.test(r.stdout), `stdout: ${r.stdout}`);
    // Install dir must contain only lint-skill.js, never a staged .mjs.
    const siblings = await fs.readdir(dir);
    assert.ok(
      !siblings.some((f) => f.endsWith('.mjs')),
      `install dir should not have staged .mjs; got: ${siblings.join(', ')}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (skillPath) await fs.rm(skillPath, { recursive: true, force: true });
  }
  await assertNoLeftoverStagingInTmp();
});

test('lintSkill (fast path) returns the lint-script failure faithfully without touching disk', async () => {
  const { dir, lintScript } = await writeLintScript(FAILING_FAST_LINT);
  let skillPath;
  try {
    skillPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-lint-target-'));
    const r = await lintSkill(skillPath, { lintScript });
    assert.equal(r.ok, false, 'expected ok=false on lint failure');
    assert.equal(r.code, 2, `expected exit code 2, got ${r.code}`);
    assert.ok(/lint failed/.test(r.stdout), `stdout: ${r.stdout}`);

    // No temp staging dir should have been created — fast path never
    // touches disk, and there is no subprocess to spawn.
    const tmpRoot = os.tmpdir();
    const entries = await fs.readdir(tmpRoot);
    const leftover = entries.filter((e) => e.startsWith(`sb-lint-${process.pid}-`));
    assert.equal(leftover.length, 0, `fast path should not stage anything; got: ${leftover.join(', ')}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (skillPath) await fs.rm(skillPath, { recursive: true, force: true });
  }
});

