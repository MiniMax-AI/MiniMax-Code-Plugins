// lib/detect.js — Encoding detection (GBK vs UTF-8) and mojibake recovery.
//
// Strategy:
//   1. Read raw bytes.
//   2. Try UTF-8 strict decode: if no replacement chars, it's UTF-8.
//   3. Else try GBK decode via iconv-lite: if it produces mostly CJK
//      printable characters (no replacement chars), the source was GBK
//      and we can restore it to UTF-8.
//   4. Else: declare unknown (do not modify).
//
// We deliberately avoid chardet-style heuristics in v0.1 because the
// failure mode of guessing wrong is silent corruption of skill text.

import iconv from 'iconv-lite';
import fs from 'node:fs/promises';

const REPLACEMENT = '\uFFFD';
const PRINTABLE_CJK = /[\u3400-\u9FFF]/;
const NON_ASCII_PRINTABLE = /[^\x00-\x7F]/;

/**
 * @typedef {Object} DetectResult
 * @property {'utf-8'|'gbk'|'unknown'} encoding
 * @property {string} text            - The recovered UTF-8 text.
 * @property {string} originalEncoding - What we believe the source was.
 * @property {boolean} replaced        - True if conversion was needed.
 * @property {number} confidence       - 0..1 heuristic confidence.
 * @property {string} reason
 */

/**
 * Detect the encoding of a Buffer and return UTF-8 text.
 * @param {Buffer} buf
 * @returns {DetectResult}
 */
export function detectEncoding(buf) {
  // 1. UTF-8 strict
  try {
    const text = buf.toString('utf-8');
    if (!text.includes(REPLACEMENT)) {
      // Cheap "is this actually CJK text" check: at least one non-ASCII printable.
      const hasNonAscii = NON_ASCII_PRINTABLE.test(text);
      return {
        encoding: 'utf-8',
        text,
        originalEncoding: 'utf-8',
        replaced: false,
        confidence: hasNonAscii ? 0.95 : 0.8,
        reason: 'utf-8 decode clean',
      };
    }
  } catch {
    /* fall through */
  }

  // 2. GBK via iconv-lite
  if (iconv.encodingExists('gbk')) {
    try {
      const text = iconv.decode(buf, 'gbk');
      // GBK almost never produces \uFFFD for valid byte sequences.
      if (!text.includes(REPLACEMENT) && PRINTABLE_CJK.test(text)) {
        return {
          encoding: 'gbk',
          text,
          originalEncoding: 'gbk',
          replaced: true,
          confidence: 0.9,
          reason: 'gbk decode clean and contains CJK',
        };
      }
    } catch {
      /* fall through */
    }
  }

  // 3. Last resort: lossy UTF-8, marked unknown so caller can warn.
  const text = buf.toString('utf-8');
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
 * Read a file from disk and return its detected encoding + UTF-8 text.
 * @param {string} filePath
 * @returns {Promise<DetectResult>}
 */
export async function readFileSafe(filePath) {
  const buf = await fs.readFile(filePath);
  return detectEncoding(buf);
}

/**
 * Heuristic: does the given UTF-8 text LOOK like GBK mojibake that
 * was already partially normalized? Useful when the file on disk is
 * already a mess of replacement characters and there's no clean byte
 * stream to go back to.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isLikelyGbkMojibake(text) {
  // Pattern: 2+ consecutive U+FFFD surrounded by ASCII or whitespace.
  // This catches the common "????-???" rendering we see in terminal output.
  return /\uFFFD{2,}/.test(text) || /[?]{3,}/.test(text);
}
