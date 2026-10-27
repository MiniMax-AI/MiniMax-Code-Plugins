/**
 * The number the panel tells the reader it is showing.
 *
 * `payload.bytes` is the size of the file on disk; the read is bounded by `maxBytes`.
 * The panel used to print the first as the second, so on a real 50791-byte task it
 * announced 「仅显示末尾 50791 字节」 while the text on screen was the last 16384 — the
 * reader was told three times more was there than there was, and the number carried
 * nothing that would let them check it. A bounded read whose bound is not stated is not
 * a finding, it is a decoration on a string.
 *
 * This is a rendering test rather than a shape test. The sentence is what the reader is
 * asked to trust, and the defect lived in the sentence, so asserting on the source text
 * would have pinned the syntax and missed the number.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { taskOutputBlock } from '../web/js/inspector.js';

test('a truncated read says how much it showed, not how big the file is', () => {
  // The file is three times the limit. The shown count has to be the limit.
  const shown = taskOutputBlock({ available: true, truncated: true, bytes: 200000, text: 'TAIL' }, 65536);
  assert.match(shown, /仅显示末尾 65536 字节/, `the bounded count is missing: ${shown}`);
  assert.match(shown, /共 200000/, `the file size should still be stated: ${shown}`);
  assert.ok(!/仅显示末尾 200000 字节/u.test(shown), 'the file size was printed as the shown count');
});

test('the shown count follows the limit that was asked for, not a constant', () => {
  // A second limit, so a fix that hardcoded 65536 would still pass the case above.
  const sixteen = taskOutputBlock({ available: true, truncated: true, bytes: 65536, text: 'TAIL' }, 16384);
  assert.match(sixteen, /仅显示末尾 16384 字节/u, sixteen);
  assert.ok(!/仅显示末尾 65536 字节/u.test(sixteen), 'the previous limit leaked into the count');
});

test('a whole file is not labelled as a tail', () => {
  const whole = taskOutputBlock({ available: true, truncated: false, bytes: 50791, text: 'WHOLE' }, 65536);
  assert.equal(whole, 'WHOLE', 'an untruncated read grew a truncation notice');
});

test('a task with no captured output says so once, plainly', () => {
  const none = taskOutputBlock({ available: false, bytes: 0, truncated: false, text: '' }, 65536);
  assert.equal(none, '该任务没有捕获输出。');
  assert.ok(!/字节/u.test(none), 'a byte count was printed for a read that returned nothing');
});