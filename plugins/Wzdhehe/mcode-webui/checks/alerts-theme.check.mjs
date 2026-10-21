// webui/checks/alerts-theme.check.mjs
// Mocked checks for the 2026-09-20 webui-manual-audit wave-2 frontend
// fixes (subagent D):
//
//   D1 — anomaly-channel (alerts) surface. server/lib/alerts.js pushes
//        system signals (failed chat send / spawn ENOENT, sqlite
//        failure, …) on the INDEPENDENT /api/alerts SSE channel; the
//        frontend had ZERO surface, so errors were invisible (P1).
//        Covers: the state.js alerts store driven by fake SSE frames
//        (snapshot / append / update / replay dedup / malformed), the
//        badge count + 99+ cap, mark-read-on-open, clear semantics,
//        and the render.js renderAlerts DOM construction (level class,
//        msg via textContent, src/session/×count/time meta line).
//   D2 — usage button local visibility (renderUsage usage-hidden
//        gating now remote-only).
//   D3 — appearance button theme cycling (applyTheme effect on the
//        documentElement data-theme attribute + localStorage persist +
//        card checkbox re-sync).
//   D4 — i18n completeness for the newly referenced keys.
//
// Same loading strategy as checks/authorize-modal.check.mjs: the REAL
// frontend modules under node:test, with minimal DOM globals installed
// BEFORE the dynamic import. No t.mock.module.

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const appPath = (rel) => pathToFileURL(resolve(PLUGIN_ROOT, "public", "app", rel)).href;

// ---------- minimal DOM / global fakes ----------
//
// Richer than the authorize-modal makeEl on exactly the axes this
// surface exercises: className is settable AND backed by the classList
// set (renderUsage toggles usage-hidden), and assigning textContent
// clears children like the real DOM (renderAlerts rebuilds the list
// with `body.textContent = ''` + appendChild).

function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    children: [],
    handlers: {},
    style: {},
    dataset: {},
    attrs: {},
    _text: "",
    hidden: false,
    disabled: false,
    checked: false,
    appendChild(c) { el.children.push(c); return c },
    addEventListener(ev, fn) {
      if (!el.handlers[ev]) el.handlers[ev] = [];
      el.handlers[ev].push(fn);
    },
    setAttribute(k, v) { el.attrs[k] = String(v) },
    getAttribute(k) { return el.attrs[k] ?? null },
    removeAttribute(k) { delete el.attrs[k] },
    contains() { return false },
    focus() {},
    querySelector(sel) {
      el._q = el._q || {};
      if (!el._q[sel]) el._q[sel] = makeEl(sel);
      return el._q[sel];
    },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    get className() { return [...classes].join(" ") },
    set textContent(v) { el._text = String(v); el.children.length = 0 },
    get textContent() { return el._text },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      toggle: (c, f) => {
        const on = f === undefined ? !classes.has(c) : !!f;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
  };
  return el;
}

const _els = {};

// Elements the assertions inspect directly. Everything else
// attachEvents touches is auto-vivified as a plain stub (the wiring
// under test only needs the element to exist).
const RICH_IDS = [
  // alerts surface (D1)
  "btn-alerts", "alerts-badge", "alerts-popover", "alerts-clear", "alerts-popover-body",
  // usage button (D2)
  "btn-usage", "usage-popover", "usage-value", "usage-popover-body",
  // appearance / theme (D3)
  "btn-appearance", "appearance-card", "appearance-card-theme", "appearance-value",
  "appearance-icon",
];

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  close() { this.closed = true }
  fire(name, data) {
    for (const fn of this.listeners.get(name) || []) fn({ data });
  }
}

const _store = new Map();

function installGlobals() {
  globalThis.window = {
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }), // → default theme "light"
    addEventListener() {},
  };
  globalThis.localStorage = {
    getItem: (k) => (_store.has(k) ? _store.get(k) : null),
    setItem: (k, v) => _store.set(k, String(v)),
    removeItem: (k) => _store.delete(k),
  };
  globalThis.EventSource = FakeEventSource;
  globalThis.document = {
    documentElement: makeEl("html"),
    body: makeEl("body"),
    // Auto-vivify: attachEvents binds ~40 ids; only the ones we assert
    // on need the rich stubs pre-registered above.
    getElementById: (id) => _els[id] || (_els[id] = makeEl(id)),
    createElement: (tag) => makeEl(tag),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: { onLine: true, clipboard: { writeText: async () => {} } },
      configurable: true, writable: true,
    });
  } catch {}
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
}

