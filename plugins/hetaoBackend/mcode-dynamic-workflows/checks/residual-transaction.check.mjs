import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';

async function temporary(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'wf-residual-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

// Failures are injected only at db.exec so the code under test runs against a
// real node:sqlite connection: BEGIN/ROLLBACK/COMMIT still reach SQLite normally
// except for the chosen statement, which is what an IO fault on commit looks like.
function breakTransactionControl(store, { commit = true, rollback = true } = {}) {
  const exec = store.db.exec.bind(store.db);
  store.db.exec = sql => {
    if (sql === 'COMMIT' && commit) throw new Error('injected commit failure');
    if (sql === 'ROLLBACK' && rollback) throw new Error('injected rollback failure');
    return exec(sql);
  };
  return exec;
}

const run = (status, extra = {}) => ({ id: 'r', requestId: 'r', requestHash: 'h', status, ...extra });

test('acknowledged run save survives a residual transaction, recovery and reopen', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    let exec;
    try {
      store.save(run('running'));
      store.event('r', 'run.created');
      store.event('r', 'step.progress', { message: 'progress' });
      exec = breakTransactionControl(store);
      assert.throws(() => store.flushVolatile(), /injected commit failure/);
      assert.equal(store.db.isTransaction, true, 'precondition: transaction still open');

      // While the fault is live nothing may claim durability: writes must either
      // recover first or refuse, and reads must not expose the open transaction.
      assert.throws(() => store.save(run('running', { marker: 'during-fault' })), /残留事务无法回滚/);
      assert.throws(() => store.saveStep('r', { id: 's', kind: 'agent' }), /残留事务无法回滚/);
      assert.throws(() => store.saveSetting('during-fault', true), /残留事务无法回滚/);
      assert.throws(() => store.saveTemplate({ id: 't', name: 't' }), /残留事务无法回滚/);
      assert.throws(() => store.events('r'), /残留事务无法回滚/);

      // Faults clear: the first operation recovers the connection by rolling the
      // leftover transaction back, and the row it had acknowledged survives.
      store.db.exec = exec;
      assert.doesNotThrow(() => store.recover('测试'));
      assert.equal(store.db.isTransaction, false);
      store.save(run('completed'));
      assert.equal(store.get('r').status, 'completed');
      store.event('r', 'run.finished');
      assert.doesNotThrow(() => store.close());

      const reopened = new Store(dir);
      try {
        assert.equal(reopened.get('r').status, 'completed', 'acknowledged save survived recovery + reopen');
        assert.equal(reopened.setting('during-fault'), undefined, 'refused writes left nothing behind');
        const events = reopened.events('r');
        assert.deepEqual(events.map(e => e.seq), [...new Set(events.map(e => e.seq))], 'no duplicate seq');
        assert.equal(events.at(-1).type, 'run.finished');
        assert.equal(reopened.verifyIntegrity().events.verified, true);
      } finally { reopened.close(); }
    } finally { store.db.exec = exec; if (store.db.isOpen !== false) { try { store.close(); } catch {} } }
  });
});

test('event reads during a fault never show duplicate or uncommitted sequence numbers', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    let exec;
    try {
      store.event('r', 'run.created');
      store.event('r', 'step.progress');
      exec = breakTransactionControl(store);
      assert.throws(() => store.flushVolatile(), /injected commit failure/);
      assert.equal(store.db.isTransaction, true);
      // The uncommitted transaction still holds the progress row on this
      // connection; reading it would publish [1,2,2] and lose the queued retry.
      assert.throws(() => store.events('r'), /残留事务无法回滚/);

      store.db.exec = exec;
      const events = store.events('r');
      assert.deepEqual(events.map(e => e.seq), [1, 2], 'recovered read shows each seq once');
      assert.deepEqual(events.map(e => e.seq), [...new Set(events.map(e => e.seq))]);
      assert.equal(store.volatileBuffer.length, 1, 'uncommitted row stays queued for retry');
    } finally { store.db.exec = exec; try { store.close(); } catch {} }
  });
});

test('save/saveStep/saveSetting recover first and only then report success', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    let exec;
    try {
      store.event('r', 'run.created');
      exec = breakTransactionControl(store);
      assert.throws(() => store.event('r', 'run.finished'), /injected commit failure/);
      assert.equal(store.db.isTransaction, true, 'precondition: both COMMIT and ROLLBACK failed');

      // ROLLBACK still broken: every plain write is refused rather than joining
      // the doomed transaction and returning a success it cannot honour.
      assert.throws(() => store.save(run('succeeded')), /残留事务无法回滚/);
      store.db.exec = sql => { if (sql === 'ROLLBACK') throw new Error('injected rollback failure'); return exec(sql); };
      assert.throws(() => store.saveStep('r', { id: 's', kind: 'agent' }), /残留事务无法回滚/);
      assert.throws(() => store.saveSetting('k', 1), /残留事务无法回滚/);
      assert.throws(() => store.verifyIntegrity(), /残留事务无法回滚/);

      // ROLLBACK restored: the same writes now recover and genuinely persist.
      store.db.exec = exec;
      store.save(run('succeeded'));
      store.saveStep('r', { id: 's', kind: 'agent' });
      store.saveSetting('k', 1);
      assert.equal(store.db.isTransaction, false);
      assert.equal(store.get('r').status, 'succeeded');
      assert.equal(store.step('r', 's').kind, 'agent');
      assert.equal(store.setting('k'), 1);
      assert.equal(store.verifyIntegrity().events.verified, true);
    } finally { store.db.exec = exec; try { store.close(); } catch {} }
  });
});

