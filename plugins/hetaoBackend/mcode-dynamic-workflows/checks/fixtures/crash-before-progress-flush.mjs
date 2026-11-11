import { Store } from '../../src/store.mjs';
import { Engine } from '../../src/engine.mjs';
import { createToolHandler } from '../../src/tools.mjs';

const store = new Store(process.argv[2]);
const engine = new Engine(store, { workspace: process.argv[2] });
store.save({ id: 'crash-run', requestId: 'crash-run', requestHash: 'h', status: 'running', phases: [], script: 'return 1;', input: {}, executor: 'demo', workspace: process.argv[2] });
engine.emitEvent('crash-run', 'run.created');
engine.emitEvent('crash-run', 'step.progress', { stepId: 'a' });
// The parent kills this process with an acknowledged, still-memory-only cursor.
clearTimeout(store.volatileTimer);
const result = await createToolHandler(engine, () => '')('workflow_wait', {
  runId: 'crash-run', afterSequence: 1, timeoutMs: 0,
});
process.send({ result, persisted: store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n });
setInterval(() => {}, 1000);
