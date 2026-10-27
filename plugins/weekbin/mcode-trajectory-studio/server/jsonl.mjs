/**
 * The JSONL fallback.
 *
 * The projection indexes sessions as they are written, so a very recent session
 * may not be present yet. For those, the Plugin falls back to the session's own
 * `messages.jsonl` artifact — folded into the same event shape as SQLite, minus
 * every timing field the artifact never recorded.
 *
 * Every path here is reached through `fsutil`, which canonicalizes before it
 * decides: a session directory or a `messages.jsonl` reached through a symlink is
 * refused rather than read, because the lexical path alone cannot prove the file
 * is inside the approved data directory.
 */

import path from 'node:path';

import { num, parseJson } from './json.mjs';
import { containedRealPath, openContainedRead, safeReadDir } from './fsutil.mjs';
import { LIMITS } from './config.mjs';
import { locateNeedle } from './events.mjs';

/**
 * Locate a session's artifact directory by ID suffix, without leaving the root.
 *
 * Every level is filtered to real directories first: a dirent reports a symlink as
 * neither a file nor a directory, so a linked directory never matches. The
 * surviving candidate is then canonicalized and has to stay inside the data
 * directory, because a link anywhere above it would otherwise resolve a
 * `messages.jsonl` outside the approved area. Only the canonical path is
 * returned, so a caller cannot re-derive the lexical one.
 *
 * @returns {Promise<string|null>} canonical session directory, or null.
 */
export async function findSessionDir(store, sessionId) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const root = store.sessionsRoot;
  let years;
  try {
    years = await safeReadDir(root);
  } catch {
    return null;
  }
  const dirsIn = async (dir) => (await safeReadDir(dir)).filter((entry) => entry.isDirectory());
  for (const year of years.filter((entry) => entry.isDirectory())) {
    const yearPath = path.join(root, year.name);
    for (const month of await dirsIn(yearPath)) {
      const monthPath = path.join(yearPath, month.name);
      for (const day of await dirsIn(monthPath)) {
        const dayPath = path.join(monthPath, day.name);
        for (const session of await dirsIn(dayPath)) {
          if (!session.name.endsWith(sessionId)) continue;
          const dir = await containedRealPath(store.dataDir, path.join(dayPath, session.name));
          if (dir) return dir;
        }
      }
    }
  }
  return null;
}

/**
 * Fold a `messages.jsonl` artifact into the same event shape as SQLite.
 *
 * The result carries the same page contract as the SQLite read: `nextOffset` is the
 * cursor for the next page, and it is non-null exactly when more records exist. The
 * artifact used to be read from the top every time with the cursor discarded, so a
 * file of 5,000 records answered one 1,000-record page and then reported itself
 * complete — the last 4,000 were unreachable through every surface.
 *
 * `total` is null rather than a number: the fold stops as soon as the page is full
 * plus one look-ahead record, so the record count of the whole file is deliberately
 * not paid for on every request.
 */
export async function readJsonlEvents(store, {
  sessionId, offset = 0, limit = 1000, detailLevel = 'summary', turnId, role,
} = {}) {
  const dir = await findSessionDir(store, sessionId);
  if (!dir) return { events: [], source: 'unavailable', total: 0, nextOffset: null, droppedOversized: 0, malformedLines: 0 };
  // The descriptor that containment approved is the one the stream reads, so the
  // path cannot be re-pointed at another inode between the check and the read.
  const opened = await openContainedRead(store.dataDir, path.join(dir, 'messages.jsonl'));
  if (!opened) return { events: [], source: 'unavailable', total: 0, nextOffset: null, droppedOversized: 0, malformedLines: 0 };
  // `autoClose` hands the descriptor to the stream, so destroying it — on success,
  // on a mid-stream error, and on the early stop below alike — is what releases
  // the handle.
  // The offset is normalised before it is used to build a cursor, exactly as the
  // SQLite path does: the value handed back has to be feedable straight in again.
  const readAt = Math.max(0, Math.trunc(Number(offset)) || 0);
  const stream = opened.handle.createReadStream({ encoding: 'utf8' });
  try {
    const folded = await foldJsonl(stream, { offset, limit, detailLevel, turnId, role });
    return {
      events: folded.events,
      source: 'jsonl',
      total: null,
      nextOffset: folded.hasMore ? readAt + folded.events.length : null,
      droppedOversized: folded.droppedOversized,
      malformedLines: folded.malformed,
    };
  } finally {
    stream.destroy();
  }
}

