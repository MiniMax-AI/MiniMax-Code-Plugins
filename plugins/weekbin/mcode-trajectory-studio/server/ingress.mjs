/**
 * Turns the runtime took in, including the ones the transcript never saw.
 *
 * `local_runtime_turn_ingress` is the runtime's own record of accepting a turn: when it
 * was accepted, in what sequence, what claimed it, whether a queue acknowledged it, and
 * how it ended. `local_runtime_message_rows` records what happened *inside* a turn.
 * Neither is a subset of the other, and the difference is where the interesting facts are.
 *
 * Measured on the machine this was written for, 634 sessions and 115k message rows:
 *
 * ```
 * ingress turns                 2,466 across 582 sessions
 *   completed                   2,344
 *   aborted                        64
 *   failed                         56
 *   accepted                        2
 * with no message row at all       27   (13 completed, 10 failed, 4 aborted)
 * ```
 *
 * **14 of the 120 failed-or-aborted turns appear in no message row at all**, across 7
 * sessions. Read through every other tool this plugin has, one of those sessions reports
 * `status: 'idle'`, no `errorMessage`, `warnings: []` and 62 turns of ordinary work — a
 * clean run with the deaths nowhere in it. The transcript genuinely does not contain
 * them, so no amount of reading it would surface them.
 *
 * What this module deliberately does **not** do is explain them. `pragma_table_info` on
 * the real table returns sixteen columns and none of them records *why* a turn failed —
 * there is no reason column, no error text, nothing to attribute it to. So there is no
 * `reason` field here, and inventing one would put the single fact a reader most wants
 * behind a guess wearing a field name. What is recorded is when, what claimed it, and
 * how it ended.
 *
 * `claim_source` is the other half of why this is worth a tool. It is the only place the
 * runtime records *who asked*, and `thread-goal` is the second-largest source there at
 * **668 of 2,466 turns** — the mechanism §8.37 published an `objective` for. Nothing else
 * in the plugin can tell a turn a person typed from one a goal started.
 *
 * The transcript's turn ids are read **once** into a set rather than joined per row, for
 * the same reason `trajectory_changes` does it that way: a correlated lookup per ingress
 * row on a session with hundreds of turns is the shape that costs 287 ms on the tool a
 * reader is told to call first.
 */

import { LIMITS, clamp, normalizeOffset } from './config.mjs';
import { num } from './json.mjs';
import { tableExists } from './sqlite.mjs';

/** The one answer that means "this runtime cannot tell", as opposed to "nothing failed". */
const UNAVAILABLE = Object.freeze({
  turns: [],
  total: 0,
  matchedTurns: 0,
  statusCounts: { completed: 0, failed: 0, aborted: 0, accepted: 0, other: 0 },
  claimCounts: {},
  failedOrAborted: null,
  missingFromTranscript: null,
  reportedInTranscript: null,
  available: false,
});

/**
 * Every turn id the transcript carries for one session, or `null` if they could not be
 * read.
 *
 * `null` and an empty set are different answers and must not collapse: an empty set says
 * this session's messages name no turn, which is a fact about the data — 34 of 616
 * sessions on the machine this was measured on are in that state. `null` says the
 * question could not be asked, in which case every row reports `inTranscript: null` and
 * `missingFromTranscript` is `null` rather than `0`. Publishing `0` from a query that
 * threw would turn a broken read into a clean bill of health, which is the exact
 * misreading this tool exists to remove.
 *
 * The `COALESCE` here is on a `DISTINCT` projection, not on a comparison: `DISTINCT` has
 * to scan the rows either way, and folding the no-turn-id rows into one group is what
 * makes "no turn id" the same value on both sides of the lookup.
 */
function transcriptTurnIds(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_message_rows')) return null;
  try {
    const rows = store.db.prepare(`
      SELECT DISTINCT COALESCE(turn_id, '') AS tid
      FROM local_runtime_message_rows
      WHERE session_id = ?
    `).all(sessionId);
    return new Set(rows.map((row) => String(row.tid ?? '')));
  } catch (error) {
    store.warn(`ingress_transcript_lookup_failed:${error.message}`);
    return null;
  }
}

