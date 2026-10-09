import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { createToolHandler } from '../src/tools.mjs';

async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-durability-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function failNextCommit(store) {
  const exec = store.db.exec.bind(store.db);
  let fail = true;
  store.db.exec = sql => {
    if (sql === 'COMMIT' && fail) { fail = false; throw new Error('injected commit failure'); }
    return exec(sql);
  };
}

test('kill-before-flush workflow_wait cursor is never reused after restart', { timeout: 15000 }, async () => {
  await temporary(async dir => {
    const child = fork(new URL('./fixtures/crash-before-progress-flush.mjs', import.meta.url), [dir], { silent: true });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    try {
      const [message] = await Promise.race([
        once(child, 'message'),
        exited.then(() => { throw new Error(`worker exited before cursor: ${stderr}`); }),
      ]);
      assert.equal(message.persisted, 1);
      assert.equal(message.result.events[0].type, 'step.progress');
      const cursor = message.result.nextSequence;
      child.kill('SIGKILL');
      await exited;
      const store = new Store(dir);
      const engine = new Engine(store, { workspace: dir });
      try {
        const durable = engine.emitEvent('crash-run', 'run.finished', { status: 'done' });
        const result = await createToolHandler(engine, () => '')('workflow_wait', {
          runId: 'crash-run', afterSequence: cursor, timeoutMs: 0,
        });
        assert.equal(result.events.length, 1);
        assert.equal(result.events[0].type, 'run.finished');
        assert.ok(result.nextSequence > cursor);
        assert.equal(store.verifyIntegrity().events.verified, true);
      } finally { await engine.close(); store.close(); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  });
});

test('FULL durability remains enabled for state, repair and batched event writes', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
      store.save({ id: 'r', requestId: 'r', requestHash: 'h', status: 'succeeded' });
      store.saveRepairCandidate('r', { id: 'a', kind: 'agent' });
      store.event('r', 'run.created');
      store.event('r', 'step.progress');
      store.flushVolatile();
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
      assert.equal(store.verifyIntegrity().events.verified, true);
      assert.equal(store.verifyIntegrity().repair.verified, true);
    } finally { store.close(); }
  });
});

test('failed sequence reservation publishes no cursor and can be retried', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      failNextCommit(store);
      assert.throws(() => store.event('r', 'step.progress'), /injected commit failure/);
      assert.equal(store.volatileBuffer.length, 0);
      assert.equal(store.nextEventSequence, 0);
      assert.equal(store.setting('event_sequence_lease'), undefined);
      assert.equal(store.event('r', 'step.progress').seq, 1);
    } finally { store.close(); }
  });
});

test('batch commit failure rolls back the ledger and restores ordered events for retry', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      store.event('r', 'run.created');
      const heads = store.integrityHeads();
      store.event('r', 'step.progress');
      store.event('r', 'step.progress');
      failNextCommit(store);
      assert.throws(() => store.flushVolatile(), /injected commit failure/);
      assert.deepEqual(store.integrityHeads(), heads);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
      assert.deepEqual(store.events('r').map(e => e.seq), [1, 2, 3]);
      store.event('r', 'run.finished');
      assert.deepEqual(store.events('r').map(e => e.seq), [1, 2, 3, 4]);
      assert.equal(store.verifyIntegrity().events.verified, true);
    } finally { store.close(); }
  });
});

test('close releases SQLite and owner locks even when volatile flush fails', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    store.event('r', 'run.created');
    const cursor = store.event('r', 'step.progress').seq;
    failNextCommit(store);
    assert.throws(() => store.close(), /injected commit failure/);
    assert.equal(store.volatileTimer, null);
    assert.equal(store.fd, undefined);
    assert.throws(() => store.db.prepare('SELECT 1'));
    await assert.rejects(access(join(dir, 'owner.lock')), { code: 'ENOENT' });
    assert.doesNotThrow(() => store.close());
    const reopened = new Store(dir);
    try {
      assert.ok(reopened.event('r', 'run.finished').seq > cursor);
      assert.equal(reopened.verifyIntegrity().events.verified, true);
    } finally { reopened.close(); }
  });
});

test('lease rollover keeps every progress cursor monotonic and ledger verified', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      for (let seq = 1; seq <= 2050; seq++) assert.equal(store.event('r', 'step.progress').seq, seq);
      store.flushVolatile();
      assert.equal(store.setting('event_sequence_lease'), 3072);
      assert.equal(store.verifyIntegrity().events.verified, true);
    } finally { store.close(); }
  });
});

test('outer durable transaction rollback restores a nested progress flush', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      store.event('r', 'run.created');
      const progress = store.event('r', 'step.progress');
      failNextCommit(store);
      assert.throws(() => store.transaction(() => store.event('r', 'run.finished')), /injected commit failure/);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
      assert.equal(store.volatileBuffer[0].body.seq, progress.seq);
      store.event('r', 'run.finished');
      assert.deepEqual(store.events('r').map(e => e.type), ['run.created', 'step.progress', 'run.finished']);
      assert.equal(store.verifyIntegrity().events.verified, true);
    } finally { store.close(); }
  });
});
