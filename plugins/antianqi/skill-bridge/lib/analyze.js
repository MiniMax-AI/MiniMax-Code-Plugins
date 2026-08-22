// lib/analyze.js — Frontmatter parsing and hardcoded-paths/commands scan.
//
// We avoid `js-yaml` to keep the dependency surface small. The
// frontmatter we need to parse is a constrained YAML subset:
//
//   - top-level `key: value` lines
//   - top-level `key: |` (or `key: >`) followed by an indented block
//   - top-level `key:` with one level of nested keys (used by
//     `descriptions.zh-Hans`, `metadata.x`, etc.)
//
// Everything else (anchors, tags, multi-doc, flow style) is unsupported
// by design; skill authors should keep frontmatter simple.

import fs from 'node:fs/promises';
import { readFileSafe, resolveSkillSource } from './detect.js';

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

// ---------- Constrained YAML parser ----------

const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*?)\s*$/;

/**
 * Parse a constrained YAML block. Supports:
 *   - `key: value`          (string / number / boolean / null)
 *   - `key: "..."` / `key: '...'`  (quoted string)
 *   - `key: |` / `key: >`   (block scalar, indented body)
 *   - `key:` (followed by indented sub-keys) -> nested object
 *
 * Throws on unsupported constructs.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseYamlBlock(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  // Stack of frames: each holds the current container and its indent
  // level. We start at indent -2 so that the first top-level key (indent 0)
  // satisfies `indent === top.indent + 2` without special-casing.
  const stack = [{ indent: -2, container: root }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const m = line.match(KEY_LINE_RE);
    if (!m) {
      throw new Error(`cannot parse line: ${JSON.stringify(line)}`);
    }
    const [, ws, key, rawValue] = m;
    const indent = ws.length;
    // Pop frames until we are at the right parent.
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const top = stack[stack.length - 1];
    // The current line's indent must be exactly top.indent + 2.
    if (indent !== top.indent + 2) {
      throw new Error(`bad indent at line: ${JSON.stringify(line)}`);
    }
    if (rawValue === '' || rawValue === '|' || rawValue === '>') {
      if (rawValue === '|' || rawValue === '>') {
        const blockIndent = indent + 2;
        const blockLines = [];
        i++;
        while (i < lines.length) {
          const bl = lines[i];
          if (bl.trim() === '') { blockLines.push(''); i++; continue; }
          const bi = bl.match(/^(\s*)/)[1].length;
          if (bi < blockIndent) break;
          blockLines.push(bl.slice(blockIndent));
          i++;
        }
        top.container[key] = blockLines.join('\n').replace(/\n+$/, '');
      } else {
        // nested object
        const obj = {};
        top.container[key] = obj;
        stack.push({ indent, container: obj });
      }
    } else {
      top.container[key] = coerceScalar(rawValue);
    }
    i++;
  }
  return root;
}

function coerceScalar(v) {
  // Quoted scalars are always returned as strings, even if the content
  // would otherwise look like a number / boolean / null. This matches
  // YAML's "explicit string" rule and matches what dumpYamlBlock emits
  // for reserved words and string-looking numbers.
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Parse a SKILL.md into frontmatter (object) + body (string).
 * @param {string} text
 * @returns {{ frontmatter: object, body: string, ok: boolean, err?: string }}
 */
export function parseFrontmatter(text) {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: {}, body: text, ok: false, err: 'no frontmatter' };
  try {
    const fm = parseYamlBlock(m[1]);
    return { frontmatter: fm, body: m[2], ok: true };
  } catch (e) {
    return { frontmatter: {}, body: text, ok: false, err: 'yaml parse: ' + e.message };
  }
}

// ---------- Pattern scanning ----------

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
 * Reconstruct the full file text from frontmatter + body so that the
 * pattern scans see the same content the human reader would.
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {string}
 */
export function reconstructText(frontmatter, body) {
  return `---\n${dumpYamlBlock(frontmatter)}---\n${body}`;
}

// ---------- Full file analyze ----------

/**
 * @param {string} filePath  a SKILL.md path or a directory containing one
 * @returns {Promise<AnalyzedSkill>}
 */
export async function analyzeSkillFile(filePath) {
  // Resolve directory → SKILL.md; throws a descriptive error if not found.
  const resolved = await resolveSkillSource(filePath);
  const det = await readFileSafe(resolved);
  const text = det.text;
  const { frontmatter, body, ok, err } = parseFrontmatter(text);

  const fullText = ok ? reconstructText(frontmatter, body) : text;

  const warnings = [];
  if (!ok) warnings.push(`frontmatter: ${err}`);
  if (det.encoding === 'unknown') warnings.push('encoding: could not determine (left as lossy utf-8)');
  if (det.encoding === 'gbk' && det.replaced) warnings.push('encoding: converted from GBK to UTF-8');

  return {
    inputPath: resolved,
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

// ---------- YAML dump (used internally and by transform-skill.js) ----------

const NEEDS_QUOTING = /[:#&*!|>'"%@`{}[\],\n]/;
const RESERVED_WORDS = new Set(['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off']);
const STARTS_WITH_NUMBER = /^-?\d/;

/**
 * Serialize a JS object as a constrained YAML block. Matches the
 * subset our parseYamlBlock understands.
 *
 * @param {object} obj
 * @param {number} [indent=0]
 * @returns {string}
 */
export function dumpYamlBlock(obj, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === null) {
      lines.push(`${pad}${k}: null`);
      continue;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${pad}${k}: []`);
        continue;
      }
      lines.push(`${pad}${k}:`);
      for (const item of v) {
        if (item === null) {
          lines.push(`${pad}  - null`);
        } else if (typeof item === 'object' && !Array.isArray(item)) {
          const childPad = `${pad}  `;
          const dumped = dumpYamlBlock(item, indent + 1);
          // Indent the first line with the dash, subsequent lines stay aligned.
          const [first, ...rest] = dumped.split('\n');
          lines.push(`${childPad}- ${first.trimStart()}`);
          for (const r of rest) lines.push(r);
        } else {
          lines.push(`${pad}  - ${scalarToYaml(item)}`);
        }
      }
      continue;
    }
    if (typeof v === 'object') {
      if (Object.keys(v).length === 0) {
        lines.push(`${pad}${k}: {}`);
        continue;
      }
      lines.push(`${pad}${k}:`);
      lines.push(dumpYamlBlock(v, indent + 1));
      continue;
    }
    if (typeof v === 'string' && v.includes('\n')) {
      lines.push(`${pad}${k}: |`);
      for (const line of v.split('\n')) lines.push(`${pad}  ${line}`);
      continue;
    }
    lines.push(`${pad}${k}: ${scalarToYaml(v)}`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

function scalarToYaml(v) {
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v !== 'string') return JSON.stringify(v);
  if (v === '') return '""';
  if (RESERVED_WORDS.has(v)) return JSON.stringify(v);
  if (STARTS_WITH_NUMBER.test(v)) return JSON.stringify(v);
  if (NEEDS_QUOTING.test(v) || /^\s|\s$/.test(v)) return JSON.stringify(v);
  return v;
}
