// lib/analyze.js — Frontmatter parsing and hardcoded-paths/commands scan.
//
// We avoid `gray-matter` to keep the dependency surface small. The
// frontmatter we need to parse is a constrained subset of YAML:
//   - top-level `key: value` lines
//   - top-level `key: |` followed by an indented block
//   - top-level `key:` with nested keys (one level deep, used by
//     `descriptions.zh-Hans` and `metadata.x`).

import * as yaml from 'js-yaml';
import fs from 'node:fs/promises';
import { readFileSafe } from './detect.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

const EXTERNAL_COMMAND_PATTERNS = [
  { re: /\bpip\s+install\b/g, label: 'pip install' },
  { re: /\bcli-anything-[a-z0-9-]+/g, label: 'cli-anything CLI' },
  { re: /\bpython3?\s+/g, label: 'python invocation' },
  { re: /\bcurl\s+/g, label: 'curl' },
  { re: /\bwget\s+/g, label: 'wget' },
  { re: /\bComfyUI\b/g, label: 'ComfyUI reference' },
  { re: /\bESP32\b/g, label: 'ESP32 reference' },
  { re: /\bDouyin|抖音\b/g, label: 'Douyin reference' },
  { re: /\bTTS\b/g, label: 'TTS reference' },
  { re: /\bfeishu|飞书\b/g, label: 'Feishu reference' },
  { re: /\b\${\w+}\b/g, label: 'unresolved template var' },
];

const PATH_PATTERNS = [
  { re: /C:\\Users\\[^"\s`']+/g, label: 'absolute Windows user path' },
  { re: /~\/\.[a-zA-Z0-9_.-]+/g, label: 'tilde home path' },
  { re: /(?<![\w/])\/tmp\//g, label: 'macOS/Linux /tmp' },
  { re: /C:\\Users\\Administrator\\\.openclaw\\/g, label: 'openclaw home' },
];

/**
 * @typedef {Object} AnalyzedSkill
 * @property {string} inputPath
 * @property {string} encoding
 * @property {boolean} convertedFromGbk
 * @property {object} frontmatter
 * @property {string} body
 * @property {Array<{label:string, samples:string[]}>} hardcodedPaths
 * @property {Array<{label:string, samples:string[]}>} externalCommands
 * @property {string[]} warnings
 */

/**
 * Parse a SKILL.md into frontmatter (object) + body (string).
 * @param {string} text
 * @returns {{ frontmatter: object, body: string, ok: boolean, err?: string }}
 */
export function parseFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text, ok: false, err: 'no frontmatter' };
  try {
    const fm = yaml.load(m[1], { filename: undefined }) || {};
    return { frontmatter: fm, body: m[2], ok: true };
  } catch (e) {
    return { frontmatter: {}, body: text, ok: false, err: 'yaml parse: ' + e.message };
  }
}

/**
 * Find matches of a set of patterns and return deduplicated samples.
 * @param {string} text
 * @param {Array<{re:RegExp,label:string}>} patterns
 * @returns {Array<{label:string, samples:string[]}>}
 */
function scanPatterns(text, patterns) {
  const out = [];
  for (const { re, label } of patterns) {
    re.lastIndex = 0;
    const samples = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      samples.add(m[0]);
      if (samples.size >= 5) break;
    }
    if (samples.size > 0) out.push({ label, samples: [...samples] });
  }
  return out;
}

/**
 * Full analyze of a single skill file.
 * @param {string} filePath
 * @returns {Promise<AnalyzedSkill>}
 */
export async function analyzeSkillFile(filePath) {
  const det = await readFileSafe(filePath);
  const text = det.text;
  const { frontmatter, body, ok, err } = parseFrontmatter(text);

  const fullText = ok ? `---\n${yaml.dump(frontmatter)}---\n${body}` : text;

  const warnings = [];
  if (!ok) warnings.push(`frontmatter: ${err}`);
  if (det.encoding === 'unknown') warnings.push('encoding: could not determine (left as lossy utf-8)');
  if (det.encoding === 'gbk' && det.replaced) warnings.push('encoding: converted from GBK to UTF-8');

  return {
    inputPath: filePath,
    encoding: det.encoding,
    convertedFromGbk: det.replaced,
    frontmatter,
    body,
    fullText,
    hardcodedPaths: scanPatterns(fullText, PATH_PATTERNS),
    externalCommands: scanPatterns(fullText, EXTERNAL_COMMAND_PATTERNS),
    warnings,
  };
}
