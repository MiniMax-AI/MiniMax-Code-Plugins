// tests/classify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/classify.js';

function report(overrides = {}) {
  return {
    inputPath: 'fake',
    encoding: 'utf-8',
    convertedFromGbk: false,
    frontmatter: {},
    body: '',
    hardcodedPaths: [],
    externalCommands: [],
    warnings: [],
    ...overrides,
  };
}

test('pure-translate: clean instruction, no paths, no external tools', () => {
  const r = classify(report());
  assert.equal(r.tier, 'pure');
  assert.equal(r.subTier, 'pure-translate');
});

test('pure-wrapped-fix: has hardcoded Windows path', () => {
  const r = classify(report({
    hardcodedPaths: [{ label: 'absolute Windows user path', samples: ['C:\\Users\\Administrator\\.openclaw\\'] }],
  }));
  assert.equal(r.tier, 'pure');
  assert.equal(r.subTier, 'pure-wrapped-fix');
});

test('pure-wrapped-fix: GBK source was converted', () => {
  const r = classify(report({ encoding: 'gbk', convertedFromGbk: true }));
  assert.equal(r.subTier, 'pure-wrapped-fix');
  assert.ok(/gbk/i.test(r.reason));
});

test('wrapped-python: pip install detected', () => {
  const r = classify(report({
    externalCommands: [{ label: 'pip install', samples: ['pip install -e .'] }],
  }));
  assert.equal(r.tier, 'wrapped');
  assert.equal(r.subTier, 'wrapped-python');
});

test('wrapped-cli-anything: CLI tool detected', () => {
  const r = classify(report({
    externalCommands: [{ label: 'cli-anything CLI', samples: ['cli-anything-comfyui'] }],
  }));
  assert.equal(r.tier, 'wrapped');
  assert.equal(r.subTier, 'wrapped-cli-anything');
});

test('wrapped-service: ComfyUI reference', () => {
  const r = classify(report({
    externalCommands: [{ label: 'ComfyUI reference', samples: ['ComfyUI'] }],
  }));
  assert.equal(r.tier, 'wrapped');
  assert.equal(r.subTier, 'wrapped-service');
});

test('wrapped-http: curl detected', () => {
  const r = classify(report({
    externalCommands: [{ label: 'curl', samples: ['curl '] }],
  }));
  assert.equal(r.tier, 'wrapped');
  assert.equal(r.subTier, 'wrapped-http');
});
