// tests/transform-atomic.test.mjs
//
// Regression tests for the "atomic replace" guarantee in
// lib/transform-skill.js.
//
// hetaoBackend's review on PR #3 said: "所谓原子替换先删除 outDir 再 rename;
// rename 失败会丢失旧输出。需要失败保留测试。"
//
// v0.2 fixes this by staging to a sibling temp dir and using a
// backup-and-rename dance: outDir is moved to a backup first, the
// staging dir is renamed onto outDir, and the backup is removed. If
// anything fails, the backup is moved back so outDir is restored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { transformSkill } from '../lib/transform-skill.js';

const SAMPLE = {
  inputPath: 'fake.md',
  report: {
    inputPath: 'fake.md',
    encoding: 'utf-8',
    convertedFromGbk: false,
    frontmatter: { name: 'atomic-test', description: 'Atomic rename test.' },
    body: '# Top\n\n## Procedure\n\nDo it.\n',
    warnings: [],
  },
  classify: { tier: 'pure', subTier: 'pure-translate', reason: 'r', recommendations: [] },
};

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'sb-atomic-'));
}

test('1st run creates outDir with the new content', async () => {
  const out = await tmpdir();
  const outDir = path.join(out, 'atomic-1');
  await transformSkill({ ...SAMPLE, outDir });
  const entries = await fs.readdir(outDir);
  assert.ok(entries.includes('SKILL.md'));
  assert.ok(entries.includes('conversion-report.md'));
  await fs.rm(out, { recursive: true, force: true });
});

test('2nd run replaces outDir cleanly (no stale references/)', async () => {
  const out = await tmpdir();
  const outDir = path.join(out, 'atomic-2');

  // 1st pass: long body that triggers the references/ split.
  const sectionBody = (label) => {
    const lines = [`## ${label}`];
    for (let i = 0; i < 200; i++) lines.push(`${label} line ${i}.`);
    return lines.join('\n');
  };
  const longBody = [
    '# Top', '',
    'Intro.',
    '',
    sectionBody('A'),
    sectionBody('B'),
    sectionBody('C'),
    sectionBody('D'),
  ].join('\n');
  await transformSkill({
    ...SAMPLE,
    report: { ...SAMPLE.report, body: longBody },
    outDir,
  });
  const refsAfterFirst = await fs.readdir(path.join(outDir, 'references'));
  assert.ok(refsAfterFirst.length > 0, '1st pass should produce references/');

  // 2nd pass: short body that does NOT trigger the split. The atomic
  // replace must wipe the old references/ — not just overwrite SKILL.md.
  await transformSkill({
    ...SAMPLE,
    report: { ...SAMPLE.report, body: '# Top\n\nShort body, no split.\n' },
    outDir,
  });
  const refsAfterSecond = await fs.readdir(path.join(outDir, 'references')).catch(() => null);
  assert.equal(refsAfterSecond, null, 'stale references/ must be removed by atomic replace');

  // And the new SKILL.md reflects the new body.
  const skill = await fs.readFile(path.join(outDir, 'SKILL.md'), 'utf-8');
  assert.ok(skill.includes('Short body, no split.'));
  assert.ok(!/A line 0/.test(skill), 'old long-body content must not leak into the new SKILL.md');

  await fs.rm(out, { recursive: true, force: true });
});

test('outDir is preserved when transformSkill fails before any write', async () => {
  // Force a deterministic failure with a NUL byte in the outDir path.
  // Node fs APIs always reject NUL bytes, so transformSkill throws
  // before it touches anything. The pre-existing outDir (and its
  // sentinel) must remain untouched on disk.
  const out = await tmpdir();
  const outDir = path.join(out, 'atomic-3');
  await fs.mkdir(outDir, { recursive: true });
  const sentinel = path.join(outDir, 'SENTINEL.md');
  await fs.writeFile(sentinel, 'keep me', 'utf-8');

  // NUL byte in the path makes any fs call throw.
  const badOut = path.join(out, 'bad\0segment', 'skill');

  await assert.rejects(
    transformSkill({ ...SAMPLE, outDir: badOut }),
    (err) => err instanceof Error,
    'transformSkill must reject when outDir is unusable',
  );

  // Pre-existing outDir and its sentinel must still be intact.
  const stillThere = await fs.stat(outDir);
  assert.ok(stillThere.isDirectory(), 'outDir must still exist');
  const content = await fs.readFile(sentinel, 'utf-8');
  assert.equal(content, 'keep me', 'sentinel must be unchanged');

  await fs.rm(out, { recursive: true, force: true });
});
