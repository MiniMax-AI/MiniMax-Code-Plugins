// Run: node --test scripts/badge.test.mjs   (from the skill directory)
// All tests use local fake data. The --pr tests use a fake "gh" executable
// that reads/writes a JSON file; nothing talks to GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBadge, buildBlock, DEFAULT_SNIPPET, START, END } from './badge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'badge.mjs');
const count = (s, sub) => s.split(sub).length - 1;
const BLOCK = buildBlock();

test('empty body gets just the block', () => {
  const r = applyBadge('');
  assert.equal(r.status, 'added');
  assert.equal(r.body, BLOCK + '\n');
});

test('adds at the end after a blank line, second run is a byte-identical no-op', () => {
  const body = '## Summary\n\nFix the parser.\n\n## Test plan\n- [x] unit tests\n';
  const a = applyBadge(body);
  assert.equal(a.status, 'added');
  assert.equal(a.body, body.trimEnd() + '\n\n' + BLOCK + '\n');
  const b = applyBadge(a.body);
  assert.equal(b.status, 'unchanged');
  assert.equal(b.body, a.body);
  assert.equal(count(b.body, START), 1);
});

test('replaces a stale marked block (old colour and link) in place of appending', () => {
  const stale = 'Body\n\n' + START + '\n[![x](https://img.shields.io/badge/powered_by-MiniMax_Code-000000)](https://example.com)\n' + END + '\n';
  const r = applyBadge(stale);
  assert.equal(r.status, 'replaced');
  assert.equal(r.body, 'Body\n\n' + BLOCK + '\n');
});

test('collapses duplicated blocks and bare legacy badge lines into one block at the end', () => {
  const messy = [
    'Intro',
    DEFAULT_SNIPPET,                       // bare copy, no markers
    '',
    'Middle text',
    BLOCK,
    '',
    '![](./assets/minimax-code-badge.png)', // bundled-asset copy, unlinked
    'Tail',
    BLOCK,
    '',
  ].join('\n');
  const r = applyBadge(messy);
  assert.equal(r.status, 'replaced');
  assert.equal(count(r.body, START), 1);
  assert.equal(count(r.body, 'img.shields.io'), 1);
  assert.ok(r.body.endsWith('Tail\n\n' + BLOCK + '\n'));
  assert.ok(r.body.includes('Middle text') && r.body.includes('Intro'));
  assert.equal(applyBadge(r.body).status, 'unchanged');
});

test('badge examples inside fenced code blocks are left alone', () => {
  const body = 'How to add it:\n\n```md\n' + BLOCK + '\n```\n';
  const r = applyBadge(body);
  assert.equal(r.status, 'added');
  assert.equal(count(r.body, START), 2); // the example + the real one
  assert.ok(r.body.startsWith(body.trimEnd()));
  assert.equal(applyBadge(r.body).status, 'unchanged');
});

test('prose that merely mentions MiniMax Code is not touched', () => {
  const body = 'This PR was drafted with MiniMax Code, see https://github.com/MiniMax-AI/minimax-code\n';
  const r = applyBadge(body);
  assert.ok(r.body.startsWith(body.trimEnd() + '\n\n'));
});

test('an unmatched start marker only removes itself', () => {
  const body = 'A\n' + START + '\nImportant user text\nB\n';
  const r = applyBadge(body);
  assert.ok(r.body.includes('Important user text\nB'));
  assert.equal(count(r.body, START), 1);
});

test('CRLF bodies stay CRLF and stay idempotent', () => {
  const body = 'Line 1\r\nLine 2\r\n';
  const r = applyBadge(body);
  assert.ok(!/[^\r]\n/.test(r.body), 'every LF is preceded by CR');
  assert.equal(applyBadge(r.body).status, 'unchanged');
});

test('user blank-line runs elsewhere are preserved byte-for-byte', () => {
  const body = 'A\n\n\n\nB\n\n' + BLOCK + '\n';
  assert.equal(applyBadge(body).body, body);
});

test('remove mode removes every copy; second remove is absent and untouched', () => {
  const withBadge = applyBadge('Body text\n').body;
  const r = applyBadge(withBadge, { mode: 'remove' });
  assert.equal(r.status, 'removed');
  assert.equal(r.body, 'Body text\n');
  const again = applyBadge(r.body, { mode: 'remove' });
  assert.equal(again.status, 'absent');
  assert.equal(again.body, r.body);
});

test('custom snippet replaces the default block and back', () => {
  const custom = '[![built with MiniMax Code](https://img.shields.io/badge/built_with-MiniMax_Code-E73562)](https://github.com/MiniMax-AI/minimax-code)';
  const a = applyBadge(applyBadge('X\n').body, { snippet: custom });
  assert.equal(a.status, 'replaced');
  assert.equal(count(a.body, START), 1);
  assert.ok(a.body.includes('built_with'));
  const b = applyBadge(a.body);
  assert.equal(b.status, 'replaced');
  assert.ok(!b.body.includes('built_with'));
  assert.throws(() => buildBlock('two\nlines'));
});

// ---- CLI ---------------------------------------------------------------

function run(args, env = {}, input) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', input, env: { ...process.env, MINIMAX_CODE_BADGE_DISABLE: '', MINIMAX_CODE_BADGE_MARKDOWN: '', ...env },
  });
}

