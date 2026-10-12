/**
 * A real browser check for the panel, with no dependencies.
 *
 * The panel's own tests run the client modules against a DOM stub that creates
 * elements on demand — which, as `panel-dom-contract.test.mjs` records, means a
 * missing element is invisible to every behavioural test. That check reads the
 * shipped HTML, so the id contract is covered; nothing covers whether the page
 * actually *runs* in a browser.
 *
 * So this drives a real Chrome over the DevTools protocol. Node 22 ships a
 * `WebSocket` client, so the whole thing is `node:` built-ins plus the browser
 * binary — no Playwright, no Puppeteer, nothing added to the package.
 *
 * Not part of `node --test`: it needs a browser on the machine, and the suite has
 * to stay runnable everywhere. Run it by hand when the panel changed.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openStore } from '../server/store.mjs';
import { findChrome } from './chrome-paths.mjs';
import { createStudio } from '../server/http.mjs';
import { resolveDataDir, resolveHomeDir } from '../server/config.mjs';
import { firstRenderBatch, offeredCalls, packStreamRows } from '../web/js/rows.js';

/** Poll a DevTools HTTP endpoint until it answers, or give up. */
async function waitForJson(url, { attempts = 60, gapMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  throw new Error(`devtools never came up: ${url}`);
}

/** One DevTools session: send, await the matching id, surface events. */
function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const consoleErrors = [];
  let nextId = 1;
  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      consoleErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params?.exceptionDetails?.exception?.description
        ?? message.params?.exceptionDetails?.text ?? 'unknown exception');
    }
  });
  const send = (method, params = {}, sessionId) => open.then(() => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  }));
  return { send, consoleErrors, close: () => socket.close() };
}

const evaluate = async (cdp, sessionId, expression) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};

/**
 * The port Chrome picked, written to a file it creates once it is listening.
 *
 * Polled rather than read once: the file appears a beat after the process starts, and
 * a single read that loses that race fails the whole check for a reason that has
 * nothing to do with the panel.
 */
