/**
 * localStorage persistence for the sidebar's expansion and grouping state.
 *
 * Storage is optional: a browser with localStorage disabled must still get a
 * working panel, so every access is guarded and degrades to an empty set.
 */

import { state } from './state.js';

/**
 * A persisted group list, or an empty set.
 *
 * The try/catch covers a document that does not parse. It does not cover one that parses
 * into the wrong shape, and `localStorage` is not this panel's to trust — an extension,
 * an older build, or a reader who poked at it can leave anything behind.
 *
 * The shape that gets past a bare catch is a JSON string: `'"hello"'` parses without
 * throwing, and `new Set('hello')` is a set of five characters rather than of five
 * group names. Nothing crashes, no group key ever matches, and the first write persists
 * `["h","e","l","o"]` back over the real state — so the panel loses the reader's sidebar
 * and keeps losing it on every reload. `JSON.parse('123')` and `new Set({})` do throw and
 * were already handled; this one is silent, which is what made it worth a check.
 */
function readSet(key) {
  let parsed;
  try {
    parsed = JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((entry) => typeof entry === 'string'));
}

function readCollapsed() {
  return readSet('trajectory.collapsedGroups');
}

export function writeCollapsed() {
  try {
    localStorage.setItem('trajectory.collapsedGroups', JSON.stringify([...state.collapsed]));
  } catch {
    /* storage is optional */
  }
}

function readExpanded() {
  return readSet('trajectory.expandedSessions');
}

export function writeExpanded() {
  try {
    localStorage.setItem('trajectory.expandedSessions', JSON.stringify([...state.expanded]));
  } catch {
    /* storage is optional */
  }
}

/** Restore the persisted sidebar state into the shared state object. */
export function hydrateSidebarState() {
  state.collapsed = readCollapsed();
  state.expanded = readExpanded();
}
