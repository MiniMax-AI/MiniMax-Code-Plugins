// lib/detect.js — Encoding detection (GBK vs UTF-8) and mojibake recovery.
//
// Strategy:
//   1. Try strict UTF-8 decode; if it succeeds, the file is UTF-8.
//   2. Try strict GB18030 decode (Node 22+ ships this in `TextDecoder`);
//      if it produces CJK printable text, the source was GBK and we have
//      the restored UTF-8.
//   3. Otherwise: declare unknown, do not modify.
//
// We deliberately avoid chardet-style heuristics because guessing wrong
// silently corrupts skill text.
//
// GB18030 is a strict superset of GBK and GB2312, so a "gbk" byte stream
// round-trips through `TextDecoder('gb18030')` losslessly in practice.

import fs from 'node:fs/promises';
import path from 'node:path';

const REPLACEMENT = '\uFFFD';
const PRINTABLE_CJK = /[\u3400-\u9FFF]/;
const NON_ASCII_PRINTABLE = /[^\x00-\x7F]/;

/**
 * @typedef {Object} DetectResult
 * @property {'utf-8'|'gbk'|'unknown'} encoding
 * @property {string} text
 * @property {string} originalEncoding
 * @property {boolean} replaced
 * @property {number} confidence  0..1
 * @property {string} reason
 */

/**
 * Detect the encoding of a Buffer and return UTF-8 text.
 * @param {Buffer} buf
 * @returns {DetectResult}
 */
export function detectEncoding(buf) {
  // 1. Strict UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    const hasNonAscii = NON_ASCII_PRINTABLE.test(text);
    return {
      encoding: 'utf-8',
      text,
      originalEncoding: 'utf-8',
      replaced: false,
      confidence: hasNonAscii ? 0.95 : 0.8,
      reason: 'utf-8 decode clean',
    };
  } catch {
    /* fall through to GBK */
  }

  // 2. GBK / GB18030 (built-in TextDecoder since Node 18)
  try {
    const text = new TextDecoder('gb18030', { fatal: true }).decode(buf);
    if (!text.includes(REPLACEMENT) && PRINTABLE_CJK.test(text)) {
      return {
        encoding: 'gbk',
        text,
        originalEncoding: 'gbk',
        replaced: true,
        confidence: 0.9,
        reason: 'gb18030 decode clean and contains CJK',
      };
    }
  } catch {
    /* not valid gb18030 either */
  }

  // 3. Last resort: lossy UTF-8, marked unknown so caller can warn.
  const text = new TextDecoder('utf-8').decode(buf);
  return {
    encoding: 'unknown',
    text,
    originalEncoding: 'unknown',
    replaced: false,
    confidence: 0.1,
    reason: 'could not determine; left as lossy utf-8',
  };
}

/**
 * Resolve a skill source: if filePath is a directory, look for a
 * `SKILL.md` inside it. If filePath is already a file, return it.
 * Throws a descriptive error if neither is found.
 *
 * @param {string} filePath
 * @returns {Promise<string>}  the resolved file path
 */
export async function resolveSkillSource(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.isFile()) return filePath;
  if (stat.isDirectory()) {
    const nested = path.join(filePath, 'SKILL.md');
    try {
      const nestedStat = await fs.stat(nested);
      if (nestedStat.isFile()) return nested;
    } catch {
      // fall through to the error below
    }
    throw new Error(
      `source is a directory but contains no SKILL.md: ${filePath} (looked for ${nested})`
    );
  }
  throw new Error(`source is neither file nor directory: ${filePath}`);
}

/**
 * Read a file from disk and return its detected encoding + UTF-8 text.
 * Accepts either a SKILL.md file path or a directory containing one
 * (delegates to resolveSkillSource).
 *
 * @param {string} filePath
 * @returns {Promise<DetectResult>}
 */
export async function readFileSafe(filePath) {
  const resolved = await resolveSkillSource(filePath);
  const buf = await fs.readFile(resolved);
  return detectEncoding(buf);
}

/**
 * Heuristic: does the given UTF-8 text LOOK like GBK mojibake that was
 * already partially normalized? Useful when the file on disk is a mess
 * of replacement characters and there is no clean byte stream to
 * recover from.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLikelyGbkMojibake(text) {
  return /\uFFFD{2,}/.test(text) || /\?{3,}/.test(text);
}
