/**
 * Just enough DOM to execute the panel's own modules, with nothing installed.
 *
 * The browser half of this plugin had no automated coverage at all: every check ran
 * against the server over a socket and never loaded a line of `web/js/`. The fixes
 * that shipped — the selection epoch, the page token, the reset ordering, the dedupe
 * — live entirely in those modules, so nothing in CI could see them go away.
 *
 * There is no browser on a CI runner and the Plugin may not take a dependency
 * (a release gate enforces that it ships none), so this is the alternative: a stub
 * small enough to read in one sitting. It is deliberately not a DOM implementation.
 * It models the handful of operations the panel actually performs — node creation,
 * `textContent`, `append`, `classList`, `dataset`, listeners, and a selector good
 * enough for `.class` / `[data-x="y"]` / `tag` — and nothing else. Anything the
 * client starts doing that this cannot express fails loudly here rather than
 * passing quietly.
 *
 * Every surface the panel writes through goes to `textContent`, so there is no
 * markup sink here to assert about; `test/panel-security.test.mjs` source-scans the
 * real assets for those instead.
 */

/* --------------------------------------------------------------- elements -- */

const camel = (name) => name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

/** Match `.class`, `[attr]`, `[attr="value"]`, a bare tag, and any concatenation. */
function matchesOne(node, selector) {
  const tag = selector.match(/^[a-z][\w-]*/u)?.[0];
  if (tag && node.tagName !== tag) return false;
  for (const [, name] of selector.matchAll(/\.([\w-]+)/gu)) {
    if (!node.classes.has(name)) return false;
  }
  for (const [, attribute, value] of selector.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/gu)) {
    const actual = attribute.startsWith('data-')
      ? node.dataset[camel(attribute.slice(5))]
      : node.attributes.get(attribute);
    if (value === undefined) {
      if (actual === undefined || actual === null) return false;
    } else if (String(actual) !== value) return false;
  }
  return true;
}

class StubElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toLowerCase();
    this.nodeName = this.tagName;
    this.isFragment = false;
    this.childNodes = [];
    this.parentElement = null;
    this.dataset = {};
    this.style = {
      setProperty: (name, value) => { this.style[name] = String(value); },
      getPropertyValue: (name) => this.style[name] ?? '',
      removeProperty: (name) => { delete this.style[name]; },
    };
    this.attributes = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.id = '';
    this.title = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
    this._text = '';
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) => {
        const next = on ?? !this.classes.has(name);
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      },
    };
  }

  get className() {
    return [...this.classes].join(' ');
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/u).filter(Boolean));
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof StubElement);
  }

  /** Concatenated like the real thing: descendants only, never a stale `_text`. */
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentElement = null;
    this.childNodes = [];
    this._text = value === undefined || value === null ? '' : String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = node instanceof StubElement ? node : new StubElement('#text');
      if (child !== node) child._text = String(node);
      if (child.isFragment) {
        // A fragment is spliced in, not adopted: the client builds a whole batch of
        // rows off-document and appends it in one go.
        for (const grandchild of child.childNodes.splice(0)) {
          grandchild.parentElement = null;
          this.append(grandchild);
        }
        continue;
      }
      child.parentElement?.removeChild(child);
      child.parentElement = this;
      this.childNodes.push(child);
    }
    return this;
  }

  removeChild(child) {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentElement = null;
  }

  remove() {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'id') this.id = '';
    if (name === 'class') this.className = '';
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  contains(node) {
    return node === this || this.childNodes.some((child) => child.contains?.(node));
  }

  matches(selector) {
    return selector.split(',').map((part) => part.trim()).filter(Boolean)
      .some((part) => matchesOne(this, part));
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    for (const child of this.childNodes) {
      if (child instanceof StubElement && child.matches(selector)) found.push(child);
      if (child instanceof StubElement) found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  /**
   * Invoke every listener and return their results, so a test can await an async
   * handler — `wire.js` binds the mid-scroll loader as one, and whether it *resolves*
   * is the difference between a reported failure and an unhandled rejection.
   */
  async dispatch(type, event = {}) {
    const results = [];
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      results.push(await handler({ type, target: this, preventDefault() {}, stopPropagation() {}, ...event }));
    }
    return results;
  }

  cloneNode() {
    const copy = new StubElement(this.tagName);
    copy.id = this.id;
    copy._text = this._text;
    copy.classes = new Set(this.classes);
    copy.attributes = new Map(this.attributes);
    return copy;
  }

  scrollIntoView() { /* the panel only ever calls this to move the viewport */ }

  getBoundingClientRect() {
    return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 };
  }

  setPointerCapture() { /* not modelled */ }

  releasePointerCapture() { /* not modelled */ }

  focus() { /* not modelled */ }
}

/* ----------------------------------------------------------------- globals -- */

function buildDocument() {
  const byId = new Map();
  const body = new StubElement('body');
  const document = {
    body,
    documentElement: new StubElement('html'),
    createElement: (tag) => new StubElement(tag),
    createElementNS: (_namespace, tag) => new StubElement(tag),
    createDocumentFragment() {
      const fragment = new StubElement('#fragment');
      fragment.isFragment = true;
      return fragment;
    },
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener: (type, handler) => body.addEventListener(type, handler),
    /**
     * The panel asks for an id it is about to write to, and a missing element is a
     * crash in a browser. Creating it on demand keeps every test from having to
     * declare the whole document — and keeps one missing element from masquerading
     * as a race.
     */
    getElementById(id) {
      if (!byId.has(id)) {
        const node = new StubElement('div');
        node.id = id;
        byId.set(id, node);
        body.append(node);
      }
      return byId.get(id);
    },
  };
  return { document, body, byId };
}

