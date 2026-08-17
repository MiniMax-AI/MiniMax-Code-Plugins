#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as indexer from './lib/indexer.mjs';
import { SYMBOL_KINDS } from './lib/languages.mjs';

export const TOOLS = [
  {
    name: 'index_status',
    description:
      'Report whether the current project has a built code index, and its file/symbol counts and build time when it does. Call this before searching to decide whether build_code_index is needed. Pass root when the server cannot auto-detect the project (see workspace_root_unknown).',
    inputSchema: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description: 'Absolute path of the project. Required when the host launched the server from the plugin directory and the project cannot be auto-detected.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'build_code_index',
    description:
      'Scan the active project and build or refresh the local code index (symbols per file, language, line counts), cached under PLUGIN_DATA. Incremental by default: only changed files are re-parsed. Pass force to rebuild from scratch, or root when the server cannot auto-detect the project (see workspace_root_unknown).',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          default: false,
          description: 'Rebuild the whole index from scratch instead of reusing unchanged files.',
        },
        root: {
          type: 'string',
          description: 'Absolute path of the project to index. Required when the host launched the server from the plugin directory and the project cannot be auto-detected.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_symbol',
    description:
      'Find symbol definitions (functions, classes, methods, interfaces, variables, imports, ...) by name. Exact names rank first, then prefix, then substring. Returns file:line locations and short snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Symbol name or fragment to search for.' },
        kind: {
          type: 'string',
          enum: SYMBOL_KINDS,
          description: 'Optional symbol kind filter (function, method, class, interface, import, ...).',
        },
        caseSensitive: { type: 'boolean', default: false, description: 'Match case exactly (default: case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of symbols to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_references',
    description:
      'Find usage sites of a symbol across the indexed project: every non-definition occurrence with file:line and snippet, plus the symbol definitions. Use before renaming or removing code.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Exact symbol name to find references for.' },
        caseSensitive: { type: 'boolean', default: true, description: 'Match case exactly (default: case-sensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Maximum number of references to return.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_file',
    description:
      'Locate files by name or path fragment. Exact basename matches rank first, then basename substring, then path substring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'File name or path fragment to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of files to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_code',
    description:
      'Full-text regex search over indexed source files. Uses ripgrep when available for speed, otherwise a built-in scanner. Returns file:line matches with snippets; results are capped and marked truncated when the cap is hit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Regular expression to match against source lines.' },
        filePattern: { type: 'string', description: 'Optional path substring; only files containing it are searched.' },
        caseSensitive: { type: 'boolean', default: false, description: 'Match case exactly (default: case-insensitive).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50, description: 'Maximum number of matches to return.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file_symbols',
    description:
      'List the symbol structure of one file (name, kind, line, column) without reading the whole file, plus its language and line count. Use it to understand a file shape before opening it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'File path as shown by search_file, or a unique path suffix.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

export async function handleRpc(message, options = {}) {
  if (!message || typeof message !== 'object') {
    return rpcError(-32600, 'Invalid Request');
  }
  if (message.method === 'initialize') {
    clientSupportsRoots = Boolean(message.params?.clientCapabilities?.roots?.listChanged);
    return {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'code-index', version: '0.1.0' },
      },
    };
  }
  if (message.method === 'ping') return { result: {} };
  if (message.method === 'notifications/initialized') {
    requestRootsIfSupported();
    return null;
  }
  if (message.method === 'notifications/roots/list_changed') {
    if (Array.isArray(message.params?.roots)) setMcpRoots(message.params.roots);
    else requestRootsIfSupported();
    return null;
  }
  if (pendingRootsRequestId !== null && message.id === pendingRootsRequestId) {
    pendingRootsRequestId = null;
    if (Array.isArray(message.result?.roots)) setMcpRoots(message.result.roots);
    return null;
  }
  if (message.method?.startsWith('notifications/')) return null;
  if (message.method === 'tools/list') return { result: { tools: TOOLS } };
  if (message.method === 'tools/call') {
    return handleToolCall(message.params, options);
  }
  return rpcError(-32601, `Method not found: ${String(message.method)}`);
}

