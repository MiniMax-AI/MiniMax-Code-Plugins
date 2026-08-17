import { constants } from "node:fs";
import { access, appendFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

let executableEntry = null;
const pathCommandEntries = new Map();

async function resolveGitExecutable() {
  if (process.env.NODE_ENV === "test") {
    const delayMs = Number(process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      const startedFile = process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE;
      if (typeof startedFile === "string" && path.isAbsolute(startedFile)) {
        await appendFile(startedFile, "started\n");
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const names = process.platform === "win32" ? ["git.exe", "git.com"] : ["git"];
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    // Never let a relative PATH component reinterpret an untrusted workspace
    // as an executable search root after a Git command changes cwd.
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return await realpath(candidate);
      } catch { /* try the next trusted PATH entry */ }
    }
  }
  throw new Error("cannot locate git in an absolute PATH directory");
}

async function resolvePathCommandUncached(command) {
  if (process.env.NODE_ENV === "test") {
    const delayMs = Number(process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      const startedFile = process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_STARTED_FILE;
      if (typeof startedFile === "string" && path.isAbsolute(startedFile)) {
        await appendFile(startedFile, "started\n");
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (path.isAbsolute(command)) {
    try {
      await access(command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return (await stat(command)).isFile() ? await realpath(command) : null;
    } catch { return null; }
  }
  if (/[\\/]/u.test(command)) return null;
  const extensions = process.platform === "win32"
    ? (path.extname(command)
        ? [""]
        : [...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean), ".ps1"])
    : [""];
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/gu, "");
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return await realpath(candidate);
      } catch { /* continue searching */ }
    }
  }
  return null;
}

function pathCommandEntry(command) {
  if (typeof command !== "string" || !command) {
    return { promise: Promise.resolve(null), state: "fulfilled", value: null, error: null };
  }
  if (!pathCommandEntries.has(command)) {
    const entry = {
      promise: resolvePathCommandUncached(command),
      state: "pending",
      value: null,
      error: null,
      waiters: new Set(),
    };
    pathCommandEntries.set(command, entry);
    // The core lookup has exactly one settlement reaction. Request-scoped
    // waiters subscribe below and can be removed on cancel/deadline, so a
    // permanently stalled filesystem lookup cannot retain one closure per
    // abandoned request.
    void entry.promise.then((resolved) => {
      entry.state = "fulfilled";
      entry.value = resolved;
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      // Retain positive results, but retry a missing/not-yet-installed CLI.
      if (resolved === null && pathCommandEntries.get(command) === entry) {
        pathCommandEntries.delete(command);
      }
      for (const waiter of waiters) waiter.resolve(resolved);
    }, (error) => {
      entry.state = "rejected";
      entry.error = error;
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      if (pathCommandEntries.get(command) === entry) pathCommandEntries.delete(command);
      for (const waiter of waiters) waiter.reject(error);
    });
  }
  return pathCommandEntries.get(command);
}

export function resolvePathCommand(command) {
  return pathCommandEntry(command).promise;
}

export function subscribePathCommand(command, resolve, reject) {
  const entry = pathCommandEntry(command);
  if (entry.state !== "pending") {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (entry.state === "rejected") reject(entry.error);
      else resolve(entry.value);
    });
    return () => { active = false; };
  }
  const waiter = { resolve, reject };
  entry.waiters.add(waiter);
  return () => { entry.waiters.delete(waiter); };
}

export function trustedGitExecutable() {
  if (!executableEntry) {
    const entry = {
      promise: resolveGitExecutable(),
      state: "pending",
      value: null,
      error: null,
      waiters: new Set(),
    };
    executableEntry = entry;
    void entry.promise.then((resolved) => {
      entry.state = "fulfilled";
      entry.value = resolved;
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      for (const waiter of waiters) waiter.resolve(resolved);
    }, (error) => {
      entry.state = "rejected";
      entry.error = error;
      const waiters = [...entry.waiters];
      entry.waiters.clear();
      if (executableEntry === entry) executableEntry = null;
      for (const waiter of waiters) waiter.reject(error);
    });
  }
  return executableEntry.promise;
}

export function subscribeTrustedGitExecutable(resolve, reject) {
  trustedGitExecutable();
  const entry = executableEntry;
  if (entry.state !== "pending") {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (entry.state === "rejected") reject(entry.error);
      else resolve(entry.value);
    });
    return () => { active = false; };
  }
  const waiter = { resolve, reject };
  entry.waiters.add(waiter);
  return () => { entry.waiters.delete(waiter); };
}

export async function safeGitInvocation(
  args, baseEnvironment = process.env, resolvedExecutable = null,
) {
  if (process.env.NODE_ENV === "test") {
    const delayMs = Number(process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS ?? 0);
    if (Number.isFinite(delayMs) && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  const safeArgs = [
    // Git documents /dev/null as the way to disable hooks. Unlike a shared
    // empty directory, this sink cannot be pre-created or populated by another
    // local user before a coordination update-ref operation.
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "gc.autoDetach=false",
    "-c", "maintenance.auto=false",
    ...args,
  ];
  if (args[0] === "diff") safeArgs.splice(9, 0, "--no-ext-diff", "--no-textconv");
  // Repository-routing variables must never leak from the process that
  // launched the bridge. Clear every case variant of GIT_* (Windows
  // environment names are case-insensitive), then restore only the settings
  // required by these local, non-interactive bridge operations.
  const env = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([name]) => !/^GIT_/iu.test(name)),
  );
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "",
    PAGER: "",
  });
  return { command: resolvedExecutable ?? await trustedGitExecutable(), args: safeArgs, env };
}
