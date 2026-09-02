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
 * @property {boolean} ok          false when frontmatter could not be parsed
 * @property {string}  [err]       parse error message when ok === false
 */

// ---------- Constrained YAML parser ----------

const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*?)\s*$/;
const LIST_ITEM_RE = /^(\s*)- (.*?)\s*$/;

/**
 * Parse a constrained YAML block. Supports:
 *   - `key: value`          (string / number / boolean / null)
 *   - `key: "..."` / `key: '...'`  (quoted string)
 *   - `key: |` / `key: >`   (block scalar, indented body)
 *   - `key:` (followed by indented sub-keys) -> nested object
 *   - `key:` (followed by `  - item`) -> list of scalars / objects
 *   - `key: [a, b, c]`     -> flow-style list of scalars
 *
 * Throws on unsupported constructs.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseYamlBlock(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  // Stack of frames: each holds the current container (object or array)
  // and its indent level. We start at indent -2 so that the first
  // top-level key (indent 0) satisfies `indent === top.indent + 2`
  // without special-casing.
  const stack = [{ indent: -2, container: root, kind: 'object' }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    // 1) Detect a list-item line: "  - foo" or "  - name: bar".
    //    The dash must be at the *current* container indent + 2.
    const lm = line.match(LIST_ITEM_RE);
    if (lm) {
      const [, ws, raw] = lm;
      const indent = ws.length;
      // Pop frames until we find a list frame at the right indent.
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      const top = stack[stack.length - 1];
      if (top.kind !== 'list') {
        throw new Error(`list item at ${JSON.stringify(line)} but parent is not a list`);
      }
      if (indent !== top.indent + 2) {
        throw new Error(`bad list-item indent at ${JSON.stringify(line)}`);
      }
      // The item is either a scalar (raw coerced) or an inline object
      // starting with a key: value on the same line. The rest of the
      // object (if any) lives on subsequent lines at indent + 2.
      const sub = parseListItem(raw, lines, indent, i);
      top.container.push(sub.value);
      i = sub.nextIndex;
      continue;
    }

    // 2) Otherwise, a normal `key: value` line.
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
    if (top.kind !== 'object') {
      throw new Error(`mapping at ${JSON.stringify(line)} but parent is a list`);
    }
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
      } else if (peekIsList(lines, i + 1, indent + 2)) {
        // Nested list. Allocate an array, push it as the value, and
        // open a new list frame at the right indent so subsequent
        // `- item` lines are appended here.
        const arr = [];
        top.container[key] = arr;
        stack.push({ indent, container: arr, kind: 'list' });
        i++;
        // Do NOT consume a line; the list-item line will be picked up
        // by the LIST_ITEM_RE branch on the next iteration.
      } else {
        // nested object
        const obj = {};
        top.container[key] = obj;
        stack.push({ indent, container: obj, kind: 'object' });
        i++;
      }
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      // Flow-style list: `key: [a, b, c]`. We support scalar items only.
      const inner = rawValue.slice(1, -1);
      const items = inner.length === 0 ? [] : inner.split(',').map((s) => coerceScalar(s.trim()));
      top.container[key] = items;
      i++;
    } else {
      top.container[key] = coerceScalar(rawValue);
      i++;
    }
  }
  return root;
}

function peekIsList(lines, start, expectedIndent) {
  // True if the next non-blank line at exactly expectedIndent is a
  // list item belonging to the current key.
  for (let k = start; k < lines.length; k++) {
    const ln = lines[k];
    if (ln.trim() === '') continue;
    const m = ln.match(/^(\s*)- /);
    if (!m) return false;
    return m[1].length === expectedIndent;
  }
  return false;
}

function parseListItem(raw, lines, itemIndent, startIndex) {
  // raw is the text after "- ". Two shapes:
  //   - scalar (no colon): return the coerced value, advance one line.
  //   - inline object: first line is "key: value", further lines at
  //     itemIndent + 2 are more `key: value` pairs. We do NOT recurse
  //     into parseYamlBlock here because re-indenting a synthetic block
  //     for nested arrays / deeper objects is brittle. Instead, scan
  //     continuation lines directly and build a flat object — one
  //     level of nested mapping is all the v0.2 skill-bridge emits.
  if (!raw.includes(':')) {
    return { value: coerceScalar(raw), nextIndex: startIndex + 1 };
  }
  const obj = {};
  const first = raw.match(/^([A-Za-z0-9_.\-]+)\s*:\s*(.*?)\s*$/);
  if (!first) {
    return { value: coerceScalar(raw), nextIndex: startIndex + 1 };
  }
  obj[first[1]] = coerceScalar(first[2]);
  const contIndent = itemIndent + 2;
  let k = startIndex + 1;
  while (k < lines.length) {
    const ln = lines[k];
    if (ln.trim() === '') { k++; continue; }
    const ind = ln.match(/^(\s*)/)[1].length;
    if (ind < contIndent) break;
    const cm = ln.match(/^(\s*)([A-Za-z0-9_.\-]+)\s*:\s*(.*?)\s*$/);
    if (!cm) break;
    obj[cm[2]] = coerceScalar(cm[3]);
    k++;
  }
  return { value: obj, nextIndex: k };
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

  // Fail closed: if the frontmatter is not parseable, do NOT silently
  // continue with an empty frontmatter (which would discard the
  // original metadata in the output). The caller is expected to check
  // `report.ok` and refuse to convert in that case.
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
    ok,
    ...(ok ? {} : { err }),
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
          // List item that is itself a mapping. The first key shares
          // the line with the "- " marker; subsequent keys must be
          // indented one more level than the marker (item.content_indent
          // = item.indent + 2). The recursive dump uses indent + 2 so
          // its pad is two more spaces than the outer pad, which is
          // exactly what we want for the "role: maintainer" continuation.
          const innerDump = dumpYamlBlock(item, indent + 2);
          const itemLines = innerDump.split('\n').filter((l) => l.length > 0);
          if (itemLines.length === 0) {
            lines.push(`${pad}  - {}`);
          } else {
            lines.push(`${pad}  - ${itemLines[0].trimStart()}`);
            for (let i = 1; i < itemLines.length; i++) {
              lines.push(itemLines[i]);
            }
          }
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
