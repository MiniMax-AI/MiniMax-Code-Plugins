// tests/analyze.test.mjs
//
// The frontmatter parser is hand-rolled to avoid the js-yaml npm dep.
// These tests pin the exact subset we support and the round-trip
// behavior of the dump.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYamlBlock, dumpYamlBlock, parseFrontmatter } from '../lib/analyze.js';

test('parseYamlBlock: simple scalars', () => {
  const fm = parseYamlBlock(`name: hello\nversion: "1.0"\nflag: true\nmissing: null\n`);
  assert.equal(fm.name, 'hello');
  assert.equal(fm.version, '1.0');
  assert.equal(fm.flag, true);
  assert.equal(fm.missing, null);
});

test('parseYamlBlock: quoted strings preserve spaces', () => {
  const fm = parseYamlBlock(`title: "Hello World"\nsub: 'a b c'\n`);
  assert.equal(fm.title, 'Hello World');
  assert.equal(fm.sub, 'a b c');
});

test('parseYamlBlock: block scalar with |', () => {
  const fm = parseYamlBlock(`body: |\n  line 1\n  line 2\n  line 3\n`);
  assert.equal(fm.body, 'line 1\nline 2\nline 3');
});

test('parseYamlBlock: one level of nested mapping', () => {
  const fm = parseYamlBlock(`metadata:\n  author: alice\n  version: "0.1.0"\ndescriptions:\n  zh-Hans: 你好\n`);
  assert.deepEqual(fm.metadata, { author: 'alice', version: '0.1.0' });
  assert.equal(fm.descriptions['zh-Hans'], '你好');
});

test('parseYamlBlock: bad indent throws', () => {
  assert.throws(
    () => parseYamlBlock(`a:\n   b: 1\n`),
    /bad indent/,
  );
});

test('parseYamlBlock: number coercion', () => {
  const fm = parseYamlBlock(`a: 42\nb: -3.14\nc: "42"\n`);
  // `42` and `-3.14` parse as numbers; `"42"` (quoted) stays a string.
  assert.equal(fm.a, 42);
  assert.equal(fm.b, -3.14);
  assert.equal(fm.c, '42');
});

test('parseFrontmatter: round-trip from SKILL.md text', () => {
  const text = `---
name: foo
description: "A test"
metadata:
  author: alice
---
# Body`;
  const { frontmatter, body, ok } = parseFrontmatter(text);
  assert.equal(ok, true);
  assert.equal(frontmatter.name, 'foo');
  assert.equal(frontmatter.description, 'A test');
  assert.equal(frontmatter.metadata.author, 'alice');
  assert.match(body, /^# Body/);
});

test('parseFrontmatter: missing frontmatter returns ok=false', () => {
  const text = '# Just a heading\n\nno frontmatter here';
  const r = parseFrontmatter(text);
  assert.equal(r.ok, false);
  assert.equal(r.frontmatter.name, undefined);
});

test('dumpYamlBlock + parseYamlBlock round-trip preserves content', () => {
  // Note: arrays are not part of the parseYamlBlock subset. We verify
  // them in dumpYamlBlock unit tests below; the round-trip here covers
  // only the shapes (scalars + one level of nested mapping) that the
  // parser supports.
  const original = {
    name: 'round-trip',
    description: 'Use this skill to round-trip.',
    descriptions: { 'zh-Hans': '回环测试' },
    metadata: { 'skill-bridge': { tier: 'pure' } },
  };
  const text = dumpYamlBlock(original);
  const parsed = parseYamlBlock(text);
  assert.equal(parsed.name, 'round-trip');
  assert.equal(parsed.description, 'Use this skill to round-trip.');
  assert.equal(parsed.descriptions['zh-Hans'], '回环测试');
  assert.equal(parsed.metadata['skill-bridge'].tier, 'pure');
});

test('dumpYamlBlock: string with newline uses block scalar', () => {
  const text = dumpYamlBlock({ body: 'line 1\nline 2' });
  assert.match(text, /^body: \|\n/m);
  assert.match(text, /  line 1\n  line 2/);
});

test('dumpYamlBlock: reserved words get quoted', () => {
  const text = dumpYamlBlock({ flag: 'true', no: 'null' });
  // 'true' / 'null' / 'yes' / 'no' / etc. must be quoted or they would
  // round-trip as their YAML-typed values, not as strings.
  assert.match(text, /flag: "true"/);
  assert.match(text, /no: "null"/);
});

test('dumpYamlBlock: leading/trailing space gets quoted', () => {
  const text = dumpYamlBlock({ x: ' hi', y: 'bye ' });
  assert.match(text, /x: " hi"/);
  assert.match(text, /y: "bye "/);
});

test('parseYamlBlock: block-style list of scalars', () => {
  const fm = parseYamlBlock(`keywords:\n  - alpha\n  - beta\n  - gamma\n`);
  assert.deepEqual(fm.keywords, ['alpha', 'beta', 'gamma']);
});

test('parseYamlBlock: flow-style list', () => {
  const fm = parseYamlBlock('tags: [a, b, c]\n');
  assert.deepEqual(fm.tags, ['a', 'b', 'c']);
});

test('parseYamlBlock: list of objects (inline mapping on the dash line)', () => {
  const fm = parseYamlBlock(`items:\n  - name: foo\n    value: 1\n  - name: bar\n    value: 2\n`);
  assert.deepEqual(fm.items, [
    { name: 'foo', value: 1 },
    { name: 'bar', value: 2 },
  ]);
});

test('parseYamlBlock: dump -> parse round-trips arrays', () => {
  // dumpYamlBlock emits list items as a block list; parseYamlBlock
  // must accept that shape. This is the round-trip the review asked
  // for, and it was broken in v0.2.0 (parser rejected the block list).
  const original = {
    name: 'rt',
    keywords: ['a', 'b', 'c'],
    authors: [
      { name: 'alice', role: 'maintainer' },
      { name: 'bob', role: 'contributor' },
    ],
  };
  const text = dumpYamlBlock(original);
  const parsed = parseYamlBlock(text);
  assert.deepEqual(parsed.keywords, original.keywords);
  assert.deepEqual(parsed.authors, original.authors);
  assert.equal(parsed.name, 'rt');
});

test('parseYamlBlock: nested object still works (regression for v0.2.0 i++ bug)', () => {
  // The earlier v0.2.0 parser had a missing-i++ bug on the nested
  // object branch that caused an infinite loop. This test fails-fast
  // by timing out (test runner) so we notice immediately if it
  // regresses.
  const fm = parseYamlBlock(`a:\n  b:\n    c: 1\n    d: 2\n  e: 3\n`);
  assert.deepEqual(fm.a, { b: { c: 1, d: 2 }, e: 3 });
});
