// compact.mjs
//
// Selection persistence at ${PLUGIN_DATA}/selections/<id>.json. Each
// selection stores:
//   - the chosen loop names + their one-line descriptions
//   - the chosen quality level + description + iteration cap + verify flag
//   - the chosen plugin names + descriptions
//   - the user's free-text notes
//   - a timestamp and the original menu char count for audit
//
// recall_selection reads the same file back so the model can re-inject
// the original menu + the chosen items.

import { mkdir, writeFile, rename, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

function shortId() {
  return randomBytes(4).toString('hex'); // 8 hex chars; collisions negligible per session
}

export async function saveSelection(pluginData, selection, menuChars) {
  await mkdir(join(pluginData, 'selections'), { recursive: true });
  const id = `sel_${shortId()}`;
  const record = {
    context_compacted_id: id,
    savedAt: new Date().toISOString(),
    replacedChars: menuChars,
    selection,
  };
  const path = join(pluginData, 'selections', `${id}.json`);
  const staged = path + '.staging';
  await writeFile(staged, JSON.stringify(record, null, 2), 'utf8');
  await rename(staged, path);
  return record;
}

export async function readSelection(pluginData, id) {
  // Sanitize: only allow short hex ids.
  if (!/^sel_[0-9a-f]{4,32}$/.test(id)) return null;
  const path = join(pluginData, 'selections', `${id}.json`);
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function listSelections(pluginData) {
  const dir = join(pluginData, 'selections');
  try {
    const names = await readdir(dir);
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const text = await readFile(join(dir, name), 'utf8');
        const j = JSON.parse(text);
        out.push({ context_compacted_id: j.context_compacted_id, savedAt: j.savedAt });
      } catch {}
    }
    return out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch {
    return [];
  }
}
