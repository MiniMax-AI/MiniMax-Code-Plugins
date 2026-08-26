import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

test('validateHookEntry rejects unknown fields (closed schema)', () => {
  assert.throws(
    () => validateHookEntry({ command: 'node', evil: 'x' }, 'hook'),
    /not a recognized Hook field/u,
  );
  assert.throws(
    () => validateHookEntry({ command: 'node', sideChannel: true }, 'hook'),
    /not a recognized Hook field/u,
  );
});

test('validateHookEntry type-checks matcher, pattern, regex, glob, once, timeout', () => {
  assert.throws(() => validateHookEntry({ command: 'node', matcher: 123 }, 'hook'), /matcher must be a non-empty string/u);
  assert.throws(() => validateHookEntry({ command: 'node', pattern: '' }, 'hook'), /pattern must be a non-empty string/u);
  assert.throws(() => validateHookEntry({ command: 'node', regex: 'yes' }, 'hook'), /regex must be a boolean/u);
  assert.throws(() => validateHookEntry({ command: 'node', glob: 1 }, 'hook'), /glob must be a boolean/u);
  assert.throws(() => validateHookEntry({ command: 'node', once: 'yes' }, 'hook'), /once must be a boolean/u);
  assert.throws(() => validateHookEntry({ command: 'node', timeout: '30s' }, 'hook'), /timeout must be an integer/u);
  assert.throws(() => validateHookEntry({ command: 'node', timeoutMs: 1 }, 'hook'), /timeoutMs must be an integer/u);
  assert.throws(() => validateHookEntry({ command: 'node', timeoutMs: 0 }, 'hook'), /timeoutMs must be an integer/u);
});

test('validateHooksDocument rejects unknown root fields (closed schema)', () => {
  assert.throws(
    () => validateHooksDocument({
      $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json',
      hooks: { SessionStart: [{ command: 'node' }] },
      extra: true,
    }, 'hooks.json'),
    /extra is not a recognized Hook field/u,
  );
});

test('record.mjs writes state under PLUGIN_DATA even when it is outside PLUGIN_ROOT', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-e2e-'));
  const { spawn } = await import('node:child_process');
  try {
    const root = path.join(tmp, 'plugin');
    const data = path.join(tmp, 'plugin-data', 'instance-1');
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    const stateFile = path.join(data, 'state.json');
    await new Promise((resolveP, rejectP) => {
      const child = spawn(process.execPath, [script, '--event', 'SessionStart', '--state', '${PLUGIN_DATA}/state.json'], {
        env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ toolName: 'Bash', toolInput: { command: 'ls' } }));
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', rejectP);
      child.on('exit', (code) => {
        if (code !== 0) rejectP(new Error(`record.mjs exited ${code}; stderr=${stderr}`));
        else resolveP();
      });
    });
    const written = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(stateFile, 'utf8')));
    assert.equal(written.records.length, 1);
    assert.equal(written.records[0].event, 'SessionStart');
    assert.deepEqual(written.records[0].payloadKeys, ['toolInput', 'toolName']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('record.mjs enforces MAX_STATE_BYTES and trims older records', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-cap-'));
  const { spawn } = await import('node:child_process');
  const { writeFile: writeFile2, readFile: readFile2 } = await import('node:fs/promises');
  try {
    const root = path.join(tmp, 'plugin');
    const data = path.join(tmp, 'data');
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    const stateFile = path.join(data, 'state.json');
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolveP, rejectP) => {
        const child = spawn(process.execPath, [script, '--event', `E${i}`, '--state', '${PLUGIN_DATA}/state.json'], {
          env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end(JSON.stringify({ idx: i }));
        child.on('error', rejectP);
        child.on('exit', (code) => { if (code === 0) resolveP(); else rejectP(new Error(`exit ${code}`)); });
      });
    }
    const text = await readFile2(stateFile, 'utf8');
    assert.ok(Buffer.byteLength(text, 'utf8') <= 1024 * 1024, 'state file must stay under MAX_STATE_BYTES');
    const written = JSON.parse(text);
    assert.ok(written.records.length <= 4096, 'records must stay under MAX_RECORDS');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
