/**
 * The Skill's claims, checked against the code that has to honour them.
 *
 * `SKILL.md` is the only thing standing between a model and a wrong turn: it is where
 * "an empty result means search is off, not that nothing matched" and "`available: false`
 * is a successful answer" live. Nine separate mistakes in it were found and fixed by
 * hand, and after those fixes *nothing read this file*. Every claim in it could now be
 * wrong again the next time a field is renamed or an error code is reworded, and the
 * failure mode is silent — the model follows correct-sounding advice about code that
 * no longer exists.
 *
 * So the assertions here are extracted from the document rather than transcribed from
 * it. A transcribed copy would be a second thing to keep in sync, and this file is
 * precisely about things falling out of sync; parsing the prose means editing the
 * prose is what moves the test.
 *
 * What this deliberately does not check: that the guidance is *good*. It cannot tell
 * whether asking before widening to `full` detail is the right instruction. It only
 * holds the document to the code's shape — that a named error code can still be
 * produced, a named field still exists, and a named tool still exists.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DETAIL_LEVELS, INPUT_KINDS } from '../server/config.mjs';
import { classifyInput } from '../server/events.mjs';
import { SEARCHABLE_COLUMNS } from '../server/search.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = readFileSync(path.join(ROOT, 'skills/mcode-trajectory-studio/SKILL.md'), 'utf8');

/** Every server and web source file, as one searchable blob. */
const SOURCE = readdirSync(path.join(ROOT, 'server'))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => readFileSync(path.join(ROOT, 'server', name), 'utf8'))
  .join('\n')
  .concat(readdirSync(path.join(ROOT, 'web/js'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(path.join(ROOT, 'web/js', name), 'utf8'))
    .join('\n'));

/** The body of one `## section`, up to the next heading of any level. */
function section(heading) {
  const start = SKILL.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `SKILL.md no longer has a "${heading}" section`);
  const title = SKILL.indexOf('\n', start + 1);
  // Search *after* the heading line: `slice(0)` would start on the heading's own
  // `#` and match it at index 0, yielding a section one character long.
  const rest = SKILL.slice(title + 1);
  const next = rest.search(/^#{1,3} /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Backticked tokens in a chunk of prose, in order, de-duplicated. */
function ticks(text) {
  return [...new Set([...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]))];
}

/** First cell of every table row, split on `/` and `,` into individual names. */
function firstCells(text) {
  return tableRows(text)
    .flatMap((line) => line.split('|')[1].split(/\s*[/,]\s*/).map((cell) => cell.trim().replaceAll('`', '')))
    .filter((cell) => cell.length > 0);
}

/** Table body rows only: the `|---|` separator and the `| Header |` line are both noise. */
function tableRows(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .filter((line) => !/^\|[\s|-]+\|$/u.test(line))
    .slice(1);
}

/** The tool names the runtime actually exposes, read from the source rather than a list. */
function realToolNames() {
  const mcp = readFileSync(path.join(ROOT, 'server/mcp.mjs'), 'utf8');
  const block = mcp.slice(mcp.indexOf('const TOOLS'), mcp.indexOf('const TOOLS') + mcp.indexOf('];', mcp.indexOf('const TOOLS')));
  return [...block.matchAll(/name:\s*'([a-z_]+)'/g)].map((match) => match[1]);
}

/* ------------------------------------------------------- the tool surface -- */

test('the Skill names exactly the tools the runtime exposes', () => {
  const real = realToolNames();
  // Derived, not written down. A literal here would be the same stale copy this file
  // exists to catch — it would have failed on the day a tool was added, correctly, but
  // for the wrong reason and with a message that reads like a broken test.
  assert.ok(real.length >= 7, `only ${real.length} tools are exposed, which is fewer than the surface has always had`);
  const named = [...new Set(SKILL.match(/trajectory_[a-z_]+/g) ?? [])];

  // A tool that exists but is undocumented is a tool the model will never call.
  for (const tool of real) {
    assert.ok(named.includes(tool), `${tool} is exposed but SKILL.md never mentions it`);
  }
  // A tool the Skill teaches that does not exist is worse: every use of it errors.
  for (const tool of named) {
    assert.ok(real.includes(tool), `SKILL.md teaches ${tool}, which the runtime does not expose`);
  }
});

test('the Skill\'s numbered tool list is contiguous and covers every tool', () => {
  // The pairwise check above is satisfied by a mention anywhere in the file, so it does
  // not notice a tool dropping *out of the list* — which is what happened here when a
  // renumbering consumed the `trajectory_studio` line while `trajectory_agent` still
  // appeared elsewhere in the document. A list that skips a number has lost a row.
  const list = SKILL.slice(SKILL.indexOf('\n## Tools'));
  const rows = [...list.matchAll(/^(\d+)\. `([a-z_]+)`/gmu)].map((match) => [Number(match[1]), match[2]]);
  assert.ok(rows.length >= 7, `only ${rows.length} tools are listed`);
  rows.forEach(([number], index) => {
    assert.equal(number, index + 1, `the list jumps at position ${index + 1}: a row was dropped`);
  });
  for (const tool of realToolNames()) {
    assert.ok(rows.some(([, name]) => name === tool), `${tool} is exposed but missing from the numbered list`);
  }
  assert.equal(new Set(rows.map(([, name]) => name)).size, rows.length, 'a tool is listed twice');
});

test('the Skill\'s detail levels are the levels the runtime accepts', () => {
  const rows = tableRows(section('Pick the detail level first'))
    .map((line) => line.split('|')[1].replaceAll('`', '').trim().split(/\s+/).filter(Boolean)[0]);
  assert.deepEqual(rows, DETAIL_LEVELS.slice(), 'SKILL.md and DETAIL_LEVELS describe different sets');
});

/* ------------------------------------------------------- the failure table -- */

test('every error code the Skill lists can still be produced', () => {
  const codes = firstCells(section('When a tool fails'))
    // `session_not_found:<id>` and `unknown_tool:<name>` document a template; the code
    // it expands from is the part before the colon.
    .map((cell) => cell.split(':')[0].trim())
    .filter((cell) => /^[a-z_]+$/u.test(cell));

  assert.ok(codes.length >= 7, `only ${codes.length} codes parsed out of the failure table`);
  for (const code of codes) {
    // Word boundaries, not `includes`. A plain substring check accepts
    // `unknown_session_identifier` as evidence for `unknown_session_id`, because one is
    // inside the other — so renaming a code to a longer one that merely starts the same
    // way would leave this test green while breaking every caller of the old name.
    assert.ok(
      new RegExp(`\\b${code}\\b`, 'u').test(SOURCE),
      `SKILL.md lists the error code \`${code}\`, which no source can emit`,
    );
  }
});

/* ------------------------------------------------- the completeness fields -- */

test('every completeness field the Skill lists is still a field', () => {
  const fields = firstCells(section('Every list can be partial'))
    // "On" column names tools like `trajectory_get`; only the leading field names
    // belong to the first column, which is what firstCells already returned.
    .filter((cell) => /^[A-Za-z][A-Za-z0-9]*$/u.test(cell) && !/^trajectory_$/u.test(cell));

  assert.ok(fields.length >= 10, `only ${fields.length} completeness fields parsed`);
  for (const field of fields) {
    assert.ok(SOURCE.includes(field), `SKILL.md tells the model to read \`${field}\`, which no source produces`);
  }
});

/* ------------------------------------------------------ per-tool specifics -- */

test('every tool the Skill says publishes `recordsUnavailable` actually does', () => {
  // Scoped per `case` block rather than searched across the file. Three tools publish
  // the field and the fourth (`trajectory_list`) does not, so a document-wide search
  // would find the name three times over and be satisfied by one of them — the shape
  // where a Skill entry promises a disclosure on a tool that dropped it.
  const mcp = readFileSync(path.join(ROOT, 'server/mcp.mjs'), 'utf8');
  const promised = /`recordsUnavailable` \| ([^|]+)\|/u.exec(
    section('Every list can be partial'),
  )?.[1] ?? '';
  const tools = [...promised.matchAll(/trajectory_[a-z_]+/gu)].map((m) => m[0]);
  assert.ok(tools.length >= 3, `only ${tools.length} tools parsed out of the completeness table`);

  for (const tool of tools) {
    const body = mcp.split(`case '${tool}'`)[1]?.split(/\n    case '/u)[0] ?? '';
    assert.ok(body.length > 0, `no case block for ${tool} could be read out of mcp.mjs`);
    assert.match(body, /recordsUnavailable/u,
      `SKILL.md says ${tool} publishes \`recordsUnavailable\` and its reply no longer can`);
  }
});

test('the Skill tells the model not to report an unreadable session as an empty one', () => {
  // The whole point of the field. A Skill that documented *what* it is without saying
  // what to do about it would still let the model answer "it did nothing". Three
  // ingredients rather than one transcribed sentence: the field to check, an ordering
  // that puts the check before the conclusion, and the reason the conclusion is wrong.
  const text = section('A session with no records is not a session that did nothing');
  assert.match(text, /recordsUnavailable/u, 'the section does not name the field to check');
  assert.match(text, /\*\*check `recordsUnavailable`[^.]*before/iu,
    'the section does not tell the model to check the field before concluding anything');
  assert.match(text, /count of nothing|not a finding|records are not readable/iu,
    'the section never says why the zeros beside the field are not a finding');
  // And the neighbouring state needs its own name, because the two look identical in
  // the numbers and only differ in where the records turned out to be.
  assert.match(text, /recordsInArtifact/u, 'the artifact-side state has no documented field');
});

/* ------------------------------------------------------ per-tool specifics -- */

test('the Skill\'s stated `maxBytes` default is the schema\'s default', () => {
  // "bounded, `maxBytes` defaults to 16384" is a number a reader will trust exactly.
  const claimed = SKILL.match(/maxBytes`?\s*defaults\s*to\s*(\d+)/u);
  assert.ok(claimed, 'SKILL.md no longer states a maxBytes default');
  const mcp = readFileSync(path.join(ROOT, 'server/mcp.mjs'), 'utf8');
  const schemaDefault = mcp.match(/maxBytes:.*?default:\s*(\d+)/u);
  assert.ok(schemaDefault, 'the maxBytes default is no longer in the tool schema');
  assert.equal(Number(claimed[1]), Number(schemaDefault[1]),
    `SKILL.md says maxBytes defaults to ${claimed[1]}, the schema says ${schemaDefault[1]}`);
});

test('the Skill\'s `inputKind` values are the ones the event layer produces', () => {
  // "human, injected, or unknown, and null on every non-user role" is four claims.
  //
  // Checked by calling the classifier rather than by grepping its source for the
  // literals. Grepping was always a proxy for "does this produce the value", and it
  // stopped being even that the moment the function started reading the declared set
  // instead of spelling the words out — it reported that events.mjs produced nothing
  // at all, which was false.
  for (const kind of ['human', 'injected', 'unknown']) {
    const produced = [
      classifyInput('api', 'origin'),
      classifyInput('thread-goal', null),
      classifyInput('api', null),
      classifyInput('nothing-recognised', null),
    ];
    assert.ok(produced.includes(kind), `SKILL.md lists inputKind \`${kind}\`, which the classifier never produces`);
  }
  const events = readFileSync(path.join(ROOT, 'server/events.mjs'), 'utf8');
  // The fourth claim is that it is null on every other role, so the assignment has to
  // be a conditional rather than a default — `classifyInput(...)` everywhere would make
  // the "null on non-user roles" half of the sentence untrue.
  assert.match(events, /inputKind:[^\n]*\?[^\n]*: null/u, 'inputKind is no longer null on non-user roles');
});

test('the Skill\'s context breakdown names the fields it actually travels in', () => {
  // Not the *values* — those are the runtime's, passed through untouched, which is
  // exactly why they drifted once: the panel iterates `components` and prints whatever
  // `kind` each entry has, so a new kind needed no code change and the Skill's hardcoded
  // list quietly went stale while omitting `OTHER` from every record it had read.
  // What this Plugin owns is the shape, and that is what has to stay true.
  const events = readFileSync(path.join(ROOT, 'server/events.mjs'), 'utf8');
  const inspector = readFileSync(path.join(ROOT, 'web/js/inspector.js'), 'utf8');
  for (const field of ['contextUsage', 'components', 'kind', 'tokens']) {
    assert.ok(events.includes(field), `the event layer no longer exposes \`${field}\` to the panel`);
  }
  assert.ok(/part\.kind/u.test(inspector), 'the panel no longer reads each entry\'s kind');
  // And the Skill has to say where the breakdown lives, or the advice is unfollowable.
  assert.match(SKILL, /contextUsage\.components/u, 'the Skill never says which field holds the breakdown');
  // `OTHER` has to be claimed, not merely mentioned: a bare occurrence in some other
  // sentence would satisfy a presence check while the breakdown line stayed silent about
  // the kind that is on every record.
  assert.match(SKILL, /`OTHER`[^.]*\bpresent\b/iu, 'the Skill does not say that OTHER is present on records');
});

test('the Skill says the breakdown can be absent while the total is real', () => {
  // The one shape the breakdown guidance above cannot handle, and it is not hypothetical:
  // across 102,748 records on this install, 11 carry `components: []` with a
  // `usedTokens` in the hundreds of thousands. Every one of them is marked
  // `totalCountSource: 'LOCAL_ESTIMATE'`; the other 102,735 read `PROVIDER_USAGE_ANCHORED`.
  // Where a breakdown exists it sums exactly to `usedTokens` — 0 mismatches in 102,737 —
  // so "read `kind` off each entry" is right and needs no hedging.
  //
  // The failure this pins is the guidance *silently* applying to a record it cannot read.
  // A model told "the breakdown is an array whose entries carry a kind" finds none, and
  // `usedTokens` beside it says the context was large — which reads as "no context used"
  // unless the document has already said the array can be empty on purpose.
  const events = readFileSync(path.join(ROOT, 'server/events.mjs'), 'utf8');
  // The field that carries the distinction has to still be exposed, or naming it is a lie.
  assert.ok(events.includes('totalCountSource'), 'the event layer no longer exposes `totalCountSource`');
  assert.match(SKILL, /totalCountSource/u,
    'the Skill never names `totalCountSource`, so it cannot say which records have no breakdown');
  assert.match(SKILL, /LOCAL_ESTIMATE/u,
    'the Skill does not give the marker value that accompanies an absent breakdown');
  // The claim has to be the *exception* shape, not a passing mention: an empty breakdown
  // with a real total is the whole point.
  assert.match(SKILL, /empty array[^.]*\busedTokens\b|components` can be an empty/iu,
    'the Skill does not say that `components` can be empty while `usedTokens` is a real number');
});

/* ------------------------------------------------------ commands and routes -- */

test('the commands the Skill tells the model to run actually work', async () => {
  // Two are spelled out in prose: the panel, and `--help`'s sibling `--serve`. Both
  // name a real file and a real flag; a rename would turn advice into a dead end.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const command of [...new Set([...SKILL.matchAll(/node\s+(server\/\S+?\.mjs)(\s+--[a-z-]+)?/gu)])]
    .map((match) => [match[1], (match[2] ?? '').trim()])) {
    const [file, flag] = command;
    // `--serve` would open a listener, so only its argument parsing is exercised
    // here; `--doctor` is checked for real because it exits on its own.
    if (flag === '--serve') {
      const { parseArgs } = await import('../server/main.mjs');
      assert.equal(parseArgs(['--serve']).mode, 'serve', `SKILL.md suggests \`${file} --serve\`, which is not a mode`);
      continue;
    }
    const { stdout } = await run(process.execPath, [file, flag], { cwd: ROOT });
    assert.ok(stdout.trim().length > 0, `\`${file} ${flag}\` is what SKILL.md tells the model to run, and it printed nothing`);
  }
});
test('the input kinds the event layer produces are the ones the Skill documents', () => {
  // `INPUT_KINDS` was declared and never read while `classifyInput` spelled the same
  // three words out by hand, so the declared set and the produced set were two
  // unconnected facts. The Skill tells a model exactly which three to expect, and a
  // fourth — or a renamed one — would arrive undocumented.
  assert.deepEqual([...INPUT_KINDS], ['human', 'injected', 'unknown']);

  // Every branch of the classifier, exercised: an origin type, an injected source, a
  // human source, and the fallback.
  const produced = new Set([
    classifyInput('api', 'something'),
    classifyInput('thread-goal', null),
    classifyInput('api', null),
    classifyInput('a-source-nobody-classified', null),
  ]);
  for (const kind of produced) {
    assert.ok(INPUT_KINDS.includes(kind), `classifyInput produced \`${kind}\`, which is not a declared input kind`);
  }
  for (const kind of INPUT_KINDS) {
    assert.ok(produced.has(kind), `\`${kind}\` is declared and documented but the classifier never returns it`);
  }
  for (const kind of produced) {
    assert.ok(SKILL.includes(`\`${kind}\``), `the Skill does not document the input kind \`${kind}\``);
  }

  // The behavioural checks above pass whether or not the function reads the constant —
  // spelling the three words out by hand produces the same three words. So the claim
  // "the declared set is the single source" is a claim about the code's shape, and it
  // gets a shape assertion. Without it the constant is free to go back to being
  // documentation nobody reads, which is what it was.
  // Imports and comments are both excluded, because a name that appears in either still
  // reads as a reference. Each exclusion was earned: with only the import excluded the
  // assertion passed on a function that had gone back to its own literals, and with the
  // import excluded but comments kept it passed on the comment saying it did not.
  const code = readFileSync(path.join(ROOT, 'server/events.mjs'), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*import\b/u.test(line) && !/^\s*(\/\/|\*)/u.test(line))
    .join('\n');
  assert.match(code, /=\s*INPUT_KINDS\b/u,
    'classifyInput no longer reads INPUT_KINDS, so the declared set is dead weight again');
});

