/**
 * localStorage persistence for the sidebar's expansion and grouping state.
 *
 * Storage is optional: a browser with localStorage disabled must still get a
 * working panel, so every access is guarded and degrades to an empty set.
 */

import { state } from './state.js';

export function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem('trajectory.collapsedGroups') || '[]'));
  } catch {
    return new Set();
  }
}

export function writeCollapsed() {
  try {
    localStorage.setItem('trajectory.collapsedGroups', JSON.stringify([...state.collapsed]));
  } catch {
    /* storage is optional */
  }
}

export function readExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem('trajectory.expandedSessions') || '[]'));
  } catch {
    return new Set();
  }
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
