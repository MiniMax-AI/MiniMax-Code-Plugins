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
export async function readJsonlEvents(store, { sessionId, offset = 0, limit = 1000, detailLevel = 'summary' } = {}) {
  const dir = await findSessionDir(store, sessionId);
  if (!dir) return { events: [], source: 'unavailable', total: 0, nextOffset: null, droppedOversized: 0 };
  // The descriptor that containment approved is the one the stream reads, so the
  // path cannot be re-pointed at another inode between the check and the read.
  const opened = await openContainedRead(store.dataDir, path.join(dir, 'messages.jsonl'));
  if (!opened) return { events: [], source: 'unavailable', total: 0, nextOffset: null, droppedOversized: 0 };
  // `autoClose` hands the descriptor to the stream, so destroying it — on success,
  // on a mid-stream error, and on the early stop below alike — is what releases
  // the handle.
  const stream = opened.handle.createReadStream({ encoding: 'utf8' });
  try {
    const folded = await foldJsonl(stream, { offset, limit, detailLevel });
    return {
      events: folded.events,
      source: 'jsonl',
      total: null,
      nextOffset: folded.hasMore ? offset + folded.events.length : null,
      droppedOversized: folded.droppedOversized,
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
  offset = 0, limit, detailLevel, maxLineBytes = LIMITS.jsonlLineBytes,
}) {
  const startAt = Math.max(0, Math.trunc(offset) || 0);
  const events = [];
  let turnCursor = null;
  let skipped = 0;
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
      if (discarding) { discarding = false; continue; }
      if (!line.trim()) continue;
      // Counted here as well as on the pending-buffer path below, because which of the
      // two a line takes depends only on where the chunk boundary fell: an oversized
      // line delivered complete with its newline never crosses the pending cap, and
      // used to be discarded without being reported. The two paths cannot both count
      // one line — the discarding branch consumes the overflowing line's newline and
      // returns before this test.
      if (Buffer.byteLength(line) > maxLineBytes) { droppedOversized += 1; continue; }
      const record = parseJson(line);
      if (!record) continue;
      // A skipped record still advances the turn cursor, or the first record of a
      // later page would inherit the wrong turn.
      if (record.turn_id) turnCursor = record.turn_id;
      if (skipped < startAt) { skipped += 1; continue; }
      // One record past the page is the look-ahead: it proves there is a next page,
      // and it costs one parse rather than a second pass over the whole file.
      if (events.length >= limit) return { events, droppedOversized, hasMore: true };
      const message = record.message && typeof record.message === 'object' ? record.message : {};
      const parts = Array.isArray(message.content) ? message.content : [];
      const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('');
      const thinking = parts.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('');
      const toolUses = parts.filter((part) => part?.type === 'toolCall');
      const usage = message.usage && typeof message.usage === 'object' ? message.usage : null;
      const event = {
        index: startAt + events.length,
        source: 'jsonl',
        msgId: record.message_id ?? null,
        turnId: record.turn_id ?? turnCursor,
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
    }
    // No newline arrived within the cap: the pending line is already unacceptable,
    // so stop retaining it and discard until the next newline instead of buffering
    // the rest of the file. The counter is incremented once per line — a line
    // arrives in many chunks, so only the transition into discarding counts.
    if (bytes > maxLineBytes) {
      if (!discarding) droppedOversized += 1;
      buffer = '';
      bytes = 0;
      discarding = true;
    }
  }
  // The stream ended inside the page: this artifact has nothing after it.
  return { events, droppedOversized, hasMore: false };
}
