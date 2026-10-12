/**
 * The sidebar's own filtering versus the server's.
 *
 * The panel searches the FTS index on Enter and replaces `state.sessions` with the
 * answer. `visibleSessions` then filtered those rows a second time, over a narrower
 * field set than the server searches: title, session id, workspace and group label,
 * but not agent name, status, session type or purpose. So a search the server
 * answered correctly was emptied by the browser — "explore" returned 58 sessions and
 * the sidebar rendered none, because no *title* contains the word.
 *
 * These drive the real `web/js/` modules through the panel's own DOM and server
 * seams. Nothing below the network is mocked: the scenario decides what the server
 * says, and the panel decides what that means.
 */

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import {
  installPanelDom,
  installServer,
  overviewPayload,
  sessionSummary,
  snapshotState,
  eventPayload,
} from './panel-dom.mjs';

const WEB = new URL('../web/js/', import.meta.url);
const { state } = await import(new URL('state.js', WEB));
const flow = await import(new URL('flow.js', WEB));
const sidebar = await import(new URL('sidebar.js', WEB));
const { wire } = await import(new URL('wire.js', WEB));

let dom;
let server;
let restoreState;

beforeEach(() => {
  dom = installPanelDom();
  restoreState = snapshotState(state);
});

afterEach(() => {
  server?.restore();
  restoreState();
  dom.restore();
});

function baseRoutes(overrides = {}) {
  return {
    '/api/sessions': () => ({ body: { sessions: [sessionSummary('A')], total: 1 } }),
    '/api/timeline': () => ({ body: { points: [], truncated: false } }),
    '/api/overview': ({ query }) => ({ body: overviewPayload(query.id) }),
    '/api/events': ({ query }) => ({ body: eventPayload(query.id) }),
    ...overrides,
  };
}

/** Type into the box the way a person does; the Enter handler reads `state.search`. */
async function type(query) {
  dom.el('search').value = query;
  await dom.el('search').dispatch('input');
  await dom.el('search').dispatch('keydown', { key: 'Enter' });
}

const rows = () => dom.document.querySelectorAll('.session-item').length;

/* ---------------------------------------------------- the defect, reproduced -- */

test('results the server matched on a field the client cannot see stay on screen', async () => {
  // The server searches agent, status, session type and purpose. This session
  // matches "explore" only through its agent name — its title, id, workspace and
  // group label are all unrelated, which is precisely the row the sidebar used to
  // throw away.
  const hit = sessionSummary('sess-x', { agent: 'explore', title: 'Untitled', workspaceDir: '/tmp/nowhere' });
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: [hit], total: 1, searchFailed: false } }),
  }));
  wire();

  await type('explore');

  assert.equal(state.sessions.length, 1, 'the server result was not installed');
  assert.equal(rows(), 1,
    'the sidebar re-matched a server result over a narrower field set and dropped it');
});

test('several such results are all kept, not just the first', async () => {
  // One row surviving by luck is how a bug like this survives: the check passes on
  // the fixture that happens to fit. Three rows with nothing client-visible makes
  // the count meaningful.
  const hits = [
    sessionSummary('sess-a', { agent: 'explore', title: 'Untitled', workspaceDir: '/tmp/a' }),
    sessionSummary('sess-b', { agent: 'explore', title: 'Untitled', workspaceDir: '/tmp/b' }),
    sessionSummary('sess-c', { status: 'busy', title: 'Untitled', workspaceDir: '/tmp/c' }),
  ];
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: hits, total: 3, searchFailed: false } }),
  }));
  wire();

  await type('explore');

  assert.equal(rows(), 3, 'only some of the results from the server reached the screen');
});

/* --------------------------------------- the sidebar's own filtering still runs -- */

test('while browsing, the box still filters what is loaded', async () => {
  server = installServer(baseRoutes({
    '/api/sessions': () => ({
      body: {
        sessions: [
          sessionSummary('keep', { title: 'Alpha work' }),
          sessionSummary('drop', { title: 'Beta work' }),
        ],
        total: 2,
      },
    }),
  }));
  wire();
  await flow.loadSessions();
  assert.equal(rows(), 2);

  await dom.el('search').dispatch('input');
  dom.el('search').value = 'alpha';
  state.search = 'alpha';
  await dom.el('search').dispatch('input');

  assert.equal(rows(), 1, 'typing stopped filtering the browsing page');
  assert.match(dom.el('session-groups').textContent, /Alpha/u);
});

test('a mixed-case query keeps its results, because the server matches case-insensitively', async () => {
  // The defect this pins down was invisible to every other case in this file.
  // `visibleSessions` compares its marker against a lower-cased term, while the
  // Enter handler stores the query verbatim — so the two agreed only for input that
  // was already lower case. "Users" is a perfectly ordinary query: the server folds
  // case, the walkthrough through a real browser used one, and every fixture here had
  // been lower case, so the whole file passed while the panel showed "no matches"
  // over 619 results.
  const hit = sessionSummary('sess-x', { agent: 'explore', title: 'Untitled', workspaceDir: '~/nowhere' });
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: [hit], total: 1, searchFailed: false } }),
  }));
  wire();

  await type('Explore');

  assert.equal(state.searchedTerm, 'Explore', 'the submitted query is stored as typed');
  assert.equal(rows(), 1,
    'a mixed-case query lost every result to a case-sensitive marker comparison');
});

