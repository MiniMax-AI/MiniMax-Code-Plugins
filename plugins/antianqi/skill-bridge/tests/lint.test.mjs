// tests/lint.test.mjs — regression tests for the review blockers:
//
//   1. `lib/lint.js` MUST NOT write a staged `.mjs` next to
//      `~/.minimax/.builtin-skills/skill-creator/scripts/lint-skill.js`.
//      That's the user's install area; polluting it is rude and racy.
//   2. The temp dir we DO write to must be removed on every code path.
//   3. The linter's `process.exit(2)` (default CLI mode when invoked
//      without arguments) must NOT kill the MCP server. We always
//      spawn a child process so a stray `process.exit` is contained.
//   4. A missing or unspawn-able lintScript must surface a
//      `ok: false` result, not throw to the caller.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { lintSkill } from '../lib/lint.js';

// A lint script that does NOT export a `lint` function. The default
// `~/.minimax/.../lint-skill.js` is shipped that way; this fixture
// matches the production shape so the subprocess path is exercised
// end-to-end.
const FAULT_FREE_LINT = `
console.log('lint ok for ' + process.argv[2]);
`;

// A lint script that calls process.exit(2) on the first line. This
// proves the subprocess path keeps the MCP server alive even when
// the linter itself terminates hard.
const EXIT_2_LINT = `
process.exit(2);
`;

async function writeLintScript(content) {
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

test('lintSkill survives a linter that calls process.exit(2)', async () => {
  // This is the exact failure mode the review called out: a default
  // linter invocation (no CLI args) calls process.exit(2). An
  // in-process import would kill the MCP server; the subprocess
  // path survives.
  const { dir, lintScript } = await writeLintScript(EXIT_2_LINT);
  let skillPath;
  try {
    skillPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-lint-target-'));
    const r = await lintSkill(skillPath, { lintScript });
    assert.equal(r.ok, false, 'expected ok=false when linter exits 2');
    assert.equal(r.code, 2, `expected code 2, got ${r.code}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (skillPath) await fs.rm(skillPath, { recursive: true, force: true });
  }
  await assertNoLeftoverStagingInTmp();
});

test('lintSkill returns ok=false when lintScript does not exist', async () => {
  const skillPath = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-lint-target-'));
  try {
    const r = await lintSkill(skillPath, {
      lintScript: path.join(os.tmpdir(), `does-not-exist-${process.pid}.js`),
    });
    assert.equal(r.ok, false, 'expected ok=false for missing lintScript');
    assert.ok(/ENOENT|no such file/i.test(r.stderr), `unexpected stderr: ${r.stderr}`);
  } finally {
    await fs.rm(skillPath, { recursive: true, force: true });
  }
  await assertNoLeftoverStagingInTmp();
});
