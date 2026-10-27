/**
 * Every route the panel asks for is served, and every route served is asked for.
 *
 * `/api/task-output` had been served, capability-gated, redacted, covered for
 * authorisation and egress, and reachable only from a test — for the whole life of the
 * panel. Nothing on the page called it. The summary tab showed a background tool call's
 * id and stopped there, so somebody reading the panel could see that a task failed and
 * had no way to read why, while `trajectory_task_output` answers exactly that for a model
 * in one call. On the machine this was found on, 56,000-odd background tasks had an
 * `output.log` on disk: not a corner case, the whole feature reachable from one surface
 * out of two.
 *
 * A route with no caller is not harmless. It still has to be secured, redacted and
 * maintained, and it advertises a capability the product does not actually offer.
 *
 * The real proof that the panel now reads task output is `tools/browser-check.mjs`,
 * which drives Chrome and asserts the bytes arrive. That needs a browser, so it is not
 * in the default suite. This file is the part that always runs: it does not prove the
 * button works, it proves the route has not gone back to having no caller.
 *
 * The scrape has a floor on what it found, because the failure mode of a route scrape is
 * silence. If `http.mjs` ever builds its paths some other way, both sets empty and every
 * assertion below passes against nothing — which is how a test ends up guarding a page
 * that does not exist.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(import.meta.dirname, '..');
const read = (...parts) => readFile(path.join(ROOT, ...parts), 'utf8');

/** Route literals the server compares a pathname against. */
function servedRoutes(source) {
  const routes = new Set();
  for (const match of source.matchAll(/['"`](\/api\/[A-Za-z0-9_\-/]*)['"`]/g)) routes.add(match[1]);
  // `pathname === \`/api/events${…}\`` — the literal prefix is what is readable here.
  for (const match of source.matchAll(/['"`](\/api\/[A-Za-z0-9_]+)\$\{/g)) routes.add(match[1]);
  // `/api/` on its own is the auth guard's prefix, not a route.
  routes.delete('/api/');
  return routes;
}

/** Route literals the page asks for, in either the script modules or the markup. */
async function askedRoutes() {
  const names = (await readdir(path.join(ROOT, 'web', 'js')))
    .filter((name) => name.endsWith('.js'));
  const parts = await Promise.all([
    ...names.map((name) => read('web', 'js', name)),
    read('web', 'index.html'),
  ]);
  const routes = new Set();
  for (const match of parts.join('\n').matchAll(/['"`](\/api\/[A-Za-z0-9_\-/]*)/g)) routes.add(match[1]);
  return routes;
}

async function testSources() {
  const names = (await readdir(path.join(ROOT, 'test'))).filter((name) => name.endsWith('.mjs'));
  return (await Promise.all(names.map((name) => read('test', name)))).join('\n');
}

test('no route the panel asks for is missing from the server', async () => {
  const served = servedRoutes(await read('server', 'http.mjs'));
  const asked = await askedRoutes();
  assert.ok(served.size >= 7,
    `the scrape found only ${served.size} served routes — this test would pass vacuously`);
  assert.ok(asked.size >= 5,
    `the scrape found only ${asked.size} requested routes — this test would pass vacuously`);

  const missing = [...asked].filter((route) => !served.has(route)).sort();
  assert.deepEqual(missing, [],
    `the panel asks for routes the server does not serve: ${missing.join(', ')}`);
});

test('every served route is called by the panel or covered by a test', async () => {
  const served = servedRoutes(await read('server', 'http.mjs'));
  const asked = await askedRoutes();
  const tests = await testSources();

  const orphans = [...served].filter((route) => {
    if (asked.has(route)) return false;
    // A suite may reach a route through a helper that composes the path, so the tail is
    // accepted too — and only here, where the question is "is anything looking at this".
    const tail = route.split('/').pop();
    return !(tests.includes(route) || tests.includes(tail));
  }).sort();

  assert.deepEqual(orphans, [],
    `served but nothing calls them: ${orphans.join(', ')} — a route with no caller is not a feature`);
});

test('the panel reads background-task output', async () => {
  // The narrow version of the rule above, pinned by name because it is the one that was
  // broken and because the general rule can only say "something mentions this".
  const panel = (await askedRoutes());
  assert.ok(panel.has('/api/task-output'),
    'the panel never asks for background-task output, so the route has no caller again');
});