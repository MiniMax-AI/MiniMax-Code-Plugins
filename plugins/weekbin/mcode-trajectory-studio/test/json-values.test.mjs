/**
 * The tolerant value helpers every reader depends on.
 *
 * `server/json.mjs` is a leaf module with two exports and, before this file, no direct
 * test anywhere in the suite. That is not because it is unimportant: it is the seam
 * where the runtime's internal JSON columns stop being trusted. Both functions decide
 * whether a malformed row is *skipped* or whether it silently becomes a wrong number,
 * and a wrong number here is invisible by construction — a duration of `null` renders
 * as a missing measurement, not as a failed read.
 *
 * The properties pinned below are the ones the rest of the server relies on and which
 * a "helpful" rewrite would quietly break.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { num, parseJson } from '../server/json.mjs';

/* ---------------------------------------------------------------- parseJson -- */

test('a well-formed document parses to its value', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('[1,2]'), [1, 2]);
  assert.equal(parseJson('"text"'), 'text');
  assert.equal(parseJson('0'), 0);
  assert.equal(parseJson('false'), false);
});

test('a malformed row is skipped rather than raised', () => {
  // The whole point of the function: one unreadable row must not abort a read.
  assert.equal(parseJson('{not json'), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson('   '), null, 'whitespace is not a document');
});

test('a non-string is not parsed, because there is nothing to parse', () => {
  // SQLite hands back `null` for an absent JSON column and numbers for a numeric one.
  // Coercing either would invent a document the projection never stored.
  for (const value of [null, undefined, 42, 0, true, false, {}, []]) {
    assert.equal(parseJson(value), null, `${JSON.stringify(value) ?? String(value)} was parsed`);
  }
});

test('a JSON null and a failed parse are deliberately indistinguishable', () => {
  // Both answer null, and the callers rely on that: `null` means "this row carries no
  // document", which is counted and reported rather than guessed at. Pinned so a
  // future change that starts distinguishing them has to say which callers it updated.
  assert.equal(parseJson('null'), null);
  assert.equal(parseJson('null'), parseJson('not json'));
});

/* ---------------------------------------------------------------------- num -- */

test('a finite number is kept exactly, including zero and negatives', () => {
  assert.equal(num(0), 0);
  assert.equal(num(-0), -0, 'a negative zero survives rather than being normalised');
  assert.equal(num(-42), -42);
  assert.equal(num(1.5), 1.5);
  assert.equal(num(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('anything that is not a number becomes null instead of a guess', () => {
  // The dangerous alternative is `Number(value)`: a column holding "1700000000000" as
  // text, or `''`, or `null`, becomes 0 — and 0 is a real timestamp, so a row that was
  // never measured renders as having taken no time at all.
  for (const value of [null, undefined, NaN, Infinity, -Infinity, '5', '', ' ', true, {}, [], [5]]) {
    assert.equal(num(value), null, `${JSON.stringify(value) ?? String(value)} became a number`);
  }
});

test('a numeric string is not silently coerced into a measurement', () => {
  // Spelled out separately because it is the case that actually occurs: SQLite is
  // typed per-value, so a column read through `json_extract` can hand back TEXT.
  assert.equal(num('1700000000000'), null);
  assert.equal(Number('1700000000000'), 1700000000000, 'the coercion this refuses, for contrast');
});

test('the two helpers compose the way the readers use them', () => {
  // Every reader does this pair: take the column, parse it, then read a field out of it.
  const row = parseJson('{"timestamp":"nope","tokens":12}');
  assert.equal(num(row.timestamp), null, 'a string timestamp did not become a measurement');
  assert.equal(num(row.tokens), 12);

  assert.equal(parseJson('not json')?.timestamp, undefined);
  assert.equal(num(null?.timestamp), null, 'a missing row did not raise');
});