// ---------- SUT handles ----------

let stateMod, renderMod, eventsMod, i18nMod, aes;

function fire(frame) {
  // The alerts channel uses default `message` events (the server's 30s
  // heartbeat is a NAMED event and never reaches onmessage).
  assert.ok(aes && typeof aes.onmessage === "function", "alerts EventSource must be connected");
  aes.onmessage({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
}

function click(id, target) {
  const el = _els[id];
  assert.ok(el && el.handlers.click && el.handlers.click.length > 0, `${id} must have a click handler bound`);
  for (const fn of el.handlers.click) fn({ stopPropagation() {}, target: target || el });
}

before(async (t) => {
  installGlobals();
  for (const id of RICH_IDS) _els[id] = makeEl(id);
  // Match the static markup's initial states.
  _els["alerts-popover"].hidden = true;
  _els["alerts-badge"].hidden = true;
  _els["appearance-card"].hidden = true;
  _els["usage-popover"].hidden = true;

  stateMod = await import(appPath("state.js"));
  renderMod = await import(appPath("render.js"));
  eventsMod = await import(appPath("events.js"));
  i18nMod = await import(appPath("i18n.js"));
  eventsMod.attachEvents(); // binds the bell + appearance + usage buttons ONCE

  // connect() schedules a 2s /api/refresh setTimeout + a 60s interval
  // with REAL timers — swap in mock timers just for the call (same
  // dance as authorize-modal.check.mjs).
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    stateMod.connect();
  } finally {
    t.mock.timers.reset();
  }
  aes = stateMod.alertsEs;
});

beforeEach(() => {
  stateMod.clearAlerts();
  _els["alerts-popover"].hidden = true;
  _els["alerts-badge"].hidden = true;
  _els["btn-alerts"].attrs["aria-expanded"] = "false";
  _els["alerts-popover-body"].children.length = 0;
  _els["alerts-popover-body"]._text = "";
});

after(() => {
  // nothing scheduled survives (mock timers were reset); nothing else to clean
});

// ============================================================
// D1 — state.js alerts store driven by SSE frames
// ============================================================

describe("D1 alerts channel — connection + queue", () => {
  test("connect() opens an independent /api/alerts EventSource (token+cid suffix)", () => {
    assert.ok(aes instanceof FakeEventSource, "alerts must ride its own EventSource");
    assert.ok(aes.url.startsWith("/api/alerts"), `unexpected url ${aes.url}`);
    assert.ok(/cid=/.test(aes.url), "cid query must be present (per-client routing)");
    assert.notEqual(aes, stateMod.es, "must NOT reuse the state-stream EventSource");
  });

  test("snapshot frame replaces the list (newest first) and counts unseen ids as unread", () => {
    fire({ kind: "snapshot", alerts: [
      { id: "a-old", ts: 1, level: "error", msg: "old failure", src: "chat:send", count: 1 },
      { id: "a-new", ts: 2, level: "warn", msg: "new warning", src: "db", count: 1 },
    ] });
    const list = stateMod.getAlerts();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "a-new", "server sends oldest→newest; store must be newest-first");
    assert.equal(list[1].id, "a-old");
    assert.equal(stateMod.getAlertsUnread(), 2);
  });

  test("append frame unshifts, bumps unread, and a replayed append is deduped by id", () => {
    fire({ kind: "append", alert: { id: "b1", ts: 3, level: "error", msg: "spawn mcode ENOENT", src: "chat:send", count: 1 } });
    assert.equal(stateMod.getAlertsUnread(), 1);
    assert.equal(stateMod.getAlerts()[0].id, "b1");
    fire({ kind: "append", alert: { id: "b1", ts: 3, level: "error", msg: "spawn mcode ENOENT", src: "chat:send", count: 1 } });
    assert.equal(stateMod.getAlertsUnread(), 1, "SSE reconnect replay must not double-count");
    assert.equal(stateMod.getAlerts().length, 1);
  });

  test("snapshot replay after reconnect does not re-inflate the unread count", () => {
    fire({ kind: "append", alert: { id: "c1", ts: 4, level: "info", msg: "x", src: "system", count: 1 } });
    fire({ kind: "snapshot", alerts: [
      { id: "c1", ts: 4, level: "info", msg: "x", src: "system", count: 1 },
    ] });
    assert.equal(stateMod.getAlertsUnread(), 1, "already-seen id → fresh=0");
    assert.equal(stateMod.getAlerts().length, 1, "but the list is still the server truth");
  });

  test("update frame merges count/ts in place without touching unread", () => {
    fire({ kind: "append", alert: { id: "d1", ts: 5, level: "warn", msg: "sqlite locked", src: "db", count: 1 } });
    fire({ kind: "update", alert: { id: "d1", ts: 6, level: "warn", msg: "sqlite locked", src: "db", count: 4 } });
    const a = stateMod.getAlerts().find((x) => x.id === "d1");
    assert.equal(a.count, 4, "dedup merge (server 60s window) must surface ×count");
    assert.equal(a.ts, 6);
    assert.equal(stateMod.getAlertsUnread(), 1);
  });

  test("update for an unknown/cleared id is ignored; malformed frames never throw", () => {
    fire({ kind: "append", alert: { id: "e1", ts: 7, level: "info", msg: "keep", src: "system", count: 1 } });
    fire({ kind: "update", alert: { id: "no-such", ts: 7, level: "info", msg: "x", count: 2 } });
    fire("not json at all");
    fire("");
    fire({ kind: "append", alert: { nope: 1 } });      // no id → skipped
    fire({ kind: "unknown-kind", alert: { id: "z" } }); // unknown kind → skipped
    fire({ kind: "append" });                            // missing alert → skipped
    assert.equal(stateMod.getAlerts().length, 1);
    assert.equal(stateMod.getAlertsUnread(), 1);
  });

  test("local ring cap mirrors the server (100) — badge caps at 99+", () => {
    for (let i = 0; i < 101; i++) {
      fire({ kind: "append", alert: { id: `cap-${i}`, ts: 1000 + i, level: "info", msg: `m${i}`, src: "system", count: 1 } });
    }
    assert.equal(stateMod.getAlerts().length, 100, "ALERTS_MAX trim");
    assert.equal(stateMod.getAlerts()[0].id, "cap-100", "newest kept");
    assert.equal(stateMod.getAlertsUnread(), 101);
    assert.equal(_els["alerts-badge"].textContent, "99+", "badge saturates instead of overflowing");
  });

  test("malformed fields are coerced, never thrown: level whitelist + msg/src strings", () => {
    fire({ kind: "append", alert: { id: "f1", ts: "junk", level: "catastrophic", msg: 42, src: "", sessionId: 12345, count: "3" } });
    const a = stateMod.getAlerts()[0];
    assert.equal(a.level, "info", "unknown level → info");
    assert.equal(a.msg, "42");
    assert.equal(a.src, "system");
    assert.equal(a.sessionId, "12345");
    assert.equal(a.count, 3);
    assert.equal(a.ts, 0);
  });
});

