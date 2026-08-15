#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import {
  getMiniMaxTrajectory,
  listMiniMaxSessions,
  resolveDataDir,
} from './lib/trajectory.mjs';

export const TOOLS = [
  {
    name: 'list_minimax_sessions',
    description:
      'List recent local MiniMax Code v2 sessions without returning titles, conversation text, paths, or raw records.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum number of recent sessions to return.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_minimax_trajectory',
    description:
      'Return a bounded, privacy-aware trajectory for one local MiniMax Code session. Summary mode omits all content; full mode returns only redacted previews and requires explicit user consent.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          description: 'Exact session ID. Omit to use the most recently updated session.',
        },
        maxRecords: {
          type: 'integer',
          minimum: 50,
          maximum: 1000,
          default: 200,
          description: 'Maximum number of most-recent event summaries returned.',
        },
        detailLevel: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'Use summary by default. Full returns bounded redacted text previews and should be used only after explicit user consent.',
        },
      },
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
        serverInfo: { name: 'minimax-code-trajectory', version: '0.1.0' },
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
  const dataDir = options.dataDir ?? resolveDataDir(options.env, options.homeDir);
  try {
    let value;
    if (name === 'list_minimax_sessions') {
      value = await listMiniMaxSessions({ dataDir, limit: args.limit });
    } else if (name === 'get_minimax_trajectory') {
      value = await getMiniMaxTrajectory({
        dataDir,
        sessionId: args.sessionId,
        maxRecords: args.maxRecords,
        detailLevel: args.detailLevel,
      });
    } else {
      return toolError(`Unknown tool: ${String(name)}`);
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
