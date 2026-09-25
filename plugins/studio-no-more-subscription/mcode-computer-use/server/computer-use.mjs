// server/computer-use.mjs
//
// stdio MCP server for mcode-computer-use. Uses the same node:readline
// JSON-RPC shape as examples/hello-mcode-mcp/server.mjs.

import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

import { buildGrid, PALETTE, colorsAtPixel } from '../lib/noise-grid.mjs';
import { composeOverlay, renderNoiseOnly } from '../lib/overlay.mjs';
import { encodePixel } from '../lib/encode.mjs';
import { decodeAddress } from '../lib/decode.mjs';
import { detect } from '../lib/platform.mjs';
import { takeScreenshot } from '../lib/screenshot.mjs';
import * as Input from '../lib/input.mjs';
import {
  appendFrame, listFrames, readFrame, bumpScreenshotCount,
  setSummary, getSummaries, summaryEveryFromEnv,
} from '../lib/summarize.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'mcode-computer-use', version: '0.1.0' };

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.PLUGIN_ROOT || join(HERE, '..');
const PLUGIN_DATA = process.env.PLUGIN_DATA || join(PLUGIN_ROOT, '.data');
await mkdir(PLUGIN_DATA, { recursive: true });

const plan = detect();
const summaryEvery = summaryEveryFromEnv(process.env);

// In-memory per-session grid. We re-seed it at every SessionStart hook,
// but for MCP-only flows we seed it once at server start.
let grid = null;
function ensureGrid(w, h) {
  if (grid && grid.w === w && grid.h === h) return grid;
  const seed = `mcode-computer-use:${process.pid}:${Date.now()}`;
  grid = buildGrid({ w, h, gridC: 32, seed });
  return grid;
}

function imageContent(pngBytes) {
  return {
    type: 'image',
    data: pngBytes.toString('base64'),
    mimeType: 'image/png',
  };
}

function textContent(s) {
  return { type: 'text', text: s };
}

function error(code, message, hint) {
  const err = { code, message };
  if (hint) err.data = { hint };
  return { error: err };
}

const TOOLS = [
  {
    name: 'screenshot',
    description:
      'Capture the screen (or a region) and return it with the two-layer ' +
      'noise grid overlaid. The returned structuredContent includes the ' +
      'grid seed, palette, and screen dimensions so the model can address ' +
      'any pixel via (color1, color2, pos).',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4,
                  description: '[x0, y0, x1, y1] in pixels' },
        monitor: { type: 'integer', description: 'Monitor index (multi-monitor)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click at the pixel addressed by (color1, color2, pos). ' +
      'pos is [dx, dy] within the sub-cell.',
    inputSchema: {
      type: 'object',
      properties: {
        color1: { type: 'string', description: '#RRGGBB (Layer A)' },
        color2: { type: 'string', description: '#RRGGBB (Layer B)' },
        pos: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        button: { enum: ['left', 'right', 'middle'] },
        modifiers: { type: 'array', items: { type: 'string' } },
      },
      required: ['color1', 'color2', 'pos'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll at the pixel addressed by (color1, color2, pos). ' +
      'dx/dy are line counts; positive = down/right.',
    inputSchema: {
      type: 'object',
      properties: {
        color1: { type: 'string' },
        color2: { type: 'string' },
        pos: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        dx: { type: 'integer' },
        dy: { type: 'integer' },
      },
      required: ['color1', 'color2', 'pos', 'dx', 'dy'],
      additionalProperties: false,
    },
  },
  {
    name: 'drag',
    description: 'Drag from one addressed pixel to another.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'object', properties: {
          color1: { type: 'string' }, color2: { type: 'string' },
          pos: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        }, required: ['color1','color2','pos'], additionalProperties: false },
        to:   { type: 'object', properties: {
          color1: { type: 'string' }, color2: { type: 'string' },
          pos: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
        }, required: ['color1','color2','pos'], additionalProperties: false },
        button: { enum: ['left','right','middle'] },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description: 'Type a string at the current cursor position.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        interval_ms: { type: 'integer', minimum: 0 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'key_combo',
    description: 'Synthesize a key combination (e.g. ["ctrl","c"]).',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' } },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'cursor_position',
    description: 'Return the current cursor pixel position.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zoom',
    description:
      'Return a high-resolution PNG of a region WITHOUT the noise overlay. ' +
      'Use to read dense text after a click has scrolled a panel.',
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
      },
      required: ['region'],
      additionalProperties: false,
    },
  },
  {
    name: 'grid_metadata',
    description:
      'Return the session grid seed, palette, cell size, screen dimensions, ' +
      'and platform info. Call once at the start of a session.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'retrieve_frame',
    description:
      'Re-inject a previously archived screenshot (used after trajectory ' +
      'summarization when the model needs to look back).',
    inputSchema: {
      type: 'object',
      properties: { turn: { type: 'integer', minimum: 0 } },
      required: ['turn'],
      additionalProperties: false,
    },
  },
  {
    name: 'record_summary',
    description:
      'Store a 1–3 sentence summary text for a previously archived turn. ' +
      'Called by the model right after a summary_request in structuredContent.',
    inputSchema: {
      type: 'object',
      properties: {
        turn: { type: 'integer', minimum: 0 },
        summary: { type: 'string' },
      },
      required: ['turn', 'summary'],
      additionalProperties: false,
    },
  },
];

