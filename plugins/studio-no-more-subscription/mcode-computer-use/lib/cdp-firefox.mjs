// cdp-firefox.mjs
//
// Firefox backend for the computer-use plugin.
//
// Design: runs PRIVATELY with the agent's own fresh profile, under the
// agent's own process and permissions. The user's Firefox profile is
// never read, copied, or touched in any way. This is the explicit
// Firefox choice for this plugin: "user Firefox, but with the agent's
// permissions" — i.e. the agent has its own Firefox that nobody else
// sees.
//
// Firefox 155 uses the Marionette protocol (port 2828), not the Chrome
// DevTools Protocol. Marionette is a length-prefixed JSON-over-TCP
// protocol — the same protocol Selenium/geckodriver uses.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';

let nextConn = 0;

// Find a Firefox binary on PATH.
function findFirefox() {
  for (const b of ['firefox', 'firefox-bin', 'firefox-esr']) {
    try {
      const r = spawn('which', [b], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      r.stdout.on('data', (d) => { out += d.toString(); });
      return new Promise((resolve) => {
        r.on('close', () => resolve(out.trim() ? { bin: b, path: out.trim() } : null));
      });
    } catch {}
  }
  return Promise.resolve(null);
}

// Marionette client: length-prefixed JSON frames over TCP.
// Format: "<length>:<json>\n"  (length is ASCII decimal byte count of json)
class MarionetteClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map(); // id -> {resolve, reject}
    this.events = [];
    this.id = 1;
    this.sessionId = null;
    this._welcomeResolve = null;
    this._welcome = new Promise((r) => { this._welcomeResolve = r; });
  }
  async connect(host = '127.0.0.1', port = 2828) {
    await new Promise((resolve, reject) => {
      this.socket = createConnection({ host, port }, resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => {
      for (const { reject: rj } of this.pending.values()) {
        rj(new Error('Marionette: socket closed'));
      }
      this.pending.clear();
    });
    await this._welcome; // wait for the welcome frame
  }
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const colon = this.buffer.indexOf(0x3A); // ':'
      if (colon < 0) return;
      const lenStr = this.buffer.slice(0, colon).toString('ascii');
      const len = Number(lenStr);
      if (!Number.isInteger(len) || len < 0) {
        // Probably the welcome frame (no colon for length? actually it does have ':').
        // If parse fails, drop the byte and continue.
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < colon + 1 + len) return; // wait for more
      const jsonBuf = this.buffer.slice(colon + 1, colon + 1 + len);
      this.buffer = this.buffer.slice(colon + 1 + len);
      let msg;
      try { msg = JSON.parse(jsonBuf.toString('utf8')); } catch { continue; }
      this._dispatch(msg);
    }
  }
  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`Marionette ${msg.error.error || 'error'}: ${msg.error.message}`));
      else resolve(msg.result || msg);
    } else if (msg.applicationType) {
      // Welcome frame
      this._welcomeResolve(msg);
    } else {
      this.events.push(msg);
    }
  }
  send(name, args = {}, timeoutMs = 8000) {
    const id = this.id++;
    const body = { id, name, args };
    if (this.sessionId) body.sessionId = this.sessionId;
    const json = JSON.stringify(body);
    const frame = `${json.length}:${json}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Marionette: ${name} timed out after ${timeoutMs}ms (Firefox 155+ in headless mode is known to not respond to legacy Marionette TCP commands; use BiDi via geckodriver instead)`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.socket.write(frame, (err) => { if (err) reject(err); });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  drainEvents(predicate) {
    const out = [];
    for (let i = 0; i < this.events.length; i += 1) {
      if (!predicate || predicate(this.events[i])) out.push(this.events[i]);
    }
    this.events.length = 0;
    return out;
  }
  close() {
    try { this.socket.end(); } catch {}
  }
}

