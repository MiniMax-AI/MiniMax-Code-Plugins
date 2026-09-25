// Unit tests for compact.mjs using a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSelection, readSelection, listSelections } from './compact.mjs';
import { renderMenu } from './catalog.mjs';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'easyloop-test-'));
  return dir;
}

test('saveSelection then readSelection round-trips with descriptions', async () => {
  const dir = tmpData();
  try {
    const selection = {
      loops: [
        { name: 'explore', description: 'Read and understand unfamiliar code; return a compressed summary.' },
        { name: 'implement', description: 'Write new code from a spec or plan.' },
      ],
      quality: { name: 'release', description: 'Full tests...', iterationCap: 25, verify: true },
      plugins: [{ name: 'mcode-think-filter', description: 'Use when context is critical.' }],
      notes: 'n/a',
    };
    const rec = await saveSelection(dir, selection, renderMenu().length);
    assert.ok(rec.context_compacted_id.startsWith('sel_'));
    assert.equal(rec.replacedChars, renderMenu().length);

    const back = await readSelection(dir, rec.context_compacted_id);
    assert.ok(back);
    assert.equal(back.context_compacted_id, rec.context_compacted_id);
    assert.equal(back.selection.loops[0].name, 'explore');
    assert.match(back.selection.loops[0].description, /understand/);
    assert.equal(back.selection.quality.name, 'release');
    assert.equal(back.selection.quality.iterationCap, 25);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSelection rejects malformed ids', async () => {
  const dir = tmpData();
  try {
    assert.equal(await readSelection(dir, 'nope'), null);
    assert.equal(await readSelection(dir, '../../../etc/passwd'), null);
    assert.equal(await readSelection(dir, ''), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listSelections returns ids sorted newest first', async () => {
  const dir = tmpData();
  try {
    for (let i = 0; i < 3; i += 1) {
      await saveSelection(dir, { loops: [{ name: 'explore', description: 'x' }],
        quality: { name: 'release', description: 'y', iterationCap: 25, verify: true },
        plugins: [], notes: '' }, 1);
    }
    const list = await listSelections(dir);
    assert.equal(list.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
