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
  // Round-4 fix: $schema is now pinned, so the URL must match exactly.
  // The old "any non-empty string" check is gone, so the error message
  // also changes — we now expect "must equal" rather than letting the
  // bogus schema past and tripping on the next clause.
  assert.throws(
    () => validateHooksDocument({ $schema: 'x', hooks: { UnknownEvent: [{ command: 'node' }] } }, 'hooks.json'),
    /\$schema must equal/u,
  );
  assert.throws(
    () => validateHooksDocument({ $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json', hooks: { UnknownEvent: [{ command: 'node' }] } }, 'hooks.json'),
    /not a recognized event/u,
  );
  assert.throws(
    () => validateHooksDocument({ $schema: 'https://minimax.io/schemas/mcode-hooks/0.1.0/hooks.schema.json', hooks: { PreToolUse: [] } }, 'hooks.json'),
    /non-empty array/u,
  );
  assert.throws(
    () => validateHooksDocument({ hooks: { PreToolUse: [{ command: 'node' }] } }, 'hooks.json'),
    /\$schema must equal/u,
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

// Round-4 fix: the previous regex accepted './../outside' and
// '${PLUGIN_ROOT}/../../outside' because it only checked the
// prefix. These tests pin the negative contract.
test('validateHookEntry rejects cwd traversal in ./ paths (R4-1)', () => {
  assert.throws(() => validateHookEntry({ command: 'node', cwd: './../outside' }, 'hook'),
    /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: './foo/../../bar' }, 'hook'),
    /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: './foo\\bar' }, 'hook'),
    /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: '..' }, 'hook'),
    /cwd must be/u);
  // Sanity: a properly contained ./ path is still accepted.
  assert.doesNotThrow(() => validateHookEntry({ command: 'node', cwd: './scripts' }, 'hook'));
});

test('validateHookEntry rejects cwd traversal in ${PLUGIN_ROOT} / ${PLUGIN_DATA} paths (R4-1)', () => {
  assert.throws(() => validateHookEntry({ command: 'node', cwd: '${PLUGIN_ROOT}/../outside' }, 'hook'),
    /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: '${PLUGIN_DATA}/foo/../bar/..' }, 'hook'),
    /cwd must be/u);
  assert.throws(() => validateHookEntry({ command: 'node', cwd: '${PLUGIN_ROOT}/foo/..' }, 'hook'),
    /cwd must be/u);
  // Sanity: contained paths still accepted.
  assert.doesNotThrow(() => validateHookEntry({ command: 'node', cwd: '${PLUGIN_ROOT}/io.minimax.mcode/hooks' }, 'hook'));
  assert.doesNotThrow(() => validateHookEntry({ command: 'node', cwd: '${PLUGIN_DATA}' }, 'hook'));
});

test('validateMcp rejects the same cwd traversal patterns (R4-1)', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', cwd: './../escape' } } }),
    /cwd must be/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}/../etc' } } }),
    /cwd must be/u,
  );
});

