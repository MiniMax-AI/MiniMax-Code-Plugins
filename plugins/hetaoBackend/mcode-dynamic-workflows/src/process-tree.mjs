import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);

// The caller creates a dedicated POSIX process group. Never walk or signal
// unrelated services, and never stop escalation merely because the leader exited.
export async function stopProcessTree(child, {
  platform = process.platform, run = exec, kill = process.kill,
  graceMs = 2000, forceMs = 1000,
} = {}) {
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) return { confirmed: true };
  try {
    if (platform === 'win32') {
      // taskkill must see the live parent to discover its descendants. An already
      // exited root is insufficient evidence that the tree has stopped.
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('CLI exited before Windows process-tree cleanup');
      }
      await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 65536,
      });
      return { confirmed: true };
    }
    const live = async () => {
      const { stdout } = await run('/bin/ps', ['-axo', 'pid=,pgid=,stat='], {
        timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      });
      // Zombies cannot execute or hold pipes. Waiting for their reaper can block
      // forever in containers even after every owned process has been killed.
      const rows = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (!rows.length) throw new Error('Empty process table');
      let running = false;
      for (const row of rows) {
        const fields = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row);
        if (!fields) throw new Error('Unrecognized process table');
        if (Number(fields[2]) === pid && !fields[3].startsWith('Z')) running = true;
      }
      return running;
    };
    const send = signal => {
      try { kill(-pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const wait = async ms => {
      const deadline = Date.now() + ms;
      do {
        if (!await live()) return true;
        if (Date.now() >= deadline) return false;
        await delay(50);
      } while (true);
    };
    if (!await live()) return { confirmed: true };
    send('SIGTERM');
    if (await wait(graceMs)) return { confirmed: true };
    send('SIGKILL');
    if (await wait(forceMs)) return { confirmed: true };
    throw new Error('Owned process group still contains live processes after SIGKILL');
  } catch (error) {
    // Keep termination bounded, but never label uncertain cleanup as stopped.
    return { confirmed: false, reason: error.message };
  }
}