/** Every status the real table carries, so an unknown one is reported as `other`. */
const KNOWN_STATUSES = ['completed', 'failed', 'aborted', 'accepted'];

/**
 * Page a session's accepted turns.
 *
 * @param {object} store An open store.
 * @param {string} sessionId Exact session ID.
 * @param {{offset?: number, limit?: number, status?: string}} options `status` narrows
 *   to one of the recorded statuses; `total` then stays the session's own count so a
 *   narrowed read is not mistaken for a whole one, exactly as `trajectory_changes` does.
 * @returns {{turns: object[], total: number, matchedTurns: number, available: boolean,
 *   failedOrAborted: number|null, missingFromTranscript: number|null,
 *   statusCounts: object, claimCounts: object}}
 */
export function listIngressTurns(store, sessionId, { offset = 0, limit = LIMITS.ingress.default, status = null } = {}) {
  if (!store.db || !tableExists(store.db, 'local_runtime_turn_ingress')) return UNAVAILABLE;
  const from = normalizeOffset(offset);
  const cap = clamp(limit, LIMITS.ingress);
  const wanted = typeof status === 'string' && status !== '' ? status : null;
  try {
    const { total } = store.db.prepare(
      'SELECT COUNT(*) AS total FROM local_runtime_turn_ingress WHERE session_id = ?',
    ).get(sessionId) || {};

    // The whole list is read and then filtered and paged, rather than pushing the filter
    // into SQL. A session's ingress list is bounded — the largest on the machine this was
    // measured on is 330 turns — and every aggregate on the reply is over what the filter
    // matched, so accumulating in one pass is what keeps them from disagreeing with the
    // rows.
    const rows = store.db.prepare(`
      SELECT turn_id, source, claim_source, status, accepted_at_ms, accepted_sequence,
             completed_at_ms, queue_acknowledged_at_ms, input_metadata_json
      FROM local_runtime_turn_ingress
      WHERE session_id = ?
      ORDER BY accepted_at_ms, turn_id
    `).all(sessionId);

    const transcriptTurns = transcriptTurnIds(store, sessionId);
    const statusCounts = { completed: 0, failed: 0, aborted: 0, accepted: 0, other: 0 };
    const claimCounts = Object.create(null);
    let failedOrAborted = 0;
    let missingFromTranscript = 0;
    const kept = [];
    for (const row of rows) {
      const rowStatus = typeof row.status === 'string' ? row.status : '';
      if (wanted !== null && rowStatus !== wanted) continue;
      if (KNOWN_STATUSES.includes(rowStatus)) statusCounts[rowStatus] += 1;
      else statusCounts.other += 1;
      if (rowStatus === 'failed' || rowStatus === 'aborted') failedOrAborted += 1;

      // `null` claim_source is reported as null and counted under no key. It is the shape
      // 1,603 of the 2,466 real rows have, and folding it into "user" would attribute
      // those turns to someone who is not recorded as having asked for them.
      if (typeof row.claim_source === 'string' && row.claim_source !== '') {
        claimCounts[row.claim_source] = (claimCounts[row.claim_source] ?? 0) + 1;
      }

      const key = row.turn_id ?? '';
      const inTranscript = transcriptTurns === null ? null : transcriptTurns.has(key);
      if (inTranscript === false) missingFromTranscript += 1;
      kept.push({
        turnId: row.turn_id ?? null,
        source: typeof row.source === 'string' ? row.source : null,
        claimSource: typeof row.claim_source === 'string' ? row.claim_source : null,
        status: rowStatus || null,
        acceptedAtMs: num(row.accepted_at_ms),
        acceptedSequence: num(row.accepted_sequence),
        completedAtMs: num(row.completed_at_ms),
        // How long the turn sat in the queue before anything took it. `null` when the
        // column is null — which is 1,603 of the real rows' share, not a rare shape —
        // and never `0`, because "nobody acknowledged it" is not the same instant as
        // "it was acknowledged immediately".
        queuedMs: num(row.accepted_at_ms) !== null && num(row.queue_acknowledged_at_ms) !== null
          ? num(row.queue_acknowledged_at_ms) - num(row.accepted_at_ms)
          : null,
        inTranscript,
        attachmentCount: readAttachmentCount(row.input_metadata_json),
      });
    }

    const page = kept.slice(from, from + cap);
    return {
      turns: page,
      total: num(total) ?? kept.length,
      matchedTurns: kept.length,
      statusCounts,
      claimCounts,
      failedOrAborted,
      missingFromTranscript: transcriptTurns === null ? null : missingFromTranscript,
      // The complement, so a reader never has to subtract. `null` in step with
      // `missingFromTranscript` — when the question could not be asked, neither half of
      // the pair has an answer, and publishing one of them would be a guess.
      reportedInTranscript: transcriptTurns === null
        ? null
        : kept.length - missingFromTranscript,
      available: true,
    };
  } catch (error) {
    store.warn(`turn_ingress_list_failed:${error.message}`);
    return UNAVAILABLE;
  }
}

