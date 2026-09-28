#!/usr/bin/env node
/**
 * Release gates for this Plugin — the invariants three review rounds each found the
 * hard way.
 *
 * These are not a second copy of the test suite. The suite proves behaviour against
 * a real projection; these prove the properties that no behavioural test can see,
 * because they are about the *relationship* between the code, the shipped
 * documentation and the shipped surface:
 *
 *   1. version-coherence    One version, declared in four places. A release that
 *                           advertises 0.1.2 while the MCP server reports 0.1.3
 *                           looks, from the outside, like two Plugins.
 *   2. engine-claims        The manifests state a Node floor and a verified range.
 *                           They must match what `server/node-version.mjs`
 *                           enforces, or the compatibility claim is a decoration.
 *   3. byte-not-char-sql    A byte ceiling expressed with SQLite's `length()` on a
 *                           TEXT column counts characters. The unit under test is
 *                           invisible to a behavioural test that only uses ASCII
 *                           fixtures, so it is checked here instead.
 *   4. doc-anchors          The docs quote implementation. A doc that keeps quoting
 *                           a SQL form the code no longer uses is worse than no
 *                           doc: it reads as verification.
 *   5. record-list-egress   Every tool that returns a record list must be bounded
 *                           and must report what the bound dropped. `trajectory_tasks`
 *                           shipped unbounded for two rounds because the bound had
 *                           been added to one tool and not audited against the rest;
 *                           this gate makes "is this tool a record list" a decision
 *                           somebody has to write down.
 *
 * Every gate names the defect it exists to prevent, so a failure says which review
 * finding is at risk rather than just "check failed".
 *
 * Usage:
 *   node tools/release-gates.mjs          # run every gate
 *   node tools/release-gates.mjs --list   # names only, no file reads
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { TOOLS } from '../server/mcp.mjs';
import { NODE_FLOOR_TEXT, VERIFIED_RANGE_TEXT } from '../server/node-version.mjs';

const PLUGIN = path.join(import.meta.dirname, '..');

const results = [];
const failures = [];

async function gate(id, prevents, check) {
  const problems = (await check()) ?? [];
  results.push({ id, prevents, ok: problems.length === 0 });
  for (const problem of problems) failures.push(`${id}: ${problem}`);
}

/* ------------------------------------------------- 1. version coherence -- */

/**
 * The four places a version lives.
 *
 * `plugin.json` is what the host reads, `.claude-plugin/plugin.json` is the mirror
 * other hosts read, the Skill frontmatter is what a human reads, and
 * `SERVER_VERSION` is what `tools/list` reports over the wire. Bumping three of four
 * is not a typo — it is invisible until someone compares them.
 */
const VERSION_SOURCES = [
  ['plugin.json', /"version"\s*:\s*"([^"]+)"/],
  ['.claude-plugin/plugin.json', /"version"\s*:\s*"([^"]+)"/],
  // The Skill carries its version under `metadata:`, so the line is indented.
  ['skills/mcode-trajectory-studio/SKILL.md', /^\s*version:\s*(\S+)\s*$/m],
  ['server/mcp.mjs', /export const SERVER_VERSION = '([^']+)'/],
];

await gate('version-coherence', 'a release advertising one version and serving another', async () => {
  const seen = new Map();
  for (const [file, pattern] of VERSION_SOURCES) {
    const text = await readFile(path.join(PLUGIN, file), 'utf8');
    const match = text.match(pattern);
    if (!match) return [`${file} declares no version the gate can read`];
    seen.set(file, match[1]);
  }
  const versions = new Set(seen.values());
  if (versions.size > 1) {
    return [`versions disagree: ${[...seen].map(([file, v]) => `${file}=${v}`).join(', ')}`];
  }
  return [];
});

/* --------------------------------------------------- 2. engine claims -- */

await gate('engine-claims', 'a compatibility claim that the code no longer enforces', async () => {
  const problems = [];
  for (const file of ['plugin.json', '.claude-plugin/plugin.json']) {
    const text = await readFile(path.join(PLUGIN, file), 'utf8');
    // The floor and the range are stated numerically in prose, so they are compared
    // as numbers: the wording around them is allowed to change. Both manifests are
    // required to state both numbers, because that is what a reader is told to
    // trust when they install on a release nobody has run.
    if (!text.includes(NODE_FLOOR_TEXT)) problems.push(`${file} does not state the floor ${NODE_FLOOR_TEXT}`);
    for (const major of [...VERIFIED_RANGE_TEXT.matchAll(/>=\s*(\d+)/g)].map((match) => match[1])) {
      if (!new RegExp(`>=\\s*${major}\\b`).test(text)) {
        problems.push(`${file} does not state the verified range >=${major}`);
      }
    }
  }
  return problems;
});

/* ---------------------------------------------- 3. byte-not-char in SQL -- */

/**
 * Columns the byte ceilings are measured on.
 *
 * `data_json` is the per-row event ceiling; `record_json` is the task projection. Both
 * are TEXT, which is the whole problem: `length()` on TEXT returns characters.
 */
const TEXT_SIZE_COLUMNS = ['data_json', 'record_json'];