async function handleToolCall(params, options) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  try {
    let value;
    if (name === 'build_code_index' || name === 'index_status') {
      const rootArg = typeof args.root === 'string' && args.root.trim() ? path.resolve(args.root) : undefined;
      const context = resolveContext({ ...options, root: options.root ?? rootArg });
      if (name === 'index_status') {
        value = await indexer.indexStatus(context);
      } else {
        value = await indexer.buildIndex({ ...context, force: args.force === true });
        rememberRoot(context.root, context.dataDir);
      }
    } else {
      const context = resolveContext(options);
      const index = await indexer.getIndex(context);
      if (!index) throw new Error('index_not_built');
      if (name === 'search_symbol') {
        value = await indexer.searchSymbols({
          ...context,
          index,
          query: args.query,
          kind: args.kind,
          caseSensitive: args.caseSensitive,
          limit: args.limit,
        });
      } else if (name === 'find_references') {
        value = await indexer.findReferences({
          ...context,
          index,
          name: args.name,
          caseSensitive: args.caseSensitive,
          limit: args.limit,
        });
      } else if (name === 'search_file') {
        value = indexer.searchFiles({ index, query: args.query, limit: args.limit });
      } else if (name === 'search_code') {
        value = await indexer.searchCode({
          ...context,
          index,
          query: args.query,
          filePattern: args.filePattern,
          caseSensitive: args.caseSensitive,
          limit: args.limit,
        });
      } else if (name === 'get_file_symbols') {
        value = indexer.getFileSymbols({ index, path: args.path });
      } else {
        return toolError(`Unknown tool: ${String(name)}`);
      }
    }
    return {
      result: {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: value,
      },
    };
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------
//
// MiniMax Code (like other Agent Plugins 1.0 hosts) launches stdio MCP servers
// with the *plugin root* as the working directory, so process.cwd() is the
// plugin's own folder, not the active project. The server must therefore learn
// the project root from the host or the agent, and it must never silently index
// its own plugin directory.

const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

let activeRoot = null; // root remembered from an earlier build in this process
let mcpRootUris = null; // file:// roots announced by the MCP client
let clientSupportsRoots = false;
let pendingRootsRequestId = null;
let nextRequestId = 1;
let outboundQueue = [];

const pluginRoot = process.env.PLUGIN_ROOT ? path.resolve(process.env.PLUGIN_ROOT) : null;

function resolveContext(options) {
  const explicitRoot = options.root;
  const envDataDir = options.dataDir ?? process.env.CODE_INDEX_DATA_DIR ?? process.env.PLUGIN_DATA ?? null;
  if (explicitRoot) {
    const root = path.resolve(explicitRoot);
    return { root, dataDir: envDataDir ?? path.join(root, '.code-index'), rootSource: 'explicit' };
  }
  const resolved = resolveProjectRoot();
  if (!resolved) {
    throw new Error(
      'workspace_root_unknown: the host launched this server from the plugin directory, ' +
        'so the active project root could not be determined. Call build_code_index (or index_status) again ' +
        'with `root` set to the absolute path of the active project; search tools then reuse it for the rest of the session.',
    );
  }
  return { root: resolved.root, dataDir: envDataDir ?? path.join(resolved.root, '.code-index'), rootSource: resolved.source };
}

function resolveProjectRoot() {
  const envRoot = process.env.CODE_INDEX_ROOT;
  if (envRoot) return { root: path.resolve(envRoot), source: 'env' };
  const rootsRoot = rootFromMcpRoots();
  if (rootsRoot) return { root: rootsRoot, source: 'mcp-roots' };
  if (activeRoot) return { root: activeRoot, source: 'active' };
  const persisted = rootFromPersistedState();
  if (persisted) return { root: persisted, source: 'persisted' };
  const cwd = path.resolve(process.cwd());
  const discovered = discoverProjectRoot(cwd);
  if (discovered && !containsPluginRoot(discovered) && !isInsidePluginRoot(discovered)) {
    return { root: discovered, source: 'discovered' };
  }
  if (!isInsidePluginRoot(cwd)) return { root: cwd, source: 'cwd' };
  return null;
}

// Walk upward from `start` looking for the nearest directory that looks like a
// project root (a VCS checkout or a well-known manifest). Returns null when no
// marker exists within a hard cap of 16 ancestors, in which case the caller
// falls back to cwd (or fails when that is the plugin directory itself).
function discoverProjectRoot(start) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 16; depth += 1) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function rootFromMcpRoots() {
  if (!mcpRootUris) return null;
  for (const uri of mcpRootUris) {
    const candidate = directoryFromRootUri(uri);
    if (candidate) return candidate;
  }
  return null;
}

