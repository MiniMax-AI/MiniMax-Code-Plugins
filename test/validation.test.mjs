import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCwd, validateMcp, validatePluginManifest, validateSkillText } from '../scripts/lib/validation.mjs';

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

test('resolveCwd accepts anchored Plugin paths and resolves them', () => {
  const pluginRoot = '/plugins/alice/hello-world';
  const pluginData = '/plugins/alice/hello-world/.data';
  assert.equal(resolveCwd('./cwd', pluginRoot, pluginData), `${pluginRoot}/cwd`);
  assert.equal(resolveCwd('./nested/cwd', pluginRoot, pluginData), `${pluginRoot}/nested/cwd`);
  assert.equal(resolveCwd('${PLUGIN_ROOT}/cwd', pluginRoot, pluginData), `${pluginRoot}/cwd`);
  assert.equal(resolveCwd('${PLUGIN_DATA}/cwd', pluginRoot, pluginData), `${pluginData}/cwd`);
  assert.equal(resolveCwd('${PLUGIN_DATA}/foo/../bar', pluginRoot, pluginData), `${pluginData}/bar`);
});

test('resolveCwd rejects paths that escape the Plugin sandbox', () => {
  const pluginRoot = '/plugins/alice/hello-world';
  const pluginData = '/plugins/alice/hello-world/.data';
  assert.throws(() => resolveCwd('${PLUGIN_DATA}/../../etc', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
  assert.throws(() => resolveCwd('./../../escape', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
  assert.throws(() => resolveCwd('${PLUGIN_ROOT}/foo/../../escape', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
  assert.throws(() => resolveCwd('/etc/passwd', pluginRoot, pluginData), /must be relative/u);
  assert.throws(() => resolveCwd('subdir', pluginRoot, pluginData), /must start with/u);
  assert.throws(() => resolveCwd('', pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd('.\\foo', pluginRoot, pluginData), /forward slashes/u);
});

test('resolveCwd rejects non-string values and embedded control bytes', () => {
  const pluginRoot = '/plugins/alice/hello-world';
  const pluginData = '/plugins/alice/hello-world/.data';
  assert.throws(() => resolveCwd(null, pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd(undefined, pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd(42, pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd(true, pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd({}, pluginRoot, pluginData), /non-empty string/u);
  assert.throws(() => resolveCwd('./cwd\u0000/etc', pluginRoot, pluginData), /NUL bytes/u);
});

test('resolveCwd accepts "./" alone and resolves it to the Plugin root', () => {
  const pluginRoot = '/plugins/alice/hello-world';
  const pluginData = '/plugins/alice/hello-world/.data';
  assert.equal(resolveCwd('./', pluginRoot, pluginData), pluginRoot);
});

test('resolveCwd refuses to resolve placeholders when the matching root is missing', () => {
  assert.throws(() => resolveCwd('./cwd'), /requires a plugin root/u);
  assert.throws(() => resolveCwd('${PLUGIN_ROOT}/cwd'), /requires a plugin root/u);
  assert.throws(() => resolveCwd('${PLUGIN_DATA}/cwd', '/plugins/alice/hello-world'), /requires a plugin data directory/u);
  assert.throws(() => resolveCwd('${PLUGIN_ROOT}/cwd', '', '/plugins/alice/hello-world/.data'), /requires a plugin root/u);
});

test('resolveCwd follows path.resolve semantics for absolute mid-segments', () => {
  const pluginRoot = '/plugins/alice/hello-world';
  const pluginData = '/plugins/alice/hello-world/.data';
  assert.throws(() => resolveCwd('./cwd/../../etc', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
  assert.throws(() => resolveCwd('./cwd/../../../etc', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
  assert.throws(() => resolveCwd('./cwd/../../../../etc', pluginRoot, pluginData), /escapes the Plugin sandbox/u);
});

test('validateMcp forwards cwd sandbox checks using the supplied options', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };
  const options = {
    pluginRoot: '/plugins/alice/hello-world',
    pluginData: '/plugins/alice/hello-world/.data',
  };
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { local: { type: 'stdio', command: './server.js', cwd: '${PLUGIN_DATA}/subdir' } } }, 'mcp.json', options),
    ['local'],
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: './server.js', cwd: '${PLUGIN_DATA}/../../etc' } } }, 'mcp.json', options),
    /escapes the Plugin sandbox/u,
  );
});

test('validateMcp rejects non-string cwd values and accepts http/sse transports', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };
  const options = {
    pluginRoot: '/plugins/alice/hello-world',
    pluginData: '/plugins/alice/hello-world/.data',
  };
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: './server.js', cwd: null } } }, 'mcp.json', options),
    /must be a string/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: './server.js', cwd: 42 } } }, 'mcp.json', options),
    /must be a string/u,
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { remote: { type: 'streamable-http', url: 'https://example.com/mcp' } } }, 'mcp.json', options),
    ['remote'],
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { sse: { type: 'sse', url: 'http://localhost:1234/mcp' } } }, 'mcp.json', options),
    ['sse'],
  );
});

