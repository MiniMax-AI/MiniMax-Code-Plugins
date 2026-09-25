// cdp.mjs
//
// Chrome DevTools Protocol (CDP) backend for the computer-use plugin.
//
// This is an alternative to the OS-level screenshot+input pipeline. It
// launches a private headless Chrome (visible to nobody — no screen
// capture permission needed) and drives it via the standard CDP
// WebSocket protocol. The model sees the page just like any other
// screenshot; clicks and keystrokes are dispatched through Chrome
// itself, not through xdotool/cliclick.
//
// Trade-offs vs the OS-level pipeline:
//   + No OS permission required (no Screen Recording / Accessibility).
//   + No external CLI tools needed (no xdotool, no cliclick, no grim).
//   + Pure-JS implementation; ships inside the plugin.
//   + Works on headless servers with no X server.
//   - Limited to the Chrome/Firefox page (not the whole desktop).
//   - Multiple displays or non-browser apps not visible.
//   - Browser launch adds ~1s of overhead per session.
//
// Use the OS-level pipeline when you have permissions and want true
// desktop control; use this CDP backend when you don't.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let nextId = 1;

function findChrome() {
  for (const b of ['google-chrome', 'google-chrome-stable', 'chrome', 'chromium', 'chromium-browser']) {
    try {
      const r = spawn('which', [b], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      r.stdout.on('data', (d) => { out += d.toString(); });
      return new Promise((resolve) => {
        r.on('close', () => {
          const p = out.trim();
          resolve(p ? { bin: b, path: p } : null);
        });
      });
    } catch {}
  }
  return Promise.resolve(null);
}

async function getWsUrl(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const j = await res.json();
        return j.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`CDP: Chrome did not open debugging port ${port} within 5s`);
}

async function getFirstTargetWs(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const list = await res.json();
        const target = list.find((t) => t.type === 'page') || list[0];
        if (target) return target.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`CDP: no page target found on port ${port} within 5s`);
}

// Tiny JSON-RPC over WebSocket client.
function rpc(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const events = [];
    let readyRes = null;
    const ready = new Promise((r) => { readyRes = r; });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: r, reject: rj } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rj(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        else r(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });

    ws.addEventListener('open', () => {
      readyRes();
    });

    ws.addEventListener('close', () => {
      for (const { reject: rj } of pending.values()) rj(new Error('CDP: socket closed'));
      pending.clear();
    });

    ws.addEventListener('error', (e) => {
      reject(new Error(`CDP: socket error: ${e.message || 'unknown'}`));
    });

    ready.then(() => {
      // Hand back the live object once the socket is open.
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((r, rj) => {
            pending.set(id, { resolve: r, reject: rj });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        drainEvents(methodFilter) {
          const out = [];
          for (let i = 0; i < events.length; i += 1) {
            if (!methodFilter || events[i].method === methodFilter) {
              out.push(events[i]);
            }
          }
          events.length = 0;
          return out;
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    }).catch(reject);
  });
}