export async function launchFirefox({ width = 1280, height = 720 } = {}) {
  const ff = await findFirefox();
  if (!ff) throw new Error('Firefox not found on PATH');

  const profileDir = mkdtempSync(join(tmpdir(), 'mcode-cu-ff-'));
  const proc = spawn(ff.path, [
    '--headless',
    '--marionette',
    '-profile', profileDir,
    '--width', String(width),
    '--height', String(height),
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // Wait for Marionette port 2828.
  await waitForPort(2828, 8000);
  const client = new MarionetteClient();
  await client.connect('127.0.0.1', 2828);

  // Start a session.
  const session = await client.send('WebDriver:NewSession', {
    capabilities: { alwaysMatch: {} },
  });
  client.sessionId = session.value || session.sessionId;

  return {
    proc,
    profileDir,
    width,
    height,
    client,
    browser: 'firefox',
    privateProfile: true,
    async navigate(url) {
      await client.send('WebDriver:Navigate', { url });
      // Wait briefly for load (Marionette doesn't emit load events; sleep).
      await new Promise((r) => setTimeout(r, 600));
    },
    async screenshot() {
      const r = await client.send('WebDriver:TakeScreenshot', {});
      const data = r.value || r;
      // Marionette returns base64-encoded PNG already.
      const b64 = typeof data === 'string' ? data : data.data;
      return Buffer.from(b64, 'base64');
    },
    async viewport() {
      try {
        const v = await client.send('WebDriver:ExecuteScript', {
          script: 'return {w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1};',
          args: [],
        });
        return v.value || v;
      } catch {
        return { w: width, h: height, dpr: 1 };
      }
    },
    async click(x, y, { button = 'left' } = {}) {
      await client.send('WebDriver:Actions', {
        actions: [{
          type: 'pointer',
          id: 'mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x, y, duration: 50 },
            { type: 'pointerDown', button: button === 'right' ? 2 : (button === 'middle' ? 1 : 0) },
            { type: 'pointerUp',   button: button === 'right' ? 2 : (button === 'middle' ? 1 : 0) },
          ],
        }],
      });
    },
    async clickSelector(selector, { button = 'left' } = {}) {
      const found = await client.send('WebDriver:FindElement', { using: 'css selector', value: selector });
      const elementId = found.value?.['element-6066-6e73-b8b5-a2b5e2b27d70'] || found.value?.ELEMENT || found.value;
      if (!elementId) throw new Error(`no element matches "${selector}"`);
      await client.send('WebDriver:ElementClick', { id: elementId });
      return { elementId, selector };
    },
    async focusSelector(selector) {
      const found = await client.send('WebDriver:FindElement', { using: 'css selector', value: selector });
      const elementId = found.value?.['element-6066-6e73-b8b5-a2b5e2b27d70'] || found.value?.ELEMENT || found.value;
      if (!elementId) throw new Error(`focusSelector: no match for "${selector}"`);
      // Fire focus via JS; Marionette's SendKeys requires element interaction.
      await client.send('WebDriver:ExecuteScript', {
        script: `arguments[0].focus(); return true;`,
        args: [{ 'element-6066-6e73-b8b5-a2b5e2b27d70': elementId, ELEMENT: elementId }],
      });
      return { elementId };
    },
    async typeText(text, { intervalMs = 0 } = {}) {
      for (const ch of text) {
        await client.send('WebDriver:Input', {
          actions: [{
            type: 'key',
            id: 'kbd',
            actions: [
              { type: 'keyDown', value: ch },
              { type: 'keyUp',   value: ch },
            ],
          }],
        });
        if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    async evaluate(expression) {
      const r = await client.send('WebDriver:ExecuteScript', {
        script: expression,
        args: [],
      });
      return r.value ?? r;
    },
    async close() {
      try { await client.send('WebDriver:Quit', {}); } catch {}
      try { client.close(); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 250));
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryOnce = () => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Marionette: port ${port} did not open within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 100);
        }
      });
    };
    tryOnce();
  });
}
