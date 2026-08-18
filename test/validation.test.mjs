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
