/**
 * A tail read whose character bound cut off the tail.
 *
 * `trajectory_task_output` answers "why did this task fail", and it answers it by
 * reading the **end** of `output.log` — `readTaskOutput` computes `start = size -
 * limit` precisely so the newest output is the part that comes back. One layer up, the
 * egress sweep bounds the text by *characters* and kept the **head** of what that tail
 * read produced.
 *
 * The two bounds disagree about which end of the string matters, and the second one
 * silently undid the first. Past 64000 characters — the MCP sweep's cap — asking for
 * *more* returned *less* of the newest output:
 *
 *   maxBytes=131072  ->  64000 chars, `truncated 1383 chars`   (end missing)
 *   maxBytes=262144  ->  64000 chars, `truncated 70554 chars`  (end missing)
 *
 * measured on a real 2,725,910-byte task log whose last line was
 * `mutations=0  survived=0  notApplied=25  mapBad=21`. That line was not in the reply
 * at 262144 bytes, and was at 16384. The tool whose whole job is the end of a failing
 * log was returning its oldest half.
 *
 * The fixture is ASCII and larger than *both* bounds, because the two only disagree
 * once the character cap is actually reached — and ASCII keeps bytes and characters
 * equal so the case cannot pass for the wrong reason.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';
import { createRequestHandler } from '../server/http.mjs';
import { redactText } from '../server/redact.mjs';
import { LIMITS } from '../server/config.mjs';

const TASK_ID = 'bg_tail_direction_fixture';
const HOME = '/tmp/trajectory-tail-home';
const CAP = 64000; // the MCP sweep's maxLength
const BYTES = LIMITS.taskOutputBytes.max;
const FINAL_LINE = 'mutations=0  survived=0  notApplied=25  mapBad=21';

/**
 * A log past both bounds, whose last line is the answer to "why did this fail".
 * 4000 lines of ~105 characters is ~420 KB, over the 262144-byte read ceiling and well
 * over the 64000-character sweep cap.
 */
async function logOverCap(t, { lines = 4000, lineLength = 90 } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-tail-'));
  await mkdir(path.join(dataDir, 'background-tasks', TASK_ID), { recursive: true });
  const body = Array.from({ length: lines },
    (_, i) => `line ${String(i).padStart(4, '0')} ${'.'.repeat(lineLength)}`).join('\n');
  const whole = `${body}\n${FINAL_LINE}\n`;
  assert.ok(whole.length > BYTES, 'the fixture must exceed the byte budget');
  assert.ok(whole.length > CAP, 'the fixture must exceed the character cap or the two bounds never disagree');
  await writeFile(path.join(dataDir, 'background-tasks', TASK_ID, 'output.log'), whole, 'utf8');
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };
  return { dataDir, store, whole, handler: createHandler({ store, studio, homeDir: HOME }) };
}

const readAt = async (handler, maxBytes) => handler.call('trajectory_task_output', { taskId: TASK_ID, maxBytes });
const MARKER = /\n… \[truncated (\d+) chars\]$/u;
const omittedOf = (text) => { const m = MARKER.exec(text); return m ? Number(m[1]) : null; };
const keptOf = (text) => { const m = MARKER.exec(text); return m ? text.slice(0, m.index) : text; };

test('the reply ends where the file ends, not where the character cap falls', async (t) => {
  const { handler } = await logOverCap(t);
  const reply = await readAt(handler, BYTES);

  assert.ok(reply.truncated, 'this fixture is longer than the byte budget, so it is a partial read');
  assert.ok(omittedOf(reply.text) > 0, 'the character cap did not fire, so this fixture is not under test');
  assert.ok(
    reply.text.includes(FINAL_LINE),
    'the last line of the file is not in the reply: the character bound kept the head of a tail read',
  );
});

test('asking for more never returns less of the newest output', async (t) => {
  const { handler } = await logOverCap(t);
  const small = await readAt(handler, 16384);
  const large = await readAt(handler, BYTES);

  // The relationship a caller is entitled to: a bigger budget is not a smaller answer.
  // Under the broken code this was false — 262144 returned fewer of the newest bytes
  // than 16384 did, because the cap was cutting the wrong end of a larger read.
  assert.ok(
    Buffer.byteLength(large.text, 'utf8') >= Buffer.byteLength(small.text, 'utf8'),
    `maxBytes=${BYTES} returned ${Buffer.byteLength(large.text, 'utf8')} bytes, `
    + `less than the ${Buffer.byteLength(small.text, 'utf8')} bytes a smaller budget returned`,
  );
  assert.ok(large.text.includes(FINAL_LINE), 'the larger budget lost the end of the file');
  assert.ok(small.text.includes(FINAL_LINE), 'and so did the smaller one');
});

