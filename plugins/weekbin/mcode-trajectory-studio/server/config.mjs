/**
 * Configuration: where the data lives, and every bound the rest of the server
 * enforces. Leaf module — imports nothing, so anything may import it.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The user's home directory, resolved the way the runtime resolves it.
 *
 * Windows commonly sets only USERPROFILE, so falling back to it is what keeps
 * home-relative paths (and home-prefix redaction) working on every platform.
 */
export function resolveHomeDir(env = process.env, override) {
  const value = override || env.HOME || env.USERPROFILE || '';
  return String(value).trim() ? path.resolve(String(value).trim()) : null;
}

/** Resolve the runtime data directory, in the order the runtime itself uses. */
export function resolveDataDir(env = process.env, homeDir) {
  const fromEnv = env.MINIMAX_DATA_DIR || env.MAVIS_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const home = resolveHomeDir(env, homeDir);
  if (!home) throw new Error('cannot resolve data directory: set MINIMAX_DATA_DIR or HOME');
  return path.join(home, '.minimax');
}

/**
 * Where the runtime may keep its data inside the data directory.
 *
 * The first entry is the layout every known build uses and is what the Plugin
 * writes its diagnostics against. The rest exist so a build that lays its files
 * out differently is still readable instead of silently degrading: nothing here is
 * discovered by scanning the tree, because the data directory also holds tens of
 * thousands of unrelated task directories.
 */
const SQLITE_RELATIVE = [
  ['v2', 'sqlite', 'runtime-state.sqlite'],
  ['sqlite', 'runtime-state.sqlite'],
  ['v2', 'runtime-state.sqlite'],
  ['runtime-state.sqlite'],
  ['v3', 'sqlite', 'runtime-state.sqlite'],
];

const SESSIONS_RELATIVE = [
  ['v2', 'sessions'],
  ['sessions'],
  ['v3', 'sessions'],
];

export function sqliteCandidates(dataDir) {
  return SQLITE_RELATIVE.map((parts) => path.join(dataDir, ...parts));
}

export function sessionsCandidates(dataDir) {
  return SESSIONS_RELATIVE.map((parts) => path.join(dataDir, ...parts));
}

/** Background-task output root. A single layout across every known build. */
export function backgroundTasksRoot(dataDir) {
  return path.join(dataDir, 'background-tasks');
}

/** Folding limits. */
export const LIMITS = Object.freeze({
  sessions: { min: 1, max: 500, default: 20 },
  events: { min: 1, max: 1000, default: 200 },
  tasks: { min: 1, max: 2000, default: 200 },
  search: { min: 1, max: 200, default: 20 },
  /**
   * The turn list is folded from the whole session before it is paged, so unlike every
   * other read here it has no store-side query to clamp the limit for it. The schema
   * declares `minimum: 1`, and `tools/call` validates nothing, so without this the
   * handler's `slice` did the arithmetic itself: `limit: 0` paged nothing and answered
   * `nextOffset: null`, which is how every other tool says "that is the whole list".
   */
  turns: { min: 1, max: 2000, default: 200 },
  /**
   * Asset pages.
   *
   * The largest session on a 633-session machine holds 112 asset rows, well under
   * this ceiling, so the cap is not the interesting bound — the frame budget on the
   * MCP surface is. It is here so `clamp` has something honest to clamp against.
   */
  assets: { min: 1, max: 500, default: 50 },
  /**
   * Change-set pages, one row per turn.
   *
   * The busiest session on the machine this was measured on holds 41 change sets and
   * the whole database holds 1,404, so the cap is not the interesting bound — the
   * per-file diff ceiling below is.
   */
  changes: { min: 1, max: 500, default: 100 },
  /**
   * Accepted-turn pages, one row per turn the runtime took in.
   *
   * The busiest session on the machine this was measured on holds 330 ingress turns, so
   * this cap is the same order as `changes` and neither is the interesting bound. The
   * whole list is 2,466 rows across the database, so it is read whole and paged in
   * memory rather than with a SQL `LIMIT` — see `listIngressTurns`, where the reason is
   * written down.
   */
  ingress: { min: 1, max: 500, default: 100 },
  /**
   * Per-file unified diff ceiling, in characters.
   *
   * A diff is the only unbounded text this plugin would carry from a row it otherwise
   * only counts, so it needs a bound of its own: one turn on the machine this was
   * measured on touched 82 files in a single patch, and `boundPayloadList` keeps an
   * oversized first item whole rather than bounding it.
   *
   * **It has to stay under the egress string limit (20,000), and it started out over
   * it.** The first value was 32 KiB, which no per-file bound could ever be measured
   * against: redaction cut every string at 20,000 characters on its way out, so the
   * constant bound nothing and the reply still shipped a truncated diff — it just did
   * so under a flag computed from the pre-redaction length, which made `diffBytes`
   * report bytes the caller never received. A limit looser than the limit above it is
   * not a limit; it is a number in a config file that reads like one.
   *
   * 16 KiB leaves room for the sweep's truncation marker and stays clear of the bound
   * above it, so `diffTruncated` is true exactly when this constant cut the text.
   */
  changeDiffBytes: 16 * 1024,  timeline: 6000,
  taskOutputBytes: { min: 256, max: 256 * 1024, default: 16 * 1024 },
  jsonlLineBytes: 2 * 1024 * 1024,
  /**
   * Ceiling for one message row's `data_json`.
   *
   * The JSONL fallback has had a per-line cap from the start; the SQLite read had
   * none, so a single multi-megabyte row was parsed into the process whole. A row
   * past this bound is reported as an oversized record rather than silently
   * dropped — the reader still needs to know it exists and how large it is.
   */
  eventJsonBytes: 8 * 1024 * 1024,
  /**
   * How much raw `data_json` one page may project into JavaScript.
   *
   * The per-row ceiling bounds one record; this bounds the page, so the work a request
   * can cause is a function of this constant rather than of `limit` times the row
   * ceiling — which is 8 GiB. Rows past it are left for the next page, and the cursor
   * says so.
   */
  eventPageBytes: 8 * 1024 * 1024,
});

