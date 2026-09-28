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
 *   6. zero-dependency     The Plugin ships no installed tree, no lockfile and no
 *                           dependency manifest, so every specifier a module reaches
 *                           for has to be `node:` or a path into this tree. The check
 *                           that stood here read one file and matched one declaration
 *                           form, and a scratch copy carrying a `package.json` with
 *                           two dependencies, three dynamic loads, a createRequire
 *                           call, a package name written into a string literal and a
 *                           real declaration in another tool passed it.
 *   7. doc-test-counts     The docs quote a test count by hand, and a hand-kept
 *                           count drifts by one with every case added: README
 *                           said 188, DESIGN said 202, the suite said neither, and
 *                           nothing compared them. The number each doc states is
 *                           now counted from `test/` and compared, so the drift
 *                           fails a gate instead of surviving to the next review.
 *
 * Every gate names the defect it exists to prevent, so a failure says which review
 * finding is at risk rather than just "check failed".
 *
 * Usage:
 *   node tools/release-gates.mjs          # run every gate
 *   node tools/release-gates.mjs --list   # names only, no file reads
 */

import { readFile, readdir } from 'node:fs/promises';
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

/* ------------------------------------------------ 6. zero dependency -- */

/**
 * The directories whose modules CI actually executes, and the only places a
 * package specifier can be read from. `tools/` is where the gates, the compat
 * matrix, the fixtures and the panel harness live, and a specifier in any of them
 * is a specifier the release depends on.
 */
const GATE_DIRS = ['tools'];
const MODULE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

/**
 * The manifest fields a dependency can be declared in. Empty or absent is the only
 * accepted state for all four: the Plugin installs nothing, so there is nothing
 * for a manifest to pin.
 */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** An installed tree or a lockfile is a dependency the Plugin cannot ship without one. */
const INSTALLED_TREES = new Set(['node_modules']);
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
]);

/**
 * Every syntax a package specifier can arrive in.
 *
 * The earlier check matched one of them — a single-quoted declaration, on one
 * line, in one file — and each of the other four walked straight past it. All
 * five are matched against raw text rather than a parsed module, deliberately: a
 * specifier written inside a string literal is reported for the same reason a live
 * one is, because the file reads as though the package were already wired in and
 * the next edit makes that true.
 */