/**
 * Whether a fallback read should replace an empty projection.
 *
 * The test used to be "did the artifact yield an event", which conflates two different
 * findings. An artifact that was found, opened and read is evidence about the session
 * whether or not one of its lines parsed; an artifact that could not be located
 * (`source: 'unavailable'`) is not. Requiring a valid event meant the most damaged
 * artifact was the one whose evidence got discarded: a file where every line is
 * corrupt reported `source: 'sqlite'`, zero events and no `malformedLines` — an empty
 * SQLite session, which is a different and false account of what is on disk.
 *
 * Kept here so the HTTP and MCP surfaces cannot disagree about it again. They did:
 * both gated on the event count, and fixing one without the other would have left the
 * panel and the tool describing the same corrupt file two different ways.
 */
export function hasArtifactEvidence(artifact) {
  if (!artifact) return false;
  return artifact.source === 'jsonl' || (Array.isArray(artifact.events) && artifact.events.length > 0);
}

/**
 * Whether a session that is known to exist has no records this Plugin can read.
 *
 * The three states a caller cannot tell apart from a row of zeroes. A session row
 * exists — it has a title, an agent and a pair of timestamps — the projection holds
 * zero message rows for it, and there is no `messages.jsonl` beside it. Every surface
 * then answered with the same clean emptiness: `turns: 0, steps: 0, toolCalls: 0` from
 * the summary, `source: 'sqlite', total: 0` from the record and turn reads, and not one
 * field anywhere saying the records were never found. A model handed that reports a
 * finished piece of work as a session that did nothing, which is the most confident
 * wrong answer this Plugin can give — the session is real, the work is not missing
 * because it never happened.
 *
 * Two facts are needed rather than one, because each has its own way of being wrong.
 * `projectionRows` must be a *count*, not a page: a turn filter that matched nothing
 * is also an empty page, and `null` — the answer when the count query itself failed —
 * must not be folded in here, or a store that could not count would be reported as a
 * store that looked and found nothing. `sessionExists` matters on the surfaces that do
 * not resolve the id first: `/api/events` takes whatever id it is handed, and without
 * this an unknown session would be reported as one whose records went missing.
 *
 * Held here beside `hasArtifactEvidence` so the HTTP and MCP surfaces cannot disagree
 * about it — the same reason that helper lives here.
 *
 * @param {{sessionExists?: boolean, projectionRows?: number|null, artifact?: object}} facts
 * @returns {boolean} true only when the session is real and nothing readable was found.
 */
export function recordsUnavailable({ sessionExists, projectionRows, artifact } = {}) {
  if (sessionExists !== true) return false;
  if (projectionRows !== 0) return false;
  return !hasArtifactEvidence(artifact);
}

/**
 * Project one artifact stream into the SQLite-shaped event list.
 *
 * `offset` and `limit` mean what they mean for the SQLite read: skip `offset`
 * records, then fold up to `limit` of them. Reading stops one record past the page
 * — that look-ahead is what distinguishes "this file ends here" from "there is more",
 * which is the difference between an honest cursor and a truncated list presented as
 * a whole one. Record indices keep counting from `offset`, so a paged artifact and a
 * paged projection produce the same indices for the same records.
 *
 * The buffer is capped *incrementally*. The earlier revision appended a chunk and
 * only then tested the line size, so a single line with no newline — a truncated
 * write, a corrupt file, a hostile artifact — grew the buffer to the size of the
 * whole file before the check ever ran, which is unbounded memory from a bounded
 * read. Instead, once the pending bytes exceed the line cap the partial line can
 * never be accepted, so it is dropped and everything up to the next newline is
 * discarded without being retained. `droppedOversized` reports how many such lines
 * were seen, which is what lets a test prove the cap path actually ran.
 *
 * Exported so the buffer accounting can be tested against a synthetic stream.
 */
