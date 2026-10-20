/**
 * The capability, tested over a real socket.
 *
 * `panel-security.test.mjs` proves the fences hold by calling the request handler with
 * a hand-built `req` object. That skips everything the HTTP layer does before the
 * handler sees a request: `new URL(req.url, base)` parsing, Node's header handling,
 * and the path the socket actually takes. A prefix check that reads
 * `url.pathname.startsWith('/api/')` is exactly the kind of thing that behaves
 * differently once a real URL parser has had its way with the string.
 *
 * So this file starts a real listener and fetches from it. The store always holds one
 * recognisable session, and the assertion is about that session appearing in a body:
 * a `200` alone proves nothing, because the panel answers `200` for the static shell.
 *
 * What the matrix says, and what it does not: the capability is the *authorization*
 * boundary, and Host/Origin/Sec-Fetch are cross-site request forgery defences layered
 * on top. A caller that already holds the token is authorized, so serving it is
 * correct — including when its request line carries a protocol-relative or
 * backslashed path. What must never happen is a body containing session data without
 * the token, whatever the request line looks like, so that is what every case asserts.
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import test, { after, before } from 'node:test';

import { createStudio } from '../server/http.mjs';

/** The one session a leak would expose. */
const SECRET = 'session-canary-9f3a';

function makeStore() {
  return {
    dataDir: '/tmp/trajectory-authz-test',
    db: {},
    hasFts: false,
    warnings: [],
    warningsDropped: 0,
    listSessions: () => [{ sessionId: SECRET, title: 'canary', workspaceDir: '/tmp/ws', updatedAtMs: 1, kind: 'conversation' }],
    countSessions: () => 1,
    getSession: () => ({ sessionId: SECRET, title: 'canary', workspaceDir: '/tmp/ws', children: [] }),
    getStats: () => ({ turns: 1 }),
    getAgentDefinition: () => null,
    getTurnSummaries: () => [],
    listBackgroundTasks: () => [],
    countBackgroundTasks: () => 0,
    searchSessions: () => ({ sessions: [], total: 0, failed: false }),
    listAgents: () => [],
    annotateWorkspaces: (sessions) => sessions,
    getEvents: () => ({ events: [{ index: 0, role: 'user' }], total: 1, sessionRows: 1, nextOffset: null, offset: 0, source: 'sqlite' }),
    getTimeline: () => ({ points: [], total: 0, truncated: false }),
    readTaskOutput: async () => ({ taskId: 'x', available: false, bytes: 0, truncated: false, text: '' }),
    has: () => false,
    taskIndex: () => ({ byCall: new Map(), capped: false, total: 0 }),
  };
}

/* The eight routes the panel serves, so no route is left unprobed. */
const ROUTES = ['sessions', 'overview', 'events', 'meta', 'agents', 'search', 'timeline', 'task-output'];

const S = String.fromCharCode(47);
const B = String.fromCharCode(92);
const CRLF = String.fromCharCode(13, 10);
const SP = String.fromCharCode(32);

/**
 * Request lines a URL parser has to make a decision about.
 *
 * Each one either normalises to `/api/<route>` or does not; the point is that the
 * *token* decides access either way.
 */
const SHAPES = [
  ['plain', (route) => `${S}api${S}${route}`],
  ['traversal', (route) => `${S}api${S}..${S}api${S}${route}`],
  ['protocol-relative', (route) => `${S}${S}elsewhere.example${S}api${S}${route}`],
  ['backslash', (route) => `${S}api${B}${route}`],
  ['encoded-slash', (route) => `${S}api%2f${route}`],
  ['uppercase', (route) => `${S}API${S}${route}`],
  ['double-slash', (route) => `${S}api${S}${S}${route}`],
  ['null-byte', (route) => `${S}api${S}${route}%00`],
  ['dot-segment', (route) => `${S}api${S}.${S}${route}`],
];

let studio;
let base;
let token;
const host = () => `127.0.0.1:${base.split(':').pop()}`;

before(async () => {
  studio = createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home', redactRoots: [] });
  const started = await studio.start({ port: 0 });
  base = `http://127.0.0.1:${started.port}`;
  token = new URL(started.url).hash.slice(3);
});

after(async () => { await studio?.stop(); });

/** Fetch a request line and report what came back. */
async function probe(requestLine, headers) {
  const response = await fetch(base + requestLine, { headers: { host: host(), ...headers } });
  const body = await response.text();
  return { status: response.status, leaked: body.includes(SECRET) };
}

/**
 * Write the request bytes ourselves and read the status line back.
 *
 * `fetch` normalises more than it looks: it lowercases every header name and it will
 * not send the same header twice. Both are things a real client — a script, a proxy,
 * a browser extension — does at will, so the only way to test how the panel reads
 * them is to put them on the wire directly.
 */
