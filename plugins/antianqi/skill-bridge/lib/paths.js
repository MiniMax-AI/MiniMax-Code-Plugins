// lib/paths.js — Path parameterization and filename fix.
//
// We can't statically know where an openclaw skill's "workspace" lives
// on a new machine. So we replace every hard-coded openclaw/TMP path
// with a parameterized template, and emit a metadata.openclaw_paths
// block that downstream code (or the user) can fill in.

/**
 * Each rule has:
 *   - id: short stable id
 *   - match: regex (with /g flag)
 *   - replace: replacement string (supports ${VAR} placeholders)
 *   - placeholder: which env var this maps to
 *   - notes: human-readable
 */
export const PATH_RULES = [
  {
    id: 'openclaw-workspace',
    // match either backslash or forward slash separator
    match: /C:\\Users\\Administrator\\\.openclaw[\\/]workspace[\\/]?/g,
    replace: '${OPENCLAW_WORKSPACE}/',
    placeholder: 'OPENCLAW_WORKSPACE',
    notes: 'openclaw workspace dir',
  },
  {
    id: 'openclaw-home',
    match: /C:\\Users\\Administrator\\\.openclaw[\\/]?/g,
    replace: '${OPENCLAW_HOME}/',
    placeholder: 'OPENCLAW_HOME',
    notes: 'Path under user home .openclaw/',
  },
  {
    id: 'openclaw-uniq-tilde',
    match: /~\/\.openclaw\//g,
    replace: '${OPENCLAW_HOME}/',
    placeholder: 'OPENCLAW_HOME',
    notes: 'tilde form of openclaw home (POSIX-style)',
  },
  {
    id: 'tmp-cli-anything',
    match: /\/tmp\/CLI-Anything\//g,
    replace: '${SCRATCH}/cli-anything/',
    placeholder: 'SCRATCH',
    notes: 'tmp path used by CLI-Anything harness',
  },
  {
    id: 'tmp-generic',
    match: /(?<![\w/])\/tmp\//g,
    replace: '${SCRATCH}/',
    placeholder: 'SCRATCH',
    notes: 'generic /tmp (avoid double-replacing CLI-Anything)',
  },
  {
    id: 'data-dir',
    match: /C:\\Users\\Administrator\\\.minimax[\\/]?/g,
    replace: '${DATA_DIR}/',
    placeholder: 'DATA_DIR',
    notes: 'mavis data dir (cross-platform alias)',
  },
];

/**
 * Collapse runs of repeated slashes inside ${...} placeholders that
 * were introduced by boundary mismatches between the regex and the
 * surrounding text. Cheap post-pass.
 */
function collapseAfterPlaceholder(text) {
  return text.replace(/(\$\{[A-Z_]+\}\/)\/+/g, '$1');
}

/**
 * @typedef {Object} PathChange
 * @property {string} id
 * @property {number} count
 * @property {string} placeholder
 * @property {string} notes
 */

/**
 * Apply all path rules to the given text. Returns the rewritten text
 * and a per-rule change report.
 *
 * @param {string} text
 * @returns {{ text: string, changes: PathChange[] }}
 */
export function parameterizePaths(text) {
  let out = text;
  const changes = [];

  for (const rule of PATH_RULES) {
    // Reset lastIndex because we reuse the regex with /g
    rule.match.lastIndex = 0;
    const before = out;
    out = out.replace(rule.match, rule.replace);
    if (out !== before) {
      const count = (before.match(rule.match) || []).length;
      changes.push({
        id: rule.id,
        count,
        placeholder: rule.placeholder,
        notes: rule.notes,
      });
    }
  }

  out = collapseAfterPlaceholder(out);
  return { text: out, changes };
}

/**
 * Try to recover a sensible Chinese filename from a mojibake one.
 * Best-effort only — v0.1 returns the input unchanged if we can't decide.
 *
 * The common pattern: `xxx-????.md` where `????` is 6-12 chars of garbled
 * bytes. We can't decode without a GBK byte stream, so v0.1 just detects
 * and warns.
 *
 * @param {string} name
 * @returns {{ name: string, recoverable: boolean, hint: string }}
 */
export function suggestFilename(name) {
  // ASCII kebab-case ending in .md → keep as-is
  if (/^[\x00-\x7F]+$/.test(name) && /\.md$/.test(name)) {
    return { name, recoverable: true, hint: 'ascii, no change needed' };
  }
  // Has replacement chars or mojibake pattern → flag for manual review
  if (/\uFFFD{2,}|�/.test(name)) {
    return { name, recoverable: false, hint: 'mojibake detected; rename manually' };
  }
  return { name, recoverable: true, hint: 'looks valid utf-8' };
}
