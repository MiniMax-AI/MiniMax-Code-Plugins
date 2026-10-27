/**
 * Every id the panel writes to has to exist in the page that ships it.
 *
 * The DOM harness creates elements on demand, which is what keeps a test from having
 * to declare the whole document — and which quietly removes the only thing that would
 * notice a missing one. `el('session-truncation')` on a page with no such element is
 * `null` in the harness and a `TypeError` in the browser, so a rename in `index.html`
 * leaves every panel test green and the panel itself blank.
 *
 * The asymmetry is worth naming: a test that fails because the stub was too thin is
 * noise, and the harness was built to avoid producing it. A test that passes because
 * the stub invented the element it was checking is worse — it reports coverage of a
 * page that does not exist. This one reads the shipped HTML, so it can tell.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const WEB = path.join(import.meta.dirname, '..', 'web');

const html = () => readFile(path.join(WEB, 'index.html'), 'utf8');
const jsFiles = async () => (await readdir(path.join(WEB, 'js')))
  .filter((name) => name.endsWith('.js'))
  .map((name) => path.join(WEB, 'js', name));

/** `el('name')` and `el("name")` — the only way the panel reaches a document element. */
function requestedIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/\bel\(\s*['"]([a-z][\w-]*)['"]\s*\)/gu)) ids.add(match[1]);
  return ids;
}

/**
 * Ids the panel builds itself, e.g. the "load more" button it appends on every page.
 *
 * The sweep found `stream-more` on its first run and it is not a defect — the panel
 * creates that node and reaches it through `?.remove()` precisely because it may not be
 * there yet. So the contract is "declared in the page or created by the panel", and an
 * id that is neither is the one that crashes a browser and passes a harness.
 */
function createdIds(source) {
  const ids = new Set();
  for (const match of source.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/gu)) ids.add(match[1]);
  return ids;
}

test('every id the panel asks for is declared in index.html or built by the panel', async () => {
  const declared = new Set([...(await html()).matchAll(/\bid="([\w-]+)"/gu)].map((match) => match[1]));
  assert.ok(declared.size > 10, 'the id scrape found almost nothing — this test would pass vacuously');

  const built = new Set();
  const sources = [];
  for (const file of await jsFiles()) {
    const source = await readFile(file, 'utf8');
    sources.push([path.basename(file), source]);
    for (const id of createdIds(source)) built.add(id);
  }

  const missing = [];
  for (const [name, source] of sources) {
    for (const id of requestedIds(source)) {
      if (!declared.has(id) && !built.has(id)) missing.push(`${name} → ${id}`);
    }
  }
  assert.deepEqual(missing, [],
    `the panel writes to ids neither index.html nor the panel itself provides: ${missing.join(', ')}`);
});

test('the truncation notice the sidebar writes to is declared and hidden by default', async () => {
  // Not a generic sweep: this is the element the sidebar's slice-of-the-machine
  // disclosure lives in, and it has to start hidden or every panel load claims the
  // list is short before the list has been fetched.
  const source = await html();
  assert.match(source, /<p[^>]*\bid="session-truncation"[^>]*\bhidden\b/u,
    'the truncation notice is missing from index.html, or ships visible');
});

test('the harness would have invented any missing id, which is the point of this file', async () => {
  // The control for the sweep above. If this stops holding — if the harness starts
  // refusing unknown ids — then the sweep has started proving something the behavioural
  // tests already prove, and it can go.
  const { installPanelDom } = await import('./panel-dom.mjs');
  const dom = installPanelDom();
  try {
    assert.ok(dom.el('an-id-that-is-in-no-page'), 'the harness no longer invents unknown ids');
  } finally {
    dom.restore();
  }
});