/* ------------------------------------------------- what search can reach -- */

/**
 * The search reached a field the documentation never named.
 *
 * The runtime writes the objective it dispatched a sub-agent with, the FTS index carries
 * it, and `search.mjs` has always queried it — `purpose_terms` is in the searchable
 * column list. Neither the tool description, SKILL.md, nor either README said so. Both
 * promised "titles, agent names, statuses and workspace paths", which is true and
 * incomplete.
 *
 * The cost of that is not a wrong answer; it is an answer nobody asks for. A reader who
 * said "find the session where I audited dead paths" is reading a tool that says it
 * searches titles, so they search for a title, find none, and conclude the session does
 * not exist. The capability worked the whole time. Measured on this machine: 439 of 633
 * indexed rows carry a purpose and the other 194 do not, so a query drawn from a
 * sub-agent's brief finds its session and the same query never finds a top-level one —
 * which is a limit of the index and worth saying out loud rather than letting a caller
 * infer "no such session".
 *
 * Two things are pinned separately because they rot separately: the column being
 * queried at all, and the field being named. Dropping the column loses the capability
 * silently; dropping the name leaves it working and invisible, which is the worse of the
 * two because nothing fails.
 */

test('search still queries the sub-agent dispatch purpose', () => {
  assert.ok(
    SEARCHABLE_COLUMNS.includes('purpose_terms'),
    `the searchable columns are ${SEARCHABLE_COLUMNS.join(', ')} — purpose_terms is gone, so a content query cannot reach it`,
  );
});

