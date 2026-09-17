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

test('transformSkill adds a References index when body is split into references/', async () => {
  // Build a body with > 500 lines and 4 `##` sections so maybeSplitReferences
  // (sections.length >= 3) fires.
  const sectionBody = (label) => {
    const lines = [`## ${label}`];
    for (let i = 0; i < 200; i++) lines.push(`Section ${label} line ${i}.`);
    return lines.join('\n');
  };
  const longBody = [
    '# Top',
    '',
    'Intro paragraph that does not count as a section.',
    '',
    sectionBody('Alpha'),
    '',
    sectionBody('Beta'),
    '',
    sectionBody('Gamma'),
    '',
    sectionBody('Delta'),
  ].join('\n');

  const out = await tmpdir();
  const outDir = path.join(out, 'split-skill');
  const r = await transformSkill({
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'split-skill', description: 'Test the split.' },
      body: longBody,
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-wrapped-fix', reason: 'r', recommendations: [] },
    outDir,
  });

  // The split must have produced at least one references file.
  const refsDir = path.join(outDir, 'references');
  const refFiles = await fs.readdir(refsDir);
  assert.ok(refFiles.length >= 1, `expected references/ to be populated, got: ${refFiles.join(', ')}`);

  // SKILL.md must surface them with a References section AND markdown links.
  const skill = await fs.readFile(path.join(outDir, 'SKILL.md'), 'utf-8');
  assert.ok(/^##\s+References\b/m.test(skill), 'should add a ## References section to SKILL.md');
  assert.ok(
    /references\/[a-z0-9-]+\.md/.test(skill),
    'should list each references/*.md as a link inside the index',
  );

  // The link target must exist on disk.
  const linked = skill.match(/references\/([a-z0-9-]+\.md)/);
  assert.ok(linked, 'should find a references/*.md link in the body');
  assert.ok(
    refFiles.includes(linked[1]),
    `linked file ${linked[1]} should exist in references/`,
  );

  assert.ok(r.written.length >= 3, 'should record SKILL.md + references + conversion-report.md');
  await fs.rm(out, { recursive: true, force: true });
});

test('transformSkill replaces outDir atomically (no stale references/ on re-run)', async () => {
  const out = await tmpdir();
  const outDir = path.join(out, 'atomic-skill');

  // 1st pass: long body that triggers split.
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
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'atomic-skill', description: 'first run' },
      body: longBody,
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-wrapped-fix', reason: 'r', recommendations: [] },
    outDir,
  });

  // 1st pass leaves a populated references/ directory.
  const refsAfterFirst = await fs.readdir(path.join(outDir, 'references'));
  assert.ok(refsAfterFirst.length > 0, '1st pass should produce references/');

  // 2nd pass: short body that does NOT trigger split. The atomic replace
  // must wipe the old references/ — not just overwrite SKILL.md.
  const shortBody = '# Top\n\nShort body, no split.\n\n## Procedure\n\nDo it.';
  await transformSkill({
    inputPath: 'fake.md',
    report: {
      inputPath: 'fake.md',
      encoding: 'utf-8',
      convertedFromGbk: false,
      frontmatter: { name: 'atomic-skill', description: 'second run' },
      body: shortBody,
      warnings: [],
    },
    classify: { tier: 'pure', subTier: 'pure-translate', reason: 'r', recommendations: [] },
    outDir,
  });

  // No stale references/ on disk.
  const refsAfterSecond = await fs.readdir(path.join(outDir, 'references')).catch(() => null);
  assert.equal(
    refsAfterSecond,
    null,
    'stale references/ from previous run must be removed by atomic replace',
  );

  // And the new SKILL.md reflects the new body (not the long one).
  const skill = await fs.readFile(path.join(outDir, 'SKILL.md'), 'utf-8');
  assert.ok(skill.includes('Short body, no split.'), 'SKILL.md should reflect 2nd pass body');
  assert.ok(!/Section A line 0/.test(skill), 'old long-body content must not leak into new SKILL.md');

  await fs.rm(out, { recursive: true, force: true });
});
