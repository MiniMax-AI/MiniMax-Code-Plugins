import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLUGIN_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseJson(text, label) {
  assert(!text.startsWith('\uFEFF'), `${label}: UTF-8 BOM is not allowed`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label}: invalid JSON: ${error.message}`);
  }
}

export function validatePluginManifest(value, label = 'plugin.json') {
  assert(isRecord(value), `${label}: root must be an object`);
  assert(value.$schema === PLUGIN_SCHEMA, `${label}: unsupported $schema`);
  assert(typeof value.name === 'string' && value.name.length <= 64 && PLUGIN_NAME.test(value.name), `${label}: invalid name`);
  for (const key of Object.keys(value)) {
    assert(PLUGIN_FIELDS.has(key), `${label}: unknown field ${key}`);
  }
  for (const key of ['version', 'description', 'homepage', 'repository', 'license']) {
    assert(value[key] === undefined || typeof value[key] === 'string', `${label}: ${key} must be a string`);
  }
  if (value.author !== undefined) {
    assert(isRecord(value.author), `${label}: author must be an object`);
    for (const key of Object.keys(value.author)) {
      assert(['name', 'email', 'url'].includes(key), `${label}: unknown author field ${key}`);
      assert(typeof value.author[key] === 'string', `${label}: author.${key} must be a string`);
    }
  }
  if (value.keywords !== undefined) {
    assert(Array.isArray(value.keywords) && value.keywords.every((item) => typeof item === 'string'), `${label}: keywords must be strings`);
  }
  assert(value.extensions === undefined || isRecord(value.extensions), `${label}: extensions must be an object`);
  return value;
}

export function validateSkillText(text, expectedName, label = 'SKILL.md') {
  assert(!text.startsWith('\uFEFF'), `${label}: UTF-8 BOM is not allowed`);
  const normalized = text.includes('\r') ? text.replace(/\r\n?/gu, '\n') : text;
  assert(normalized.startsWith('---\n'), `${label}: YAML frontmatter is required`);
  const end = normalized.indexOf('\n---\n', 4);
  assert(end > 4, `${label}: YAML frontmatter is not closed`);
  const frontmatter = normalized.slice(4, end);
  const name = frontmatter.match(/^name:\s*([^\n]+)$/mu)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*([^\n]+)$/mu)?.[1]?.trim();
  assert(name === expectedName, `${label}: frontmatter name must equal ${expectedName}`);
  assert(SKILL_NAME.test(name) && name.length <= 64, `${label}: invalid Skill name`);
  assert(Boolean(description) && description.length <= 1024, `${label}: description is required and must be at most 1024 characters`);
  assert(normalized.slice(end + 5).trim().length > 0, `${label}: instructions are required`);
  return { name, description };
}

export function validateMcp(value, label = 'mcp.json', options = {}) {
  assert(isRecord(value), `${label}: root must be an object`);
  assert(value.$schema === MCP_SCHEMA, `${label}: unsupported $schema`);
  assert(Object.keys(value).every((key) => ['$schema', 'mcpServers'].includes(key)), `${label}: unknown root field`);
  assert(isRecord(value.mcpServers), `${label}: mcpServers must be an object`);
  const entries = Object.entries(value.mcpServers);
  assert(entries.length <= 8, `${label}: MiniMax Code supports at most 8 MCP servers per plugin`);
  for (const [name, server] of entries) {
    assert(PLUGIN_NAME.test(name) && name.length <= 64, `${label}: invalid MCP server name ${name}`);
    assert(isRecord(server), `${label}: MCP server ${name} must be an object`);
    if (server.type === 'stdio') {
      assert(typeof server.command === 'string' && server.command.length > 0 && server.command.length <= 1024 && !/\x00/u.test(server.command) && (isBareCommand(server.command) || isContainedRelativePath(server.command)), `${label}: ${name} needs a bare executable or contained ./ path without NUL bytes (max 1024 chars)`);
      assert(server.args === undefined || (Array.isArray(server.args) && server.args.length <= 1024 && server.args.every((item) => typeof item === 'string' && item.length <= 4096 && !/\x00/u.test(item))), `${label}: ${name}.args must be strings without NUL bytes (max 1024 items, 4096 chars each)`);
      assert(server.env === undefined || (isRecord(server.env) && Object.entries(server.env).length <= 256 && Object.entries(server.env).every(([key, item]) => !['PLUGIN_ROOT', 'PLUGIN_DATA'].includes(key) && typeof item === 'string' && !/\x00/u.test(item) && !/\x00/u.test(key))), `${label}: ${name}.env is invalid (max 256 entries)`);
      if (server.cwd !== undefined) {
        assert(typeof server.cwd === 'string' && server.cwd.length <= 1024, `${label}: ${name}.cwd must be a string of at most 1024 chars`);
        resolveCwd(server.cwd, options.pluginRoot, options.pluginData, label, name);
      }
      assert(Object.keys(server).every((key) => ['type', 'command', 'args', 'env', 'cwd'].includes(key)), `${label}: ${name} has unsupported fields`);
    } else if (server.type === 'streamable-http' || server.type === 'sse') {
      assert(typeof server.url === 'string' && isSafeRemoteUrl(server.url), `${label}: ${name}.url must be HTTPS or loopback HTTP without credentials or fragment`);
      assert(server.headers === undefined || (isRecord(server.headers) && Object.entries(server.headers).length <= 100 && Object.entries(server.headers).every(([key, item]) => {
        // Trim before matching so trailing whitespace cannot smuggle a credential header past the blacklist.
        const trimmedKey = key.trim();
        const reservedKeys = ['PLUGIN_ROOT', 'PLUGIN_DATA'];
        const credentialHeaders = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|x-auth-token|x-access-token|x-token|x-secret|x-api-token|api-key|auth-token|access-token)$/iu;
        // \x0a-\x1f covers LF (\x0a) and CR (\x0d); tab (\x09) is allowed as RFC 7230 OWS.
        const controlBytes = /[\x00-\x08\x0a-\x1f\x7f]/u;
        return !reservedKeys.includes(trimmedKey)
          && !credentialHeaders.test(trimmedKey)
          && typeof item === 'string'
          && item.length <= 8192
          && key.length <= 256
          && !controlBytes.test(item)
          && !controlBytes.test(key);
      })), `${label}: ${name}.headers must be strings without reserved keys, credentials, or control bytes (NUL/CR/LF/>0x7f; tab is allowed as RFC 7230 OWS; max 100 entries, key 256 chars, value 8192 chars)`);
      assert(Object.keys(server).every((key) => ['type', 'url', 'headers'].includes(key)), `${label}: ${name} has unsupported fields`);
    } else {
      throw new Error(`${label}: ${name} uses unsupported transport ${String(server.type)}`);
    }
  }
  return entries.map(([name]) => name).sort();
}

function isBareCommand(value) {
  return !/[\\/]/u.test(value);
}

function isContainedRelativePath(value) {
  return value.startsWith('./') && !value.split('/').includes('..') && !value.includes('\\');
}

function isSafeRemoteUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol !== 'http:') return false;
    const host = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
  } catch {
    return false;
  }
}

function isContainedWithin(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string') return false;
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveCwd(cwd, pluginRoot, pluginData, label = 'mcp.json', serverName = 'cwd') {
  assert(typeof cwd === 'string' && cwd.length > 0, `${label}: ${serverName}.cwd must be a non-empty string`);
  assert(!path.isAbsolute(cwd), `${label}: ${serverName}.cwd must be relative: ${cwd}`);
  assert(!cwd.includes('\\'), `${label}: ${serverName}.cwd must use forward slashes: ${cwd}`);
  assert(!/\x00/u.test(cwd), `${label}: ${serverName}.cwd must not contain NUL bytes: ${cwd}`);
  let resolved;
  if (cwd.startsWith('./')) {
    assert(typeof pluginRoot === 'string' && pluginRoot.length > 0, `${label}: ${serverName}.cwd requires a plugin root to resolve ${cwd}`);
    resolved = path.resolve(pluginRoot, cwd);
  } else if (cwd.startsWith('${PLUGIN_ROOT}')) {
    assert(typeof pluginRoot === 'string' && pluginRoot.length > 0, `${label}: ${serverName}.cwd requires a plugin root to resolve ${cwd}`);
    resolved = path.resolve(pluginRoot, cwd.slice('${PLUGIN_ROOT}'.length).replace(/^\/+/u, ''));
  } else if (cwd.startsWith('${PLUGIN_DATA}')) {
    assert(typeof pluginData === 'string' && pluginData.length > 0, `${label}: ${serverName}.cwd requires a plugin data directory to resolve ${cwd}`);
    resolved = path.resolve(pluginData, cwd.slice('${PLUGIN_DATA}'.length).replace(/^\/+/u, ''));
  } else {
    throw new Error(`${label}: ${serverName}.cwd must start with "./", "\${PLUGIN_ROOT}", or "\${PLUGIN_DATA}": ${cwd}`);
  }
  const insideRoot = isContainedWithin(pluginRoot, resolved);
  const insideData = typeof pluginData === 'string' && pluginData.length > 0 && isContainedWithin(pluginData, resolved);
  assert(insideRoot || insideData, `${label}: ${serverName}.cwd escapes the Plugin sandbox: ${cwd}`);
  return resolved;
}

export async function validatePluginDirectory(root, options = {}) {
  const manifestPath = path.join(root, 'plugin.json');
  const manifest = validatePluginManifest(parseJson(await readFile(manifestPath, 'utf8'), manifestPath), manifestPath);
  const skills = [];
  const skillsRoot = path.join(root, 'skills');
  let children = [];
  try {
    children = await readdir(skillsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert(children.filter((item) => item.isDirectory()).length <= 64, `${skillsRoot}: MiniMax Code supports at most 64 Skills per plugin`);
  for (const child of children.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillPath = path.join(skillsRoot, child.name, 'SKILL.md');
    validateSkillText(await readFile(skillPath, 'utf8'), child.name, skillPath);
    skills.push(child.name);
  }
  let mcpServers = [];
  const mcpPath = path.join(root, 'mcp.json');
  try {
    mcpServers = validateMcp(parseJson(await readFile(mcpPath, 'utf8'), mcpPath), mcpPath, options);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  assert(skills.length + mcpServers.length > 0, `${root}: plugin must expose at least one Skill or MCP server`);
  return { manifest, skills: skills.sort(), mcpServers };
}

export async function validateHostedPluginDirectory(root, { owner, pluginName, pluginRoot, pluginData } = {}) {
  assert(OWNER_NAME.test(owner), `${root}: invalid GitHub owner directory ${owner}`);
  assert(PLUGIN_NAME.test(pluginName) && pluginName.length <= 64, `${root}: invalid Plugin directory ${pluginName}`);
  await assertNoSymlinks(root);
  const resolvedPluginRoot = pluginRoot ?? root;
  const resolvedPluginData = pluginData ?? path.join(root, '.data');
  const result = await validatePluginDirectory(root, { pluginRoot: resolvedPluginRoot, pluginData: resolvedPluginData });
  assert(result.manifest.name === pluginName, `${root}: plugin.json name must equal directory name ${pluginName}`);
  assert(typeof result.manifest.license === 'string' && result.manifest.license.length > 0, `${root}: plugin.json must declare a license`);
  for (const file of ['README.md', 'LICENSE']) {
    const contents = await readFile(path.join(root, file), 'utf8');
    assert(contents.trim().length > 0, `${root}: ${file} must not be empty`);
  }
  for (const file of await listTextContractFiles(root)) {
    const contents = await readFile(file, 'utf8');
    assert(!/\bTODO\b/u.test(contents), `${file}: replace every TODO before submission`);
  }
  return { id: `${owner}/${pluginName}`, ...result };
}

async function assertNoSymlinks(root) {
  for (const child of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, child.name);
    assert(!child.isSymbolicLink(), `${file}: symlinks are not allowed in hosted Plugins`);
    if (child.isDirectory()) await assertNoSymlinks(file);
  }
}

async function listTextContractFiles(root) {
  const files = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, child.name);
    if (child.isDirectory()) files.push(...await listTextContractFiles(file));
    else if (child.isFile() && (child.name.endsWith('.md') || ['plugin.json', 'mcp.json'].includes(child.name))) files.push(file);
  }
  return files;
}
