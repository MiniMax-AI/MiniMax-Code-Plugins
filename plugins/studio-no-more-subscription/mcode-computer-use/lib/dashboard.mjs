// dashboard.mjs
//
// Localhost-only HTTP server that serves the Agent Activity Dashboard.
// Uses SSE for live updates and a vanilla HTML/JS frontend — no
// external dependencies, no build step.

import { createServer } from 'node:http';
import { hostname } from 'node:os';

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>mcode-computer-use — Activity Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f1115;
      color: #e8eaed;
      font-size: 13px;
    }
    header {
      padding: 12px 20px;
      background: #1a1d23;
      border-bottom: 1px solid #2c3038;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { margin: 0; font-size: 15px; font-weight: 600; }
    header .meta { color: #9aa0a6; font-size: 11px; }
    .grid {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1px;
      background: #2c3038;
      height: calc(100vh - 49px);
    }
    .panel {
      background: #0f1115;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .panel h2 {
      margin: 0;
      padding: 10px 16px;
      font-size: 12px;
      font-weight: 600;
      color: #9aa0a6;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 1px solid #2c3038;
    }
    .panel .body { flex: 1; overflow: auto; padding: 12px 16px; }
    .left { display: flex; flex-direction: column; }
    .left .screen-panel { flex: 1.4; }
    .left .task-panel { flex: 1; }
    .right { display: flex; flex-direction: column; }
    .right .log-panel { flex: 2; }
    .right .perms-panel { flex: 1; }
    #screen-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      image-rendering: auto;
      background: #000;
      display: block;
      margin: auto;
    }
    .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #5f6368;
      font-style: italic;
    }
    #current-task {
      white-space: pre-wrap;
      line-height: 1.5;
    }
    #current-task .empty { color: #5f6368; font-style: italic; }
    .meta-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 8px; }
    .meta-grid .k { color: #9aa0a6; }
    .meta-grid .v { color: #e8eaed; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; }
    .progress {
      height: 4px;
      background: #2c3038;
      border-radius: 2px;
      overflow: hidden;
      margin: 4px 0 12px;
    }
    .progress .bar {
      height: 100%;
      background: #4d9fff;
      transition: width 0.3s;
    }
    #log {
      list-style: none;
      padding: 0;
      margin: 0;
      font-family: ui-monospace, "SF Mono", monospace;
      font-size: 11.5px;
    }
    #log li {
      padding: 4px 0;
      border-bottom: 1px solid #1a1d23;
      display: grid;
      grid-template-columns: 70px 130px 1fr;
      gap: 10px;
    }
    #log .ts { color: #5f6368; }
    #log .tool { color: #4d9fff; }
    #log .tool.error { color: #f28b82; }
    #log .summary { color: #9aa0a6; }
    .perm {
      padding: 10px 12px;
      border: 1px solid #2c3038;
      border-radius: 6px;
      margin-bottom: 10px;
      background: #1a1d23;
    }
    .perm .title { font-weight: 600; margin-bottom: 4px; color: #fbbc04; }
    .perm .body { color: #c4c7c5; margin-bottom: 8px; line-height: 1.4; }
    .perm .btns { display: flex; gap: 8px; }
    .perm button {
      padding: 6px 14px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }
    .perm button.ok { background: #4d9fff; color: white; }
    .perm button.no { background: #2c3038; color: #e8eaed; }
    .perm.resolved { opacity: 0.5; }
    .empty-state { color: #5f6368; font-style: italic; }
    .summary-flash {
      position: fixed;
      top: 60px;
      right: 20px;
      background: #fbbc04;
      color: #1a1d23;
      padding: 8px 14px;
      border-radius: 6px;
      font-weight: 600;
      animation: slide-in 0.3s ease-out, fade-out 0.5s ease-in 2.5s forwards;
    }
    @keyframes slide-in { from { transform: translateX(120%); } to { transform: translateX(0); } }
    @keyframes fade-out { to { opacity: 0; transform: translateX(40px); } }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #34a853; margin-right: 6px; }
  </style>
</head>
<body>
  <header>
    <h1><span class="status-dot"></span>mcode-computer-use Activity</h1>
    <span class="meta" id="meta"></span>
  </header>
  <div class="grid">
    <div class="panel left">
      <div class="screen-panel panel">
        <h2>Live screen <span id="screen-meta" style="float:right; font-weight:400; text-transform:none; letter-spacing:0;"></span></h2>
        <div class="body" id="screen-wrap">
          <div class="placeholder">Waiting for first screenshot…</div>
        </div>
      </div>
      <div class="task-panel panel">
        <h2>Current task</h2>
        <div class="body">
          <div class="meta-grid">
            <span class="k">Turn</span>          <span class="v" id="turn">—</span>
            <span class="k">Until summary</span>  <span class="v" id="until-summary">—</span>
          </div>
          <div class="progress"><div class="bar" id="progress-bar" style="width:0%"></div></div>
          <div id="current-task"><span class="empty">No task announced yet.</span></div>
        </div>
      </div>
    </div>
    <div class="panel right">
      <div class="log-panel panel">
        <h2>Action log</h2>
        <div class="body">
          <ul id="log"></ul>
        </div>
      </div>
      <div class="perms-panel panel">
        <h2>Permissions</h2>
        <div class="body" id="perms">
          <div class="empty-state">No permission requests yet.</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const state = {
      screen: null,
      task: null,
      turn: 0,
      summaryEvery: 10,
      log: [],
      perms: [],
    };
    const $ = (s) => document.querySelector(s);
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }
    function fmtTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('en-US', { hour12: false });
    }
    function renderScreen() {
      const wrap = $('#screen-wrap');
      if (!state.screen) {
        wrap.innerHTML = '<div class="placeholder">Waiting for first screenshot…</div>';
        return;
      }
      wrap.innerHTML = '<img id="screen-img" src="data:image/png;base64,' + state.screen + '">';
      const m = $('#screen-meta');
      if (state.screenSize) {
        m.textContent = state.screenSize.w + '×' + state.screenSize.h +
          (state.screenSize.composite ? '  (composite)' : '  (noise-only)');
      }
    }
    function renderTask() {
      const t = $('#current-task');
      if (state.task) t.textContent = state.task;
      else t.innerHTML = '<span class="empty">No task announced yet.</span>';
      $('#turn').textContent = state.turn;
      const remaining = Math.max(0, state.summaryEvery - (state.turn % state.summaryEvery));
      $('#until-summary').textContent = remaining + ' turn' + (remaining !== 1 ? 's' : '');
      const pct = ((state.turn % state.summaryEvery) / state.summaryEvery) * 100;
      $('#progress-bar').style.width = pct + '%';
    }
    function renderLog() {
      const ul = $('#log');
      ul.innerHTML = state.log.map((e) => {
        const cls = e.kind === 'error' ? 'tool error' : 'tool';
        const summ = e.kind === 'summary' ? 'summary' : '';
        return '<li>'
          + '<span class="ts">' + fmtTime(e.ts) + '</span>'
          + '<span class="' + cls + '">' + escapeHtml(e.tool) + '</span>'
          + '<span class="summary">' + escapeHtml(e.summary || '') + '</span>'
          + '</li>';
      }).join('');
      ul.scrollTop = ul.scrollHeight;
    }
    function renderPerms() {
      const wrap = $('#perms');
      if (state.perms.length === 0) {
        wrap.innerHTML = '<div class="empty-state">No permission requests yet.</div>';
        return;
      }
      wrap.innerHTML = state.perms.map((p) => {
        const buttons = p.status === 'pending' ? (
          '<div class="btns">'
            + '<button class="ok" onclick="resolvePerm(\\'' + p.id + '\\', true)">Allow</button>'
            + '<button class="no" onclick="resolvePerm(\\'' + p.id + '\\', false)">Decline</button>'
          + '</div>'
        ) : (
          '<div class="btns"><span class="empty-state">' + p.status + '</span></div>'
        );
        return '<div class="perm ' + (p.status === 'pending' ? '' : 'resolved') + '" id="perm-' + p.id + '">'
          + '<div class="title">' + escapeHtml(p.title) + '</div>'
          + '<div class="body">' + escapeHtml(p.body) + '</div>'
          + buttons + '</div>';
      }).join('');
    }
    function resolvePerm(id, decision) {
      // POST to /permissions/:id with { decision }
      fetch('/permissions/' + encodeURIComponent(id), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ decision }),
      }).then((r) => r.json()).then(() => {
        const p = state.perms.find((x) => x.id === id);
        if (p) p.status = decision ? 'allowed' : 'declined';
        renderPerms();
      });
    }
    window.resolvePerm = resolvePerm;

    function flashSummary() {
      const f = document.createElement('div');
      f.className = 'summary-flash';
      f.textContent = 'Trajectory summary requested';
      document.body.appendChild(f);
      setTimeout(() => f.remove(), 3000);
    }

    function applyEvent(ev) {
      if (ev.type === 'screen') {
        state.screen = ev.data;
        state.screenSize = ev.meta || null;
        renderScreen();
      } else if (ev.type === 'task') {
        state.task = ev.text;
        if (ev.turn !== undefined) state.turn = ev.turn;
        if (ev.summaryEvery !== undefined) state.summaryEvery = ev.summaryEvery;
        renderTask();
      } else if (ev.type === 'tool') {
        state.log.unshift({ ts: Date.now(), tool: ev.tool, summary: ev.summary, kind: ev.kind });
        if (state.log.length > 200) state.log.length = 200;
        if (ev.turn !== undefined) state.turn = ev.turn;
        if (ev.summaryEvery !== undefined) state.summaryEvery = ev.summaryEvery;
        renderLog(); renderTask();
      } else if (ev.type === 'summary-flash') {
        flashSummary();
      } else if (ev.type === 'perm-request') {
        state.perms.push({
          id: ev.id, title: ev.title, body: ev.body, status: 'pending',
        });
        renderPerms();
      }
    }

    const es = new EventSource('/events');
    es.onmessage = (m) => {
      try { applyEvent(JSON.parse(m.data)); } catch (e) { console.error(e); }
    };
    es.onerror = () => {
      $('#meta').textContent = 'disconnected';
    };
  </script>
