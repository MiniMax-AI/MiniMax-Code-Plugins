// tests/server.test.mjs
//
// Spawns server.mjs as a real subprocess and exercises the JSON-RPC
// protocol over stdio. This is the same protocol mavis will use to
// invoke the plugin's MCP server, so any regression here is caught
// before review.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, '..', 'server.mjs');

/**
 * Minimal JSON-RPC client that talks to the spawned server over stdio.
 * Each request/response is one JSON object per line.
 */
function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let nextId = 1;
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d.toString('utf-8')));

  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  async function stop() {
    notify('shutdown', {});
    child.stdin.end();
    await new Promise((r) => child.on('close', r));
    return stderr.join('');
  }
  return { send, notify, stop };
}

test('server: initialize handshake', async () => {
  const s = startServer();
  try {
    const r = await s.send('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.equal(r.serverInfo.name, 'skill-bridge');
    assert.match(r.serverInfo.version, /^\d+\.\d+\.\d+/);
  } finally {
    await s.stop();
  }
});

test('server: tools/list advertises the four tools', async () => {
  const s = startServer();
  try {
    const r = await s.send('tools/list');
    const names = r.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['analyze', 'classify', 'convert', 'detect']);
  } finally {
    await s.stop();
  }
});

test('server: detect on utf-8 file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-server-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(file, '---\nname: x\ndescription: y\n---\n\n# X\n', 'utf-8');
  const s = startServer();
  try {
    const r = await s.send('tools/call', { name: 'detect', arguments: { source: file } });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.encoding, 'utf-8');
    assert.equal(payload.replaced, false);
  } finally {
    await s.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server: classify on a pure-instruction skill', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-server-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(
    file,
    '---\nname: y\ndescription: "A pure skill."\n---\n\n# Y\n\nJust instructions.\n',
    'utf-8',
  );
  const s = startServer();
  try {
    const r = await s.send('tools/call', { name: 'classify', arguments: { source: file } });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.tier, 'pure');
  } finally {
    await s.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server: convert writes output and returns lint object', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-server-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(
    file,
    '---\nname: demo-skill\ndescription: "Demo."\n---\n\n# Demo\n\nUse /tmp/x for cache.\n',
    'utf-8',
  );
  const out = path.join(dir, 'out');
  const s = startServer();
  try {
    const r = await s.send('tools/call', {
      name: 'convert',
      arguments: { source: file, target_dir: out, run_lint: false },
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.tier, 'pure');
    assert.ok(payload.written.some((f) => f.endsWith('SKILL.md')));
    assert.equal(payload.lint, null, 'run_lint=false → no lint field');
    const written = await fs.readdir(out);
    assert.ok(written.includes('SKILL.md'));
    assert.ok(written.includes('conversion-report.md'));
  } finally {
    await s.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server: convert on wrapped skill returns ok=false with reason', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-server-'));
  const file = path.join(dir, 'SKILL.md');
  await fs.writeFile(
    file,
    '---\nname: w\ndescription: "Uses pip."\n---\n\n# W\n\nRun `pip install foo`.\n',
    'utf-8',
  );
  const out = path.join(dir, 'out');
  const s = startServer();
  try {
    const r = await s.send('tools/call', {
      name: 'convert',
      arguments: { source: file, target_dir: out, run_lint: false },
    });
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.tier, 'wrapped');
  } finally {
    await s.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('server: unknown method returns JSON-RPC error', async () => {
  const s = startServer();
  try {
    await assert.rejects(
      s.send('tools/banana', {}),
      /Method not found/,
    );
  } finally {
    await s.stop();
  }
});
