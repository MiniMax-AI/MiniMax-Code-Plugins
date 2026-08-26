import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HOOKS_SCHEMA,
  validateHooks,
  validateMcp,
  validatePluginManifest,
  validateSkillText,
} from '../scripts/lib/validation.mjs';

test('accepts the portable Agent Plugins manifest', () => {
  const value = validatePluginManifest({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'example-plugin',
    version: '1.0.0',
  });
  assert.equal(value.name, 'example-plugin');
});

test('rejects unsupported plugin capabilities in the manifest', () => {
  assert.throws(
    () => validatePluginManifest({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'example-plugin',
      hooks: './hooks.json',
    }),
    /unknown field hooks/u,
  );
});

test('accepts a valid Skill and rejects a mismatched directory name', () => {
  const skill = '---\nname: example-skill\ndescription: Run the example when requested.\n---\n\n# Example\n';
  assert.equal(validateSkillText(skill, 'example-skill').name, 'example-skill');
  assert.throws(() => validateSkillText(skill, 'different-skill'), /must equal different-skill/u);
});

test('validates supported MCP transports and reserved environment variables', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };
  assert.deepEqual(validateMcp({ ...base, mcpServers: { docs: { type: 'streamable-http', url: 'https://example.com/mcp' } } }), ['docs']);
  assert.deepEqual(validateMcp({ ...base, mcpServers: { local: { type: 'stdio', command: './server.js' } } }), ['local']);
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { unsafe: { type: 'streamable-http', url: 'http://example.com/mcp' } } }),
    /HTTPS or loopback HTTP/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { local: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'bad' } } } }),
    /env is invalid/u,
  );
});

test('validates the MiniMax Code Hooks 0.1 client extension', () => {
  const result = validateHooks({
    $schema: HOOKS_SCHEMA,
    hooks: {
      'pre-tool-use': [{
        command: 'node',
        args: ['${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs'],
        env: { OUTPUT: '${PLUGIN_DATA}/events.jsonl' },
        cwd: '${PLUGIN_DATA}',
      }],
      'turn-end': [{ command: './io.minimax.mcode/hooks/scripts/record.mjs' }],
    },
  });

  assert.deepEqual(result, {
    events: ['pre-tool-use', 'turn-end'],
    handlerCount: 2,
  });
});

test('rejects unsupported Hook events and unsafe handler configuration', () => {
  const document = (hooks) => ({ $schema: HOOKS_SCHEMA, hooks });

  assert.throws(() => validateHooks(document({})), /at least one event/u);
  assert.throws(
    () => validateHooks(document({ Notification: [{ command: 'node' }] })),
    /unsupported event Notification/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node script.mjs' }] })),
    /single bare executable or contained \.\/ path/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: './../outside.sh' }] })),
    /single bare executable or contained \.\/ path/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: './' }] })),
    /single bare executable or contained \.\/ path/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node', args: ['ok', 1] }] })),
    /args must be strings/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node', args: ['bad\0value'] }] })),
    /args must be strings/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node', env: { plugin_root: 'bad' } }] })),
    /env is invalid/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node', cwd: '${PLUGIN_ROOT}/../outside' }] })),
    /cwd is invalid/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': [{ command: 'node', type: 'command' }] })),
    /unsupported fields/u,
  );
  assert.throws(
    () => validateHooks(document({ 'pre-tool-use': Array.from({ length: 9 }, () => ({ command: 'node' })) })),
    /at most 8 handlers/u,
  );
});

test('rejects unsupported Hooks schema versions and excessive total handlers', () => {
  assert.throws(
    () => validateHooks({
      $schema: 'https://raw.githubusercontent.com/MiniMax-AI/MiniMax-Code-Plugins/main/schemas/io.minimax.mcode/hooks/9.9.9.schema.json',
      hooks: { 'session-start': [{ command: 'node' }] },
    }),
    /unsupported \$schema/u,
  );

  const sixHandlers = Array.from({ length: 6 }, () => ({ command: 'node' }));
  assert.throws(
    () => validateHooks({
      $schema: HOOKS_SCHEMA,
      hooks: {
        'session-start': sixHandlers,
        'turn-start': sixHandlers,
        'pre-tool-use': sixHandlers,
        'post-tool-use': sixHandlers,
        'turn-end': sixHandlers,
        'session-end': sixHandlers,
      },
    }),
    /at most 32 handlers/u,
  );
});
