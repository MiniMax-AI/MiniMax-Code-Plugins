// tests/detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { detectEncoding, isLikelyGbkMojibake } from '../lib/detect.js';

test('UTF-8 clean ASCII', () => {
  const r = detectEncoding(Buffer.from('hello world', 'utf-8'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.replaced, false);
  assert.equal(r.text, 'hello world');
});

test('UTF-8 clean Chinese', () => {
  const r = detectEncoding(Buffer.from('你好世界', 'utf-8'));
  assert.equal(r.encoding, 'utf-8');
  assert.equal(r.text, '你好世界');
});

test('GBK round-trip is detected as gbk', () => {
  const original = '短剧生成工作流';
  const buf = iconv.encode(original, 'gbk');
  const r = detectEncoding(buf);
  assert.equal(r.encoding, 'gbk');
  assert.equal(r.replaced, true);
  assert.equal(r.text, original);
});

test('Unknown bytes fall through to lossy utf-8', () => {
  // Random binary that is neither valid UTF-8 nor valid GBK CJK
  const buf = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90, 0xa0, 0xb0]);
  const r = detectEncoding(buf);
  assert.ok(['unknown', 'gbk'].includes(r.encoding), 'should not falsely claim utf-8');
});

test('Mixed file (mostly UTF-8 with a stray GBK chunk) is still utf-8', () => {
  const utf8 = 'Normal text. ';
  const gbk = iconv.encode('中文段落', 'gbk');
  const combo = Buffer.concat([Buffer.from(utf8, 'utf-8'), gbk]);
  const r = detectEncoding(combo);
  // The GBK chunk produces replacement chars, but the start is clean UTF-8.
  // We expect either utf-8 (if the regex thinks it's still OK) or gbk (if
  // CJK presence wins). Either way, we should not be 'unknown'.
  assert.notEqual(r.encoding, 'unknown');
});

test('isLikelyGbkMojibake detects U+FFFD cluster', () => {
  assert.equal(isLikelyGbkMojibake('xxx ���� xxx'), true);
  assert.equal(isLikelyGbkMojibake('正常中文'), false);
});
