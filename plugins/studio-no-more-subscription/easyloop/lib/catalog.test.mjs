// Unit tests for catalog + planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOPS, QUALITIES, renderMenu, loopByName, qualityByName } from './catalog.mjs';
import { validateSelection, menuCharCount, setDiscoveredPlugins, getDiscoveredPlugins } from './planner.mjs';
import { mergeCatalog, BUILTIN_OPTIONAL } from './discover.mjs';

test('catalog has 12+ loops with descriptions', () => {
  assert.ok(LOOPS.length >= 12, `expected at least 12 loops, got ${LOOPS.length}`);
  for (const l of LOOPS) {
    assert.ok(l.name && typeof l.name === 'string');
    assert.ok(l.description && typeof l.description === 'string');
  }
});

test('renderMenu covers every loop and quality', () => {
  const text = renderMenu();
  for (const l of LOOPS) assert.ok(text.includes(l.name), `menu missing ${l.name}`);
  for (const q of QUALITIES) assert.ok(text.includes(q.name), `menu missing ${q.name}`);
  assert.ok(text.includes('PARALLELISM'));
});

test('loopByName returns metadata or null', () => {
  assert.ok(loopByName('explore').description.length > 0);
  assert.equal(loopByName('does-not-exist'), null);
});

test('validateSelection rejects empty loops', () => {
  const r = validateSelection({ loops: [], quality: 'release' });
  assert.equal(r.ok, false);
  assert.match(r.error, /loops/);
});

test('validateSelection rejects unknown loop', () => {
  const r = validateSelection({ loops: ['nope'], quality: 'release' });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown loop/);
});

test('validateSelection accepts a valid selection and preserves descriptions', () => {
  const r = validateSelection({
    loops: ['explore', 'implement', 'test'],
    quality: 'release',
    plugins: ['mcode-think-filter'],
    notes: 'sample',
  });
  assert.equal(r.ok, true);
  assert.equal(r.selection.quality.name, 'release');
  assert.equal(r.selection.quality.iterationCap, 25);
  assert.equal(r.selection.quality.verify, true);
  assert.equal(r.selection.loops.length, 3);
  for (const l of r.selection.loops) {
    assert.ok(l.description && l.description.length > 0);
  }
  assert.equal(r.selection.plugins[0].name, 'mcode-think-filter');
  assert.equal(r.selection.notes, 'sample');
});

test('validateSelection accepts unknown plugin with placeholder desc', () => {
  const r = validateSelection({
    loops: ['explore'],
    quality: 'prototype',
    plugins: ['some-user-plugin'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.selection.plugins[0].description, '(user plugin)');
});

test('menuCharCount matches renderMenu length', () => {
  assert.equal(menuCharCount(), renderMenu().length);
});

test('renderMenu with discovered plugins lists each one with its description', () => {
  const plugins = [
    { name: 'mcode-computer-use', description: 'GUI automation.' },
    { name: 'my-custom-plugin', description: 'Custom tool that does X.' },
  ];
  const text = renderMenu(plugins);
  assert.match(text, /mcode-computer-use/);
  assert.match(text, /GUI automation/);
  assert.match(text, /my-custom-plugin/);
  assert.match(text, /Custom tool that does X\./);
  // Recommended tag on the built-in
  assert.match(text, /\(recommended\)/);
});

test('renderMenu with empty plugin list falls back gracefully', () => {
  const text = renderMenu([]);
  assert.match(text, /LOOP PATTERNS/);
  assert.match(text, /QUALITY LEVEL/);
  // No plugin section populated
  assert.doesNotMatch(text, /\(recommended\)/);
});

test('mergeCatalog puts built-ins first and dedupes', () => {
  const discovered = [
    { name: 'mcode-computer-use', description: 'overrides built-in description', marketplaceName: 'official' },
    { name: 'custom-plugin', description: 'a custom plugin', marketplaceName: 'local' },
  ];
  const merged = mergeCatalog(discovered);
  assert.ok(merged.length >= 3, 'expected built-ins + custom');
  // First should be a built-in
  assert.equal(merged[0].builtin, true);
  // Built-in description should be replaced by richer discovered one
  const cu = merged.find((p) => p.name === 'mcode-computer-use');
  assert.equal(cu.description, 'overrides built-in description');
  // Custom appears
  assert.ok(merged.some((p) => p.name === 'custom-plugin'));
});

test('validateSelection stamps description from discovered plugins', () => {
  setDiscoveredPlugins([
    { name: 'custom-x', description: 'does X', marketplaceName: 'local' },
    { name: 'mcode-computer-use', description: 'GUI automation', marketplaceName: 'official' },
  ]);
  const r = validateSelection({
    loops: ['explore'],
    quality: 'prototype',
    plugins: ['custom-x', 'mcode-computer-use'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.selection.plugins[0].description, 'does X');
  assert.equal(r.selection.plugins[1].description, 'GUI automation');
  setDiscoveredPlugins([]);
});

test('validateSelection falls back to (user plugin) for unknown names', () => {
  setDiscoveredPlugins([]);
  const r = validateSelection({
    loops: ['explore'],
    quality: 'prototype',
    plugins: ['never-seen-this'],
  });
  assert.equal(r.ok, true);
  assert.equal(r.selection.plugins[0].description, '(user plugin)');
});

test('BUILTIN_OPTIONAL has the two suite plugins', () => {
  const names = BUILTIN_OPTIONAL.map((p) => p.name);
  assert.ok(names.includes('mcode-computer-use'));
  assert.ok(names.includes('mcode-think-filter'));
});
