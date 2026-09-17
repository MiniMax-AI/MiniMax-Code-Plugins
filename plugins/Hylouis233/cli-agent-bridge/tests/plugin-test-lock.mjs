import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_DIR = path.join(os.tmpdir(), "cli-agent-bridge-plugin-test-lock");
const PID_FILE = path.join(LOCK_DIR, "pid");
const LOCK_WAIT_MS = 600000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

export async function acquireCliAgentBridgeTestLock() {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(LOCK_DIR);
      await writeFile(PID_FILE, String(process.pid));
      return async () => {
        await rm(LOCK_DIR, { recursive: true, force: true });
      };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      let owner = Number.NaN;
      try {
        owner = Number((await readFile(PID_FILE, "utf8")).trim());
      } catch {
        owner = Number.NaN;
      }
      if (Number.isInteger(owner) && owner > 0 && !pidAlive(owner)) {
        await rm(LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > LOCK_WAIT_MS) {
        throw new Error("timed out waiting for cli-agent-bridge plugin test serialization lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