const SPECIFIER_SYNTAXES = [
  { syntax: 'a declaration', pattern: /(?:^|[^\w$.])(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"]+)\1/gmu },
  { syntax: 'a bare side-effect load', pattern: /(?:^|[^\w$.])import\s*(['"])([^'"]+)\1/gmu },
  { syntax: 'a dynamic load', pattern: /(?:^|[^\w$.])import\s*\(\s*(['"])([^'"]+)\1/gmu },
  { syntax: 'a require call', pattern: /\brequire\s*\(\s*(['"])([^'"]+)\1/gmu },
  { syntax: 'a createRequire load', pattern: /\bcreateRequire\b[^;]{0,200}?\(\s*(['"])([^'"]+)\1/gmu },
];

/**
 * A file that reached for `createRequire` has asked to load a module by name, and from
 * there on any call whose only argument is a bare specifier is one of those loads. The
 * chained form — the loader invoked in the same expression that built it — is the
 * shape the syntax list above matches, and it is not the only one: assigning the loader
 * to a name and calling it on a later line puts a statement boundary between the two,
 * which the chained pattern cannot cross. That form passed this gate.
 *
 * This is a heuristic and it is scoped to files that already mention `createRequire`,
 * so it cannot fire on ordinary code elsewhere. It does not close the general problem —
 * a loader hidden behind a function that takes a computed name is beyond a text scan —
 * and it can still report a short lowercase argument in a file that has introduced a
 * loader. Both are stated rather than papered over, because a gate whose limits are
 * written down is one a maintainer can reason about.
 */
const LOADS_BY_NAME = /\b[A-Za-z_$][\w$]*\s*\(\s*(['"])([^'"]+)\1\s*\)/gu;

/**
 * A bare specifier, as opposed to any string at all. Without this the loader check
 * reported `join(", ")` and `split("\\n")` as packages, which is what a first pass of
 * it did: a package name is lowercase, may be scoped, and carries no whitespace and
 * no escape sequences.
 */
// Two characters minimum: a one-letter argument (`banner("x")`) is an argument, not a
// package, and reporting it would train a maintainer to ignore this gate.
const PACKAGE_SPECIFIER = /^[a-z@][a-z0-9@._/-]+$/u;
const FILE_EXTENSION = /\.(?:js|mjs|cjs|json|md|ya?ml|txt|log|sh|ts|map)$/u;

/** A specifier the Plugin can actually resolve: a built-in, or a file in this tree. */
const SHIPPABLE_SPECIFIER = /^(?:node:|\.{1,2}\/|\/|file:)/u;

/**
 * Every file in the Plugin, as Plugin-relative paths, plus the problems found on
 * the way. An installed tree or a lockfile is reported and not descended into.
 */
async function walkPlugin(dir, problems, relative = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const here = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (INSTALLED_TREES.has(entry.name)) {
        problems.push(`${here}/ is an installed dependency tree; the Plugin ships none`);
        continue;
      }
      files.push(...await walkPlugin(path.join(dir, entry.name), problems, here));
      continue;
    }
    if (LOCKFILES.has(entry.name)) {
      problems.push(`${here} is a dependency lockfile; the Plugin ships no dependencies`);
      continue;
    }
    files.push(here);
  }
  return files;
}

await gate('zero-dependency', 'a dependency nobody can install at run time', async () => {
  const problems = [];
  const shipped = await walkPlugin(PLUGIN, problems);

  // A manifest declares a dependency long before anything loads one.
  if (shipped.includes('package.json')) {
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(path.join(PLUGIN, 'package.json'), 'utf8'));
    } catch (error) {
      problems.push(`package.json is not readable JSON: ${error.message}`);
    }
    for (const field of DEPENDENCY_FIELDS) {
      const declared = manifest?.[field];
      if (declared && Object.keys(declared).length > 0) {
        problems.push(`package.json declares ${field}: ${Object.keys(declared).join(', ')}`);
      }
    }
  }

  const scanned = shipped.filter((file) =>
    GATE_DIRS.some((dir) => file.startsWith(`${dir}/`)) && MODULE_EXTENSIONS.has(path.extname(file)));
  for (const file of scanned) {
    const source = await readFile(path.join(PLUGIN, file), 'utf8');
    if (/\bcreateRequire\b/u.test(source)) {
      for (const match of source.matchAll(LOADS_BY_NAME)) {
        const specifier = match[2];
        // Two exclusions, each for a thing this check reported on its first pass: a
        // camelCase local (`boundPayloadList`) and a filename (`package.json`). A bare
        // specifier carries no uppercase and no document extension.
        if (!PACKAGE_SPECIFIER.test(specifier) || FILE_EXTENSION.test(specifier)) continue;
        const at = match.index + match[0].lastIndexOf(specifier);
        const line = source.slice(0, at).split('\n').length;
        problems.push(`${file}:${line} reaches for "${specifier}" through a loader this file built; the Plugin ships no dependencies`);
      }
    }
    for (const { syntax, pattern } of SPECIFIER_SYNTAXES) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[2];
        if (SHIPPABLE_SPECIFIER.test(specifier)) continue;
        // The specifier's own offset, so the line names the package rather than
        // the head of a wrapped declaration.
        const at = match.index + match[0].lastIndexOf(specifier);
        const line = source.slice(0, at).split('\n').length;
        problems.push(`${file}:${line} reaches for "${specifier}" through ${syntax}; the Plugin ships no dependencies`);
      }
    }
  }
  return problems;
});

/* ------------------------------------------- 7. documented test counts -- */

/**
 * Test counts the documentation states, and the line that states each one.
 *
 * README said 188 and DESIGN said 202, and nothing compared either against the
 * suite — the counts are hand-kept and drift by one every time a case is added.
 * Each entry is matched by its surrounding line rather than by a bare number, so
 * a reworded doc fails loudly here instead of quietly ceasing to be checked.
 * `DESIGN.md`'s repo-wide `npm run check` count is deliberately absent: it
 * belongs to the whole repository's suite and to every other Plugin's tests, so
 * this Plugin's gate cannot compute it without failing on changes it has no part
 * in. That count belongs to the repository's own gate.
 */
const DOC_TEST_COUNTS = [
  {
    file: 'README.md',
    states: 'the compat-matrix run marked "latest run"',
    line: /compat-matrix.*latest run/u,
    count: /(\d+)[ \t]+tests,\s*(\d+)[ \t]+pass/u,
  },
  {
    file: 'README.md',
    states: 'how far the suite has grown since those rows were measured',
    line: /has grown from \d+ in those rows to \d+/u,
    count: /in those rows to[ \t]+(\d+)/u,
  },
  {
    file: 'README.zh-CN.md',
    states: 'the compat-matrix run marked as the latest one',
    line: /compat-matrix.*最新一次/u,
    count: /(\d+)\s*个测试：\s*(\d+)\s*通过/u,
  },
  {
    file: 'DESIGN.md',
    states: "the Plugin's own suite",
    line: /`node --test`/u,
    count: /\*\*(\d+)[ \t]+pass/u,
  },
];

/**
 * A test case declared at the start of a line, which is how this suite writes
 * them: `test(`, `test.skip(`, `await test(`, at any indentation.
 */
const DECLARED_CASE = /^[ \t]*(?:await[ \t]+)?(?:test|it)(?:\.\w+)?[ \t]*\(/gmu;

/** A construct that can declare one case per iteration, which a line count cannot see. */
const CASE_MULTIPLIER = /(?:for|while)[ \t]*\(|\.(?:forEach|map)[ \t]*\(/u;

const indentOf = (line) => line.length - line.trimStart().length;

/**
 * Cases declared by the suite, and the problems that make that number a lie.
 *
 * Counted rather than run, because this gate is a CI step that sits next to the
 * step that runs the suite: a gate that re-ran 200+ cases — including the run
 * that invoked it — would double the suite's cost on every invocation. The count
 * is exact for this suite because every case is a call at the start of a line and
 * none is generated in a loop, and the one construct that could break that
 * assumption (a case declared inside a loop) is reported rather than absorbed.
 */
async function countDeclaredCases(problems) {
  const dir = path.join(PLUGIN, 'test');
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    problems.push(`test/ is not readable, so no count can be taken: ${error.message}`);
    return null;
  }
  const files = entries.filter((name) => name.endsWith('.test.mjs')).sort();
  if (files.length === 0) {
    problems.push('test/ declares no *.test.mjs file to count');
    return null;
  }
  let total = 0;
  for (const name of files) {
    const source = await readFile(path.join(dir, name), 'utf8');
    const lines = source.split('\n');
    total += [...source.matchAll(DECLARED_CASE)].length;
    lines.forEach((text, index) => {
      if (!/^[ \t]+(?:test|it)(?:\.\w+)?[ \t]*\(/u.test(text)) return;
      for (let back = index - 1; back >= 0 && back >= index - 8; back -= 1) {
        if (!CASE_MULTIPLIER.test(lines[back])) continue;
        if (indentOf(lines[back]) >= indentOf(text)) continue;
        problems.push(`test/${name}:${index + 1} declares a case inside a loop, so the counted total is a lower bound`);
        return;
      }
    });
  }
  return total;
}

await gate('doc-test-counts', 'a documented test count that no longer matches the suite', async () => {
  const problems = [];
  const declared = await countDeclaredCases(problems);
  if (declared === null) return problems;
  for (const claim of DOC_TEST_COUNTS) {
    const text = await readFile(path.join(PLUGIN, claim.file), 'utf8');
    const lines = text.split('\n');
    const hits = lines.flatMap((line, index) => (claim.line.test(line) ? [index] : []));
    if (hits.length !== 1) {
      problems.push(`${claim.file} states ${claim.states} on ${hits.length} lines; the gate can only compare 1`);
      continue;
    }
    const stated = claim.count.exec(lines[hits[0]]);
    if (!stated) {
      problems.push(`${claim.file}:${hits[0] + 1} states ${claim.states} in a form the gate cannot read: ${lines[hits[0]].trim()}`);
      continue;
    }
    const numbers = [...stated].slice(1).map(Number);
    if (numbers.some((number) => number !== declared)) {
      problems.push(
        `${claim.file}:${hits[0] + 1} counts ${numbers.join(' and ')} for ${claim.states}, but test/ declares `
        + `${declared} cases — change the suite and the doc together, or neither`,
      );
    }
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