function directoryFromRootUri(uri) {
  try {
    let candidate;
    if (typeof uri === 'string' && uri.startsWith('file://')) candidate = fileURLToPath(uri);
    else if (typeof uri === 'string' && (/^[A-Za-z]:[\\/]/u.test(uri) || uri.startsWith('/'))) candidate = uri;
    else return null;
    const resolved = path.resolve(candidate);
    return statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// The root last used by a previous session, persisted next to the index under
// PLUGIN_DATA (or CODE_INDEX_DATA_DIR). Lets a restarted server keep answering
// for the same project until the agent rebuilds elsewhere.
function rootFromPersistedState() {
  const dataDir = process.env.CODE_INDEX_DATA_DIR ?? process.env.PLUGIN_DATA;
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, 'code-index', 'active-root.json'), 'utf8'));
    if (parsed && typeof parsed.root === 'string' && statSync(parsed.root).isDirectory()) {
      return path.resolve(parsed.root);
    }
  } catch {
    // No persisted state; not an error.
  }
  return null;
}

function rememberRoot(root, dataDir) {
  activeRoot = path.resolve(root);
  if (!dataDir) return;
  mkdir(path.join(dataDir, 'code-index'), { recursive: true })
    .then(() =>
      writeFile(
        path.join(dataDir, 'code-index', 'active-root.json'),
        `${JSON.stringify({ root: activeRoot, updatedAtMs: Date.now() })}\n`,
        'utf8',
      ),
    )
    .catch(() => {
      // Persistence is best-effort; the in-memory root still covers this session.
    });
}

function isInsidePluginRoot(candidate) {
  if (!pluginRoot) return false;
  const resolved = path.resolve(candidate);
  const relative = path.relative(pluginRoot, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function containsPluginRoot(candidate) {
  if (!pluginRoot) return false;
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolved, pluginRoot);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function setMcpRoots(roots) {
  mcpRootUris = roots.map((root) => (root && typeof root.uri === 'string' ? root.uri : null)).filter(Boolean);
  if (mcpRootUris.length === 0) mcpRootUris = null;
}

// Old-style MCP clients announce a roots change without a payload; the server
// must then ask for the list with a roots/list request.
function requestRootsIfSupported() {
  if (!clientSupportsRoots || mcpRootUris !== null) return;
  const id = `ci-${nextRequestId++}`;
  pendingRootsRequestId = id;
  outboundQueue.push({ id, method: 'roots/list', params: {} });
}

// Exposed for tests: messages the server wants to send to the client that are
// not responses (currently only roots/list requests).
export function drainOutboundRequests() {
  const drained = outboundQueue;
  outboundQueue = [];
  return drained;
}

function toolError(message) {
  return {
    result: {
      isError: true,
      content: [{ type: 'text', text: message }],
    },
  };
}

function rpcError(code, message) {
  return { error: { code, message } };
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!message || typeof message !== 'object') continue;
    const response = await handleRpc(message);
    if (message.id !== undefined && response) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`);
    }
    for (const outbound of drainOutboundRequests()) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...outbound })}\n`);
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
