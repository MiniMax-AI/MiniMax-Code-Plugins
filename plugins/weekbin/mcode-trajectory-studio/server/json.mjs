/**
 * Tolerant value helpers shared by every reader. Leaf module — imports nothing.
 *
 * The runtime's JSON columns are an internal detail, so parsing is defensive: a
 * single malformed row must not abort a whole read.
 */

/** Parse a JSON string, returning null instead of throwing on malformed input. */
export function parseJson(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Coerce a value to a finite number, or null when it is not one. */
export function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
