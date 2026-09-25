// planner.mjs
//
// Validate the selection JSON the model passes to finish_plugin_selection
// against the catalog. Pure.

import { renderMenu, loopByName, qualityByName, OPTIONAL_PLUGINS } from './catalog.mjs';

// Optional: a list of discovered plugins (with descriptions) so we can
// stamp the model-chosen plugin with its real description rather than
// a "(user plugin)" placeholder.
let _discoveredPlugins = null;
export function setDiscoveredPlugins(plugins) {
  _discoveredPlugins = Array.isArray(plugins) ? plugins : [];
}
export function getDiscoveredPlugins() {
  return _discoveredPlugins || [];
}

export function validateSelection(sel) {
  if (!sel || typeof sel !== 'object') {
    return { ok: false, error: 'selection must be an object' };
  }
  const errors = [];

  // loops: array of loop names
  const loops = Array.isArray(sel.loops) ? sel.loops : [];
  if (loops.length === 0) errors.push('loops must be a non-empty array');
  const loopDescs = [];
  for (const name of loops) {
    if (typeof name !== 'string') { errors.push(`loop entry must be a string, got ${typeof name}`); continue; }
    const meta = loopByName(name);
    if (!meta) errors.push(`unknown loop: ${name}`);
    else loopDescs.push({ name: meta.name, description: meta.description });
  }

  // quality: must match a known level
  let qualityDesc = null;
  if (typeof sel.quality !== 'string') errors.push('quality must be a string');
  else {
    const q = qualityByName(sel.quality);
    if (!q) errors.push(`unknown quality: ${sel.quality}`);
    else qualityDesc = { name: q.name, description: q.description, iterationCap: q.iterationCap, verify: q.verify };
  }

  // plugins: array of plugin names — accept ANY string. Look up the
  // description from discovered plugins first, then OPTIONAL_PLUGINS,
  // then fall back to a generic label.
  const plugins = Array.isArray(sel.plugins) ? sel.plugins : [];
  const pluginDescs = [];
  const known = new Map();
  for (const p of _discoveredPlugins || []) if (p && p.name) known.set(p.name, p);
  for (const p of OPTIONAL_PLUGINS) if (!known.has(p.name)) known.set(p.name, p);
  for (const name of plugins) {
    if (typeof name !== 'string') { errors.push(`plugin entry must be a string`); continue; }
    const meta = known.get(name);
    if (meta && meta.description) {
      pluginDescs.push({ name: meta.name, description: meta.description });
    } else if (meta) {
      pluginDescs.push({ name: meta.name, description: '(no description)' });
    } else {
      pluginDescs.push({ name, description: '(user plugin)' });
    }
  }

  // notes: optional free text
  const notes = typeof sel.notes === 'string' ? sel.notes : '';

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };

  return {
    ok: true,
    selection: {
      loops: loopDescs,
      quality: qualityDesc,
      plugins: pluginDescs,
      notes,
    },
  };
}

export function menuCharCount() {
  return renderMenu(_discoveredPlugins).length;
}