</body>
</html>
`;

export async function startDashboard({ host = '127.0.0.1', port = 0 } = {}) {
  // State and subscribers.
  const subs = new Set();
  const pendingPerms = new Map(); // id -> {resolve, reject, timer}
  const eventLog = []; // recent events for replay to new clients
  const MAX_LOG = 200;
  let currentTask = null;
  let currentScreen = null; // {data, meta}
  let currentTurn = 0;
  let currentSummaryEvery = 10;

  function broadcast(ev) {
    eventLog.push(ev);
    if (eventLog.length > MAX_LOG) eventLog.shift();
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of subs) {
      try { res.write(data); } catch {}
    }
  }

  function replay(res) {
    // Push the latest screen state.
    if (currentScreen) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'screen', data: currentScreen.data, meta: currentScreen.meta })}\n\n`);
      } catch {}
    }
    if (currentTask) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'task', text: currentTask.text, turn: currentTurn, summaryEvery: currentSummaryEvery })}\n\n`);
      } catch {}
    }
    // Replay recent events.
    for (const ev of eventLog) {
      try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
    }
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });
      subs.add(res);
      // Initial state flush
      try {
        res.write(`: connected\n\n`);
      } catch {}
      req.on('close', () => subs.delete(res));
      // Replay buffered state to new clients.
      replay(res);
      return;
    }
    if (req.method === 'POST' && req.url.startsWith('/permissions/')) {
      const id = decodeURIComponent(req.url.slice('/permissions/'.length));
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        const decision = !!parsed.decision;
        const pending = pendingPerms.get(id);
        if (pending) {
          pendingPerms.delete(id);
          pending.resolve(decision);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const url = `http://${host}:${addr.port}`;

  return {
    host,
    port: addr.port,
    url,
    hostname: hostname(),
    // Event pushers.
    pushScreen(pngBase64, meta = {}) {
      currentScreen = { data: pngBase64, meta };
      broadcast({ type: 'screen', data: pngBase64, meta });
    },
    pushTask({ text, turn, summaryEvery }) {
      currentTask = { text, turn, summaryEvery };
      if (turn !== undefined) currentTurn = turn;
      if (summaryEvery !== undefined) currentSummaryEvery = summaryEvery;
      broadcast({ type: 'task', text, turn, summaryEvery });
    },
    pushTool({ tool, summary, kind = 'info', turn, summaryEvery }) {
      if (turn !== undefined) currentTurn = turn;
      if (summaryEvery !== undefined) currentSummaryEvery = summaryEvery;
      broadcast({ type: 'tool', tool, summary, kind, turn, summaryEvery });
    },
    pushSummaryFlash() {
      broadcast({ type: 'summary-flash' });
    },
    // Permission request: returns a Promise<boolean> when user clicks Allow/Decline.
    async askPermission({ title, body, timeoutMs = 10 * 60 * 1000 }) {
      const id = `p${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      broadcast({ type: 'perm-request', id, title, body });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingPerms.delete(id);
          broadcast({ type: 'perm-update', id, status: 'timed_out' });
          resolve(false);
        }, timeoutMs);
        pendingPerms.set(id, {
          resolve: (decision) => { clearTimeout(timer); resolve(decision); },
          reject,
        });
      });
    },
    async close() {
      for (const res of subs) try { res.end(); } catch {}
      subs.clear();
      await new Promise((r) => server.close(r));
    },
  };
}
