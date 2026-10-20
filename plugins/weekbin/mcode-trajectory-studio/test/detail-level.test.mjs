/**
 * The only route to message text, and what happens when a caller misses it.
 *
 * `detailLevel: 'full'` is the sole way to ask for `content` or `thinking`; `summary`
 * carries `contentLength` and omits both. The Skill told the model to "prefer `summary`
 * detail, ask before requesting `full`" and never once named the parameter that does it,
 * on a tool whose entire second half is message text. And a value outside the enum was
 * ignored silently: on a record whose text is sixteen characters, the default, the right
 * value and a misspelling all but one returned a record with no `content` field — which
 * is the exact shape of "this session said nothing".
 *
 * So this file pins two things. That the Skill names the parameter, the enum, and what a
 * guess costs. And that an unrecognised value says so in the reply, because an argument
 * silently dropped is indistinguishable from one that was honoured.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { TOOLS } from '../server/mcp.mjs';
import { readFile } from 'node:fs/promises';

const NOW = 1_700_000_000_000;
const TEXT = '先同步本地与远程的这个分支的代码';

/** One session, one user record whose text is the whole point of the case. */
async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'detail-level-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-d', title: 'Detail', updatedAtMs: NOW });
  projection.row({
    sessionId: 'sess-d',
    msgId: 'm0',
    role: 'user',
    turnId: 'turn-0',
    createdAtMs: NOW,
    // `msg_content` is where the projection reads a record's text from — `contentLength`
    // and the `full`-level `content` are both derived from it, so any other shape makes
    // this fixture a record that genuinely said nothing.
    data: { msg_content: TEXT },
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

test('summary detail omits the message text and full detail carries it', async (t) => {
  // The contrast the Skill now states. Without it a caller cannot tell "the session said
  // nothing" from "you did not ask for the words".
  const store = await seeded(t);
  const summary = await call(store, 'trajectory_get', { sessionId: 'sess-d' });
  assert.equal(summary.detailLevel, 'summary');
  assert.equal(summary.events[0].content, undefined, 'summary detail carried message text');
  assert.ok(summary.events[0].contentLength > 0, 'the fixture record has no text to withhold');

  const full = await call(store, 'trajectory_get', { sessionId: 'sess-d', detailLevel: 'full' });
  assert.equal(full.detailLevel, 'full');
  assert.equal(typeof full.events[0].content, 'string', 'full detail carried no content');
});

test('a detail level outside the enum is ignored, and the reply says so', async (t) => {
  // The defect this exists for: the ignored value was indistinguishable from the default,
  // so a model that misspelled the parameter read a record with no `content` and could
  // conclude the session contained no words.
  const store = await seeded(t);
  for (const tool of ['trajectory_get', 'trajectory_find']) {
    for (const detailLevel of ['nope', 'FULL', 'Summary', 'detail', '']) {
      const args = { sessionId: 'sess-d', detailLevel, ...(tool === 'trajectory_find' ? { query: '分支' } : {}) };
      const reply = await call(store, tool, args);
      assert.equal(reply.detailLevel, 'summary', `${tool}(${JSON.stringify(detailLevel)}) did not fall back`);
      assert.match(reply.note ?? '', /detailLevel/u,
        `${tool}(${JSON.stringify(detailLevel)}) was ignored without saying so`);
      assert.match(reply.note ?? '', /summary/u,
        'the note must name the level actually used, not merely that something was wrong');
    }
  }
});

test('a level that was honoured carries no note', async (t) => {
  // The other direction: a note on every reply is noise, and one that fires when the
  // request was honoured teaches the reader to ignore it.
  const store = await seeded(t);
  for (const [tool, extra] of [['trajectory_get', {}], ['trajectory_find', { query: '分支' }]]) {
    for (const detailLevel of ['summary', 'full']) {
      const reply = await call(store, tool, { sessionId: 'sess-d', detailLevel, ...extra });
      assert.equal(reply.note, undefined, `${tool} noted a level it had honoured`);
    }
    const omitted = await call(store, tool, { sessionId: 'sess-d', ...extra });
    assert.equal(omitted.note, undefined, `${tool} noted a level the caller never mentioned`);
  }
});

test('the schema names the parameter on both tools that take it', () => {
  for (const name of ['trajectory_get', 'trajectory_find']) {
    const tool = TOOLS.find((entry) => entry.name === name);
    const properties = tool?.inputSchema?.properties ?? {};
    assert.deepEqual(properties.detailLevel?.enum, ['summary', 'full'],
      `${name}'s schema does not declare the two levels`);
    assert.ok(properties.detailLevel?.description, `${name}'s schema does not describe the argument`);
  }
});

test('the Skill names the parameter, its values, and what a guess costs', async () => {
  const skill = await readFile(new URL('../skills/mcode-trajectory-studio/SKILL.md', import.meta.url), 'utf8');
  // The trap this file was written for: the Skill carried a policy about `full` detail
  // and never once named the argument that requests it, on the tool whose whole second
  // half is message text.
  assert.match(skill, /`detailLevel`/u, 'the Skill never names the parameter');
  assert.match(skill, /detailLevel: 'full'/u, 'the Skill never shows how to ask for message text');
  // Both tools that take it, so the guidance is not attached to only one of them.
  //
  // Anchored on `/^\d+\. \`tool\`/m` — the bullet's *number* is not pinned. It used
  // to be (`'5. \`trajectory_find\`'`), and adding a tool renumbered the list, so
  // `indexOf` returned -1 and `slice(-1, …)` handed the assertion a span of the file
  // that had nothing to do with the tool: a guard that silently stops guarding.
  // Number-agnostic but bullet-anchored, which is also what keeps the name-based
  // failure this comment started with from coming back — `trajectory_find`'s entry
  // refers to `trajectory_get` inside itself, and a bare `indexOf(toolName)` would
  // still end inside the sentence the guidance lives in.
  const bulletHead = (tool) => new RegExp('^\\d+\\. `' + tool + '`', 'mu');
  const bullet = (tool) => {
    const start = bulletHead(tool).exec(skill);
    assert.ok(start, `the Skill has no numbered bullet for ${tool}`);
    const rest = skill.slice(start.index + start[0].length);
    const next = /^\d+\. `/mu.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  };
  assert.match(bullet('trajectory_find'), /detailLevel/u, 'the trajectory_find entry does not mention it');
  assert.match(bullet('trajectory_get'), /detailLevel/u, 'the trajectory_get entry does not mention it');
  // And the tool added after this file was written takes the same argument, so the same
  // rule covers it. A guard that only knows the tools it was written beside stops
  // saying anything about the ones added afterwards.
  assert.match(bullet('trajectory_changes'), /detailLevel/u,
    'the trajectory_changes entry does not mention it');
  // And the cost of guessing wrong, which is the part that turns a missing parameter
  // name into a wrong conclusion rather than a retry.
  assert.match(skill, /note/u, 'the Skill does not say that a wrong value is reported');
});