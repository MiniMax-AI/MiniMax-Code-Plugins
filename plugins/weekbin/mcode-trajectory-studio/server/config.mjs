/**
 * Configuration: where the data lives, and every bound the rest of the server
 * enforces. Leaf module — imports nothing, so anything may import it.
 */

import path from 'node:path';

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

/** The canonical projection path (first candidate). */
export function sqlitePath(dataDir) {
  return sqliteCandidates(dataDir)[0];
}

/** The canonical session-artifact root (first candidate). */
export function sessionsRoot(dataDir) {
  return sessionsCandidates(dataDir)[0];
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
  timeline: 6000,
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
