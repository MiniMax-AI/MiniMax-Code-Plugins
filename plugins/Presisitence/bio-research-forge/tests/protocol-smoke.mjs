import assert from 'node:assert/strict';
import { startServer, toolText } from './mcp-client.mjs';

const server = startServer();
try {
  const initialized = await server.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'public-bio-api');

  const listed = await server.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['bio_api_catalog', 'bio_api_query', 'bio_api_health']);

  const catalogMessage = await server.request('tools/call', { name: 'bio_api_catalog', arguments: {} });
  const catalog = JSON.parse(toolText(catalogMessage));
  assert.equal(catalog.sources.length, 10);
  assert(catalog.sources.every((source) => source.docs.startsWith('https://')));

  const healthMessage = await server.request('tools/call', { name: 'bio_api_health', arguments: {} });
  const health = JSON.parse(toolText(healthMessage));
  assert.equal(health.status, 'healthy');
  assert.equal(health.publicOnly, true);
  assert.equal(health.localFilesRead, false);
  console.log('protocol-smoke: ok');
} finally {
  server.close();
}