async function waitForPort(profile, { attempts = 80, gapMs = 250 } = {}) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < attempts; i += 1) {
    try {
      const first = (await readFile(file, 'utf8')).split('\n')[0];
      if (first?.trim()) return Number(first.trim());
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  throw new Error(`chrome never wrote DevToolsActivePort in ${profile}`);
}

// The same resolver the Plugin itself uses, rather than `process.env.HOME`. Windows
// commonly sets only USERPROFILE, and the bespoke version fell through to `/tmp` — a
// path that does not exist there, so the store came up empty and every check below ran
// against nothing. That is the worse of the two failures: not an error, but a green run
// over an empty machine. Sharing the resolver also means this reads the same data
// directory the Plugin does, on every platform.
const dataDir = resolveDataDir(process.env);
const homeDir = resolveHomeDir(process.env);
const store = openStore({ dataDir });
const studio = createStudio({ store, homeDir, redactRoots: [store.dataDir] });
const panel = await studio.start({});
const url = panel.url;

const chromeBinary = findChrome();
if (!chromeBinary.found) {
  console.error(`no Chrome/Chromium/Edge found for ${process.platform}; looked in:\n  ${chromeBinary.candidates.join('\n  ') || '(no candidate for this platform)'}`);
  console.error('set CHROME_PATH to the binary to run this check; nothing was verified');
  process.exit(1);
}

const profile = await mkdtemp(path.join(tmpdir(), 'studio-cdp-'));
const browser = spawn(chromeBinary.found, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  const port = await waitForPort(profile);
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = connect(version.webSocketDebuggerUrl);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);

  // Boot is a chain of awaits; poll the flag the entry point sets when it finishes.
  let state = 'loading';
  for (let i = 0; i < 80 && state === 'loading'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = await evaluate(cdp, sessionId, "document.body.dataset.state || ''");
  }

  const report = await evaluate(cdp, sessionId, `JSON.stringify({
    state: document.body.dataset.state,
    banner: (document.getElementById('banner')?.textContent || '').trim(),
    notice: (document.getElementById('session-truncation')?.textContent || '').trim(),
    noticeHidden: document.getElementById('session-truncation')?.hidden,
    groups: document.querySelectorAll('#session-groups *').length,
    groupsHtml: (document.getElementById('session-groups')?.innerHTML || '').slice(0, 160),
    agents: document.querySelectorAll('#agent-select option').length,
    title: document.getElementById('source-line')?.textContent || '',
  })`);
  const page = JSON.parse(report);

  console.log(`\nurl: ${url}\npage: ${JSON.stringify(page, null, 2)}\n`);
  check(page.state === 'ready', 'the panel reaches its ready state', `state=${page.state}`);
  check(page.groups > 0, 'the sidebar renders session groups', `${page.groups} nodes`);
  check(page.agents > 1, 'the agent filter is populated', `${page.agents} options`);
  check(page.noticeHidden === false, 'the truncation notice is shown', `hidden=${page.noticeHidden}`);
  check(/共\s*\d+/.test(page.notice), 'the notice states the whole-machine count', page.notice);
  check(/显示最新的\s*\d+/.test(page.notice), 'the notice states how many are listed', page.notice);

  /* ------------------------------------ the reader's path, not just first paint -- */

  // First paint is the easy half. Everything below drives the panel the way a person
  // does — click a session, ask a question in the search box, turn on the text — and
  // every one of those paths has changed during this work without a browser to run it in.
  const snapshot = async (expression) => JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify(${expression})`));

  /**
   * Poll the page until `expression` yields a truthy value, then go on.
   *
   * The five steps below used to sleep a fixed 1.2–1.5 s and then assert, which is a
   * guess dressed as a wait: it passes when the machine is quiet and reports a failure
   * when it is not. That is backwards for a check whose whole job is to be the evidence.
   * Running this file straight after fourteen mutation sweeps — each one spawning node
   * test processes — produced `exit 1` on a walk that passes three times out of three
   * when the machine is idle. A gate that cries wolf on a healthy tree is not evidence.
   *
   * So the wait is on the condition, and the budget is only for a page that never gets
   * there: giving up hands the assertion whatever it finds, which is what a reader wants
   * to see — the state that was actually reached — not a fabricated pass.
   */
  const waitFor = async (expression, { timeoutMs = 20000, gapMs = 150 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify(${expression})`));
      const ready = typeof value === 'object' && value !== null ? (value.ready ?? false) : Boolean(value);
      if (ready) return value;
      if (Date.now() >= deadline) return value;
      await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
  };

  const afterBoot = await snapshot(`({
    selected: document.querySelectorAll('.session-item[aria-current="true"]').length,
    streamRows: document.querySelectorAll('#stream .row, #stream [class*="row"]').length,
    streamText: (document.getElementById('stream')?.textContent || '').trim().slice(0, 120),
    heading: (document.getElementById('main-title')?.textContent
      || document.querySelector('main header')?.textContent || '').trim().slice(0, 80),
  })`);
  check(afterBoot.selected === 1, 'a session is selected after boot', `${afterBoot.selected} marked`);
  check(afterBoot.streamRows > 0, 'the trajectory stream rendered rows', `${afterBoot.streamRows} rows`);
  check(afterBoot.streamText.length > 0, 'the stream is not blank', afterBoot.streamText);

  // Click a different session and wait for the detail pane to catch up.
  const before = await evaluate(cdp, sessionId, "document.querySelector('.session-item[aria-current=\"true\"]')?.title || ''");
  await evaluate(cdp, sessionId, `(() => {
    const items = [...document.querySelectorAll('.session-item')].filter((el) => el.title !== ${JSON.stringify(before)});
    items[0]?.click();
    return items.length;
  })()`);
  await waitFor(`({ ready: (document.querySelector('.session-item[aria-current="true"]')?.title || '') !== ${JSON.stringify(before)} })`);
  const afterClick = await snapshot(`({
    selected: document.querySelectorAll('.session-item[aria-current="true"]').length,
    title: document.querySelector('.session-item[aria-current="true"]')?.title || '',
  })`);
  check(afterClick.selected === 1, 'selecting another session keeps exactly one marked', `${afterClick.selected}`);
  check(afterClick.title !== before, 'the selection actually moved',
    `${JSON.stringify(before.slice(0, 40))} -> ${JSON.stringify(afterClick.title.slice(0, 40))}`);

  // The search box: a query, Enter, and the list it replaces.
  //
  // The term is derived from data the server really holds, because a walkthrough
  // cannot tell "the search is broken" from "the term is in no data" — and the first
  // two attempts at this step proved it. A hard-coded "trajectory" matched only
  // because the query encoding produced cross-column false positives, so the check
  // was asserting the very bug it was meant to catch. Scraping a word out of a
  // rendered row failed the other way: the row's text is title, agent, branch,
  // workspace and age joined together, so the "word" was in no field of any session.
  //
  // So it is taken here, from the same store the panel is reading, out of a field
  // the index is known to carry. It still exercises phrase matching and case folding,
  // because the index holds the field lowercased and the term is a slice of it.
  const searchTerm = (() => {
    for (const session of store.listSessions({ limit: 40 })) {
      const dir = String(session.workspaceDir || '');
      const segment = dir.split(/[\\/]/).find((part) => part.length >= 5 && /[a-z]/i.test(part));
      if (segment) return segment;
      const word = String(session.title || '').trim().split(/\s+/).find((w) => w.length >= 5);
      if (word) return word;
    }
    return '';
  })();
  check(searchTerm.length >= 5,
    'a search term could be read from the same data the panel serves', JSON.stringify(searchTerm));
  await evaluate(cdp, sessionId, `(() => {
    const box = document.getElementById('search');
    box.value = ${JSON.stringify(searchTerm)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await waitFor(`({ ready: document.getElementById('search')?.value === ${JSON.stringify(searchTerm)} && document.querySelectorAll('.session-item').length > 0 })`);
  const afterSearch = await snapshot(`({
    banner: (document.getElementById('banner')?.textContent || '').trim(),
    noticeHidden: document.getElementById('session-truncation')?.hidden,
    items: document.querySelectorAll('.session-item').length,
    boxValue: document.getElementById('search')?.value,
    groupText: (document.getElementById('session-groups')?.textContent || '').trim().slice(0, 120),
  })`);
  check(afterSearch.items > 0, 'a search renders results', `${afterSearch.items} items for ${JSON.stringify(searchTerm)}`);
  check(afterSearch.noticeHidden === true,
    'the browsing notice is retired once a search replaces the list', `hidden=${afterSearch.noticeHidden}`);
  // The "your page is a subset of the matches" notice is only owed when the page *is*
  // a subset. Asserting it unconditionally demanded a banner that a complete result
  // set does not produce, and the banner element is shared with the timeline warning,
  // so it also failed for a message this step never raised.
  const expected = store.searchSessions({ query: searchTerm, limit: 100 });
  if (expected.total > afterSearch.items) {
    check(/匹配|显示|仅/u.test(afterSearch.banner),
      'a truncated search says so', `total=${expected.total} shown=${afterSearch.items} banner=${afterSearch.banner}`);
  } else {
    check(afterSearch.items === expected.total,
      'a complete search shows every match',
      `total=${expected.total} shown=${afterSearch.items}`);
  }

  // A query that matches nothing must say so rather than leaving the old list up.
  await evaluate(cdp, sessionId, `(() => {
    const box = document.getElementById('search');
    box.value = 'zzz-no-such-session-title-zzz';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  // Wait for the *miss* to be rendered, not for a fixed span: an empty result set is
  // reached by clearing the list and writing the banner, and both have to have happened
  // before "it says so" means anything.
  await waitFor(`({ ready: /没有匹配/.test(document.getElementById('banner')?.textContent || '') })`);
  const afterMiss = await snapshot(`({
    banner: (document.getElementById('banner')?.textContent || '').trim(),
    items: document.querySelectorAll('.session-item').length,
  })`);
  check(/没有匹配/.test(afterMiss.banner), 'a search that matched nothing says so', afterMiss.banner);

  // A background tool call's captured output, fetched from the panel.
  //
  // `/api/task-output` had been served, capability-gated, redacted and tested since the
  // panel first shipped, and nothing on the page called it: the summary tab showed the
  // task's id and stopped there. This is the step that would have caught that.
  //
  // The session is chosen rather than taken from the boot selection. Boot picks the most
  // recently updated session, which on a machine where a sub-agent is still running is a
  // different session entirely — and one whose tool calls were never recorded as
  // background tasks, so they carry no task id and there is nothing to fetch. That is a
  // property of the machine, not of the feature, so the check asks the store for a
  // session that really owns linked background tasks.
  //
  // "Really owns them" turned out to be two questions, and answering only the first gave
  // a check that was flaky and then consistently wrong.
  //
  // It used to ask for the session whose linked task was written *last* — not a subject
  // but a snapshot of whoever was busy at that instant, including the session this very
  // check runs in, since running it is what writes those tasks. Six runs picked two
  // sessions, rendered 669 rows against 81 tool rows, and passed or failed accordingly.
  //
  // Ordering by how many linked tasks a session owns fixed the moving target and made it
  // fail *every* time, which is the better failure: the session with 14,984 linked tasks
  // has none of them on its first page. The task index is bounded, so on a long session
  // the oldest records — the ones the panel loads first — carry no task id at all, and
  // no amount of clicking finds a button that is not there. Asking "which session has the
  // most linked tasks" and "which session *shows* one" are different questions.
  //
  // So the second is asked of the store, over the panel's own data path, rather than
  // reimplemented here: the candidates are tried in a fixed order and the first whose
  // first page carries an output-bearing call wins.
  //
  // "First page" was still the wrong unit, and this failed consistently for three runs
  // before it was looked at properly. The panel fetches 200 records but paints at most
  // `STREAM_PAGE` stream rows — a record is a row, and each of its tool calls is
  // another. A page of 200 records holding 181 calls packs to 381 rows, and the first
  // 150 are all the reader ever sees without asking for more. On the session chosen that
  // way the first output-bearing call sat at row 327, so the panel rendered 69 tool rows
  // and offered the button on none of them. The store said 27 of 181 calls were
  // reachable; not one of the 27 was on the screen.
  //
  // The row arithmetic now comes from `web/js/rows.js` — the same module `loadEvents`
  // packs with — so this asks what the panel will paint rather than what the store
  // holds. That is the whole difference: the question is about the first screen, and a
  // second copy of the bounds would drift back into exactly this failure.
  const candidates = store.db.prepare(`
    SELECT owner_session_id AS id, COUNT(*) AS linked FROM local_runtime_background_tasks
    WHERE json_extract(record_json, '$.toolCallId') IS NOT NULL
      AND json_extract(record_json, '$.outputRef.uri') IS NOT NULL
      AND updated_at_ms < ?
    GROUP BY owner_session_id
    ORDER BY linked DESC, owner_session_id ASC
    LIMIT 12
  `).all(Date.now() - 120_000);
  let outputTarget = null;
  for (const candidate of candidates) {
    const page = store.getEvents({ sessionId: candidate.id, offset: 0, limit: 200, detailLevel: 'summary' });
    const calls = (page.events ?? []).flatMap((event) => event.toolCalls ?? []);
    const usable = calls.filter((call) => call.taskId || call.hasOutput).length;
    // Painted on the first screen, not merely present in the page.
    const offered = offeredCalls(firstRenderBatch(packStreamRows(page.events ?? [])));
    const painted = offered.length;
    // The **ids** of those rows, not just how many. The walkthrough below needs to click a
    // row it already knows must offer its output, and "click every rendered row and read
    // the inspector" is how this check became a coin flip — see the note there.
    const ids = offered.map((row) => row.call.id).filter(Boolean);
    if (painted > 0) {
      outputTarget = { ...candidate, calls: calls.length, usable, painted, ids };
      break;
    }
    outputTarget ??= { ...candidate, calls: calls.length, usable, painted, ids };
  }
  const outputSessionTitle = outputTarget
    ? (store.getSession(outputTarget.id)?.title ?? null)
    : null;
  check(Boolean(outputSessionTitle),
    'a session with linked background tasks could be named for the output walkthrough',
    outputTarget
      ? `${outputSessionTitle ?? '(untitled)'} — ${outputTarget.painted} of ${outputTarget.calls} calls on its first screen carry captured output (${outputTarget.usable} within the fetched page)`
      : 'none: no task on this machine links a tool call to captured output');

  if (outputSessionTitle) {
  // Last in the walkthrough, so nothing above depends on the state it leaves behind.
  //
  // The session is found through the search box rather than by scrolling the sidebar:
  // the sidebar groups by workspace and restores a *partial* collapse state from
  // storage, so a named session may not be on screen, and the "collapse all" control is
  // an involution between fully-collapsed and fully-expanded — pressing it cannot put a
  // partial state back.
    await evaluate(cdp, sessionId, `(() => {
      const box = document.getElementById('search');
      box.value = ${JSON.stringify(outputSessionTitle)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await waitFor(`({ ready: [...document.querySelectorAll('.session-item')].some((node) => node.title.startsWith(${JSON.stringify(outputSessionTitle)})) })`);
    const selected = JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify((() => {
      const wanted = ${JSON.stringify(outputSessionTitle)};
      const item = [...document.querySelectorAll('.session-item')].find((node) => node.title.startsWith(wanted));
      if (!item) return { clicked: false, items: document.querySelectorAll('.session-item').length };
      item.click();
      return { clicked: true, items: document.querySelectorAll('.session-item').length };
    })())`));
    check(selected.clicked,
      'that session is reachable from the sidebar',
      selected.clicked ? '' : `${outputSessionTitle} is not among ${selected.items} listed sessions`);
    // Selecting a session fetches its records, and the session the store named is the
    // busiest one on the machine — so "clicked" is not "loaded". Waiting a fixed 1.5 s
    // scanned the previous session's rows and reported them as this one's.
    let loaded = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      loaded = JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify({
        title: document.querySelector('.session-item[aria-current="true"]')?.title || '',
        toolRows: document.querySelectorAll('[data-tool-call-id]').length,
      })`));
      if (loaded.title.startsWith(outputSessionTitle) && loaded.toolRows > 0) break;
    }
    check(loaded.title.startsWith(outputSessionTitle),
      'the panel is showing that session', loaded.title.slice(0, 60));

    // Click one row this file already **knows** must offer its output, and wait for the
    // inspector to say so.
    //
    // The previous version walked every rendered row and read the inspector immediately
    // after each click. That is a coin flip, and it was observed failing: the click handler
    // marks the selected row synchronously but **fetches** the task output asynchronously,
    // so the read that follows a click is the *previous* row's answer. Under load — this
    // failed on the run straight after a full mutation sweep — every read was stale and the
    // check reported "no row". It could just as easily report a **pass** for a row it never
    // verified, by reading the preceding row's button.
    //
    // So: the row is chosen from the same live data that picked the session, and the read
    // waits. Clicking only rows that must work removes the dependence on which rows happen
    // to be painted, and waiting removes the dependence on how fast the machine is.
    // The expression returns a **promise of an object**, not a string: `evaluate` is called with
    // `awaitPromise: true` and `returnByValue: true`, so Chrome awaits the IIFE and
    // serialises what it resolved to. Wrapping it in `JSON.stringify` first — the form every
    // other probe in this file uses — serialises the *Promise* instead, which has no own
    // enumerable properties, so the call returns `{}` and every field reads as `undefined`.
    // The other probes can use that form because their IIFEs are synchronous.
    const openedOutput = await evaluate(cdp, sessionId, `(async () => {
      const wanted = ${JSON.stringify(outputTarget.ids ?? [])};
      const rendered = document.querySelectorAll('[data-tool-call-id]').length;
      const buttonOffers = () => [...document.querySelectorAll('#inspector button')]
        .some((node) => (node.textContent || '').includes('查看任务输出'));
      // **One budget for the whole search**, not a deadline per row. A deadline per row
      // makes a genuine failure take minutes — this session's first screen carries dozens
      // of output-bearing rows, so 8 s each is several minutes of waiting to report one
      // word. A check that slow is a check that gets skipped, and this one exists precisely
      // to be run after a long sweep when nobody is watching.
      const budget = Date.now() + 6000;
      let clicked = null;
      for (const id of wanted) {
        if (Date.now() > budget) break;
        const row = document.querySelector('[data-tool-call-id="' + CSS.escape(String(id)) + '"]');
        if (!row) continue;   // not painted; skipping costs nothing
        row.click();
        clicked = id;
        while (!buttonOffers() && Date.now() < budget) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (buttonOffers()) return { found: true, rows: rendered, clicked: id };
      }
      return { found: false, rows: rendered, wanted: wanted.length, clicked };
    })()`);
    check(openedOutput.found,
      'a background tool call offers its captured output',
      openedOutput.found
        ? `offered by the row for call ${openedOutput.clicked}, out of ${openedOutput.rows} rendered tool rows`
        : `no button after waiting on ${openedOutput.wanted} row(s) that carry output, among ${openedOutput.rows} rendered tool rows`);

    if (openedOutput.found) {
      // Which button was clicked, and what the inspector held before and after. A failure
      // that can only say `(empty)` is not evidence — it is the same one word whether the
      // click missed, the read 404'd, or the panel rendered the text somewhere this file
      // does not look. The inspector's own text is what distinguishes those.
      const clicked = JSON.parse(await evaluate(cdp, sessionId, `JSON.stringify((() => {
        const button = [...document.querySelectorAll('#inspector button')]
          .find((node) => (node.textContent || '').includes('查看任务输出'));
        if (!button) return { clicked: false, buttons: [...document.querySelectorAll('#inspector button')].map((n) => (n.textContent || '').trim()) };
        button.click();
        return { clicked: true, label: (button.textContent || '').trim() };
      })())`));
      check(clicked.clicked, 'the captured-output button could be clicked',
        clicked.clicked ? clicked.label : `inspector holds: ${JSON.stringify(clicked.buttons)}`);
      // The fetch is async and its result lands in `#inspector pre`; waiting on that
      // element is what separates "the button worked" from "the output arrived".
      await waitFor(`({ ready: [...document.querySelectorAll('#inspector pre')].some((node) => (node.textContent || '').trim().length > 0) })`);
      const afterOutput = await snapshot(`({
        text: ([...document.querySelectorAll('#inspector pre')]
          .map((node) => node.textContent || '')
          .filter(Boolean)
          .join('\\n')).trim(),
        inspector: (document.getElementById('inspector')?.textContent || '').trim().slice(0, 160),
        pres: document.querySelectorAll('#inspector pre').length,
      })`);
      check(afterOutput.text.length > 0,
        'the panel reads the captured output',
        afterOutput.text.slice(0, 90)
          || `no text in ${afterOutput.pres} <pre>; inspector said: ${JSON.stringify(afterOutput.inspector)}`);
      check(!/^读取失败/u.test(afterOutput.text),
        'the captured-output read did not fail', afterOutput.text.slice(0, 90) || '(empty)');
      // "This task produced nothing" is an answer, and a different one from a refusal.
      // Asserting only that something appeared would pass on an error message too.
      check(!/没有捕获输出/u.test(afterOutput.text),
        'a task with output on disk is not reported as having none', afterOutput.text.slice(0, 90));
    }
  }

  check(cdp.consoleErrors.length === 0, 'no console errors after the whole walk', cdp.consoleErrors.join(' | '));

  cdp.close();
} finally {
  browser.kill();
  await studio.stop();
  store.close();
  // Chrome flushes its profile on the way out, so removing the directory the instant
  // the signal lands races it and fails with ENOTEMPTY — a cleanup error reported as a
  // check failure. Wait for the exit, and treat a leftover as a leftover: the profile is
  // a scratch directory in the system temp, not an artifact anyone is waiting on.
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    .catch((error) => console.log(`note: left the scratch Chrome profile at ${profile} (${error.code ?? error.message})`));
}

process.exit(failures === 0 ? 0 : 1);