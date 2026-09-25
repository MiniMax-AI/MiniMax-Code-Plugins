// Unit tests for lib/discover.mjs using a fake local marketplace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCatalog, BUILTIN_OPTIONAL } from './discover.mjs';

test('mergeCatalog returns built-ins when discovered list is empty', () => {
  const merged = mergeCatalog([]);
  assert.equal(merged.length, BUILTIN_OPTIONAL.length);
  for (const p of merged) assert.equal(p.builtin, true);
});

test('mergeCatalog preserves order (builtins first, then alphabetical)', () => {
  const merged = mergeCatalog([
    { name: 'zeta-plugin', description: 'z', marketplaceName: 'local' },
    { name: 'alpha-plugin', description: 'a', marketplaceName: 'local' },
  ]);
  // First two are builtins, then alpha, then zeta.
  assert.equal(merged[0].builtin, true);
  assert.equal(merged[1].builtin, true);
  const customs = merged.filter((p) => !p.builtin);
  assert.equal(customs[0].name, 'alpha-plugin');
  assert.equal(customs[1].name, 'zeta-plugin');
});

test('mergeCatalog overrides built-in description when richer one is discovered', () => {
  const merged = mergeCatalog([
    { name: 'mcode-computer-use', description: 'richer desc from discovery', marketplaceName: 'official' },
  ]);
  const cu = merged.find((p) => p.name === 'mcode-computer-use');
  assert.equal(cu.description, 'richer desc from discovery');
});

test('mergeCatalog ignores malformed discovered entries', () => {
  const merged = mergeCatalog([
    null,
    { name: '', description: 'empty name' },
    { description: 'no name' },
    { name: 'ok-plugin', description: 'fine', marketplaceName: 'local' },
  ]);
  const customs = merged.filter((p) => !p.builtin);
  assert.equal(customs.length, 1);
  assert.equal(customs[0].name, 'ok-plugin');
});
