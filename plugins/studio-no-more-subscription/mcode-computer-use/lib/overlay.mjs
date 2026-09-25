// overlay.mjs
//
// Compose a screenshot (PNG byte buffer) with the two noise layers at low
// alpha, returning a PNG byte buffer. Pure given inputs.
//
// We do pure-JS PNG decoding and encoding via pngjs (no native binaries).
// The bundled encoder/decoder is implemented in lib/png-pure.mjs.

import { PALETTE } from './noise-grid.mjs';
import { Png } from './png-pure.mjs';

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

// Compose an overlay. `pngBytes` is a Buffer with the screenshot PNG.
// `alpha` is 0..1; default 0.22 (the plan calls for low-alpha overlay).
export async function composeOverlay(pngBytes, grid, { alpha = 0.22 } = {}) {
  const src = await Png.decode(pngBytes);
  const { width: w, height: h, data: srcRgba } = src;

  // Use a fresh copy so we don't mutate the caller's buffer.
  const out = Buffer.from(srcRgba);

  const c = grid.gridC;
  const half = c / 2;

  // Layer A: aligned to (0, 0). For each cell, blend its color.
  for (let cy = 0; cy < grid.rowsA; cy += 1) {
    for (let cx = 0; cx < grid.colsA; cx += 1) {
      const ia = grid.layerA[cy * grid.colsA + cx];
      const [r, g, b] = hexToRgb(PALETTE[ia]);
      const x0 = cx * c;
      const y0 = cy * c;
      const x1 = Math.min(x0 + c, w);
      const y1 = Math.min(y0 + c, h);
      blendRect(out, w, x0, y0, x1, y1, r, g, b, alpha);
    }
  }

  // Layer B: B cell (cx, cy) covers [cx*c - c/2, (cx+1)*c - c/2).
  // The first B cell (0,0) starts at (-c/2, -c/2), so half of it is
  // off-screen on the top-left. We clip to screen bounds.
  for (let cy = 0; cy < grid.rowsB; cy += 1) {
    for (let cx = 0; cx < grid.colsB; cx += 1) {
      const ib = grid.layerB[cy * grid.colsB + cx];
      const [r, g, b] = hexToRgb(PALETTE[ib]);
      const x0 = cx * c - half;
      const y0 = cy * c - half;
      const x1 = Math.min(x0 + c, w);
      const y1 = Math.min(y0 + c, h);
      if (x1 <= 0 || y1 <= 0 || x0 >= w || y0 >= h) continue;
      const cx0 = Math.max(0, x0);
      const cy0 = Math.max(0, y0);
      // Use a slightly lower alpha for Layer B so both are visible.
      blendRect(out, w, cx0, cy0, x1, y1, r, g, b, alpha * 0.85);
    }
  }

  return await Png.encode({ width: w, height: h, data: out });
}

// Build a noise-only image at the same dimensions as the grid. Used for
// the "compact mode" returned after summarization.
export async function renderNoiseOnly(grid, { alpha = 0.55 } = {}) {
  const w = grid.w;
  const h = grid.h;
  const buf = Buffer.alloc(w * h * 4);

  const c = grid.gridC;
  const half = c / 2;

  for (let cy = 0; cy < grid.rowsA; cy += 1) {
    for (let cx = 0; cx < grid.colsA; cx += 1) {
      const ia = grid.layerA[cy * grid.colsA + cx];
      const [r, g, b] = hexToRgb(PALETTE[ia]);
      const x0 = cx * c;
      const y0 = cy * c;
      const x1 = Math.min(x0 + c, w);
      const y1 = Math.min(y0 + c, h);
      paintRect(buf, w, x0, y0, x1, y1, r, g, b, alpha);
    }
  }
  for (let cy = 0; cy < grid.rowsB; cy += 1) {
    for (let cx = 0; cx < grid.colsB; cx += 1) {
      const ib = grid.layerB[cy * grid.colsB + cx];
      const [r, g, b] = hexToRgb(PALETTE[ib]);
      const x0 = cx * c - half;
      const y0 = cy * c - half;
      const x1 = Math.min(x0 + c, w);
      const y1 = Math.min(y0 + c, h);
      if (x1 <= 0 || y1 <= 0 || x0 >= w || y0 >= h) continue;
      paintRect(buf, w, Math.max(0, x0), Math.max(0, y0), x1, y1, r, g, b, alpha * 0.85);
    }
  }
  return await Png.encode({ width: w, height: h, data: buf });
}

function blendRect(buf, w, x0, y0, x1, y1, r, g, b, alpha) {
  for (let y = y0; y < y1; y += 1) {
    const row = y * w * 4;
    for (let x = x0; x < x1; x += 1) {
      const i = row + x * 4;
      buf[i]     = (buf[i]     * (1 - alpha) + r * alpha) | 0;
      buf[i + 1] = (buf[i + 1] * (1 - alpha) + g * alpha) | 0;
      buf[i + 2] = (buf[i + 2] * (1 - alpha) + b * alpha) | 0;
      // alpha channel unchanged
    }
  }
}

function paintRect(buf, w, x0, y0, x1, y1, r, g, b, alpha) {
  for (let y = y0; y < y1; y += 1) {
    const row = y * w * 4;
    for (let x = x0; x < x1; x += 1) {
      const i = row + x * 4;
      buf[i]     = (r * alpha) | 0;
      buf[i + 1] = (g * alpha) | 0;
      buf[i + 2] = (b * alpha) | 0;
      buf[i + 3] = 255;
    }
  }
}