/**
 * The attachment count the runtime recorded on a turn's input.
 *
 * Read through rather than `json_extract` on the way out, for the same reason every other
 * fold in this plugin normalises first: one unparseable `input_metadata_json` raises
 * "malformed JSON" and aborts the whole statement, taking every turn on the page with it.
 */
function readAttachmentCount(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const count = num(parsed.attachmentCount);
  return count;
}

/**
 * The two counts `trajectory_summary` publishes for a session.
 *
 * Separate from each other on purpose, and from `turns`. `turns` counts the turns the
 * transcript carries; this counts what the runtime accepted, and how many of those are
 * missing from the transcript. On the machine this was measured on those differ for 27
 * turns, and the failed ones among them are the ones a reader can otherwise not see.
 */
export function ingressAggregate(store, sessionId) {
  if (!store.db || !tableExists(store.db, 'local_runtime_turn_ingress')) {
    return {
      available: false,
      failedOrAborted: null,
      missingFromTranscript: null,
      degraded: 'turn intake records are unavailable: this runtime exposes no local_runtime_turn_ingress table, so this session\'s failed and aborted turns cannot be counted — the transcript alone would read as a clean run',
    };
  }
  try {
    const row = store.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status IN ('failed', 'aborted') THEN 1 ELSE 0 END) AS bad,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM local_runtime_message_rows m
          WHERE m.session_id = i.session_id AND m.turn_id IS i.turn_id
        ) THEN 0 ELSE 1 END) AS missing
      FROM local_runtime_turn_ingress i
      WHERE i.session_id = ?
    `).get(sessionId) || {};
    if (!num(row.total)) {
      // No ingress rows at all is an ordinary answer, not a degraded one: most sessions
      // on every machine measured are plain conversations the runtime never routed
      // through the intake queue.
      return { available: true, failedOrAborted: 0, missingFromTranscript: 0, degraded: null };
    }
    if (!tableExists(store.db, 'local_runtime_message_rows')) {
      return {
        available: true,
        failedOrAborted: num(row.bad) ?? 0,
        // Not `0`: the question was not asked, and reporting zero here would say every
        // turn is in the transcript when this runtime cannot check.
        missingFromTranscript: null,
        degraded: null,
      };
    }
    return {
      available: true,
      failedOrAborted: num(row.bad) ?? 0,
      missingFromTranscript: num(row.missing) ?? 0,
      degraded: null,
    };
  } catch (error) {
    store.warn(`turn_ingress_aggregate_failed:${error.message}`);
    return {
      available: false,
      failedOrAborted: null,
      missingFromTranscript: null,
      degraded: 'turn intake records are unavailable: the query failed, so a clean-looking session here does not mean the turns all succeeded',
    };
  }
}