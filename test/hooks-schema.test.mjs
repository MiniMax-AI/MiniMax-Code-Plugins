import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { HOOK_EVENTS, HOOKS_SCHEMA, validateHooks } from '../scripts/lib/validation.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('published Hooks schema encodes the field-level validator contract', async () => {
  const schema = JSON.parse(await readFile(
    path.join(repositoryRoot, 'schemas', 'io.minimax.mcode', 'hooks', '0.1.0.schema.json'),
    'utf8',
  ));

  assert.equal(schema.$id, HOOKS_SCHEMA);
  assert.equal(schema.properties.$schema.const, HOOKS_SCHEMA);
  assert.deepEqual(Object.keys(schema.properties.hooks.properties), HOOK_EVENTS);
  assert.equal(schema.properties.hooks.additionalProperties, false);
  assert.equal(schema.$defs.handlers.maxItems, 8);
  assert.equal(schema.$defs.handler.additionalProperties, false);
  const commandVariants = schema.$defs.handler.properties.command.anyOf;
  for (const variant of commandVariants) {
    assert.doesNotThrow(() => new RegExp(variant.pattern, 'u'));
  }
  const cwdVariants = schema.$defs.handler.properties.cwd.anyOf;
  for (const variant of cwdVariants) {
    assert.doesNotThrow(() => new RegExp(variant.pattern, 'u'));
  }

  const matchesAny = (variants, value) => variants.some(({ pattern }) => new RegExp(pattern, 'u').test(value));
  assert.equal(matchesAny(commandVariants, 'node'), true);
  assert.equal(matchesAny(commandVariants, './scripts/record.mjs'), true);
  assert.equal(matchesAny(commandVariants, 'node script.mjs'), false);
  assert.equal(matchesAny(commandVariants, './scripts/../record.mjs'), false);
  assert.equal(matchesAny(commandVariants, 'node\0'), false);
  assert.equal(matchesAny(cwdVariants, './'), true);
  assert.equal(matchesAny(cwdVariants, '${PLUGIN_DATA}/logs'), true);
  assert.equal(matchesAny(cwdVariants, '${PLUGIN_ROOT}/../outside'), false);
  assert.equal(matchesAny(cwdVariants, '/tmp'), false);

  const argumentPattern = new RegExp(schema.$defs.handler.properties.args.items.pattern, 'u');
  assert.equal(argumentPattern.test('ordinary argument'), true);
  assert.equal(argumentPattern.test('bad\0argument'), false);
});

test('published schema and registry validator agree except for the documented aggregate limit', async () => {
  const schema = JSON.parse(await readFile(
    path.join(repositoryRoot, 'schemas', 'io.minimax.mcode', 'hooks', '0.1.0.schema.json'),
    'utf8',
  ));
  const validateSchema = new Ajv2020({ strict: true }).compile(schema);
  const document = (hooks) => ({ $schema: HOOKS_SCHEMA, hooks });
  const valid = document({
    'pre-tool-use': [{
      command: 'node',
      args: ['${PLUGIN_ROOT}/record.mjs'],
      env: { OUTPUT: '${PLUGIN_DATA}/events.jsonl' },
      cwd: '${PLUGIN_DATA}',
    }],
  });
  assert.equal(validateSchema(valid), true, JSON.stringify(validateSchema.errors));
  assert.doesNotThrow(() => validateHooks(valid));

  for (const reservedName of ['PLUGIN_ROOT', 'plugin_data']) {
    const reserved = document({ 'turn-end': [{ command: 'node', env: { [reservedName]: 'override' } }] });
    assert.equal(validateSchema(reserved), false);
    assert.throws(() => validateHooks(reserved), /env is invalid/u);
  }

  const sixHandlers = Array.from({ length: 6 }, () => ({ command: 'node' }));
  const aggregateOnly = document({
    'session-start': sixHandlers,
    'turn-start': sixHandlers,
    'pre-tool-use': sixHandlers,
    'post-tool-use': sixHandlers,
    'turn-end': sixHandlers,
    'session-end': sixHandlers,
  });
  assert.equal(validateSchema(aggregateOnly), true, 'JSON Schema cannot sum handlers across event properties');
  assert.throws(() => validateHooks(aggregateOnly), /at most 32 handlers/u);
});
