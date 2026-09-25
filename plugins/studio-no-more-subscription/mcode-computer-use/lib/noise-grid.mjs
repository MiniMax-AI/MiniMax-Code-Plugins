// noise-grid.mjs
//
// Deterministic two-layer random-noise grid for the mcode-computer-use
// addressing protocol.
//
// Layer A: square cells of size C aligned to (0, 0).
// Layer B: same cell size, offset by (C/2, C/2).
//
// Each cell carries one color drawn from a fixed 16-color palette. The
// choice is seeded from a per-session PRNG so a session sees the same
// grid across turns but a new session sees a fresh grid.
//
// Pure functions; no I/O; fully unit-testable.

// 256-color palette derived from HSV space. With 256 colors, the
// (colorA, colorB) pair space has 65,536 bins, which is far more than
// the sub-cell count on any realistic screen (1500–4000 sub-cells at
// 1280x720). Expected number of pair collisions per pair by birthday
// paradox is roughly (n^2) / (2 * 65536), which for n=3600 is ~99
// collisions across the whole screen — most pairs are unique.
//
// The plan originally targeted 16 colors. That was a deliberate
// trade-off in the visual layer (humans can distinguish 16 hues
// reliably), but for the model addressing protocol it caused too many
// sub-cell collisions. We split the difference: 256 hues is still
// distinguishable to a vision model that has been pre-trained on
// diverse imagery, and the cell sizes (32 px) make the color cells
// large enough that JPEG/PNG compression does not collapse them.
export const PALETTE = (() => {
  const out = [];
  for (let i = 0; i < 256; i += 1) {
    const h = (i * 360 / 256) | 0;
    // Vary S/V a bit so adjacent hues stay distinct under compression.
    const s = (i & 1) ? 88 : 75;
    const v = (i & 2) ? 92 : 80;
    out.push(hsvToHex(h, s, v));
  }
  return out;
})();

function hsvToHex(h, s, v) {
  // h in [0,360), s and v in [0,100].
  const c = (v / 100) * (s / 100);
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if      (0 <= hh && hh < 1) { r = c; g = x; b = 0; }
  else if (1 <= hh && hh < 2) { r = x; g = c; b = 0; }
  else if (2 <= hh && hh < 3) { r = 0; g = c; b = x; }
  else if (3 <= hh && hh < 4) { r = 0; g = x; b = c; }
  else if (4 <= hh && hh < 5) { r = x; g = 0; b = c; }
  else                        { r = c; g = 0; b = x; }
  const m = (v / 100) - c;
  const to255 = (v2) => Math.max(0, Math.min(255, Math.round((v2 + m) * 255)));
  return '#' +
    to255(r).toString(16).padStart(2, '0').toUpperCase() +
    to255(g).toString(16).padStart(2, '0').toUpperCase() +
    to255(b).toString(16).padStart(2, '0').toUpperCase();
}

// 32-bit xorshift PRNG. Tiny, deterministic, good-enough for grid layout.
function makePrng(seed) {
  let s = (seed >>> 0) || 0x9E3779B9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s >>> 0;
  };
}

// Hash a string seed into a 32-bit int.
export function hashSeed(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i += 1) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build the two layers. Returns:
//   {
//     seed, gridC,
//     layerA: Int32Array of palette indices, length colsA*rowsA,
//     layerB: Int32Array of palette indices, length colsB*rowsB,
//     colsA, rowsA, colsB, rowsB, w, h,
//   }
//
// Layer A is aligned to (0, 0). Layer B is conceptually offset by
// (-c/2, -c/2), so its cell (cx, cy) covers
//   [cx*c - c/2, (cx+1)*c - c/2) x [cy*c - c/2, (cy+1)*c - c/2).
// This guarantees every screen pixel in [0, w) x [0, h) has a Layer-B
// color. Layer B therefore needs colsB = colsA + 1 / rowsB = rowsA + 1
// cells in the worst case so the right/bottom edge is fully covered.
export function buildGrid({ w, h, gridC = 32, seed }) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`buildGrid: invalid dimensions ${w}x${h}`);
  }
  if (!Number.isInteger(gridC) || gridC < 4) {
    throw new Error(`buildGrid: gridC must be an integer >= 4, got ${gridC}`);
  }
  const seedNum = (typeof seed === 'number')
    ? (seed >>> 0)
    : hashSeed(String(seed));
  const prng = makePrng(seedNum);

  const colsA = Math.ceil(w / gridC);
  const rowsA = Math.ceil(h / gridC);
  // For B cell at (cx, cy), its right edge is (cx+1)*c - c/2.
  // To cover pixel x = w-1 we need (cx+1)*c - c/2 > w-1, i.e. cx >= (w-1 + c/2)/c.
  // The smallest such cx is ceil((w-1 + c/2)/c). Add a small safety margin.
  const colsB = Math.ceil((w - 1 + gridC / 2) / gridC) + 1;
  const rowsB = Math.ceil((h - 1 + gridC / 2) / gridC) + 1;

  const layerA = new Int32Array(colsA * rowsA);
  const layerB = new Int32Array(colsB * rowsB);

  for (let i = 0; i < layerA.length; i += 1) {
    layerA[i] = prng() % PALETTE.length;
  }
  for (let i = 0; i < layerB.length; i += 1) {
    layerB[i] = prng() % PALETTE.length;
  }

  return {
    seed: seedNum,
    gridC,
    layerA,
    layerB,
    colsA, rowsA, colsB, rowsB,
    w, h,
  };
}

// Look up the palette index at a screen pixel for a given layer.
// Returns -1 if the pixel is outside the layer's coverage.
export function layerAtPixel(grid, layer, x, y) {
  const c = grid.gridC;
  if (layer === 'A') {
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return -1;
    const cx = Math.floor(x / c);
    const cy = Math.floor(y / c);
    if (cx >= grid.colsA || cy >= grid.rowsA) return -1;
    return grid.layerA[cy * grid.colsA + cx];
  }
  // B cell (cx, cy) covers [cx*c - c/2, (cx+1)*c - c/2).
  // Inverse: cx = floor((x + c/2) / c).
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return -1;
  const cx = Math.floor((x + c / 2) / c);
  const cy = Math.floor((y + c / 2) / c);
  if (cx < 0 || cy < 0 || cx >= grid.colsB || cy >= grid.rowsB) return -1;
  return grid.layerB[cy * grid.colsB + cx];
}

// Return the (colorA, colorB) pair for a screen pixel as hex strings.
export function colorsAtPixel(grid, x, y) {
  const ia = layerAtPixel(grid, 'A', x, y);
  const ib = layerAtPixel(grid, 'B', x, y);
  return {
    color1: ia >= 0 ? PALETTE[ia] : null,
    color2: ib >= 0 ? PALETTE[ib] : null,
    indexA: ia,
    indexB: ib,
  };
}
