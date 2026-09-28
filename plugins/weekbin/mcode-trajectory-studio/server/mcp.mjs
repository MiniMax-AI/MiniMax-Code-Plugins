/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Implemented against the protocol directly so the Plugin stays dependency-free:
 * no node_modules is shipped and nothing needs a build step.
 */

import { createInterface } from 'node:readline';

import { boundPayloadList, redactEvent, redactPayload, redactPath, redactText } from './redact.mjs';
import { EGRESS_MAX_DEPTH, EGRESS_MAX_ENTRIES, EGRESS_STRING_LIMIT, EGRESS_TOTAL_BYTES_MCP, normalizeOffset } from './config.mjs';
import { SESSION_KINDS } from './store.mjs';


export const SERVER_NAME = 'mcode-trajectory-studio';
export const SERVER_VERSION = '0.1.3';

/**
 * Protocol versions this server implements, newest first.
 *
 * The initialize response must name a version the server actually supports. Echoing
 * whatever the client asked for would claim support for versions whose behaviour was
 * never implemented — and the two differ in ways that matter here, since JSON-RPC
 * batching exists in 2024-11-05 but was removed in 2025-06-18.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateProtocolVersion(requested) {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

const DETAIL_LEVELS = ['summary', 'full'];

/**
 * Every tool that only reads. Declaring that lets a client skip its own
 * confirmation prompts for calls that cannot mutate anything.
 */
const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  // Reading local session data is a closed-world operation: no outbound requests.
  openWorldHint: false,
});

/**
 * `trajectory_studio` is not read-only, and claiming it was is a real hazard: a
 * client that trusts `readOnlyHint` skips its confirmation prompt, and this call
 * opens a listening socket and publishes a capability URL. It reads nothing that
 * the other tools do not, but starting a listener is a side effect on the
 * environment.
 *
 * It is idempotent — a second call while the panel runs returns the same URL and
 * the same capability, rather than invalidating the page the caller already opened.
 */
const STUDIO = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const obj = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export const TOOLS = [
  {
    name: 'trajectory_list',
    annotations: READ_ONLY,
    description:
      'List recent local MiniMax Code sessions from the runtime SQLite projection, with non-content metadata only (no message text). Use this first to find a session ID, then call trajectory_summary or trajectory_get. truncated/omitted report sessions the response budget could not carry.',
    inputSchema: obj({
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
      agent: str('Filter by agent name, for example "mavis", "explore", "worker", "verifier".'),
      kind: str('Filter by session kind.', { enum: SESSION_KINDS }),
      sinceMs: int('Only sessions updated at or after this epoch-millisecond timestamp.', { minimum: 0 }),
      includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
    }),
  },
  {
    name: 'trajectory_summary',
    annotations: READ_ONLY,
    description:
      'Return per-session trajectory statistics for one MiniMax Code session: turns, steps, LLM/tool/decode wall-clock milliseconds, token totals, tool-call and failure counts, compactions, sub-agent tasks, assets, and the trigger-source breakdown. Equivalent to the dsh sessionStats projection. Omit sessionId to use the most recently updated session.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
    }),
  },
  {
    name: 'trajectory_get',
    annotations: READ_ONLY,
    description:
      'Return a page of trajectory records for one session, in insert order. Summary mode returns timing, token usage, roles, turn IDs and tool-call names only. Full mode additionally returns message text, thinking, tool arguments and tool results, redacted and length-bounded; request it only after explicit user consent. Reply with the same offset to continue: nextOffset is the index of the first record you did NOT receive and is null at the end, and truncated/omitted report records the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based record offset.', { minimum: 0, default: 0 }),
      limit: int('Maximum records to return.', { minimum: 1, maximum: 1000, default: 200 }),
      turnId: str('Restrict to one turn ID.'),
      detailLevel: str('Use summary by default.', { enum: DETAIL_LEVELS, default: 'summary' }),
    }),
  },
  {
    name: 'trajectory_search',
    annotations: READ_ONLY,
    description:
      'Full-text search across local session titles, agent names, statuses and workspace paths using the runtime FTS5 index. truncated/omitted report matches the response budget could not carry.',
    inputSchema: obj({
      query: str('Search text. Multi-character queries are matched as a phrase.', { minLength: 1, maxLength: 200 }),
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
    }, ['query']),
  },
  {
    name: 'trajectory_tasks',
    annotations: READ_ONLY,
    description:
      'List the background tasks and sub-agent dispatches owned by one session, with status, wall-clock duration, the command or objective, the sub-agent name, and the child session ID when a sub-agent ran. This is the nested-tool view for a trajectory. truncated/omitted report tasks the response budget could not carry, so the totals describe the records in this reply rather than the whole session.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      limit: int('Maximum tasks to return.', { minimum: 1, maximum: 2000, default: 200 }),
      // The list is newest-first, so a capped page needs a cursor: without one the
      // oldest tasks of a long session were unreachable and the reply did not say so.
      offset: int('Zero-based task offset, for reaching older tasks.', { minimum: 0, default: 0 }),
      kind: str('Restrict to one task kind, for example "bash" or "subagent".'),
    }),
  },
  {
    name: 'trajectory_task_output',
    annotations: READ_ONLY,
    description:
      'Read the tail of the captured output for one background task, bounded to the last 16 KiB by default. Use it to explain why a task failed without opening the session directory by hand.',
    inputSchema: obj({
      taskId: str('Exact task ID, as returned by trajectory_tasks.', { minLength: 1 }),
      maxBytes: int('Maximum bytes of trailing output to return.', { minimum: 256, maximum: 262144, default: 16384 }),
    }, ['taskId']),
  },
  {
    name: 'trajectory_studio',
    annotations: STUDIO,
    description:
      'Start (or reuse) the local Trajectory Studio web panel bound to 127.0.0.1 and return its URL. ' +
      'Open that URL with the host built-in browser, verbatim: the fragment carries a per-process ' +
      'capability token that every API route requires, so a URL with the fragment stripped will not ' +
      'load any data. Do not log or share the URL. The panel reads local session data only; starting ' +
      'it opens a loopback listener.',
    inputSchema: obj({
      sessionId: str('Session to focus when the panel opens.'),
      port: int('Preferred TCP port. Omit to reuse the running panel or pick a free one.', { minimum: 1024, maximum: 65535 }),
      stop: { type: 'boolean', description: 'Stop the running panel instead of starting it. Default false.' },
    }),
  },
];

