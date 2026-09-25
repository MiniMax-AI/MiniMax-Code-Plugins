// Unit tests for noise-grid.mjs (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, hashSeed, PALETTE, layerAtPixel, colorsAtPixel } from './noise-grid.mjs';

test('hashSeed is deterministic', () => {
  assert.equal(hashSeed('hello'), hashSeed('hello'));
  assert.notEqual(hashSeed('hello'), hashSeed('hello!'));
});

test('buildGrid throws on bad dimensions', () => {
  assert.throws(() => buildGrid({ w: 0, h: 100 }), /invalid dimensions/);
  assert.throws(() => buildGrid({ w: -1, h: 100 }), /invalid dimensions/);
  assert.throws(() => buildGrid({ w: 100 }), /invalid dimensions/);
});

test('buildGrid throws on bad gridC', () => {
  assert.throws(() => buildGrid({ w: 100, h: 100, gridC: 0 }), /gridC/);
  assert.throws(() => buildGrid({ w: 100, h: 100, gridC: 3.5 }), /gridC/);
});

test('buildGrid is deterministic for a numeric seed', () => {
  const a = buildGrid({ w: 320, h: 240, gridC: 32, seed: 42 });
  const b = buildGrid({ w: 320, h: 240, gridC: 32, seed: 42 });
  assert.deepEqual(Array.from(a.layerA), Array.from(b.layerA));
  assert.deepEqual(Array.from(a.layerB), Array.from(b.layerB));
});

test('buildGrid differs across seeds', () => {
  const a = buildGrid({ w: 320, h: 240, gridC: 32, seed: 1 });
  const b = buildGrid({ w: 320, h: 240, gridC: 32, seed: 2 });
  assert.notDeepEqual(Array.from(a.layerA), Array.from(b.layerA));
});

test('layerAtPixel returns -1 outside coverage', () => {
  const g = buildGrid({ w: 100, h: 100, gridC: 32, seed: 7 });
  assert.equal(layerAtPixel(g, 'A', -1, 0), -1);
  assert.equal(layerAtPixel(g, 'B', -1, 0), -1);
});

test('layerAtPixel covers both layers', () => {
  const g = buildGrid({ w: 320, h: 240, gridC: 32, seed: 7 });
  // Take a few sample points; at least one in each macro cell should resolve.
  let sawA = 0, sawB = 0;
  for (let y = 0; y < 320; y += 8) {
    for (let x = 0; x < 640; x += 8) {
      if (layerAtPixel(g, 'A', x, y) >= 0) sawA += 1;
      if (layerAtPixel(g, 'B', x, y) >= 0) sawB += 1;
    }
  }
  assert.ok(sawA > 100, 'expected many A hits');
  assert.ok(sawB > 100, 'expected many B hits');
});

test('colorsAtPixel returns palette strings', () => {
  const g = buildGrid({ w: 320, h: 240, gridC: 32, seed: 9 });
  const c = colorsAtPixel(g, 100, 100);
  assert.ok(PALETTE.includes(c.color1));
  assert.ok(PALETTE.includes(c.color2));
  assert.equal(c.indexA, PALETTE.indexOf(c.color1));
  assert.equal(c.indexB, PALETTE.indexOf(c.color2));
});