// ============================================================
// D1 — badge + popover render + interactions
// ============================================================

describe("D1 alerts surface — badge, popover, mark-read, clear", () => {
  test("badge tracks unread (hidden at zero, count while > 0)", () => {
    assert.equal(_els["alerts-badge"].hidden, true);
    fire({ kind: "append", alert: { id: "g1", ts: 8, level: "error", msg: "boom", src: "chat:send", count: 1 } });
    assert.equal(_els["alerts-badge"].hidden, false);
    assert.equal(_els["alerts-badge"].textContent, "1");
  });

  test("bell click opens the popover, renders items, and marks everything read", () => {
    fire({ kind: "append", alert: { id: "h1", ts: 9, level: "error", msg: "first", src: "chat:send", count: 1 } });
    fire({ kind: "append", alert: { id: "h2", ts: 10, level: "warn", msg: "second", src: "db", sessionId: "mvs_abcdefgh1234567890", count: 2 } });
    click("btn-alerts");
    assert.equal(_els["alerts-popover"].hidden, false, "popover opens");
    assert.equal(_els["btn-alerts"].attrs["aria-expanded"], "true");
    assert.equal(stateMod.getAlertsUnread(), 0, "marking-read on open");
    assert.equal(_els["alerts-badge"].hidden, true, "badge drops");
    // list still shows everything, newest first, via DOM construction
    const body = _els["alerts-popover-body"];
    assert.equal(body.children.length, 2);
    const [first, second] = body.children;
    assert.equal(first.className, "alerts-item level-warn");
    assert.equal(first.children[1].children[0].textContent, "second");
    const meta = first.children[1].children[1].textContent;
    assert.match(meta, /^db · session mvs_abcdefgh… · ×2 · \d{2}:\d{2}$/);
    assert.equal(second.className, "alerts-item level-error");
    assert.match(second.children[1].children[1].textContent, /^chat:send · \d{2}:\d{2}$/,
      "second item meta: src + time (no session hint, no ×count)");
  });

  test("untrusted msg lands in textContent verbatim — no markup interpretation", () => {
    const evil = `<img src=x onerror=alert(1)> <script>document.alertsPwned=1</script>`;
    fire({ kind: "append", alert: { id: "x1", ts: 11, level: "error", msg: evil, src: "chat:send", count: 1 } });
    click("btn-alerts");
    const item = _els["alerts-popover-body"].children[0];
    assert.equal(item.children[1].children[0].textContent, evil);
    assert.equal(item.children[1].children[0].children.length, 0, "no child nodes — text only");
  });

  test("empty store renders the localized empty state", () => {
    click("btn-alerts");
    const body = _els["alerts-popover-body"];
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].className, "alerts-empty");
    assert.equal(body.children[0].textContent, "No alerts"); // en default dictionary
  });

  test("clear empties the list; the badge only returns for genuinely new alerts", () => {
    fire({ kind: "append", alert: { id: "i1", ts: 12, level: "info", msg: "x", src: "system", count: 1 } });
    click("btn-alerts"); // open + read
    click("alerts-clear");
    assert.equal(stateMod.getAlerts().length, 0);
    assert.equal(_els["alerts-popover-body"].children[0].className, "alerts-empty");
    assert.equal(stateMod.getAlertsUnread(), 0);
    // reconnect replay of the SAME alert: history may come back, but the
    // badge (the attention surface) must not re-inflate.
    fire({ kind: "snapshot", alerts: [
      { id: "i1", ts: 12, level: "info", msg: "x", src: "system", count: 1 },
    ] });
    assert.equal(stateMod.getAlertsUnread(), 0, "cleared id is still 'seen'");
    fire({ kind: "append", alert: { id: "i2", ts: 13, level: "error", msg: "y", src: "chat:send", count: 1 } });
    assert.equal(stateMod.getAlertsUnread(), 1, "a genuinely new alert re-arms the badge");
  });

  test("list is NOT rebuilt while the popover is closed (render storms are cheap)", () => {
    fire({ kind: "append", alert: { id: "j1", ts: 14, level: "info", msg: "while closed", src: "system", count: 1 } });
    assert.equal(_els["alerts-popover-body"].children.length, 0, "closed popover renders nothing");
    assert.equal(_els["alerts-badge"].textContent, "1", "but the badge still updates");
  });

  test("bell click toggles: a second click closes without clearing the list", () => {
    fire({ kind: "append", alert: { id: "k1", ts: 15, level: "info", msg: "x", src: "system", count: 1 } });
    click("btn-alerts");
    click("btn-alerts");
    assert.equal(_els["alerts-popover"].hidden, true);
    assert.equal(_els["btn-alerts"].attrs["aria-expanded"], "false");
    assert.equal(stateMod.getAlerts().length, 1, "closing is visual only");
  });
});

