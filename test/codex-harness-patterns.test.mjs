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
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
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

// Extract every FULL `fnName(...)` call from every code block in `text`,
// matching paren-balanced bodies (multi-line allowed). Returns
// `{ match, line }` for each call where `match` is the entire
// `fnName(args...)` substring and `line` is the 1-based line within
// the code block where the call starts.
//
// The earlier `findInCodeFences(text, /task\s*\(/u)` only returned the
// first 5 characters of the call ('task('), so the parameter-name
// asserts that ran against it were vacuously true (you cannot find
// 'agent_name=' inside 'task('). This balanced-paren extractor closes
// the false-green hole the round-4 review identified.
//
// Multi-line calls (most real `task(` / `bash(` examples are multi-line)
// are supported: the paren walker does not break on newline, only on EOF.
function extractCallBodies(text, fnName) {
  const calls = [];
  const nameRe = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Use a negative lookbehind so we match 'task(' at start-of-string or
  // after any non-word char (whitespace, `>`, `(`, `,`, newline). The
  // simpler `(^|[^\w])` form also captures the preceding char which
  // throws off the callStart index.
  const callRe = new RegExp(`(?<![A-Za-z0-9_])${nameRe}\\s*\\(`, 'gu');
  const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gu;
  for (const fm of text.matchAll(fenceRe)) {
    const block = fm[1];
    for (const m of block.matchAll(callRe)) {
      // m.index is the position of the start of the name; '(' is the
      // last char of the match.
      const openIdx = m.index + m[0].length - 1;
      let depth = 1;
      let i = openIdx + 1;
      let inString = null; // '"' | "'" | null
      let lineStart = true; // at start of a line (after a newline)
      while (i < block.length && depth > 0) {
        const ch = block[i];
        if (inString) {
          if (ch === '\\') { i += 2; lineStart = false; continue; }
          if (ch === inString) inString = null;
        } else if (ch === '"' || ch === "'") {
          inString = ch;
        } else if (ch === '(') {
          depth += 1;
        } else if (ch === ')') {
          depth -= 1;
        }
        // newline is allowed inside the call body; track it only for
        // the line-number report.
        if (ch === '\n') lineStart = true;
        else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
        i += 1;
      }
      if (depth === 0) {
        const callStr = block.slice(m.index, i);
        const line = block.slice(0, m.index).split('\n').length;
        calls.push({ match: callStr, line });
      }
    }
  }
  return calls;
}

// --- Tests ------------------------------------------------------------------

// === Negative-first fixture tests (round-4 review close-out) ===
//
// Each of these is constructed against a synthetic SKILL.md string that
// embeds a known-bad pattern. The assert demonstrates that the helper
// under test actually catches the pattern. To prove the test would
// fail on the previous (round-4) implementation, the comment at the
// top of each test names the change that would break it.

const NEG_TASK = `---
name: test-skill
description: |
  A test fixture that embeds a Codex-style task() call.
license: Apache-2.0
metadata:
  author: antianqi
  version: "0.0.1"
---

# Test

The point of this fixture is to embed a \`task(agent_name="explore", brief="...")\`
call inside a code block. Any extractor that returns only the literal
\`task(\` (5 chars) cannot see the body and cannot fail this fixture.

\`\`\`text
> task(
    agent_name="explore",
    brief="Investigate X",
    description="d"
  )
\`\`\`
`;

test('extractCallBodies returns the full task(...) body (not just "task(")', () => {
  // This is the round-4 false-green hole: findInCodeFences returned
  // mm[0] (the regex match = 'task('), so the assert
  //   !/\bagent_name\s*=/u.test('task(') was always true and the
  // contract check never saw the actual parameters.
  const calls = extractCallBodies(NEG_TASK, 'task');
  assert.equal(calls.length, 1, `expected 1 task(...) call, got ${calls.length}`);
  // The body must contain the parameter names that appear AFTER '('
  // in the fixture. 'task(' alone would fail all four asserts below.
  assert.match(calls[0].match, /\bagent_name\s*=/u,
    'extractCallBodies must capture the full body, including the agent_name= arg (proves the regex does not stop at the open paren)');
  assert.match(calls[0].match, /\bbrief\s*=/u,
    'extractCallBodies must capture brief= (the parameter that comes after the open paren)');
  assert.match(calls[0].match, /\bdescription\s*=/u,
    'extractCallBodies must capture description= (a parameter from the end of the body)');
});

