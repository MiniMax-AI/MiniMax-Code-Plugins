// codex-harness-patterns.test.mjs
//
// PR #18 review round 2: a static check that every one of the 23
// `plugins/antianqi/codex-harness-patterns/skills/*/SKILL.md` files has
// exactly one valid YAML frontmatter block, with the required fields, and
// without a duplicate `author:` or `version:` key anywhere in the file. Also
// pins the mcode 0.2.4 tool-surface contract for the 5 Skills that touch the
// `task` / `bash` tools (no `agent_name=` / `brief=` / `history=` /
// `bash(task_name=)` / `bash(action=)` / `model_config_id=` placeholders).
//
// Pinned against the bundled mcode 0.2.4 `cli.js` schema:
//   - `task(description, prompt, subagent_type, run_in_background?)`
//   - `bash(command, timeout?, run_in_background?)`
//   - `task_query(task_id?, status?)`
//   - `task_output(task_id, offset?)`
//   - `task_stop(task_id, reason?)`
// `agent_name=` is accepted as a runtime alias by mcode's normaliser
// (`cli.js:j6c`) but the canonical form is `subagent_type=`. The Skills
// prefer the canonical form; this test fails if any Skill body uses
// `agent_name=` inside a `task(` call. Mentioning `agent_name` in prose
// (e.g. the `compatibility:` field) is allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'antianqi', 'codex-harness-patterns');
const SKILLS_ROOT = join(PLUGIN_DIR, 'skills');

// --- Helpers ----------------------------------------------------------------

function listSkillFiles() {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      path: join(SKILLS_ROOT, d.name, 'SKILL.md'),
    }))
    .filter((d) => {
      try { return statSync(d.path).isFile(); } catch { return false; }
    });
}

// Very small YAML frontmatter parser. Supports the shape used by every
// Skill in this plugin: top-level `key: scalar` pairs, and a single
// `metadata:` block whose body is indented 2 spaces and contains
// `key: scalar` pairs. Returns the parsed object plus a list of (line,
// key) entries in document order so we can detect duplicates.
function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) {
    throw new Error('frontmatter must start with "---\\n" at the very top of the file');
  }
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error('frontmatter must be closed by a line containing only "---"');
  }
  const body = text.slice(4, end);
  const lines = body.split('\n');

  // No `---` line is allowed inside the frontmatter body. The closing
  // marker is on its own line; we already extracted everything before
  // it, so an inner `---` (matched by /^\s*---\s*$/) would corrupt the
  // parse and split the frontmatter into two pieces.
  const innerClose = lines.findIndex((l) => /^\s*---\s*$/u.test(l));
  if (innerClose >= 0) {
    throw new Error(`frontmatter contains an inner "---" line at line ${innerClose + 1} (would split the block)`);
  }

  // YAML keys in this plugin: ASCII letters / digits / underscore, plus
  // dot and hyphen for the version-suffixed change-log keys
  // (e.g. `changes-from-v0.1.2`). Anything fancier should be quoted.
  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.\-]*$/u;

  const out = { _keys: [] };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === '' || /^\s*#/u.test(line)) { i += 1; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_.\-]*)\s*:\s*(.*)$/u);
    if (!m) { throw new Error(`unparseable frontmatter line ${i + 1}: ${JSON.stringify(line)}`); }
    const key = m[1];
    const rest = m[2];
    if (out._keys.includes(key)) {
      throw new Error(`duplicate top-level key "${key}" in frontmatter (first seen earlier)`);
    }
    out._keys.push(key);
    if (rest === '' || rest === '|' || rest === '>') {
      // Block value (literal `|` or folded `>`) or nested mapping under this key.
      // Read indented continuation lines until we hit a non-indented line or EOF.
      const blockKind = rest;
      const blockLines = [];
      i += 1;
      while (i < lines.length && (lines[i] === '' || /^\s+/u.test(lines[i]))) {
        blockLines.push(lines[i].replace(/^\s{1,2}/u, ''));
        i += 1;
      }
      if (blockKind === '') {
        // Nested mapping: parse each `key: value` line.
        const nested = {};
        for (const bl of blockLines) {
          if (bl === '') continue;
          const nm = bl.match(/^([A-Za-z_][A-Za-z0-9_.\-]*)\s*:\s*(.*)$/u);
          if (!nm) { throw new Error(`unparseable nested mapping line under "${key}": ${JSON.stringify(bl)}`); }
          if (nested._keys?.includes(nm[1])) {
            throw new Error(`duplicate nested key "${nm[1]}" under "${key}"`);
          }
          if (!nested._keys) nested._keys = [];
          nested._keys.push(nm[1]);
          // Strip surrounding quotes from the scalar value.
          let v = nm[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          nested[nm[1]] = v;
        }
        out[key] = nested;
      } else {
        // Literal / folded scalar: collapse to a single string.
        out[key] = blockLines.join('\n').trim();
      }
    } else {
      // Scalar value: strip surrounding quotes.
      let v = rest.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[key] = v;
      i += 1;
    }
  }
  // Allow callers to introspect the raw key list; strip it from the
  // returned object so it does not pollute property-style access.
  const keys = out._keys;
  delete out._keys;
  out.__keys = keys;
  return out;
}

