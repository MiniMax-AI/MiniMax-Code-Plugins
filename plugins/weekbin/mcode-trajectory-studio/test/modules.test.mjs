import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/**
 * The module graph is an engineering constraint, not a preference.
 *
 * A cycle makes load order matter and turns a small refactor into a subtle
 * breakage: `flow.js` importing a surface that imports `flow.js` back would work
 * only by accident of hoisting. These tests make "no cycles" enforceable — the
 * client honored it by having surfaces announce intents instead of importing the
 * actions, and any future edge that recreates a cycle fails here.
 */

const ROOT = path.join(import.meta.dirname, '..');

const STATIC_IMPORT = /(?:^|[^\w$])(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT = /(?:^|[^\w$])import\s*['"]([^'"]+)['"]/g;

/** Every relative specifier a source file imports or re-exports. */
function relativeImports(source) {
  const found = new Set();
  for (const pattern of [STATIC_IMPORT, SIDE_EFFECT_IMPORT]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1].startsWith('.')) found.add(match[1]);
    }
  }
  return [...found];
}

async function moduleFiles(dir, extension) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Build `file -> [imported files]` for one directory of modules. */
async function buildGraph(dir, extension) {
  const files = await moduleFiles(dir, extension);
  const graph = new Map();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const targets = relativeImports(source).map((specifier) => path.resolve(path.dirname(file), specifier));
    graph.set(file, targets);
  }
  return graph;
}

/** Return the first cycle found, as a path list, or null when the graph is a DAG. */
function findCycle(graph) {
  const state = new Map();   // undefined=unvisited, 'open', 'done'
  const stack = [];

  const visit = (node) => {
    state.set(node, 'open');
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;         // external or non-module target
      const seen = state.get(next);
      if (seen === 'open') return [...stack.slice(stack.indexOf(next)), next];
      if (seen === undefined) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  for (const node of graph.keys()) {
    if (state.get(node) === undefined) {
      const cycle = visit(node);
      if (cycle) return cycle;
    }
  }
  return null;
}

/** Every unresolved relative specifier across a directory, with its file. */
async function unresolvedImports(dir, extension) {
  const files = await moduleFiles(dir, extension);
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const specifier of relativeImports(source)) {
      const target = path.resolve(path.dirname(file), specifier);
      try {
        await readFile(target);
      } catch {
        missing.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      }
    }
  }
  return missing;
}

const shortest = (cycle) => cycle.map((file) => path.basename(file)).join(' -> ');

test('the server module graph is acyclic', async () => {
  const graph = await buildGraph(path.join(ROOT, 'server'), '.mjs');
  assert.ok(graph.size >= 10, `expected the server to be split into modules (got ${graph.size})`);
  const cycle = findCycle(graph);
  assert.equal(cycle, null, `server import cycle: ${cycle ? shortest(cycle) : ''}`);
});

test('the client module graph is acyclic', async () => {
  const dir = path.join(ROOT, 'web', 'js');
  const graph = await buildGraph(dir, '.js');
  assert.ok(graph.size >= 12, `expected the client to be split into modules (got ${graph.size})`);

  // The entry point's own imports count too.
  const entry = path.join(ROOT, 'web', 'app.js');
  const entrySource = await readFile(entry, 'utf8');
  graph.set(entry, relativeImports(entrySource).map((s) => path.resolve(path.dirname(entry), s)));

  const cycle = findCycle(graph);
  assert.equal(cycle, null, `client import cycle: ${cycle ? shortest(cycle) : ''}`);
});

test('every relative import resolves to a real file', async () => {
  for (const [dir, extension] of [[path.join(ROOT, 'server'), '.mjs'], [path.join(ROOT, 'web', 'js'), '.js']]) {
    const missing = await unresolvedImports(dir, extension);
    assert.deepEqual(missing, [], `unresolved imports: ${missing.join(', ')}`);
  }
});

test('no client surface imports the flow or controller layer', async () => {
  // The structural rule behind the acyclicity: a surface may announce an intent,
  // never reach up into the orchestrator that renders it.
  const surfaces = ['sidebar.js', 'capability.js', 'stats.js', 'timeline.js', 'stream.js', 'inspector.js'];
  const dir = path.join(ROOT, 'web', 'js');
  const offenders = [];
  for (const name of surfaces) {
    const source = await readFile(path.join(dir, name), 'utf8');
    for (const specifier of relativeImports(source)) {
      if (specifier === './flow.js' || specifier === './controller.js' || specifier === './wire.js') {
        offenders.push(`${name} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('; '));
});