test('extractCallBodies returns "bash(...)" with full body, not just "bash("', () => {
  const NEG_BASH = `
\`\`\`text
> bash(
    command="echo hello",
    run_in_background=true
  )
# returns { job_id: "job_x", pid: 12345, log: "..." }
\`\`\`
`;
  const calls = extractCallBodies(NEG_BASH, 'bash');
  assert.equal(calls.length, 1);
  assert.match(calls[0].match, /\bcommand\s*=/u,
    'extractCallBodies must capture the full bash body including the command= arg');
  assert.match(calls[0].match, /\brun_in_background\s*=\s*true/u,
    'extractCallBodies must capture run_in_background=true in the bash body');
});

test('extractCallBodies does NOT report false positives in prose', () => {
  // The helper must only look at code blocks; a prose mention of
  // "task(agent_name=...)" should NOT be flagged because that prose
  // is documenting the round-1 defect, not using it.
  const PROSE_ONLY = `
This Skill previously used the Codex-style \`task(agent_name=...)\` form
but the round-1 review required switching to mcode canonical. See
\`fork-context-decision/SKILL.md\` for the corrected example.
`;
  const calls = extractCallBodies(PROSE_ONLY, 'task');
  assert.equal(calls.length, 0,
    `extractCallBodies must not match prose mentions of task(agent_name=); got ${calls.length} false positive(s)`);
});

test('every body after the closing frontmatter has no stray "---" that could split a second block (round-1 defect shape)', () => {
  // Round-1 reviewer finding on fork-context-decision: "two metadata
  // blocks and a stray '---' inside the frontmatter, plus a duplicate
  // '# Fork Context Decision' heading". The earlier parseFrontmatter
  // check used indexOf('\n---\n', 4) which only found the FIRST close,
  // so a second frontmatter-shaped block in the body was invisible.
  //
  // The fix is a structural check: walk the body and fail on any line
  // that is exactly '---' (or matches the '---' close pattern) AFTER
  // the first frontmatter close. That is the only way a second YAML
  // document could begin.
  const DUPLICATE_BLOCK = `---
name: fork-context-decision
description: |
  This Skill is about how much context to pass.
license: Apache-2.0
metadata:
  author: antianqi
  version: "0.1.0"
---
metadata:
  author: HACKED_INJECT
  version: "99.99.99"
---

# body
`;
  const NEG = `---
name: neg
description: |
  This Skill is fine.
license: Apache-2.0
metadata:
  author: antianqi
  version: "0.1.0"
---

# body

a prose paragraph.

---

# another H1 (no second frontmatter, but the stray '---' is still wrong)
`;
  // Helper: find the first frontmatter close, then check the body.
  const stray = (text) => {
    const end = text.indexOf('\n---\n', 4);
    if (end < 0) return null;
    const body = text.slice(end + 5);
    // Find any line in the body that is exactly '---'. If found,
    // return the line number (1-based, in the body).
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*---\s*$/u.test(lines[i])) return { line: i + 1, content: lines[i] };
    }
    return null;
  };
  assert.ok(stray(DUPLICATE_BLOCK) !== null,
    'a duplicate-block fixture must be detected (the round-1 defect shape)');
  assert.ok(stray(NEG) !== null,
    'a stray "---" line in prose must also be detected (a future regression shape)');
  // Positive case: a clean body must NOT have any stray '---' line.
  const CLEAN = `---
name: clean
description: |
  A clean Skill.
license: Apache-2.0
metadata:
  author: antianqi
  version: "0.1.0"
---

# body
no stray dashes here.
`;
  assert.equal(stray(CLEAN), null, 'a clean body must have no stray "---"');
});