// Strip a single backtick-delimited code block / inline. We use this only
// to count prose claims (placeholders, Codex-harness parameter names),
// not to interpret the code; the asserts are conservative.
function findInCodeFences(text, re) {
  const hits = [];
  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gu;
  for (const m of text.matchAll(fenceRe)) {
    const block = m[1];
    let mm;
    const local = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((mm = local.exec(block)) !== null) {
      hits.push({ match: mm[0], line: block.slice(0, mm.index).split('\n').length });
    }
  }
  return hits;
}

// --- Tests ------------------------------------------------------------------

test('all 23 SKILL.md files exist (one per directory under skills/)', () => {
  const skills = listSkillFiles();
  assert.equal(skills.length, 23, `expected 23 Skills under ${SKILLS_ROOT}, found ${skills.length}: ${skills.map(s => s.name).join(', ')}`);
});

for (const { name, path } of listSkillFiles()) {
  test(`SKILL.md for ${name} has exactly one valid frontmatter block`, () => {
    const text = readFileSync(path, 'utf8');
    const fm = parseFrontmatter(text);

    // Required top-level fields.
    assert.equal(fm.name, name, `${name}: frontmatter "name" must equal the directory name`);
    assert.equal(typeof fm.description, 'string', `${name}: frontmatter "description" is required`);
    assert.ok(fm.description.length > 0, `${name}: frontmatter "description" must be non-empty`);
    assert.ok(fm.description.length <= 1024, `${name}: frontmatter "description" must be at most 1024 characters (got ${fm.description.length})`);
    assert.equal(fm.license, 'Apache-2.0', `${name}: frontmatter "license" must be Apache-2.0`);

    // Required metadata block (every Skill in this plugin has it).
    assert.ok(fm.metadata && typeof fm.metadata === 'object', `${name}: frontmatter "metadata" block is required`);
    assert.equal(fm.metadata.author, 'antianqi', `${name}: metadata.author must be "antianqi"`);
    assert.ok(typeof fm.metadata.version === 'string' && fm.metadata.version.length > 0,
      `${name}: metadata.version is required and must be non-empty`);

    // Body after the closing `---` must be non-empty.
    const body = text.slice(text.indexOf('\n---\n', 4) + 5).trim();
    assert.ok(body.length > 0, `${name}: instructions are required after the frontmatter`);
  });
}

test('no SKILL.md contains a duplicate `author:` or `version:` key anywhere', () => {
  // parseFrontmatter already rejects duplicate top-level / nested keys, but
  // a body that *also* repeats `author:` outside the frontmatter would slip
  // through. Pin both layers.
  for (const { name, path } of listSkillFiles()) {
    const text = readFileSync(path, 'utf8');
    // Strip the frontmatter so we only check the body.
    const end = text.indexOf('\n---\n', 4);
    const body = text.slice(end + 5);
    // A body line of `author: ...` or `version: ...` at column 0 is the
    // "duplicate author/version block" defect the reviewer flagged in the
    // previous round (see `fork-context-decision` v0.1.x). Bullet-list /
    // table / prose mentions like `- **author**: foo` or backtick-quoted
    // `version:` are allowed and are not matched.
    const dupAuthor = /(^|\n)author\s*:/u.test(body);
    const dupVersion = /(^|\n)version\s*:/u.test(body);
    assert.ok(!dupAuthor, `${name}: duplicate top-level "author:" key in body (forbidden — belongs only in metadata)`);
    assert.ok(!dupVersion, `${name}: duplicate top-level "version:" key in body (forbidden — belongs only in metadata)`);
  }
});

// --- mcode 0.2.4 tool-surface pinning ---------------------------------------

// Skills that touch the `task` tool. The 5 Skills rewritten in this PR plus
// any future Skill that calls `task(` must use the canonical parameter
// names from `cli.js:B6c`: description, prompt, subagent_type, run_in_background.
// The audit sweep after v1.0.4 also caught `error-recovery-strategy` which
// had a `task(subagent=...)` shape in its Example block; that fix is
// recorded as v0.1.2 of that Skill. The test below covers all Skills whose
// body contains a `task(` call in a code block — adding a new Skill that
// touches the `task` tool (or a new `task(` call in an existing Skill)
// will be caught by this test automatically.
const TASK_SKILLS = [
  'fork-context-decision',
  'delegate-with-context',
  'parallel-fanout',
  'model-router',
  'background-task',
  'error-recovery-strategy',
];