await gate('byte-not-char-sql', 'review finding 3: a byte ceiling that counted characters', async () => {
  const problems = [];
  const files = ['events.mjs', 'tasks.mjs', 'sessions.mjs', 'stats.mjs', 'search.mjs'];
  for (const name of files) {
    const text = await readFile(path.join(PLUGIN, 'server', name), 'utf8');
    text.split('\n').forEach((line, index) => {
      const measuresSize = /\blength\s*\(/.test(line);
      if (!measuresSize) return;
      const onTextColumn = TEXT_SIZE_COLUMNS.some((column) => line.includes(column));
      if (!onTextColumn) return;
      // A size test that is not a byte test is the defect. CAST is the only
      // accepted way to say "bytes" in SQLite.
      if (!/CAST\s*\([^)]*AS\s+BLOB\)/i.test(line)) {
        problems.push(`server/${name}:${index + 1} measures a TEXT column in characters — ${line.trim()}`);
      }
    });
  }
  return problems;
});

/* ----------------------------------------------------- 4. doc anchors -- */

/**
 * Claims the documentation makes about this implementation.
 *
 * Each entry is a string that must exist in the file, or must not. This is the gate
 * for the class of defect where the code is fixed and the doc keeps describing the
 * old code: `DESIGN.md` documented `CASE WHEN length(data_json) <= ?` as though it
 * were a byte bound for two review rounds after that stopped being true.
 */
const DOC_ANCHORS = [
  {
    file: 'DESIGN.md',
    mustContain: [
      'length(CAST(data_json AS BLOB))',
      'UTF-8',
    ],
    mustNotContain: [
      'CASE WHEN length(data_json) <= ?',
    ],
  },
  {
    file: 'README.md',
    mustContain: [
      'UTF-8 bytes',
      'nextOffset',
    ],
    mustNotContain: [],
  },
];

await gate('doc-anchors', 'documentation quoting an implementation the code no longer has', async () => {
  const problems = [];
  for (const anchor of DOC_ANCHORS) {
    const text = await readFile(path.join(PLUGIN, anchor.file), 'utf8');
    for (const needle of anchor.mustContain) {
      if (!text.includes(needle)) problems.push(`${anchor.file} no longer states "${needle}"`);
    }
    for (const needle of anchor.mustNotContain) {
      if (text.includes(needle)) problems.push(`${anchor.file} still states "${needle}"`);
    }
  }
  return problems;
});

/* ---------------------------------------------- 5. record-list egress -- */

/**
 * Which tools return a record list, declared rather than inferred.
 *
 * A tool that is not listed here and turns out to return a list is the gap this
 * gate closes; `unclassified` is reported so adding a tool forces the decision.
 */
const RECORD_LIST_TOOLS = new Set([
  'trajectory_list',
  'trajectory_get',
  'trajectory_search',
  'trajectory_tasks',
]);

/**
 * Tools that return one object, and so need no list budget.
 *
 * `trajectory_studio` is here because it is a lifecycle call, and `trajectory_summary`
 * / `trajectory_task_output` because each returns a single folded value. The point of
 * listing them is the same as the point of listing the others: somebody decided.
 */
const SINGLE_OBJECT_TOOLS = new Set([
  'trajectory_summary',
  'trajectory_task_output',
  'trajectory_studio',
]);

await gate('record-list-egress', 'review finding 5: a record list with no frame budget', async () => {
  const problems = [];
  const text = await readFile(path.join(PLUGIN, 'server', 'mcp.mjs'), 'utf8');
  for (const tool of TOOLS) {
    const start = text.indexOf(`case '${tool.name}':`);
    if (start === -1) {
      problems.push(`${tool.name} is declared in TOOLS but has no case block in mcp.mjs`);
      continue;
    }
    const rest = text.slice(start + 1);
    const next = rest.indexOf("\n    case '");
    const body = next === -1 ? rest : rest.slice(0, next);

    if (!RECORD_LIST_TOOLS.has(tool.name)) {
      // Not a record list by declaration. The only evidence needed is that it does
      // not quietly return one, which the egress suite asserts behaviourally.
      continue;
    }
    if (!body.includes('boundPayloadList')) {
      problems.push(`${tool.name} returns a record list without boundPayloadList`);
    }
    for (const field of ['truncated', 'omitted']) {
      if (!new RegExp(`\\b${field}\\b`).test(body)) {
        problems.push(`${tool.name} returns a record list without reporting ${field}`);
      }
    }
    if (tool.description && !/truncated\/omitted/.test(tool.description)) {
      problems.push(`${tool.name}'s description does not tell the caller about truncated/omitted`);
    }
  }
  // A tool nobody classified is a tool nobody reasoned about.
  const unclassified = TOOLS
    .map((tool) => tool.name)
    .filter((name) => !RECORD_LIST_TOOLS.has(name) && !SINGLE_OBJECT_TOOLS.has(name));
  for (const name of unclassified) {
    problems.push(`${name} is not classified: add it to RECORD_LIST_TOOLS or SINGLE_OBJECT_TOOLS`);
  }
  return problems;
});

/* ------------------------------------------------------------- report -- */

if (process.argv.includes('--list')) {
  for (const result of results) process.stdout.write(`${result.id}\n  prevents: ${result.prevents}\n`);
  process.exit(0);
}

const width = Math.max(...results.map((result) => result.id.length));
for (const result of results) {
  process.stdout.write(`${result.ok ? 'ok  ' : 'FAIL'} ${result.id.padEnd(width)}  ${result.prevents}\n`);
}
if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} release-gate failure(s):\n`);
  for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
  process.exit(1);
}
process.stdout.write(`\n${results.length} release gates passed.\n`);