/**
 * Install the browser globals the client reads. Returns the same document the client
 * will see, so a test can assert on it.
 */
export function installPanelDom({ hash = '#t=panel-test' } = {}) {
  const { document, body, byId } = buildDocument();
  const store = new Map();
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    CSS: globalThis.CSS,
    localStorage: globalThis.localStorage,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };

  globalThis.document = document;
  globalThis.window = {
    location: { hash, href: `http://127.0.0.1:0/${hash}`, reload() {} },
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/gu, '\\$&') };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  // The banner auto-hides after six seconds and `debounce` waits 140ms. Unreferenced
  // timers keep those from holding the test runner open, while leaving the timing
  // semantics alone — this is not a fake clock, it is the same clock, detached.
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const timer = previous.setTimeout(fn, ms, ...rest);
    timer.unref?.();
    return timer;
  };
  globalThis.clearTimeout = (timer) => previous.clearTimeout(timer);

  return {
    document,
    body,
    window: globalThis.window,
    el: (id) => document.getElementById(id),
    /** Read the panel's visible text for one id, notices strip included. */
    text: (id) => document.getElementById(id)?.textContent ?? '',
    /** Forget every element created so far; the next `getElementById` starts clean. */
    reset() {
      byId.clear();
      body.childNodes = [];
      body.listeners.clear();
    },
    restore() {
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      globalThis.CSS = previous.CSS;
      globalThis.localStorage = previous.localStorage;
      globalThis.setTimeout = previous.setTimeout;
      globalThis.clearTimeout = previous.clearTimeout;
    },
  };
}

/* ------------------------------------------------------------------ server -- */

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Resolve a pending route, unless the caller aborted it first. */
function race(signal, promise) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/**
 * Stand in for the panel's own server.
 *
 * `fetch` is the seam `api.js` already uses, so a route can be made slow, made to
 * fail, or made to answer with a disclosure the panel then has to render — without
 * stubbing a single module under test.
 */
export function installServer(routes = {}) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (pathname, init = {}) => {
    const url = new URL(pathname, 'http://panel.test');
    const call = {
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      offset: Number(url.searchParams.get('offset') ?? 0),
      headers: init.headers ?? {},
      signal: init.signal ?? null,
    };
    calls.push(call);
    const route = routes[url.pathname];
    if (!route) return jsonResponse(404, { error: 'unknown_route' });
    const answered = typeof route === 'function' ? route(call) : route;
    const settled = await race(init.signal, Promise.resolve(answered));
    if (settled instanceof Error) throw settled;
    return jsonResponse(settled?.status ?? 200, settled?.body ?? {});
  };
  return {
    calls,
    restore() { globalThis.fetch = previous; },
  };
}

/* --------------------------------------------------------------- utilities -- */

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask and timer callback run. */
export function tick(times = 3) {
  let chain = Promise.resolve();
  for (let index = 0; index < times; index += 1) {
    chain = chain.then(() => new Promise((resolve) => { setImmediate(resolve); }));
  }
  return chain;
}

/**
 * Snapshot the shared client state and return the restore function.
 *
 * The state object is a module singleton by design — the surfaces mutate it in
 * place — so a test file that runs several scenarios has to put it back itself or
 * the second scenario inherits the first one's session.
 */
export function snapshotState(state) {
  const saved = new Map(Object.entries(state));
  return () => {
    for (const key of Object.keys(state)) {
      const value = saved.get(key);
      if (value instanceof Set) state[key] = new Set(value);
      else if (value instanceof Map) state[key] = new Map(value);
      else if (Array.isArray(value)) state[key] = [...value];
      else state[key] = value;
    }
  };
}

/* ----------------------------------------------------------------- fixtures -- */

export function sessionSummary(sessionId, overrides = {}) {
  return {
    sessionId,
    title: `session ${sessionId}`,
    agent: 'main',
    sessionKind: 'main',
    workspaceDir: '~/repo',
    updatedAtMs: 1_700_000_000_000,
    sources: [{ source: 'sqlite', count: 0 }],
    ...overrides,
  };
}

export function statsPayload(sessionId, overrides = {}) {
  return {
    sessionId,
    title: `session ${sessionId}`,
    turns: 1,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    decodeMs: 0,
    thinkingMs: 0,
    thinkingEvents: 0,
    decodeTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    toolCalls: 0,
    toolFailures: 0,
    compactions: 0,
    compactionFailures: 0,
    subagentTasks: 0,
    backgroundTasks: 0,
    events: 0,
    unreadableRows: 0,
    sources: [{ source: 'sqlite', count: 0 }],
    ...overrides,
  };
}

export function overviewPayload(sessionId, overrides = {}) {
  return {
    session: sessionSummary(sessionId),
    stats: statsPayload(sessionId),
    turns: [],
    agent: null,
    tasks: [],
    tasksTruncated: false,
    tasksOmitted: 0,
    ...overrides,
  };
}

export function eventPayload(sessionId, overrides = {}) {
  const events = overrides.events ?? [
    { rowId: 1, index: 0, role: 'user', inputKind: 'human', content: 'hi', turnId: 'turn-1' },
  ];
  return {
    detailLevel: 'summary',
    source: 'sqlite',
    offset: 0,
    total: events.length,
    nextOffset: null,
    truncated: false,
    omitted: 0,
    events,
    ...overrides,
  };
}
