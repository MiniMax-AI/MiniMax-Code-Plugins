// Smoke test for overlay.mjs: round-trip a 64x64 black PNG through the
// noise overlay and verify it's still a valid PNG of the same size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from './noise-grid.mjs';
import { composeOverlay, renderNoiseOnly } from './overlay.mjs';
import { Png } from './png-pure.mjs';

test('composeOverlay produces same-dimension PNG', async () => {
  const w = 64, h = 64;
  const blank = await Png.encode({
    width: w, height: h,
    data: Buffer.alloc(w * h * 4, 0xFF), // white
  });
  const g = buildGrid({ w, h, gridC: 32, seed: 5 });
  const out = await composeOverlay(blank, g, { alpha: 0.2 });
  const dec = await Png.decode(out);
  assert.equal(dec.width, w);
  assert.equal(dec.height, h);
});

test('renderNoiseOnly produces valid PNG', async () => {
  const g = buildGrid({ w: 128, h: 96, gridC: 32, seed: 5 });
  const out = await renderNoiseOnly(g, { alpha: 0.5 });
  const dec = await Png.decode(out);
  assert.equal(dec.width, 128);
  assert.equal(dec.height, 96);
});
