// tests/transform-skill.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformSkill } from '../lib/transform-skill.js';
import { parseFrontmatter } from '../lib/analyze.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SAMPLE = `---
name: test-skill
description: "A test skill for unit tests."
---

# Test Skill

## Inputs to collect

- A thing.

## Procedure

1. Do the thing.

This skill uses C:\\Users\\Administrator\\.openclaw\\workspace\\foo.md
`;

async function tmpdir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
}

test('transformSkill writes SKILL.md and conversion-report.md', async () => {
  const out = await tmpdir();
  // Use a stable outDir basename so the resulting name is deterministic.
  const outDir = path.join(path.dirname(out), 'test-skill');
  const r = await transformSkill({
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'test-skill', description: 'A test skill for unit tests.' },
      body: SAMPLE.split('---\n').slice(2).join('---\n'),
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-wrapped-fix', reason: 'has hardcoded path', recommendations: [] },
    outDir,
  });
  assert.ok(r.written.some(f => f.endsWith('SKILL.md')));
  assert.ok(r.written.some(f => f.endsWith('conversion-report.md')));

  const skill = await fs.readFile(path.join(outDir, 'SKILL.md'), 'utf-8');
  // Original path should be parameterized (workspace rule wins for this input)
  assert.ok(skill.includes('${OPENCLAW_WORKSPACE}'));
  // Required sections should be added
  assert.ok(/^##\s+Output contract/m.test(skill));
  assert.ok(/^##\s+Failure handling/m.test(skill));
  // Frontmatter enrichment
  const { frontmatter, body } = parseFrontmatter(skill);
  assert.equal(frontmatter.name, 'test-skill');
  assert.equal(frontmatter.metadata['skill-bridge'].classify_tier, 'pure');
  await fs.rm(outDir, { recursive: true, force: true });
});

test('transformSkill adds Windows notes when shell commands present', async () => {
  const out = await tmpdir();
  const bodyWithShell = '## Procedure\n\nRun `pip install foo` and then `python3 main.py`.';
  await transformSkill({
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'shell-skill', description: 'shell skill' },
      body: bodyWithShell,
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-wrapped-fix', reason: 'r', recommendations: [] },
    outDir: out,
  });
  const skill = await fs.readFile(path.join(out, 'SKILL.md'), 'utf-8');
  assert.ok(/^##\s+Windows \(win32\) platform notes/m.test(skill), 'should add Windows section');
  await fs.rm(out, { recursive: true, force: true });
});

test('transformSkill does NOT add Windows notes for pure prose', async () => {
  const out = await tmpdir();
  const body = '## Procedure\n\nJust do the thing. No shell needed.';
  await transformSkill({
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'pure-skill', description: 'pure' },
      body,
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-translate', reason: 'r', recommendations: [] },
    outDir: out,
  });
  const skill = await fs.readFile(path.join(out, 'SKILL.md'), 'utf-8');
  assert.ok(!/^##\s+Windows \(win32\) platform notes/m.test(skill));
  await fs.rm(out, { recursive: true, force: true });
});
