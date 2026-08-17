/**
 * Code index engine: incremental project indexing, persistent caching under
 * PLUGIN_DATA, and the symbol/file/text/reference search primitives.
 *
 * Architecture is informed by open-source code search MCP servers (notably
 * LLMTooling/code-search-mcp's ctags + ripgrep + persistent-cache design), but
 * everything here is implemented from scratch on Node's standard library so the
 * plugin runs with `node ./server.mjs` and no install step. ripgrep is used as
 * an optional accelerator for text search when it is on PATH; the built-in
 * line scanner is the fallback.
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { isIgnored, parseGitignore } from './gitignore.mjs';
import { extractSymbols, getSpec, isParseable, languageForFile } from './languages.mjs';

const execFileAsync = promisify(execFile);

export const SCHEMA_VERSION = 1;
export const MAX_FILES = 20_000;
export const MAX_PARSE_BYTES = 1024 * 1024;
export const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_SNIPPET_CHARS = 160;

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn',
  'node_modules', 'bower_components',
  '__pycache__', '.venv', 'venv',
  'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.cache',
  '.idea', '.vs', '.vscode',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.eggs',
  '.terraform', '.serverless', '.parcel-cache', '.turbo',
  '.gradle', '.settings', '.yarn', '.pnpm-store',
  'Pods', '.dart_tool', '.kotlin', '.swiftpm', 'CMakeFiles', '.clangd',
]);

const textCache = new Map(); // absolute path -> { text, bytes }
const indexCache = new Map(); // "<dataDir>::<root>" -> payload
let cachedBytes = 0;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------

export async function buildIndex({ root, dataDir, force = false } = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const rootInfo = await stat(resolvedRoot).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory()) throw new Error('project_root_unavailable');

  const previous = force ? null : await loadIndexFile({ dataDir, root: resolvedRoot });
  const prevByPath = previous ? new Map(previous.files.map((file) => [file.path, file])) : new Map();

  const walk = await walkProject(resolvedRoot);
  const files = [];
  let added = 0;
  let changed = 0;
  let removed = 0;
  let reused = 0;

  for (const discovered of walk.files) {
    const prev = prevByPath.get(discovered.path);
    if (
      prev
      && prev.size === discovered.size
      && prev.mtimeMs === discovered.mtimeMs
      && prev.language === discovered.language
    ) {
      files.push({ ...discovered, symbols: prev.symbols ?? [], lineCount: prev.lineCount ?? null, hash: prev.hash ?? null });
      reused += 1;
      continue;
    }
    if (isParseable(discovered.language) && discovered.size <= MAX_PARSE_BYTES) {
      const hash = await hashFile(discovered.absPath);
      if (prev && hash !== null && prev.hash === hash && Array.isArray(prev.symbols)) {
        files.push({ ...discovered, symbols: prev.symbols, lineCount: prev.lineCount ?? null, hash });
        reused += 1;
        continue;
      }
      const parsed = await parseFile(discovered.absPath, discovered.language);
      if (prev) changed += 1;
      else added += 1;
      files.push({ ...discovered, hash, symbols: parsed.symbols, lineCount: parsed.lineCount });
    } else {
      files.push({ ...discovered, symbols: [], lineCount: null, hash: null });
      if (prev) reused += 1;
      else added += 1;
    }
  }
  for (const prevPath of prevByPath.keys()) {
    if (!files.some((file) => file.path === prevPath)) removed += 1;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Null-prototype so symbol names such as "constructor" or "__proto__" cannot collide with Object.prototype.
  const symbolIndex = Object.create(null);
  let symbolCount = 0;
  for (const file of files) {
    for (const symbol of file.symbols) {
      const defs = symbolIndex[symbol.name];
      if (defs) defs.push({ file: file.path, line: symbol.line, column: symbol.column, kind: symbol.kind });
      else symbolIndex[symbol.name] = [{ file: file.path, line: symbol.line, column: symbol.column, kind: symbol.kind }];
      symbolCount += 1;
    }
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    root: resolvedRoot,
    builtAtMs: Date.now(),
    fileCount: files.length,
    symbolCount,
    files: files.map(({ absPath, ...rest }) => rest),
    symbolIndex,
    warnings: walk.warnings.slice(0, 50),
  };

  let persisted = false;
  let indexPath = null;
  if (dataDir) {
    indexPath = await persistIndex(payload, dataDir);
    persisted = true;
  }
  setCachedIndex({ dataDir, root: resolvedRoot }, payload);

  return {
    schemaVersion: SCHEMA_VERSION,
    root: resolvedRoot,
    builtAtMs: payload.builtAtMs,
    fileCount: files.length,
    symbolCount,
    filesAdded: added,
    filesChanged: changed,
    filesRemoved: removed,
    filesReused: reused,
    truncated: walk.truncated,
    persisted,
    indexPath,
    warnings: payload.warnings,
  };
}

export async function indexStatus({ root, dataDir }) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const index = await loadIndexFile({ dataDir, root: resolvedRoot });
  if (!index) return { indexed: false, root: resolvedRoot, schemaVersion: SCHEMA_VERSION };
  return {
    indexed: true,
    root: resolvedRoot,
    schemaVersion: index.schemaVersion,
    builtAtMs: index.builtAtMs,
    fileCount: index.fileCount,
    symbolCount: index.symbolCount,
    indexPath: dataDir ? path.join(dataDir, 'code-index', 'index.json') : null,
  };
}

export async function getIndex({ dataDir, root }) {
  const key = cacheKey({ dataDir, root });
  let index = indexCache.get(key);
  if (!index) {
    index = await loadIndexFile({ dataDir, root });
    if (index) indexCache.set(key, index);
  }
  return index;
}

async function walkProject(root) {
  const warnings = [];
  const files = [];
  let truncated = false;
  let ignoreRules = [];
  try {
    ignoreRules = parseGitignore(await readFile(path.join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore at the project root; nothing to apply.
  }

  await walkDir(root, '');
  return { files, warnings, truncated };

  async function walkDir(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      warnings.push(`unreadable_directory:${relDir || '.'}`);
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith('.')) continue; // hidden files and directories are never indexed
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isIgnored(relPath, ignoreRules)) continue;
      if (entry.isDirectory()) {
        await walkDir(path.join(absDir, entry.name), relPath);
      } else if (entry.isFile()) {
        let info;
        try {
          const s = await stat(path.join(absDir, entry.name));
          info = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          warnings.push(`unreadable_file:${relPath}`);
          continue;
        }
        files.push({
          path: relPath,
          absPath: path.join(absDir, entry.name),
          language: languageForFile(relPath),
          ...info,
        });
      }
    }
  }
}

async function parseFile(absPath, language) {
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    return { symbols: [], lineCount: null };
  }
  const lines = text.split('\n');
  const spec = getSpec(language);
  const symbols = spec ? extractSymbols(lines, spec) : [];
  return { symbols, lineCount: lines.length };
}

async function hashFile(absPath) {
  try {
    const content = await readFile(absPath);
    return createHash('sha1').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

async function persistIndex(payload, dataDir) {
  const indexDir = path.join(dataDir, 'code-index');
  await mkdir(indexDir, { recursive: true });
  const dirInfo = await lstat(indexDir);
  if (dirInfo.isSymbolicLink()) throw new Error('index_output_directory_unsafe');
  const target = path.join(indexDir, 'index.json');
  const tmp = path.join(indexDir, 'index.json.tmp');
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  await rename(tmp, target);
  return target;
}

async function loadIndexFile({ dataDir, root }) {
  if (!dataDir) return null;
  let text;
  try {
    text = await readFile(path.join(dataDir, 'code-index', 'index.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    if (parsed.root !== path.resolve(root)) return null;
    if (!Array.isArray(parsed.files) || !parsed.symbolIndex || typeof parsed.symbolIndex !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search primitives
// ---------------------------------------------------------------------------

export async function searchSymbols({ index, root, query, kind, caseSensitive = false, limit = 20 }) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query_required');
  const max = clampInt(limit, 1, 100, 20);
  const needle = caseSensitive ? q : q.toLowerCase();
  const scored = [];
  for (const name of Object.keys(index.symbolIndex)) {
    let defs = index.symbolIndex[name];
    if (kind) defs = defs.filter((def) => def.kind === kind);
    if (!defs.length) continue;
    const candidate = caseSensitive ? name : name.toLowerCase();
    let score;
    if (candidate === needle) score = 0;
    else if (candidate.startsWith(needle)) score = 1;
    else if (candidate.includes(needle)) score = 2;
    else continue;
    scored.push({ name, score, defs });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const results = [];
  for (const { name, defs } of scored.slice(0, max)) {
    const definitions = [];
    for (const def of defs.slice(0, 5)) {
      definitions.push({ ...def, snippet: await snippetFor(root, def.file, def.line) });
    }
    results.push({ name, kind: defs[0].kind, definitionCount: defs.length, definitions });
  }
  return {
    query: q,
    kind: kind ?? null,
    caseSensitive,
    total: scored.length,
    results,
  };
}

export async function findReferences({ index, root, name, caseSensitive = true, limit = 50 }) {
  const q = String(name ?? '').trim();
  if (!q) throw new Error('name_required');
  const max = clampInt(limit, 1, 200, 50);
  let key = q;
  let defs = index.symbolIndex[q];
  if (!defs) {
    const lower = q.toLowerCase();
    const match = Object.keys(index.symbolIndex).find((candidate) => candidate.toLowerCase() === lower);
    if (match) {
      key = match;
      defs = index.symbolIndex[match];
    }
  }
  defs = defs ?? [];
  const defSet = new Set(defs.map((def) => `${def.file}:${def.line}`));
  const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(key)}(?![A-Za-z0-9_])`, caseSensitive ? '' : 'i');
  const references = [];
  let truncated = false;
  for (const file of index.files) {
    if (!file.language || (file.size ?? 0) > MAX_SCAN_BYTES) continue;
    const text = await readTextCached(path.join(index.root, file.path));
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i]) && !defSet.has(`${file.path}:${i + 1}`)) {
        references.push({ file: file.path, line: i + 1, snippet: trimSnippet(lines[i]) });
        if (references.length >= max) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }
  const definitions = [];
  for (const def of defs.slice(0, 10)) {
    definitions.push({ ...def, snippet: await snippetFor(root, def.file, def.line) });
  }
  return { name: key, caseSensitive, total: references.length, truncated, definitions, references };
}

export function searchFiles({ index, query, limit = 20 }) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query_required');
  const max = clampInt(limit, 1, 100, 20);
  const needle = q.toLowerCase();
  const scored = [];
  for (const file of index.files) {
    const lower = file.path.toLowerCase();
    const base = file.path.split('/').pop().toLowerCase();
    let score = null;
    if (base === needle) score = 0;
    else if (base.includes(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    if (score === null) continue;
    scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.path.localeCompare(b.file.path));
  return {
    query: q,
    total: scored.length,
    results: scored.slice(0, max).map(({ file }) => ({
      path: file.path,
      language: file.language,
      lineCount: file.lineCount,
      symbolCount: file.symbols.length,
    })),
  };
}

export function getFileSymbols({ index, path: requested }) {
  const q = String(requested ?? '').trim().replace(/\\/g, '/');
  if (!q) throw new Error('path_required');
  const file = index.files.find((candidate) => candidate.path === q)
    ?? index.files.find((candidate) => candidate.path.endsWith(`/${q}`))
    ?? index.files.find((candidate) => candidate.path.endsWith(q));
  if (!file) throw new Error('file_not_in_index');
  return {
    path: file.path,
    language: file.language,
    lineCount: file.lineCount,
    symbolCount: file.symbols.length,
    symbols: file.symbols,
  };
}

export async function searchCode({ index, root, query, filePattern, caseSensitive = false, limit = 50 }) {
  const q = String(query ?? '');
  if (!q.trim()) throw new Error('query_required');
  let re;
  try {
    re = new RegExp(q, caseSensitive ? '' : 'i');
  } catch {
    throw new Error('invalid_regex');
  }
  const max = clampInt(limit, 1, 200, 50);
  const pattern = filePattern ? String(filePattern) : null;
  const results = [];
  let truncated = false;

  const candidates = index.files.filter(
    (file) => file.language && (file.size ?? 0) <= MAX_SCAN_BYTES && (!pattern || file.path.includes(pattern)),
  );
  const rgAvailable = await findExecutable('rg');
  if (rgAvailable && candidates.length > 0) {
    const filesArg = candidates.map((file) => path.join(root, file.path));
    const args = [
      '--json',
      '--line-number',
      '--no-heading',
      '--max-count', String(max),
      caseSensitive ? '--case-sensitive' : '--ignore-case',
      '--',
      q,
      ...filesArg,
    ];
    try {
      const { stdout } = await execFileAsync('rg', args, { maxBuffer: 8 * 1024 * 1024 });
      const seen = new Set();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let match;
        try {
          match = JSON.parse(line);
        } catch {
          continue;
        }
        if (match.type !== 'match' || !match.data?.path?.text || !Number.isInteger(match.data.line_number)) continue;
        const rel = path.relative(root, match.data.path.text).replace(/\\/g, '/');
        const key = `${rel}:${match.data.line_number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ file: rel, line: match.data.line_number, snippet: (match.data.lines?.text ?? '').trim().slice(0, MAX_SNIPPET_CHARS) });
        if (results.length >= max) {
          truncated = true;
          break;
        }
      }
      return { query: q, caseSensitive, filePattern: pattern, engine: 'ripgrep', total: results.length, truncated, results };
    } catch {
      // ripgrep failed (missing file, binary content, exit 1 = no matches); fall through to the built-in scanner.
    }
  }

  for (const file of candidates) {
    const text = await readTextCached(path.join(root, file.path));
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        results.push({ file: file.path, line: i + 1, snippet: trimSnippet(lines[i]) });
        if (results.length >= max) {
          truncated = true;
          break;
        }
      }
    }
    if (truncated) break;
  }
  return { query: q, caseSensitive, filePattern: pattern, engine: 'builtin', total: results.length, truncated, results };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function snippetFor(root, relPath, lineNumber) {
  const text = await readTextCached(path.join(root, relPath));
  const line = text.split('\n')[lineNumber - 1];
  return line ? trimSnippet(line) : null;
}

function trimSnippet(line) {
  const trimmed = line.trim();
  return trimmed.length > MAX_SNIPPET_CHARS ? `${trimmed.slice(0, MAX_SNIPPET_CHARS)}…` : trimmed;
}

async function readTextCached(absPath) {
  const hit = textCache.get(absPath);
  if (hit) return hit.text;
  let text;
  try {
    text = await readFile(absPath, 'utf8');
  } catch {
    text = '';
  }
  const bytes = Buffer.byteLength(text);
  textCache.set(absPath, { text, bytes });
  cachedBytes += bytes;
  while (cachedBytes > CACHE_MAX_BYTES && textCache.size > 1) {
    const firstKey = textCache.keys().next().value;
    const evicted = textCache.get(firstKey);
    textCache.delete(firstKey);
    cachedBytes -= evicted.bytes;
  }
  return text;
}

function cacheKey({ dataDir, root }) {
  return `${dataDir ?? ''}::${root ?? ''}`;
}

function setCachedIndex(context, payload) {
  indexCache.set(cacheKey(context), payload);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let executableCache = null;
async function findExecutable(name) {
  if (executableCache !== null) return executableCache;
  try {
    await execFileAsync(name, ['--version'], { timeout: 2000 });
    executableCache = true;
  } catch {
    executableCache = false;
  }
  return executableCache;
}