test('validateMcp rejects credentials and reserved keys in headers and env', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer secret123' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Cookie: 'session=abc' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { AUTHORIZATION: 'Bearer x' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { PLUGIN_ROOT: 'overwrite' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { PLUGIN_DATA: 'overwrite' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'overwrite' } } } }, 'mcp.json'),
    /env is invalid/u,
  );

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'audit' } } } }, 'mcp.json'),
    ['ok'],
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'Accept': 'application/json' } } } }, 'mcp.json'),
    ['ok'],
  );
});

test('validateMcp rejects NUL bytes in command, args, env, and headers', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node\u0000' } } }, 'mcp.json'),
    /NUL bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', args: ['./server.js\u0000'] } } }, 'mcp.json'),
    /NUL bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', env: { FOO: 'bar\u0000' } } } }, 'mcp.json'),
    /env is invalid/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', env: { 'FOO\u0000': 'bar' } } } }, 'mcp.json'),
    /env is invalid/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'a\u0000b' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-\u0000': 'audit' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'stdio', command: 'node', args: ['./server.js'] } } }, 'mcp.json'),
    ['ok'],
  );
});

test('validateMcp rejects server names longer than 64 characters', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { ['x'.repeat(65)]: { type: 'stdio', command: 'node' } } }, 'mcp.json'),
    /invalid MCP server name/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { ['a'.repeat(64) + '--']: { type: 'stdio', command: 'node' } } }, 'mcp.json'),
    /invalid MCP server name/u,
  );

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ['x'.repeat(64)]: { type: 'stdio', command: 'node' } } }, 'mcp.json'),
    ['x'.repeat(64)],
  );
});

test('validateMcp rejects CRLF and control bytes in headers (HTTP header injection defense)', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'a\r\nAuthorization: Bearer evil' } } } }, 'mcp.json'),
    /control bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace\r\nAuthorization': 'foo' } } } }, 'mcp.json'),
    /control bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'a\nfoo' } } } }, 'mcp.json'),
    /control bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'a\rfoo' } } } }, 'mcp.json'),
    /control bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'foo\u0000bar' } } } }, 'mcp.json'),
    /control bytes/u,
  );
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'foo\u007fbar' } } } }, 'mcp.json'),
    /control bytes/u,
  );

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'foo\tbar' } } } }, 'mcp.json'),
    ['ok'],
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'audit-id' } } } }, 'mcp.json'),
    ['ok'],
  );
});

test('validateMcp rejects common custom credential headers (X-Api-Key, X-Auth-Token, etc.)', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  for (const key of ['X-Api-Key', 'X-Auth-Token', 'X-Access-Token', 'X-Token', 'X-Secret', 'X-Api-Token', 'Api-Key', 'Auth-Token', 'Access-Token']) {
    assert.throws(
      () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { [key]: 'secret123' } } } }, 'mcp.json'),
      /headers must be strings/u,
      `expected ${key} to be rejected`,
    );
  }

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Request-Id': 'audit-trace' } } } }, 'mcp.json'),
    ['ok'],
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'User-Agent': 'minimax-code-plugin/1.0' } } } }, 'mcp.json'),
    ['ok'],
  );
});

