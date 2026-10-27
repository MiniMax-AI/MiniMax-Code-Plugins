/**
 * The one cross-platform claim this Plugin makes about the browser check.
 *
 * `tools/browser-check.mjs` drives a real Chrome over DevTools. It used to name one
 * binary — `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` — so it could
 * not run on the other two platforms the suite itself runs on, and it reported that as
 * an exit 1: the same code a reader gets when the panel is broken. The CI workflow notes
 * in a comment that the browser half stays out of CI, but a file that quietly cannot run
 * elsewhere is not the same as a check being deliberately manual, because the reader of
 * the file cannot tell those apart.
 *
 * Asserting this from a macOS machine is the whole point of taking the platform as a
 * parameter: a cross-platform claim can only be checked where one platform cannot
 * otherwise see it. What is pinned here is the *shape* each platform is asked for — a
 * POSIX absolute path, a `.exe` under a drive-lettered Program Files, an override that
 * replaces rather than extends — because a list that quietly degrades to empty is the
 * failure mode, and empty is what "ran, found nothing" also looks like.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromeCandidates, findChrome } from '../tools/chrome-paths.mjs';

test('each platform is asked for its own browsers', () => {
  const mac = chromeCandidates('darwin', {});
  assert.ok(mac.length > 0, 'darwin was left with nothing to look for');
  assert.ok(mac.some((p) => p.endsWith('.app/Contents/MacOS/Google Chrome')),
    'darwin no longer asks for the Chrome that ships on macOS');

  const linux = chromeCandidates('linux', {});
  assert.ok(linux.length > 0, 'linux was left with nothing to look for');
  assert.ok(linux.every((p) => p.startsWith('/')),
    `a linux candidate is not an absolute POSIX path: ${JSON.stringify(linux)}`);
  assert.ok(linux.some((p) => p.includes('chromium')),
    'linux no longer asks for Chromium, which is what CI runners usually have');

  const win = chromeCandidates('win32', {});
  assert.ok(win.length > 0, 'win32 was left with nothing to look for');
  assert.ok(win.every((p) => p.toLowerCase().endsWith('.exe')),
    `a win32 candidate is not an executable: ${JSON.stringify(win)}`);
  assert.ok(win.some((p) => /^[A-Za-z]:\//u.test(p)),
    `a win32 candidate has no drive letter: ${JSON.stringify(win)}`);
  // Forward slashes on purpose: existsSync takes both on Windows, and a table that had
  // to be rewritten per platform would be a table nobody kept up to date.
  assert.ok(win.every((p) => !p.includes('\\')),
    `a win32 candidate was written with backslashes: ${JSON.stringify(win)}`);
});

test('a platform nobody thought about gets an empty list, not another platform\'s', () => {
  // Silently falling back to the macOS list on an unknown platform is the exact failure
  // this file exists to remove: a check that runs against a browser it cannot have.
  assert.deepEqual(chromeCandidates('freebsd', {}), []);
  assert.deepEqual(chromeCandidates('aix', {}), []);
});

test('CHROME_PATH replaces the list rather than extending it', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chrome-path-'));
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const binary = path.join(dir, 'my-chrome');
  await writeFile(binary, '', 'utf8');

  // Replaces: an explicit path that is not there should say so, not quietly drive a
  // different browser than the one the caller named.
  assert.deepEqual(chromeCandidates('darwin', { CHROME_PATH: '/nope/chrome' }), ['/nope/chrome']);
  assert.equal(findChrome({ platform: 'darwin', env: { CHROME_PATH: '/nope/chrome' } }).found, null);

  const found = findChrome({ platform: 'darwin', env: { CHROME_PATH: binary } });
  assert.equal(found.found, binary, 'a path that exists was not chosen');
  // The list travels with the answer so a failure can say where it looked.
  assert.deepEqual(found.candidates, [binary]);

  // Whitespace is not an instruction.
  assert.deepEqual(chromeCandidates('darwin', { CHROME_PATH: '   ' }).length > 0, true,
    'a blank override should fall back to the platform list');
});

test('the failure answer can say where it looked', () => {
  const result = findChrome({ platform: 'linux', env: {} });
  assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0);
  // On a machine that does have one of these, `found` is that path; on one that does
  // not, it is null. Both answers carry the list, so neither can be reported as a bare
  // failure with no indication of where the search stood.
  if (result.found === null) {
    assert.ok(result.candidates.length > 0, 'a null answer carried no candidates to report');
  }
});