/**
 * Local Trajectory Studio web panel.
 *
 * Bound to `127.0.0.1` only — the address is a constant with no override, because
 * a configurable bind address is one environment variable away from publishing
 * every session's tool arguments to the network.
 *
 * Authorization is a per-process capability, not a fence. A Host check, an Origin
 * check and a fixed custom header are all cross-site request forgery defences:
 * they stop a *web page* from reaching the API and none of them stops a local
 * *process*, which can send any header it likes. Each start therefore mints a
 * random capability, hands it to the caller in the URL's fragment, and requires it
 * on every API route. The fragment never travels to the server, so the token stays
 * out of request logs, out of `Referer`, and out of any asset request.
 *
 * The capability lives in memory for the life of this process and nothing about
 * the panel is written to disk. That is also what keeps concurrent sessions apart:
 * mcode spawns one MCP server per session, so two sessions get two panels with two
 * capabilities, and one session's URL cannot open the other's panel.
 */

import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { boundPayloadList, redactEvent, redactPayload, redactPath, redactText } from './redact.mjs';
import { hasArtifactEvidence, recordsUnavailable } from './jsonl.mjs';
import { jsonlTimelinePoints } from './events.mjs';
import {
  EGRESS_MAX_DEPTH, EGRESS_MAX_ENTRIES, EGRESS_STRING_LIMIT, EGRESS_TOTAL_BYTES, LIMITS, TASK_LIST_MAX_ROWS,
} from './config.mjs';

const WEB_ROOT = new URL('../web/', import.meta.url);
const TOKEN_HEADER = 'x-trajectory-token';

/**
 * The only address the panel may listen on. Not configurable on purpose: an
 * environment variable here would be a one-character path to exposing every
 * session on the network.
 */
const LISTEN_ADDRESS = '127.0.0.1';

/** A peer address that is loopback, including the IPv4-mapped IPv6 form. */
function isLoopbackPeer(address) {
  if (typeof address !== 'string') return false;
  return address === '::1' || address === '::ffff:127.0.0.1' || /^127\./u.test(address);
}

/** Constant-time capability comparison that tolerates any supplied shape. */
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  // A repeated header arrives as an array; refuse it rather than pick a winner.
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Fixed entry points. Everything else is refused. */
const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]);

/**
 * The client is split into ES modules under `/js/`. Serve them by a narrow name
 * pattern rather than by enumerating files, so adding a module needs no change
 * here, while anything outside the pattern stays denied by default.
 */
const CLIENT_MODULE = /^\/js\/[a-z0-9-]+\.js$/;

function resolveStatic(pathname) {
  const mapped = STATIC_FILES.get(pathname);
  if (mapped) return mapped;
  if (CLIENT_MODULE.test(pathname)) return pathname.slice(1);
  return null;
}

/**
 * An error whose code is safe to send to the client.
 *
 * The code comes from a fixed set chosen by the server; it never contains text
 * derived from the request. An error string that embeds the request (a route, a
 * session id) is a reflection surface, and echoing an unexpected error's message
 * leaks internals — so anything that is not an ApiError is written to stderr and
 * reported to the client as a single generic code.
 */
/**
 * Whether a failed static read proves the resource is not there.
 *
 * Only `ENOENT` does: nothing is at that path. The neighbours do not — `ENOTDIR` says a
 * path component is not a directory and `EISDIR` that the target is one, both of which
 * leave open that something is there and unreadable. Reporting those as "not found"
 * would be the more dangerous half of this fix: a wrong 404 is a claim the caller acts
 * on, while the 500 it replaces is only a refusal to answer.
 *
 * Exported because the rule is worth asserting on its own. Producing an `EISDIR` here
 * would mean planting a directory named like a module inside the shipped `web/`, and a
 * test artefact left in the package is worse than the code it was proving.
 */
export function staticResourceIsAbsent(errorCode) {
  return errorCode === 'ENOENT';
}

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function securityHeaders(extra = {}) {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  };
}

