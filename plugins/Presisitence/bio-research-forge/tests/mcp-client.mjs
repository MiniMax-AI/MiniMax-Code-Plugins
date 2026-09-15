import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function startServer(serverPath = './mcp/public-bio-api.mjs', env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP server exited with code ${code}`));
    pending.clear();
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 60_000);
      pending.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  return {
    child,
    request,
    close() { child.stdin.end(); child.kill(); },
  };
}

export function toolText(message) {
  const text = message?.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`Missing MCP text result: ${JSON.stringify(message)}`);
  return text;
}