async function rawProbe(requestLine, headerLines) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(
        `GET ${requestLine} HTTP/1.1${CRLF}` +
        `Host: 127.0.0.1:${port}${CRLF}` +
        `${headerLines}Connection: close${CRLF}${CRLF}`,
      );
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { raw += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      const status = Number(raw.split(`${CRLF}`)[0].split(' ')[1]);
      const body = raw.slice(raw.indexOf(`${CRLF}${CRLF}`));
      resolve({ status, leaked: body.includes(SECRET) });
    });
  });
}

/* ------------------------------------------------------------ the matrix -- */

test('no request line reaches session data without the capability', async () => {
  const credentials = [
    ['no credential', {}],
    ['empty credential', { 'x-trajectory-token': '' }],
    ['a one-character credential', { 'x-trajectory-token': 'x' }],
    // Same length as the real one, so nothing can fall out of a length check.
    ['a same-length wrong credential', { 'x-trajectory-token': 'x'.repeat(token.length) }],
  ];
  for (const [label, headers] of credentials) {
    const leaks = [];
    for (const [shape, make] of SHAPES) {
      for (const route of ROUTES) {
        const { status, leaked } = await probe(make(route), headers);
        if (leaked) leaks.push(`${shape}/${route}`);
        // 404 is what a request line that never reaches an API route gets; 403 is
        // what one that does gets refused with. Anything else is unaccounted for.
        if (status !== 403 && status !== 404) leaks.push(`${shape}/${route} answered ${status}`);
      }
    }
    assert.deepEqual(leaks, [], `${label}: ${leaks.join(', ')}`);
  }
});

test('a cross-site Origin does not open the API either', async () => {
  const leaks = [];
  for (const [shape, make] of SHAPES) {
    for (const route of ROUTES) {
      const { status, leaked } = await probe(make(route), { origin: 'http://elsewhere.example' });
      if (leaked) leaks.push(`${shape}/${route}`);
      if (status !== 403 && status !== 404) leaks.push(`${shape}/${route} answered ${status}`);
    }
  }
  assert.deepEqual(leaks, [], leaks.join(', '));
});

/* -------------------------------------------------------------- the fence -- */

/**
 * Credential spellings that are *not* ways in.
 *
 * These all end at 403 through the value comparison, and each one is a shape a real
 * caller can actually produce on the wire.
 */
test('the capability is not accepted from the query string', async () => {
  // `server/http.mjs` promises the token "stays out of request logs, out of Referer,
  // and out of any asset request". That holds because it lives in the URL *fragment*
  // and is read from the header alone. A `?token=` fallback would put it into every
  // access log on the path, so the absence of that route is a contract to pin rather
  // than an accident to leave unpoliced.
  for (const key of ['token', 'x-trajectory-token', 'capability', 'auth', 'access_token', 'api_key']) {
    const response = await fetch(`${base}${S}api${S}sessions?${key}=${encodeURIComponent(token)}`);
    const body = await response.text();
    assert.equal(response.status, 403, `?${key}= was taken as a credential`);
    assert.equal(body.includes(SECRET), false, `?${key}= reached session data`);
  }
});

test('a credential sent twice in one request is refused', async () => {
  // `panel-security.test.mjs` covers this with a hand-built `req` whose header value
  // is an array, which exercises the `typeof provided !== 'string'` guard in
  // `tokenMatches`. That array never arrives from a real client: Node's parser merges
  // repeated headers into one comma-joined value, so the reachable shape is
  // `"<token>, <token>"` and it is the value comparison that turns it away, not the
  // type guard. Both cases are worth a test, and only this one is reachable.
  for (const [label, lines] of [
    ['twice, both correct', `x-trajectory-token: ${token}${CRLF}x-trajectory-token: ${token}${CRLF}`],
    ['twice, one wrong', `x-trajectory-token: ${token}${CRLF}x-trajectory-token: wrong${CRLF}`],
    ['twice, both wrong', `x-trajectory-token: wrong${CRLF}x-trajectory-token: nope${CRLF}`],
  ]) {
    const { status, leaked } = await rawProbe(`${S}api${S}sessions`, lines);
    assert.equal(status, 403, `a credential sent ${label} was not refused`);
    assert.equal(leaked, false, `a credential sent ${label} reached session data`);
  }
});

test('the credential header is matched by name, not by spelling', async () => {
  // `TOKEN_HEADER` is written lowercase in the source. HTTP header names are
  // case-insensitive and Node lowercases whatever arrives, so a lowercase `fetch`
  // call cannot distinguish "matches by name" from "matches because the client
  // happened to agree with us". Writing the bytes removes the coincidence.
  for (const name of ['X-Trajectory-Token', 'X-TRAJECTORY-TOKEN', 'x-Trajectory-token']) {
    const { status } = await rawProbe(`${S}api${S}sessions`, `${name}: ${token}${CRLF}`);
    assert.equal(status, 200, `the panel rejected the perfectly valid name ${name}`);
  }
  // And the name still decides: a real credential under a name we do not read is
  // not a credential at all.
  const { status, leaked } = await rawProbe(`${S}api${S}sessions`, `Authorization: Bearer ${token}${CRLF}`);
  assert.equal(status, 403, 'the token was honoured from a header we never read');
  assert.equal(leaked, false);
});

