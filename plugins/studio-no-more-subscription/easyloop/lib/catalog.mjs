// catalog.mjs
//
// Static catalog of loops and quality levels. The plugin list passed to
// renderMenu() comes from lib/discover.mjs (CLI + filesystem scan).
// Pure data; no I/O.

import { BUILTIN_OPTIONAL } from './discover.mjs';

export const LOOPS = [
  { name: 'explore',       description: 'Read and understand unfamiliar code; return a compressed summary.' },
  { name: 'implement',     description: 'Write new code from a spec or plan.' },
  { name: 'test',          description: 'Run tests, interpret failures, fix them until green.' },
  { name: 'debug',         description: 'Diagnose a known bug, isolate root cause, patch it.' },
  { name: 'refactor',      description: 'Improve structure or clarity without changing behavior.' },
  { name: 'review',        description: 'Read code or a diff and surface concrete defects.' },
  { name: 'document',      description: 'Write or update docs, docstrings, READMEs, comments.' },
  { name: 'migrate',       description: 'Port code between frameworks, languages, or major versions.' },
  { name: 'benchmark',     description: 'Profile and optimize performance, memory, or bundle size.' },
  { name: 'security-audit',description: 'Check for known vulnerability classes and fix them.' },
  { name: 'deps-update',   description: 'Upgrade dependencies safely with tests + lockfile.' },
  { name: 'release',       description: 'Version bump, changelog, tag, publish artifacts.' },
  { name: 'chain',         description: 'Combine multiple loops in sequence (recommended for non-trivial work).' },
];

export const QUALITIES = [
  { name: 'prototype', description: 'Fast, throwaway, minimal tests, no docs.',  iterationCap: 5,  verify: false },
  { name: 'release',   description: 'Full tests, type safety, docs, error handling.', iterationCap: 25, verify: true  },
];

// Backwards-compatible default (built-in optionals). Tests that don't
// care about discovery still work without changing their imports.
export const OPTIONAL_PLUGINS = BUILTIN_OPTIONAL.map((p) => ({
  name: p.name,
  description: p.description,
}));

// Render the selection menu as plain text the model reads in the Skill
// body. Pass `plugins` from lib/discover.mjs to include every installed
// plugin's one-line description; pass `null`/`undefined` to fall back
// to the built-in optionals; pass `[]` to explicitly show "none
// discovered".
export function renderMenu(plugins) {
  // undefined/null → built-in fallback; [] → empty (caller knows there
  // are no plugins).
  const list = plugins === undefined || plugins === null
    ? BUILTIN_OPTIONAL
    : plugins;
  const builtinNames = new Set(BUILTIN_OPTIONAL.map((p) => p.name));
  const lines = [];
  lines.push('LOOP PATTERNS:');
  for (const l of LOOPS) {
    lines.push(`  ${l.name.padEnd(16)} — ${l.description}`);
  }
  lines.push('');
  lines.push('QUALITY LEVEL:');
  for (const q of QUALITIES) {
    lines.push(`  ${q.name.padEnd(16)} — ${q.description} (cap ${q.iterationCap} turns, verify=${q.verify})`);
  }
  lines.push('');
  lines.push('OPTIONAL PLUGINS (you may enable any of these for this task):');
  if (list.length === 0) {
    lines.push('  (none discovered)');
  } else {
    for (const p of list) {
      const tag = builtinNames.has(p.name) ? ' (recommended)' : '';
      const desc = (p.description && p.description.length > 0)
        ? p.description
        : '(no description provided by manifest)';
      lines.push(`  ${p.name.padEnd(28)} — ${desc}${tag}`);
    }
  }
  lines.push('');
  lines.push('PARALLELISM:');
  lines.push('  Use the Task tool (`task`/`delegate`/`spawn_agent`) with `run_in_background: true` whenever');
  lines.push('  sub-tasks are independent. Maximize parallel calls in one turn. Spawn 3–5 background scouts');
  lines.push('  at a time for multi-file exploration, then aggregate.');
  return lines.join('\n');
}

// Look up loop metadata by name.
export function loopByName(name) {
  return LOOPS.find((l) => l.name === name) || null;
}

export function qualityByName(name) {
  return QUALITIES.find((q) => q.name === name) || null;
}
