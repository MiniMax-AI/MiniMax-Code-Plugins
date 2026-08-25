import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  validateHooksDocument,
  validateHookEntry,
  validateMcp,
  validatePluginDirectory,
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

test('accepts a Hook entry with allowed field vocabulary and rejects reserved discriminators', () => {
  const entry = validateHookEntry({
    command: 'node',
    args: ['${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs'],
    env: { LOG: 'info' },
    cwd: '${PLUGIN_DATA}',
    matcher: 'Bash',
    timeout: 5000,
    once: false,
  }, 'hook');
  assert.equal(entry.command, 'node');
  assert.throws(() => validateHookEntry({ command: 'node', type: 'shell' }, 'hook'), /reserved internal discriminator/u);
  assert.throws(() => validateHookEntry({ command: 'node', env: { PLUGIN_ROOT: 'bad' } }, 'hook'), /reserved/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: '/etc' }, 'hook'), /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', timeout: 1 }, 'hook'), /timeout must be an integer/u);
});

test('accepts a Hooks document that targets the experimental io.minimax.mcode namespace', () => {
  const events = validateHooksDocument({
    $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json',
    hooks: {
      PreToolUse: [{ command: 'node', args: ['${PLUGIN_ROOT}/io.minimax.mcode/hooks/scripts/record.mjs'] }],
      SessionEnd: [{ command: 'node' }],
    },
  }, 'hooks.json');
  assert.deepEqual(events, ['PreToolUse', 'SessionEnd']);
  assert.throws(
    () => validateHooksDocument({ $schema: 'x', hooks: { UnknownEvent: [{ command: 'node' }] } }, 'hooks.json'),
    /not a recognized event/u,
  );
  assert.throws(
    () => validateHooksDocument({ $schema: 'x', hooks: { PreToolUse: [] } }, 'hooks.json'),
    /non-empty array/u,
  );
  assert.throws(
    () => validateHooksDocument({ hooks: { PreToolUse: [{ command: 'node' }] } }, 'hooks.json'),
    /\$schema is required/u,
  );
});

test('validatePluginDirectory picks up an io.minimax.mode hooks extension without requiring it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-ext-'));
  try {
    await writeFile(path.join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-hooks',
      version: '0.1.0',
    }));
    const skillDir = path.join(root, 'skills', 'hello-hooks');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: hello-hooks',
      'description: Verify hello-hooks loads.',
      '---',
      '',
      '# Hello',
      '',
    ].join('\n'), 'utf8');
    const hooksDir = path.join(root, 'io.minimax.mcode', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json',
      hooks: { SessionStart: [{ command: 'node' }] },
    }));
    const result = await validatePluginDirectory(root);
    assert.deepEqual(result.clientExtensions, [{ namespace: 'io.minimax.mcode', events: ['SessionStart'] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validatePluginDirectory ignores a missing hooks extension', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-none-'));
  try {
    await writeFile(path.join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-mcode',
      version: '0.1.0',
    }));
    const skillDir = path.join(root, 'skills', 'hello-mcode');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: hello-mcode',
      'description: Verify hello-mcode loads.',
      '---',
      '',
      '# Hello',
      '',
    ].join('\n'), 'utf8');
    const result = await validatePluginDirectory(root);
    assert.deepEqual(result.clientExtensions, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validatePluginDirectory rejects hooks.json with an unrecognized event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hooks-bad-'));
  try {
    await writeFile(path.join(root, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-bad',
      version: '0.1.0',
    }));
    const skillDir = path.join(root, 'skills', 'hello-bad');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: hello-bad',
      'description: Verify hello-bad loads.',
      '---',
      '',
      '# Hello',
      '',
    ].join('\n'), 'utf8');
    const hooksDir = path.join(root, 'io.minimax.mcode', 'hooks');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json',
      hooks: { Bogus: [{ command: 'node' }] },
    }));
    await assert.rejects(validatePluginDirectory(root), /not a recognized event/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
