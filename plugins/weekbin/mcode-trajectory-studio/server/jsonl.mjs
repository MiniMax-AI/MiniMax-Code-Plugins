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
  sessionId, offset = 0, limit = 1000, detailLevel = 'summary', turnId,
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
    const folded = await foldJsonl(stream, { offset, limit, detailLevel, turnId });
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
  offset = 0, limit, detailLevel, turnId, maxLineBytes = LIMITS.jsonlLineBytes,
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
      if (take(line)) return { events, droppedOversized, hasMore: true };
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
