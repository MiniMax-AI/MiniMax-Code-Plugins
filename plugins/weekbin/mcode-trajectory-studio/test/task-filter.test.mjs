/**
 * A count and a page have to describe the same set.
 *
 * `trajectory_list` had exactly this bug once: the list and its count spelled their
 * filter out separately, a `kind` filter was added to one, and `total` went on
 * describing sessions the page would never return. The fix was one shared
 * `sessionFilter`. `trajectory_tasks` was left with the same shape — `listBackgroundTasks`
 * and `countBackgroundTasks` each built `owner_session_id = ?` plus an optional
 * `kind = ?` — and agreed only by coincidence.
 *
 * The cases below pin the agreement behaviourally for every filter the tool accepts,
 * and pin it structurally as well: a behaviour test over a fixture that happens to
 * agree today cannot tell a shared builder from two copies that match.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, FIXTURE_HOME } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';

const NOW = 1_700_000_000_000;

/** Enough rows that a page limit smaller than the set can actually trim it. */
const MIX = [
  ['bash', 'completed'],
  ['bash', 'failed'],
  ['subagent', 'completed'],
  ['subagent', 'running'],
  ['bash', 'completed'],
  ['subagent', 'failed'],
];

async function seeded(t, { sessionId = 'sess-a' } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'task-filter-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: sessionId, title: 'Alpha', updatedAtMs: NOW });
  MIX.forEach(([kind, status], index) => {
    projection.task({
      taskId: `t-${index}`,
      sessionId,
      kind,
      status,
      createdAtMs: NOW - index * 1000,
      endedAtMs: NOW - index * 1000 + 500,
      record: { description: `task ${index}`, toolCallId: `c-${index}` },
    });
  });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

/** Everything the count says exists, read with a limit no fixture can exceed. */
const all = (store, options) => store.listBackgroundTasks('sess-a', { limit: 1000, ...options });

test('the count matches the page for every filter the tool accepts', async (t) => {
  const store = await seeded(t);
  for (const options of [{}, { kind: 'bash' }, { kind: 'subagent' }, { kind: 'no-such-kind' }]) {
    const counted = store.countBackgroundTasks('sess-a', options);
    const listed = all(store, options);
    assert.equal(counted, listed.length,
      `count and page disagree for ${JSON.stringify(options)}: ${counted} vs ${listed.length}`);
  }
});

test('a kind filter narrows both by the same amount', async (t) => {
  // The control for the case above: a builder that ignored `kind` on both sides would
  // still agree with itself, so the filter has to demonstrably do something.
  const store = await seeded(t);
  const allTasks = store.countBackgroundTasks('sess-a');
  const bash = store.countBackgroundTasks('sess-a', { kind: 'bash' });
  const subagents = store.countBackgroundTasks('sess-a', { kind: 'subagent' });
  assert.equal(bash, MIX.filter(([kind]) => kind === 'bash').length);
  assert.equal(subagents, MIX.filter(([kind]) => kind === 'subagent').length);
  assert.equal(bash + subagents, allTasks, 'the kinds do not partition the set');
});

test('a paged walk delivers exactly what the count promised', async (t) => {
  // The failure this guards: `total` from one filter, `nextOffset` walking a different
  // one, so the cursor stops early or never.
  const store = await seeded(t);
  for (const options of [{}, { kind: 'bash' }]) {
    const seen = [];
    let offset = 0;
    for (;;) {
      const page = store.listBackgroundTasks('sess-a', { limit: 2, offset, ...options });
      seen.push(...page.map((task) => task.taskId));
      const counted = store.countBackgroundTasks('sess-a', options);
      if (page.length === 0 || offset + page.length >= counted) break;
      offset += page.length;
    }
    assert.equal(seen.length, store.countBackgroundTasks('sess-a', options),
      `the walk delivered ${seen.length} rows for ${JSON.stringify(options)}`);
    assert.equal(new Set(seen).size, seen.length, 'the walk repeated a task');
  }
});

test('one session\'s count says nothing about another\'s', async (t) => {
  // The other half of "the same set": `owner_session_id` is in the shared builder,
  // and a filter that lost it would count every task on the machine for every session.
  const store = await seeded(t, { sessionId: 'sess-a' });
  assert.equal(store.countBackgroundTasks('sess-b'), 0);
  assert.deepEqual(all(store).length > 0, true);
});

test('the count and the page read one filter, not two copies', async () => {
  // The structural half. A behaviour test over a fixture that agrees today cannot
  // distinguish a shared builder from two matching copies — and the drift only shows
  // up the day someone adds a filter to one of them.
  const source = await readFile(new URL('../server/tasks.mjs', import.meta.url), 'utf8');
  // No regular expression: this needs to slice one function body out of a file, and a
  // pattern written to spell that out is exactly the kind of escaping that silently
  // stops matching — which is how a structural check ends up passing nothing.
  const bodies = ['listBackgroundTasks', 'countBackgroundTasks'].map((name) => {
    const begin = source.indexOf(`export function ${name}(`);
    assert.notEqual(begin, -1, `${name} was not found in tasks.mjs`);
    return source.slice(begin, source.indexOf('\n}', begin));
  });
  for (const [name, body] of [['listBackgroundTasks', bodies[0]], ['countBackgroundTasks', bodies[1]]]) {
    assert.match(body, /\btaskFilter\(/u, `${name} no longer goes through the shared task filter`);
    assert.doesNotMatch(body, /owner_session_id/u,
      `${name} spells the session predicate out again, so the two can drift`);
  }
});