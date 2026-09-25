// discover.mjs
//
// Discover installed plugins so the easyloop menu can present every
// plugin's description (one-liner) to the model. The model then picks
// which optional plugins to enable for the current task — including
// any custom plugins the user has installed locally.
//
// Discovery strategy (in order):
//   1. Run `mcode plugin list --json` if the CLI is on PATH.
//   2. Walk the local marketplace directory directly, reading each
//      `plugin.json` (Agent Plugins 1.0 manifest).
//   3. Fall back to an empty list (the built-in OPTIONAL_PLUGINS still
//      render in the menu).
//
// All operations are read-only and cached for the lifetime of the
// server process.

import { spawnSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// Built-in known-good plugins. These always render in the menu even
// if discovery fails, so the model sees a useful default.
export const BUILTIN_OPTIONAL = [
  { name: 'mcode-computer-use', description: 'Use when GUI interaction is required (screenshot, click, scroll, keyboard).' },
  { name: 'mcode-think-filter', description: 'Use when context is critical (always on for release quality work).' },
];

function runMcodeList() {
  try {
    const r = spawnSync('mcode', ['plugin', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function runMcodeMarketplaceList() {
  try {
    const r = spawnSync('mcode', ['plugin', 'marketplace', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const arr = JSON.parse(r.stdout);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return null;
  }
}

async function readManifest(dir) {
  try {
    const text = await readFile(join(dir, 'plugin.json'), 'utf8');
    const j = JSON.parse(text);
    if (j && typeof j.name === 'string') {
      return {
        name: j.name,
        description: typeof j.description === 'string' ? j.description : '',
        marketplaceName: 'local',
      };
    }
  } catch {}
  return null;
}

async function scanLocalDir(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry);
    try {
      const st = await stat(p);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    // Two layouts: dir/<plugin-name>/plugin.json, or dir/plugin.json directly.
    const manifest = await readManifest(p) ||
                     await readManifest(join(p, entries[0] === 'plugin.json' ? '' : ''));
    // First try p/plugin.json, then p/<subdir>/plugin.json.
    const direct = await readManifest(p);
    if (direct) {
      out.push(direct);
      continue;
    }
    // Subdirectory layout: dir/<owner>/<plugin>/plugin.json — collect all.
    let subEntries;
    try {
      subEntries = await readdir(p);
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      const sp = join(p, sub);
      try {
        const sst = await stat(sp);
        if (!sst.isDirectory()) continue;
      } catch {
        continue;
      }
      const m = await readManifest(sp);
      if (m) out.push(m);
    }
  }
  return out;
}

export async function discoverPlugins({ env = process.env } = {}) {
  // Prefer the mcode CLI when available — it knows about official plugins too.
  const fromCli = runMcodeList();
  if (fromCli && Array.isArray(fromCli.installed)) {
    return fromCli.installed
      .filter((p) => p && typeof p.name === 'string')
      .map((p) => ({
        name: p.name,
        description: typeof p.description === 'string' ? p.description : '',
        marketplaceName: typeof p.marketplaceName === 'string' ? p.marketplaceName : 'unknown',
        enabled: p.enabled !== false,
      }));
  }

  // Fallback: scan local marketplace directory.
  const mkt = runMcodeMarketplaceList();
  if (Array.isArray(mkt)) {
    const local = mkt.find((m) => m && m.kind === 'directory' && typeof m.path === 'string');
    if (local) {
      const found = await scanLocalDir(local.path);
      if (found.length > 0) return found;
    }
  }

  // Last-ditch: try PLUGIN_DATA's parent, since PLUGIN_DATA typically
  // sits under the local marketplace.
  if (env.PLUGIN_DATA) {
    const guess = dirname(env.PLUGIN_DATA);
    const found = await scanLocalDir(guess);
    if (found.length > 0) return found;
  }

  return [];
}

// Combine built-in optionals with discovered plugins. De-duplicate by
// name. The discovered plugin's description (from its plugin.json
// manifest) takes precedence when present — the manifest is the
// plugin's authoritative self-description. Falls back to the built-in
// description when discovery didn't provide one (or didn't run).
export function mergeCatalog(discovered) {
  const byName = new Map();
  for (const b of BUILTIN_OPTIONAL) byName.set(b.name, { ...b, builtin: true });
  for (const d of discovered) {
    if (!d || !d.name) continue;
    const existing = byName.get(d.name);
    if (existing) {
      // Discovered description wins if non-empty; otherwise keep built-in.
      if (d.description && d.description.length > 0) {
        existing.description = d.description;
      }
      existing.marketplaceName = d.marketplaceName || existing.marketplaceName;
      // If discovered says disabled, mark it.
      if (d.enabled === false) existing.enabled = false;
    } else {
      byName.set(d.name, { ...d, builtin: false });
    }
  }
  const out = Array.from(byName.values());
  out.sort((a, b) => {
    // Built-in first, then alphabetical.
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}