test('the marker still counts every character that was dropped', async (t) => {
  const { store, handler } = await logOverCap(t);
  const reply = await readAt(handler, BYTES);
  // The pre-sweep text, from the same read the handler made — not a reconstruction, so
  // the arithmetic below compares the bound against the thing it actually bounded.
  const raw = await store.readTaskOutput(TASK_ID, { maxBytes: BYTES });

  assert.equal(keptOf(reply.text).length, CAP, 'the kept body is not exactly the character budget');
  assert.equal(omittedOf(reply.text), raw.text.length - CAP,
    'the marker no longer accounts for exactly what the bound removed');
});

test('sweeping the same text again does not shrink it further', async (t) => {
  const { handler } = await logOverCap(t);
  // The module's stated invariant: text is redacted at the source and swept again at the
  // egress boundary, so a second pass must equal the first. `keep: 'tail'` has to hold
  // it too — a tail-kept body is exactly `maxLength` long, so the second pass must see a
  // body that no longer needs cutting and leave the marker alone.
  const once = (await readAt(handler, BYTES)).text;
  assert.equal(redactText(once, { maxLength: CAP, keep: 'tail', homeDir: HOME }), once,
    'a second sweep cut into a tail-kept string');
});

test('the default direction is unchanged, so titles and snippets keep their head', async () => {
  const text = `${'a'.repeat(CAP)}\n${FINAL_LINE}`;

  const head = redactText(text, { maxLength: 100, homeDir: HOME });
  assert.ok(head.startsWith('aaaa'), 'the default stopped keeping the head of a bounded string');
  assert.ok(!head.includes(FINAL_LINE), 'the default is now a tail bound');

  const tail = redactText(text, { maxLength: 100, keep: 'tail', homeDir: HOME });
  assert.ok(tail.includes(FINAL_LINE), "keep: 'tail' did not keep the end");
  assert.ok(!tail.startsWith('a'.repeat(200)), "keep: 'tail' kept the head");
  assert.equal(redactText(tail, { maxLength: 100, keep: 'tail', homeDir: HOME }), tail,
    'tail bounding is not idempotent');
});

test('the panel route returns the end of the log', async (t) => {
  const { store } = await logOverCap(t);
  const TOKEN = 'test-token';
  const res = {
    statusCode: 200, headers: {}, body: '',
    writeHead(c) { this.statusCode = c; }, setHeader() {}, end(c) { this.body = c ?? ''; },
  };
  await createRequestHandler({
    store, homeDir: HOME, getFocus: () => null, setFocus: () => {}, getToken: () => TOKEN,
  })({
    method: 'GET',
    url: `/api/task-output?taskId=${TASK_ID}&maxBytes=${BYTES}`,
    headers: { host: '127.0.0.1:1', 'x-trajectory-token': TOKEN },
    socket: { localPort: 1, remoteAddress: '127.0.0.1' },
  }, res);

  const reply = JSON.parse(res.body);
  assert.ok(reply.text.includes(FINAL_LINE), 'the panel does not show the end of the log');

  // This route's own bound sits almost exactly on its read: `maxBytes` is clamped to
  // 262144 bytes and the sweep caps at 262144 characters, so the two agree except for
  // the `… [tail of N bytes]` line the read prepends. Before `keep: 'tail'` that margin
  // was spent in the wrong direction — the bound cut the *last* 28 characters of the
  // log, which is the end of the final line. So the omission here is small and, more
  // importantly, comes off the front: what is left is the newest output.
  const omitted = omittedOf(reply.text);
  assert.ok(omitted !== null, 'this fixture is no longer long enough to reach the sweep cap');
  assert.ok(omitted < 64, `the panel bound removed ${omitted} characters, which is more than the read's own prefix`);
  assert.ok(reply.text.endsWith(FINAL_LINE.replace(/.$/, '')) || reply.text.includes(FINAL_LINE),
    'the panel kept the head instead of the end');
});