/**
 * The purpose a sub-agent was dispatched with is a searchable field, and nothing proved it.
 *
 * The `trajectory_search` description makes the strongest content-search claim this
 * Plugin has: a sub-agent's dispatch objective is in the FTS index, "so a word from it
 * matches a session whose title never mentions it". That is the difference between a tool
 * that searches metadata and one a model can point at content, and on the machine this
 * was written against **439 of 633 sessions carry a purpose** — two thirds of the corpus,
 * not an edge case.
 *
 * What tested it was `SEARCHABLE_COLUMNS.includes('purpose_terms')`. That is a claim about
 * a JavaScript array, not about the index: the column name is printed in the reply's
 * documentation, and printing it correctly is exactly what happens when the capability
 * has quietly stopped existing. Nothing in the fixture could even express the state —
 * `purpose_terms` was written as `''` for every session ever created — so a test that
 * needed a searchable objective had no way to ask for one.
 *
 * So the fixture can now set `purpose`, and this file asks the behaviour instead of the
 * array. The control matters more than the case: a search that matched every session
 * would satisfy a one-line assertion, so every case here also asserts which sessions were
 * *not* matched.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFixtureProjection, fixtureHasFts5 } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { SEARCHABLE_COLUMNS } from '../server/search.mjs';

const NOW = 1_700_000_000_000;
const FIXTURE_HOME = '/tmp/trajectory-purpose-home';

// A word that appears in no title, agent, status or workspace path below, so a match can
// only have come through the purpose column.
const NEEDLE = 'deadpath';

/**
 * Two sessions whose metadata is deliberately unremarkable, only one of them dispatched.
 *
 * The second is the control the whole file rests on: without it, a search that returned
 * everything would satisfy the first case and prove nothing.
 */
async function seeded(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-purpose-'));
  const projection = await createFixtureProjection(dataDir);
  projection.session({
    id: 'sess-dispatched',
    title: 'Untitled run',
    agent: 'worker',
    updatedAtMs: NOW,
    purpose: `local-background-task:${NEEDLE}-sweep`,
  });
  projection.session({
    id: 'sess-plain',
    title: 'Untitled run',
    agent: 'worker',
    updatedAtMs: NOW - 1000,
    purpose: '',
  });
  // Metadata that would match a generic word, so the counts below are not trivially 1.
  projection.session({ id: 'sess-other', title: `A run about ${NEEDLE}`, agent: 'worker', updatedAtMs: NOW - 2000 });
  projection.close();
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const search = (store, query) =>
  createHandler({ store, studio: null, homeDir: FIXTURE_HOME }).call('trajectory_search', { query, limit: 20 });

test('a dispatch objective is findable even when no metadata mentions it', { skip: !fixtureHasFts5() && 'no FTS5 in this build' }, async (t) => {
  const store = await seeded(t);
  const reply = await search(store, NEEDLE);

  const ids = reply.sessions.map((s) => s.sessionId);
  assert.ok(ids.includes('sess-dispatched'),
    `the dispatched session was not found; got ${JSON.stringify(ids)}`);
  // The control. A match here would mean the term reached a field it should not have, or
  // that the search returned everything — either of which makes the case above vacuous.
  assert.equal(ids.includes('sess-plain'), false,
    'a session with no purpose matched a word that is only in another session\'s purpose');
  assert.ok(ids.includes('sess-other'), 'the title match regressed');
});

test('the whole dispatch objective matches, not only its fragments', { skip: !fixtureHasFts5() && 'no FTS5 in this build' }, async (t) => {
  const store = await seeded(t);
  const reply = await search(store, 'deadpath-sweep');
  const ids = reply.sessions.map((s) => s.sessionId);

  // The runtime tokenises the objective before indexing it, so this is a phrase over the
  // tokenised form rather than over the raw string. What matters is that the whole thing
  // is reachable, not that the hyphen survives.
  assert.ok(ids.includes('sess-dispatched'),
    `the objective did not match as a whole; got ${JSON.stringify(ids)}`);
});

test('a word from the objective alone is enough', { skip: !fixtureHasFts5() && 'no FTS5 in this build' }, async (t) => {
  const store = await seeded(t);
  // The capability as the description sells it: one word out of the objective, and a
  // session whose title never mentions it comes back.
  const reply = await search(store, 'sweep');
  assert.ok(reply.sessions.map((s) => s.sessionId).includes('sess-dispatched'));
});

test('the searchable-column list still names the column this file exercises', () => {
  // Kept because it is a *different* half of the same claim, and it rots separately: the
  // capability can work while the documentation stops promising it, and nothing else here
  // would notice that the name is no longer published anywhere.
  assert.ok(SEARCHABLE_COLUMNS.includes('purpose_terms'),
    `the searchable columns are ${SEARCHABLE_COLUMNS.join(', ')} — purpose_terms is gone`);
});