/* ----------------------------------------------------------------- studio -- */

export function createStudio({ store, homeDir, redactRoots = [] }) {
  let server = null;
  let port = null;
  let token = null;
  let focusSessionId = null;

  async function start({ sessionId, port: requested } = {}) {
    const wanted = Number.isInteger(requested) ? requested : null;
    if (sessionId) focusSessionId = sessionId;
    if (server && port) {
      // Reuse the running panel, capability included: minting a new one would
      // invalidate the URL the caller already has open.
      return {
        url: panelUrl(port, token), port, reused: true, sessionId: focusSessionId,
        boundTo: LISTEN_ADDRESS, requestedPort: wanted, portHonoured: wanted === null || wanted === port,
      };
    }
    // 256 bits from the CSPRNG, minted per process and never derived from anything
    // an observer could read — not the pid, not PLUGIN_ROOT, not the port.
    if (!token) token = randomBytes(32).toString('base64url');

    const handler = createRequestHandler({
      store,
      homeDir,
      redactRoots,
      getFocus: () => focusSessionId,
      setFocus: (id) => { focusSessionId = id; },
      getToken: () => token,
    });
    server = http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        // The detail goes to the operator's stderr, never into the response.
        process.stderr.write(`[trajectory-studio] ${error?.stack ?? String(error)}\n`);
        if (!res.headersSent) {
          res.writeHead(500, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
        }
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
    });
    server.keepAliveTimeout = 5000;

    port = await listenOnFreePort(server, Number.isInteger(requested) ? requested : null);
    if (Number.isInteger(requested) && requested >= 1024 && port !== requested) {
      // Silently moving to another port hides the real problem: something else is
      // already serving the requested one, so the old panel keeps answering and the
      // reader is looking at stale code.
      process.stderr.write(
        `[trajectory-studio] port ${requested} is in use; listening on ${port} instead. ` +
        `Another instance is still serving ${requested}.\n`);
    }
    return {
      url: panelUrl(port, token), port, reused: false, sessionId: focusSessionId,
      boundTo: LISTEN_ADDRESS, requestedPort: wanted, portHonoured: wanted === null || wanted === port,
    };
  }

  async function stop() {
    // The capability dies with the listener: a URL from a previous panel must not
    // come back to life when a later one reuses the port.
    token = null;
    if (!server) return false;
    const closing = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections?.();
    await closing;
    server = null;
    port = null;
    return true;
  }

  return {
    start,
    stop,
    get status() {
      return { running: Boolean(server), port, sessionId: focusSessionId, boundTo: LISTEN_ADDRESS };
    },
  };
}

/**
 * The panel URL, with the capability in the fragment.
 *
 * A fragment rather than a query parameter on purpose: the browser never sends it
 * to the server, so it stays out of request logs and out of the `Referer` of any
 * asset request. The page reads it from `location.hash` and sends it as a header.
 */
function panelUrl(port, capability) {
  return `http://${LISTEN_ADDRESS}:${port}/#t=${capability}`;
}

