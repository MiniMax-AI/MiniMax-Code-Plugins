import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openStore, resolveDataDir, resolveHomeDir, encodeFtsQuery } from '../server/store.mjs';
import { WARNINGS_MAX, resolveRedactRoots } from '../server/config.mjs';
import { resolveWorkspaceIdentity, gitChildEnv } from '../server/git.mjs';
import { redactValue, redactText, redactPath } from '../server/redact.mjs';
import { TOOLS, handleRpcMessage } from '../server/mcp.mjs';
import { ftsModuleAvailable } from '../server/sqlite.mjs';

/**
 * Whether this runtime's bundled SQLite has FTS5.
 *
 * The runtime's own index is an FTS5 virtual table, so a fixture that builds one
 * cannot be created without the module. A runtime without FTS5 is a *supported*
 * configuration rather than a failure — Node 22.13.0 through 22.18.x and every 23.x
 * bundle a SQLite without it — so the fixture omits the index there and the search
 * test skips itself, which leaves the rest of this suite free to prove that every
 * other read still works on those releases.
 */
const FTS5 = (() => {
  const probe = new DatabaseSync(':memory:');
  const available = ftsModuleAvailable(probe);
  probe.close();
  return available;
})();

/* ------------------------------------------------------------- fixtures -- */

// A deliberately synthetic home and workspace. Written this way so the packaged
// tests carry no path that looks like a real machine's (no /home/<user>, no
// /Users/<user>), which is a rule the package audit enforces.
const FIXTURE_HOME = '/tmp/trajectory-fixture-home';
const FIXTURE_WORKSPACE = `${FIXTURE_HOME}/ws`;

