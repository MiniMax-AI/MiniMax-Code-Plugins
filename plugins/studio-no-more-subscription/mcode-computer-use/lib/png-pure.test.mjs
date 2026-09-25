// Round-trip test for png-pure.mjs (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Png } from './png-pure.mjs';

test('encode then decode preserves RGBA pixels', async () => {
  const w = 32, h = 32;
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = i & 0xFF;
    data[i + 1] = (i * 7) & 0xFF;
    data[i + 2] = (i * 13) & 0xFF;
    data[i + 3] = 0xFF;
  }
  const bytes = await Png.encode({ width: w, height: h, data });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.slice(0, 8).toString('hex'),
    '89504e470d0a1a0a', 'PNG signature');
  const decoded = await Png.decode(bytes);
  assert.equal(decoded.width, w);
  assert.equal(decoded.height, h);
  assert.equal(decoded.data.length, data.length);
  assert.deepEqual(Array.from(decoded.data), Array.from(data));
});

test('encode rejects mismatched buffer length', async () => {
  await assert.rejects(async () =>
    Png.encode({ width: 10, height: 10, data: Buffer.alloc(99) }),
  /data length/);
});

test('decode rejects non-PNG data', async () => {
  await assert.rejects(async () => Png.decode(Buffer.from('not a png')),
    /signature/);
});