function listenOnFreePort(server, preferred) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, LISTEN_ADDRESS, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
        return;
      }
      reject(error);
    };
    server.once('error', onError);
    const target = Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535 ? preferred : 0;
    server.listen(target, LISTEN_ADDRESS, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

/* ---------------------------------------------------------------- request -- */

export function createRequestHandler({ store, homeDir, redactRoots = [], getFocus, setFocus, getToken = () => null }) {
  const json = (res, value, status = 200) => {
    res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify(value));
  };
  const fail = (res, status, message) => json(res, { error: message }, status);

  return async function handle(req, res) {
    // First, before anything is read: the listener is bound loopback-only, so a
    // non-loopback peer means the socket was reached some other way.
    if (!isLoopbackPeer(req.socket.remoteAddress)) return fail(res, 403, 'forbidden_remote');

    const host = req.headers.host;
    const authority = `${LISTEN_ADDRESS}:${req.socket.localPort}`;
    if (host !== authority && host !== `localhost:${req.socket.localPort}`) {
      return fail(res, 403, 'forbidden_host');
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${authority}` && origin !== `http://localhost:${req.socket.localPort}`) {
      return fail(res, 403, 'forbidden_origin');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed');

    const url = new URL(req.url, `http://${authority}`);

    if (url.pathname.startsWith('/api/')) {
      // The capability. Without it the panel answers with nothing but the code, so
      // a local process that has not been handed the URL learns no session data.
      if (!tokenMatches(getToken(), req.headers[TOKEN_HEADER])) return fail(res, 403, 'forbidden_token');
      if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return fail(res, 403, 'cross_site');
      try {
        const payload = await api(store, homeDir, redactRoots, url, { getFocus, setFocus });
        // One sweep at the boundary, on top of the per-field redaction each read
        // already applies, so a field added later cannot leave unredacted. It is
        // home-aware, so an absolute home path embedded anywhere — a warning, a
        // workspace field, a tool argument — is collapsed to `~` here even when the
        // read that produced it did not know about the home directory.
        //
        // `pii` stays off on this surface: the panel is the reader's own screen, and
        // masking an address there would destroy the answer they opened it for.
        return json(res, redactPayload(payload ?? { ok: true }, {
          maxLength: EGRESS_STRING_LIMIT,
          maxDepth: EGRESS_MAX_DEPTH,
          maxEntries: EGRESS_MAX_ENTRIES,
          homeDir,
          roots: redactRoots,
        }));
      } catch (error) {
        if (error instanceof ApiError) return fail(res, error.status, error.code);
        process.stderr.write(`[trajectory-studio] ${error?.stack ?? String(error)}\n`);
        return fail(res, 500, 'internal_error');
      }
    }

    const file = resolveStatic(url.pathname);
    if (!file) return fail(res, 404, 'not_found');
    try {
      const body = await readFile(new URL(file, WEB_ROOT));
      res.writeHead(200, securityHeaders({ 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' }));
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      // A legal static route whose file is not there is a **404**, not a server error.
      //
      // `resolveStatic` answers from the route shape alone — any `/js/<name>.js` is a
      // route whether or not that module exists, which is what lets a new module ship
      // without editing this file. So existence was being decided by the read, and every
      // failure of that read — including a plain "no such file" — was reported as
      // `static_unavailable`. A missing module therefore came back 500 while a missing
      // path at the root came back 404, which sends whoever is debugging a broken panel
      // to look at the server instead of at the file they renamed.
      //
      // Only the reads that mean the resource is provably not there are a 404; the rest
      // stay a 500, because "I could not answer" is the honest one of the two.
      if (staticResourceIsAbsent(error?.code)) {
        return fail(res, 404, 'not_found');
      }
      return fail(res, 500, 'static_unavailable');
    }
  };
}

/* -------------------------------------------------------------------- api -- */

async function api(store, homeDir, redactRoots, url, { getFocus, setFocus }) {
  const route = url.pathname;
  const fold = (value) => redactPath(value, { homeDir, roots: redactRoots });

  if (route === '/api/meta') {
    return {
      dataDir: store.dataDir,
      sqliteAvailable: Boolean(store.db),
      ftsAvailable: store.hasFts,
      readOnly: true,
      boundTo: LISTEN_ADDRESS,
      focusSessionId: getFocus() ?? null,
      warnings: store.warnings,
      // The list is bounded; say so when entries were dropped rather than letting a
      // truncated list read as a complete one.
      ...(store.warningsDropped > 0 ? { warningsDropped: store.warningsDropped } : {}),
    };
  }

  if (route === '/api/sessions') {
    // A single-session lookup lets the sidebar force-include the session on screen
    // even when a limit or filter would have excluded it, so the highlight can never
    // disagree with the detail pane.
    const only = url.searchParams.get('id');
    const filters = {
      agent: url.searchParams.get('agent') || undefined,
      kind: url.searchParams.get('kind') || undefined,
      includeArchived: url.searchParams.get('includeArchived') === '1',
    };
    const raw = only
      ? [store.getSession(only)].filter(Boolean)
      : store.listSessions({ limit: Number(url.searchParams.get('limit')) || 50, ...filters });
    const sessions = (await store.annotateWorkspaces(raw))
      .map((session) => ({ ...session, workspaceDir: fold(session.workspaceDir) }));
    // The sidebar asks for a capped page, and on a machine with hundreds of sessions
    // that cap is most of them: 300 of 614 measured, so more than half the history was
    // simply not on screen with nothing saying so. `total` lets the panel say the list
    // is a slice instead of presenting it as the machine. It counts the same filter the
    // page read, so a filtered sidebar cannot mistake the filter for the cap.
    return {
      sessions,
      ...(only ? {} : { total: store.countSessions(filters) }),
    };
  }

  if (route === '/api/agents') {
    // Agents differ per machine — sub-agent names come from whatever presets that
    // install has — so the filter's options are read from the data, not hard-coded.
    //
    // `includeArchived` off the same query string `/api/sessions` reads, and for the
    // same reason: a caller who sizes the list with `includeArchived=1` and then reads
    // these options for the menu gets counts over a different population, which is the
    // whole disagreement `listAgents` was fixed for.
    return {
      agents: store.listAgents({
        includeArchived: url.searchParams.get('includeArchived') === '1',
      }),
    };
  }

  if (route === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const raw = store.searchSessions({
      query,
      limit: Number(url.searchParams.get('limit')) || 50,
      offset: Number(url.searchParams.get('offset')) || 0,
    });
    const sessions = (await store.annotateWorkspaces(raw.sessions))
      .map((session) => ({ ...session, workspaceDir: fold(session.workspaceDir) }));
    // The query is not echoed: the client already has what they typed, and echoing a
    // request value back through the response body is a reflection surface.
    // `searchFailed` so the panel can tell "nothing matched" from "never searched".
    // `searchUnsearchable` is the third case: FTS5 is present and the query never
    // ran because this build's index does not carry the fields a match names. It
    // rides alongside rather than inside `searchFailed` so the panel can say which
    // happened — both look like an empty list, and the reader's next move differs.
    // `total` because the panel asks for a capped page: the common queries match most
    // of the machine's sessions, so a capped list is a subset and the panel has to be
    // able to say so rather than rendering a hundred rows as "the matches".
    return {
      sessions,
      total: raw.total,
      searchFailed: raw.failed === true,
      searchUnsearchable: raw.unsearchable === true,
    };
  }

  if (route === '/api/overview') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) {
      const [latest] = store.listSessions({ limit: 1 });
      if (!latest) return { session: null, stats: null, events: [], tasks: [] };
      return overview(store, fold, latest.sessionId, { homeDir, redactRoots });
    }
    setFocus?.(sessionId);
    return overview(store, fold, sessionId, { homeDir, redactRoots });
  }

  if (route === '/api/timeline') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new ApiError(400, 'session_required');
    // The timeline is capped for drawability, so the reply says whether it was cut:
    // a panel that drew 6,000 points for a 7,000-record session otherwise presents
    // the cap as the session. There is no `total` and there should not be one — the
    // store never counted past the cap, so it could only have reported the delivered
    // count under a name that reads as the session's size.
    let { points, truncated, sessionRows } = store.getTimeline(sessionId);
    // The same fallback the four record reads make, on the same key: the projection has
    // no rows for this session, so it produced an empty axis — and `truncated: false`
    // beside it is the strongest claim this Plugin can make that a list is complete.
    //
    // Measured on a session whose records were on disk and not indexed:
    //
    //   trajectory_get    source: jsonl, returned: 3
    //   trajectory_turns  source: jsonl, total: 1
    //   /api/timeline     points: 0, truncated: false
    //
    // One empty axis against two populated answers to the same session. The panel's
    // records and turns came from the artifact; its axis was empty and said it was the
    // whole thing. A reader comparing two sessions could not tell that difference from
    // one that was genuinely idle.
    let source = 'sqlite';
    if (sessionRows === 0) {
      const artifact = await store.readJsonlEvents({
        sessionId, offset: 0, limit: LIMITS.timeline, detailLevel: 'summary',
      });
      if (hasArtifactEvidence(artifact)) {
        points = jsonlTimelinePoints(artifact.events);
        truncated = false;
        source = 'jsonl';
      }
    }
    return { points, truncated, source };
  }

  if (route === '/api/task-output') {
    const taskId = url.searchParams.get('taskId');
    if (!taskId) throw new ApiError(400, 'taskId_required');
    const maxBytes = Math.min(262144, Math.max(256, Number(url.searchParams.get('maxBytes')) || 16384));
    let output;
    try {
      output = await store.readTaskOutput(taskId, { maxBytes });
    } catch {
      // readTaskOutput validates the id against a strict shape; a rejection is a bad
      // request, not a server fault.
      throw new ApiError(400, 'invalid_task_id');
    }
    // The task output is a credential surface in its own right — a `bash` task's
    // captured stdout is where an inline secret actually lands — so the sweep here
    // knows the home directory too, rather than leaving the folding entirely to the
    // boundary pass.
    //
    // `keep: 'tail'` for the same reason as the MCP tool: the read was a tail read, so
    // the bound must keep the end of it. The panel's own banner counts characters from
    // the file's size, and a bound that cut the newest output instead would leave the
    // banner describing a region the reader is not looking at.
    return { ...output, text: redactText(output.text, { maxLength: 262144, keep: 'tail', homeDir, roots: redactRoots }) };
  }

  if (route === '/api/events') {
    const sessionId = url.searchParams.get('id') || getFocus();
    if (!sessionId) throw new ApiError(400, 'session_required');
    const detailLevel = url.searchParams.get('detailLevel') === 'full' ? 'full' : 'summary';
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    // `?turnId=` and no `turnId` at all are different questions: one asks for the rows
    // that carry no turn identity, the other asks for no filter. Collapsing them with
    // `|| undefined` made the first return the whole session.
    const rawTurn = url.searchParams.get('turnId');
    const turnId = url.searchParams.has('turnId') ? rawTurn : undefined;
    let page = store.getEvents({ sessionId, offset, limit, detailLevel, turnId });
    // Keyed on the session's row count, not on this page. `page.events.length === 0`
    // is also what a turn filter matching nothing looks like, and it let the source
    // change between two pages of one cursor. See the longer note in `mcp.mjs`.
    let eventsArtifact = null;
    if (page.sessionRows === 0) {
      const artifact = await store.readJsonlEvents({
        sessionId, offset: page.offset ?? offset, limit, detailLevel, turnId,
      });
      eventsArtifact = artifact;
      // Drop the projection's own row count for the same reason `mcp.mjs` does: it
      // counted the source the artifact just replaced, and carrying its `0` into a
      // reply full of artifact events published `sessionTotal: 0` beside them.
      if (hasArtifactEvidence(artifact)) {
        const { sessionRows: _projectionRows, ...projection } = page;
        page = { ...projection, ...artifact };
      }
    }
    const events = detailLevel === 'full'
      ? page.events.map((event) => redactEvent(event, { maxLength: 20000, homeDir, roots: redactRoots }))
      : page.events;
    // Per-string limits do not bound the response: trim the record list to a byte
    // budget and report it, so a 1000-record full page cannot return tens of MB.
    const bounded = boundPayloadList(events, { maxBytes: EGRESS_TOTAL_BYTES });
    // The cursor has to name the first record the client did *not* get.
    //
    // It used to echo the store's own `nextOffset`, which counts what was *read* —
    // so a 1000-record page cut to 209 records answered `nextOffset: 1000` and
    // records 209-999 were skipped by every client, permanently. The cursor is now
    // derived from delivered records whenever the list was trimmed, and the client
    // uses it directly (`web/js/flow.js`), so this is the difference between a
    // complete session and a silently shortened one.
    //
    // `readAt` is the offset the read actually used, after normalisation: a float or a
    // non-numeric offset used to raise `datatype mismatch` inside SQLite and the page
    // came back empty, which the panel then reported as "not in the projection".
    const readAt = page.offset ?? offset;
    const delivered = bounded.items.length;
    return {
      detailLevel,
      source: page.source,
      offset: readAt,
      total: page.total ?? null,
      ...(page.sessionRows !== undefined && page.sessionRows !== page.total
        ? { sessionTotal: page.sessionRows } : {}),
      nextOffset: delivered === 0 ? null : (bounded.truncated ? readAt + delivered : page.nextOffset),
      truncated: bounded.truncated,
      omitted: bounded.omitted,
      // The page byte budget stopped the read, which is a different cut from the frame
      // budget above: `returned` is below `limit` with nothing omitted from what was
      // read, so without this the panel saw a short page described as a whole one.
      // Separate from `truncated` because `omitted: 0, truncated: true` reads as a
      // contradiction, and separate because the reason a page is short matters.
      ...(page.pageBytesTruncated ? { pageBytesTruncated: true } : {}),
      // A line past the JSONL line cap is dropped at the source; say so rather than
      // let a short file read as a faithful one.
      ...(page.droppedOversized > 0 ? { droppedOversized: page.droppedOversized } : {}),
      ...(page.malformedLines > 0 ? { malformedLines: page.malformedLines } : {}),
      ...(page.taskIndexTruncated ? { taskIndexTruncated: true } : {}),
      ...(page.source === 'error' ? { error: page.error ?? 'event_read_failed' } : {}),
      // The same disclosure `trajectory_get` makes, reached the same way — and this
      // route is the one place it cannot assume the session was resolved first: `id`
      // arrives from the query string, so an unknown id would otherwise be reported as
      // a session whose records went missing.
      ...(recordsUnavailable({
        sessionExists: Boolean(store.getSession(sessionId)),
        projectionRows: page.sessionRows,
        artifact: eventsArtifact,
      }) ? { recordsUnavailable: true } : {}),
      events: bounded.items,
    };
  }

  // The route is deliberately absent from the message: it is request-controlled.
  throw new ApiError(404, 'unknown_route');
}

/**
 * The overview payload.
 *
 * `homeDir` and `redactRoots` are arguments rather than closed-over names. This is a
 * module-level function, so the agent branch's `redactText(…, { homeDir, roots })`
 * was reading two identifiers that do not exist in its scope — a ReferenceError, not
 * a null, and therefore a `500 internal_error` for exactly one class of session: the
 * ones with an agent definition whose `systemPrompt` is non-empty. The fixtures all
 * stubbed `getAgentDefinition: () => null`, so the branch never ran. The context it
 * needs is in the argument list now, and the regression test drives a populated one.
 */
async function overview(store, fold, sessionId, { homeDir, redactRoots } = {}) {
  const session = store.getSession(sessionId);
  if (!session) throw new ApiError(404, 'session_not_found');
  const stats = store.getStats(sessionId);
  const agent = store.getAgentDefinition(sessionId);
  // 500 tasks is 500 records in one reply, and a task's `description` is a command
  // line — a credential surface whose per-string bound is not an aggregate bound.
  // The same budget the event page uses, and the same `truncated`/`omitted` report,
  // so a trimmed task list cannot read as a complete one.
  //
  // One row past the cap, because the 500 was a limit with no count behind it: a
  // session owning 900 tasks answered `tasksTruncated: false, tasksOmitted: 0` with
  // 400 of them absent, since the byte budget never tripped. The byte budget trims a
  // list this reply read; the cap stops the read. Both now say so, and `tasksTotal`
  // is the session's real count — which is also what `stats.backgroundTasks` beside
  // it already reported, so the two used to contradict each other on the same
  // session.
  //
  // The read cap is the smaller of this row budget and `TASK_LIST_MAX_ROWS`, so the
  // number of rows materialised is a constant rather than a function of the session:
  // the reply trims to `EGRESS_TOTAL_BYTES` regardless, and reading several times that
  // many rows only made the peak larger.
  const OVERVIEW_TASKS = Math.min(500, TASK_LIST_MAX_ROWS);
  const taskRows = store.listBackgroundTasks(sessionId, { limit: OVERVIEW_TASKS + 1 });
  const tasksCapped = taskRows.length > OVERVIEW_TASKS;
  const boundedTasks = boundPayloadList(
    tasksCapped ? taskRows.slice(0, OVERVIEW_TASKS) : taskRows,
    { maxBytes: EGRESS_TOTAL_BYTES },
  );
  // What the session really owns, not what this reply managed to read.
  //
  // `tasksOmitted` used to be the rows dropped *from the window this handler read* —
  // the byte-budget loss plus the one row the look-ahead found past the cap. A session
  // owning 5,000 tasks read 501, delivered 500 and answered `tasksOmitted: 1` while
  // 4,500 were absent, against `tasksTotal: 5000` in the very same payload. The
  // omission count has to be measured against the same total it is published next to,
  // or the two contradict each other and the smaller one is the one a client trusts.
  const tasksTotal = store.countBackgroundTasks(sessionId);
  // No events here on purpose: the client asks /api/events for the page it will
  // actually render. Fetching them here only to discard them was the single
  // largest waste in a session switch.
  // The same disclosure `/api/events` makes, about the same fold, computed the same way.
  //
  // `stats` is a second publication of the session totals, and it was the only one of the
  // panel's session-shaped routes that published the zero-fold unqualified: measured on a
  // real machine, a session with a row and no records anywhere came back here as
  // `turns: 0, steps: 0, toolCalls: 0, events: 0` with no flag, while `/api/events` for
  // the same session answered `recordsUnavailable: true`. The panel only saw a correct
  // account because it happens to call both — a reader of either route alone did not.
  //
  // Async for the artifact probe, which is the one part of the predicate that needs I/O.
  // It runs only when the row count is zero, so the ordinary path pays one indexed
  // aggregate and nothing else.
  // Optional method, optional disclosure. Several route doubles and hand-built store
  // objects do not carry it, and a session's totals must not become unservable because
  // the disclosure could not be made — the same reasoning `search.mjs` applies to
  // `store.searchable`. `null` is the conservative answer: a store that could not look
  // is not a store that looked and found nothing.
  const projectionRows = typeof store.messageRowCount === 'function'
    ? store.messageRowCount(sessionId) : null;
  let unavailable = false;
  if (projectionRows === 0) {
    const artifact = await store.readJsonlTurnSummaries({ sessionId });
    unavailable = recordsUnavailable({ sessionExists: true, projectionRows, artifact });
  }
  return {
    session: { ...session, workspaceDir: fold(session.workspaceDir) },
    // `stats` carries the session's workspace path again, so it needs the same
    // treatment: returning it raw leaked the absolute user path that the `session`
    // field right above it had just collapsed to `~`.
    stats: stats
      ? { ...stats, workspaceDir: fold(stats.workspaceDir), ...(unavailable ? { recordsUnavailable: true } : {}) }
      : stats,
    turns: store.getTurnSummaries(sessionId),
    agent: agent
      ? { ...agent, systemPrompt: agent.systemPrompt ? redactText(agent.systemPrompt, { maxLength: 20000, homeDir, roots: redactRoots }) : null }
      : null,
    tasks: boundedTasks.items,
    tasksTotal,
    tasksTruncated: boundedTasks.truncated || tasksCapped,
    // Everything this session owns that this reply did not carry — the byte budget's
    // cut, the 500-row cap's cut, and the rows no read ever looked at.
    tasksOmitted: Math.max(0, tasksTotal - boundedTasks.items.length),
  };
}