async function makeDataDir({ withSqlite = true, withJsonl = true } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-studio-'));
  const sqliteDir = path.join(dataDir, 'v2', 'sqlite');
  await mkdir(sqliteDir, { recursive: true });

  if (withSqlite) {
    const db = new DatabaseSync(path.join(sqliteDir, 'runtime-state.sqlite'));
    db.exec(`
      CREATE TABLE local_runtime_sessions (
        session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
        agent_name TEXT, session_type TEXT, status TEXT, archived INTEGER NOT NULL DEFAULT 0,
        visibility TEXT NOT NULL DEFAULT 'visible', session_kind TEXT NOT NULL DEFAULT 'unknown',
        parent_session_id TEXT, workspace_dir TEXT, title TEXT, created_at_ms INTEGER
      );
      CREATE TABLE local_runtime_message_rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
        role TEXT, turn_id TEXT, created_at_ms INTEGER NOT NULL, data_json TEXT NOT NULL,
        source TEXT, source_context_json TEXT, UNIQUE(session_id, msg_id)
      );
      CREATE TABLE local_runtime_background_tasks (
        task_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, kind TEXT NOT NULL,
        status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        ended_at_ms INTEGER, record_json TEXT NOT NULL
      );
      CREATE TABLE local_runtime_session_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, msg_id TEXT NOT NULL,
        role TEXT, message_created_at_ms INTEGER NOT NULL, asset_index INTEGER NOT NULL,
        asset_key TEXT NOT NULL, source_tag TEXT NOT NULL, path TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE local_runtime_session_agent_definitions (
        session_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL
      );
      ${FTS5 ? `CREATE VIRTUAL TABLE local_runtime_sessions_fts USING fts5(
        session_id UNINDEXED, session_id_terms, agent_name_terms, title_terms,
        workspace_dir_terms, purpose_terms, status_terms, session_type_terms,
        tokenize = 'unicode61'
      );` : ''}
    `);

    const session = (id, title, agent, updated, parent = null) => db.prepare(`
      INSERT INTO local_runtime_sessions
        (session_id, record_json, updated_at_ms, agent_name, status, session_kind, title, created_at_ms, parent_session_id, workspace_dir)
      VALUES (?, '{}', ?, ?, 'idle', 'conversation', ?, ?, ?, '${FIXTURE_WORKSPACE}')
    `).run(id, updated, agent, title, updated - 1000, parent);

    session('sess-a', 'Alpha task', 'mavis', 2000);
    session('sess-b', 'Beta subtask', 'explore', 1500, 'sess-a');
    session('sess-archived', 'Old task', 'mavis', 500);
    db.prepare('UPDATE local_runtime_sessions SET archived = 1 WHERE session_id = ?').run('sess-archived');

    // The FTS columns store `c<hex codepoint>` tokens.
    const encode = (text) => [...text].map((ch) => `c${ch.codePointAt(0).toString(16)}`).join(' ');
    for (const [id, title, agent] of (FTS5 ? [['sess-a', 'Alpha task', 'mavis'], ['sess-b', 'Beta subtask', 'explore']] : [])) {
      db.prepare(`
        INSERT INTO local_runtime_sessions_fts
          (session_id, session_id_terms, agent_name_terms, title_terms, workspace_dir_terms, purpose_terms, status_terms, session_type_terms)
        VALUES (?, ?, ?, ?, ?, '', 'idle', 'conversation')
      `).run(id, encode(id), encode(agent), encode(title), encode(FIXTURE_WORKSPACE));
    }

    const row = (sessionId, msgId, role, turnId, createdAtMs, data) => db.prepare(`
      INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, msgId, role, turnId, createdAtMs, JSON.stringify(data), data.source ?? null);

    row('sess-a', 'm1', 'user', 'turn-1', 1000, { msg_id: 'm1', role: 'user', source: 'api', msg_type: 1, msg_content: 'please fix the bug', turn_id: 'turn-1' });
    row('sess-a', 'm2', 'assistant', 'turn-1', 1200, {
      msg_id: 'm2', role: 'assistant', source: 'api', msg_type: 2, msg_content: 'looking at it',
      thinking_content: 'hmm', thinking_duration_ms: 200, finish_reason: 'toolUse',
      turn_id: 'turn-1', turnId: 'turn-1',
      usage: { input_tokens: 100, output_tokens: 50, cache_read: 900, total_tokens: 1050, context_window: 200000, request_duration_ms: 1500 },
      context_usage: { usedTokens: 1000, contextWindowTokens: 200000, totalCountSource: 'LOCAL_ESTIMATE', components: [{ kind: 'TOOLS', tokens: 400 }] },
      tool_calls: [{ tool_name: 'bash', tool_call_id: 'c1', tool_call_status: 2, tool_call_args: '{"command":"ls"}', tool_call_result_data: '{"text":"ok"}' }],
    });
    row('sess-a', 'm3', 'assistant', 'turn-2', 1400, {
      msg_id: 'm3', role: 'assistant', source: 'thread-goal', msg_type: 2, msg_content: 'done',
      turn_id: 'turn-2', turnId: 'turn-2',
      usage: { input_tokens: 10, output_tokens: 5, cache_read: 0, total_tokens: 15, context_window: 200000, request_duration_ms: 500 },
      tool_calls: [{ tool_name: 'edit', tool_call_id: 'c2', tool_call_status: 3, tool_call_args: '{}', tool_call_result_data: '{"error":"boom"}' }],
    });
    row('sess-a', 'm4', 'assistant', 'turn-2', 1500, {
      msg_id: 'm4', role: 'assistant', kind: 'compaction', msg_type: 2,
      turn_id: 'turn-2', turnId: 'turn-2',
      metadata: { compactionId: 'ctx-1', messagesBefore: 40, messagesAfter: 2, tokensBefore: 90000, tokensAfter: 5000 },
    });
    row('sess-a', 'm5', 'user', 'turn-3', 1600, {
      msg_id: 'm5', role: 'user', source: 'thread-goal', msg_type: 1, msg_content: 'injected objective',
      turn_id: 'turn-3', sourceContext: { origin: { type: 'thread-goal-kickoff', goalId: 'tg-1' } },
    });
    row('sess-a', 'm6', 'user', 'turn-4', 1700, {
      msg_id: 'm6', role: 'user', source: 'questionnaire', msg_type: 1, msg_content: 'a person answered',
      turn_id: 'turn-4',
    });

    db.prepare(`
      INSERT INTO local_runtime_session_agent_definitions (session_id, definition_json)
      VALUES ('sess-a', ?)
    `).run(JSON.stringify({
      definitionVersion: 2,
      exactOwnerName: 'worker',
      model: { providerId: 'minimax', modelId: 'MiniMax-M3', variant: 'thinking', contextWindow: 512000, maxOutputTokens: 128000 },
      project: { workspaceDir: FIXTURE_WORKSPACE },
      systemPrompt: 'You are a worker.',
      capabilities: { tools: ['read', 'bash'], disallowedTools: [], mcpServers: [], skills: ['a-skill'], extensionSkills: ['ext:b'] },
    }));

    db.prepare(`
      INSERT INTO local_runtime_background_tasks (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
      VALUES ('t1', 'sess-a', 'bash', 'succeeded', 1000, 1300, 1300,
              '{"description":"ls -la","toolCallId":"c1","metadata":{"command":"ls -la","parentTurnId":"turn-1"},"outputRef":{"uri":"/tmp/x.log"}}'),
             ('t2', 'sess-a', 'subagent', 'running', 1400, 1400, NULL,
              '{"description":"Map the call graph","metadata":{"agentName":"explore","childSessionId":"sess-b"}}')
    `).run();
    db.prepare(`
      INSERT INTO local_runtime_session_assets (session_id, msg_id, message_created_at_ms, asset_index, asset_key, source_tag, path, data_json)
      VALUES ('sess-a', 'm2', 1200, 0, 'k', 'media', '/tmp/a.png', '{}')
    `).run();
    db.close();

    const taskDir = path.join(dataDir, 'background-tasks', 't1');
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'output.log'), 'line one\nline two\nlisting complete\n', 'utf8');
  }

  if (withJsonl) {
    const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-jsonl');
    await mkdir(dir, { recursive: true });
    const lines = [
      { message_id: 'j1', turn_id: 'turn-j1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 10 } },
      {
        message_id: 'j2',
        turn_id: 'turn-j1',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'thinking hard' }, { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
          usage: { input: 5, output: 7, cacheRead: 0, totalTokens: 12 },
          stopReason: 'toolUse',
          timestamp: 20,
          model: 'MiniMax-M3',
        },
      },
    ];
    await writeFile(path.join(dir, 'messages.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  }

  return dataDir;
}

/* ------------------------------------------------------------- data dir -- */

test('the data directory resolves from env, then HOME, then USERPROFILE', () => {
  // The contract is that a configured directory is *resolved*, not passed through
  // verbatim, so every expectation is resolved the same way. Comparing against the
  // literal only holds on a POSIX host, where resolving is the identity.
  const home = path.resolve(FIXTURE_HOME);
  const under = (dir) => path.join(dir, '.minimax');
  // An explicit environment variable wins, MINIMAX before MAVIS.
  assert.equal(resolveDataDir({ MINIMAX_DATA_DIR: '/tmp/a' }, FIXTURE_HOME), path.resolve('/tmp/a'));
  assert.equal(resolveDataDir({ MAVIS_DATA_DIR: '/tmp/b' }, FIXTURE_HOME), path.resolve('/tmp/b'));
  assert.equal(
    resolveDataDir({ MINIMAX_DATA_DIR: '/tmp/a', MAVIS_DATA_DIR: '/tmp/b' }, FIXTURE_HOME),
    path.resolve('/tmp/a'),
  );
  // Then the home directory from the environment, then the passed one.
  assert.equal(resolveDataDir({ HOME: FIXTURE_HOME }), under(home));
  assert.equal(resolveDataDir({}, FIXTURE_HOME), under(home));
  // USERPROFILE is what Windows actually sets, so it has to work on its own.
  assert.equal(resolveDataDir({ USERPROFILE: FIXTURE_HOME }), under(home));
  assert.equal(resolveHomeDir({ USERPROFILE: FIXTURE_HOME }), home);
  // A blank value is not a value.
  assert.equal(resolveDataDir({ MINIMAX_DATA_DIR: '   ', USERPROFILE: FIXTURE_HOME }), path.join(path.resolve(FIXTURE_HOME), '.minimax'));
  assert.equal(resolveHomeDir({ HOME: '  ' }), null);
  assert.throws(() => resolveDataDir({}, ''), /MINIMAX_DATA_DIR|HOME/);
});

test('encodeFtsQuery mirrors the runtime token encoding', () => {
  assert.equal(encodeFtsQuery('mavis'), 'c6d c61 c76 c69 c73');
  assert.equal(encodeFtsQuery('轨迹'), 'c8f68 c8ff9');
  assert.equal(encodeFtsQuery(''), '');
});

/* ---------------------------------------------------------------- store -- */

test('listSessions hides archived rows and reports metadata', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const sessions = store.listSessions({ limit: 10 });
  assert.deepEqual(sessions.map((s) => s.sessionId), ['sess-a', 'sess-b']);
  assert.equal(sessions[0].title, 'Alpha task');
  assert.equal(sessions[0].agent, 'mavis');
  assert.equal(store.listSessions({ limit: 10, includeArchived: true }).length, 3);
  assert.deepEqual(store.listSessions({ limit: 10, agent: 'explore' }).map((s) => s.sessionId), ['sess-b']);
});

test('getStats folds the dsh sessionStats fields', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const stats = store.getStats('sess-a');
  assert.equal(stats.turns, 4, 'four distinct turn IDs');
  assert.equal(stats.steps, 2, 'two records carrying request_duration_ms');
  assert.equal(stats.llmMs, 2000);
  assert.equal(stats.thinkingMs, 200);
  assert.equal(stats.decodeMs, 1800, 'llmMs - thinkingMs');
  assert.equal(stats.decodeTokens, 55);
  assert.equal(stats.inputTokens, 110);
  assert.equal(stats.cacheReadTokens, 900);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolFailures, 1, 'status 3 is not a success');
  assert.equal(stats.compactions, 1);
  assert.equal(stats.assets, 1);
  assert.equal(stats.backgroundTasks, 2);
  assert.equal(stats.subagentTasks, 1);
  assert.equal(stats.ttftMs, null, 'ttft is never fabricated');
  assert.equal(stats.ttftAvailable, false);
  assert.equal(stats.children, 1, 'sess-b is a child of sess-a');
  assert.deepEqual(stats.sources.map((s) => s.source).sort(), ['api', 'questionnaire', 'thread-goal']);
});

test('tool wall-clock is summed from background tasks', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const tasks = store.listBackgroundTasks('sess-a');
  assert.equal(tasks.length, 2);
  assert.equal(tasks.find((task) => task.taskId === 't1').durationMs, 300);
  assert.equal(store.getStats('sess-a').toolMs, 300, 'running task has no ended_at_ms');
});

test('tasks carry description, agent, child session and output availability', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const tasks = store.listBackgroundTasks('sess-a');
  const bash = tasks.find((task) => task.taskId === 't1');
  assert.equal(bash.description, 'ls -la');
  assert.equal(bash.command, 'ls -la');
  assert.equal(bash.toolCallId, 'c1');
  assert.equal(bash.parentTurnId, 'turn-1');
  assert.equal(bash.hasOutput, true);
  assert.equal(bash.status, 'succeeded');

  const sub = tasks.find((task) => task.taskId === 't2');
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.agentName, 'explore');
  assert.equal(sub.childSessionId, 'sess-b', 'sub-agent tasks link to their child session');
  assert.equal(sub.hasOutput, false);

  assert.deepEqual(store.listBackgroundTasks('sess-a', { kind: 'subagent' }).map((task) => task.taskId), ['t2']);
});

test('task output is read as a bounded tail and rejects unsafe ids', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const output = await store.readTaskOutput('t1');
  assert.equal(output.available, true);
  assert.match(output.text, /listing complete/);

  const tail = await store.readTaskOutput('t1', { maxBytes: 256 });
  assert.equal(tail.available, true);
  assert.equal(tail.truncated, false, 'file is smaller than the floor of 256 bytes');

  const missing = await store.readTaskOutput('t_missing');
  assert.equal(missing.available, false);
  assert.equal(missing.text, '');

  for (const bad of ['../../etc/passwd', 'a/b', '', 'x'.repeat(200)]) {
    await assert.rejects(() => store.readTaskOutput(bad), /invalid_task_id/);
  }
});

test('child sessions are listed for drill-down', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.deepEqual(store.listChildSessions('sess-a').map((session) => session.sessionId), ['sess-b']);
  assert.deepEqual(store.listChildSessions('sess-b'), []);
});

test('getEvents omits content in summary mode and includes it in full mode', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const summary = store.getEvents({ sessionId: 'sess-a', detailLevel: 'summary' });
  assert.equal(summary.total, 6);
  assert.equal(summary.source, 'sqlite');
  const withTools = summary.events.find((event) => event.toolCallCount > 0);
  assert.equal(withTools.content, undefined, 'summary must not leak text');
  assert.equal(withTools.toolCalls[0].args, undefined, 'summary must not leak tool args');
  assert.equal(withTools.toolCalls[0].result, undefined);
  assert.equal(withTools.toolCalls[0].name, 'bash', 'summary still reports tool names');
  assert.equal(withTools.usage.inputTokens, 100);
  assert.equal(withTools.contextUsage.components[0].kind, 'TOOLS');

  const full = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' });
  const fullEvent = full.events.find((event) => event.msgId === 'm2');
  assert.equal(fullEvent.content, 'looking at it');
  assert.equal(fullEvent.thinking, 'hmm');
  assert.equal(fullEvent.toolCalls[0].args, '{"command":"ls"}');
  assert.equal(fullEvent.toolCalls[0].result, '{"text":"ok"}');
});

test('getEvents paginates and filters by turn', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const first = store.getEvents({ sessionId: 'sess-a', limit: 2 });
  assert.equal(first.events.length, 2);
  assert.equal(first.nextOffset, 2);
  const second = store.getEvents({ sessionId: 'sess-a', offset: first.nextOffset, limit: 2 });
  assert.equal(second.events.length, 2);
  assert.equal(second.nextOffset, 4, 'four of six records consumed');
  const third = store.getEvents({ sessionId: 'sess-a', offset: second.nextOffset, limit: 2 });
  assert.equal(third.events.length, 2);
  assert.equal(third.nextOffset, null, 'no more pages');

  const turn2 = store.getEvents({ sessionId: 'sess-a', turnId: 'turn-2' });
  assert.deepEqual(turn2.events.map((event) => event.msgId), ['m3', 'm4']);
});

test('compaction records carry their metadata', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const full = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' });
  const compaction = full.events.find((event) => event.kind === 'compaction');
  assert.equal(compaction.metadata.messagesBefore, 40);
  assert.equal(compaction.metadata.tokensBefore, 90000);
});

test('searchSessions uses the runtime token encoding', { skip: FTS5 ? false : 'this runtime\'s SQLite has no FTS5' }, async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(store.hasFts, true);
  assert.deepEqual(store.searchSessions({ query: 'Alpha' }).map((s) => s.sessionId), ['sess-a']);
  assert.deepEqual(store.searchSessions({ query: 'mavis' }).map((s) => s.sessionId), ['sess-a']);
  assert.deepEqual(store.searchSessions({ query: 'nope-not-here' }), []);
});

test('a missing SQLite projection degrades instead of throwing', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: false });
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(store.db, null);
  assert.equal(store.hasFts, false);
  assert.deepEqual(store.listSessions(), []);
  assert.equal(store.getStats('sess-a'), null);
  assert.deepEqual(store.getEvents({ sessionId: 'sess-a' }).events, []);
  assert.deepEqual(store.searchSessions({ query: 'x' }), []);
  assert.ok(store.warnings.some((warning) => warning.startsWith('sqlite_unavailable:')));
});

test('jsonl fallback reads a session the projection does not index', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: true, withJsonl: true });
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const dir = await store.findSessionDir('sess-jsonl');
  assert.ok(dir, 'session directory is located by suffix');

  const summary = await store.readJsonlEvents({ sessionId: 'sess-jsonl', detailLevel: 'summary' });
  assert.equal(summary.source, 'jsonl');
  assert.equal(summary.events.length, 2);
  assert.equal(summary.events[1].toolCalls[0].name, 'bash');
  assert.equal(summary.events[1].content, undefined);

  const full = await store.readJsonlEvents({ sessionId: 'sess-jsonl', detailLevel: 'full' });
  assert.equal(full.events[0].content, 'hi');
  assert.equal(full.events[1].thinking, 'thinking hard');
  assert.equal(full.events[1].model, 'MiniMax-M3');
});

test('session directory lookup rejects traversal attempts', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(await store.findSessionDir('../../etc/passwd'), null);
  assert.equal(await store.findSessionDir('a/b'), null);
  assert.equal(await store.findSessionDir(''), null);
});

/* --------------------------------------------------- dimensions & joins -- */

test('human input is distinguished from harness-injected context', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const events = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' }).events;
  const byId = new Map(events.map((event) => [event.msgId, event]));

  assert.equal(byId.get('m1').inputKind, 'human', 'a plain api user message is human');
  assert.equal(byId.get('m5').inputKind, 'injected', 'a goal objective is injected');
  assert.equal(byId.get('m5').originType, 'thread-goal-kickoff');
  assert.equal(byId.get('m5').goalId, 'tg-1');
  assert.equal(byId.get('m6').inputKind, 'human', 'a questionnaire answer is still the person');
  assert.equal(byId.get('m2').inputKind, null, 'an assistant row has no input doorway');
});

test('tool calls are joined to their measured task duration', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const events = store.getEvents({ sessionId: 'sess-a', detailLevel: 'full' }).events;
  const call = events.find((event) => event.msgId === 'm2').toolCalls[0];
  assert.equal(call.id, 'c1');
  assert.equal(call.ok, true);
  assert.equal(call.durationMs, 300, 'joined from the background task by tool call id');
  assert.equal(call.taskId, 't1');
  assert.equal(call.taskStatus, 'succeeded');
  assert.equal(call.hasOutput, true);
  assert.equal(call.description, 'ls -la');

  const failing = events.find((event) => event.msgId === 'm3').toolCalls[0];
  assert.equal(failing.ok, false, 'status 3 is a failure');
  assert.equal(failing.durationMs, null, 'no task means no measured duration, never estimated');
  assert.equal(events.find((event) => event.msgId === 'm3').failureCount, 1);
});

test('agent definition exposes model, capabilities and prompt', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const agent = store.getAgentDefinition('sess-a');
  assert.equal(agent.ownerName, 'worker');
  assert.equal(agent.model.modelId, 'MiniMax-M3');
  assert.equal(agent.model.contextWindow, 512000);
  assert.deepEqual(agent.tools, ['read', 'bash']);
  assert.deepEqual(agent.skills, ['a-skill']);
  assert.deepEqual(agent.extensionSkills, ['ext:b']);
  assert.equal(agent.systemPrompt, 'You are a worker.');
  assert.equal(store.getAgentDefinition('sess-b'), null, 'no definition is not an error');
});

test('workspaces group by git repository so worktrees merge', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'trajectory-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const git = (args, cwd = repo) => new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 15000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } },
      (error) => resolve(!error));
  });

  const available = await git(['init', '-q', '-b', 'main']);
  if (!available) {
    t.skip('git is not available in this environment');
    return;
  }
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-qm', 'init']);

  const worktree = path.join(root, 'wt');
  const madeWorktree = await git(['worktree', 'add', '-q', '-b', 'feature', worktree]);

  const main = await resolveWorkspaceIdentity(repo);
  assert.equal(main.kind, 'git');
  assert.equal(main.label, 'repo');
  assert.equal(main.worktree, false);

  if (madeWorktree) {
    const linked = await resolveWorkspaceIdentity(worktree);
    assert.equal(linked.key, main.key, 'a worktree shares its repository group');
    assert.equal(linked.worktree, true);
    assert.equal(linked.branch, 'feature');
  }

  const outside = path.join(root, 'plain');
  await mkdir(outside, { recursive: true });
  const plain = await resolveWorkspaceIdentity(outside);
  assert.equal(plain.kind, 'path', 'a non-repository directory falls back to path grouping');
  assert.notEqual(plain.key, main.key);

  assert.equal((await resolveWorkspaceIdentity('')).kind, 'path');
});

test('the git probe receives an allowlisted environment, not the whole process', () => {
  // The probe runs on a directory that came out of session data. Handing it the whole
  // `process.env` passed every credential the host exports into a child process that
  // needs none of them — so the test plants two and asserts neither arrives, then
  // pins the exact key set so a future `...process.env` cannot creep back in.
  const SYNTHETIC = 'TRAJECTORY_CANARY_TOKEN';
  const previous = { [SYNTHETIC]: process.env[SYNTHETIC], AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY };
  process.env[SYNTHETIC] = 'CANARY-git-env-9f31';
  process.env.AWS_SECRET_ACCESS_KEY = 'CANARY-aws-secret-9f31';
  try {
    const env = gitChildEnv();
    assert.equal(SYNTHETIC in env, false, 'the child inherited an arbitrary environment variable');
    assert.equal('AWS_SECRET_ACCESS_KEY' in env, false, 'the child inherited a credential');

    const expected = new Set([
      'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT',
      'WINDIR', 'LANG', 'LC_ALL',
      'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS',
      'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PAGER',
    ]);
    for (const key of Object.keys(env)) {
      assert.ok(expected.has(key), `unexpected key in the git child environment: ${key}`);
    }
    // Fixed regardless of any config file, and never inherited from the host.
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_ASKPASS, '');
    assert.equal(env.SSH_ASKPASS, '');
    // PATH has to survive or `git` cannot be resolved at all; the worktree test above
    // is the positive control that the restricted environment still runs real git.
    assert.ok(env.PATH, 'PATH was dropped, so git could not be found');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('annotateWorkspaces labels every session with its group', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const annotated = await store.annotateWorkspaces(store.listSessions({ limit: 10 }));
  assert.equal(annotated.length, 2);
  for (const session of annotated) {
    assert.ok(session.groupKey, 'every session gets a group key');
    assert.ok(session.groupLabel, 'every session gets a human label');
    assert.ok(['git', 'path'].includes(session.groupKind));
  }
});

test('turn summaries are folded server-side for the whole session', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const turns = store.getTurnSummaries('sess-a');
  assert.deepEqual(turns.map((turn) => turn.turnId), ['turn-1', 'turn-2', 'turn-3', 'turn-4']);
  const first = turns[0];
  assert.equal(first.count, 2, 'a user row and an assistant row');
  assert.equal(first.llmMs, 1500, 'only the assistant row carries a request duration');
  assert.equal(first.outputTokens, 50);
  assert.equal(turns[1].llmMs, 500);
});

test('turn summaries never come back with a null turn id', async (t) => {
  // `local_runtime_message_rows` has a real `turn_id` column. Aliasing the JSON
  // expression to that same name makes the driver return the column instead and
  // silently yields nulls, which broke the "第 N 轮" ordinal in the UI.
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const turns = store.getTurnSummaries('sess-a');
  assert.ok(turns.length > 0);
  for (const turn of turns) {
    assert.ok(turn.turnId, `turn id must not be null (got ${JSON.stringify(turn)})`);
  }
  assert.deepEqual(turns.map((turn) => turn.turnId), ['turn-1', 'turn-2', 'turn-3', 'turn-4']);
});

test('timeline points keep their json role and source, not the shadowed columns', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const points = store.getTimeline('sess-a');
  assert.equal(points.length, 6);
  assert.equal(points[0].role, 'user');
  assert.equal(points[0].source, 'api');
  assert.equal(points[1].role, 'assistant');
  assert.equal(points[1].durationMs, 1500);
  assert.equal(points[1].thinkingMs, 200);
  const injected = points.find((point) => point.source === 'thread-goal');
  assert.equal(injected.injected, true, 'goal-injected records are flagged for the axis');
  assert.equal(points.find((point) => point.kind === 'compaction').kind, 'compaction');
});

test('agent options are read from the data, not hard-coded', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const agents = store.listAgents();
  assert.deepEqual(agents, [{ name: 'mavis', count: 2 }, { name: 'explore', count: 1 }],
    'distinct agents with session counts, most frequent first');
});

test('a single session can be looked up by id for the highlight', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const session = store.getSession('sess-b');
  assert.equal(session.sessionId, 'sess-b');
  const annotated = await store.annotateWorkspaces([session]);
  assert.equal(annotated.length, 1);
  assert.ok(annotated[0].groupKey);
});

/* ------------------------------------------------------------- redaction -- */

test('redactText removes credentials and bounds length', () => {
  assert.match(redactText('api_key=abcdef123456'), /api_key=\[redacted\]/);
  assert.match(redactText('Authorization: Bearer abcdefghijklmnop'), /\[redacted\]/);
  assert.doesNotMatch(redactText('sk-abcdefghijklmnopqrst'), /sk-abcdefghijklmnopqrst/);
  assert.match(redactText('postgres://user:pw@host/db'), /\[redacted\]/);
  const long = redactText('x'.repeat(100), { maxLength: 10 });
  assert.ok(long.startsWith('xxxxxxxxxx'));
  assert.match(long, /truncated 90 chars/);
});

test('redactValue scrubs nested secrets by key name', () => {
  const value = redactValue({ command: 'ls', env: { API_KEY: 'secret', nested: { token: 'abc' } } });
  assert.equal(value.command, 'ls');
  assert.equal(value.env.API_KEY, '[redacted]');
  assert.equal(value.env.nested.token, '[redacted]');
});

test('redactPath collapses the home prefix', () => {
  assert.equal(redactPath(`${FIXTURE_WORKSPACE}/x`, { homeDir: FIXTURE_HOME }), '~/ws/x');
  assert.equal(redactPath('/opt/other', { homeDir: '/home/tester' }), '/opt/other');
});

/* ---------------------------------------------------------------- bounds -- */

test('a row past the per-record byte cap is reported, not parsed whole', async (t) => {
  // The JSONL fallback has always had a per-line cap; the SQLite read had none, so
  // one multi-megabyte row was materialised as a string and parsed. The bound is
  // exercised at 512 bytes here rather than 8 MiB, because the property under test
  // is the accounting, not the constant.
  const dataDir = await makeDataDir();
  const huge = JSON.stringify({
    msg_id: 'm-huge', role: 'assistant', source: 'api', msg_type: 2,
    turn_id: 'turn-1', msg_content: 'y'.repeat(4096),
  });
  const writable = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  writable.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-a', 'm-huge', 'assistant', 'turn-1', 5000, huge, 'api');
  writable.close();

  const store = openStore({ dataDir });
  // Close, then remove, in one hook. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order — a removal registered ahead
  // of the close takes the projection while SQLite still holds it.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const page = store.getEvents({ sessionId: 'sess-a', limit: 500, maxJsonBytes: 2048 });
  const oversized = page.events.find((event) => event.oversized === true);
  assert.ok(oversized, `no record was reported as oversized: ${JSON.stringify(page.events.map((e) => e.rowId))}`);
  // Bytes, not characters — `huge` is ASCII so the two agree here, and the test
  // below is the one that separates them.
  assert.equal(oversized.bytes, Buffer.byteLength(huge, 'utf8'));
  assert.equal(oversized.msgId, null, 'an oversized row must not pretend to have content');
  // The row still occupies its slot, so indices and `total` keep lining up.
  assert.equal(page.events.length, page.total);
  assert.equal(page.events.filter((event) => event.oversized).length, 1);
  // The ordinary rows are untouched by the presence of one oversized sibling.
  assert.ok(page.events.some((event) => event.contentLength > 0), 'the other records lost their summary');
  assert.ok(store.warnings.some((entry) => entry.startsWith('events_oversized:')), 'no warning was recorded');
});

/**
 * The cap is in bytes; `length()` on a TEXT column counts characters.
 *
 * So the size test was satisfied by a row four times larger than its budget, which
 * was then materialised as a JavaScript string and parsed in full — the cap refusing
 * the 8 MiB ASCII case while waving through the 2 MiB emoji case. The row below is
 * 1000 characters, 4000 bytes, against a 2048-byte cap: under the old rule it
 * passed and came back whole, under the byte rule it is an oversized record.
 *
 * `bytes` is asserted in bytes for the same reason — the reported count is what a
 * reader compares against the limit.
 */
test('the per-record cap counts UTF-8 bytes, not characters', async (t) => {
  const dataDir = await makeDataDir();
  const payload = JSON.stringify({
    msg_id: 'm-multibyte', role: 'assistant', source: 'api', msg_type: 2,
    turn_id: 'turn-1', msg_content: '😀'.repeat(1000),
  });
  // Counted in code points, because that is what SQLite's `length()` on a TEXT
  // column counts — a JS `.length` counts UTF-16 units and would overstate this row
  // by one unit per astral character, which is exactly the confusion the fix is about.
  const chars = [...payload].length;
  const bytes = Buffer.byteLength(payload, 'utf8');
  assert.ok(bytes > chars * 2, `the fixture is not multibyte: ${chars} chars / ${bytes} bytes`);
  const cap = 2048;
  assert.ok(chars <= cap, `the row must pass a character count, or this proves nothing: ${chars}`);
  assert.ok(bytes > cap, 'the row must fail a byte count');

  const writable = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  writable.prepare(
    `INSERT INTO local_runtime_message_rows (session_id, msg_id, role, turn_id, created_at_ms, data_json, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('sess-a', 'm-multibyte', 'assistant', 'turn-1', 5100, payload, 'api');
  writable.close();

  const store = openStore({ dataDir });
  // Close, then remove, in one hook. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order — a removal registered ahead
  // of the close takes the projection while SQLite still holds it.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const page = store.getEvents({ sessionId: 'sess-a', limit: 500, maxJsonBytes: cap });
  const oversized = page.events.find((event) => event.msgId === null || event.oversized === true);
  assert.ok(oversized?.oversized === true, 'a multibyte row past the byte cap was returned whole');
  assert.equal(oversized.bytes, bytes, 'the reported size is not the byte size');
  assert.equal(oversized.contentLength, 0, 'an oversized row must not report parsed content');
});

/**
 * A file with more records than one page holds must not report itself complete.
 *
 * The fallback read from the top of the artifact on every call and the caller
 * discarded the cursor, so a 5,000-record session answered one 1,000-record page and
 * `nextOffset: null` — the last 4,000 records were unreachable through HTTP and MCP
 * alike. The cursor now pages the artifact, and one record of look-ahead is what
 * distinguishes "the file ends here" from "there is more".
 */
test('the jsonl fallback pages to the end of the artifact', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: true, withJsonl: false });
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-page');
  await mkdir(dir, { recursive: true });
  const RECORDS = 25;
  const lines = Array.from({ length: RECORDS }, (_, i) => JSON.stringify({
    message_id: `j${i}`,
    turn_id: `turn-${Math.floor(i / 5)}`,
    message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `record ${i}` }], timestamp: i },
  }));
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.join('\n')}\n`, 'utf8');

  const store = openStore({ dataDir });
  // Close, then remove, in one hook. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order — a removal registered ahead
  // of the close takes the projection while SQLite still holds it.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const seen = [];
  let offset = 0;
  let lastPage = 0;
  for (let page = 0; page < 10; page += 1) {
    const result = await store.readJsonlEvents({ sessionId: 'sess-page', offset, limit: 10 });
    assert.equal(result.source, 'jsonl');
    assert.equal(result.events.length, Math.min(10, RECORDS - offset), 'the page is not full');
    lastPage = result.events.length;
    for (const event of result.events) seen.push(event.index);
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset, `the cursor did not advance: ${offset} -> ${result.nextOffset}`);
    offset = result.nextOffset;
  }
  assert.deepEqual(seen, Array.from({ length: RECORDS }, (_, i) => i), 'paging skipped or repeated records');
  assert.equal(offset + lastPage, RECORDS, 'the last page did not end exactly at the end of the file');

  // A page past the end is empty and terminates, rather than restarting the file.
  const past = await store.readJsonlEvents({ sessionId: 'sess-page', offset: RECORDS, limit: 10 });
  assert.equal(past.events.length, 0);
  assert.equal(past.nextOffset, null);
  assert.equal(past.total, null, 'the fold stops early, so it does not claim a total it never counted');

  // A session the projection has not indexed still pages through the HTTP route.
  const last = await store.readJsonlEvents({ sessionId: 'sess-page', offset: RECORDS - 3, limit: 10 });
  assert.equal(last.events.length, 3);
  assert.equal(last.nextOffset, null, 'the final page must terminate');
});

test('the jsonl fallback reports lines dropped at the per-line cap', async (t) => {
  const dataDir = await makeDataDir({ withSqlite: true, withJsonl: false });
  const dir = path.join(dataDir, 'v2', 'sessions', '2026', '09', '18', '10-00-00-000-sess-drop');
  await mkdir(dir, { recursive: true });
  const line = (i) => JSON.stringify({ message_id: `j${i}`, message: { role: 'user', content: [{ type: 'text', text: `r${i}` }] } });
  // A real line past the 2 MiB cap, so the production path is exercised rather than
  // a knob only the test knows about. It is unparseable JSON too, which is what a
  // truncated write looks like — and the point is that the drop is *reported*
  // instead of the file quietly reading one record shorter than it is.
  const oversized = 'z'.repeat(2 * 1024 * 1024 + 64);
  await writeFile(
    path.join(dir, 'messages.jsonl'),
    `${line(0)}\n${oversized}\n${line(1)}\n`,
    'utf8',
  );

  const store = openStore({ dataDir });
  // Close, then remove, in one hook. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order — a removal registered ahead
  // of the close takes the projection while SQLite still holds it.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const result = await store.readJsonlEvents({ sessionId: 'sess-drop', limit: 10 });
  assert.equal(result.droppedOversized, 1, 'the dropped line was not reported');
  assert.equal(result.events.length, 2, 'a dropped line must not take the next one with it');
  assert.equal(JSON.stringify(result).includes(oversized.slice(0, 64)), false, 'the oversized line leaked');
});

test('the warning list is bounded and reports what it dropped', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  // One hook, closing before removing. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order, so a removal registered ahead
  // of the close takes the projection while SQLite still holds it — EBUSY, reported
  // as a hook failure on a test that never failed on Linux.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const before = store.warnings.length;
  const total = WARNINGS_MAX * 3;
  for (let index = 0; index < total; index += 1) store.warn(`synthetic_${index}`);
  assert.equal(store.warnings.length, WARNINGS_MAX, 'the list grew without bound');
  assert.equal(store.warnings.at(-1), `synthetic_${total - 1}`, 'the newest warning was dropped');
  assert.equal(store.warningsDropped, before + total - WARNINGS_MAX, 'the drop was not accounted for');
});

test('the folded roots always include the data directory, and parse the extra list', () => {
  // A deployment that puts the data directory outside the home directory — a
  // container, a CI runner, a mounted volume — would otherwise have its one
  // deliberately-named absolute path leave verbatim in `/api/meta` and in the
  // `sqlite_discovered:` warning.
  const dataDir = path.join(tmpdir(), 'roots-data');
  const extra = ['', '/one', '  /two  '].join(path.delimiter);
  assert.deepEqual(resolveRedactRoots({ MCODE_TRAJECTORY_REDACT_ROOTS: extra }, dataDir), [dataDir, '/one', '/two']);

  // A root that is a single separator would rewrite every path separator in a
  // payload, so it is refused rather than folded.
  assert.deepEqual(resolveRedactRoots({}, '/'), []);
  assert.deepEqual(resolveRedactRoots({ MCODE_TRAJECTORY_REDACT_ROOTS: '/' }, undefined), []);
  assert.deepEqual(resolveRedactRoots({}, undefined), []);
});

/* ------------------------------------------------------------------- mcp -- */

test('tools are declared with the expected names and bounded schemas', () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), [
    'trajectory_list', 'trajectory_summary', 'trajectory_get', 'trajectory_search',
    'trajectory_tasks', 'trajectory_task_output', 'trajectory_studio',
  ]);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`);
  }
});

