// tests/paths.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parameterizePaths, suggestFilename, PATH_RULES } from '../lib/paths.js';

test('parameterizePaths replaces openclaw home', () => {
  // Use a path that hits the home rule (not the more specific workspace rule)
  const r = parameterizePaths('read C:\\Users\\Administrator\\.openclaw\\config\\foo.md');
  assert.ok(r.text.includes('${OPENCLAW_HOME}'));
  assert.ok(r.changes.some(c => c.id === 'openclaw-home'));
});

test('parameterizePaths prefers openclaw-workspace when workspace/ is present', () => {
  const r = parameterizePaths('read C:\\Users\\Administrator\\.openclaw\\workspace\\foo.md');
  assert.ok(r.text.includes('${OPENCLAW_WORKSPACE}'));
  assert.ok(r.text.includes('foo.md'));
  assert.ok(!r.text.includes('${OPENCLAW_HOME}'));
});

test('parameterizePaths replaces /tmp/CLI-Anything once', () => {
  const r = parameterizePaths('source: /tmp/CLI-Anything/gimp/agent-harness');
  assert.equal(r.text, 'source: ${SCRATCH}/cli-anything/gimp/agent-harness');
});

test('parameterizePaths does not double-replace CLI-Anything', () => {
  const r = parameterizePaths('cd /tmp/CLI-Anything/foo');
  // Should be ${SCRATCH}/cli-anything/foo, NOT ${SCRATCH}/${SCRATCH}/cli-anything/foo
  assert.ok(!r.text.includes('${SCRATCH}/${SCRATCH}'), `got: ${r.text}`);
  assert.ok(r.text.startsWith('cd ${SCRATCH}/cli-anything/foo'));
});

test('parameterizePaths generic /tmp', () => {
  const r = parameterizePaths('cd /tmp/myscript.sh');
  assert.equal(r.text, 'cd ${SCRATCH}/myscript.sh');
});

test('parameterizePaths returns empty changes for clean text', () => {
  const r = parameterizePaths('pure text with no paths');
  assert.equal(r.changes.length, 0);
  assert.equal(r.text, 'pure text with no paths');
});

test('suggestFilename keeps ASCII names', () => {
  const r = suggestFilename('task-tracker.md');
  assert.equal(r.recoverable, true);
  assert.equal(r.name, 'task-tracker.md');
});

test('suggestFilename flags mojibake names', () => {
  const r = suggestFilename('�̾�����.md');
  assert.equal(r.recoverable, false);
});

test('PATH_RULES has stable ids', () => {
  const ids = PATH_RULES.map(r => r.id);
  assert.ok(new Set(ids).size === ids.length, 'ids must be unique');
  for (const id of ids) {
    assert.ok(/^[a-z0-9-]+$/.test(id), `bad id: ${id}`);
  }
});