// ============================================================
// D3 — theme cycling through the appearance button + helpers
// ============================================================

describe("D3 appearance button — theme cycle + persistence", () => {
  test("applyTheme() writes the current theme onto document.documentElement", () => {
    i18nMod.applyTheme();
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "light", "no stored theme + matchMedia(false) → light");
    assert.equal(_els["appearance-value"].textContent, "Light");
    assert.equal(_els["appearance-card-theme"].checked, false, "card checkbox re-syncs");
  });

  test("toggleTheme() cycles light↔dark, persists to localStorage, re-syncs the checkbox", () => {
    i18nMod.toggleTheme();
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "dark");
    assert.equal(globalThis.localStorage.getItem("webui-theme"), "dark", "must persist across reloads");
    assert.equal(_els["appearance-value"].textContent, "Dark");
    assert.equal(_els["appearance-card-theme"].checked, true);
    i18nMod.toggleTheme();
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "light");
    assert.equal(globalThis.localStorage.getItem("webui-theme"), "light");
  });

  test("btn-appearance click cycles the theme AND opens the appearance card", () => {
    // fresh localStorage state → light
    globalThis.localStorage.removeItem("webui-theme");
    click("btn-appearance");
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "dark", "click must have a directly observable effect (the audit's probe)");
    assert.equal(globalThis.localStorage.getItem("webui-theme"), "dark");
    assert.equal(_els["appearance-card"].hidden, false, "card (quota master switch) stays reachable");
    assert.equal(_els["btn-appearance"].attrs["aria-expanded"], "true");
    click("btn-appearance");
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "light");
    assert.equal(_els["appearance-card"].hidden, true);
  });

  test("the card's own checkbox still toggles the theme (pre-existing path preserved)", () => {
    const cb = _els["appearance-card-theme"];
    assert.ok(cb.handlers.change && cb.handlers.change.length > 0, "checkbox change handler must stay bound");
    for (const fn of cb.handlers.change) fn({ target: { checked: true } });
    assert.equal(globalThis.document.documentElement.attrs["data-theme"], "dark");
    assert.equal(globalThis.localStorage.getItem("webui-theme"), "dark");
  });
});