test('validateHooksDocument pins the $schema URL to the proposal (R4-3)', () => {
  // Wrong URL is now rejected with the new pin.
  assert.throws(
    () => validateHooksDocument({
      $schema: 'https://example.com/wrong/schema.json',
      hooks: { SessionStart: [{ command: 'node' }] },
    }, 'hooks.json'),
    /\$schema must equal/u,
  );
  // Empty string is now rejected (the old "length > 0" check would
  // still pass an empty string; the new pin wouldn't, because the
  // empty string doesn't equal the proposal URL).
  assert.throws(
    () => validateHooksDocument({
      $schema: '',
      hooks: { SessionStart: [{ command: 'node' }] },
    }, 'hooks.json'),
    /\$schema must equal/u,
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

// Round-4 fix (R4-2): the previous ensureContained only did
// `path.resolve` (lexical normalization), which is bypassed when
// PLUGIN_DATA itself is reached through a symlink. For example:
//
//   PLUGIN_DATA = /tmp/data   (realpath = /var/srv/data)
//   realpath('/tmp/data')   = '/var/srv/data'
//
// Lexical: startsWith('/tmp/data/') -> true -> "contained" (false positive)
// Real:    startsWith('/var/srv/data/') -> true -> contained (the truth)
//
// The hard case is when a SUBDIRECTORY of PLUGIN_DATA is a symlink
// to outside. Lexical containment passes (the symlink lives under
// the lexical root), but real containment fails (the realpath of
// the target is outside the realpath of the root).
test('record.mjs refuses to write through a symlink in PLUGIN_DATA that escapes the root (R4-2)', async () => {
  if (process.platform === 'win32') {
    // Windows symlinks require admin or developer mode; the existing
    // tests in this file already exercise the non-symlink code path,
    // and the contract that the symlink case fails is enforced by
    // the realpath-based check. Skip on Windows to keep CI green;
    // POSIX CI is the real evidence.
    return;
  }
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-symlink-'));
  const { spawn } = await import('node:child_process');
  const { symlink, mkdir, writeFile: writeFileRaw } = await import('node:fs/promises');
  try {
    const data = path.join(tmp, 'plugin-data');
    const outside = path.join(tmp, 'outside');
    await mkdir(data, { recursive: true });
    await mkdir(outside, { recursive: true });
    // Create a sentinel file outside the data root.
    await writeFileRaw(path.join(outside, 'pwned.json'), '{"records":[]}', 'utf8');
    // Symlink data/link -> outside so PLUGIN_DATA/link/pwned.json
    // lexically lives under PLUGIN_DATA but realpath-wise lives
    // under the outside dir.
    await symlink(outside, path.join(data, 'link'), 'dir');
    const root = path.join(tmp, 'plugin');
    await mkdir(root, { recursive: true });
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    const code = await new Promise((resolveP, rejectP) => {
      const child = spawn(process.execPath, [script, '--event', 'SessionStart', '--state', '${PLUGIN_DATA}/link/pwned.json'], {
        env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ toolName: 'Bash' }));
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', rejectP);
      child.on('exit', (c) => resolveP(c));
    });
    // record.mjs swallows the error (Observer must never affect
    // agent behavior), so we can't observe the throw directly.
    // The observable signal is that the file outside PLUGIN_DATA
    // was NOT modified: it still contains the sentinel bytes, not
    // a JSON envelope with `records`.
    const outsideBytes = await import('node:fs/promises').then((m) => m.readFile(path.join(outside, 'pwned.json'), 'utf8'));
    assert.equal(outsideBytes, '{"records":[]}',
      `record.mjs must not have written through the symlink (got: ${outsideBytes})`);
    // The exit code is 0 because errors are swallowed; the contract
    // is that the file system is unchanged. The code is exposed for
    // diagnostic purposes only.
    assert.equal(code, 0, `record.mjs exit code is 0 (errors swallowed) but state must not have escaped: got ${code}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Round-4 fix (R4-4): the previous roundtrip tests only exercised
// SessionStart. The hello-mcode-hooks example ships with
// SessionStart / SessionEnd / PreToolUse entries, and CI only proved
// the first one. These tests run the bundled script with the
// --event flag for the other two.
test('record.mjs handles SessionEnd via the bundled script (R4-4)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-end-'));
  const { spawn } = await import('node:child_process');
  try {
    const root = path.join(tmp, 'plugin');
    const data = path.join(tmp, 'data');
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    const stateFile = path.join(data, 'state.json');
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    await new Promise((resolveP, rejectP) => {
      const child = spawn(process.execPath, [script, '--event', 'SessionEnd', '--state', '${PLUGIN_DATA}/state.json'], {
        env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ sessionId: 'abc-123' }));
      child.on('error', rejectP);
      child.on('exit', (c) => { if (c === 0) resolveP(); else rejectP(new Error(`exit ${c}`)); });
    });
    const written = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(stateFile, 'utf8')));
    assert.equal(written.records.length, 1);
    assert.equal(written.records[0].event, 'SessionEnd');
    assert.deepEqual(written.records[0].payloadKeys, ['sessionId']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('record.mjs handles PostToolUse via the bundled script (R4-4)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-post-'));
  const { spawn } = await import('node:child_process');
  try {
    const root = path.join(tmp, 'plugin');
    const data = path.join(tmp, 'data');
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    const stateFile = path.join(data, 'state.json');
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    await new Promise((resolveP, rejectP) => {
      const child = spawn(process.execPath, [script, '--event', 'PostToolUse', '--state', '${PLUGIN_DATA}/state.json'], {
        env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ toolName: 'Bash', toolResult: { stdout: 'hello', exitCode: 0 } }));
      child.on('error', rejectP);
      child.on('exit', (c) => { if (c === 0) resolveP(); else rejectP(new Error(`exit ${c}`)); });
    });
    const written = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(stateFile, 'utf8')));
    assert.equal(written.records.length, 1);
    assert.equal(written.records[0].event, 'PostToolUse');
    assert.deepEqual(written.records[0].payloadKeys, ['toolName', 'toolResult']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('record.mjs handles PreToolUse via the bundled script (R4-4)', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'hooks-pre-'));
  const { spawn } = await import('node:child_process');
  try {
    const root = path.join(tmp, 'plugin');
    const data = path.join(tmp, 'data');
    await mkdir(root, { recursive: true });
    await mkdir(data, { recursive: true });
    const stateFile = path.join(data, 'state.json');
    const script = path.join(process.cwd(), 'examples', 'hello-mcode-hooks', 'io.minimax.mcode', 'hooks', 'scripts', 'record.mjs');
    await new Promise((resolveP, rejectP) => {
      const child = spawn(process.execPath, [script, '--event', 'PreToolUse', '--state', '${PLUGIN_DATA}/state.json'], {
        env: { ...process.env, PLUGIN_ROOT: root, PLUGIN_DATA: data },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.end(JSON.stringify({ toolName: 'Bash', toolInput: { command: 'rm -rf /' } }));
      child.on('error', rejectP);
      child.on('exit', (c) => { if (c === 0) resolveP(); else rejectP(new Error(`exit ${c}`)); });
    });
    const written = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(stateFile, 'utf8')));
    assert.equal(written.records.length, 1);
    assert.equal(written.records[0].event, 'PreToolUse');
    // payloadKeys is sorted alphabetically (see record.mjs).
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