test('engine keeps run status and the finish event consistent across a residual transaction', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    const engine = new Engine(store, { workspace: dir });
    let exec;
    try {
      store.save(run('running'));
      store.event('r', 'run.created');
      store.event('r', 'step.progress', { message: 'progress' });
      exec = breakTransactionControl(store);
      assert.throws(() => store.flushVolatile(), /injected commit failure/);
      assert.equal(store.db.isTransaction, true, 'precondition: transaction left open');

      // The real engine ordering: save node, save run, then emit run.finished.
      // With ROLLBACK still broken the run save must be refused, not acknowledged.
      assert.throws(() => store.saveStep('r', { id: 's', kind: 'agent', status: 'succeeded' }), /残留事务无法回滚/);
      assert.throws(() => store.save(run('succeeded')), /残留事务无法回滚/);

      store.db.exec = exec;
      const finished = { ...store.get('r'), status: 'succeeded' };
      store.saveStep('r', { id: 's', kind: 'agent', status: 'succeeded' });
      engine.save(finished);
      engine.emitEvent('r', 'run.finished', { status: 'succeeded' });
      assert.equal(store.get('r').status, 'succeeded');
      assert.doesNotThrow(() => store.close());

      const reopened = new Store(dir);
      try {
        assert.equal(reopened.get('r').status, 'succeeded', 'status did not revert to running');
        const events = reopened.events('r');
        assert.deepEqual(events.map(e => e.seq), [...new Set(events.map(e => e.seq))]);
        assert.equal(events.at(-1).type, 'run.finished');
        assert.equal(reopened.step('r', 's').status, 'succeeded');
        assert.equal(reopened.verifyIntegrity().events.verified, true);
      } finally { reopened.close(); }
    } finally { store.db.exec = exec; await engine.close().catch(() => {}); try { store.close(); } catch {} }
  });
});

test('periodic flush failure keeps the batch and close reports it instead of losing it', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    let exec;
    try {
      store.event('r', 'run.created');
      const progress = store.event('r', 'step.progress');
      exec = breakTransactionControl(store);
      // The scheduled flush swallows its own error, so the batch must survive it
      // in the buffer instead of being dropped by a later rollback.
      assert.throws(() => store.flushVolatile(), /injected commit failure/);
      assert.equal(store.db.isTransaction, true);
      assert.deepEqual(store.volatileBuffer.map(i => i.body.seq), [progress.seq], 'periodic batch stays queued');

      // Explicit close during the fault must surface the problem, and must not
      // let db.close() silently discard the open transaction. The residual
      // transaction is still open here, so recovery fails and shutdown reports
      // it instead of dropping the queued batch without a word.
      assert.throws(() => store.close(), error => {
        assert.equal(error.constructor, AggregateError);
        assert.ok(error.errors.length >= 1);
        return error.errors.every(e => /残留事务无法回滚/.test(e.message));
      });
      assert.equal(store.fd, undefined, 'owner lock released even under fault');
      await assert.rejects(access(join(dir, 'owner.lock')), { code: 'ENOENT' });

      store.db.exec = exec;
      const reopened = new Store(dir);
      try {
        assert.ok(reopened.event('r', 'run.finished').seq > progress.seq, 'a new Store acquires the lock');
        assert.equal(reopened.verifyIntegrity().events.verified, true);
      } finally { reopened.close(); }
    } finally { store.db.exec = exec; try { store.close(); } catch {} }
  });
});

test('durability mode, sequence leasing and batch throughput are unchanged', async () => {
  await temporary(async dir => {
    const store = new Store(dir);
    try {
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2, 'FULL synchronous preserved');
      assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
      store.save(run('running'));
      store.saveRepairCandidate('r', { id: 'a', kind: 'agent' });
      store.event('r', 'run.created');
      for (let seq = 2; seq <= 151; seq++) assert.equal(store.event('r', 'step.progress').seq, seq);
      store.flushVolatile();
      assert.equal(store.volatileBuffer.length, 0);
      assert.equal(store.setting('event_sequence_lease'), 1024, 'leasing intact');
      assert.deepEqual(store.events('r').map(e => e.seq).slice(0, 4), [1, 2, 3, 4]);
      assert.equal(store.verifyIntegrity().events.verified, true);
      assert.equal(store.verifyIntegrity().repair.verified, true);
      assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    } finally { store.close(); }
  });
});