// ============================================================
// D2 — usage button visibility gating (local vs remote)
// ============================================================

describe("D2 usage button — visible in local mode", () => {
  test("quotaEnabled=false + LOCAL body → no usage-hidden (button visible + clickable)", () => {
    globalThis.document.body.classList.remove("is-remote");
    stateMod.setState({ quotaEnabled: false });
    stateMod.renderUsage();
    assert.equal(_els["btn-usage"].classList.contains("usage-hidden"), false,
      "fresh local install must be able to reach the key configuration entry");
  });

  test("quotaEnabled=false + REMOTE body → usage-hidden kept (original design)", () => {
    globalThis.document.body.classList.add("is-remote");
    stateMod.setState({ quotaEnabled: false });
    stateMod.renderUsage();
    assert.equal(_els["btn-usage"].classList.contains("usage-hidden"), true);
    globalThis.document.body.classList.remove("is-remote");
  });

  test("quotaEnabled=true is visible in both modes", () => {
    stateMod.setState({ quotaEnabled: true });
    stateMod.renderUsage();
    assert.equal(_els["btn-usage"].classList.contains("usage-hidden"), false);
    globalThis.document.body.classList.add("is-remote");
    stateMod.renderUsage();
    assert.equal(_els["btn-usage"].classList.contains("usage-hidden"), false);
    globalThis.document.body.classList.remove("is-remote");
  });
});

// ============================================================
// render.js pure helpers
// ============================================================

describe("alerts render helpers (pure)", () => {
  test("formatAlertTime — HH:MM, zero-padded, junk → ''", () => {
    // Local-time rendering (matches the rest of the UI's time display),
    // so compute the expectation through Date the same way.
    const d = new Date(12345);
    const want = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    assert.equal(renderMod.formatAlertTime(12345), want);
    assert.match(renderMod.formatAlertTime(12345), /^\d{2}:\d{2}$/);
    assert.equal(renderMod.formatAlertTime("junk"), "");
    assert.equal(renderMod.formatAlertTime(undefined), "");
  });

  test("shortSessionHint truncates at 12 chars with an ellipsis", () => {
    assert.equal(renderMod.shortSessionHint("mvs_abcdefgh1234567890"), "mvs_abcdefgh…");
    assert.equal(renderMod.shortSessionHint("short-id"), "short-id");
    assert.equal(renderMod.shortSessionHint(""), "");
  });

  test("alertLevelLabel maps the three levels through i18n", () => {
    assert.equal(renderMod.alertLevelLabel("error"), "Error");
    assert.equal(renderMod.alertLevelLabel("warn"), "Warning");
    assert.equal(renderMod.alertLevelLabel("info"), "Info");
    assert.equal(renderMod.alertLevelLabel("nonsense"), "nonsense");
  });
});

// ============================================================
// Static source guards (CodeQL js/xss-through-dom + markup + i18n)
// ============================================================

