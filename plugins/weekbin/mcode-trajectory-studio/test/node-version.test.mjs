import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  FTS5_NOTE,
  NODE_FLOOR_TEXT,
  VERIFIED_RANGE_TEXT,
  isNodeSupported,
  isWithinVerifiedRange,
  nodeFloorMessage,
} from '../server/node-version.mjs';
import { ftsModuleAvailable } from '../server/sqlite.mjs';

/**
 * The Node compatibility claim, and the fact that it has two thresholds.
 *
 * Measured, not assumed — the numbers below are the results of running this Plugin
 * on each release:
 *
 *   Node 22.12.0   `node:sqlite` does not exist  → the process cannot start
 *   Node 22.13.0   imports; bundled SQLite 3.47.2 has **no FTS5**
 *   Node 22.19.0   bundled SQLite 3.50.4 has FTS5
 *   Node 23.4.0    bundled SQLite 3.47.1 has **no FTS5** — FTS5 is not monotonic in
 *                  the Node version, because each release line branched from a
 *                  different dependency bump
 *   Node 24.0.0    bundled SQLite 3.49.1 has FTS5
 *
 * So the manifest has to say two things at once: a floor below which nothing runs,
 * and the range the Plugin is actually verified on — which is mcode's own `engines`
 * field, and happens to be exactly the range where FTS5 is present. Stating only
 * one of the two is how a plugin ends up claiming support it does not have.
 */

const PLUGIN = path.join(import.meta.dirname, '..');

function readJson(rel) { return JSON.parse(readFileSync(path.join(PLUGIN, rel), 'utf8')); }

test('the floor is the release where node:sqlite stops needing a flag', () => {
  assert.equal(NODE_FLOOR_TEXT, '22.13.0');
  assert.equal(isNodeSupported('22.12.0'), false);
  assert.equal(isNodeSupported('22.12.9'), false);
  assert.equal(isNodeSupported('22.13.0'), true);
  assert.equal(isNodeSupported('24.19.0'), true);
  assert.equal(isNodeSupported('v22.13.0'), true, 'a leading v must not defeat the comparison');
});

test('the verified range is exactly what mcode itself declares', () => {
  // mcode's `engines`: ">=22.19 <23 || >=24 <27".
  assert.equal(VERIFIED_RANGE_TEXT, '>=22.19 <23 || >=24 <27');
  for (const version of ['22.19.0', '22.21.1', '24.0.0', '24.19.0', '26.9.0']) {
    assert.equal(isWithinVerifiedRange(version), true, `${version} should be inside the verified range`);
  }
  for (const version of ['22.18.0', '23.0.0', '23.4.0', '23.11.0', '27.0.0']) {
    assert.equal(isWithinVerifiedRange(version), false, `${version} should be outside the verified range`);
  }
});

test('the too-old message names both the requirement and the running version', () => {
  const message = nodeFloorMessage('22.12.0');
  assert.match(message, /22\.13\.0/);
  assert.match(message, /22\.12\.0/);
  assert.match(message, /node:sqlite/);
});

test('an FTS5 claim matches what this runtime can actually do', async () => {
  // The declaration and the probe have to agree with reality on whatever Node runs
  // this suite: if the probe says FTS5 is there, creating an FTS5 table must work,
  // and vice versa. Otherwise the flag is a guess.
  const db = new DatabaseSync(':memory:');
  try {
    let creatable = true;
    try {
      db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');
    } catch {
      creatable = false;
    }
    assert.equal(ftsModuleAvailable(db), creatable, 'the probe disagrees with an actual CREATE');
    assert.equal(
      isWithinVerifiedRange(process.versions.node) || !creatable,
      true,
      `running on ${process.versions.node}, where FTS5 ${creatable ? 'works' : 'is absent'}: ` +
      'the verified range claims FTS5 is always present inside it',
    );
  } finally {
    db.close();
  }
});

test('every manifest and both READMEs state the same floor and range', async () => {
  const plugin = readJson('plugin.json');
  const claude = readJson('.claude-plugin/plugin.json');
  for (const [label, description] of [['plugin.json', plugin.description], ['.claude-plugin/plugin.json', claude.description]]) {
    assert.match(description, /22\.13/, `${label} does not state the 22.13 floor`);
    assert.match(description, /22\.19/, `${label} does not state the 22.19 verified range`);
    assert.match(description, /FTS5/, `${label} does not mention the FTS5 condition`);
  }
  for (const rel of ['README.md', 'README.zh-CN.md']) {
    const text = await readFile(path.join(PLUGIN, rel), 'utf8');
    assert.match(text, /22\.13/, `${rel} does not state the 22.13 floor`);
    assert.match(text, /22\.19/, `${rel} does not state the 22.19 verified range`);
    assert.match(text, /FTS5/, `${rel} does not mention the FTS5 condition`);
  }
  // And the note itself has to stay accurate about which lines lack FTS5.
  assert.match(FTS5_NOTE, /23\.x/);
});

test('the plugin declares no native module, which is what removes the ABI question', async () => {
  // mcode writes the projection with better-sqlite3, a native module bound to one
  // Node ABI. The Plugin must not add a second, differently-bound copy: it reads the
  // same SQLite file with the runtime's own built-in driver instead.
  const mcp = readJson('mcp.json');
  const server = mcp.mcpServers['mcode-trajectory-studio'];
  assert.deepEqual(server.args, ['./server/main.mjs']);
  assert.equal(server.command, 'node');
  const source = await readFile(path.join(PLUGIN, 'server', 'sqlite.mjs'), 'utf8');
  assert.match(source, /node:sqlite/u);
  assert.equal(/better-sqlite3|require\(['"](?!node:)/u.test(source), false, 'sqlite.mjs pulls in a third-party module');
});
