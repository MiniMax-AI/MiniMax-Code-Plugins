import assert from 'node:assert/strict';
import { startServer, toolText } from './mcp-client.mjs';

const server = startServer('./mcp/local-bio-tools.mjs');
try {
  const initialized = await server.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'local-bio-tools');
  const listed = await server.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['local_bio_tool_status', 'pymol_render', 'local_bio_open']);
  const statusMessage = await server.request('tools/call', { name: 'local_bio_tool_status', arguments: {} });
  const status = JSON.parse(toolText(statusMessage));
  assert.equal(status.localOnly, true);
  assert.deepEqual(status.tools.map((tool) => tool.id), ['pymol', 'snapgene', 'cytoscape', 'fiji']);
  console.log('local-tools-protocol-smoke: ok');
} finally { server.close(); }