// Spawn a private headless Chrome and return its CDP control.
export async function launchChrome({ port = 9222, width = 1280, height = 720 } = {}) {
  const chrome = await findChrome();
  if (!chrome) {
    throw new Error('CDP: no Chrome/Chromium binary found on PATH');
  }
  const profileDir = mkdtempSync(join(tmpdir(), 'mcode-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`,
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const proc = spawn(chrome.path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  const wsUrl = await getWsUrl(port);
  const targetWsUrl = await getFirstTargetWs(port);
  const client = await rpc(targetWsUrl);

  // Enable the domains we use.
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('DOM.enable');
  await client.send('Input.setIgnoreInputEvents', { ignore: false });

  return {
    proc,
    profileDir,
    wsUrl,
    port,
    width,
    height,
    client,
    async navigate(url) {
      await client.send('Page.navigate', { url });
      // Wait for loadState 'load' via Page.loadEventFired event.
      const ev = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 15000);
        const interval = setInterval(() => {
          const found = client.drainEvents('Page.loadEventFired');
          if (found.length > 0) {
            clearTimeout(t);
            clearInterval(interval);
            resolve(found[0]);
          }
        }, 50);
      });
      // Give the page another moment to settle (image paints etc.).
      await new Promise((r) => setTimeout(r, 250));
      return ev;
    },
    async screenshot({ format = 'png' } = {}) {
      const res = await client.send('Page.captureScreenshot', { format });
      return Buffer.from(res.data, 'base64');
    },
    async viewport() {
      const { result } = await client.send('Runtime.evaluate', {
        expression: '({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})',
        returnByValue: true,
      });
      return result.value;
    },
    async click(x, y, { button = 'left', clickCount = 1 } = {}) {
      const common = { x, y, button, clickCount };
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', ...common,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', ...common,
      });
    },
    // Find an element via a CSS selector and click it at its center.
    // More reliable than computing pixel coordinates manually.
    async clickSelector(selector, { button = 'left' } = {}) {
      const rect = await client.send('Runtime.evaluate', {
        expression: `
          (function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({block: 'center'});
            var r = el.getBoundingClientRect();
            return { x: r.left + r.width/2, y: r.top + r.height/2,
                     tag: el.tagName, id: el.id, name: el.name };
          })()
        `,
        returnByValue: true,
      });
      if (!rect.result.value) {
        throw new Error(`clickSelector: no element matches "${selector}"`);
      }
      const { x, y } = rect.result.value;
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button, clickCount: 1,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button, clickCount: 1,
      });
      return rect.result.value;
    },
    // Find an input/textarea element by selector and focus it via
    // element.focus() rather than by clicking. Faster and immune to
    // viewport coordinate mismatches.
    async focusSelector(selector) {
      const r = await client.send('Runtime.evaluate', {
        expression: `
          (function(){
            var el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.focus();
            return { tag: el.tagName, id: el.id, name: el.name,
                     active: document.activeElement === el };
          })()
        `,
        returnByValue: true,
      });
      if (!r.result.value) {
        throw new Error(`focusSelector: no element matches "${selector}"`);
      }
      if (!r.result.value.active) {
        // Fall back to mouse click at the element center.
        const rect = await client.send('Runtime.evaluate', {
          expression: `
            (function(){
              var el = document.querySelector(${JSON.stringify(selector)});
              el.scrollIntoView({block: 'center'});
              var r = el.getBoundingClientRect();
              return { x: r.left + r.width/2, y: r.top + r.height/2 };
            })()
          `,
          returnByValue: true,
        });
        const { x, y } = rect.result.value;
        await client.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1,
        });
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
      }
      return r.result.value;
    },
    async mousemove(x, y) {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none',
      });
    },
    async typeText(text, { intervalMs = 0 } = {}) {
      for (const ch of text) {
        if (ch === '\n') {
          await client.send('Input.dispatchKeyEvent', {
            type: 'char', text: '\r', unmodifiedText: '\r',
            windowsVirtualKeyCode: 13,
          });
        } else {
          await client.send('Input.dispatchKeyEvent', {
            type: 'char', text: ch, unmodifiedText: ch,
          });
        }
        if (intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    async keyCombo(keys) {
      // Press all modifier keys down, the main key, then release modifiers.
      const modifiers = keys.slice(0, -1).map((k) => k.toLowerCase());
      const main = keys[keys.length - 1];
      for (const m of modifiers) {
        await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: modBit(m), key: m });
      }
      await client.send('Input.dispatchKeyEvent', { type: 'char', text: main });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modBit(main) });
      for (const m of modifiers) {
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modBit(m), key: m });
      }
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'CDP eval failed');
      return result.value;
    },
    async close() {
      try { client.close(); } catch {}
      try { proc.kill('SIGTERM'); } catch {}
      try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    },
  };
}

function modBit(name) {
  const n = name.toLowerCase();
  let bit = 0;
  if (n === 'ctrl' || n === 'control') bit |= 2;
  if (n === 'alt' || n === 'option') bit |= 1;
  if (n === 'shift') bit |= 8;
  if (n === 'meta' || n === 'cmd' || n === 'super') bit |= 4;
  return bit;
}
