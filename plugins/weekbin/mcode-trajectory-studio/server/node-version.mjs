/**
 * The Node version this Plugin needs, in one place.
 *
 * The Plugin reads the runtime's projection with the built-in `node:sqlite`, which
 * keeps it free of native modules and ABI constraints of its own — but that module
 * only exists, un-flagged, from a specific Node release. Measured rather than
 * assumed:
 *
 *   Node 22.12.0   ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite
 *   Node 22.13.0   imports, and the bundled SQLite is 3.47.2 with FTS5 *absent*
 *   Node 22.19.0   bundled SQLite 3.50.4, FTS5 present
 *   Node 23.4.0    bundled SQLite 3.47.1, FTS5 *absent* — FTS5 is not monotonic in
 *                  the Node version, because each line branched from a different
 *                  dependency bump
 *   Node 24.0.0    bundled SQLite 3.49.1, FTS5 present
 *
 * So there are two thresholds, and conflating them is how a manifest ends up
 * overstating support:
 *
 *   FLOOR          22.13.0 — below it the module does not exist and the process
 *                  cannot start at all. Enforced, with a readable message.
 *   VERIFIED_RANGE mcode's own `engines` range. That is the host this Plugin is
 *                  loaded by, and it conveniently coincides with FTS5 being
 *                  present, so full-text search always works inside it.
 *
 * Between the two — 22.13.0 through 22.18.x, and every 23.x — the Plugin runs and
 * degrades: `trajectory_search` reports no matches and a warning instead of
 * throwing. That degradation is covered by `test/node-version.test.mjs`.
 */

/** The lowest Node that provides `node:sqlite` without `--experimental-sqlite`. */
export const NODE_FLOOR = Object.freeze([22, 13, 0]);
export const NODE_FLOOR_TEXT = '22.13.0';

/**
 * The range mcode itself runs on (`@minimax-ai/code` manifest `engines`):
 * `>=22.19 <23 || >=24 <27`. The Plugin mirrors it so the two never disagree, and
 * because it is exactly the range in which the bundled SQLite has FTS5.
 */
export const VERIFIED_RANGE_TEXT = '>=22.19 <23 || >=24 <27';

export const FTS5_NOTE =
  'Full-text search needs the bundled SQLite to have FTS5: present from Node 22.19.0 ' +
  'and 24.0.0, absent in 22.13.0–22.18.x and throughout 23.x, where search degrades ' +
  'to no matches instead of failing.';

function parseVersion(value) {
  const [major = 0, minor = 0, patch = 0] = String(value)
    .replace(/^v/u, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

/** True when `version` is at least `[major, minor, patch]`. */
export function atLeast(version, [major, minor, patch]) {
  const [a, b, c] = parseVersion(version);
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/** True when this Node can load `node:sqlite` at all. */
export function isNodeSupported(version = process.versions.node) {
  return atLeast(version, NODE_FLOOR);
}

/**
 * True when the version sits in the range mcode supports — the range this Plugin
 * is tested against. Outside it the Plugin still runs, but the host is unverified.
 */
export function isWithinVerifiedRange(version = process.versions.node) {
  const [a, b] = parseVersion(version);
  if (a === 22) return b >= 19;
  if (a === 23) return false;
  return a >= 24 && a < 27;
}

/** The message a too-old runtime gets, instead of a module-resolution crash. */
export function nodeFloorMessage(version = process.versions.node) {
  return `mcode-trajectory-studio requires Node.js ${NODE_FLOOR_TEXT} or newer ` +
    `(running ${version}). The built-in node:sqlite module it reads the runtime ` +
    `projection with is only available without --experimental-sqlite from ` +
    `Node.js ${NODE_FLOOR_TEXT}.\n`;
}
