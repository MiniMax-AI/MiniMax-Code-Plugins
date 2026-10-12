/**
 * How a session was configured, read directly rather than by opening a browser.
 *
 * The Plugin has always been able to answer "what was this session configured with?"
 * — the Studio panel draws it — and the Skill's answer for that question was to send
 * the user off to open the panel in a browser. That is a poor instruction for a model
 * that has the data one call away: on the machine this was written on, 55 of the 60
 * most recent sessions carry a definition, and it is around 6 KB.
 *
 * So the tool reports `present` rather than a null definition, because "this session
 * was dispatched without one" and "this session could not be read" are different
 * answers, and only the first is common. The absent case is a finding of its own: a
 * session with no definition was dispatched some other way.
 *
 * The case this file pins hardest is the one that returned two bytes instead of six
 * kilobytes: `boundPayloadList` bounds arrays and answers an empty list for anything
 * else, without saying so. A budget silently swallowing a whole answer is worse than
 * no budget, because the reply still looks like a reply.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createFixtureProjection, FIXTURE_HOME, withProjectionDb } from '../tools/fixture.mjs';
import { openStore } from '../server/store.mjs';
import { createHandler } from '../server/mcp.mjs';

const NOW = 1_700_000_000_000;

/** A store whose session has a definition only when `withDefinition` is set. */
async function seeded(t, { withDefinition = true, bigDefinition = false } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agent-tool-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Configured', updatedAtMs: NOW });
  projection.close();
  if (withDefinition) {
    const db = new DatabaseSync(dbPath);
    db.prepare(`
      INSERT INTO local_runtime_session_agent_definitions (session_id, definition_json)
      VALUES (?, ?)
    `).run('sess-a', JSON.stringify({
      definitionVersion: 1,
      exactOwnerName: 'weekbin',
      model: { providerId: 'minimax', modelId: 'MiniMax-M3.1-Flash-Preview' },
      // Nested under `capabilities`, which is where the runtime keeps them — a flat
      // fixture would be silently normalised down to empty lists and the case would
      // assert the normaliser rather than the tool.
      capabilities: {
        // A definition big enough to cross the MCP egress budget. The budget is 2 MiB and
        // the per-string ceiling is 20,000 characters, so this takes 120 entries rather
        // than one enormous one — which is the shape a real agent with a long tool list
        // has, and the shape the tier below needs to reach.
        tools: bigDefinition
          ? Array.from({ length: 120 }, (_, i) => `tool-${i} ${'d'.repeat(20_000)}`)
          : ['read', 'bash', 'grep'],
        disallowedTools: [],
        mcpServers: ['mcode-trajectory-studio'],
        skills: ['technical-doc-discipline'],
        extensionSkills: [],
      },
      systemPrompt: 'You are a careful engineer.',
      project: { name: 'demo' },
    }));
    db.close();
  }
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const call = (store, tool, args) => createHandler({ store, homeDir: FIXTURE_HOME, redactRoots: [] })
  .call(tool, args);

test('a configured session answers with its definition intact', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_agent', { sessionId: 'sess-a' });
  assert.equal(reply.present, true);
  assert.equal(reply.truncated, false);
  assert.ok(reply.definition, 'the definition came back empty on a session that has one');
  // The regression this file exists for: an object handed to a list budget comes back
  // as an empty list rather than as an error, and the reply still looks well formed.
  assert.ok(Object.keys(reply.definition).length > 0, 'the definition arrived with no fields at all');
  assert.equal(reply.definition.model.modelId, 'MiniMax-M3.1-Flash-Preview');
  assert.deepEqual(reply.definition.tools, ['read', 'bash', 'grep'], 'the allowlist did not survive');
  assert.equal(reply.definition.systemPrompt, 'You are a careful engineer.');
});

test('an unconfigured session says so, and says it is readable', async (t) => {
  // Not a null definition and not an error: the session was dispatched without one,
  // which is a real thing to report about a session.
  const store = await seeded(t, { withDefinition: false });
  const reply = await call(store, 'trajectory_agent', { sessionId: 'sess-a' });
  assert.equal(reply.present, false);
  assert.equal(reply.available, true, 'an absent definition must not read as an unreadable session');
  assert.equal(reply.definition, undefined);
});