export async function foldJsonl(stream, {
  offset = 0, limit, detailLevel, turnId, role, match, onRecord, maxLineBytes = LIMITS.jsonlLineBytes,
}) {
  const startAt = Math.max(0, Math.trunc(offset) || 0);
  const events = [];
  const state = { skipped: 0, hasMore: false, malformed: 0 };

  /**
   * Fold one complete line, if it is a record this page wants.
   *
   * Every line reaches here — whether it arrived with its newline or as the tail the
   * stream ended on — because the previous shape only looked at lines the `\n` loop
   * found. That dropped the last line of any file not ending in a newline, silently
   * and with no counter, which is the shape an interrupted write leaves behind and the
   * most recent record in the artifact.
   *
   * A byte-order mark is stripped rather than parsed. It is metadata about the file,
   * not part of its first record; left in place it made `JSON.parse` throw and the
   * first record vanished, on every artifact a Windows tool wrote.
   *
   * @returns true when the caller should stop reading.
   */
  const take = (raw) => {
    const line = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    if (!line.trim()) return false;
    if (Buffer.byteLength(line) > maxLineBytes) return false;
    const record = parseJson(line);
    if (!record) {
      // A line that does not parse is the shape an interrupted write leaves behind,
      // which is the case this reader exists for. It is correctly not presented as a
      // record, but the oversized path counts its drops and this one did not, so a
      // file whose last record is corrupt was indistinguishable from a file that
      // simply ended.
      state.malformed += 1;
      return false;
    }
    // The turn this record names, normalised the way the projection normalises it:
    // no turn id, or an empty one, is the same "no turn" group. Nothing is inherited
    // from the previous record.
    //
    // The cursor used to be, and it was used twice. As a *label* it was a reasonable
    // reading of a session file that omits `turn_id` on continuation lines. As a
    // *filter* it was not: `TURN_KEY_SQL` has no such cursor, so asking a session for
    // one turn returned, from the artifact, records that carry no turn id at all —
    // which the same query on the same session excluded from the projection. The
    // module's stated invariant is that a caller cannot tell the two paths apart from
    // the record alone, and a filter that selects a different set breaks it outright,
    // so the label follows the record too.
    const recordTurn = record.turn_id ? record.turn_id : null;
    // The filter applies before the offset, which is what makes the two paths
    // agree: SQLite offsets into the filtered set too. The parameter used to be absent
    // from this signature entirely, so a caller that asked for one turn got every
    // turn — from a filtered SQLite read and an unfiltered artifact read, for the same
    // session.
    //
    // `undefined` means no filter; `null` means the records that name no turn, which is
    // a group the turn fold reports and a caller holding that id back is asking about.
    // `undefined` and `null` must not collapse, or that second question answers with
    // every record in the file.
    if (turnId !== undefined && recordTurn !== turnId) return false;
    // The role filter, at the same layer and in the same position as the turn filter
    // above, for the same reason the turn filter had to be here: applied *after* the
    // offset, `offset` would count records rather than matches and the two sources would
    // disagree about what a given offset names. A role filter honoured on the projection
    // and silently dropped here would answer the same question two ways depending on
    // whether the session happened to be indexed yet.
    if (role !== undefined) {
      // `record.message.role`, not `record.role`: the role an artifact line carries lives
      // inside `message`, which is the same object the event below reads it from. Reading
      // the outer level compares against a field the record does not have, so every line
      // reads as role-less and the filter matches only the role-less group — a filter that
      // applies and answers the wrong question, which is the worst of the three outcomes
      // this comment is guarding against.
      const recordRole = (record?.message && typeof record.message === 'object'
        ? record.message.role
        : undefined) ?? null;
      if (role === null || role === '') {
        if (recordRole !== null) return false;
      } else if (recordRole !== role) {
        return false;
      }
    }
    // A content predicate, applied at the same layer and in the same position as the
    // turn filter: before the offset, so `offset` counts matches rather than records —
    // which is what the SQLite search does too, and what keeps the two paths agreeing
    // about what a given offset names.
    //
    // A predicate may return where it matched rather than a bare yes, and the event
    // carries that through. It is what lets the caller report the field the needle is
    // actually in: deciding "yes" here and then guessing "the message" over there is how
    // a term in the thinking came back labelled as content, with no excerpt.
    let located = null;
    if (typeof match === 'function') {
      located = match(record);
      if (!located) return false;
    }
    // A consumer that wants the records rather than the pages they become. Placed here,
    // after both filters and before the offset, so it sees the same set the page would
    // — and it returns immediately, because a caller folding the whole file does not
    // want its records materialised as events on the way past.
    if (typeof onRecord === 'function') {
      onRecord(record, recordTurn);
      return false;
    }
    if (state.skipped < startAt) { state.skipped += 1; return false; }
    // One record past the page is the look-ahead: it proves there is a next page, and
    // it costs one parse rather than a second pass over the whole file.
    if (events.length >= limit) { state.hasMore = true; return true; }

    const message = record.message && typeof record.message === 'object' ? record.message : {};
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
    const thinking = parts.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('');
    const toolUses = parts.filter((part) => part?.type === 'toolCall');
    const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
    // The same shape the projection returns, field for field, so a caller cannot tell
    // which of the two it got from the record alone. It is the same projection the
    // earlier revision emitted; moving it into `take` changed when lines are consumed,
    // not what a line becomes.
    const event = {
      index: startAt + events.length,
      source: 'jsonl',
      msgId: record.message_id ?? null,
      turnId: recordTurn,
      role: message.role ?? null,
      sourceKind: null,
      kind: null,
      finishReason: message.stopReason ?? null,
      createdAtMs: num(message.timestamp),
      thinkingDurationMs: null,
      requestDurationMs: null,
      inputKind: message.role === 'user' ? 'human' : 'unknown',
      originType: null,
      goalId: null,
      usage: usage ? {
        inputTokens: num(usage.input),
        outputTokens: num(usage.output),
        cacheReadTokens: num(usage.cacheRead),
        totalTokens: num(usage.totalTokens),
        contextWindowTokens: null,
      } : null,
      contextUsage: null,
      toolCallCount: toolUses.length || (message.toolName ? 1 : 0),
      failureCount: message.isError ? 1 : 0,
      hasThinking: thinking.length > 0,
      contentLength: text.length,
      model: message.model ?? null,
    };
    const callNames = toolUses.length
      ? toolUses.map((call) => ({ name: call.name ?? null, id: call.id ?? null }))
      : (message.toolName ? [{ name: message.toolName, id: message.toolCallId ?? null }] : []);
    event.toolCalls = callNames.length
      ? callNames.map((call, position) => {
          const projected = {
            ...call,
            status: message.isError && position === 0 ? 3 : (message.toolName ? 2 : null),
            ok: !(message.isError && position === 0),
            durationMs: null,
            taskId: null,
            taskStatus: null,
            agentName: null,
            childSessionId: null,
            hasOutput: false,
          };
          if (detailLevel === 'full') {
            projected.args = toolUses[position]?.arguments ?? null;
            projected.result = position === 0 && message.content ? message.content : null;
            projected.description = null;
          }
          return projected;
        })
      : null;
    if (detailLevel === 'full') {
      event.content = text || null;
      event.thinking = thinking || null;
    }
    // Only a search ever supplies one. Kept off the event a caller asked to page through:
    // it is the raw text the needle was found in, unredacted, and a `trajectory_get`
    // reply must carry message bodies only under the same redaction as every other one.
    if (located && typeof located === 'object') event.matchLoc = located;
    events.push(event);
    return false;
  };

  let buffer = '';
  let bytes = 0;
  let discarding = false;
  let droppedOversized = 0;
  for await (const chunk of stream) {
    buffer += chunk;
    bytes += Buffer.byteLength(chunk, 'utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      bytes -= Buffer.byteLength(line, 'utf8') + 1; // the '\n' is one byte
      if (discarding) {
        // The rest of a line that already overflowed the cap, whose count was
        // incremented when it overflowed.
        discarding = false;
        continue;
      }
      // Counted here as well as on the pending-buffer path below, because which of the
      // two a line takes depends only on where the chunk boundary fell: an oversized
      // line delivered complete with its newline never crosses the pending cap. The
      // two cannot both count one line — the discarding branch consumes the
      // overflowing line's newline and continues before this test.
      if (Buffer.byteLength(line) > maxLineBytes) { droppedOversized += 1; continue; }
      // `malformed` travels on this early return too. Stopping on the look-ahead
      // record is the *normal* exit for any file holding more records than one page
      // fits, and this return left the count off — so the one page shape that read
      // furthest into a file was the one that lost the corruption it had already
      // measured, and a corrupt line before the cursor silently reappeared as clean on
      // the next request. Consumers read `malformedLines` off this object, so an
      // absent key is an absent report.
      if (take(line)) return { events, droppedOversized, malformed: state.malformed, hasMore: true };
    }
    // No newline arrived within the cap: the pending line can never be accepted, so
    // stop retaining it and discard until the next newline instead of buffering the
    // rest of the file. The counter is incremented once per line — a line arrives in
    // many chunks, so only the transition into discarding counts.
    if (bytes > maxLineBytes) {
      if (!discarding) droppedOversized += 1;
      buffer = '';
      bytes = 0;
      discarding = true;
    }
  }

  // Whatever the stream ended on, if it holds a record. A file that does not end in a
  // newline still has a last record, and it is the one the reader is most likely to
  // have opened the session for.
  if (!discarding && buffer) take(buffer);
  return { events, droppedOversized, malformed: state.malformed, hasMore: state.hasMore };
}

