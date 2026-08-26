import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(
  repositoryRoot,
  'examples',
  'hello-mcode-hooks',
  'io.minimax.mcode',
  'hooks',
  'scripts',
  'record.mjs',
);

function runHook(dataRoot, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, event], {
      env: { PLUGIN_DATA: dataRoot },
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Hook exited with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}

test('Hook example retains concurrent records within its storage bound', async (context) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-hooks-example-'));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const recordsRoot = path.join(dataRoot, 'events');
  await mkdir(recordsRoot);
  const activeTemporary = `${Date.now().toString().padStart(13, '0')}-00000000000000000000-00000000-0000-4000-8000-000000000000.tmp`;
  const staleTemporary = '0000000000000-00000000000000000000-00000000-0000-4000-8000-000000000001.tmp';
  await Promise.all([
    writeFile(path.join(recordsRoot, activeTemporary), '{"partial":', 'utf8'),
    writeFile(path.join(recordsRoot, staleTemporary), '{"abandoned":', 'utf8'),
  ]);

  const invocationCount = 140;
  await Promise.all(Array.from(
    { length: invocationCount },
    (_, index) => runHook(dataRoot, index % 2 === 0 ? 'pre-tool-use' : 'post-tool-use'),
  ));

  const entries = await readdir(recordsRoot);
  const records = entries.filter((entry) => entry.endsWith('.json')).sort();
  assert.equal(records.length, 128);
  assert.equal(entries.includes(activeTemporary), true);
  assert.equal(entries.includes(staleTemporary), false);
  const values = await Promise.all(records.map(async (record) => (
    JSON.parse(await readFile(path.join(recordsRoot, record), 'utf8'))
  )));
  assert.ok(values.every(({ event }) => ['pre-tool-use', 'post-tool-use'].includes(event)));
});
