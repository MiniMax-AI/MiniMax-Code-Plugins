import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateHostedPluginDirectory } from '../scripts/lib/validation.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('contributor can scaffold a hosted Skill plugin with one command', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugins-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'create-plugin.mjs'), 'alice/hello-world'],
    { cwd: workspace },
  );

  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const readme = await readFile(path.join(pluginRoot, 'README.md'), 'utf8');
  const license = await readFile(path.join(pluginRoot, 'LICENSE'), 'utf8');
  const skill = await readFile(path.join(pluginRoot, 'skills', 'hello-world', 'SKILL.md'), 'utf8');

  assert.equal(manifest.name, 'hello-world');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.match(readme, /# Hello World/u);
  assert.match(license, /Apache License/u);
  assert.match(skill, /^---\nname: hello-world\n/mu);
  assert.match(stdout, /plugins\/alice\/hello-world/u);
});

test('hosted Plugin is valid when its package and contribution docs are complete', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-validation-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  await mkdir(path.join(pluginRoot, 'skills', 'hello-world'), { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-world',
      version: '1.0.0',
      description: 'Greets MiniMax Code users with a reusable Skill.',
      license: 'Apache-2.0',
    })}\n`),
    writeFile(path.join(pluginRoot, 'README.md'), '# Hello World\n\nUse the Skill to greet a user.\n'),
    writeFile(path.join(pluginRoot, 'LICENSE'), 'Apache License\nVersion 2.0\n'),
    writeFile(path.join(pluginRoot, 'skills', 'hello-world', 'SKILL.md'), '---\nname: hello-world\ndescription: Greet the user when they ask MiniMax Code to say hello.\n---\n\n# Instructions\n\nRespond with a friendly greeting.\n'),
  ]);

  const result = await validateHostedPluginDirectory(pluginRoot, {
    owner: 'alice',
    pluginName: 'hello-world',
  });

  assert.equal(result.id, 'alice/hello-world');
  assert.deepEqual(result.skills, ['hello-world']);
});

test('scaffold stays review-incomplete until contributor replaces every TODO', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-todo-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'create-plugin.mjs'), 'alice/hello-world'],
    { cwd: workspace },
  );

  await assert.rejects(
    validateHostedPluginDirectory(path.join(workspace, 'plugins', 'alice', 'hello-world'), {
      owner: 'alice',
      pluginName: 'hello-world',
    }),
    /replace every TODO/u,
  );
});

test('repository check discovers hosted Plugins by owner and directory name', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-repository-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'create-plugin.mjs'), 'alice/hello-world'],
    { cwd: workspace },
  );
  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  manifest.description = 'Greets MiniMax Code users with a reusable Skill.';
  await Promise.all([
    writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(pluginRoot, 'README.md'), '# Hello World\n\nAsk MiniMax Code for a friendly greeting.\n'),
    writeFile(path.join(pluginRoot, 'skills', 'hello-world', 'SKILL.md'), '---\nname: hello-world\ndescription: Greet the user when they ask MiniMax Code to say hello.\n---\n\n# Instructions\n\nRespond with a friendly greeting.\n'),
  ]);

  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(repositoryRoot, 'scripts', 'validate.mjs'), '--root', workspace],
    { cwd: workspace },
  );

  assert.match(stdout, /OK   plugin alice\/hello-world/u);
  assert.match(stdout, /Validated 1 hosted Plugin/u);
});

test('hosted Plugin rejects symlinks that can escape its package root', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-symlink-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  await mkdir(path.join(pluginRoot, 'skills', 'hello-world'), { recursive: true });
  await Promise.all([
    writeFile(path.join(workspace, 'outside.md'), '# Outside\n'),
    writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-world',
      description: 'Greets MiniMax Code users with a reusable Skill.',
      license: 'Apache-2.0',
    })}\n`),
    writeFile(path.join(pluginRoot, 'LICENSE'), 'Apache License\nVersion 2.0\n'),
    writeFile(path.join(pluginRoot, 'skills', 'hello-world', 'SKILL.md'), '---\nname: hello-world\ndescription: Greet the user when they ask MiniMax Code to say hello.\n---\n\n# Instructions\n\nRespond with a friendly greeting.\n'),
    symlink(path.join(workspace, 'outside.md'), path.join(pluginRoot, 'README.md')),
  ]);

  await assert.rejects(
    validateHostedPluginDirectory(pluginRoot, { owner: 'alice', pluginName: 'hello-world' }),
    /symlinks are not allowed/u,
  );
});

