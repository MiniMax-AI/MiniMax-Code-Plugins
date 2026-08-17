#!/usr/bin/env node
// server.mjs — stdio MCP server for skill-bridge.
//
// Exposes four tools that mirror the original CLI subcommands but
// communicate over JSON-RPC on stdin/stdout:
//
//   detect   (source)              -> { encoding, originalEncoding,
//                                       replaced, confidence, reason }
//   analyze  (source)              -> full AnalyzedSkill report
//   classify (source)              -> { tier, subTier, reason, ... }
//   convert  (source, target_dir,
//             force?, run_lint?)   -> { tier, subTier, written, warnings,
//                                       lint }
//
// `source` may be a path to a SKILL.md file OR a directory containing one.
// Paths are resolved relative to the calling agent's filesystem; we do
// not use any host-specific state.
//
// References:
//   - Agent Plugins 1.0 MCP schema:
//     https://agent-plugins.org/schemas/1.0.0/mcp.schema.json
//   - hello-mcode-mcp example shipped by the community registry.

import { createInterface } from 'node:readline';
import { readFileSafe } from './lib/detect.js';
import { analyzeSkillFile, parseFrontmatter } from './lib/analyze.js';
import { classify } from './lib/classify.js';
import { transformSkill } from './lib/transform-skill.js';
import { lintSkill } from './lib/lint.js';

const SERVER_INFO = { name: 'skill-bridge', version: '0.2.0' };
const PROTOCOL_VERSION = '2025-06-18';

// ---------- MCP plumbing ----------

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

const TOOLS = [
  {
    name: 'detect',
    description:
      'Detect the encoding of a SKILL.md file. Returns one of: utf-8, gbk, unknown. ' +
      'If gbk, the text field is the UTF-8-restored content.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'Absolute path to a SKILL.md file or a directory containing one.',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze',
    description:
      'Full analysis of a SKILL.md: frontmatter, body, hardcoded paths, ' +
      'external commands, and warnings. Use this when the caller wants to ' +
      'inspect the skill before deciding what to do.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Path to SKILL.md or skill folder.' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'classify',
    description:
      'Classify a skill into one of: pure / pure-translate / pure-wrapped-fix, ' +
      'or wrapped-* (not yet supported in v0.2), or abandon.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
      },
      required: ['source'],
      additionalProperties: false,
    },
  },
  {
    name: 'convert',
    description:
      'Run the full conversion pipeline and write the result to target_dir. ' +
      'In v0.2 only `pure` skills are converted. Lint runs by default; ' +
      'pass run_lint=false to skip.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        target_dir: { type: 'string' },
        force: { type: 'boolean', default: false },
        run_lint: { type: 'boolean', default: true },
      },
      required: ['source', 'target_dir'],
      additionalProperties: false,
    },
  },
];

function toolResultText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

async function handle(message) {
  const { method, params, id } = message;
  try {
    if (method === 'initialize') {
      return {
        result: {
          protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (method === 'notifications/initialized') {
      return null; // no-op
    }
    if (method === 'tools/list') {
      return { result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments ?? {};
      return {
        result: await invokeTool(name, args),
      };
    }
    return { error: { code: -32601, message: `Method not found: ${String(method)}` } };
  } catch (e) {
    return { error: { code: -32000, message: e?.message ?? String(e) } };
  }
}

async function invokeTool(name, args) {
  switch (name) {
    case 'detect': {
      const r = await readFileSafe(String(args.source));
      return toolResultText(r);
    }
    case 'analyze': {
      const r = await analyzeSkillFile(String(args.source));
      return toolResultText(r);
    }
    case 'classify': {
      const report = await analyzeSkillFile(String(args.source));
      return toolResultText(classify(report));
    }
    case 'convert': {
      const source = String(args.source);
      const targetDir = String(args.target_dir);
      const force = Boolean(args.force);
      const runLint = args.run_lint !== false;
      const report = await analyzeSkillFile(source);
      const result = classify(report);
      if (result.tier === 'abandon') {
        return toolResultText({ ok: false, tier: 'abandon', reason: result.reason });
      }
      if (result.tier !== 'pure') {
        return toolResultText({
          ok: false,
          tier: result.tier,
          subTier: result.subTier,
          reason: result.reason,
          note: 'v0.2 only emits pure skills. wrapped-* support is planned for v0.3.',
        });
      }
      // The transformer writes to a staging dir and renames onto target_dir.
      // It does NOT touch target_dir if anything fails. The `force` flag
      // here is informational; the transformer is always safe to re-run.
      void force;
      const r = await transformSkill({
        inputPath: source,
        report,
        classify: result,
        outDir: targetDir,
      });
      let lint = null;
      if (runLint) {
        const lr = await lintSkill(targetDir);
        lint = { ok: lr.ok, code: lr.code, stdout: lr.stdout, stderr: lr.stderr };
      }
      return toolResultText({
        ok: true,
        tier: result.tier,
        subTier: result.subTier,
        written: r.written,
        warnings: r.warnings,
        lint,
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }
  if (message.id === undefined) return; // notifications have no id
  Promise.resolve(handle(message)).then((response) => {
    if (response === null || response === undefined) return;
    if (response.error) return fail(message.id, response.error.code, response.error.message, response.error.data);
    return ok(message.id, response.result);
  });
});
