// encode.mjs
//
// Diagnostic / symmetry helpers: given an (x, y) pixel, return the
// (color1, color2, pos) tuple that the model would use to address it.
// Round-tripped against decode.mjs for tests.

import { PALETTE, colorsAtPixel } from './noise-grid.mjs';

// For a pixel (x, y), compute the canonical sub-cell address.
// pos is the offset within the sub-cell, range [-(C/4), +(C/4)) on each axis.
export function encodePixel(grid, x, y) {
  const c = grid.gridC;
  const half = c / 2;

  // Sub-cell origin: A's macro cell origin, plus the B offset inside it.
  const macroX = Math.floor(x / c) * c;
  const macroY = Math.floor(y / c) * c;
  // Which sub-cell quadrant (TL, TR, BL, BR) of the macro cell?
  // Layer B's grid is offset by (c/2, c/2). So:
  //   localX = x - macroX
  //   localY = y - macroY
  // If localX < c/2 we are in the LEFT half of A's macro cell, otherwise RIGHT.
  // But B's offset means B's cell boundary sits at c/2; the sub-cell
  // containing (x, y) is determined by which of A's 4 quadrants we are in.
  const localX = x - macroX;
  const localY = y - macroY;
  const quadrant = (localX >= half ? 2 : 0) | (localY >= half ? 1 : 0);

  // Sub-cell origin in pixel coordinates:
  const subOriginX = macroX + (quadrant & 2 ? half : 0);
  const subOriginY = macroY + (quadrant & 1 ? half : 0);

  const { color1, color2 } = colorsAtPixel(grid, x, y);

  // pos is (x - subOriginX - half/2, y - subOriginY - half/2),
  // i.e. offset from sub-cell center.
  const pos = [x - subOriginX - half / 2, y - subOriginY - half / 2];

  return {
    color1,
    color2,
    pos,
    quadrant,
    subOrigin: [subOriginX, subOriginY],
    macroOrigin: [macroX, macroY],
  };
}
