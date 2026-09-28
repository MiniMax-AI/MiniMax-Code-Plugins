import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRequestHandler, createStudio } from '../server/http.mjs';
import { openStore } from '../server/store.mjs';

/**
 * The panel's authorization boundary, its network exposure, and the render sinks
 * its assets are allowed to use.
 *
 * The earlier revision fenced the panel with a Host check, an Origin check and a
 * fixed custom header. All three are cross-site request forgery defences: they
 * stop a *web page* from reaching the API, and none of them stops a *process*.
 * Any local program could send the fixed header and read every session's tool
 * arguments and results over HTTP. A panel therefore needs a capability, not just
 * a fence — a secret that only the caller the agent handed the URL to possesses.
 *
 * The capability is per process and in memory only, which is also what keeps
 * concurrent sessions apart: session A's token is not valid on session B's panel.
 *
 * These tests are deliberately shaped so that "refuse everything" cannot pass
 * them: every fence has a positive control that has to succeed.
 */

const PORT = 7411;

/* ------------------------------------------------------------ fake request -- */

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); },
  };
}

function makeReq({ method = 'GET', url = '/api/meta', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host: `127.0.0.1:${PORT}`, ...headers },
    socket: { localPort: PORT, remoteAddress },
  };
}

function makeStore(overrides = {}) {
  return {
    dataDir: '/tmp/trajectory-studio-test',
    db: {},
    hasFts: false,
    warnings: [],
    listSessions: () => [],
    getSession: () => null,
    listAgents: () => [],
    annotateWorkspaces: (sessions) => sessions,
    searchSessions: () => [],
    getTimeline: () => ({ points: [], total: 0, truncated: false }),
    getEvents: () => ({ events: [], total: 0, sessionRows: 0, nextOffset: null, source: 'sqlite' }),
    getTurnSummaries: () => [],
    listBackgroundTasks: () => [],
    getStats: () => null,
    getAgentDefinition: () => null,
    readTaskOutput: async () => ({ taskId: 'x', available: false, bytes: 0, truncated: false, text: '' }),
    ...overrides,
  };
}

async function request(handler, req) {
  const res = makeRes();
  const original = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await handler(req, res);
  } finally {
    process.stderr.write = original;
  }
  return res;
}

const guarded = (token) => createRequestHandler({
  store: makeStore(),
  homeDir: '/tmp/trajectory-fixture-home',
  getFocus: () => null,
  setFocus: () => {},
  getToken: () => token,
});

/* ---------------------------------------------------------------- section -- */

test('the old fixed header alone no longer reaches the API', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq({ headers: { 'x-trajectory-client': '1' } }));
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error, 'forbidden_token');
});

test('no credential is refused', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq());
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_token');
});

test('a wrong credential of the same length is refused', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq({ headers: { 'x-trajectory-token': 'SECRET-TOKEZ' } }));
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error, 'forbidden_token');
});

test('a credential of a different length is refused without throwing', async () => {
  for (const value of ['', 'x', 'SECRET-TOKEN-and-more']) {
    const res = await request(guarded('SECRET-TOKEN'), makeReq({ headers: { 'x-trajectory-token': value } }));
    assert.equal(res.status, 403, `${JSON.stringify(value)} was accepted`);
  }
});

test('a repeated credential header is refused rather than compared', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq({
    headers: { 'x-trajectory-token': ['SECRET-TOKEN', 'SECRET-TOKEN'] },
  }));
  assert.equal(res.status, 403, 'an array header was accepted');
});

test('the positive control: the right credential is accepted', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq({ headers: { 'x-trajectory-token': 'SECRET-TOKEN' } }));
  assert.equal(res.status, 200, res.body);
});

test('the refusal leaks neither the credential nor the supplied value', async () => {
  const res = await request(guarded('SECRET-TOKEN'), makeReq({ headers: { 'x-trajectory-token': 'GUESSED-VALUE-XYZ' } }));
  assert.equal(res.body.includes('SECRET-TOKEN'), false, 'the expected credential was echoed');
  assert.equal(res.body.includes('GUESSED-VALUE-XYZ'), false, 'the supplied value was echoed');
});

/* -------------------------------------------------------------- transport -- */

test('the panel binds loopback explicitly, not every interface', async () => {
  const store = makeStore();
  const studio = createStudio({ store, homeDir: '/tmp/trajectory-fixture-home' });
  try {
    const started = await studio.start({});
    assert.equal(started.boundTo, '127.0.0.1');
    assert.equal(studio.status.boundTo, '127.0.0.1');
    assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\//u);
  } finally {
    await studio.stop();
  }
});

