// decode.mjs
//
// Canonical direction used by the MCP tools:
// Given a (color1, color2, pos, [button]) tuple, find the absolute pixel
// (x, y) on the screen and dispatch the requested action.

import { PALETTE } from './noise-grid.mjs';

const QUADRANT_OFFSETS = [
  [0, 0], // TL  (0)
  [0, 1], // BL  (1)
  [1, 0], // TR  (2)
  [1, 1], // BR  (3)
];

// Find every pixel covered by the sub-cell whose (colorA, colorB) matches.
// Returns an array of { x, y } pixel centers — typically four, one per
// macro cell that contains the pair.
function findSubCells(grid, color1, color2) {
  const c = grid.gridC;
  const half = c / 2;
  const matches = [];
  const lc1 = color1.toLowerCase();
  const lc2 = color2.toLowerCase();
  for (let cy = 0; cy < grid.rowsA; cy += 1) {
    for (let cx = 0; cx < grid.colsA; cx += 1) {
      const ia = grid.layerA[cy * grid.colsA + cx];
      const c1 = PALETTE[ia];
      if (c1.toLowerCase() !== lc1) continue;
      const macroX = cx * c;
      const macroY = cy * c;
      // The four sub-cells live at each quadrant. The B cell overlapping
      // sub-cell (qx, qy) within macro cell (cx, cy) is (cx+qx, cy+qy),
      // because B's cell (cx, cy) covers [cx*c - c/2, cx*c + c/2), and
      // the TL sub-cell of A's macro cell (cx, cy) sits at [cx*c, cx*c + c/2)
      // which falls inside B cell (cx, cy).
      for (let q = 0; q < 4; q += 1) {
        const [qx, qy] = QUADRANT_OFFSETS[q];
        const bx = cx + qx;
        const by = cy + qy;
        if (bx < 0 || by < 0 || bx >= grid.colsB || by >= grid.rowsB) continue;
        const ib = grid.layerB[by * grid.colsB + bx];
        const c2 = PALETTE[ib];
        if (c2.toLowerCase() === lc2) {
          matches.push({
            macroOrigin: [macroX, macroY],
            quadrant: q,
            subOrigin: [macroX + qx * half, macroY + qy * half],
          });
        }
      }
    }
  }
  return matches;
}

// Resolve (color1, color2, pos) to a single pixel. If multiple sub-cells
// match the color pair, we pick the topmost-leftmost (deterministic).
// If no match, returns null and the caller should report an error.
export function decodeAddress(grid, { color1, color2, pos }) {
  const matches = findSubCells(grid, color1, color2);
  if (matches.length === 0) return null;
  // Sort by subOrigin (top-left first) for determinism.
  matches.sort((a, b) => {
    if (a.subOrigin[1] !== b.subOrigin[1]) return a.subOrigin[1] - b.subOrigin[1];
    return a.subOrigin[0] - b.subOrigin[0];
  });
  const m = matches[0];
  const half = grid.gridC / 2;
  const [px, py] = pos;
  // Clamp to sub-cell bounds to be safe.
  const dx = Math.max(-half / 2, Math.min(half / 2 - 1, px | 0));
  const dy = Math.max(-half / 2, Math.min(half / 2 - 1, py | 0));
  const x = m.subOrigin[0] + half / 2 + dx;
  const y = m.subOrigin[1] + half / 2 + dy;
  return { x, y, matches: matches.length, subOrigin: m.subOrigin };
}