/** Per-session folded totals kept warm; browsing revisits sessions constantly. */
export const CACHE_ENTRIES = 96;

/**
 * How many warnings the store retains.
 *
 * A long-lived MCP server accumulates one warning per failed read, and the whole
 * list is echoed on every `trajectory_list`. The oldest entries are dropped past
 * this bound and the count of dropped ones is reported, so the list cannot grow
 * without limit and the loss is not silent.
 */
export const WARNINGS_MAX = 64;

/**
 * Directories folded to `~` in every response, on top of the home directory.
 *
 * The data directory is included automatically because it is the one absolute path
 * the Plugin is *designed* to name (`sqlite_discovered:…`, `/api/meta`), and a
 * deployment that puts it outside the home directory — a container, a CI runner, a
 * mounted volume — would otherwise have it leave verbatim. Extra roots can be added
 * with `MCODE_TRAJECTORY_REDACT_ROOTS` (path-separator separated). Unlike the listen
 * address, this knob is not a configuration surface that can weaken anything: adding
 * a root can only fold more, never less.
 */
export function resolveRedactRoots(env = process.env, dataDir) {
  const extra = String(env.MCODE_TRAJECTORY_REDACT_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [dataDir, ...extra].filter((entry) => typeof entry === 'string' && entry.length > 1);
}

/**
 * Ceiling for a single string in a swept outbound payload.
 *
 * Deliberately the largest bound any surface already applies, so the egress sweep
 * can only ever redact. A smaller ceiling here would silently re-truncate content
 * whose own limit is larger — the task-output tail, for instance.
 */
export const EGRESS_STRING_LIMIT = LIMITS.taskOutputBytes.max;

/**
 * Per-string character ceiling for the MCP surface.
 *
 * Named rather than left inline at the sweep call because another bound now has to be
 * kept *under* it: `LIMITS.changeDiffBytes`. When that ceiling was 32 KiB the sweep cut
 * every diff at this number first, so the per-file bound was dead and the reply carried
 * a flag computed from text the caller never received. A relationship between two
 * limits cannot be checked when one of them is a literal in someone else's call site.
 */
export const EGRESS_MAX_LENGTH_MCP = 20000;

/**
 * Ceiling for the *aggregate* serialized size of one response's record list.
 *
 * Per-string limits do not compose into a response limit: `trajectory_get` accepts
 * `limit: 1000` and each `full` record may carry ~20 KB strings, which serialises to
 * roughly 20 MB in a single reply. A record list is therefore trimmed to this
 * budget, in order, with a `truncated`/`omitted` report so the client pages on
 * `nextOffset` rather than believing it received every record.
 */
export const EGRESS_TOTAL_BYTES = 4 * 1024 * 1024;

/**
 * The MCP record-list budget.
 *
 * A `tools/call` result carries the payload twice — a human-readable `text` block
 * and `structuredContent` — so keeping the whole frame inside `EGRESS_TOTAL_BYTES`
 * means budgeting the record list to half of it. Without this the MCP reply was
 * twice the HTTP response for the same records.
 */
export const EGRESS_TOTAL_BYTES_MCP = Math.floor(EGRESS_TOTAL_BYTES / 2);

/**
 * Per-task `description`/`command` ceiling on a list surface.
 *
 * A task's description is its command line, so it is the field most likely to carry an
 * inline credential and the one most likely to be long. It is redacted and bounded at
 * the source rather than at each consumer, so every surface gets scrubbed text and a new
 * consumer cannot forget to ask for it.
 */
export const TASK_TEXT_LIMIT = 4000;

/**
 * How many task rows a list surface materializes in one read.
 *
 * A list read materializes every row it fetches and only then trims the reply to the
 * frame budget, so the *peak* was `limit × TASK_TEXT_LIMIT` — a function of caller
 * input, not of anything in this file. Asking for the largest page the task limits allow
 * meant holding ~2,000 descriptions to return a few hundred of them.
 *
 * Derived from the budget rather than chosen: the frame budget divided by what one
 * worst-case row costs (two bounded text fields plus its row overhead). A full page of
 * maximally-sized rows therefore still fits the budget it is trimmed to, and the
 * work one request can cause is a constant.
 *
 * This bounds what is *read*, not what is *returned*, and the two are no longer the same
 * number. A caller asking for more than this gets a shorter page with a cursor that
 * reaches the rest — which is why `trajectory_tasks` derives `nextOffset` from delivered
 * records, and why `truncated` there also covers the rows this cap left unread.
 */
export const TASK_LIST_MAX_ROWS = Math.max(
  1,
  Math.floor(EGRESS_TOTAL_BYTES_MCP / (2 * TASK_TEXT_LIMIT)),
);

/** Depth and breadth ceilings for a swept outbound payload. */
export const EGRESS_MAX_DEPTH = 64;
export const EGRESS_MAX_ENTRIES = 10000;

/** Records fetched per MCP page and per web request. */
export const DETAIL_LEVELS = Object.freeze(['summary', 'full']);

/** `tool_call_status` 2 is the runtime's success code. */
export const TOOL_STATUS_OK = 2;

/** Input provenance, used to separate a person's words from injected context. */
export const INPUT_KINDS = Object.freeze(['human', 'injected', 'unknown']);

export function clamp(value, { min, max, default: fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * A record offset a caller can actually page with.
 *
 * `OFFSET ?` binds a literal, so anything that is not a non-negative integer reaches
 * SQLite as-is and raises `datatype mismatch`: a fraction, a numeric string and a
 * non-number all took the whole read down, and the empty page that followed was
 * reported as a session that was "not in the projection".
 *
 * It lives here rather than in a query module because both the event read and the task
 * read need it, and putting it in either would make the two import each other.
 *
 * The cursors these offsets feed are `offset + delivered` and the store's own
 * `nextOffset`, and clients hand that value straight back in, so an offset that is not
 * an integer is not only a failed read — it poisons the next one.
 */
export function normalizeOffset(offset) {
  const parsed = Number(offset);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

/**
 * A short, stable identity for "which question this walk is answering".
 *
 * A cursor says where to resume — but not what it was resuming *for*. Handing a
 * filtered walk's cursor back without its filter returns a page of a different
 * population at an arbitrary key: measured on the real machine, a walk filtered to one
 * agent resumed without the filter delivered rows that were not that agent while
 * reporting the unfiltered total, so a caller would have concluded the filter matched
 * every session on the box. Across two queries it is worse — the cursor's key sits above
 * every match of the new query, the page comes back empty, and an empty list with no note
 * is the one answer this Plugin has gone out of its way never to give by accident.
 *
 * So the identity travels inside the cursor. It is derived only from what defines the
 * population — never from `limit`, which changes how much is carried without changing
 * which rows match, and never from the pinned instant, which is already carried
 * separately and is what lets an interrupted walk be resumed rather than restarted.
 *
 * @param {object} scope the caller's own filters, keyed however the caller thinks of them
 * @returns {string} 16 hex characters
 */
export function sessionCursorFingerprint(scope = {}) {
  const entries = Object.keys(scope)
    .sort()
    .filter((key) => scope[key] !== undefined)
    .map((key) => [key, typeof scope[key] === 'number' && !Number.isFinite(scope[key]) ? null : scope[key]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

/**
 * A cursor for a recency-ordered session list, and what it costs to page by position.
 *
 * `trajectory_list` and `trajectory_search` are the only two paged queries in the plugin
 * that order by `updated_at_ms DESC`, and that column is the one the runtime rewrites
 * whenever it writes to a session. `LIMIT ? OFFSET ?` counts *positions*, so a session
 * that is updated mid-walk jumps above the cursor and is never delivered again — while
 * `nextOffset: null`, the word every other field in this plugin uses for "that is the
 * whole list", says the walk finished. On a fixture of twelve sessions the walk ended
 * claiming twelve of twelve and delivered eleven distinct ones: a session silently
 * dropped, and `total` agreeing with the number of rows sent, so a caller counting its
 * own results could not have noticed.
 *
 * Two things make the order total rather than merely recent. The secondary sort key
 * removes ties — three real sessions on one machine share an `updated_at_ms`, and
 * without it which of them lands on which side of a page boundary is unspecified. The
 * pinned upper bound removes movement: keyset paging alone still loses a row that jumps
 * *above* the cursor, so every page carries the `pin` the walk started from and each
 * query is bounded by it. A session written to after page one is then excluded from the
 * walk and from `total` alike, which is the difference between "excluded and counted" and
 * "dropped and still counted".
 *
 * The encoding is `v2.<pinMs>.<updatedAtMs>.<fingerprint>.<sessionId>` rather than a bare
 * offset because the value has to survive a round trip through a model that was told to
 * read it off a reply and hand it back. A trailing `.` splits it, so an id is never
 * truncated, and anything that is not this shape decodes to `null` — an unreadable cursor
 * starts a fresh first page rather than paging by a key nothing can compare. The
 * fingerprint is what tells a continuation apart from another walk's cursor; see
 * `sessionCursorFingerprint` for what happens when the two do not match.
 *
 * @returns {string} an opaque token, or `null` when the walk is over
 */
export function encodeSessionCursor({ pinMs, updatedAtMs, fingerprint, sessionId }) {
  if (!Number.isFinite(updatedAtMs) || typeof sessionId !== 'string' || !sessionId) return null;
  const pin = Number.isFinite(pinMs) ? Math.trunc(pinMs) : updatedAtMs;
  return `v2.${pin}.${Math.trunc(updatedAtMs)}.${fingerprint || '-'}.${sessionId}`;
}

/**
 * The four values inside a cursor, or `null` for anything unreadable.
 *
 * Defensive on purpose: this value is whatever the caller last saw in a reply, and
 * `tools/call` validates no arguments, so a hand-built, truncated or stale cursor reaches
 * it as-is. Falling back to a first page is the safe reading — the caller gets the newest
 * rows again and can tell it from a continuation by the absent cursor. Treating it as a
 * comparison key instead would compare against `NaN` and return nothing, which reads as
 * "the list is empty" for the one call whose job is to say the list is not empty.
 *
 * @returns {{pinMs: number, updatedAtMs: number, fingerprint: string, sessionId: string}|null}
 */
export function decodeSessionCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  const parts = cursor.split('.');
  // `session_id` is a TEXT primary key and nothing constrains it to the shape the
  // artifact lookup expects. Splitting on every dot and reading the id as a single field
  // breaks on an id that carries one: the decode fails, every page comes back as page
  // one, and the walk hands back a fresh unreadable cursor each time — a caller paging
  // until the cursor is `null` never stops. So the id is the *remainder*, rejoined.
  if (parts.length < 5 || parts[0] !== 'v2') return null;
  const sessionId = parts.slice(4).join('.');
  const pinMs = Number(parts[1]);
  const updatedAtMs = Number(parts[2]);
  if (!Number.isFinite(pinMs) || !Number.isFinite(updatedAtMs) || !sessionId) return null;
  return {
    pinMs: Math.trunc(pinMs),
    updatedAtMs: Math.trunc(updatedAtMs),
    fingerprint: parts[3] === '-' ? '' : parts[3],
    sessionId,
  };
}

/**
 * A boolean a caller actually meant.
 *
 * `tools/call` arguments arrive as whatever JSON the client sent, and nothing between
 * the wire and the handler checks them against the declared schema — the schema is
 * documentation for the model, not an enforced gate. So a boolean parameter can turn
 * up as the string `"false"`, and `Boolean("false")` is `true`.
 *
 * That is not a cosmetic difference here. `trajectory_list`'s `includeArchived` is the
 * one boolean on the MCP surface, and `Boolean("false")` returned the *archived*
 * sessions to a caller that had asked for the opposite: the reply looked complete,
 * `total` counted them, and nothing in the answer said a flag had been read backwards.
 * A wrong list is worse than a refused one, because the caller has no reason to doubt
 * it.
 *
 * The string spellings are therefore read as what they say. Anything unrecognised
 * returns the default rather than guessing: an unknown token is a client that did not
 * follow the schema, and inventing a meaning for it is how the original bug happened.
 *
 * @param {unknown} value
 * @param {boolean} fallback used when `value` is absent or not a recognisable boolean
 */
export function toBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no' || text === '') return false;
  }
  return fallback;
}
