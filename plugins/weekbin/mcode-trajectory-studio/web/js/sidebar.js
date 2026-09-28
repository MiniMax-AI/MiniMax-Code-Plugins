/**
 * The session tree.
 *
 * Sessions group by repository (the server annotates each with a git-derived
 * `groupKey`, folding every worktree of one project together), and sub-agent
 * sessions nest recursively under the session that dispatched them. The whole row
 * toggles expansion, not just the caret.
 *
 * This module renders and announces the selection intent; it does not know who
 * performs it. That keeps the dependency one-way — `flow.js` imports this module to
 * render, and this module imports only the intent leaf.
 */

import { el, state } from './state.js';
import { fmtAge, textNode } from './format.js';
import { icon } from './icons.js';
import { writeCollapsed, writeExpanded } from './storage.js';
import { selectSession } from './intents.js';

export function visibleSessions() {
  const term = state.search.trim().toLowerCase();
  return state.sessions.filter((session) => {
    if (state.agentFilter && session.agent !== state.agentFilter) return false;
    if (!term) return true;
    return `${session.title ?? ''} ${session.sessionId} ${session.workspaceDir ?? ''} ${session.groupLabel ?? ''}`
      .toLowerCase().includes(term);
  });
}

/** Expand every ancestor of a session so the selected row is actually visible. */
export function revealAncestors(sessionId) {
  const byId = new Map(state.sessions.map((session) => [session.sessionId, session]));
  let cursor = byId.get(sessionId);
  let guard = 0;
  while (cursor?.parentSessionId && guard < 64) {
    if (!byId.has(cursor.parentSessionId)) break;
    state.expanded.add(cursor.parentSessionId);
    cursor = byId.get(cursor.parentSessionId);
    guard += 1;
  }
  writeExpanded();
}

export function renderSessions() {
  const host = el('session-groups');
  host.textContent = '';
  const rows = visibleSessions();
  if (rows.length === 0) {
    host.append(textNode('p', 'muted small', '  没有匹配的会话'));
    return;
  }

  // Sub-agents are children of the session that dispatched them. Anything whose
  // parent is filtered out (or is not loaded) is promoted to a root so it stays reachable.
  const present = new Set(rows.map((session) => session.sessionId));
  const childrenOf = new Map();
  const roots = [];
  for (const session of rows) {
    const parent = session.parentSessionId;
    if (parent && present.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(session);
    } else {
      roots.push(session);
    }
  }
  for (const list of childrenOf.values()) list.sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));

  const groups = new Map();
  for (const session of roots) {
    const key = session.groupKey ?? `path:${session.workspaceDir ?? ''}`;
    if (!groups.has(key)) {
      groups.set(key, { key, label: session.groupLabel ?? '(无工作区)', kind: session.groupKind ?? 'path', sessions: [] });
    }
    groups.get(key).sessions.push(session);
  }
  const ordered = [...groups.values()].sort(
    (a, b) => Math.max(...b.sessions.map((s) => s.updatedAtMs ?? 0)) - Math.max(...a.sessions.map((s) => s.updatedAtMs ?? 0)),
  );

  for (const group of ordered) {
    const collapsed = state.collapsed.has(group.key);
    const section = textNode('section', `ws-group${collapsed ? ' is-collapsed' : ''}`);
    const dirs = new Set();
    for (const session of rows) {
      if ((session.groupKey ?? `path:${session.workspaceDir ?? ''}`) === group.key && session.workspaceDir) dirs.add(session.workspaceDir);
    }

    const head = document.createElement('button');
    head.type = 'button';
    head.className = `ws-head ws-${group.kind}`;
    head.title = `${group.label}${dirs.size > 1 ? ` · ${dirs.size} 个工作区` : ''}\n${[...dirs].join('\n')}`;
    head.append(icon(collapsed ? 'caretRight' : 'caretDown', 'ic ws-caret'));
    head.append(icon('folder', 'ic ws-folder'));
    head.append(textNode('span', 'ws-name', group.label));
    head.append(textNode('span', 'ws-count', String(group.sessions.length)));
    head.addEventListener('click', () => {
      if (state.collapsed.has(group.key)) state.collapsed.delete(group.key);
      else state.collapsed.add(group.key);
      writeCollapsed();
      renderSessions();
    });
    section.append(head);

    if (!collapsed) {
      const list = document.createElement('ul');
      list.className = 'ws-sessions';
      const walk = (session, depth) => {
        list.append(renderSessionItem(session, depth, childrenOf));
        if (!state.expanded.has(session.sessionId)) return;
        for (const child of childrenOf.get(session.sessionId) ?? []) walk(child, depth + 1);
      };
      for (const session of group.sessions) walk(session, 0);
      section.append(list);
    }
    host.append(section);
  }
}

/** Keep the highlighted row on screen — a correct highlight you cannot see is no help. */
export function scrollSelectedIntoView() {
  const node = el('session-groups').querySelector('.session-item[aria-current="true"]');
  node?.scrollIntoView({ block: 'nearest' });
}

/**
 * One sidebar row.
 *
 * The whole row toggles expansion, not just the caret — a caret-sized target is
 * needlessly fussy. Clicking a collapsed parent selects it and opens it; clicking an
 * already-selected open parent closes it, so the same gesture never hides the row
 * you are reading.
 */
function renderSessionItem(session, depth, childrenOf) {
  const children = childrenOf.get(session.sessionId) ?? [];
  const expanded = state.expanded.has(session.sessionId);
  const isSelected = session.sessionId === state.sessionId;

  const item = document.createElement('button');
  item.type = 'button';
  item.className = `session-item${session.parentSessionId ? ' is-sub' : ''}${children.length ? ' has-children' : ''}`;
  // Indent grows 12px per level and stops growing past level 4, so a deep fan-out
  // does not push titles off the panel.
  item.style.paddingLeft = `${6 + Math.min(depth, 4) * 12}px`;
  item.style.setProperty('--d', String(Math.min(depth, 4)));
  if (isSelected) item.setAttribute('aria-current', 'true');
  item.title = [
    session.title || '(无标题)',
    `${session.agent ?? '?'} · ${session.sessionKind ?? ''}`,
    session.branch ? `分支 ${session.branch}` : null,
    session.workspaceDir,
    session.parentSessionId ? `父会话 ${session.parentSessionId}` : null,
    children.length ? `${children.length} 个子代理` : null,
    `更新于 ${fmtAge(session.updatedAtMs)}`,
    children.length ? '点击行展开 / 收起' : null,
  ].filter(Boolean).join('\n');

  if (children.length) {
    item.append(icon(expanded ? 'caretDown' : 'caretRight', 'ic s-caret'));
  } else {
    item.append(textNode('span', 's-caret-space'));
  }

  if (session.parentSessionId) item.append(textNode('span', 's-sub-dot'));
  item.append(textNode('span', 's-title', session.title || '(无标题)'));
  if (children.length) item.append(textNode('span', 's-child-count', String(children.length)));

  item.addEventListener('click', () => {
    const wasSelected = session.sessionId === state.sessionId;
    if (children.length) {
      if (expanded && wasSelected) {
        state.expanded.delete(session.sessionId);
        writeExpanded();
        renderSessions();
        return;
      }
      if (!expanded) {
        state.expanded.add(session.sessionId);
        writeExpanded();
      }
    }
    selectSession(session.sessionId);
  });

  const li = document.createElement('li');
  li.append(item);
  return li;
}
