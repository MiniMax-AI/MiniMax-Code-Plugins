import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, toolText } from './mcp-client.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function filesUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else found.push(full);
  }
  return found;
}

const self = fileURLToPath(import.meta.url);
const textFiles = (await filesUnder(ROOT)).filter((file) => file !== self && !/\.(?:svg|png|jpg|jpeg|gif|pdf|docx|pptx)$/i.test(file));
const forbidden = [
  /[G-Z]:\\/i,
  /C:\\Users\\[^\\]+/i,
  /pepper-hub/i,
  /zsg_id_map/i,
  /尊辣|张树刚/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
for (const file of textFiles) {
  const content = await readFile(file, 'utf8');
  for (const rule of forbidden) assert(!rule.test(content), `${path.relative(ROOT, file)} matched ${rule}`);
}

const server = startServer();
try {
  const blocked = await server.request('tools/call', {
    name: 'bio_api_query',
    arguments: { source: 'ensembl', operation: 'lookup-symbol', species: 'capsicum_annuum', id: 'Example1' },
  });
  assert.equal(blocked.result.isError, true);
  assert.match(toolText(blocked), /public-data boundary/i);
  console.log('privacy-boundary: ok');
} finally {
  server.close();
}