test('a trailing or leading space is the same credential', async () => {
  // Stated because it looks like a hole and is not. RFC 7230 §3.2.4 makes the parser
  // drop optional whitespace from *both* ends of a header value, so
  // `X-Trajectory-Token: <token><SP>` and `X-Trajectory-Token: <SP><token>` are one
  // credential on the wire, exactly as the bare form is. Checked against Node's parser
  // rather than taken on faith: the raw bytes arrive as the token and nothing else,
  // byte for byte. The handler is handed the exact credential, so serving it is right
  // — and no amount of strictness in `tokenMatches` could tell these apart, because by
  // the time it runs the difference is gone.
  for (const [label, pad] of [['a trailing space', token + SP], ['a leading space', SP + token]]) {
    const { status } = await rawProbe(`${S}api${S}sessions`, `x-trajectory-token: ${pad}${CRLF}`);
    assert.equal(status, 200, `${label} should have been delivered as the plain credential`);
  }
  // The direction with teeth: whitespace *inside* the value is not stripped, so it
  // must not be accepted.
  const inside = await rawProbe(`${S}api${S}sessions`, `x-trajectory-token: ${token.slice(0, 4)}${SP}${token.slice(4)}${CRLF}`);
  assert.equal(inside.status, 403, 'an embedded space was treated as surrounding whitespace');
  assert.equal(inside.leaked, false);
});

test('the accepted credential is exactly the credential', async () => {
  // The token is the *only* accepted value — not a prefix of it, not the first field
  // of it. Surrounding whitespace above is the one laxity, and the HTTP layer applies
  // it before the handler runs. Everything else has to be a byte-for-byte match, which
  // is what keeps "tolerates any supplied shape" from quietly turning into "tolerates
  // anything shaped like it".
  for (const [label, value] of [
    ['followed by junk', `${token}x`],
    ['followed by a second field', `${token} X-Other: 1`],
    ['truncated by one character', token.slice(0, -1)],
    ['the token reversed', [...token].reverse().join('')],
    ['the token twice', token + token],
  ]) {
    const { status, leaked } = await rawProbe(`${S}api${S}sessions`, `x-trajectory-token: ${value}${CRLF}`);
    assert.equal(status, 403, `a credential ${label} was accepted`);
    assert.equal(leaked, false, `a credential ${label} reached session data`);
  }
});

test('a same-site or cross-site fetch is refused even with the right capability', async () => {
  // These are the two Sec-Fetch-Site values that mean the request did not come from
  // this panel's own origin.
  for (const site of ['cross-site', 'same-site']) {
    const { status } = await probe(`${S}api${S}sessions`, {
      'x-trajectory-token': token, 'sec-fetch-site': site,
    });
    assert.equal(status, 403, `sec-fetch-site: ${site} was not refused`);
  }
});

/* --------------------------------------------------------- positive control -- */

test('the right capability still opens the API', async () => {
  // Without this, every case above would also pass against a panel that refuses
  // everything, including itself.
  const { status, leaked } = await probe(`${S}api${S}sessions`, { 'x-trajectory-token': token });
  assert.equal(status, 200);
  assert.equal(leaked, true, 'the canary session did not come back, so the refusals prove nothing');
});

test('the capability is what decides access, not the shape of the request line', async () => {
  // The counterpart to the matrix above, stated so it is not mistaken for a defect:
  // a caller holding the token is authorized, so a normalising request line — one
  // that resolves to the same `/api/<route>` — is served. What the matrix forbids is
  // the same request line *without* the token.
  const served = [];
  for (const [shape, make] of SHAPES) {
    const { status, leaked } = await probe(make('sessions'), { 'x-trajectory-token': token });
    if (leaked) served.push(shape);
    assert.ok(status === 200 || status === 404, `${shape} answered ${status} with a valid capability`);
  }
  // The shapes a URL parser normalises back to the route are served; the ones that do
  // not resolve to an API path fall through to the static handler. Either is fine —
  // what matters is that it took the token to get there, which the matrix pins.
  assert.ok(served.includes('traversal'), 'the traversal shape should still resolve to the route');
  assert.ok(served.includes('backslash'), 'the backslash shape should still resolve to the route');
  assert.ok(!served.includes('encoded-slash'), 'an encoded slash must not resolve to the API prefix');
});

test('a second process does not inherit the first panel\'s capability', async () => {
  // The property that keeps two concurrent sessions apart, checked over the wire.
  const other = createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home', redactRoots: [] });
  const started = await other.start({ port: 0 });
  try {
    const otherBase = `http://127.0.0.1:${started.port}`;
    const response = await fetch(`${otherBase}${S}api${S}sessions`, {
      headers: { host: `127.0.0.1:${started.port}`, 'x-trajectory-token': token },
    });
    const body = await response.text();
    assert.equal(response.status, 403, 'one panel opened another');
    assert.equal(body.includes(SECRET), false);
  } finally {
    await other.stop();
  }
});