export function createHandler({ store, studio, homeDir, redactRoots = [] }) {
  return {
    homeDir,
    redactRoots,
    call: (name, args) => callTool({ store, studio, homeDir, redactRoots }, name, args),
  };
}

/**
 * Which session a tool call is about.
 *
 * `undefined` — the argument omitted — means "the most recently updated session",
 * which is what the tool description promises. An explicitly empty string is not the
 * same thing: it is a value the caller supplied, it matches no session, and treating
 * it as absent returned a *different* session's records under the name the caller
 * asked about. A caller whose session id came from an unfilled variable got plausible
 * data for someone else's session.
 */
async function resolveSessionId(store, sessionId) {
  if (sessionId === undefined || sessionId === null) {
    const [latest] = store.listSessions({ limit: 1 });
    return latest?.sessionId ?? null;
  }
  if (typeof sessionId === 'string' && sessionId.trim() === '') throw new Error('unknown_session_id');
  if (typeof sessionId === 'string') return sessionId;
  throw new Error('invalid_session_id');
}

async function callTool(ctx, name, args = {}) {
  const { store, studio, homeDir, redactRoots } = ctx;
  const detailLevel = DETAIL_LEVELS.includes(args.detailLevel) ? args.detailLevel : 'summary';
  // The MCP surface is the one egress that leaves the machine, so its sweep masks
  // personal data as well as credentials. The panel keeps `pii` off: it is the
  // reader's own screen, and masking a customer's address there would destroy the
  // answer they opened it for.
  const options = {
    maxLength: 20000,
    maxDepth: EGRESS_MAX_DEPTH,
    maxEntries: EGRESS_MAX_ENTRIES,
    homeDir,
    roots: redactRoots,
    pii: true,
  };

  switch (name) {
    case 'trajectory_list': {
      const sessions = store.listSessions({
        limit: args.limit ?? 20,
        agent: args.agent,
        kind: args.kind,
        sinceMs: args.sinceMs,
        includeArchived: Boolean(args.includeArchived),
      }).map((session) => ({
        ...session,
        workspaceDir: redactPath(session.workspaceDir, { homeDir, roots: redactRoots }),
      }));
      // Every tool that returns a record list goes through the frame budget, not only
      // the one that was found to need it: the budget is what makes "how much can
      // come back" a property of the surface rather than of one tool's `limit`.
      const bounded = boundPayloadList(sessions, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      return {
        dataDir: store.dataDir,
        sqlite: Boolean(store.db),
        returned: bounded.items.length,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        sessions: bounded.items,
        warnings: store.warnings,
        // The list is bounded, so say when entries were dropped rather than letting
        // a truncated list read as a complete one.
        ...(store.warningsDropped > 0 ? { warningsDropped: store.warningsDropped } : {}),
      };
    }

    case 'trajectory_summary': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const stats = store.getStats(sessionId);
      if (!stats) throw new Error(`session_not_found:${sessionId}`);
      return { ...stats, workspaceDir: redactPath(stats.workspaceDir, { homeDir, roots: redactRoots }) };
    }

    case 'trajectory_get': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      let page = store.getEvents({
        sessionId,
        offset: args.offset ?? 0,
        limit: args.limit ?? 200,
        turnId: args.turnId,
        detailLevel,
      });
      // The artifact is consulted whenever the projection yielded nothing, not only
      // when there is no database at all.
      //
      // The guard used to be `source !== 'sqlite'`, and a live projection answers
      // `sqlite` for zero rows — so the fallback never ran for the case it exists
      // for: a session whose records have not been indexed yet but whose
      // `messages.jsonl` is on disk. That session reported "no records" while the
      // artifact held them. The artifact is only adopted when it actually has some,
      // so a projection that truly holds none still answers "no records".
      if (page.events.length === 0) {
        const artifact = await store.readJsonlEvents({
          sessionId, offset: page.offset ?? 0, limit: args.limit ?? 200, detailLevel, turnId: args.turnId,
        });
        if (artifact.events.length > 0) page = { ...page, ...artifact };
      }
      const events = detailLevel === 'full'
        ? page.events.map((event) => redactEvent(event, options))
        : page.events;
      // Per-record limits do not bound one reply: trim the list to a byte budget and
      // report it, so `limit: 1000` of full detail cannot return tens of megabytes.
      // The budget is the frame budget halved, because the result carries the payload
      // twice (text and structuredContent).
      const bounded = boundPayloadList(events, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      // The cursor names the first record the caller did not receive, not the first
      // one the store read: a page trimmed from 1000 records to 209 must answer 209,
      // or records 209-999 are skipped by every caller that pages on this value.
      // Built from the offset that was actually read, so the value it hands back is
      // always feedable in again.
      const readAt = page.offset ?? normalizeOffset(args.offset ?? 0);
      const delivered = bounded.items.length;
      return {
        sessionId,
        detailLevel,
        source: page.source,
        offset: readAt,
        returned: delivered,
        total: page.total ?? null,
        nextOffset: delivered === 0 ? null : (bounded.truncated ? readAt + delivered : page.nextOffset),
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        ...(page.source === 'error' ? { error: page.error ?? 'event_read_failed' } : {}),
        ...(page.droppedOversized > 0 ? { droppedOversized: page.droppedOversized } : {}),
        events: bounded.items,
      };
    }

    case 'trajectory_search': {
      const sessions = store.searchSessions({ query: args.query, limit: args.limit ?? 20 })
        .map((session) => ({ ...session, workspaceDir: redactPath(session.workspaceDir, { homeDir, roots: redactRoots }) }));
      const bounded = boundPayloadList(sessions, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      // An empty result on a runtime whose SQLite lacks FTS5 looks identical to a
      // query that matched nothing, so say which one it is.
      return {
        query: args.query,
        returned: bounded.items.length,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        ftsAvailable: store.hasFts,
        ...(store.hasFts ? {} : { note: 'full-text search is unavailable on this Node runtime (bundled SQLite without FTS5)' }),
        sessions: bounded.items,
      };
    }

    case 'trajectory_tasks': {
      const sessionId = await resolveSessionId(store, args.sessionId);
      if (!sessionId) throw new Error('no_sessions_available');
      const total = store.countBackgroundTasks(sessionId, { kind: args.kind });
      const at = normalizeOffset(args.offset ?? 0);
      const tasks = store.listBackgroundTasks(sessionId, {
        limit: args.limit ?? 200, kind: args.kind, offset: at,
      });
      // The same total-frame budget the event list gets. `limit` alone was the only
      // bound here, and `limit: 2000` of full tasks is roughly a 32 MB frame — the
      // event list was protected from exactly this and the task list was not.
      //
      // `total` and `nextOffset` are what make a short page honest. The list is
      // newest-first, so a capped page used to answer `truncated: false, omitted: 0`
      // while the session's oldest tasks were unreachable through every surface: a
      // 2,500-task session returned its newest 2,000 and described the result as
      // complete. The aggregate fields describe the records in this reply, which is
      // what `omitted` says.
      const bounded = boundPayloadList(tasks, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      const delivered = bounded.items;
      const covered = at + tasks.length;
      return {
        sessionId,
        returned: delivered.length,
        totalMs: delivered.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
        failed: delivered.filter((task) => task.status === 'failed').length,
        subagents: delivered.filter((task) => task.kind === 'subagent').length,
        total,
        offset: at,
        nextOffset: covered < total ? covered : null,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        tasks: delivered,
      };
    }

    case 'trajectory_task_output': {
      const output = await store.readTaskOutput(args.taskId, { maxBytes: args.maxBytes ?? 16384 });
      return { ...output, text: redactText(output.text, { maxLength: 64000, homeDir, roots: redactRoots }) };
    }

    case 'trajectory_studio': {
      if (!studio) throw new Error('studio_unavailable');
      if (args.stop) return { stopped: await studio.stop() };
      const started = await studio.start({ sessionId: args.sessionId, port: args.port });
      return {
        url: started.url,
        port: started.port,
        reused: started.reused,
        sessionId: started.sessionId ?? null,
        boundTo: started.boundTo,
        capabilityRequired: true,
        note: 'Open the URL exactly as returned, including the #t= fragment. It is this process\'s capability for the panel; do not log it or share it.',
      };
    }

    default:
      throw new Error(`unknown_tool:${String(name)}`);
  }
}

/* ------------------------------------------------------------- transport -- */

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function handleRpcMessage(handler, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        'Read-only trajectory inspection for local MiniMax Code sessions. Prefer summary detail; request full detail only with explicit user consent.',
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    return handler.call(name, args).then(
      (value) => {
        // One sweep on the way out, on top of the redaction each read already does,
        // so a field added to a result later cannot leave unredacted. The ceiling is
        // the largest per-field bound any tool applies, so this can only redact; the
        // sweep is also home-aware, so an absolute home path embedded anywhere in the
        // result is collapsed to `~` rather than leaving the machine. `pii` is set
        // here and nowhere else: this is the surface whose output reaches a model.
        const safe = redactPayload(value, {
          maxLength: EGRESS_STRING_LIMIT,
          maxDepth: EGRESS_MAX_DEPTH,
          maxEntries: EGRESS_MAX_ENTRIES,
          homeDir: handler.homeDir,
          roots: handler.redactRoots,
          pii: true,
        });
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(safe, null, 2) }],
          structuredContent: safe,
        });
      },
      (error) => rpcResult(id, {
        isError: true,
        // The failure path goes through the same sweep as the success path. Tool
        // errors here are Plugin-authored codes, but an unexpected one carries a
        // driver message or a path, and an egress that is only swept when it
        // succeeds is not a boundary. The success branch had this and the error
        // branch did not, which is precisely how a boundary drifts.
        content: [{
          type: 'text',
          text: redactText(error instanceof Error ? error.message : String(error), {
            maxLength: 2048,
            homeDir: handler.homeDir,
            roots: handler.redactRoots,
            pii: true,
          }),
        }],
      }),
    );
  }
  return rpcError(id, -32601, `Method not found: ${String(method)}`);
}

/** Serve MCP over stdio until stdin closes. */
export async function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // Notifications carry no id and must not be answered.
    if (message.id === undefined) {
      handleRpcMessage(handler, message);
      continue;
    }
    const response = await handleRpcMessage(handler, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