test('validateMcp trims header keys before matching the credential blacklist', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  for (const key of ['Authorization ', ' Authorization', '  Authorization  ', 'authorization\t', 'X-Api-Key ', ' X-Api-Key', 'PLUGIN_ROOT ']) {
    assert.throws(
      () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { [key]: 'secret' } } } }, 'mcp.json'),
      /headers must be strings/u,
      `expected ${JSON.stringify(key)} to be rejected after trim`,
    );
  }

  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace ': 'audit' } } } }, 'mcp.json'),
    ['ok'],
  );
  assert.deepEqual(
    validateMcp({ ...base, mcpServers: { ok: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { '\tX-Trace': 'audit' } } } }, 'mcp.json'),
    ['ok'],
  );
});

test('validateMcp enforces size limits to prevent DoS via huge cwd/args/env/headers', () => {
  const base = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' };

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', cwd: './' + 'a/'.repeat(50000) } } }, 'mcp.json'),
    /cwd must be a string of at most 1024 chars/u,
  );

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', args: new Array(2000).fill('./server.js') } } }, 'mcp.json'),
    /args must be strings without NUL bytes/u,
  );

  const manyArgs = [];
  for (let i = 0; i < 1024; i++) manyArgs.push(`--flag-${i}`);
  manyArgs.push('a'.repeat(5000));
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', args: manyArgs } } }, 'mcp.json'),
    /args must be strings without NUL bytes/u,
  );

  const manyEnv = {};
  for (let i = 0; i < 300; i++) manyEnv[`KEY_${i}`] = 'value';
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'stdio', command: 'node', env: manyEnv } } }, 'mcp.json'),
    /env is invalid/u,
  );

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Trace': 'a'.repeat(100000) } } } }, 'mcp.json'),
    /headers must be strings/u,
  );

  const manyHeaders = {};
  for (let i = 0; i < 200; i++) manyHeaders[`X-Header-${i}`] = 'value';
  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: manyHeaders } } }, 'mcp.json'),
    /headers must be strings/u,
  );

  assert.throws(
    () => validateMcp({ ...base, mcpServers: { bad: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { ['X-'.repeat(200)]: 'value' } } } }, 'mcp.json'),
    /headers must be strings/u,
  );
});

test('validateSkillText accepts CRLF and rejects UTF-8 BOM (cross-platform line endings)', () => {
  assert.deepEqual(
    validateSkillText('---\r\nname: hello-skill\r\ndescription: Run when the user asks.\r\n---\r\n\r\n# Hello\n', 'hello-skill'),
    { name: 'hello-skill', description: 'Run when the user asks.' },
  );
  assert.deepEqual(
    validateSkillText('---\r\nname: hello-skill\ndescription: Run when the user asks.\r\n---\n\n# Hello\n', 'hello-skill'),
    { name: 'hello-skill', description: 'Run when the user asks.' },
  );
  assert.deepEqual(
    validateSkillText('---\nname: hello-skill\ndescription: Run when the user asks.\r\n---\r\n\r\n# Hello\n', 'hello-skill'),
    { name: 'hello-skill', description: 'Run when the user asks.' },
  );

  assert.throws(
    () => validateSkillText('\uFEFF---\nname: hello-skill\ndescription: Run when the user asks.\n---\n\n# Hello\n', 'hello-skill'),
    /UTF-8 BOM is not allowed/u,
  );
  assert.throws(
    () => validateSkillText('\uFEFF---\r\nname: hello-skill\r\ndescription: Run when the user asks.\r\n---\r\n\r\n# Hello\r\n', 'hello-skill'),
    /UTF-8 BOM is not allowed/u,
  );
});