test('CLI --body-file: run twice, file holds exactly one block', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmc-badge-test-'));
  const f = join(dir, 'pr-body.md');
  writeFileSync(f, '## Summary\nFake PR body\n');
  const r1 = run(['--body-file', f]);
  assert.equal(r1.status, 0); assert.match(r1.stderr, /^added /);
  const first = readFileSync(f, 'utf8');
  const r2 = run(['--body-file', f]);
  assert.equal(r2.status, 0); assert.match(r2.stderr, /^unchanged /);
  assert.equal(readFileSync(f, 'utf8'), first);
  assert.equal(count(first, START), 1);
  assert.equal(run(['--body-file', f, '--check']).status, 0);
  const d = run(['--body-file', f, '--remove', '--dry-run']);
  assert.match(d.stderr, /^removed \(dry-run/);
  assert.equal(readFileSync(f, 'utf8'), first, 'dry-run must not write');
  assert.equal(run(['--body-file', f, '--remove']).status, 0);
  assert.equal(readFileSync(f, 'utf8'), '## Summary\nFake PR body\n');
  assert.equal(run(['--body-file', f, '--check']).status, 1);
});

test('CLI honours MINIMAX_CODE_BADGE_DISABLE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmc-badge-test-'));
  const f = join(dir, 'b.md');
  writeFileSync(f, 'x\n');
  const r = run(['--body-file', f], { MINIMAX_CODE_BADGE_DISABLE: '1' });
  assert.equal(r.status, 0); assert.match(r.stderr, /^disabled/);
  assert.equal(readFileSync(f, 'utf8'), 'x\n');
});

test('CLI rejects bad usage with exit 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--body-file', 'a', '--stdin']).status, 2);
  assert.equal(run(['--wat']).status, 2);
});

test('CLI --pr against a fake gh: one edit, then idempotent, dry-run never edits', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mmc-badge-gh-'));
  const state = join(dir, 'pr.json');
  const log = join(dir, 'calls.log');
  writeFileSync(state, JSON.stringify({ url: 'https://github.com/example/fake/pull/7', body: 'Fake body\r\n\r\n- item\r\n' }));
  const fake = join(dir, 'gh');
  writeFileSync(fake, [
    '#!' + process.execPath,
    "const fs = require('fs');",
    'const [state, log] = [process.env.FAKE_GH_STATE, process.env.FAKE_GH_LOG];',
    'const a = process.argv.slice(2);',
    "fs.appendFileSync(log, a.join(' ') + '\\n');",
    'const pr = JSON.parse(fs.readFileSync(state, "utf8"));',
    "if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify(pr)); process.exit(0); }",
    "if (a[0] === 'pr' && a[1] === 'edit') { const i = a.indexOf('--body-file'); pr.body = fs.readFileSync(a[i + 1], 'utf8'); fs.writeFileSync(state, JSON.stringify(pr)); process.exit(0); }",
    "process.stderr.write('unsupported'); process.exit(1);",
  ].join('\n'));
  chmodSync(fake, 0o755);
  const env = { GH_BIN: fake, FAKE_GH_STATE: state, FAKE_GH_LOG: log };
  const edits = () => readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('pr edit')).length;

  const dry = run(['--pr', '7', '--repo', 'example/fake', '--dry-run'], env);
  assert.equal(dry.status, 0); assert.match(dry.stderr, /^added \(dry-run/);
  assert.equal(edits(), 0);

  const r1 = run(['--pr', '7', '--repo', 'example/fake'], env);
  assert.equal(r1.status, 0, r1.stderr); assert.match(r1.stderr, /^added https:\/\/github.com\/example\/fake\/pull\/7/);
  assert.equal(edits(), 1);
  const body1 = JSON.parse(readFileSync(state, 'utf8')).body;
  assert.equal(count(body1, START), 1);
  assert.ok(body1.startsWith('Fake body\r\n\r\n- item\r\n\r\n'));

  const r2 = run(['--pr', '7', '--repo', 'example/fake'], env);
  assert.match(r2.stderr, /^unchanged /);
  assert.equal(edits(), 1, 'second run must not call gh pr edit');
  assert.equal(run(['--pr', '7', '--repo', 'example/fake', '--check'], env).status, 0);

  const r3 = run(['--pr', '7', '--repo', 'example/fake', '--remove'], env);
  assert.match(r3.stderr, /^removed /);
  assert.equal(JSON.parse(readFileSync(state, 'utf8')).body, 'Fake body\r\n\r\n- item\r\n');
  assert.ok(readFileSync(log, 'utf8').includes('--repo example/fake'));

  const bad = run(['--pr', '7'], { ...env, GH_BIN: join(dir, 'missing-gh') });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /cannot run/);
});

// ---- package consistency ----------------------------------------------

test('SKILL.md carries the exact default snippet (no drift)', () => {
  const skill = readFileSync(join(here, '..', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(DEFAULT_SNIPPET));
});

test('bundled assets exist with the shields geometry and brand colour', () => {
  const svg = readFileSync(join(here, '..', 'assets', 'minimax-code-badge.svg'), 'utf8');
  assert.match(svg, /width="179" height="20"/);
  assert.match(svg, /#E73562/);
  assert.match(svg, />powered by</);
  assert.match(svg, />MiniMax Code</);
  assert.ok(existsSync(join(here, '..', 'assets', 'minimax-code-badge.png')));
});