test('scaffold refuses to populate an existing Plugin directory', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-existing-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  const destination = path.join(workspace, 'plugins', 'alice', 'hello-world');
  await mkdir(destination, { recursive: true });

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(repositoryRoot, 'scripts', 'create-plugin.mjs'), 'alice/hello-world'],
      { cwd: workspace },
    ),
    /already exists/u,
  );
  await assert.rejects(readFile(path.join(destination, 'plugin.json'), 'utf8'), /ENOENT/u);
});

test('scaffold rejects paths that cannot identify a GitHub owner and portable Plugin', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-path-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });

  for (const contribution of ['alice-/hello', 'alice--dev/hello', 'alice/Hello', 'alice/hello--world']) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [path.join(repositoryRoot, 'scripts', 'create-plugin.mjs'), contribution],
        { cwd: workspace },
      ),
      /must be <github-owner>\/<lowercase-plugin-name>/u,
    );
  }
});

test('hosted Plugin accepts a stdio server whose cwd stays inside the sandbox', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-cwd-safe-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  const skillsRoot = path.join(pluginRoot, 'skills', 'hello-world');
  await mkdir(skillsRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-world',
      version: '1.0.0',
      description: 'Greets MiniMax Code users with a reusable Skill and a sandboxed stdio MCP server.',
      license: 'Apache-2.0',
    })}\n`),
    writeFile(path.join(pluginRoot, 'README.md'), '# Hello World\n\nUse the Skill and MCP server safely.\n'),
    writeFile(path.join(pluginRoot, 'LICENSE'), 'Apache License\nVersion 2.0\n'),
    writeFile(path.join(skillsRoot, 'SKILL.md'), '---\nname: hello-world\ndescription: Greet the user when they ask MiniMax Code to say hello.\n---\n\n# Instructions\n\nRespond with a friendly greeting.\n'),
    writeFile(path.join(pluginRoot, 'mcp.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        local: { type: 'stdio', command: './server.js', cwd: '${PLUGIN_DATA}/subdir' },
      },
    })}\n`),
  ]);

  const result = await validateHostedPluginDirectory(pluginRoot, {
    owner: 'alice',
    pluginName: 'hello-world',
  });
  assert.equal(result.id, 'alice/hello-world');
  assert.deepEqual(result.mcpServers, ['local']);
});

test('hosted Plugin rejects a stdio server whose cwd escapes the sandbox', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'minimax-code-plugin-cwd-escape-'));
  context.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(workspace, { recursive: true, force: true });
  });
  const pluginRoot = path.join(workspace, 'plugins', 'alice', 'hello-world');
  const skillsRoot = path.join(pluginRoot, 'skills', 'hello-world');
  await mkdir(skillsRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(pluginRoot, 'plugin.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'hello-world',
      version: '1.0.0',
      description: 'Greets MiniMax Code users with a malicious stdio MCP server.',
      license: 'Apache-2.0',
    })}\n`),
    writeFile(path.join(pluginRoot, 'README.md'), '# Hello World\n\nUse the Skill and MCP server safely.\n'),
    writeFile(path.join(pluginRoot, 'LICENSE'), 'Apache License\nVersion 2.0\n'),
    writeFile(path.join(skillsRoot, 'SKILL.md'), '---\nname: hello-world\ndescription: Greet the user when they ask MiniMax Code to say hello.\n---\n\n# Instructions\n\nRespond with a friendly greeting.\n'),
    writeFile(path.join(pluginRoot, 'mcp.json'), `${JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        bad: { type: 'stdio', command: './server.js', cwd: '${PLUGIN_DATA}/../../etc' },
      },
    })}\n`),
  ]);

  await assert.rejects(
    validateHostedPluginDirectory(pluginRoot, { owner: 'alice', pluginName: 'hello-world' }),
    /escapes the Plugin sandbox/u,
  );
});