test('the definition carries more than a token or two', async (t) => {
  // A size floor rather than a field-by-field check: the failure mode was a reply that
  // was structurally valid and semantically empty, which a shape assertion passes.
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_agent', { sessionId: 'sess-a' });
  const bytes = Buffer.byteLength(JSON.stringify(reply.definition ?? {}), 'utf8');
  assert.ok(bytes > 100, `the definition came back at ${bytes} bytes, which is not a definition`);
});

test('a definition over the byte budget says it was cut', async (t) => {
  // Found by mutation tier J, and for the same reason as its counterpart in the assets
  // suite: not an equivalent mutation and not a dead tier, but one reporting a pass for a
  // condition the fixture could not reach. A single record is soft-budgeted — it is allowed
  // to go over rather than hand back a cursor that cannot advance — so the only way a
  // caller learns the definition is incomplete is `truncated` and `omitted`. With a
  // definition of a few hundred bytes both were already zero, and hardcoding them to zero
  // changed no assertion at all.
  //
  // So the disclosure is asserted on a definition big enough to need it. Nothing about the
  // budget is arbitrary here: 2 MiB against a 20,000-character per-string ceiling is
  // 120 tool descriptions, which a real configured agent has.
  const store = await seeded(t, { bigDefinition: true });
  const reply = await call(store, 'trajectory_agent', { sessionId: 'sess-a' });
  assert.equal(reply.truncated, true, 'a definition that went over the budget did not say so');
  // `omitted` is zero here, and that is the contract rather than a second bug: the budget
  // is **soft for exactly one record**, because a record that fit nothing would answer
  // `nextOffset` equal to the offset it was given and every client would re-request it
  // forever. So the record is kept and `truncated` alone reports the overage. Asserted as
  // an exact zero rather than left alone, because the tempting "fix" for a reply that says
  // it was truncated is to start dropping the record, and this is what rules that out.
  assert.equal(reply.omitted, 0, 'a single soft-budgeted record must not be counted as omitted');
  // The record itself is still delivered — a definition that arrived as `null` while
  // `present: true` would be a second, worse way to be unreadable.
  assert.ok(reply.definition, 'the budget cut the record instead of disclosing the cut');
});

test('omitting the session id uses the most recently updated one', async (t) => {
  const store = await seeded(t);
  const reply = await call(store, 'trajectory_agent', {});
  assert.equal(reply.sessionId, 'sess-a');
  assert.equal(reply.present, true);
});
test('the definition folds absolute home paths the way the panel does', async (t) => {
  // The egress contract caught this on the day the tool was added, and it is a
  // redaction gap rather than a new one: the store redacts the system prompt, but
  // without a path context, so a home path written into it survives. The panel route
  // re-redacts for exactly this reason. Asserted here as well so the fix is pinned
  // where the tool is defined, not only where a sweep happens to notice.
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agent-tool-'));
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const projection = await createFixtureProjection(dataDir);
  projection.session({ id: 'sess-a', title: 'Configured', updatedAtMs: NOW });
  projection.close();
  withProjectionDb(dbPath, (db) => db.prepare(
    'INSERT INTO local_runtime_session_agent_definitions (session_id, definition_json) VALUES (?, ?)',
  ).run('sess-a', JSON.stringify({
    definitionVersion: 1,
    capabilities: { tools: [] },
    systemPrompt: `Work in ${FIXTURE_HOME}/ws every day`,
    project: { root: `${FIXTURE_HOME}/repo` },
  })));
  const store = openStore({ dataDir });
  t.after(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const reply = await call(store, 'trajectory_agent', { sessionId: 'sess-a' });
  const body = JSON.stringify(reply);
  assert.equal(body.includes(FIXTURE_HOME), false, `the definition leaked an absolute path: ${body}`);
  assert.ok(body.includes('<home>') || body.includes('~'),
    'the path should be folded to a placeholder, not merely altered until the check passes');
});
