// server/easyloop.mjs
//
// stdio MCP server for the easyloop plugin. Tools:
//   - finish_plugin_selection
//   - recall_selection
//   - log_iteration
//   - list_selections

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { renderMenu, LOOPS, QUALITIES } from '../lib/catalog.mjs';
import { validateSelection, setDiscoveredPlugins } from '../lib/planner.mjs';
import { saveSelection, readSelection, listSelections } from '../lib/compact.mjs';
import { discoverPlugins, mergeCatalog } from '../lib/discover.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'easyloop', version: '0.1.0' };

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || join(HERE, '..');
const PLUGIN_DATA = process.env.PLUGIN_DATA || join(PLUGIN_ROOT, '.data');
await mkdir(PLUGIN_DATA, { recursive: true });
await mkdir(join(PLUGIN_DATA, 'selections'), { recursive: true });

// Discover every installed plugin at session start. The model sees
// each plugin's `description` from its `plugin.json` manifest as a
// one-liner in the menu, and can enable any of them — including custom
// plugins the user has installed locally — for the current task.
const discovered = await discoverPlugins();
const catalog = mergeCatalog(discovered);
setDiscoveredPlugins(catalog);

const MENU_TEXT = renderMenu(catalog);
const MENU_CHARS = MENU_TEXT.length;

function textContent(s) { return { type: 'text', text: s }; }

const TOOLS = [
  {
    name: 'get_menu',
    description:
      'Return the full easyloop selection menu as text. The menu lists every loop, ' +
      'quality level, and the descriptions of every installed plugin (built-in ' +
      'and custom). Call this FIRST when the easyloop Skill activates, before ' +
      'calling finish_plugin_selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_available_plugins',
    description:
      'List every plugin installed in the local marketplace with its one-line ' +
      'description (from each plugin\'s plugin.json manifest). Use this to see ' +
      'which custom plugins are available before finish_plugin_selection.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'finish_plugin_selection',
    description:
      'Persist the model\'s loop/quality/plugin selection and return a ' +
      'context_compacted_id. The Skill body instructs the model to drop ' +
      'the original menu text from its next turn\'s output and carry only ' +
      'the id forward. Use recall_selection to re-inject the menu later.',
    inputSchema: {
      type: 'object',
      properties: {
        loops:   { type: 'array', items: { type: 'string' } },
        quality: { type: 'string', enum: ['prototype', 'release'] },
        plugins: { type: 'array', items: { type: 'string' } },
        notes:   { type: 'string' },
      },
      required: ['loops', 'quality'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_selection',
    description: 'Re-inject a previously compacted selection menu by id.',
    inputSchema: {
      type: 'object',
      properties: { context_compacted_id: { type: 'string' } },
      required: ['context_compacted_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_iteration',
    description: 'Append an iteration audit entry to the session log.',
    inputSchema: {
      type: 'object',
      properties: {
        turn: { type: 'integer' },
        loop: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['turn', 'loop', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_selections',
    description: 'List all selections saved in this session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function toolFinishPluginSelection(args) {
  const v = validateSelection(args);
  if (!v.ok) {
    return {
      content: [textContent(`finish_plugin_selection: ${v.error}`)],
      isError: true,
      structuredContent: { error: v.error },
    };
  }
  const record = await saveSelection(PLUGIN_DATA, v.selection, MENU_CHARS);

  const planText = renderPlan(v.selection);
  return {
    content: [textContent(
      `selection saved as ${record.context_compacted_id}.\n\n` +
      `PLAN:\n${planText}\n\n` +
      `The original menu (${MENU_CHARS} chars) is now compacted; carry only this id ` +
      `forward. Use recall_selection("${record.context_compacted_id}") to re-inject the menu later.`,
    )],
    structuredContent: {
      context_compacted_id: record.context_compacted_id,
      replaced_chars: MENU_CHARS,
      plan_text: planText,
      selection: v.selection,
    },
  };
}

function renderPlan(s) {
  const lines = [];
  lines.push(`Loops: ${s.loops.map((l) => l.name).join(', ')}`);
  for (const l of s.loops) lines.push(`  - ${l.name}: ${l.description}`);
  lines.push(`Quality: ${s.quality.name} (cap ${s.quality.iterationCap} turns, verify=${s.quality.verify})`);
  lines.push(`  - ${s.quality.description}`);
  if (s.plugins.length > 0) {
    lines.push(`Plugins:`);
    for (const p of s.plugins) lines.push(`  - ${p.name}: ${p.description}`);
  } else {
    lines.push(`Plugins: none`);
  }
  if (s.notes) lines.push(`Notes: ${s.notes}`);
  return lines.join('\n');
}

async function toolRecallSelection(args) {
  const id = args.context_compacted_id;
  const record = await readSelection(PLUGIN_DATA, id);
  if (!record) {
    return {
      content: [textContent(`recall_selection: not found: ${id}`)],
      isError: true,
      structuredContent: { found: false },
    };
  }
  const planText = renderPlan(record.selection);
  return {
    content: [textContent(
      `MENU (original, ${record.replacedChars} chars):\n${MENU_TEXT}\n\n` +
      `SAVED PLAN:\n${planText}\n`,
    )],
    structuredContent: {
      context_compacted_id: record.context_compacted_id,
      replaced_chars: record.replacedChars,
      plan_text: planText,
      selection: record.selection,
    },
  };
}

async function toolLogIteration(args) {
  const path = join(PLUGIN_DATA, 'iterations.jsonl');
  const { writeFile } = await import('node:fs/promises');
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    turn: args.turn,
    loop: args.loop,
    summary: args.summary,
  }) + '\n';
  await writeFile(path, line, { flag: 'a' });
  return {
    content: [textContent(`logged iteration ${args.turn} (${args.loop})`)],
    structuredContent: { logged: true },
  };
}

async function toolGetMenu() {
  return {
    content: [textContent(MENU_TEXT)],
    structuredContent: {
      menu_chars: MENU_CHARS,
      plugins: catalog,
      loops: LOOPS.map(({ name, description }) => ({ name, description })),
      qualities: QUALITIES,
    },
  };
}

async function toolListAvailablePlugins() {
  return {
    content: [textContent(
      catalog.map((p) => `${p.name}: ${p.description}`).join('\n') || '(none discovered)',
    )],
    structuredContent: { plugins: catalog },
  };
}

async function toolListSelections() {
  const items = await listSelections(PLUGIN_DATA);
  return {
    content: [textContent(JSON.stringify(items, null, 2))],
    structuredContent: { selections: items },
  };
}

const ROUTES = {
  get_menu:                toolGetMenu,
  list_available_plugins:  toolListAvailablePlugins,
  finish_plugin_selection: toolFinishPluginSelection,
  recall_selection:        toolRecallSelection,
  log_iteration:           toolLogIteration,
  list_selections:         toolListSelections,
};

async function handle(message) {
  const { method, params, id } = message;
  if (method === 'initialize') {
    return {
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === 'notifications/initialized') return { result: {} };
  if (method === 'tools/list') return { result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    const fn = ROUTES[name];
    if (!fn) return { error: { code: -32601, message: `unknown tool: ${name}` } };
    try {
      const out = await fn(params?.arguments || {});
      return { result: out };
    } catch (e) {
      return {
        result: {
          content: [textContent(`error: ${e.message}`)],
          isError: true,
          structuredContent: { error: { code: 'INTERNAL', message: e.message } },
        },
      };
    }
  }
  return { error: { code: -32601, message: `unknown method: ${method}` } };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const resp = await handle(msg);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...resp })}\n`);
});
