import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getMiniMaxTrajectory,
  listMiniMaxSessions,
  previewText,
  resolveDataDir,
} from '../lib/trajectory.mjs';
import { handleRpc } from '../server.mjs';

test('resolves MiniMax data directory with explicit precedence', () => {
  assert.equal(
    resolveDataDir({ MINIMAX_DATA_DIR: '/tmp/minimax-a', MAVIS_DATA_DIR: '/tmp/mavis-b' }, '/home/test'),
    path.resolve('/tmp/minimax-a'),
  );
  assert.equal(
    resolveDataDir({ MAVIS_DATA_DIR: '/tmp/mavis-b' }, '/home/test'),
    path.resolve('/tmp/mavis-b'),
  );
  assert.equal(resolveDataDir({}, '/home/test'), path.resolve('/home/test/.minimax'));
});

test('lists recent sessions without returning content or paths', async () => {
  const dataDir = await makeDataDir();
  try {
    await writeSession(dataDir, 'older-session', 1_700_000_000_000, [
      ledgerEvent('older-session', 1, 'session.created', {
        record: sessionRecord('older-session', 'secret old title', '/private/old'),
      }),
    ]);
    await writeSession(dataDir, 'newer-session', 1_800_000_000_000, [
      ledgerEvent('newer-session', 1, 'session.created', {
        record: sessionRecord('newer-session', 'secret new title', '/private/new'),
      }),
    ]);

    const result = await listMiniMaxSessions({ dataDir, limit: 1 });
    assert.equal(result.returned, 1);
    assert.equal(result.discovered, 2);
    assert.equal(result.sessions[0].sessionId, 'newer-session');
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /secret|private|ledger\.jsonl/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('skips manifest-only sessions by default but reports their availability', async () => {
  const dataDir = await makeDataDir();
  try {
    await writeSession(dataDir, 'readable-session', 1_700_000_000_000, [
      ledgerEvent('readable-session', 1, 'session.deleted'),
    ]);
    const missingDir = await writeSession(dataDir, 'manifest-only-session', 1_800_000_000_000, []);
    await rm(path.join(missingDir, 'ledger.jsonl'));

    const listed = await listMiniMaxSessions({ dataDir });
    assert.equal(listed.discovered, 1);
    assert.equal(listed.unavailable, 1);
    assert.equal(listed.sessions[0].sessionId, 'readable-session');

    const latest = await getMiniMaxTrajectory({ dataDir });
    assert.equal(latest.session.sessionId, 'readable-session');
    await assert.rejects(
      getMiniMaxTrajectory({ dataDir, sessionId: 'manifest-only-session' }),
      /ledger_missing/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('summary trajectory exposes counts but no content, paths, tool payloads, or secrets', async () => {
  const dataDir = await makeDataDir();
  const sessionId = 'summary-session';
  try {
    await writeSession(dataDir, sessionId, 1_800_000_000_000, sampleEvents(sessionId, dataDir));
    const result = await getMiniMaxTrajectory({ dataDir, sessionId, detailLevel: 'summary' });

    assert.equal(result.privacy.contentPreviews, false);
    assert.equal(result.summary.finalDisplayMessageCount, 2);
    assert.equal(result.summary.displayToolCallCount, 1);
    assert.equal(result.summary.piToolCallCount, 1);
    assert.equal(result.summary.piToolResultCount, 1);
    assert.equal(result.summary.compactionCount, 1);
    assert.equal(result.summary.displayUsageTotalTokens, 42);
    assert.equal(result.summary.piUsageTotalTokens, 33);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /top secret prompt|supersecret|tool result secret|private-workspace/);
    assert.doesNotMatch(serialized, /tool_call_args|tool_call_result_data/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('full trajectory returns only bounded redacted previews and tool names', async () => {
  const dataDir = await makeDataDir();
  const sessionId = 'full-session';
  try {
    await writeSession(dataDir, sessionId, 1_800_000_000_000, sampleEvents(sessionId, dataDir));
    const result = await getMiniMaxTrajectory({ dataDir, sessionId, detailLevel: 'full' });
    const serialized = JSON.stringify(result);

    assert.equal(result.privacy.previewsAreRedacted, true);
    assert.match(serialized, /top secret prompt/);
    assert.match(serialized, /<REDACTED>/);
    assert.match(serialized, /read_file/);
    assert.match(serialized, /private-workspace/);
    assert.doesNotMatch(serialized, /supersecret/);
    assert.doesNotMatch(serialized, /tool result secret/);
    assert.doesNotMatch(serialized, /tool error secret/);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(dataDir)));
    assert.doesNotMatch(serialized, /thinking_content|chain of thought/);
    assert.ok(previewText('x'.repeat(900), dataDir).length <= 501);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('reports malformed complete lines, ignores an incomplete active tail, and keeps valid records', async () => {
  const dataDir = await makeDataDir();
  const sessionId = 'tail-session';
  try {
    const sessionDir = await writeSession(dataDir, sessionId, 1_800_000_000_000, [
      ledgerEvent(sessionId, 1, 'session.created', {
        record: sessionRecord(sessionId, 'title', '/workspace'),
      }),
    ]);
    const ledger = path.join(sessionDir, 'ledger.jsonl');
    const original = await readFile(ledger, 'utf8');
    await writeFile(ledger, `${original}{broken}\n{"schemaVersion":1`, 'utf8');

    const result = await getMiniMaxTrajectory({ dataDir, sessionId });
    assert.equal(result.summary.totalRecords, 1);
    assert.ok(result.warnings.includes('malformed_jsonl_line'));
    assert.ok(result.warnings.includes('incomplete_tail_ignored'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('caps oversized records and the number of returned event summaries', async () => {
  const dataDir = await makeDataDir();
  const sessionId = 'bounded-session';
  try {
    const events = Array.from({ length: 55 }, (_, index) =>
      ledgerEvent(sessionId, index + 1, 'session.snapshot_created', {
        snapshotId: `snapshot-${index + 1}`,
      }),
    );
    const sessionDir = await writeSession(dataDir, sessionId, 1_800_000_000_000, events);
    const ledger = path.join(sessionDir, 'ledger.jsonl');
    const original = await readFile(ledger, 'utf8');
    await writeFile(
      ledger,
      `${JSON.stringify(ledgerEvent(sessionId, 100, 'message.display_upserted', {
        message: { msg_id: 'huge', role: 'assistant', msg_content: 'x'.repeat(2 * 1024 * 1024) },
      }))}\n${original}`,
      'utf8',
    );

    const result = await getMiniMaxTrajectory({ dataDir, sessionId, maxRecords: 50 });
    assert.equal(result.summary.totalRecords, 55);
    assert.equal(result.summary.returnedRecords, 50);
    assert.equal(result.summary.truncated, true);
    assert.ok(result.warnings.includes('oversized_jsonl_line'));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rejects symlinked ledgers without reading their target', async (context) => {
  const dataDir = await makeDataDir();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'minimax-trajectory-outside-'));
  const sessionId = 'symlink-session';
  try {
    const sessionDir = await writeSession(dataDir, sessionId, 1_800_000_000_000, []);
    const outside = path.join(outsideDir, 'outside.jsonl');
    await writeFile(outside, `${JSON.stringify(ledgerEvent(sessionId, 1, 'session.deleted'))}\n`, 'utf8');
    await rm(path.join(sessionDir, 'ledger.jsonl'));
    try {
      await symlink(outside, path.join(sessionDir, 'ledger.jsonl'));
    } catch (error) {
      if (error?.code === 'EPERM') {
        context.skip('symlink creation is unavailable on this platform');
        return;
      }
      throw error;
    }
    await assert.rejects(
      getMiniMaxTrajectory({ dataDir, sessionId }),
      /symlink_artifact_rejected/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('handles MCP initialize, tool listing, calls, and unknown tools', async () => {
  const dataDir = await makeDataDir();
  try {
    await writeSession(dataDir, 'rpc-session', 1_800_000_000_000, [
      ledgerEvent('rpc-session', 1, 'session.deleted'),
    ]);
    const initialized = await handleRpc({ method: 'initialize', params: { protocolVersion: 'x' } });
    assert.equal(initialized.result.protocolVersion, 'x');
    const listed = await handleRpc({ method: 'tools/list' });
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      ['list_minimax_sessions', 'get_minimax_trajectory'],
    );
    const called = await handleRpc(
      { method: 'tools/call', params: { name: 'list_minimax_sessions', arguments: { limit: 1 } } },
      { dataDir },
    );
    assert.equal(called.result.structuredContent.sessions[0].sessionId, 'rpc-session');
    const missing = await handleRpc({ method: 'tools/call', params: { name: 'missing' } }, { dataDir });
    assert.equal(missing.result.isError, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('serves MCP requests over the configured stdio process boundary', async (context) => {
  const dataDir = await makeDataDir();
  try {
    await writeSession(dataDir, 'stdio-session', 1_800_000_000_000, [
      ledgerEvent('stdio-session', 1, 'session.deleted'),
    ]);
    const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, MINIMAX_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    context.after(() => {
      if (!child.killed) child.kill();
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end([
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'list_minimax_sessions', arguments: { limit: 1 } },
      }),
      '',
    ].join('\n'));

    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, stderr);
    const responses = stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(responses.map((response) => response.id), [1, 2, 3]);
    assert.equal(responses[0].result.serverInfo.name, 'minimax-code-trajectory');
    assert.equal(responses[1].result.tools.length, 2);
    assert.equal(
      responses[2].result.structuredContent.sessions[0].sessionId,
      'stdio-session',
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

async function makeDataDir() {
  return mkdtemp(path.join(os.tmpdir(), 'minimax-code-trajectory-'));
}

async function writeSession(dataDir, sessionId, updatedAtMs, events) {
  const sessionDir = path.join(
    dataDir,
    'v2',
    'sessions',
    '2026',
    '08',
    '15',
    `12-00-00-000-session_${Buffer.from(sessionId).toString('base64url')}`,
  );
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sessionId,
      createdAtMs: updatedAtMs - 1000,
      updatedAtMs,
      source: 'local-runtime',
      layout: 'v2-final-dated-session',
      paths: {},
    })}\n`,
    'utf8',
  );
  await writeFile(
    path.join(sessionDir, 'ledger.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''),
    'utf8',
  );
  return sessionDir;
}

function ledgerEvent(sessionId, seq, kind, extra = {}) {
  return {
    schemaVersion: 1,
    eventId: `event-${seq}`,
    sessionId,
    seq,
    createdAtMs: 1_800_000_000_000 + seq,
    kind,
    ...extra,
  };
}

function sessionRecord(sessionId, title, workspaceDir) {
  return {
    sessionId,
    agentName: 'mavis',
    workspaceDir,
    runtime: 'pi-agent',
    sessionType: 'root',
    archived: false,
    title,
    status: 'finished',
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_001_000,
  };
}

function sampleEvents(sessionId, dataDir) {
  return [
    ledgerEvent(sessionId, 1, 'session.created', {
      record: sessionRecord(sessionId, 'token=supersecret', path.join(dataDir, 'private-workspace')),
    }),
    ledgerEvent(sessionId, 2, 'message.display_upserted', {
      message: {
        msg_id: 'display-1',
        role: 'assistant',
        msg_content: 'top secret prompt token=supersecret',
        thinking_content: 'chain of thought',
        usage: { total_tokens: 42, context_window: 1000 },
        tool_calls: [
          {
            tool_name: 'read_file',
            tool_call_id: 'call-1',
            tool_call_args: '{"path":"/private/file"}',
            tool_call_result_data: 'tool result secret',
          },
        ],
      },
    }),
    ledgerEvent(sessionId, 3, 'message.display_upserted', {
      message: {
        msg_id: 'compaction-1',
        role: 'assistant',
        kind: 'compaction',
        msg_content: 'compacted private context',
      },
    }),
    ledgerEvent(sessionId, 4, 'message.pi_history_appended', {
      messages: [
        { role: 'user', content: 'top secret prompt', timestamp: 1 },
        {
          role: 'assistant',
          model: 'MiniMax-M2.5',
          stopReason: 'toolUse',
          timestamp: 2,
          usage: { totalTokens: 33 },
          content: [
            { type: 'text', text: 'token=supersecret' },
            { type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/private/file' } },
          ],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read_file',
          content: [{ type: 'text', text: 'tool result secret' }],
          errorMessage: 'tool error secret',
          isError: false,
          timestamp: 3,
        },
      ],
    }),
  ];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('stdio server did not exit after stdin closed'));
    }, 5000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
