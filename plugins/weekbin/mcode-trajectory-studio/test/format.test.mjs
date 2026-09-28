import assert from 'node:assert/strict';
import test from 'node:test';

import { fmtMs, fmtTokens } from '../web/js/format.js';

/**
 * Client formatting is pure, so it is testable without a DOM. The duration edge
 * case is the one worth pinning: rounding can land exactly on 60 seconds, and
 * printing "142m60s" is both wrong and easy to reintroduce.
 */

test('duration formatting carries a rounded 60s into the next minute', () => {
  assert.equal(fmtMs(142 * 60_000 + 59_600), '143m00s');
  assert.equal(fmtMs(1 * 60_000 + 59_600), '2m00s');
  assert.equal(fmtMs(60_000), '1m00s');
  assert.equal(fmtMs(59_400), '59.40s');
  assert.equal(fmtMs(940), '940ms');
  assert.equal(fmtMs(null), '—');
});

test('token formatting keeps magnitudes readable and never invents a value', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1_500), '1.5k');
  assert.equal(fmtTokens(27_000), '27k');
  assert.equal(fmtTokens(2_500_000), '2.50M');
  assert.equal(fmtTokens(null), '—');
});
