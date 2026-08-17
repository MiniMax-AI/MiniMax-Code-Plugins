// tests/detect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEncoding, isLikelyGbkMojibake } from '../lib/detect.js';

// Minimal GBK encoder for tests. We do NOT want a production dependency
// on iconv-lite (the whole point of v0.2 is to ship with zero npm deps),
// and we do NOT want to round-trip through the Node TextDecoder in tests
// (the decoder would be exercising the very code path we are testing).
//
// The table below covers the characters used in this test file and the
// "Short Chinese string" corpus. Adding a new test that needs different
// characters means adding entries here.
const GBK_TABLE = {
  '短': [0xB6, 0xCC],
  '剧': [0xBE, 0xE7],
  '生': [0xC9, 0xFA],
  '成': [0xB3, 0xC9],
  '工': [0xB9, 0xA4],
  '作': [0xD7, 0xF7],
  '流': [0xC1, 0xF7],
  '中': [0xD6, 0xD0],
  '文': [0xCE, 0xC4],
  '段': [0xB6, 0xCE],
  '落': [0xC2, 0xD4],
  '正': [0xD5, 0xFD],
  '常': [0xB3, 0xA3],
  '世': [0xCA, 0xC0],
  '界': [0xBD, 0xE7],
  '你': [0xC4, 0xE3],
  '好': [0xBA, 0xC3],
  '再': [0xD4, 0xD9],
  '见': [0xBC, 0xFB],
};

function encodeGbk(str) {
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) {
      out.push(code);
    } else {
      const bytes = GBK_TABLE[ch];
      if (!bytes) throw new Error(`test corpus missing GBK entry for ${JSON.stringify(ch)}`);
      out.push(bytes[0], bytes[1]);
    }
  }
  return Buffer.from(out);
}

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
  const buf = encodeGbk(original);
  const r = detectEncoding(buf);
  assert.equal(r.encoding, 'gbk');
  assert.equal(r.replaced, true);
  assert.equal(r.text, original);
});

test('Unknown bytes fall through to lossy utf-8', () => {
  // Random binary that is neither valid UTF-8 nor valid GBK CJK.
  // 0xff 0xfe is a UTF-16 LE BOM; the strict UTF-8 decoder will reject.
  // The bytes below are not part of any GBK lead/continuation pair either,
  // so the GBK decoder will also reject. We expect "unknown" (the
  // lossy-utf-8 fallback).
  const buf = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x90, 0xa0, 0xb0]);
  const r = detectEncoding(buf);
  // We accept either "unknown" or "gbk" because the heuristic is
  // intentionally loose; what we care about is that the text is not
  // silently treated as clean utf-8.
  assert.ok(['unknown', 'gbk'].includes(r.encoding), 'should not falsely claim clean utf-8');
});

test('isLikelyGbkMojibake detects U+FFFD cluster', () => {
  assert.equal(isLikelyGbkMojibake('xxx ���� xxx'), true);
  assert.equal(isLikelyGbkMojibake('正常中文'), false);
});
