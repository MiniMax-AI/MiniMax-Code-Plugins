// tests/cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '..', 'index.js');

function run(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('--help prints usage', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  assert.ok(/mcode-skill-bridge/.test(r.stdout));
  assert.ok(/Usage:/.test(r.stdout));
});

test('detect command on utf-8 file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-cli-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, '---\nname: x\ndescription: y\n---\n\n# X\n', 'utf-8');
  const r = await run(['detect', file]);
  assert.equal(r.code, 0);
  assert.ok(/encoding:\s+utf-8/.test(r.stdout), `got: ${r.stdout}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('classify command on a pure-instruction skill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-cli-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, '---\nname: y\ndescription: "A pure skill."\n---\n\n# Y\n\nJust instructions.\n', 'utf-8');
  const r = await run(['classify', file]);
  assert.equal(r.code, 0);
  assert.ok(/tier:\s+pure/.test(r.stdout), `got: ${r.stdout}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test('convert writes output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-cli-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file,
    '---\nname: demo-skill\ndescription: "Demo."\n---\n\n# Demo\n\nUse /tmp/x for cache.\n', 'utf-8');
  const out = path.join(dir, 'out');
  const r = await run(['convert', file, '--out', out, '--no-lint']);
  assert.equal(r.code, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const written = await fs.readdir(out);
  assert.ok(written.includes('SKILL.md'));
  assert.ok(written.includes('conversion-report.md'));
  await fs.rm(dir, { recursive: true, force: true });
});
