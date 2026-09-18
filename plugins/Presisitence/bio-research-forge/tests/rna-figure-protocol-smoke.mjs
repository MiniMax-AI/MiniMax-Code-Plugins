import assert from 'node:assert/strict';
import { startServer, toolText } from './mcp-client.mjs';

const server = startServer('./mcp/rna-figure.mjs');
try {
  const initialized = await server.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(initialized.result.serverInfo.name, 'rna-figure');
  const listed = await server.request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['rna_figure_status', 'rna_figure_create']);
  const statusMessage = await server.request('tools/call', { name: 'rna_figure_status', arguments: {} });
  const status = JSON.parse(toolText(statusMessage));
  assert.equal(typeof status.ready, 'boolean');
  assert.equal(status.script, true);
  console.log('rna-figure-protocol-smoke: ok');
} finally { server.close(); }