test('handleRpcMessage answers initialize, tools/list and tool calls', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };
  const handler = { call: (name, args) => callHandlerForTest({ store, studio }, name, args) };

  const init = handleRpcMessage(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(init.result.serverInfo.name, 'mcode-trajectory-studio');

  const list = handleRpcMessage(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.result.tools.length, 7);

  const notif = handleRpcMessage(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif, null, 'notifications are not answered');

  const unknown = handleRpcMessage(handler, { jsonrpc: '2.0', id: 3, method: 'nope' });
  assert.equal(unknown.error.code, -32601);

  const summary = await handleRpcMessage(handler, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'trajectory_summary', arguments: { sessionId: 'sess-a' } },
  });
  assert.equal(summary.result.structuredContent.turns, 4);
  assert.equal(summary.result.structuredContent.ttftMs, null);
});

test('full detail over MCP is redacted', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  t.after(async () => {
    // Close before removing. Windows refuses to unlink a file that is still open,
    // so registering the removal first passed on POSIX and failed on every other
    // platform with EBUSY.
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };
  const handler = { call: (name, args) => callHandlerForTest({ store, studio }, name, args) };

  const response = await handleRpcMessage(handler, {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'trajectory_get', arguments: { sessionId: 'sess-a', detailLevel: 'full' } },
  });
  const events = response.result.structuredContent.events;
  assert.ok(events.every((event) => typeof event.content !== 'string' || !/api[_-]?key\s*[:=]/i.test(event.content)));
  assert.equal(response.result.structuredContent.detailLevel, 'full');
});