// === Existing 23-Skill checks (now using extractCallBodies) ===

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
    const calls = extractCallBodies(text, 'task');
    assert.ok(calls.length > 0, `${name}: expected at least one task(...) example in a code block`);

    for (const { match } of calls) {
      // Inside every `task(` example, the parameters must be the canonical
      // mcode 0.2.4 set. extractCallBodies returns the FULL paren-balanced
      // body, so the regex below sees the actual arguments (round-4 fix:
      // the previous findInCodeFences returned only 'task(' and the
      // asserts were vacuously true).
      //
      // The banned list is the union of all Codex-harness parameter
      // names that have appeared in the round-1 / round-2 / round-3 /
      // round-4 review comments. Each is a known-bad shape that the
      // mcode 0.2.4 `task` tool (cli.js:B6c strict validator) does
      // not accept. `agent_name=` is also banned because the canonical
      // form is `subagent_type=` (cli.js:j6c accepts the alias but the
      // Skills prefer canonical).
      assert.ok(!/\bagent_name\s*=/u.test(match),
        `${name}: task(...) example uses "agent_name="; mcode canonical is "subagent_type=" (agent_name is accepted as a runtime alias but Skills prefer canonical)`);
      assert.ok(!/\bsubagent\s*=/u.test(match),
        `${name}: task(...) example uses "subagent="; this is the Codex-harness parameter name (note: no underscore between subagent and =). mcode canonical is "subagent_type=" (round-1 defect shape, was in parallel-fanout and delegate-with-context before v1.0.3)`);
      assert.ok(!/\bbrief\s*=/u.test(match),
        `${name}: task(...) example uses "brief="; mcode canonical is "prompt="`);
      assert.ok(!/\bhistory\s*=/u.test(match),
        `${name}: task(...) example uses "history="; mcode 0.2.4 has no context-sharing parameter (the 3 fork modes are expressed by what is inlined into "prompt")`);
      assert.ok(!/\bmodel_config_id\s*=/u.test(match),
        `${name}: task(...) example uses "model_config_id="; mcode 0.2.4 task tool does not expose a per-call model field (model selection is session-level)`);
      assert.ok(!/\bfork_turns\s*=/u.test(match),
        `${name}: task(...) example uses "fork_turns="; this is the Codex-harness parameter name, removed in v1.0.3`);
      assert.ok(!/\bagent_type\s*=/u.test(match),
        `${name}: task(...) example uses "agent_type="; mcode canonical is "subagent_type="`);
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
    // Use the full-body extractor so a Skill that hides a `task(`
    // call in the middle of a long body is still detected.
    const calls = extractCallBodies(text, 'task');
    if (calls.length === 0) continue;
    if (!allow.has(name)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `Skills with a task(...) call but not in the static-check allow-list: ${offenders.join(', ')}. Either add them to TASK_SKILLS (and pin their parameter names) or remove the task(...) call.`);
});

// === Round-4 #3: sub-agent manifest path verification ===
//
// Reviewer finding: "fork-context-decision/SKILL.md 仍声称三个 sub-agent
// manifest 位于 assets/agents/<name>/agent.md;请用当前 MiniMax Code 可验证
// 契约确认该路径". The Skills name explore / worker / verifier as
// subagent_type values; mcode 0.2.4 ships a per-agent manifest at
// `assets/agents/<name>/agent.md` (we verified this from
// `C:\Users\Administrator\.minimax-code\node_modules\@minimax-ai\code\assets\agents\`).
// This test fails closed if any named sub-agent type is missing the
// manifest file on disk, OR if a Skill claims a sub-agent type whose
// manifest does not exist.
test('sub-agent types claimed in Skills have a real manifest on disk (mcode 0.2.4 contract)', () => {
  // Locate the mcode install. The active mcode is at $env:LOCALAPPDATA
  // typically; fall back to a well-known absolute path. Skip the test
  // (not fail it) if no mcode install is reachable, so this test is
  // hermetic on dev machines that don't have mcode installed.
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', '@minimax-ai', 'code'),
    join(process.env.APPDATA || '', 'npm', 'node_modules', '@minimax-ai', 'code'),
    'C:\\Users\\Administrator\\.minimax-code\\node_modules\\@minimax-ai\\code',
  ];
  const mcodeRoot = candidates.find((p) => p && existsSync(join(p, 'assets', 'agents')));
  if (!mcodeRoot) {
    // No mcode reachable on this machine. Skip rather than fail.
    return;
  }
  // Scan all 23 Skills; collect every distinct subagent_type value that
  // appears in a `task(... subagent_type="X" ...)` example. The values
  // must come from the canonical mcode 0.2.4 set.
  const claimed = new Set();
  const reSub = /\bsubagent_type\s*=\s*["']([a-z0-9_-]+)["']/giu;
  for (const { path } of listSkillFiles()) {
    const text = readFileSync(path, 'utf8');
    for (const c of extractCallBodies(text, 'task')) {
      for (const m of c.match.matchAll(reSub)) claimed.add(m[1]);
    }
  }
  // The canonical sub-agent types (verified from
  // assets/agents/{explore,worker,verifier}/agent.md). `mavis` is the
  // root agent and MUST NOT be a claimed subagent_type.
  assert.ok(!claimed.has('mavis'),
    'mavis is the root agent, not a subagent_type; some Skill is still claiming it. Found in: ' + Array.from(claimed).join(', '));
  for (const name of claimed) {
    if (name === 'mavis') continue; // asserted above
    const manifest = join(mcodeRoot, 'assets', 'agents', name, 'agent.md');
    assert.ok(existsSync(manifest),
      `subagent_type "${name}" is claimed in a Skill example but the manifest ${manifest} does not exist on disk. Either the Skill is wrong or the mcode install is wrong.`);
  }
});

