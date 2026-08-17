#!/usr/bin/env node

import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import * as indexer from './lib/indexer.mjs';
import { SYMBOL_KINDS } from './lib/languages.mjs';

export const TOOLS = [
  {
    name: 'index_status',
    description:
      'Report whether the current project has a built code index, and its file/symbol counts and build time when it does. Call this before searching to decide whether build_code_index is needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'build_code_index',
    description:
      'Scan the active project and build or refresh the local code index (symbols per file, language, line counts), cached under PLUGIN_DATA. Incremental by default: only changed files are re-parsed. Pass force to rebuild from scratch.',
    inputSchema: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          default: false,
          description: 'Rebuild the whole index from scratch instead of reusing unchanged files.',
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
    return {
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'code-index', version: '0.1.0' },
      },
    };
  }
  if (message.method === 'ping') return { result: {} };
  if (message.method === 'tools/list') return { result: { tools: TOOLS } };
  if (message.method === 'tools/call') {
    return handleToolCall(message.params, options);
  }
  return rpcError(-32601, `Method not found: ${String(message.method)}`);
}

async function handleToolCall(params, options) {
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const context = resolveContext(options);
  try {
    let value;
    if (name === 'index_status') {
      value = await indexer.indexStatus(context);
    } else if (name === 'build_code_index') {
      value = await indexer.buildIndex({ ...context, force: args.force === true });
    } else {
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

function resolveContext(options) {
  const root = path.resolve(options.root ?? process.env.PLUGIN_ROOT ?? process.cwd());
  const dataDir = options.dataDir ?? process.env.CODE_INDEX_DATA_DIR ?? process.env.PLUGIN_DATA ?? undefined;
  return { root, dataDir };
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
    if (message.id === undefined) continue;
    const response = await handleRpc(message);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...response })}\n`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