/**
 * The event list had a frame budget and the task list did not.
 *
 * `trajectory_tasks` accepts `limit: 2000` and every task carries a `description`
 * that is, for a `bash` task, its full command line — so the "bounded" tool could
 * answer roughly 32 MB in one result, doubled again by `structuredContent`. The
 * aggregate bound now applies to every record-list tool, and the loss is reported
 * rather than passing as a complete list.
 */
test('trajectory_tasks is bounded by the frame budget, not only by limit', async (t) => {
  const dataDir = await makeDataDir();
  const writable = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insert = writable.prepare(`
    INSERT INTO local_runtime_background_tasks (task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, record_json)
    VALUES (?, 'sess-a', 'bash', 'completed', ?, ?, ?, ?)
  `);
  // Each description is swept at the source and truncated to the per-string bound, so
  // a task costs ~4 KB in the reply whatever it was stored with. 800 of them is well
  // past the 2 MB record budget — which is the point: `limit` is not what bounds this.
  const COUNT = 800;
  writable.exec('BEGIN');
  for (let i = 0; i < COUNT; i += 1) {
    insert.run(`bulk-${i}`, 1000 + i, 1100 + i, 1100 + i, JSON.stringify({ description: 'x'.repeat(8 * 1024) }));
  }
  writable.exec('COMMIT');
  writable.close();

  const store = openStore({ dataDir });
  // Close, then remove, in one hook. Windows refuses to unlink a file that is still
  // open, and `after` hooks run in registration order — a removal registered ahead
  // of the close takes the projection while SQLite still holds it.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };

  const response = await handleRpcMessage(
    { call: (name, args) => callHandlerForTest({ store, studio }, name, args) },
    {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'trajectory_tasks', arguments: { sessionId: 'sess-a', limit: 2000 } },
    },
  );
  const body = response.result.structuredContent;
  assert.equal(body.truncated, true, 'a trimmed task list must report itself as truncated');
  assert.ok(body.omitted > 0, 'nothing was reported as omitted');
  assert.equal(body.returned, body.tasks.length, 'the count and the list disagree');
  // Plus the two tasks the base fixture already owns.
  assert.equal(body.returned + body.omitted, COUNT + 2, 'the accounting does not add up');
  assert.ok(body.tasks.length < COUNT, `the list was not trimmed: ${body.tasks.length}`);
  // The whole reply carries the payload twice, so the frame is bounded at twice the
  // record budget rather than twice the event page's.
  const frame = JSON.stringify(response.result);
  assert.ok(frame.length <= 8 * 1024 * 1024, `the frame exceeded its budget: ${frame.length}`);
});

test('a small task list is returned whole, with no false truncation', async (t) => {
  const dataDir = await makeDataDir();
  const store = openStore({ dataDir });
  // Closing before removing, in one hook: `after` hooks run in registration order,
  // so a removal registered ahead of the close unlinks the projection while SQLite
  // still holds it. Windows answers EBUSY; Linux does not, which is how this passed
  // for as long as it did.
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const studio = { start: async () => ({ url: 'http://127.0.0.1:1/', port: 1, reused: false }), stop: async () => true };

  const response = await handleRpcMessage(
    { call: (name, args) => callHandlerForTest({ store, studio }, name, args) },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'trajectory_tasks', arguments: { sessionId: 'sess-a' } } },
  );
  const body = response.result.structuredContent;
  assert.equal(body.truncated, false, 'two tasks must not be reported as a trimmed list');
  assert.equal(body.omitted, 0);
  assert.equal(body.returned, 2);
});

/* The MCP module owns tool dispatch; import it through the public handler factory. */
async function callHandlerForTest(ctx, name, args) {
  const { createHandler } = await import('../server/mcp.mjs');
  const handler = createHandler({ store: ctx.store, studio: ctx.studio, homeDir: '/home/tester' });
  return handler.call(name, args);
}