/**
 * Records in a session's artifact whose text contains `query`.
 *
 * The artifact path exists for a session the projection has not indexed yet, and a
 * search that ignored it would report "no matches" for a session whose records are
 * sitting on disk — the confident wrong answer this module exists to prevent. So the
 * search follows the read: same containment, same parser, same malformed-line
 * accounting, and the same offset-into-the-filtered-set contract, so a hit means the
 * same record on either path.
 *
 * `total` is `null`, exactly as `readJsonlEvents` reports it. The file is streamed and
 * never counted in advance, so a total would be a second pass over the whole artifact
 * to answer a question the caller can answer by paging.
 */
export async function findJsonlEvents(store, {
  sessionId, query, offset = 0, limit = 1000, detailLevel = 'summary',
} = {}) {
  const empty = { events: [], source: 'unavailable', total: null, nextOffset: null, droppedOversized: 0, malformedLines: 0 };
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle === '') return empty;
  const dir = await findSessionDir(store, sessionId);
  if (!dir) return empty;
  const opened = await openContainedRead(store.dataDir, path.join(dir, 'messages.jsonl'));
  if (!opened) return empty;
  const readAt = Math.max(0, Math.trunc(Number(offset)) || 0);
  const stream = opened.handle.createReadStream({ encoding: 'utf8' });
  try {
    const folded = await foldJsonl(stream, {
      offset, limit, detailLevel,
      match: (record) => locateInRecord(record, needle),
    });
    return {
      events: folded.events,
      source: 'jsonl',
      total: null,
      nextOffset: folded.hasMore ? readAt + folded.events.length : null,
      droppedOversized: folded.droppedOversized,
      malformedLines: folded.malformed,
    };
  } finally {
    stream.destroy();
  }
}