test('the tool description says search reaches the purpose', () => {
  // The description in `tools/list` is what a model reads before anything else. If it
  // promises an exhaustive list of fields, that list has to be the real one.
  const mcp = readFileSync(path.join(ROOT, 'server/mcp.mjs'), 'utf8');
  const description = /name: 'trajectory_search',[\s\S]*?description:\s*\n?\s*'([^']*)'/u.exec(mcp)?.[1] ?? '';
  assert.ok(description.length > 0, 'the trajectory_search description could not be read out of the source');
  assert.match(description, /purpose/u,
    'the tool description still promises only titles, agents, statuses and workspace paths');
  assert.match(description, /sub-agent|dispatch/u,
    'the description mentions purpose without saying what fills it');
});

test('the Skill says the same thing as the tool description', () => {
  // Scoped to the field *enumeration*, not to the whole entry. The entry explains what
  // `purpose` is a few sentences later, so a match anywhere in it would survive the
  // mutation that drops the name from the list — which is the mutation that matters,
  // because the list is the sentence a reader takes as "this is what I can search".
  // Anchored on the *numbered entry*, not on the first backticked mention. The prose
  // around it names `trajectory_search` for other tools — "the same text
  // `trajectory_list` and `trajectory_search` publish on the row" — and a first-mention
  // selection silently latched onto whichever of those came first, captured 79
  // characters of someone else's paragraph, and then failed with a message about the
  // field enumeration. A selection rule that reads as "the entry" but actually means
  // "the first time the word appears" is a transcribed assumption that rots on the next
  // sentence written.
  const bullet = /\n\d+\.\s+`trajectory_search`([\s\S]*?)(?=\n\d+\.\s+`trajectory_|##\s)/u
    .exec(section('Tools'))?.[1] ?? '';
  assert.ok(bullet.length > 0, 'the trajectory_search entry could not be read out of the Tools section');
  assert.match(bullet, /workspace paths[^.]*`purpose`/u,
    'the field enumeration under trajectory_search no longer names purpose');
});