test('TASK_SKILLS use canonical mcode 0.2.4 `task` parameter names (no `agent_name=`, no `brief=`, no `history=`, no `model_config_id=`)', () => {
  for (const name of TASK_SKILLS) {
    const path = join(SKILLS_ROOT, name, 'SKILL.md');
    const text = readFileSync(path, 'utf8');
    const blocks = findInCodeFences(text, /task\s*\(/u);
    assert.ok(blocks.length > 0, `${name}: expected at least one task(...) example in a code block`);

    for (const { match } of blocks) {
      // Inside every `task(` example, the parameters must be the canonical
      // mcode 0.2.4 set. The prose around the code block may mention
      // `agent_name` as a runtime alias (allowed) — we only check what is
      // *inside* the call.
      assert.ok(!/\bagent_name\s*=/u.test(match),
        `${name}: task(...) example uses "agent_name="; mcode canonical is "subagent_type=" (agent_name is accepted as a runtime alias but Skills prefer canonical)`);
      assert.ok(!/\bbrief\s*=/u.test(match),
        `${name}: task(...) example uses "brief="; mcode canonical is "prompt="`);
      assert.ok(!/\bhistory\s*=/u.test(match),
        `${name}: task(...) example uses "history="; mcode 0.2.4 has no context-sharing parameter (the 3 fork modes are expressed by what is inlined into "prompt")`);
      assert.ok(!/\bmodel_config_id\s*=/u.test(match),
        `${name}: task(...) example uses "model_config_id="; mcode 0.2.4 task tool does not expose a per-call model field (model selection is session-level)`);
    }
  }
});

// Catch-all: any Skill whose code block contains a `task(` call but is
// not in the TASK_SKILLS allow-list must be added to the list (or the
// call removed). Without this, a future contributor could drop a
// `task(subagent=...)` shape into e.g. `plan-stream-emit` and slip
// past the static check.
test('every Skill with a `task(` call in a code block is in the TASK_SKILLS allow-list', () => {
  const allow = new Set(TASK_SKILLS);
  const offenders = [];
  for (const { name, path } of listSkillFiles()) {
    const text = readFileSync(path, 'utf8');
    const blocks = findInCodeFences(text, /task\s*\(/u);
    if (blocks.length === 0) continue;
    if (!allow.has(name)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `Skills with a task(...) call but not in the static-check allow-list: ${offenders.join(', ')}. Either add them to TASK_SKILLS (and pin their parameter names) or remove the task(...) call.`);
});

test('background-task uses `task(run_in_background: true)` + `task_query` / `task_output` / `task_stop` (no `bash(task_name=...)`, no `bash(action="kill")`)', () => {
  const path = join(SKILLS_ROOT, 'background-task', 'SKILL.md');
  const text = readFileSync(path, 'utf8');

  // Helper: match `key = value` OR `key: value` in code-block examples.
  const keyVal = (key, val = 'true') => new RegExp(`${key}\\s*[:=]\\s*${val}`, 'u');

  // Sub-agent background uses the `task` tool with `run_in_background: true`.
  assert.ok(findInCodeFences(text, /task\s*\([\s\S]*?/u).length > 0,
    'background-task must show at least one task(...) example (inside a code block)');
  assert.ok(findInCodeFences(text, keyVal('run_in_background', 'true')).length > 0,
    'background-task must show run_in_background: true / = true (inside a code block)');
  assert.ok(findInCodeFences(text, /task_query\s*\(/u).length > 0,
    'background-task must show task_query(...) for listing / fetching a background task');
  assert.ok(findInCodeFences(text, /task_output\s*\(/u).length > 0,
    'background-task must show task_output(task_id=...) for reading output');
  assert.ok(findInCodeFences(text, /task_stop\s*\(/u).length > 0,
    'background-task must show task_stop(task_id=...) for stopping a background task');

  // Shell background uses the `bash` tool with `run_in_background: true`.
  assert.ok(findInCodeFences(text, /bash\s*\([\s\S]*?/u).length > 0,
    'background-task must show at least one bash(...) example (inside a code block)');

  // Codex-harness placeholders that do NOT exist on mcode 0.2.4. We only
  // look inside code blocks; prose mentions like "removed bash(task_name=...)"
  // in the frontmatter change-log are allowed (they are explicitly removing
  // the bad pattern, not using it).
  const codeBlocks = findInCodeFences(text, /bash\s*\([\s\S]*?\)/u);
  for (const { match } of codeBlocks) {
    assert.ok(!/\btask_name\s*=/u.test(match),
      'background-task code block uses "bash(... task_name=...)" — mcode 0.2.4 bash has no task_name field; rewrite as `bash(command=..., run_in_background=true)`');
    assert.ok(!/\baction\s*=\s*["']kill["']/u.test(match),
      'background-task code block uses "bash(... action=\"kill\")" — mcode 0.2.4 bash has no action sub-action; killing is via task_stop or the host job-control API');
  }
});