test('the panel is not reachable on a non-loopback address', async () => {
  const external = Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  if (external.length === 0) return; // nothing but loopback on this host

  const studio = createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home' });
  try {
    const started = await studio.start({});
    for (const address of external) {
      await assert.rejects(
        fetch(`http://${address}:${started.port}/api/meta`, { signal: AbortSignal.timeout(2000) }),
        `the panel answered on ${address}`,
      );
    }
  } finally {
    await studio.stop();
  }
});

test('a request from a non-loopback peer is refused even if it arrives', async () => {
  const res = await request(
    guarded('SECRET-TOKEN'),
    makeReq({ headers: { 'x-trajectory-token': 'SECRET-TOKEN' }, remoteAddress: '192.168.1.50' }),
  );
  assert.equal(res.status, 403, res.body);
  assert.equal(JSON.parse(res.body).error, 'forbidden_remote');
});

test('an IPv6 loopback peer is accepted', async () => {
  for (const address of ['::1', '::ffff:127.0.0.1', '127.0.0.1']) {
    const res = await request(
      guarded('SECRET-TOKEN'),
      makeReq({ headers: { 'x-trajectory-token': 'SECRET-TOKEN' }, remoteAddress: address }),
    );
    assert.equal(res.status, 200, `${address} was refused: ${res.body}`);
  }
});

/* -------------------------------------------------------- capability shape -- */

test('the minted URL carries the capability, and it is fresh entropy', async () => {
  const stores = [makeStore(), makeStore()];
  const studios = stores.map((store) => createStudio({ store, homeDir: '/tmp/trajectory-fixture-home' }));
  try {
    const [a, b] = [await studios[0].start({}), await studios[1].start({})];
    const tokenOf = (url) => /#t=([A-Za-z0-9_-]+)$/u.exec(url)?.[1];
    const tokenA = tokenOf(a.url);
    const tokenB = tokenOf(b.url);
    assert.ok(tokenA, `no capability in ${a.url}`);
    assert.ok(tokenB, `no capability in ${b.url}`);
    assert.notEqual(tokenA, tokenB, 'two panels minted the same capability');
    assert.ok(tokenA.length >= 32, `capability too short: ${tokenA.length}`);
    // A fresh mint has to come from the CSPRNG, not a counter or a hash of state.
    assert.notEqual(tokenA, String(Number(tokenA)), 'the capability looks sequential');
  } finally {
    await Promise.all(studios.map((studio) => studio.stop()));
  }
});

test("one process's capability does not open another process's panel", async () => {
  const [a, b] = [createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home' }), createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home' })];
  try {
    const startedA = await a.start({});
    await b.start({});
    const tokenA = /#t=([A-Za-z0-9_-]+)$/u.exec(startedA.url)[1];
    const asB = await fetch(`http://127.0.0.1:${b.status.port}/api/meta`, { headers: { 'x-trajectory-token': tokenA } });
    assert.equal(asB.status, 403, "session A's capability opened session B's panel");
    const asA = await fetch(`http://127.0.0.1:${a.status.port}/api/meta`, { headers: { 'x-trajectory-token': tokenA } });
    assert.equal(asA.status, 200);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
  }
});

test('restarting the panel mints a new capability rather than reusing the old one', async () => {
  const studio = createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home' });
  try {
    const first = await studio.start({});
    const reused = await studio.start({});
    assert.equal(reused.reused, true, 'a second start while running must reuse the panel');
    assert.equal(reused.url, first.url, 'a running panel must keep its capability');
    await studio.stop();
    const second = await studio.start({});
    assert.notEqual(second.url, first.url, 'a restarted panel reused its capability');
  } finally {
    // A studio left running keeps the event loop alive and the test process never
    // exits, which looks like a hang rather than a failure.
    await studio.stop();
  }
});