async function toolScreenshot(args) {
  const png = await takeScreenshot(plan, { region: args.region, monitor: args.monitor });
  const { width: w, height: h } = (await import('../lib/png-pure.mjs')).Png.decode(png);
  ensureGrid(w, h);
  const composed = await composeOverlay(png, grid, { alpha: 0.22 });
  const turn = await bumpScreenshotCount(PLUGIN_DATA);
  await appendFrame({
    pluginData: PLUGIN_DATA,
    turn,
    ts: new Date().toISOString(),
    pngBytes: composed,
    brief: null,
  });
  const out = {
    content: [imageContent(composed)],
    structuredContent: {
      seed: grid.seed,
      gridC: grid.gridC,
      palette: PALETTE,
      w, h,
      turn,
      summary_every: summaryEvery,
    },
  };
  if (turn % summaryEvery === 0) {
    out.structuredContent.summary_request = {
      threshold: summaryEvery,
      frames_to_summarize: await listFrames(PLUGIN_DATA),
      prompt:
        `You have completed ${turn} computer-use turns. Summarize the prior ` +
        `frames in 1–3 sentences each via record_summary, keep only the latest ` +
        `screenshot visible, and continue. Older frames remain available via retrieve_frame.`,
    };
  }
  return out;
}

async function toolClick(args) {
  const decoded = decodeAddress(grid, { color1: args.color1, color2: args.color2, pos: args.pos });
  if (!decoded) {
    return {
      content: [textContent(`click: no sub-cell matches (${args.color1}, ${args.color2})`)],
      structuredContent: { dispatched: false, reason: 'no_match' },
    };
  }
  await Input.click(plan, decoded.x, decoded.y, {
    button: args.button || 'left',
    modifiers: args.modifiers || [],
  });
  return {
    content: [textContent(`click(${args.button || 'left'}) at (${decoded.x}, ${decoded.y})`)],
    structuredContent: { dispatched: true, x: decoded.x, y: decoded.y, matches: decoded.matches },
  };
}

async function toolScroll(args) {
  const decoded = decodeAddress(grid, { color1: args.color1, color2: args.color2, pos: args.pos });
  if (!decoded) {
    return {
      content: [textContent('scroll: no match')],
      structuredContent: { dispatched: false, reason: 'no_match' },
    };
  }
  await Input.scroll(plan, decoded.x, decoded.y, args.dx | 0, args.dy | 0);
  return {
    content: [textContent(`scroll at (${decoded.x}, ${decoded.y}) by (${args.dx}, ${args.dy})`)],
    structuredContent: { dispatched: true, x: decoded.x, y: decoded.y },
  };
}