/**
 * How a session's turns divide up, read from the artifact rather than the projection.
 *
 * `getTurnSummaries` reads the projection only, so for a session the indexer has not
 * reached it answered `total: 0` — "this run had no turns" for a run whose records
 * `trajectory_get` was happily listing from disk, three of them under a turn id. The
 * progress view is the tool a model reaches for to find out how a run was divided up,
 * so a wrong zero there is worse than an absent answer.
 *
 * The whole file is streamed and grouped, because a fold that stopped at a page
 * boundary would report the turns of the first hundred records as the turns of the
 * session. Records are never materialised as events on the way: the consumer takes
 * each one as it is parsed.
 *
 * `llmMs` and `outputTokens` are `null` rather than `0`. The artifact records no
 * request duration and no usage, so those are genuinely unknown here — and a `0` would
 * be read as "this turn cost nothing", which is a measurement, not an absence.
 *
 * Order is first appearance, which for an append-only file is production order — the
 * same thing `ORDER BY first_ms ASC` gives the projection.
 *
 * @returns {{turns: object[], source: string, available: boolean}}
 */
export async function readJsonlTurnSummaries(store, { sessionId } = {}) {
  const unavailable = { turns: [], source: 'unavailable', available: false };
  const dir = await findSessionDir(store, sessionId);
  if (!dir) return unavailable;
  const opened = await openContainedRead(store.dataDir, path.join(dir, 'messages.jsonl'));
  if (!opened) return unavailable;
  const order = [];
  const counts = new Map();
  const firstMs = new Map();
  const stream = opened.handle.createReadStream({ encoding: 'utf8' });
  try {
    await foldJsonl(stream, {
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
      detailLevel: 'summary',
      onRecord: (record, recordTurn) => {
        if (!counts.has(recordTurn)) {
          counts.set(recordTurn, 0);
          firstMs.set(recordTurn, null);
          order.push(recordTurn);
        }
        counts.set(recordTurn, counts.get(recordTurn) + 1);
        // The same aggregate the projection fold computes, over the same field the
        // artifact's own event path already reads (`createdAtMs: num(message.timestamp)`),
        // so the two answers agree on what a turn's start time is. Published here because
        // it is published there: a turn row that dated itself on one path and not on the
        // other is a difference a caller cannot see, and it is the difference that makes
        // one of the two sources look like it lost its timing.
        const at = num(record?.message?.timestamp);
        if (at !== null && (firstMs.get(recordTurn) === null || at < firstMs.get(recordTurn))) {
          firstMs.set(recordTurn, at);
        }
      },
    });
    // Chronological, to match the projection's `ORDER BY first_ms ASC` — not file order.
    //
    // They are different, and not hypothetically: on the machine this was written
    // against, **21 of 613 artifact files** carry a record whose timestamp goes backwards
    // (one runs 1786968363541 → 1786968361812, about 1.7 seconds earlier). So the same
    // session read from the projection and read from its artifact answered with the
    // turns in a different order, and the module's stated invariant — a caller cannot
    // tell the two paths apart from the record alone — did not hold for turn order.
    //
    // This only became visible once each row published its own time: before that the two
    // orders looked identical because nothing said what order they were in. A disagreement
    // between two implementations that no field can reveal is not a disagreement anyone
    // can find, which is the whole argument for publishing the value a field is computed
    // from.
    //
    // Turns with no time at all keep their file order and sort last: they cannot be
    // placed, and dropping them or pretending they are at the epoch would be a second
    // invention. Ties break on file order so the answer is stable.
    const dated = order.map((turnId, index) => ({ turnId, index, at: firstMs.get(turnId) }));
    dated.sort((a, b) => {
      if (a.at === null && b.at === null) return a.index - b.index;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at - b.at || a.index - b.index;
    });
    return {
      turns: dated.map(({ turnId, at }) => ({
        turnId,
        count: counts.get(turnId),
        firstMs: at,
        llmMs: null,
        outputTokens: null,
        failureCount: null,
      })),
      source: 'jsonl',
      available: true,
    };
  } catch (error) {
    store.warn(`turn_artifact_failed:${error.message}`);
    return unavailable;
  } finally {
    // The same `autoClose` discipline as the reads above: destroying the stream on every
    // exit path is what releases the descriptor containment approved.
    stream.destroy();
  }
}

