// Round-trip test for encode/decode (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from './noise-grid.mjs';
import { encodePixel } from './encode.mjs';
import { decodeAddress } from './decode.mjs';

test('encode → decode lands in the same sub-cell', () => {
  // With 256 colors, the (color1, color2) pair has 65,536 bins, so most
  // sub-cells on a 320x240 grid are uniquely addressable. The protocol
  // contract is: the decoded pixel is in the same sub-cell as the encoded
  // one (within ±half sub-cell tolerance).
  const g = buildGrid({ w: 320, h: 240, gridC: 32, seed: 42 });
  const half = g.gridC / 2; // 16
  let tested = 0, exact = 0, subcellMatch = 0;
  for (let y = 0; y < 240; y += 3) {
    for (let x = 0; x < 320; x += 3) {
      const enc = encodePixel(g, x, y);
      const dec = decodeAddress(g, { color1: enc.color1, color2: enc.color2, pos: enc.pos });
      assert.ok(dec, `decode should succeed for (${x},${y})`);
      if (dec.x === x && dec.y === y) exact += 1;
      else if (Math.abs(dec.x - x) < half && Math.abs(dec.y - y) < half) subcellMatch += 1;
      tested += 1;
    }
  }
  const success = exact + subcellMatch;
  assert.ok(success / tested >= 0.95,
    `expected >=95% sub-cell accuracy, got ${(success / tested * 100).toFixed(1)}% (exact=${exact}, subcell=${subcellMatch}, total=${tested})`);
});

test('decodeAddress returns null or match for impossible pair', () => {
  const g = buildGrid({ w: 320, h: 240, gridC: 32, seed: 42 });
  // The pair "#000000"/"#FFFFFF" should not match anything.
  const dec = decodeAddress(g, { color1: '#000000', color2: '#FFFFFF', pos: [0, 0] });
  assert.ok(dec === null || typeof dec.x === 'number');
});

test('encode identifies the correct quadrant', () => {
  const g = buildGrid({ w: 64, h: 64, gridC: 32, seed: 1 });
  // Top-left corner of macro cell at (0,0): quadrant 0 (TL).
  assert.equal(encodePixel(g, 0, 0).quadrant, 0);
  // Bottom-left of (0,0) macro cell: quadrant 1 (BL).
  assert.equal(encodePixel(g, 0, 31).quadrant, 1);
  // Top-right of (0,0) macro cell: quadrant 2 (TR).
  assert.equal(encodePixel(g, 31, 0).quadrant, 2);
  // Bottom-right of (0,0) macro cell: quadrant 3 (BR).
  assert.equal(encodePixel(g, 31, 31).quadrant, 3);
  // Now (32,0) macro cell, TL.
  assert.equal(encodePixel(g, 32, 0).quadrant, 0);
});

test('decodeAddress clamps pos out of range', () => {
  const g = buildGrid({ w: 320, h: 240, gridC: 32, seed: 1 });
  // Pick any valid (color1, color2) from the grid.
  let dec;
  for (let y = 0; y < 240 && !dec; y += 16) {
    for (let x = 0; x < 320 && !dec; x += 16) {
      const enc = encodePixel(g, x, y);
      dec = decodeAddress(g, { color1: enc.color1, color2: enc.color2, pos: [1000, -1000] });
      if (dec) {
        assert.ok(dec.x >= 0 && dec.x < 320);
        assert.ok(dec.y >= 0 && dec.y < 240);
      }
    }
  }
  assert.ok(dec, 'should have decoded at least once');
});