test('the panel creates no files, including under PLUGIN_DATA', async () => {
  const pluginData = await mkdtemp(path.join(tmpdir(), 'trajectory-plugin-data-'));
  const previous = process.env.PLUGIN_DATA;
  process.env.PLUGIN_DATA = pluginData;
  const studio = createStudio({ store: makeStore(), homeDir: '/tmp/trajectory-fixture-home' });
  try {
    const started = await studio.start({});
    const token = /#t=([A-Za-z0-9_-]+)$/u.exec(started.url)[1];
    await fetch(`http://127.0.0.1:${started.port}/api/meta`, { headers: { 'x-trajectory-token': token } });
    await fetch(`http://127.0.0.1:${started.port}/api/sessions?limit=1`, { headers: { 'x-trajectory-token': token } });
    await studio.stop();
    const left = await readdir(pluginData);
    assert.deepEqual(left, [], `the panel wrote ${left.join(', ')} into PLUGIN_DATA`);
  } finally {
    if (previous === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previous;
    await studio.stop();
  }
});

/* -------------------------------------------------------- render sinks -- */

/**
 * Sinks that would let payload text become markup.
 *
 * The client builds every node with `createElement` and writes only `textContent`,
 * which is why a hostile session body renders as text. This scanner exists because
 * that property is a convention, not a compiler guarantee: one `innerHTML =` added
 * later would silently turn every session's tool output into an injection vector.
 * It is mutation-checked below so a passing scan cannot be a false green.
 */
const FORBIDDEN_SINKS = [
  { label: 'innerHTML', re: /\.innerHTML\s*=/u },
  { label: 'outerHTML', re: /\.outerHTML\s*=/u },
  { label: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/u },
  { label: 'document.write', re: /document\.write\s*\(/u },
  { label: 'srcdoc', re: /\bsrcdoc\s*=/u },
  { label: 'eval', re: /\beval\s*\(/u },
  { label: 'new Function', re: /new\s+Function\s*\(/u },
  { label: 'a javascript: URL', re: /["'`]javascript:/u },
  // A computed attribute name is how a payload escapes an attribute position.
  { label: 'a computed setAttribute name', re: /\.setAttribute\s*\(\s*[^"'`)]/u },
];

export function scanRenderSinks(source) {
  return FORBIDDEN_SINKS.filter(({ re }) => re.test(source)).map(({ label }) => label);
}

async function shippedWebFiles(root = path.join(import.meta.dirname, '..', 'web')) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await shippedWebFiles(full));
    else if (/\.(?:js|html)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

test('the scanner reports each sink it claims to catch', () => {
  // Without this, a typo in a pattern would make the real scan pass forever.
  const samples = [
    ['el.innerHTML = payload;', 'innerHTML'],
    ['el.outerHTML = payload;', 'outerHTML'],
    ['el.insertAdjacentHTML("beforeend", payload);', 'insertAdjacentHTML'],
    ['document.write(payload);', 'document.write'],
    ['frame.srcdoc = payload;', 'srcdoc'],
    ['eval(payload);', 'eval'],
    ['const f = new Function(payload);', 'new Function'],
    ['const href = "javascript:alert(1)";', 'a javascript: URL'],
    ['el.setAttribute(name, payload);', 'a computed setAttribute name'],
  ];
  for (const [source, expected] of samples) {
    assert.ok(scanRenderSinks(source).includes(expected), `scanner missed ${expected} in: ${source}`);
  }
  // And that it does not fire on the shapes the client actually uses.
  assert.deepEqual(scanRenderSinks('el.textContent = payload;'), []);
  assert.deepEqual(scanRenderSinks('node.setAttribute("aria-selected", "true");'), []);
  assert.deepEqual(scanRenderSinks('document.createElement("div");'), []);
});

test('no shipped asset uses a markup injection sink', async () => {
  const offenders = [];
  for (const file of await shippedWebFiles()) {
    const source = await readFile(file, 'utf8');
    for (const sink of scanRenderSinks(source)) {
      offenders.push(`${path.relative(process.cwd(), file)} uses ${sink}`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the page loads no remote origin and permits no inline script', async () => {
  const html = await readFile(path.join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  assert.equal(/https?:\/\//u.test(html.replace(/data:image\/svg\+xml[^"]*/gu, '')), false,
    'index.html references a remote origin');
  assert.equal(/<script(?![^>]*\bsrc=)/u.test(html), false, 'index.html carries an inline script');
});

test('the panel opens content-free and the toggle cannot disagree with the state', async () => {
  // The documented posture is that message text, tool arguments and tool results are
  // loaded only when the reader asks. The markup used to open with the toggle
  // `checked` while the state defaulted to `full`, so the panel fetched content the
  // control said it was not fetching — a privacy default that existed in the design
  // note and nowhere in the code.
  const dir = path.join(import.meta.dirname, '..', 'web');
  const html = await readFile(path.join(dir, 'index.html'), 'utf8');
  const toggle = /<input[^>]*id="full-detail"[^>]*>/u.exec(html);
  assert.ok(toggle, 'the detail toggle is gone from index.html');
  assert.equal(/\bchecked\b/u.test(toggle[0]), false, 'the toggle ships checked, so the panel fetches content unasked');

  const state = await readFile(path.join(dir, 'js', 'state.js'), 'utf8');
  assert.match(state, /detailLevel:\s*'summary'/u, 'the state default is not summary');

  // The control must be driven from the state, not the other way round, or the two
  // can drift apart again.
  const wire = await readFile(path.join(dir, 'js', 'wire.js'), 'utf8');
  assert.match(wire, /el\('full-detail'\)\.checked\s*=\s*state\.detailLevel/u,
    'wire.js does not derive the toggle from state.detailLevel');
});
