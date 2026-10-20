/**
 * The egress sweep's edges.
 *
 * `redactPayload` is the boundary every outbound MCP result passes through, and the
 * module's stated property is that it can only ever *redact*. That property was one
 * branch short of true: `walk` ended in `return String(value)` for any value JSON
 * has no shape for — a function, a symbol, a bigint — and returned it **unredacted**.
 *
 * A function's source text is ordinary text and can carry a credential. A property
 * whose value was `() => ({ api_key: "…" })` came out of the sweep with the key intact.
 * It survives where a real `JSON.stringify` would not have dropped it, because the
 * branch had already converted the function into a string before anything serialised
 * the result.
 *
 * The Plugin's own data cannot reach this branch — it arrives from `JSON.parse` and
 * JSON has no function — so this is hardening rather than a live leak. It is here
 * because a boundary is a claim about *every* path through it, not the paths that
 * happen to have callers today, and the next field added to a result would not know
 * to avoid this one.
 *
 * The other half of this file is the control: the values that are legitimately
 * non-JSON must keep behaving the way a caller expects, because the fix redacts the
 * string form rather than dropping the value.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { redactPayload } from '../server/redact.mjs';

const OPTS = { maxLength: 400, maxDepth: 8, maxEntries: 100, pii: true };

/* ------------------------------------------------- the branch that leaked -- */

test('a function value is swept, not passed through as source text', () => {
  const out = JSON.stringify(redactPayload({ run: () => 'curl -H "api_key=SECRET_A" https://x', n: 1 }, OPTS));
  assert.equal(out.includes('SECRET_A'), false, `credential survived: ${out}`);
  assert.ok(out.includes('[redacted]'), 'nothing was redacted at all, so this proves nothing');
  // The branch is total: the value is still there, it is just safe now.
  assert.ok(JSON.parse(out).run, 'the key was dropped rather than swept');
});

test('a toJSON trap does not smuggle its body past the sweep', () => {
  const out = JSON.stringify(redactPayload({ toJSON: () => ({ api_key: 'SECRET_B' }), n: 1 }, OPTS));
  assert.equal(out.includes('SECRET_B'), false, `credential survived: ${out}`);
});

test('the same value nested inside the payload is swept as well', () => {
  const out = JSON.stringify(redactPayload({ a: [{ f: () => 'api_key=SECRET_C' }] }, OPTS));
  assert.equal(out.includes('SECRET_C'), false, `credential survived: ${out}`);
});

/* ------------------------------------------------------- the control group -- */

test('a bigint still becomes a readable string', () => {
  // Dropping the value instead of redacting it would have been the safer-looking fix
  // and would have silently changed every caller's shape. It stays a string.
  assert.deepEqual(redactPayload({ n: 10n }, OPTS), { n: '10' });
});

test('a symbol still becomes its description', () => {
  assert.deepEqual(redactPayload({ s: Symbol('tag') }, OPTS), { s: 'Symbol(tag)' });
});

test('ordinary JSON shapes are untouched by the change', () => {
  const input = {
    s: 'plain', n: 1, b: true, nil: null, arr: [1, 2], obj: { deep: { deeper: 'x' } },
  };
  assert.deepEqual(redactPayload(input, OPTS), input);
});

test('null and undefined still pass through without being stringified', () => {
  assert.equal(redactPayload(null, OPTS), null);
  assert.equal(redactPayload(undefined, OPTS), undefined);
  // `String(undefined)` is "undefined", so this pins the earlier branch above the fallthrough.
  assert.deepEqual(redactPayload({ u: undefined }, OPTS), { u: undefined });
});

/* ----------------------------------------- the rest of the sweep still holds -- */

test('the malformed-shape cases the sweep is asked about stay swept', () => {
  const cases = {
    'a circular reference': (() => { const o = { name: 'x' }; o.self = o; return { o }; })(),
    'a getter that returns a credential': { get p() { return 'api_key=SECRET_D'; } },
    'a sparse array': { a: [, 'api_key=SECRET_E'] },
    'a deeply nested payload': { d: Array.from({ length: 60 }, (_, i) => ({ [`l${i}`]: 'api_key=SECRET_F' })) },
    'a very wide object': Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`k${i}`, 'api_key=SECRET_G'])),
  };
  for (const [label, input] of Object.entries(cases)) {
    const out = JSON.stringify(redactPayload(input, OPTS));
    const leaked = ['SECRET_D', 'SECRET_E', 'SECRET_F', 'SECRET_G'].find((secret) => out.includes(secret));
    assert.equal(leaked, undefined, `${label} leaked ${leaked}`);
  }
});