test('typing after a search filters again instead of trusting the old results', async () => {
  // `searchedTerm` marks the current list as the server's answer. Editing the box
  // must invalidate it, or the panel keeps showing results for a term that is no
  // longer on screen — the same class of defect, one step later.
  const hit = sessionSummary('sess-x', { agent: 'explore', title: 'Untitled', workspaceDir: '/tmp/a' });
  server = installServer(baseRoutes({
    '/api/sessions': () => ({ body: { sessions: [hit], total: 1 } }),
    '/api/search': () => ({ body: { sessions: [hit], total: 1, searchFailed: false } }),
  }));
  wire();

  await type('explore');
  assert.equal(rows(), 1);

  dom.el('search').value = 'nothing-matches-this';
  await dom.el('search').dispatch('input');

  assert.equal(state.searchedTerm, null, 'editing the box left the results marked as its answer');
  assert.equal(rows(), 0, 'the sidebar kept showing results for a term no longer typed');
});

test('reloading the browsing page retires the search marker', async () => {
  const hit = sessionSummary('sess-x', { agent: 'explore', title: 'Untitled', workspaceDir: '/tmp/a' });
  server = installServer(baseRoutes({
    '/api/sessions': () => ({ body: { sessions: [hit], total: 1 } }),
    '/api/search': () => ({ body: { sessions: [hit], total: 1, searchFailed: false } }),
  }));
  wire();

  await type('explore');
  assert.notEqual(state.searchedTerm, null);

  await flow.loadSessions();

  assert.equal(state.searchedTerm, null,
    'a browsing page was left marked as the answer to the last search');
});

test('a search that matches nothing leaves the loaded list alone', async () => {
  // An existing contract, kept deliberately: a failed match does not discard what
  // was already loaded. What it must also do is stop claiming those rows are the
  // answer to the term that just found nothing.
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: [], total: 0, searchFailed: false } }),
  }));
  wire();
  await flow.loadSessions();
  assert.equal(state.sessions.length, 1);

  await type('nothing-matches-this');

  assert.equal(state.sessions.length, 1, 'the loaded list was discarded');
  assert.match(dom.text('banner'), /没有匹配/u);
  assert.equal(state.searchedTerm, null,
    'the old list stayed marked as the answer to a term that matched nothing');
});

test('a search that matches nothing after a successful one retires the earlier results', async () => {
  // The scenario that actually distinguishes the two: the marker is already set when
  // the empty result arrives, so it can only end up null if the empty branch clears
  // it. A previous version of this check ran against a fresh browsing page, where
  // the marker was null before the search ran and null after — it passed with the
  // clearing line deleted.
  //
  // It passes today because `type()` fires `input` first, and that handler clears the
  // marker on every keystroke, so the empty branch's own clear is belt-and-braces.
  // It stays asserted because the branch is the only thing standing between a stale
  // marker and a programmatic search that sets the box without an `input` event.
  let attempt = 0;
  const hit = sessionSummary('sess-x', { agent: 'explore', title: 'From explore', workspaceDir: '/tmp/a' });
  server = installServer(baseRoutes({
    '/api/search': () => {
      attempt += 1;
      return attempt === 1
        ? { body: { sessions: [hit], total: 1, searchFailed: false } }
        : { body: { sessions: [], total: 0, searchFailed: false } };
    },
  }));
  wire();

  await type('explore');
  assert.equal(state.searchedTerm, 'explore', 'the first search did not mark its results');

  // Drive the second search without an `input` event, so the marker is still set when
  // the empty answer arrives — which is the state the branch has to handle.
  state.search = 'busy';
  await dom.el('search').dispatch('keydown', { key: 'Enter' });

  assert.match(dom.text('banner'), /没有匹配/u);
  assert.equal(state.searchedTerm, null,
    'the previous results stayed marked as the answer to the term that found nothing');
});

test('a search that failed does not mark anything as its answer', async () => {
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: [], total: 0, searchFailed: true } }),
  }));
  wire();
  await type('mavis');

  assert.match(dom.text('banner'), /搜索未能执行/u);
  assert.equal(state.searchedTerm, null);
});

test('an index that cannot search says so, and is not described as a failure', async () => {
  // A third empty-list shape. It reads as a failure if it is worded that way, and the
  // reader's response to a failure is to try again — which cannot help here, because
  // the cause is which fields this runtime indexes.
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: [], total: 0, searchFailed: false, searchUnsearchable: true } }),
  }));
  wire();
  await type('mavis');

  assert.match(dom.text('banner'), /索引/u);
  assert.match(dom.text('banner'), /没有执行/u);
  assert.doesNotMatch(dom.text('banner'), /搜索未能执行/u,
    'an index mismatch was worded as a failed query, which invites a pointless retry');
  assert.equal(state.searchedTerm, null);
});

/* -------------------------------------------------- the agent filter is separate -- */

test('the agent filter still applies to server results', async () => {
  // The fix must not have turned the sidebar into a pass-through: the agent
  // dropdown is a local facet the reader controls, and it composes with the search.
  // Titles differ so the surviving row is identifiable by what is rendered — the
  // session id is not shown in a row.
  const hits = [
    sessionSummary('sess-a', { agent: 'explore', title: 'From explore', workspaceDir: '/tmp/a' }),
    sessionSummary('sess-b', { agent: 'worker', title: 'From worker', workspaceDir: '/tmp/b' }),
  ];
  server = installServer(baseRoutes({
    '/api/search': () => ({ body: { sessions: hits, total: 2, searchFailed: false } }),
  }));
  wire();

  await type('explore');
  assert.equal(rows(), 2);

  state.agentFilter = 'explore';
  sidebar.renderSessions();
  assert.equal(rows(), 1, 'the agent filter stopped narrowing the results');
  assert.match(dom.el('session-groups').textContent, /From explore/u);
  assert.doesNotMatch(dom.el('session-groups').textContent, /From worker/u);
});