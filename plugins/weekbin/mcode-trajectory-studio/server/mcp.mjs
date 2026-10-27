/**
 * MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Implemented against the protocol directly so the Plugin stays dependency-free:
 * no node_modules is shipped and nothing needs a build step.
 */

import { createInterface } from 'node:readline';

import { boundPayloadList, redactEvent, redactPayload, redactPath, redactText } from './redact.mjs';
import { findSessionDir, hasArtifactEvidence, recordsUnavailable } from './jsonl.mjs';
import { snippetAround } from './events.mjs';
import { EGRESS_MAX_DEPTH, EGRESS_MAX_ENTRIES, EGRESS_MAX_LENGTH_MCP, EGRESS_STRING_LIMIT, EGRESS_TOTAL_BYTES_MCP, LIMITS, clamp, normalizeOffset, TASK_LIST_MAX_ROWS, toBoolean, decodeSessionCursor, encodeSessionCursor, sessionCursorFingerprint } from './config.mjs';
import { SESSION_KINDS } from './store.mjs';
import { DETAIL_LEVELS } from './config.mjs';


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
      'List local MiniMax Code sessions from the runtime SQLite projection, with non-content metadata only (no message text). Use this first to find a session ID, then call trajectory_summary or trajectory_get. Newest first. total is how many sessions the filter matches, and nextCursor is how to reach the rest: pass it back as cursor unchanged until nextCursor is null. Do not page by offset or row position — the runtime updates sessions as it writes to them, and a walk by position silently skips any session that moves during the walk, while still reporting that it finished. The cursor belongs to the walk that produced it: pass it back with the same filters, or the reply is page one of the new question plus a note saying so. Changing limit is fine. Every page of one walk describes the same instant, walkPinnedAtMs, so total and the rows always agree; a session written to after page one is newer than that instant and is found by starting the walk again. agents lists every agent name `agent` matches against, with session counts, so the exact value for that filter can be read off the reply instead of guessed — `agent` is case-sensitive and exact. truncated/omitted report sessions the response budget could not carry.',
    inputSchema: obj({
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
      cursor: str('Continue a walk over sessions: pass the previous reply\'s nextCursor back unchanged. Omit it to start a new walk.', { maxLength: 200 }),
      agent: str('Filter by agent name, for example "mavis", "explore", "worker", "verifier".'),
      kind: str('Filter by session kind.', { enum: SESSION_KINDS }),
      parentSessionId: str('Only sessions dispatched by this one — the sub-agent sessions it spawned. Pass "root" for top-level sessions only. Without this, a parent\'s children can only be found by paging the whole machine and picking them out locally.', { maxLength: 200 }),
      sinceMs: int('Only sessions updated at or after this epoch-millisecond timestamp.', { minimum: 0 }),
      untilMs: int('Only sessions updated at or before this epoch-millisecond timestamp. Pair with sinceMs to ask for a date range rather than "everything since then".', { minimum: 0 }),
      includeArchived: { type: 'boolean', description: 'Include archived sessions. Default false.' },
    }),
  },
  {
    name: 'trajectory_summary',
    annotations: READ_ONLY,
    description:
      'Return per-session trajectory statistics for one MiniMax Code session: turns, steps, LLM/tool/decode wall-clock milliseconds, token totals, tool-call and failure counts, compactions, sub-agent tasks, assets, and the trigger-source breakdown. Equivalent to the dsh sessionStats projection. Omit sessionId to use the most recently updated session. **assets and changedTurns are different facts and neither stands in for the other**: assets counts files the session delivered or attached, changedTurns counts its turns that recorded edits. On a machine measured here, 329 of the 351 sessions with any recorded edit delivered zero assets, and where both exist the counts differ 19 times out of 22 — so `assets: 0` does not mean the session did nothing. changesAvailable says whether changedTurns is recorded at all rather than merely zero. **unmatchedTurns is how many of those change sets name a turn the transcript does not carry** — the runtime writes the two tables independently, so on a measured machine 307 of 1,417 change sets name a turn no message row has and on 7 of 351 sessions changedTurns is larger than the turn count trajectory_turns reports. It is not a warning: both numbers are correct and the change sets behind it are real edits. Subtract it before paging by turnId. **objective is what the run was actually asked to do, and it is not the title restated** — on a measured machine the two share almost no vocabulary in 13 of 15 goal-bearing sessions, so a reader inferring the task from the title is wrong two times in three with nothing on any reply to say so. Absent means no goal was recorded (618 of 633 sessions on that machine) and is never the title; goalAvailable false means this runtime records none.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
    }),
  },
  {
    name: 'trajectory_turns',
    annotations: READ_ONLY,
    description:
      'Return one row per turn for a session: how many records the turn holds, its LLM wall-clock milliseconds, and its output tokens. This is the progress view — reach for it instead of paging trajectory_get to work out how a run was divided up, which costs one call per thousand records instead of one call in total. Order and content match the session\'s own turn grouping. truncated/omitted report turns the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based turn offset, for reaching later turns.', { minimum: 0, default: 0 }),
      limit: int('Maximum turns to return.', { minimum: 1, maximum: 2000, default: 200 }),
    }),
  },
  {
    name: 'trajectory_ingress',
    annotations: READ_ONLY,
    description:
      'List the turns the runtime accepted for one session: when each was taken in, in what order, what claimed it, how long it sat in the queue, and how it ended — plus whether the transcript carries that turn at all. This exists because the transcript is not the same set: on a machine measured here 14 turns that **failed or aborted** appear in no message row at all, across 7 sessions that every other tool reports as a clean run with no error and no warnings. Read `inTranscript: false` as "this turn is not in the transcript", not "it died" — 13 turns on that machine completed and are equally absent. failedOrAborted is the count that ended badly; missingFromTranscript is the count the projection does not carry, and the two answer different questions. **There is no reason field because the runtime records none**: the table has sixteen columns and none says why a turn failed, so this tool says that a turn died and when, never why. claimSource is the only record of *who asked* — on that machine 668 of 2,466 turns were started by a thread goal and 1,603 carry no claim at all, which is reported as null rather than attributed to anyone. A null claimSource is an absent answer, not "the user". Most sessions record none at all, so total 0 with available true is ordinary; available false means this runtime cannot tell, and failedOrAborted is then null rather than 0. status narrows to one recorded status and total still reports the session\'s own count. truncated/omitted report turns the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based turn offset, for reaching later turns.', { minimum: 0, default: 0 }),
      limit: int('Maximum turns to return.', { minimum: 1, maximum: 500, default: 100 }),
      status: str('Narrow to one recorded status: completed, failed, aborted or accepted.', { maxLength: 32 }),
    }),
  },
  {
    name: 'trajectory_assets',
    annotations: READ_ONLY,
    description:
      'List the files a session delivered or referenced: absolute path, display name, role, source tag and asset id. trajectory_summary reports how many, not which, so this is how "which files came out of that session" gets answered without paging trajectory_get a thousand records at a time. assetType is carried through as recorded and is null for most rows, so do not read a type into a null. Most sessions have none — assets are recorded only when a file was produced or attached. truncated/omitted report assets the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based asset offset, for reaching older assets.', { minimum: 0, default: 0 }),
      limit: int('Maximum assets to return.', { minimum: 1, maximum: 500, default: 50 }),
    }),
  },
  {
    name: 'trajectory_changes',
    annotations: READ_ONLY,
    description:
      'Return what a session changed on disk, one row per turn: every file it added, modified or deleted, with line counts and — in full detail — the unified diff. This is the answer to "what did that run actually do"; the transcript only holds what the agent said it did. Recorded for most sessions that edited a repo and absent for the rest, so an empty page means either nothing was recorded or this runtime does not record it — available says which. Paths inside the workspace are stored relative to it and come back absolute; each turn carries its own scratchFiles, and the reply-level matchedFiles/matchedScratchFiles are session-wide over everything the filter matched — scratch being the temp-directory files that are the majority of a real busy turn, so a turn of 82 files is usually about five repository edits. `path` narrows to a substring of the resolved path. `turnInTranscript` on each row says whether trajectory_get can find that turn by turnId, and `unmatchedTurns` is the session-wide count of those that cannot — the runtime writes change sets and transcript independently, so a change set may name a turn no message row carries; those rows are real edits and stay in the list, and `changedTurns - unmatchedTurns` is how many you can page by turnId. status and revertedAtMs are carried through as recorded and carry no signal on any runtime measured so far. truncated/omitted report change sets the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      offset: int('Zero-based change-set offset, for reaching later turns.', { minimum: 0, default: 0 }),
      limit: int('Maximum turns to return.', { minimum: 1, maximum: 500, default: 100 }),
      path: str('Substring match against the resolved absolute path, for narrowing to one directory or file type.'),
      detailLevel: str('"summary" (default) lists the files with their line counts. "full" adds each file\'s unified diff.', { enum: ['summary', 'full'], default: 'summary' }),
    }),
  },
  {
    name: 'trajectory_agent',
    annotations: READ_ONLY,
    description:
      'Return the agent definition a session was dispatched with: model, tool allowlist and denylist, MCP servers, skills, system prompt and project. Present only for sessions the runtime dispatched with an explicit definition, so absent is the answer for most sessions and a real finding for a few. Use it instead of opening the Studio panel — the panel draws the same data for a human. truncated/omitted report parts the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
    }),
  },
  {
    name: 'trajectory_find',
    annotations: READ_ONLY,
    description:
      'Find records in ONE session whose text contains a query, newest match last. Scoped to a session on purpose: a whole-machine text search takes seconds, while this is tens of milliseconds. Each hit carries the record\'s index in the same numbering trajectory_get pages in, so read it with offset rather than paging to find it. Snippets come only in full detail, like every other message body — including when the needle is in neither the message nor the thinking: such a hit reads field "other" and matchedToolCall names the half of the tool call that held it, "args" or "result". truncated/omitted report hits the response budget could not carry.',
    inputSchema: obj({
      sessionId: str('Exact session ID. Omit to use the most recently updated session.'),
      query: str('Literal text to find. Wildcards are not interpreted.', { minLength: 2, maxLength: 200 }),
      offset: int('Zero-based match offset, for reaching later matches.', { minimum: 0, default: 0 }),
      limit: int('Maximum matches to return.', { minimum: 1, maximum: 200, default: 20 }),
      detailLevel: str('Use summary by default.', { enum: DETAIL_LEVELS, default: 'summary' }),
    }, ['query']),
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
      role: str(
        'Restrict to one role. User records are 2.1% of a machine\'s rows, so "what did this '
        + 'conversation ask and how far did it get" is a question about a few records hidden '
        + 'in thousands of assistant ones — filter rather than walk and discard. Omit for no '
        + 'filter; pass null for the rows that carry no role.',
      ),
      detailLevel: str('Use summary by default.', { enum: DETAIL_LEVELS, default: 'summary' }),
    }),
  },
  {
    name: 'trajectory_search',
    annotations: READ_ONLY,
    description:
      'Full-text search across local sessions using the runtime FTS5 index: session ids, titles, agent names, statuses, session kinds, workspace paths, and the per-session purpose the runtime records when it dispatches a sub-agent. That last one is why a query can be a *content* query — a sub-agent\'s dispatch objective is indexed, so a word from it matches a session whose title never mentions it. It is recorded only for dispatched sessions, so on a machine of N sessions roughly the sub-agent share is reachable this way and the rest are matched on their metadata alone. A query is matched as a case-insensitive phrase inside one field, so "Spec review" matches that title and not a session holding both words apart. **A run\'s recorded objective is searched too, on a channel that is not the index**: the runtime\'s FTS table has no objective column, so that text is matched by a separate literal scan of the goal table — objectivesIndexed says whether it ran, objectiveMatchedSessionIds lists what it reached, and those rows carry objectiveMatched true and the matching objective text. On a measured machine every goal match was invisible to the index (0 of 15 goal-bearing sessions reachable by a word from their own objective), and this channel still works with no FTS5 at all. Objective rows ride on the page but never in total or the cursor, because the walk is an index walk. These queries are still not selective — a status or a common word can match most sessions — so total is the match count, and nextCursor is how to reach the rest: pass it back as cursor unchanged until nextCursor is null rather than assuming the first page was everything, and never page by row position, which skips any match whose session is written to during the walk while still reporting that it finished. The cursor belongs to the walk that produced it — pass it back with the same query, or the reply is page one of the new query plus a note saying so. Changing limit is fine. Every page of one walk describes the same instant, walkPinnedAtMs, so total and the rows always agree. truncated/omitted report matches the response budget could not carry. An empty sessions list is only "no match" when there is no note: ftsAvailable false means this runtime has no FTS5, a note saying the query failed means it was not searched, and a note saying the index does not carry the searched fields means no query of this shape can run here at all.',
    inputSchema: obj({
      query: str('Search text, matched as a case-insensitive phrase. Multi-word queries must appear contiguously within one field.', { minLength: 1, maxLength: 200 }),
      limit: int('Maximum sessions to return.', { minimum: 1, maximum: 200, default: 20 }),
      cursor: str('Continue a walk over matches: pass the previous reply\'s nextCursor back unchanged. Omit it to start a new walk.', { maxLength: 200 }),
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

/**
 * Resolve the session a call is about, and refuse one that does not exist.
 *
 * `resolveSessionId` answers only "which id"; this answers "is it real". The gap
 * between them was the trap: six session-scoped tools resolved an id and then read
 * from a table keyed by it, so a mistyped or hallucinated id produced the empty list
 * of a session that produced nothing. `trajectory_find` was the sharpest case — it
 * answered `total: 0` for a session that was never searched, and a model reading that
 * reports "I looked through that session and there is nothing in it".
 *
 * Both places a session can legitimately live count as existing: the SQLite
 * projection, and the session's own `messages.jsonl` for one the indexer has not
 * reached yet. Checking the artifact is what keeps this from breaking the fallback
 * path — an existence check that only knew about SQLite would have turned every
 * freshly-written session into an error.
 *
 * The directory walk costs about 2.5 ms on a 633-session machine and only runs when
 * the projection has no row, so the ordinary path — the one every call takes — pays
 * a 0.1 ms indexed lookup instead.
 */
async function requireSession(store, sessionId) {
  const resolved = await resolveSessionId(store, sessionId);
  if (!resolved) throw new Error('no_sessions_available');
  if (store.getSession(resolved)) return resolved;
  if (await findSessionDir(store, resolved)) return resolved;
  throw new Error(`session_not_found:${resolved}`);
}

async function callTool(ctx, name, args = {}) {
  const { store, studio, homeDir, redactRoots } = ctx;
  // An unrecognised level is not a request for summary — it is a request whose answer is
  // being thrown away. `detailLevel` is the only way to ask for message text at all:
  // summary detail carries `contentLength` and no `content`, so a caller who misspelled
  // the enum gets records with the field simply absent, which reads exactly like a
  // session that said nothing. Measured on a record whose text is sixteen characters,
  // the default, the right value and a wrong one are: absent, the text, absent.
  const requestedDetail = args.detailLevel;
  const detailLevel = DETAIL_LEVELS.includes(requestedDetail) ? requestedDetail : 'summary';
  const detailNote = requestedDetail !== undefined && !DETAIL_LEVELS.includes(requestedDetail)
    ? `detailLevel ${JSON.stringify(requestedDetail)} is not one of ${DETAIL_LEVELS.join(' or ')}, so this reply is the ${detailLevel} level — records carry no message text`
    : null;
  // The MCP surface is the one egress that leaves the machine, so its sweep masks
  // personal data as well as credentials. The panel keeps `pii` off: it is the
  // reader's own screen, and masking a customer's address there would destroy the
  // answer they opened it for.
  const options = {
    maxLength: EGRESS_MAX_LENGTH_MCP,
    maxDepth: EGRESS_MAX_DEPTH,
    maxEntries: EGRESS_MAX_ENTRIES,
    homeDir,
    roots: redactRoots,
    pii: true,
  };

  switch (name) {
    case 'trajectory_list': {
      // The store's warnings are a cumulative ring, and they have to be: `/api/meta` and
      // `--doctor` are diagnostic surfaces whose whole job is to report everything that
      // has gone wrong since the process opened the store. But this reply is not a
      // diagnostic — it is an answer about a filtered page of sessions, and the Skill
      // says its `warnings` are "reads that failed while building this answer".
      //
      // It was publishing the whole ring, so a `trajectory_find` that failed with
      // `event_find_failed:…` left a line that every later list repeated as its own. The
      // cost is not the stray line but that **nothing clears them**: once anything fails,
      // every subsequent list announces a failure it did not have, and the contract that
      // makes this field useful — "a `0` in the same answer means *not counted*, not
      // *none*" — only means anything to somebody reading that answer.
      //
      // So the reply carries what was appended while it was being built, and the
      // cumulative view stays where it belongs.
      const warnedAt = store.warnings.length;
      const droppedAt = store.warningsDropped;
      // What this walk is answering, as one value. A cursor says where to resume and says
      // nothing about what it was resuming *for*, so the filter set travels inside it:
      // measured on the real machine, a walk filtered to one agent and then resumed
      // without its filter delivered rows that were not that agent while reporting the
      // unfiltered total. Resuming from a cursor that belongs to a different filter set
      // starts a fresh first page instead, and says so.
      const fingerprint = sessionCursorFingerprint({
        agent: args.agent,
        kind: args.kind,
        parentSessionId: args.parentSessionId,
        sinceMs: Number.isFinite(args.sinceMs) ? args.sinceMs : null,
        untilMs: Number.isFinite(args.untilMs) ? args.untilMs : null,
        includeArchived: toBoolean(args.includeArchived),
      });
      const decoded = decodeSessionCursor(args.cursor);
      const foreignCursor = Boolean(decoded) && decoded.fingerprint !== fingerprint;
      // The instant this walk is pinned to. Page one fixes it; every later page reads it
      // back out of the cursor, so the rows and `total` describe the same moment for the
      // whole walk.
      //
      // The bound is *strictly* older than it, and the last millisecond is the whole
      // point. `updated_at_ms` is millisecond-resolution, so a write landing in the same
      // millisecond the walk pinned at is not distinguishable from one that landed just
      // before: inclusive, the moved row stayed inside the window, fell above the
      // cursor, and was dropped from the walk while `total` still counted it — the exact
      // defect the cursor exists to remove, surviving in a one-millisecond corner.
      const at = foreignCursor ? null : decoded;
      const pinMs = at ? at.pinMs : Date.now();
      const pageSize = clamp(args.limit ?? 20, LIMITS.sessions);
      const filters = {
        agent: args.agent,
        kind: args.kind,
        parentSessionId: args.parentSessionId,
        sinceMs: args.sinceMs,
        // A caller's own upper bound still wins when it is the tighter of the two.
        untilMs: Math.min(Number.isFinite(args.untilMs) ? args.untilMs : Number.POSITIVE_INFINITY, pinMs - 1),
        // `toBoolean`, not `Boolean`: nothing validates `tools/call` arguments against
        // the declared schema, so a string "false" reaches this line, and
        // `Boolean("false")` is `true` — which returned archived sessions to a caller
        // that asked for the opposite, in a reply that looked complete.
        includeArchived: toBoolean(args.includeArchived),
      };
      const total = store.countSessions(filters);
      const read = store.listSessions({ ...filters, limit: pageSize, cursor: at ? args.cursor : undefined });
      const sessions = read.map((session) => ({
        ...session,
        workspaceDir: redactPath(session.workspaceDir, { homeDir, roots: redactRoots }),
      }));
      // Every tool that returns a record list goes through the frame budget, not only
      // the one that was found to need it: the budget is what makes "how much can
      // come back" a property of the surface rather than of one tool's `limit`.
      const bounded = boundPayloadList(sessions, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      // The cursor names the last session this page carried, not the first one this call
      // read. Advancing by what was read would permanently skip whatever the frame
      // budget dropped: those sessions would be counted in `omitted` and never delivered
      // by any page of this walk. Advancing by what was carried means the next page
      // starts exactly where this one stopped, and the walk stays lossless.
      const delivered = bounded.items.length;
      // The agent names this machine actually used, which is what `agent` is matched
      // against — an exact, case-sensitive comparison, so `Explore` does not find a
      // session stored as `explore`.
      //
      // The Skill told the model to read this list instead of guessing, and the reply
      // did not carry it: the field was absent, so the remedy for the guessing trap was
      // itself a dead end. The store has always computed it in one indexed `GROUP BY`,
      // and the panel's sidebar filter is built from exactly this call.
      //
      // Scoped to the same population as the `total` above it, and taking
      // `includeArchived` from the same `filters` object rather than defaulting: a
      // reply whose counts skipped archived sessions while its own `total` included
      // them would be the same disagreement in the other direction, and the panel's
      // filter menu prints these counts verbatim next to the list they claim to size.
      //
      // Whole-population, not narrowed to this page's filters — a caller that filtered
      // on a name nothing owns gets an empty page, and the vocabulary is precisely what
      // tells them the filter value was wrong. Deliberately outside the page budget:
      // this is a dimension list bounded by the number of distinct agent names in the
      // sessions table, next to a page of records, and a budget on it would report a
      // partial vocabulary as a whole one.
      const agents = store.listAgents({ includeArchived: filters.includeArchived });
      // The slice starts *behind* the mark by however many entries this call pushed out
      // of the ring. Slicing from the mark alone is empty whenever the ring was already
      // full: the append pushes the length to 65, the overflow splices the oldest away,
      // and the warning that caused the drop ends up at the new last index rather than
      // past the old length — so the reply said `warningsDropped: 1` beside
      // `warnings: []`, a count with nothing to account for it.
      const droppedHere = store.warningsDropped - droppedAt;
      const from = Math.max(0, warnedAt - droppedHere);
      // Where the walk ends, and the only continuation this tool publishes. A short read
      // is the end: the query asked for `pageSize` rows and got fewer, so nothing older
      // is left. A read that filled the page, or one the frame budget trimmed below the
      // page it read, still has more behind it. Asking the count instead would answer a
      // different question — a row written to mid-walk leaves the pinned window, so
      // `total` can be smaller than what this walk is still owed.
      const lastCarried = bounded.items[delivered - 1];
      const reachedEnd = delivered === 0 || (delivered === read.length && read.length < pageSize);
      const nextCursor = reachedEnd || !lastCarried
        ? null
        : encodeSessionCursor({ pinMs, fingerprint, updatedAtMs: lastCarried.updatedAtMs, sessionId: lastCarried.sessionId });
      return {
        dataDir: store.dataDir,
        sqlite: Boolean(store.db),
        agents,
        total,
        returned: delivered,
        nextCursor,
        // The instant `total` and every page of this walk describe. It is the reason a
        // session written to while the walk was running is absent from both rather than
        // missing from one of them — and it is what makes `nextCursor` resumable.
        walkPinnedAtMs: pinMs,
        // A cursor from a walk of a *different* filter set resumes nothing: its key
        // belongs to another population, so the page would come back from an arbitrary
        // point in this one and `total` would describe the wrong question. Page one is
        // returned instead, with the mismatch said out loud — the alternative was a page
        // that looked like a continuation and was not.
        ...(foreignCursor
          ? { note: 'the cursor you passed belongs to a walk with different filters, so this is page one of the filters you asked for — hand this reply\'s own nextCursor back to continue it' }
          : {}),
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        sessions: bounded.items,
        warnings: store.warnings.slice(from),
        // The list is bounded, so say when entries were dropped rather than letting
        // a truncated list read as a complete one. Scoped to this call for the same
        // reason as the warnings: a drop that happened during an earlier read is not
        // this answer's omission.
        ...(store.warningsDropped > droppedAt
          ? { warningsDropped: store.warningsDropped - droppedAt } : {}),
      };
    }

    case 'trajectory_summary': {
      const sessionId = await requireSession(store, args.sessionId);
      const stats = store.getStats(sessionId);
      // The guard above already established that the session exists, so a null fold is
      // not a bad id: it is a session the projection has not indexed yet, whose records
      // live only in its `messages.jsonl`. Those records carry no timing, no usage and no
      // tool-call rows, so there is no summary to compute — but reporting that as
      // `session_not_found` claims a session that does not exist, which sends the caller
      // off to re-read `trajectory_list` for a session it can already see there.
      if (!stats) throw new Error(`session_not_indexed:${sessionId}`);
      // The fold answering zeroes is not the same finding as the fold being absent, and
      // this is the one place a zero fold can be checked against the row count the fold
      // ran over. `getStats` returns null only when the *session row* is missing, so the
      // `session_not_indexed` above never fires for a session whose row exists and whose
      // message rows do not — and that is a real state on a real machine: sessions whose
      // rows were never indexed and whose artifact is not on disk either. Every number in
      // the fold is then a correct count of nothing, which is exactly why it reads as an
      // answer rather than as a failure.
      //
      // The artifact is consulted before concluding that, because "no rows here" and
      // "no records anywhere" are different and the two list tools already tell them
      // apart. Without this, a session whose row count is zero but whose `messages.jsonl`
      // holds its records was summarised as `turns: 0, toolCalls: 0` while
      // `trajectory_turns` and `trajectory_get` were listing those same records one call
      // later — the summary was the odd tool out, and it is the one a caller asks first.
      // The walk only runs when the count is zero, so the ordinary path pays nothing.
      const projectionRows = store.messageRowCount(sessionId);
      let unavailable = false;
      let inArtifact = false;
      if (projectionRows === 0) {
        const artifact = await store.readJsonlTurnSummaries({ sessionId });
        unavailable = recordsUnavailable({ sessionExists: true, projectionRows, artifact });
        // The other side of the same question. `trajectory_turns` and `trajectory_get`
        // fall back to the artifact and list the records; this fold cannot, because an
        // artifact records no timings, no usage and no tool-call rows. Left unsaid, the
        // summary read as a contradiction of the two calls that followed it — the tool a
        // caller asks *first* reporting no turns for a session it then lists records for.
        inArtifact = !unavailable && artifact.available;
      }
      // The objective is swept with the rest of the fold rather than trusted, because it
      // is whatever the user typed to start the run: a home path, a branch name, a pasted
      // snippet or a credential. Every other free-form field here already went through
      // this sweep — the first version published the objective beside them untouched, and
      // a test asserting a key pasted into an objective does not leave the machine found
      // the summary and the search path disagreeing about it.
      const swept = redactPayload(stats, options);
      return {
        ...stats,
        ...(typeof stats.objective === 'string' ? { objective: swept.objective ?? null } : {}),
        workspaceDir: redactPath(stats.workspaceDir, { homeDir, roots: redactRoots }),
        ...(unavailable ? { recordsUnavailable: true } : {}),
        ...(inArtifact ? { recordsInArtifact: true } : {}),
      };
    }

    case 'trajectory_turns': {
      const sessionId = await requireSession(store, args.sessionId);
      let all = store.getTurnSummaries(sessionId);
      // The same fallback `trajectory_get` and `trajectory_find` use, for the same
      // reason. The projection fold answers `[]` for a session the indexer has not
      // reached, and an empty progress view reads as "this run was one turn of no
      // records" rather than "this run is not in the index yet" — while
      // `trajectory_get` was listing that same session's records from disk, under turn
      // ids, one call away.
      let source = 'sqlite';
      // Kept outside the branch: `recordsUnavailable` is asked about the artifact after
      // the fallback has run, not instead of it.
      let artifact = null;
      if (all.length === 0) {
        artifact = await store.readJsonlTurnSummaries({ sessionId });
        if (artifact.available) {
          all = artifact.turns;
          source = artifact.source;
        }
      }
      // `all.length === 0` is a count of zero rows and not a statement about the page:
      // this tool folds the whole session before it slices, so a `GROUP BY` over the
      // session's rows yields at least one group whenever the session has any row at
      // all. Empty here, with no artifact, means the records are not anywhere this
      // Plugin can read — which is a different account from "this run had no turns",
      // and the reply used to be the first one.
      //
      // The row count is read only when that outcome makes it the deciding fact, so the
      // ordinary path — which already pays a count inside `getTurnSummaries`' own cache
      // key — does not pay a second one on what is the cheapest progress query there
      // is. It is a real count whenever it is read, never a stand-in for one.
      const unavailable = all.length === 0 && recordsUnavailable({
        sessionExists: true, projectionRows: store.messageRowCount(sessionId), artifact,
      });
      const at = normalizeOffset(args.offset ?? 0);
      // Clamped here rather than in the store, because this is the one paged tool that
      // has no store query to clamp for it — the turn list is folded whole and sliced in
      // the handler, and a `slice` applies whatever arithmetic it is handed.
      // `limit: 0` paged nothing and answered `nextOffset: null`, which is the same word
      // every other tool uses for "that is the whole list"; `limit: -5` paged *more* than
      // asked for, since `slice(at, at - 5)` stops that many short of the end. The schema
      // says `minimum: 1`, but `tools/call` validates no arguments, so a bound written in
      // a schema is documentation until something enforces it.
      const pageSize = clamp(args.limit ?? 200, LIMITS.turns);
      const turns = all.slice(at, at + pageSize).map((turn) => ({
        ...turn,
        // `trajectory_summary` publishes this same quantity as `decodeTokens`, for dsh
        // parity. Two names for one number across two tools is a trap: a caller that
        // sums the turn rows and checks them against the session aggregate — the obvious
        // way to use this tool — reads `undefined` from `summary.outputTokens` and has
        // no way to tell a naming difference from a miscalculation. The alias costs
        // twenty bytes a row and removes the question.
        decodeTokens: turn.outputTokens,
      }));
      const bounded = boundPayloadList(turns, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      const delivered = bounded.items.length;
      return {
        sessionId,
        // Which store answered, so a caller can tell "this run had no turns" from
        // "the turns are not in the index yet". Null timings on the artifact path are
        // read the same way — the artifact recorded no duration, which is not the same
        // as a turn that cost nothing.
        source,
        // The session's own turn count, so a caller can tell "the run was one long
        // turn" from "this page shows one turn" — the same distinction `total` makes
        // on every other list, and the one that keeps a short page from reading as a
        // whole run.
        total: all.length,
        offset: at,
        returned: delivered,
        nextOffset: delivered === 0 || at + delivered >= all.length ? null : at + delivered,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        // A capability, not a count: `total: 0, turns: []` beside `recordsUnavailable: true`
        // means the records were never found, and the zeros beside it are counts of
        // nothing rather than a report that this run did nothing.
        ...(unavailable ? { recordsUnavailable: true } : {}),
        // Read straight off the same grouping `trajectory_get`'s `turnId` filter uses,
        // so the turn count here and the filter's matches cannot disagree.
        turns: bounded.items,
      };
    }

    case 'trajectory_ingress': {
      const sessionId = await requireSession(store, args.sessionId);
      const offset = normalizeOffset(args.offset ?? 0);
      const result = store.listIngressTurns(sessionId, {
        offset,
        limit: args.limit ?? LIMITS.ingress.default,
        status: args.status ?? null,
      });
      // Swept whole, for the same reason every other record list is: the question "which
      // of these fields could carry a payload" has been answered wrong before, and a turn
      // id or a claim source is still text this plugin hands to a model. No reasoning
      // about which fields are "just identifiers" — that is the reasoning that skips one.
      const bounded = boundPayloadList(result.turns.map((turn) => redactPayload(turn, options)), {
        maxBytes: EGRESS_TOTAL_BYTES_MCP,
      });
      const delivered = bounded.items.length;
      // Paged against what the filter left. `total` stays the session's own intake count
      // and is reported for scale, but a narrowed read that ended after two rows must not
      // hand back a cursor that walks past the end of a 200-row list.
      const reachable = result.available ? result.matchedTurns : 0;
      return {
        sessionId,
        available: result.available,
        // "This runtime does not record intake" and "this session's turns all succeeded"
        // are both an empty list, and only one of them is a finding. See the assets
        // tool for why the reason is named rather than left to the reader.
        ...(result.available ? {} : { note: 'turn intake records are unavailable on this runtime: it exposes no local_runtime_turn_ingress table, or the query failed — so an empty list here means "not recorded", and a session reading clean does not mean its turns succeeded' }),
        total: result.total,
        matchedTurns: result.matchedTurns,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= reachable ? null : offset + delivered,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        turns: bounded.items,
        statusCounts: result.statusCounts,
        claimCounts: result.claimCounts,
        // Both are `null` rather than `0` whenever the runtime could not count, and the
        // difference is the whole reason this tool exists: a `0` beside a session that
        // reports no error and no warnings reads as a clean run.
        failedOrAborted: result.failedOrAborted,
        missingFromTranscript: result.missingFromTranscript,
        reportedInTranscript: result.reportedInTranscript,
      };
    }

    case 'trajectory_assets': {
      const sessionId = await requireSession(store, args.sessionId);
      const offset = normalizeOffset(args.offset ?? 0);
      const { assets, total, available } = store.listSessionAssets(sessionId, { offset, limit: args.limit ?? 50 });
      // Two passes, both needed, neither a substitute for the other.
      //
      // The sweep at the RPC boundary would catch a credential in any of these fields,
      // but this tool is also reachable through `createHandler().call()`, and more to
      // the point every other tool here redacts its own fields rather than trusting the
      // boundary — `trajectory_agent` does it for the same reason. An asset's display
      // name is free text typed by whoever produced the file, and the fixture caught
      // exactly that: `api_key=…` in a `name` went out verbatim while the sibling
      // `path` field folded correctly.
      //
      // The row is swept whole rather than field by field, because the question "which
      // of these columns could carry a payload" has already been answered wrong once —
      // by a sweep that reasoned about the fields instead of covering them. `path` is
      // folded first and explicitly, since a path is the one field where `~` is the
      // answer rather than damage, and the rest of the path has to survive for the
      // reader to know which file it was.
      const rows = assets.map((asset) => redactPayload(
        { ...asset, path: asset.path ? redactPath(asset.path, { homeDir, roots: redactRoots }) : null },
        options,
      ));
      const bounded = boundPayloadList(rows, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      const delivered = bounded.items.length;
      return {
        sessionId,
        // "The table could not be read" and "the session produced nothing" are both an
        // empty list. Only one of them is a finding, so only one of them may read as a
        // plain empty page.
        available,
        ...(available ? {} : { note: 'session assets are unavailable on this runtime: it exposes no local_runtime_session_assets table, or the query failed — so an empty list here means "not listed", not "none exist"' }),
        total,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= total ? null : offset + delivered,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        assets: bounded.items,
      };
    }

    case 'trajectory_changes': {
      const sessionId = await requireSession(store, args.sessionId);
      const offset = normalizeOffset(args.offset ?? 0);
      const detailLevel = args.detailLevel === 'full' ? 'full' : 'summary';
      const {
        turns, total, matchedTurns, available, matchedFiles, matchedScratchFiles, unmatchedTurns,
      } = store.listTurnChanges(sessionId, {
        offset,
        limit: args.limit ?? LIMITS.changes.default,
        path: args.path ?? null,
        // `diffBytes` is passed only in full mode, so `projectFile` omits the `diff`
        // keys entirely in summary rather than sending `diff: ''` for every file.
        ...(detailLevel === 'full' ? { diffBytes: LIMITS.changeDiffBytes } : {}),
      });
      // Swept whole, for the same reason `trajectory_assets` is: the question "which of
      // these fields could carry a payload" has already been answered wrong once, by a
      // sweep that reasoned about the fields instead of covering them. A diff is the
      // most free-form text this plugin has ever carried out of a database row, and a
      // session that diffed an `.env` file diffs its contents.
      const rows = turns.map((turn) => redactPayload(turn, options));
      const bounded = boundPayloadList(rows, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      const delivered = bounded.items.length;
      // Paging is measured against what the filter left. `total` is the session's own
      // change-set count and stays in the reply for scale, but a narrowed read that
      // ended after three rows must not hand back a cursor that walks off the end.
      const reachable = available ? matchedTurns : 0;
      return {
        sessionId,
        detailLevel,
        // "This runtime does not record them" and "this session changed nothing" are
        // both an empty list, and only one of them is a finding. See trajectory_assets
        // for why the reason is named rather than left to the reader.
        available,
        ...(available ? {} : { note: 'turn change sets are unavailable on this runtime: it exposes no local_runtime_turn_diffs table, or the query failed — so an empty list here means "not recorded", not "nothing changed"' }),
        total,
        offset,
        returned: delivered,
        nextOffset: delivered === 0 || offset + delivered >= reachable ? null : offset + delivered,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        turns: bounded.items,
        // How many files the filter matched across the whole session, and how many of
        // those are scratch — **session-wide, not page-scoped**; each turn's own count is
        // on the turn. The second is not a warning: on a real machine more than half the
        // entries in a busy turn are temp-dir apply scripts, and a reader who is not told
        // will read an 82-file turn as 82 repository edits.
        ...(matchedFiles === undefined ? {} : { matchedFiles, matchedScratchFiles }),
        // How many of the change sets the filter matched name a turn the transcript does
        // not carry. Reported beside `total`, never instead of it — those change sets are
        // real edits, and on a real machine 11.8% of every file entry sits behind one.
        // `null` when the transcript's turn ids could not be read at all, so a broken
        // lookup is never published as "nothing is unmatched".
        //
        // This is the fact that makes `trajectory_summary`'s `changedTurns` and
        // `trajectory_turns`' `total` reconcilable: they count turns of two tables the
        // runtime is not required to keep in step, and on 7 sessions the first is
        // strictly larger than the second.
        ...(unmatchedTurns === undefined ? {} : { unmatchedTurns }),
        // A filter that matched nothing is not the same as a session that changed
        // nothing, and it is the one narrowing mistake the rows cannot show.
        ...(args.path && available && matchedFiles === 0 ? { pathMatchedNothing: true } : {}),
      };
    }
    case 'trajectory_agent': {
      const sessionId = await requireSession(store, args.sessionId);
      const definition = store.getAgentDefinition(sessionId);
      // `absent` rather than a null definition, because "this session was dispatched
      // without one" and "this session cannot be read" are different answers, and the
      // first is the common one.
      if (!definition) {
        return { sessionId, present: false, available: true };
      }
      // The store redacts the system prompt, but with no path context — so an absolute
      // home path written into the prompt survived it. The panel route re-redacts for
      // exactly this reason, and the egress contract caught the same leak here on the
      // day this tool was added. Done over the whole definition rather than the prompt
      // alone, because `project` and the tool list can carry a path too, and folding
      // one field while leaking the next is how the leak comes back.
      const redacted = redactPayload(definition, {
        maxLength: 20000, maxDepth: EGRESS_MAX_DEPTH, maxEntries: EGRESS_MAX_ENTRIES,
        homeDir, roots: redactRoots,
      });
      // `boundPayloadList` bounds *arrays*; handed anything else it answers an empty
      // list rather than saying so, which is how a definition of 6 KB silently came
      // back as two bytes. Wrapped so the same budget and truncation reporting apply.
      const bounded = boundPayloadList([redacted], { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      return {
        sessionId,
        present: true,
        available: true,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        definition: bounded.items[0] ?? null,
      };
    }

    case 'trajectory_find': {
      const sessionId = await requireSession(store, args.sessionId);
      let found = store.findEvents({
        sessionId,
        query: args.query,
        offset: args.offset ?? 0,
        limit: args.limit ?? 20,
        detailLevel,
      });
      // The artifact is consulted whenever the *session* has no projection at all, the
      // same guard `trajectory_get` uses and for the same reason. Without it a session
      // the indexer has not reached yet reports "no matches" while its records sit on
      // disk — and a search that says "nothing here" when it never looked is the one
      // answer this Plugin is built not to give.
      let findArtifact = null;
      if (found.sessionRows === 0) {
        const artifact = await store.findJsonlEvents({
          sessionId, query: args.query, offset: args.offset ?? 0, limit: args.limit ?? 20, detailLevel,
        });
        findArtifact = artifact;
        if (hasArtifactEvidence(artifact)) {
          // Projected into the match shape rather than spread in. The artifact read
          // answers with `events`; spreading it left `matches` holding the empty
          // projection result, so the reply said "no matches" *and* claimed `jsonl` —
          // a fallback that ran and still returned the answer it was meant to replace.
          found = {
            ...found,
            source: artifact.source,
            total: artifact.total,
            nextOffset: artifact.nextOffset,
            matches: artifact.events.map((event) => ({
              index: event.index,
              role: event.role ?? null,
              turnId: event.turnId ?? null,
              createdAtMs: event.createdAtMs ?? null,
              // Where the needle is, from the same pass that decided the record matched.
              // It used to be a hardcoded `'content'`, so a term living in the thinking
              // came back labelled as the message — and, being quoted from
              // `event.content`, with no excerpt at all, because the needle was not in
              // there either. `other` with no location means the reader found it in text
              // this projection does not model; it is still a hit, and `total` has
              // already counted it.
              field: event.matchLoc?.field ?? 'other',
              // Around the match, on the same terms as the projection path — this used
              // to be `event.content.slice(0, 400)`, the first 400 characters of the
              // message, which on a long record does not contain the text that matched.
              // A snippet whose purpose is to show what was found, that does not show
              // it, is worse than none: the reader sees four hundred characters of
              // something else and concludes the match was elsewhere.
              ...(detailLevel === 'full' && event.matchLoc
                ? { snippet: snippetAround(event.matchLoc.text, String(args.query ?? '')) }
                : {}),
              ...(detailLevel === 'full' && event.matchLoc?.in
                ? { matchedToolCall: event.matchLoc.in }
                : {}),
            })),
          };
        }
      }
      // A snippet is a slice of a message body, so it carries exactly what a message
      // body carries — including a credential. `trajectory_get` runs its full-detail
      // records through `redactEvent`; a match has to go through the same sweep or the
      // search tool becomes the one path that hands out unredacted session text, which
      // is worse than not having it: the result looks like a safe, bounded excerpt.
      const matches = detailLevel === 'full'
        ? found.matches.map((match) => (typeof match.snippet === 'string'
          ? { ...match, snippet: redactText(match.snippet, { maxLength: 2000, homeDir, roots: redactRoots }) }
          : match))
        : found.matches;
      const bounded = boundPayloadList(matches, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      const delivered = bounded.items.length;
      // Where the cursor goes next, and the two sources state that in different shapes.
      //
      // The projection knows how many records in the session match, so the walk ends
      // where `offset + total` is reached and the cursor is computed from what was
      // delivered. The artifact fold deliberately does not pay for a whole-file count —
      // it stops at the page boundary and publishes a *cursor* (`offset + records read`)
      // or null when it reached the end of the file.
      //
      // Comparing `offset + delivered` against the artifact's missing `total` treated
      // `null` as `0`, which ended every artifact walk after one page: an un-indexed
      // session with twelve matches delivered five and answered `nextOffset: null`, so
      // the other seven were reachable by no call and the reply called the list complete.
      // Reading the artifact's cursor as an *upper bound* instead of as the cursor is the
      // same defect wearing the opposite sign, and fails on the first page either way.
      let cursor = null;
      if (delivered > 0) {
        if (typeof found.total === 'number') {
          // `total` is the session's whole match count, an absolute bound rather than a
          // count measured from `offset`. Adding the offset to it ends the walk `offset`
          // records late, which on a paged search meant the last page handed back a
          // cursor instead of null.
          cursor = found.offset + delivered >= found.total ? null : found.offset + delivered;
        } else {
          const read = typeof found.nextOffset === 'number'
            ? found.nextOffset - found.offset
            : found.matches.length;
          // A page the frame budget trimmed has to be re-read from the break, not from
          // the fold's own cursor, which points past records this caller never received.
          cursor = delivered < read
            ? found.offset + delivered
            : (typeof found.nextOffset === 'number' ? found.nextOffset : null);
        }
      }
      return {
        sessionId,
        detailLevel,
        ...(detailNote ? { note: detailNote } : {}),
        source: found.source,
        total: found.total,
        offset: found.offset,
        returned: delivered,
        nextOffset: cursor,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        ...(found.source === 'error' ? { error: found.error ?? 'event_find_failed' } : {}),
        // Set when the indexed `LIKE` found nothing and this session's rows were folded
        // in JavaScript to answer instead. The two paths differ by an order of
        // magnitude in cost on a large session, so the caller gets to know which one
        // ran rather than finding out as a slow call. Absent on the ordinary path —
        // a constant `false` would be a field that says nothing while looking like one
        // that does.
        ...(found.unindexedCaseMatch === true ? { unindexedCaseMatch: true } : {}),
        // The one shape this Plugin must never give: a search that never searched,
        // reporting zero matches. `total: 0` beside a session with no readable records
        // reads as a finding about the *content* — the word was absent from this run —
        // when the truth is that no record was ever looked at. Measured on the machine
        // this was found on, the query `the` matches 22,207 records of a real session
        // and zero of an unreadable one, so the number is not even a function of the
        // query. Same disclosure the list tools carry, for the same reason.
        ...(found.source === 'error' ? {} : (recordsUnavailable({
          sessionExists: true,
          projectionRows: found.sessionRows,
          artifact: findArtifact,
        }) ? { recordsUnavailable: true } : {})),
        matches: bounded.items,
      };
    }

    case 'trajectory_get': {
      const sessionId = await requireSession(store, args.sessionId);
      let page = store.getEvents({
        sessionId,
        offset: args.offset ?? 0,
        limit: args.limit ?? 200,
        turnId: args.turnId,
        role: args.role,
        detailLevel,
      });
      // The artifact is consulted whenever the *session* has no projection at all,
      // not whenever this particular page came back empty.
      //
      // The guard used to be `source !== 'sqlite'`, and a live projection answers
      // `sqlite` for zero rows — so the fallback never ran for the case it exists
      // for: a session whose records have not been indexed yet but whose
      // `messages.jsonl` is on disk. That session reported "no records" while the
      // artifact held them.
      //
      // Keying it on the page was wrong in a way this one is not. "This page is empty"
      // is not a statement about the session: a turn filter that matched nothing says
      // it too, and the caller was then answered from a second source, with that
      // source's `total`, for the same session. It also let the source change between
      // two pages of one cursor when the indexer landed in between.
      //
      // What this does *not* claim: no record was being lost. The projection is built
      // from the artifact, so offset n names the same record in either, and a session
      // that is still being indexed reports the projection's count — a snapshot of what
      // has landed — either way. What is fixed is that one cursor walk now stays in one
      // source and answers every page of it the same way.
      let fallbackArtifact = null;
      if (page.sessionRows === 0) {
        const artifact = await store.readJsonlEvents({
          sessionId, offset: page.offset ?? 0, limit: args.limit ?? 200, detailLevel, turnId: args.turnId, role: args.role,
        });
        fallbackArtifact = artifact;
        if (hasArtifactEvidence(artifact)) {
          // `sessionRows` counted the *projection*, and the artifact is exactly what has
          // just replaced it. `readJsonlEvents` carries no count of its own — it stops at
          // the page boundary rather than paying for a whole-file count — so the
          // projection's `0` survived the merge into a reply holding the artifact's
          // events, and the `sessionTotal` emit below published it: `sessionTotal: 0`
          // beside three returned records.
          //
          // Dropped rather than zeroed or back-filled. The artifact's size is not known
          // here, and "not known" is not zero — a count that cannot be computed has no
          // business wearing the field a real count would.
          const { sessionRows: _projectionRows, ...projection } = page;
          page = { ...projection, ...artifact };
        }
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
        ...(detailNote ? { note: detailNote } : {}),
        source: page.source,
        offset: readAt,
        returned: delivered,
        total: page.total ?? null,
        // Present only when a turn filter is in play, so `total` (what matched) and
        // `sessionTotal` (what the session holds) are never confused for one another.
        ...(page.sessionRows !== undefined && page.sessionRows !== page.total
          ? { sessionTotal: page.sessionRows } : {}),
        nextOffset: delivered === 0 ? null : (bounded.truncated ? readAt + delivered : page.nextOffset),
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        // The page byte budget is a *different* cut from the frame budget above: the
        // frame budget trims a list this reply already read, while this one stopped
        // the read itself, so `returned` is below `limit` with nothing omitted from
        // what was read. Reporting it as `truncated: false, omitted: 0` described a
        // short page as a whole one. It is its own field rather than folded into
        // `truncated` because `omitted: 0, truncated: true` reads as a contradiction.
        ...(page.pageBytesTruncated ? { pageBytesTruncated: true } : {}),
        ...(page.source === 'error' ? { error: page.error ?? 'event_read_failed' } : {}),
        ...(page.droppedOversized > 0 ? { droppedOversized: page.droppedOversized } : {}),
        ...(page.malformedLines > 0 ? { malformedLines: page.malformedLines } : {}),
        ...(page.taskIndexTruncated ? { taskIndexTruncated: true } : {}),
        // A read that *failed* is not a read that found nothing, and the `error` above
        // already says so — claiming both would tell the caller the records are gone
        // when the truth is that the Plugin never got to look. Same guard on the fold:
        // `recordsUnavailable` only speaks about a session it can see and count.
        ...(page.source === 'error' ? {} : (recordsUnavailable({
          sessionExists: true, projectionRows: page.sessionRows, artifact: fallbackArtifact,
        }) ? { recordsUnavailable: true } : {})),
        events: bounded.items,
      };
    }

    case 'trajectory_search': {
      // Pinned and resumed exactly as `trajectory_list` is, because matches come back in
      // the same recency order over the same column the runtime rewrites — including the
      // strict bound, so a write landing in the pin's own millisecond still leaves.
      //
      // The fingerprint is the query itself: a cursor taken from a search for one phrase
      // names a key that sits above most matches of another, so handing it back across
      // queries returned an empty page with no note at all — the one answer this Plugin
      // never means to give by accident. It starts the new query's first page instead,
      // and says why the cursor was not used.
      const fingerprint = sessionCursorFingerprint({
        query: args.query,
        untilMs: Number.isFinite(args.untilMs) ? args.untilMs : null,
      });
      const decoded = decodeSessionCursor(args.cursor);
      const foreignCursor = Boolean(decoded) && decoded.fingerprint !== fingerprint;
      const at = foreignCursor ? null : decoded;
      const pinMs = at ? at.pinMs : Date.now();
      const pageSize = clamp(args.limit ?? 20, LIMITS.search);
      const {
        sessions: found, total, failed, unsearchable,
        objectivesIndexed, objectiveMatchedSessionIds,
      } =
        store.searchSessions({
          query: args.query,
          limit: pageSize,
          cursor: at ? args.cursor : undefined,
          untilMs: Math.min(Number.isFinite(args.untilMs) ? args.untilMs : Number.POSITIVE_INFINITY, pinMs - 1),
        });
      const sessions = found
        .map((session) => ({
          ...session,
          workspaceDir: redactPath(session.workspaceDir, { homeDir, roots: redactRoots }),
          // The objective is the most free-form text this reply has ever carried: it is
          // whatever the user typed to start the run, so it can hold a path, a branch
          // name, a pasted snippet or a credential. `redactPayload` sweeps the whole row
          // and reasons about the fields it carries, so the objective goes through it
          // with everything else rather than being trusted because it "is just a summary".
          ...(typeof session.objective === 'string' ? { objective: redactPayload(session, options).objective ?? null } : {}),
        }));
      const bounded = boundPayloadList(sessions, { maxBytes: EGRESS_TOTAL_BYTES_MCP });
      // An empty result on a runtime whose SQLite lacks FTS5 looks identical to a
      // query that matched nothing, so say which one it is. A query that *failed*
      // is the same shape again, and worse: FTS5 is present, so nothing in the
      // answer hints that the search never ran.
      //
      // A runtime whose index exists but lacks the fields the match names is a third
      // shape, and the one note above would describe it wrongly — it says the query
      // ran and broke, when in fact no query of this shape can ever run here. It gets
      // its own wording because the reader's next move differs: a failed query is
      // worth retrying, a mismatched index is not.
      //
      // `unsearchable` is checked before the `hasFts` fallback because `searchSessions`
      // now reports a store with no index at all as unsearchable too — the same fact
      // about the same installation, and the caller must not retry either. The wording
      // still has to be the right one of the two: "does not carry the fields" describes
      // a table that exists and is missing columns, and saying it about a machine that
      // ships no FTS5 at all points the reader at an index that is not there.
      const note = [
        ...(foreignCursor
          ? ['the cursor you passed belongs to a different query, so this is page one of the query you asked for — hand this reply\'s own nextCursor back to continue it']
          : []),
        ...(!store.hasFts
          ? ['full-text search is unavailable on this Node runtime (bundled SQLite without FTS5)']
          : unsearchable
            ? ['this runtime\'s session index does not carry the fields full-text search needs, so nothing was searched']
            : failed
              ? ['the full-text query failed, so an empty result here means "not searched", not "no match"']
              : []),
      ];
      const noteText = note.length ? note.join('; ') : null;
      const delivered = bounded.items.length;
      const lastCarried = bounded.items[delivered - 1];
      // Same end-of-walk rule as the session list: a short read is the end, a full one
      // is not, and a page the frame budget trimmed is never mistaken for the end.
      const reachedEnd = delivered === 0 || (delivered === found.length && found.length < pageSize);
      return {
        query: args.query,
        // Match count for the query, independent of the page. A capped page that did
        // not carry it would read as "these are the matches" when two thirds of them
        // were never reachable by any call.
        total,
        returned: delivered,
        // Advance by what was carried, so a page the frame budget trimmed is re-read
        // from the break rather than skipped forever.
        nextCursor: reachedEnd || !lastCarried
          ? null
          : encodeSessionCursor({ pinMs, fingerprint, updatedAtMs: lastCarried.updatedAtMs, sessionId: lastCarried.sessionId }),
        walkPinnedAtMs: pinMs,
        truncated: bounded.truncated,
        omitted: bounded.omitted,
        ftsAvailable: store.hasFts,
        // Whether the recorded objectives were searched, and which sessions they reached.
        //
        // Separate from `ftsAvailable` because they are different facts about different
        // tables: the runtime's index carries no objective column at all (its schema has
        // id, agent, title, workspace, purpose, status and type), so on the machine this
        // was measured on **0 of 15** goal-bearing sessions could be found by a word from
        // their own objective through the index alone. A reader who gets an empty result
        // needs to know whether a field they were looking in was consulted.
        //
        // Objective matches ride on the page but never in `total` or the cursor — the
        // walk is an FTS walk, and a cursor whose meaning depends on which source matched
        // is the one thing a cursor must not do. Rows the objective found say
        // `objectiveMatched: true` and carry the text that matched.
        objectivesIndexed: objectivesIndexed !== false,
        objectiveMatchedSessionIds: objectiveMatchedSessionIds ?? [],
        ...(noteText ? { note: noteText } : {}),
        sessions: bounded.items,
      };
    }

    case 'trajectory_tasks': {
      // Same warning scoping `trajectory_list` uses, for the same reason: a tool that
      // does not publish what the store said while building its answer leaves the reader
      // with a `0` that reads as a finding. `trajectory_tasks` was the one list tool with
      // no `warnings` key at all, so `task_count_failed` — whose whole text is "total=0
      // means not counted" — could not reach a model by any route.
      const warnedAt = store.warnings.length;
      const droppedAt = store.warningsDropped;
      const sessionId = await requireSession(store, args.sessionId);
      const total = store.countBackgroundTasks(sessionId, { kind: args.kind });
      const at = normalizeOffset(args.offset ?? 0);
      // `limit` says how many records the caller wants; `TASK_LIST_MAX_ROWS` says how
      // many this read is willing to materialise. The smaller wins, and the difference
      // is not silently dropped — it is counted in `omitted` and reachable through
      // `nextOffset` below, so a caller that pages sees every task exactly once.
      const wanted = args.limit ?? 200;
      const readLimit = Math.min(wanted, TASK_LIST_MAX_ROWS);
      const tasks = store.listBackgroundTasks(sessionId, {
        limit: readLimit, kind: args.kind, offset: at,
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
      // The cursor advances by the records this reply actually carried, not by the
      // records the store read. Trimming is a second cut on top of the read: a page of
      // 802 tasks trimmed to 252 delivered 252 and answered `nextOffset: 802`, which
      // is past `total` for that session — so `null`, which means "no more pages".
      // The 550 tasks in between were neither returned nor reachable, permanently, and
      // `omitted` counted them without any surface offering a way to ask for them.
      // `trajectory_get` already advances from `delivered`; this is the same rule.
      const consumed = bounded.truncated ? delivered.length : tasks.length;
      const covered = at + consumed;
      // Measured against the session's own count, not against this page. Both the byte
      // budget and the read cap can leave tasks behind, and a page that is shorter than
      // the session for either reason is a truncated view of it — including the rows the
      // read cap chose not to fetch, which no amount of paging *within this reply*
      // would have delivered.
      const omitted = Math.max(0, total - delivered.length);
      const droppedHere = store.warningsDropped - droppedAt;
      const from = Math.max(0, warnedAt - droppedHere);
      return {
        sessionId,
        // A capability, not a count. `total: 0` beside `tasksAvailable: true` means this
        // session dispatched nothing; beside `false` it means this installation cannot
        // say — and without the field the second was indistinguishable from the first,
        // which is the one answer here that reads as a finding.
        tasksAvailable: store.hasTasks,
        returned: delivered.length,
        totalMs: delivered.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
        failed: delivered.filter((task) => task.status === 'failed').length,
        subagents: delivered.filter((task) => task.kind === 'subagent').length,
        total,
        offset: at,
        // A page that delivered nothing cannot be advanced past without handing back
        // the offset it was given, which every caller would re-request forever.
        // `boundPayloadList` keeps at least one record, so this only guards an empty
        // store page, not the oversize-single-record case.
        nextOffset: delivered.length === 0 ? null : (covered < total ? covered : null),
        truncated: bounded.truncated || omitted > 0,
        omitted,
        tasks: delivered,
        // What the store said while answering, and only that: a drop caused by an earlier
        // read is not this answer's omission, and `trajectory_list` works the same slice
        // out of the same ring.
        warnings: store.warnings.slice(from),
        ...(store.warningsDropped > droppedAt
          ? { warningsDropped: store.warningsDropped - droppedAt } : {}),
      };
    }

    case 'trajectory_task_output': {
      const output = await store.readTaskOutput(args.taskId, { maxBytes: args.maxBytes ?? 16384 });
      // `keep: 'tail'` because `readTaskOutput` already read a tail. Without it the
      // character bound keeps the head of that tail, so asking for more than 64000
      // characters returns *less* of the newest output than asking for less does — on
      // one 2.7 MB task log, `maxBytes: 262144` came back 70554 characters short of the
      // file's last line. This is the surface "why did this task fail" answers, and the
      // answer is at the end.
      return { ...output, text: redactText(output.text, { maxLength: 64000, keep: 'tail', homeDir, roots: redactRoots }) };
    }

    case 'trajectory_studio': {
      if (!studio) throw new Error('studio_unavailable');
      if (args.stop) return { stopped: await studio.stop() };
      const started = await studio.start({ sessionId: args.sessionId, port: args.port });
      const notes = ['Open the URL exactly as returned, including the #t= fragment. '
        + 'It is this process\'s capability for the panel; do not log it or share it.'];
      // Appending, never replacing — the capability note is the reason the URL is safe to
      // hand over, and a second fact must not displace it.
      //
      // Asking for a port and receiving another one is the case this is for. The panel
      // moves to a free port rather than failing, which is right, but it used to report
      // the move only to the operator's stderr: the reply carried a working URL on a
      // different port and no word about it, while the module's own comment above that
      // write names the danger — something else is still serving the requested port, so
      // a reader with that panel already open is looking at stale code and would have
      // no way to tell it from this one. A `port` that is accurate is not enough when the
      // question was "start it there".
      if (started.portHonoured === false) {
        notes.push(started.reused
          ? `port ${started.requestedPort} was requested but a panel is already running on ${started.port}, and it was reused rather than replaced — its URL is already open somewhere`
          : `port ${started.requestedPort} was requested but is in use by something else, so this panel is on ${started.port}`);
      }
      return {
        url: started.url,
        port: started.port,
        reused: started.reused,
        sessionId: started.sessionId ?? null,
        boundTo: started.boundTo,
        capabilityRequired: true,
        note: notes.join(' '),
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

  // The envelope is checked before the method is routed. `jsonrpc` is what makes this a
  // JSON-RPC 2.0 message at all, and a message arriving without it was executed anyway:
  // a host speaking a different dialect got a successful result instead of being told
  // its framing was wrong, which is the one reply it could have acted on.
  if (message.jsonrpc !== '2.0') {
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }
  // `method` names what to do, so a message without one has nothing to route. It used to
  // fall through to the method-not-found branch and answer `-32601 Method not found:
  // undefined`, which describes a framing fault as a missing handler — and sends the
  // reader looking for a tool that does not exist rather than at their own request.
  if (typeof method !== 'string' || method === '') {
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }
  // `params`, when present, is a structured value. A scalar used to pass validation and
  // reach the tool, where `params?.name` became undefined and the call came back as
  // `unknown_tool: undefined` — a bad request reported as a missing tool.
  if (params !== undefined && (params === null || typeof params !== 'object')) {
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }

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
        // Attached here, at the one place every tool call passes through, because the
        // condition cannot be detected from inside a handler: none of them validate the
        // argument they were given.
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(withPagingNote(safe, name, args), null, 2) }],
          structuredContent: withPagingNote(safe, name, args),
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

/**
 * Answer one JSON-RPC envelope, which may be a single request or a batch.
 *
 * A batch is an array of requests answered by an array of responses. This server
 * rejected every array as an Invalid Request, so a host that legitimately pipelines
 * several calls in one frame got one error for work it had issued — and the `id` of
 * each individual call, which is the only thing correlating a response to its request,
 * was gone.
 *
 * The rules a batch inherits from the specification, and which are easy to get wrong:
 *
 * - An **empty** array is not an empty batch, it is an invalid request, and is answered
 *   with a single error object rather than an empty array.
 * - A **notification** inside a batch is not answered. An array of nothing but
 *   notifications therefore produces no output at all, rather than an empty array that
 *   the caller has to disambiguate from a batch of failed calls.
 * - Each entry is validated on its own, so one malformed entry does not discard the
 *   answers to the well-formed ones beside it.
 */
export async function handleRpcEnvelope(handler, message) {
  if (!Array.isArray(message)) return handleRpcMessage(handler, message);
  if (message.length === 0) return rpcError(null, -32600, 'Invalid Request');
  const responses = [];
  for (const entry of message) {
    // Decided before the entry is handled, and from the envelope rather than from
    // whatever `handleRpcMessage` concluded about it, so a notification stays
    // unacknowledged even when its contents are malformed.
    const isNotification = Boolean(entry) && typeof entry === 'object'
      && !Array.isArray(entry) && entry.id === undefined;
    const answer = await handleRpcMessage(handler, entry);
    if (answer && !isNotification) responses.push(answer);
  }
  return responses.length > 0 ? responses : null;
}

/**
 * The two paging conventions, by tool.
 *
 * They are not interchangeable and the shape of each is dictated by what it pages over:
 * `trajectory_list` and `trajectory_search` order by `updated_at_ms DESC`, the column the
 * runtime rewrites whenever it writes to a session, so a position in that list moves and a
 * walk by row number silently drops whatever moved; they page by a pinned cursor. The other
 * five page over an append-only key, so a position is stable and `offset` is the honest
 * continuation.
 *
 * The trap is that a caller carries one convention over to the other. It used to be
 * answered with silence, because nothing validates a tool's arguments:
 *
 * - `trajectory_turns` with `cursor: 3` came back `returned: 5, nextOffset: 5, total: 445`
 *   and no note at all. That is page zero of a 445-turn session, presented exactly like the
 *   page the caller asked to be on.
 * - `trajectory_list` with `offset: 3` is worse: the reply has no `offset` field to
 *   contradict what was asked, so there is nothing in the answer to notice.
 *
 * An ignored argument that silently returns the wrong page is the same failure as a
 * silently-ignored enum value: the caller cannot tell "I did what you asked" from "I did
 * what you asked and it had no effect". So it is said, in `note`, on the reply that proves it.
 */
const PAGING_BY_OFFSET = new Set([
  'trajectory_get', 'trajectory_find', 'trajectory_turns', 'trajectory_tasks', 'trajectory_assets',
  'trajectory_changes',
]);
const PAGING_BY_CURSOR = new Set(['trajectory_list', 'trajectory_search']);

/**
 * `value` with a note appended when the caller paged this tool by the other convention.
 *
 * Appended rather than replacing: a reply can already be carrying a note that matters —
 * that the level it used was not the one asked for, that the cursor belonged to another
 * walk — and the argument that was ignored is a second, independent fact about the same
 * answer. Merging keeps both, in the order the caller has to act on them.
 */
function withPagingNote(value, name, args) {
  const ignored = PAGING_BY_OFFSET.has(name) && args?.cursor !== undefined
    ? 'cursor'
    : PAGING_BY_CURSOR.has(name) && args?.offset !== undefined ? 'offset' : null;
  if (!ignored || !value || typeof value !== 'object' || Array.isArray(value) || value.error) return value;
  const wanted = ignored === 'cursor' ? 'offset' : 'cursor';
  const text = `this tool pages by ${wanted}, so the ${ignored} you passed was ignored — `
    + `this is the first page, not the one that argument names`;
  const existing = typeof value.note === 'string' ? value.note : null;
  return { ...value, note: existing ? `${existing}; ${text}` : text };
}

/** Serve MCP over stdio until stdin closes. */export async function serveStdio(handler, { input = process.stdin, output = process.stdout } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // A line that is not JSON is a parse error, and the protocol answers it with
      // `-32700`. Dropping it silently meant a host whose framing was broken — a
      // truncated write, an encoder bug, the wrong transport — received neither a result
      // nor an error, and the only symptom was a tool call that never came back and no
      // way to find out why.
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    // Notifications carry no id and must not be answered.
    if (!Array.isArray(message) && message?.id === undefined) {
      handleRpcMessage(handler, message);
      continue;
    }
    const response = await handleRpcEnvelope(handler, message);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