async function toolDrag(args) {
  const a = decodeAddress(grid, args.from);
  const b = decodeAddress(grid, args.to);
  if (!a || !b) {
    return {
      content: [textContent('drag: no match')],
      structuredContent: { dispatched: false },
    };
  }
  await Input.drag(plan, [a.x, a.y], [b.x, b.y], { button: args.button || 'left' });
  return {
    content: [textContent(`drag from (${a.x}, ${a.y}) to (${b.x}, ${b.y})`)],
    structuredContent: { dispatched: true },
  };
}

async function toolTypeText(args) {
  await Input.typeText(plan, args.text, { intervalMs: args.interval_ms || 0 });
  return {
    content: [textContent(`typed ${args.text.length} chars`)],
    structuredContent: { typed: args.text.length },
  };
}

async function toolKeyCombo(args) {
  await Input.keyCombo(plan, args.keys);
  return {
    content: [textContent(`key combo: ${args.keys.join('+')}`)],
    structuredContent: { dispatched: true },
  };
}

async function toolCursorPosition() {
  const p = await Input.cursorPosition(plan);
  if (!p) {
    return {
      content: [textContent('cursor position unavailable')],
      structuredContent: { x: null, y: null },
    };
  }
  const x = p.X ?? p.x ?? 0;
  const y = p.Y ?? p.y ?? 0;
  return {
    content: [textContent(`cursor at (${x}, ${y})`)],
    structuredContent: { x, y },
  };
}

async function toolZoom(args) {
  const png = await takeScreenshot(plan, { region: args.region });
  return {
    content: [imageContent(png)],
    structuredContent: { region: args.region },
  };
}

async function toolGridMetadata() {
  return {
    content: [textContent(JSON.stringify({
      seed: grid?.seed ?? null,
      gridC: grid?.gridC ?? 32,
      palette: PALETTE,
      w: grid?.w ?? null,
      h: grid?.h ?? null,
      platform: plan,
      summary_every: summaryEvery,
    }, null, 2))],
    structuredContent: {
      seed: grid?.seed ?? null,
      gridC: grid?.gridC ?? 32,
      palette: PALETTE,
      w: grid?.w ?? null,
      h: grid?.h ?? null,
      platform: { os: plan.os, ready: plan.ready, needs: plan.needs },
      summary_every: summaryEvery,
    },
  };
}

async function toolRetrieveFrame(args) {
  const png = await readFrame(PLUGIN_DATA, args.turn);
  if (!png) {
    return {
      content: [textContent(`frame ${args.turn} not found`)],
      structuredContent: { found: false },
    };
  }
  return {
    content: [imageContent(png)],
    structuredContent: { turn: args.turn, found: true },
  };
}

async function toolRecordSummary(args) {
  await setSummary(PLUGIN_DATA, args.turn, args.summary);
  return {
    content: [textContent(`recorded summary for turn ${args.turn}`)],
    structuredContent: { stored: true, turn: args.turn },
  };
}

const ROUTES = {
  screenshot: toolScreenshot,
  click: toolClick,
  scroll: toolScroll,
  drag: toolDrag,
  type_text: toolTypeText,
  key_combo: toolKeyCombo,
  cursor_position: toolCursorPosition,
  zoom: toolZoom,
  grid_metadata: toolGridMetadata,
  retrieve_frame: toolRetrieveFrame,
  record_summary: toolRecordSummary,
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
  if (method === 'notifications/initialized') {
    return { result: {} };
  }
  if (method === 'tools/list') {
    return { result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const fn = ROUTES[name];
    if (!fn) return { error: { code: -32601, message: `unknown tool: ${name}` } };
    try {
      const out = await fn(params?.arguments || {});
      return { result: out };
    } catch (e) {
      const code = e.code === 'TOOLS_MISSING' ? 'TOOLS_MISSING' : 'INTERNAL';
      return {
        result: {
          content: [textContent(`error: ${e.message}`)],
          isError: true,
          structuredContent: { error: { code, message: e.message, hint: e.hint || null } },
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
  if (msg.id === undefined) return; // notification
  const resp = await handle(msg);
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...resp })}\n`);
});