/**
 * Where in an artifact record a needle sits, or `null` when it is nowhere in it.
 *
 * The artifact's shape is not the projection's: text lives in `message.content` parts
 * rather than a `msg_content` string, and a tool call carries its arguments inline. This
 * used to fold those into one haystack and answer a bare yes/no — and it read a tool
 * call's payload from `part.input ?? part.args ?? {}`, neither of which the runtime
 * writes. Every tool call therefore contributed the two characters `{}` to the haystack:
 * on the six largest artifacts on this machine all 1,273 `toolCall` parts carry
 * `('arguments', 'id', 'name', 'type')` and not one of those two keys, so a term that
 * appeared only in a tool argument was found on the projection path and reported as
 * absent here, for the same session, with no note that the sources differ.
 *
 * Returning the location instead of a boolean is what closes the second half of it. The
 * match this predicate accepts was then reported as `field: 'content'` and quoted from
 * `event.content`, so a term sitting in the thinking came back labelled as the message
 * with no excerpt at all — the same dead end the projection path had. One function now
 * decides both, and this one is `locateNeedle`, the same function that path uses.
 */
function locateInRecord(record, needle) {
  const message = record.message && typeof record.message === 'object' ? record.message : {};
  const parts = Array.isArray(message.content) ? message.content : [];
  const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
  const thinking = parts.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('');
  return locateNeedle({
    content: text,
    thinking,
    calls: parts.filter((part) => part?.type === 'toolCall')
      .map((part) => ({ args: part?.arguments, result: part?.result })),
  }, needle);
}