test('background-task uses `task(run_in_background: true)` + `task_query` / `task_output` / `task_stop` (no `bash(task_name=...)`, no `bash(action="kill")`)', () => {
  const path = join(SKILLS_ROOT, 'background-task', 'SKILL.md');
  const text = readFileSync(path, 'utf8');

  // Sub-agent background uses the `task` tool with `run_in_background: true`.
  // extractCallBodies returns the FULL paren-balanced body so the
  // run_in_background check actually sees the body (round-4 fix).
  const taskCalls = extractCallBodies(text, 'task');
  assert.ok(taskCalls.length > 0,
    'background-task must show at least one task(...) example (inside a code block)');
  assert.ok(taskCalls.some((c) => /\brun_in_background\s*[:=]\s*true/u.test(c.match)),
    'background-task must show run_in_background: true / = true inside a task(...) call');
  assert.ok(extractCallBodies(text, 'task_query').length > 0,
    'background-task must show task_query(...) for listing / fetching a background task');
  assert.ok(extractCallBodies(text, 'task_output').length > 0,
    'background-task must show task_output(task_id=...) for reading output');
  assert.ok(extractCallBodies(text, 'task_stop').length > 0,
    'background-task must show task_stop(task_id=...) for stopping a background task');

  // Shell background uses the `bash` tool with `run_in_background: true.
  // The call must carry run_in_background=true AND a documented return
  // shape (job id / pid / log path) somewhere in the same code block
  // (round-4 finding: the return shape was prose-only, not test-pinned).
  const bashCalls = extractCallBodies(text, 'bash');
  assert.ok(bashCalls.length > 0,
    'background-task must show at least one bash(...) example (inside a code block)');
  const bgBashCalls = bashCalls.filter((c) => /\brun_in_background\s*[:=]\s*true/u.test(c.match));
  assert.ok(bgBashCalls.length > 0,
    'background-task must show at least one bash(... run_in_background: true) example');
  // For each background-bash call, the call body must include a
  // documented handle. We extract the whole fenced block the call
  // appears in and assert the block mentions a handle keyword.
  for (const call of bgBashCalls) {
    const fenceRe = /```[a-zA-Z0-9_-]*\n([\s\S]*?)```/gu;
    let hostBlock = null;
    for (const fm of text.matchAll(fenceRe)) {
      if (fm[1].includes(call.match)) { hostBlock = fm[1]; break; }
    }
    assert.ok(hostBlock !== null,
      `background-task has a bash(... run_in_background: true) call but its code block could not be located: ${call.match.slice(0, 80)}`);
    const hasHandle = /\b(job_?id|pid|log_?path|log\b|handle)\b/iu.test(hostBlock);
    assert.ok(hasHandle,
      `background-task bash(... run_in_background: true) example in code block must document the return handle (job id / pid / log path). Block:\n${hostBlock}`);
  }

  // Codex-harness placeholders that do NOT exist on mcode 0.2.4. We only
  // look inside code blocks; prose mentions like "removed bash(task_name=...)"
  // in the frontmatter change-log are allowed (they are explicitly removing
  // the bad pattern, not using it). The call body is the FULL paren-balanced
  // body now (round-4 fix), so this assert actually sees the args.
  for (const call of bashCalls) {
    assert.ok(!/\btask_name\s*=/u.test(call.match),
      'background-task code block uses "bash(... task_name=...)" — mcode 0.2.4 bash has no task_name field; rewrite as `bash(command=..., run_in_background=true)`');
    assert.ok(!/\baction\s*=\s*["']kill["']/u.test(call.match),
      'background-task code block uses "bash(... action=\"kill\")" — mcode 0.2.4 bash has no action sub-action; killing is via task_stop or the host job-control API');
  }
});
