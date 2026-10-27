/**
 * Persisted sidebar state that parses is not the same as persisted state that is a list.
 *
 * `readCollapsed` and `readExpanded` wrap `JSON.parse` in a try/catch, which covers a
 * document that does not parse at all. It does not cover one that parses into the wrong
 * shape — and `localStorage` is not this Plugin's to trust. A browser extension, an
 * older version of this panel, or a reader who poked at it can leave anything behind.
 *
 * The case that gets through is a bare JSON string:
 *
 *   localStorage['trajectory.collapsedGroups'] = '"hello"'
 *   JSON.parse('"hello"')      // 'hello'  — no throw
 *   new Set('hello')           // Set { 'h', 'e', 'l', 'o' }
 *
 * No exception, so the catch never runs. The panel comes up with a collapsed-group set
 * of single characters, which matches no group key, so every group is expanded — and the
 * next `writeCollapsed` persists `["h","e","l","o"]` back over the real state. The damage
 * is self-inflicted on first write and only a reader with devtools could undo it.
 *
 * `JSON.parse('123')` and `new Set({})` do throw, and those the catch already handles.
 * This is the one shape that is silent.
 */

import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { installPanelDom } from './panel-dom.mjs';

const WEB = new URL('../web/js/', import.meta.url);
const { state } = await import(new URL('state.js', WEB));
const storage = await import(new URL('storage.js', WEB));

let dom;

beforeEach(() => { dom = installPanelDom(); });
afterEach(() => { dom.restore(); });

const KEYS = ['trajectory.collapsedGroups', 'trajectory.expandedSessions'];

test('a persisted JSON string is not read as a set of its characters', () => {
  for (const key of KEYS) {
    globalThis.localStorage.setItem(key, '"hello"');
    storage.hydrateSidebarState();
    const set = key.endsWith('collapsedGroups') ? state.collapsed : state.expanded;
    assert.deepEqual([...set], [],
      `${key} held a JSON string, and the panel came up with ${JSON.stringify([...set])}`);
  }
});

test('a persisted number, object and null are all refused rather than half-read', () => {
  for (const raw of ['123', '{"a":1}', 'null', 'true', '[]', '["ok"]']) {
    for (const key of KEYS) {
      globalThis.localStorage.setItem(key, raw);
      storage.hydrateSidebarState();
      const set = key.endsWith('collapsedGroups') ? state.collapsed : state.expanded;
      const expected = raw === '["ok"]' ? ['ok'] : [];
      assert.deepEqual([...set], expected,
        `${key} = ${raw} produced ${JSON.stringify([...set])}, expected ${JSON.stringify(expected)}`);
    }
  }
});

test('a well-formed list keeps only its string entries', () => {
  globalThis.localStorage.setItem('trajectory.collapsedGroups', JSON.stringify(['ws:/a', 7, null, 'ws:/b']));
  storage.hydrateSidebarState();
  assert.deepEqual([...state.collapsed], ['ws:/a', 'ws:/b'],
    'the list lost its string entries or kept values that can never be a group key');
});

test('a list the reader never wrote cannot be turned into one it did', () => {
  // The self-inflicted part: without the shape check the character set above is what
  // gets written back, so the bad state survives a reload instead of being cleared.
  globalThis.localStorage.setItem('trajectory.collapsedGroups', '"hello"');
  storage.hydrateSidebarState();
  storage.writeCollapsed();
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('trajectory.collapsedGroups')), [],
    'the panel persisted the characters it misread');
});

test('unparseable and absent state both degrade to empty, as before', () => {
  for (const raw of ['{not json', '']) {
    globalThis.localStorage.setItem('trajectory.collapsedGroups', raw);
    storage.hydrateSidebarState();
    assert.deepEqual([...state.collapsed], [], `${JSON.stringify(raw)} did not degrade to an empty set`);
  }
  globalThis.localStorage.clear();
  storage.hydrateSidebarState();
  assert.deepEqual([...state.collapsed], []);
  assert.deepEqual([...state.expanded], []);
});