describe("static source guards", () => {
  // v2 (2026-09-20 webui-manual-audit D1): normalize CRLF at read time —
  //   windows-latest checks out with git autocrlf, so every source file
  //   arrives with \r\n line endings and the slice() markers below (which
  //   embed a literal \n) never match, failing the guard on the ONLY real
  //   Windows CI we have. Normalizing to LF makes marker slicing checkout-
  //   agnostic: the sliced block is byte-identical to the LF-checkout run,
  //   so the innerHTML/regex assertions keep their exact semantics.
  const readSrc = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const RENDER_SRC = readSrc(resolve(PLUGIN_ROOT, "public", "app", "render.js"));
  const STATE_SRC = readSrc(resolve(PLUGIN_ROOT, "public", "app", "state.js"));
  const INDEX_SRC = readSrc(resolve(PLUGIN_ROOT, "public", "index.html"));
  const I18N_SRC = readSrc(resolve(PLUGIN_ROOT, "public", "app", "i18n.js"));

  function slice(src, startMarker, endMarker) {
    const s = src.indexOf(startMarker);
    assert.ok(s !== -1, `start marker not found: ${startMarker}`);
    const e = src.indexOf(endMarker, s);
    assert.ok(e !== -1, `end marker not found after start: ${endMarker}`);
    return src.slice(s, e + endMarker.length);
  }

  test("alerts surface in render.js is DOM-only — zero innerHTML (CodeQL)", () => {
    const block = slice(
      RENDER_SRC,
      "// v2 (2026-09-20 webui-manual-audit D1): anomaly-channel (alerts)\n// surface — begin alerts-surface",
      "// v2 (2026-09-20 webui-manual-audit D1): alerts surface — end alerts-surface",
    );
    assert.equal(/\.innerHTML\s*=/.test(block), false,
      "alert msg/src/sessionId are untrusted SSE wire data (server relays raw subprocess stderr)");
    assert.match(block, /createElement\(\s*['"]div['"]\s*\)/);
    assert.match(block, /createElement\(\s*['"]span['"]\s*\)/);
    assert.match(block, /\.textContent\s*=/);
  });

  test("alerts store in state.js never touches innerHTML either", () => {
    const block = slice(
      STATE_SRC,
      "// v2 (2026-09-20 webui-manual-audit D1): anomaly-channel (alerts) store",
      "// v2 (2026-09-20 webui-manual-audit D1): the alerts SSE connection.",
    );
    assert.equal(/\.innerHTML\s*=/.test(block), false);
  });

  test("index.html carries the bell + popover mount (btn-alerts / badge / clear)", () => {
    assert.match(INDEX_SRC, /id="btn-alerts"/);
    assert.match(INDEX_SRC, /id="alerts-badge"/);
    assert.match(INDEX_SRC, /id="alerts-popover"/);
    assert.match(INDEX_SRC, /id="alerts-clear"/);
    assert.match(INDEX_SRC, /id="alerts-popover-body"/);
  });

  test("the alerts channel is a SEPARATE EventSource, not the state stream", () => {
    const block = slice(STATE_SRC, "if (!alertsEs) {", "// v0.5.ak: user footer");
    assert.ok(block.includes("new EventSource('/api/alerts'"), "must subscribe to /api/alerts");
    assert.ok(STATE_SRC.includes("const url = '/api/events'"), "state stream unchanged");
  });

  test("i18n completeness — alerts_* keys exist in BOTH zh and en", () => {
    const keys = ["alerts_title", "alerts_empty", "alerts_clear", "alerts_session",
      "alerts_level_info", "alerts_level_warn", "alerts_level_error"];
    for (const k of keys) {
      const n = (I18N_SRC.match(new RegExp(`\\b${k}\\s*:`, "g")) || []).length;
      assert.ok(n >= 2, `i18n key ${k} must be in both dictionaries (found ${n})`);
    }
  });

  test("i18n completeness — every previously-missing referenced key now exists in BOTH dictionaries", () => {
    // D4: live audit observed raw keys leaking in the workspace picker.
    // The full referenced-vs-defined audit lives in this check's sibling
    // coverage; here we pin the exact keys the audit found plus the
    // systematic sweep result (mode_read was also unreferenced-free).
    const keys = ["workspace_sync_tui", "workspace_recents_title", "workspace_browse",
      "workspace_loading", "mode_read"];
    for (const k of keys) {
      const n = (I18N_SRC.match(new RegExp(`\\b${k}\\s*:`, "g")) || []).length;
      assert.ok(n >= 2, `i18n key ${k} must be in both dictionaries (found ${n})`);
    }
  });
});
