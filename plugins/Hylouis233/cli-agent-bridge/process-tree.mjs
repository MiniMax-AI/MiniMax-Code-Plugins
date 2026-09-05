import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const UTILITY_CAPTURE_CHARS = 1_000_000;
const MARKER_OBSERVATION_GRACE_MS = 500;

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > UTILITY_CAPTURE_CHARS ? combined.slice(-UTILITY_CAPTURE_CHARS) : combined;
}

function runUtility(command, args, timeoutMs = 5_000, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const done = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, error, stdoutTruncated, stderrTruncated });
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      done(null, new Error(command + " timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > UTILITY_CAPTURE_CHARS) stdoutTruncated = true;
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > UTILITY_CAPTURE_CHARS) stderrTruncated = true;
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => done(null, error));
    child.on("close", (code) => done(code));
  });
}

async function windowsProcessStartIdentity(pid, run = runUtility) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${String(pid)}'`,
    "if ($null -eq $p -or $null -eq $p.CreationDate) { throw 'process identity is unavailable' }",
    "$p.CreationDate.ToUniversalTime().Ticks.ToString()",
  ].join("; ");
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  const identity = result.stdout.trim();
  if (result.exitCode !== 0 || !/^\d+$/u.test(identity)) {
    throw new Error("cannot inspect Windows process identity: " +
      (result.stderr.trim() || result.error?.message || "unknown error"));
  }
  return identity;
}

export function trackedWindowsProcessTreePids(rootPid, treeState, processes) {
  treeState.knownStarts ??= new Map();
  if (treeState.windowsRootIdentityAttempted === true &&
      !treeState.knownStarts.has(rootPid)) {
    throw new Error("cannot inspect Windows process tree: worker creation identity was not captured at startup");
  }
  if (!Array.isArray(processes) || processes.some((item) =>
    !Number.isInteger(item.pid) || !Number.isInteger(item.parentPid) ||
    !/^\d+$/u.test(item.startIdentity))) {
    throw new Error("cannot inspect Windows process tree: invalid process snapshot");
  }
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  for (const pid of [...treeState.knownPids]) {
    const item = byPid.get(pid);
    const expected = treeState.knownStarts.get(pid);
    if (item && expected && expected !== item.startIdentity) treeState.knownPids.delete(pid);
  }
  const descendants = new Set();
  const parents = new Set();
  const canBeChildOf = (item, parentPid) => {
    const parentStart = treeState.knownStarts.get(parentPid);
    return Boolean(parentStart) && BigInt(item.startIdentity) >= BigInt(parentStart);
  };
  const acceptKnown = (pid) => {
    const item = byPid.get(pid);
    const expected = treeState.knownStarts.get(pid);
    if (!item || !expected || expected !== item.startIdentity) return;
    descendants.add(pid);
    parents.add(pid);
  };
  acceptKnown(rootPid);
  for (const pid of treeState.knownPids) acceptKnown(pid);
  if (!treeState.knownStarts.has(rootPid) &&
      (byPid.has(rootPid) || processes.some((item) => item.parentPid === rootPid))) {
    throw new Error("cannot inspect Windows process tree: worker creation identity was not captured at startup");
  }
  for (const [knownPid, knownStart] of treeState.knownStarts) {
    const currentParent = byPid.get(knownPid);
    const originalParentUnavailable = !currentParent || currentParent.startIdentity !== knownStart;
    if (originalParentUnavailable && processes.some((item) => {
      if (item.parentPid !== knownPid || treeState.knownStarts.has(item.pid) ||
          BigInt(item.startIdentity) < BigInt(knownStart)) return false;
      return !currentParent || BigInt(item.startIdentity) <= BigInt(currentParent.startIdentity);
    })) {
      throw new Error("cannot inspect Windows process tree: unverified descendant remained after a tracked parent exited");
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (!parents.has(item.parentPid) || descendants.has(item.pid) ||
          !canBeChildOf(item, item.parentPid)) continue;
      descendants.add(item.pid);
      parents.add(item.pid);
      treeState.knownStarts.set(item.pid, item.startIdentity);
      changed = true;
    }
  }
  for (const pid of descendants) treeState.knownPids.add(pid);
  return [...descendants];
}

export async function windowsProcessTreePids(
  rootPid,
  treeState = { knownPids: new Set(), knownStarts: new Map() },
  { runUtility: run = runUtility, windowsSnapshot } = {},
) {
  if (windowsSnapshot) {
    return trackedWindowsProcessTreePids(rootPid, treeState, await windowsSnapshot({
      rootPid, knownPids: [...treeState.knownPids],
    }));
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-CimInstance Win32_Process | ForEach-Object {$identity=$(if($null -eq $_.CreationDate){''}else{$_.CreationDate.ToUniversalTime().Ticks.ToString()});[pscustomobject]@{ProcessId=[uint32]$_.ProcessId;ParentProcessId=[uint32]$_.ParentProcessId;CreationTicks=$identity}})",
    "$items | ConvertTo-Json -Compress",
  ].join("; ");
  const result = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", script,
  ]);
  if (result.exitCode !== 0) {
    throw new Error("cannot inspect Windows process tree: " + (result.stderr.trim() || result.error?.message || "unknown error"));
  }
  const raw = result.stdout.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const processes = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    startIdentity: String(item.CreationTicks ?? ""),
  }));
  return trackedWindowsProcessTreePids(rootPid, treeState, processes);
}

export async function initializeProcessTree(child, treeState, options = {}) {
  const platform = options.platform ?? process.platform;
  const queryRootIdentity = options.queryRootIdentity ?? windowsProcessStartIdentity;
  const run = options.runUtility ?? runUtility;
  if (!Number.isInteger(child.pid)) return;
  if (platform === "win32") {
    treeState.knownStarts ??= new Map();
    treeState.windowsRootIdentityAttempted = true;
    const identity = await queryRootIdentity(child.pid, run);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Windows worker exited before startup identity was captured");
    }
    treeState.knownPids.add(child.pid);
    treeState.knownStarts.set(child.pid, identity);
    return;
  }
  try {
    const snapshot = await refreshProcessTree(child, treeState, {
      ...options, platform, allowRootIdentityCapture: true,
    });
    if (snapshot === null || treeState.processIdentityUncertain === true ||
        child.exitCode !== null || child.signalCode !== null ||
        !treeState.knownStarts?.get(child.pid)) {
      treeState.knownPids.clear();
      treeState.knownPids.add(child.pid);
      treeState.knownStarts.clear();
      throw new Error("POSIX worker identity was not captured while its process handle was live");
    }
  } finally {
    treeState.rootIdentityInitialized = true;
  }
}

function parseLinuxStat(pid, statLine) {
  // comm is parenthesized and may itself contain ')' characters. Fields
  // after the final ')' begin with: state, ppid, pgrp, ...
  const close = statLine.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statLine.slice(close + 1).trim().split(/\s+/u);
  const item = {
    pid,
    state: fields[0],
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    startIdentity: fields[19] ?? "", // field 22: start time since boot
  };
  return !item.state || !Number.isInteger(item.pid) ||
    !Number.isInteger(item.parentPid) || !Number.isInteger(item.processGroupId)
    ? null : item;
}

function isLinuxProcessGone(error) {
  // procfs can report either ENOENT or ESRCH when a process disappears
  // between directory enumeration and a subsequent stat/task read.
  return error?.code === "ENOENT" || error?.code === "ESRCH";
}

async function readLinuxStat(pid, procRoot, fsOps) {
  try {
    return parseLinuxStat(pid, await fsOps.readFile(`${procRoot}/${pid}/stat`, "utf8"));
  } catch (error) {
    if (isLinuxProcessGone(error)) return undefined;
    throw error;
  }
}

async function linuxProcessSnapshot(procRoot = "/proc", fsOps = { readdir, readFile }) {
  let entries;
  try {
    entries = await fsOps.readdir(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const processes = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const item = await readLinuxStat(Number(entry.name), procRoot, fsOps);
      if (item === undefined) continue;
      if (item === null) return null;
      processes.push(item);
    } catch (error) {
      return null;
    }
  }
  processes.incomplete = false;
  return processes;
}

// Linux keeps zombie processes in /proc until their parent (sometimes a
// non-reaping container PID 1) collects them. This classifier is deliberately
// tri-state: true means a live member was found, false means every matching
// member is a zombie, and null means the result is uncertain. Callers may only
// use the false result after a group-wide SIGKILL; while a group is still
// running, enumerating /proc races with members that can fork.
export async function linuxProcessGroupHasLiveMembers(
  processGroupId,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
) {
  const processes = await linuxProcessSnapshot(procRoot, fsOps);
  if (processes === null) return null;
  const members = processes.filter((item) => item.processGroupId === processGroupId);
  if (members.length === 0) return null;
  return members.some((item) => isLiveState(item.state));
}

async function linuxMarkedProcesses(marker, procRoot, fsOps) {
  let entries;
  try {
    entries = await fsOps.readdir(procRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const expected = "CLI_AGENT_BRIDGE_RUN_ID=" + marker;
  const matches = [];
  matches.identityConflict = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    try {
      const pid = Number(entry.name);
      const before = await readLinuxStat(pid, procRoot, fsOps);
      if (before === undefined) continue;
      if (before === null) return null;
      const environment = await fsOps.readFile(`${procRoot}/${entry.name}/environ`);
      const values = Buffer.isBuffer(environment)
        ? environment.toString("utf8").split("\0")
        : String(environment).split("\0");
      if (!values.includes(expected)) continue;
      const after = await readLinuxStat(pid, procRoot, fsOps);
      if (after && before.startIdentity && before.startIdentity === after.startIdentity) {
        matches.push(after);
      } else if (after && before.startIdentity && after.startIdentity &&
          before.startIdentity !== after.startIdentity) {
        matches.identityConflict = true;
      }
    } catch (error) {
      // Processes may exit or belong to another user while /proc is scanned.
      // Neither case invalidates positive matches from this bridge's marker.
      if (!isLinuxProcessGone(error) && !["EACCES", "EPERM"].includes(error.code)) return null;
    }
  }
  return matches;
}

async function linuxFallbackTrackedProcessSnapshot(
  rootPid,
  treeState,
  procRoot,
  fsOps,
  allowRootIdentityCapture = false,
) {
  const snapshot = await linuxProcessSnapshot(procRoot, fsOps);
  if (snapshot === null) {
    treeState.processIdentityUncertain = true;
    return null;
  }
  treeState.knownStarts ??= new Map();
  const byPid = new Map(snapshot.map((item) => [item.pid, item]));
  const accepted = new Map();
  const root = byPid.get(rootPid);
  let expectedRoot = treeState.knownStarts.get(rootPid);
  if (allowRootIdentityCapture && !expectedRoot && root?.startIdentity) {
    const rootAfter = await readLinuxStat(rootPid, procRoot, fsOps);
    if (!rootAfter || rootAfter.startIdentity !== root.startIdentity) {
      treeState.processIdentityUncertain = true;
      return null;
    }
    expectedRoot = root.startIdentity;
    treeState.knownStarts.set(rootPid, expectedRoot);
  }
  if (root && expectedRoot && root.startIdentity === expectedRoot) {
    accepted.set(rootPid, root);
    treeState.knownPids.add(rootPid);
  }
  for (const [pid, expected] of treeState.knownStarts) {
    const item = byPid.get(pid);
    if (item?.startIdentity && item.startIdentity === expected) accepted.set(pid, item);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const item of snapshot) {
      if (accepted.has(item.pid) || !/^\d+$/u.test(item.startIdentity)) continue;
      const parent = accepted.get(item.parentPid);
      const rootGroupMember = accepted.has(rootPid) && item.processGroupId === rootPid;
      if (!parent && !rootGroupMember) continue;
      const relationshipAnchor = parent ?? accepted.get(rootPid);
      if (!/^\d+$/u.test(relationshipAnchor.startIdentity) ||
          BigInt(item.startIdentity) < BigInt(relationshipAnchor.startIdentity)) {
        treeState.processIdentityUncertain = true;
        continue;
      }
      const current = await readLinuxStat(item.pid, procRoot, fsOps);
      if (current === null) return null;
      if (current === undefined) continue;
      if (current.startIdentity !== item.startIdentity ||
          (parent && current.parentPid !== parent.pid) ||
          (rootGroupMember && current.processGroupId !== rootPid)) {
        treeState.processIdentityUncertain = true;
        continue;
      }
      const anchorNow = await readLinuxStat(relationshipAnchor.pid, procRoot, fsOps);
      if (anchorNow === null) return null;
      if (!anchorNow || anchorNow.startIdentity !== relationshipAnchor.startIdentity) {
        treeState.processIdentityUncertain = true;
        continue;
      }
      accepted.set(item.pid, current);
      treeState.knownPids.add(item.pid);
      treeState.knownStarts.set(item.pid, current.startIdentity);
      changed = true;
    }
  }

  if (treeState.runMarker) {
    const marked = await linuxMarkedProcesses(treeState.runMarker, procRoot, fsOps);
    if (marked === null || marked.identityConflict === true) {
      treeState.processIdentityUncertain = true;
      return null;
    }
    for (const item of marked) {
      if (item.pid === rootPid) continue;
      const expected = treeState.knownStarts.get(item.pid);
      if (expected && expected !== item.startIdentity) {
        treeState.processIdentityUncertain = true;
        continue;
      }
      treeState.knownPids.add(item.pid);
      if (!expected) treeState.knownStarts.set(item.pid, item.startIdentity);
      accepted.set(item.pid, item);
    }
  }
  const processes = [...accepted.values()];
  // Discovery used a complete host snapshot, but the accepted ownership subset
  // is intentionally narrower. Keep group probing enabled for final liveness.
  processes.incomplete = true;
  return processes;
}

// Follow only PIDs already owned by this worker and the kernel-maintained child
// lists for their tasks. This keeps the short escape-detection interval without
// rescanning every process on the host for the lifetime of a delegation.
async function linuxTrackedProcessSnapshot(
  rootPid,
  treeState,
  procRoot,
  fsOps,
  allowRootIdentityCapture = false,
) {
  treeState.knownStarts ??= new Map();
  if (treeState.linuxTaskChildrenUnavailable === true) {
    return await linuxFallbackTrackedProcessSnapshot(
      rootPid, treeState, procRoot, fsOps, allowRootIdentityCapture,
    );
  }
  const queue = [];
  const queued = new Set();
  const enqueue = (pid, parentPid = null, parentStartIdentity = null) => {
    if (queued.has(pid)) return;
    queued.add(pid);
    queue.push({ pid, parentPid, parentStartIdentity });
  };
  enqueue(rootPid);
  for (const pid of treeState.knownPids) enqueue(pid);
  const processes = [];
  const enqueueMarkedProcesses = async ({ stable = false } = {}) => {
    if (!treeState.runMarker) return;
    const scanMarkedProcesses = async () => {
      const items = await linuxMarkedProcesses(treeState.runMarker, procRoot, fsOps);
      if (items === null) {
        treeState.processIdentityUncertain = true;
        throw new Error("cannot inspect Linux run markers");
      }
      if (items.identityConflict === true) {
        treeState.processIdentityUncertain = true;
        throw new Error("Linux run-marker process identity changed during inspection");
      }
      return items;
    };
    const identities = (items) => items
      .map((item) => String(item.pid) + ":" + item.startIdentity)
      .sort().join("\n");
    const observedIdentities = new Map();
    const rememberIdentities = (items) => {
      for (const item of items) {
        const previous = observedIdentities.get(item.pid);
        if (previous && previous !== item.startIdentity) {
          treeState.processIdentityUncertain = true;
          throw new Error("Linux run-marker process identity changed between observations");
        }
        observedIdentities.set(item.pid, item.startIdentity);
      }
    };
    let markedProcesses = await scanMarkedProcesses();
    rememberIdentities(markedProcesses);
    if (stable) {
      let stableObservation = false;
      // A process can disappear between the first and second scans during a
      // normal exit. Permit a bounded sequence of runner/worker transitions,
      // but require two consecutive, identical full observations before
      // treating the result as stable.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const repeated = await scanMarkedProcesses();
        rememberIdentities(repeated);
        if (identities(markedProcesses) === identities(repeated)) {
          markedProcesses = repeated;
          stableObservation = true;
          break;
        }
        markedProcesses = repeated;
      }
      if (!stableObservation) {
        treeState.processIdentityUncertain = true;
        throw new Error("Linux run-marker observation changed during process exit");
      }
    }
    for (const marked of markedProcesses) {
      // The launch-time root identity is immutable. Marker recovery exists for
      // escaped descendants, never to bless a recycled root PID.
      if (marked.pid === rootPid) continue;
      const expected = treeState.knownStarts.get(marked.pid);
      // A recorded identity is immutable too. A stable marker proves that the
      // current process inherited this run's environment, but it cannot prove
      // that a recycled numeric PID is the same descendant observed earlier.
      if (expected && expected !== marked.startIdentity) {
        treeState.processIdentityUncertain = true;
        continue;
      }
      if (!expected) treeState.knownStarts.set(marked.pid, marked.startIdentity);
      enqueue(marked.pid);
    }
  };
  for (let index = 0; index < queue.length; index += 1) {
    const { pid, parentPid, parentStartIdentity } = queue[index];
    let item;
    try {
      item = await readLinuxStat(pid, procRoot, fsOps);
    } catch {
      return null;
    }
    if (item === undefined) {
      if (pid === rootPid || parentPid !== null) {
        await enqueueMarkedProcesses({ stable: true });
      }
      continue;
    }
    if (item === null) return null;
    const expected = treeState.knownStarts.get(pid);
    if (pid === rootPid && !expected && !allowRootIdentityCapture) {
      await enqueueMarkedProcesses();
      continue;
    }
    if (expected && item.startIdentity && expected !== item.startIdentity) {
      if (pid === rootPid) await enqueueMarkedProcesses();
      continue;
    }
    if (parentPid !== null && (item.parentPid !== parentPid ||
        !parentStartIdentity || BigInt(item.startIdentity) < BigInt(parentStartIdentity))) {
      treeState.processIdentityUncertain = true;
      await enqueueMarkedProcesses();
      continue;
    }
    treeState.knownPids.add(pid);
    if (item.startIdentity) treeState.knownStarts.set(pid, item.startIdentity);
    processes.push(item);

    const pendingChildren = new Set();
    let parentAfter = item;
    let taskDirectoryGone = false;
    let stableTaskSample = false;
    for (let taskAttempt = 0; taskAttempt < 3; taskAttempt += 1) {
      let taskEntries;
      try {
        taskEntries = await fsOps.readdir(`${procRoot}/${pid}/task`, { withFileTypes: true });
      } catch (error) {
        if (isLinuxProcessGone(error)) {
          taskDirectoryGone = true;
          break;
        }
        return null;
      }
      let taskChangedWhileReading = false;
      for (const taskEntry of taskEntries) {
        if (!taskEntry.isDirectory() || !/^\d+$/u.test(taskEntry.name)) continue;
        let children;
        try {
          children = await fsOps.readFile(
            `${procRoot}/${pid}/task/${taskEntry.name}/children`, "utf8",
          );
        } catch (error) {
          if (allowRootIdentityCapture && pid === rootPid && taskEntry.name === String(rootPid) &&
              error?.code === "ENOENT") {
            let taskEntriesAfter;
            try {
              taskEntriesAfter = await fsOps.readdir(`${procRoot}/${pid}/task`, {
                withFileTypes: true,
              });
            } catch (confirmError) {
              if (!isLinuxProcessGone(confirmError)) return null;
              taskEntriesAfter = [];
            }
            const mainTaskStillPresent = taskEntriesAfter.some((entry) =>
              entry.isDirectory() && entry.name === String(rootPid));
            const rootAfter = mainTaskStillPresent
              ? await readLinuxStat(pid, procRoot, fsOps)
              : undefined;
            if (rootAfter && rootAfter.startIdentity === item.startIdentity) {
              treeState.linuxTaskChildrenUnavailable = true;
              return await linuxFallbackTrackedProcessSnapshot(
                rootPid, treeState, procRoot, fsOps, allowRootIdentityCapture,
              );
            }
          }
          if (isLinuxProcessGone(error)) {
            taskChangedWhileReading = true;
            continue;
          }
          return null;
        }
        for (const value of children.trim().split(/\s+/u)) {
          if (!value) continue;
          const childPid = Number(value);
          if (!Number.isInteger(childPid) || childPid <= 0) continue;
          // Preserve evidence from every torn attempt. A later complete task
          // pass cannot make a previously observed child safe to forget.
          pendingChildren.add(childPid);
        }
      }
      try {
        parentAfter = await readLinuxStat(pid, procRoot, fsOps);
      } catch {
        return null;
      }
      if (!parentAfter || parentAfter.startIdentity !== item.startIdentity) break;
      if (!taskChangedWhileReading) {
        stableTaskSample = true;
        break;
      }
      // Recover marker-bearing escapees immediately, then retry the complete
      // task list while the original parent identity is still live.
      await enqueueMarkedProcesses();
    }
    if (taskDirectoryGone) {
      await enqueueMarkedProcesses({ stable: true });
      if ([...pendingChildren].some((childPid) => !treeState.knownStarts.has(childPid))) {
        treeState.processIdentityUncertain = true;
      }
      continue;
    }
    if (!parentAfter || parentAfter.startIdentity !== item.startIdentity) {
      // A short-lived, childless runner normally disappears between its task
      // listing and this identity recheck. Require two identical full marker
      // scans before accepting that clean exit. Any not-yet-verified child, a
      // replacement parent identity, a marker conflict, or an unstable scan
      // remains sticky/fail-closed. A previously bound child is independently
      // rechecked from the initial queue with its immutable start identity.
      await enqueueMarkedProcesses({ stable: true });
      const hasUnverifiedPendingChild = [...pendingChildren]
        .some((childPid) => !treeState.knownStarts.has(childPid));
      if (hasUnverifiedPendingChild ||
          parentAfter === null ||
          (parentAfter && parentAfter.startIdentity !== item.startIdentity) ||
          treeState.processIdentityUncertain === true) {
        treeState.processIdentityUncertain = true;
      }
      continue;
    }
    if (!stableTaskSample) {
      // Repeated task churn means at least one task's children were never
      // observed in a complete pass. Preserve every positive child candidate,
      // but keep liveness sticky so the workspace cannot be released on a
      // potentially incomplete ancestry proof.
      treeState.processIdentityUncertain = true;
    }
    for (const childPid of pendingChildren) {
      enqueue(childPid, pid, item.startIdentity);
    }
  }
  // This targeted ancestry/marker walk is not a complete process-group scan.
  processes.incomplete = true;
  return processes;
}

export async function posixProcessSnapshot({
  platform = process.platform,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
  runUtility: run = runUtility,
} = {}) {
  if (platform === "linux") return await linuxProcessSnapshot(procRoot, fsOps);
  const result = await run(
    "ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], 5_000,
    { env: { ...process.env, LC_ALL: "C", LANG: "C" } },
  );
  if (result.exitCode !== 0 || result.stdoutTruncated === true) return null;
  const processes = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const item = parsePosixProcessLine(line);
    if (!item) return null;
    processes.push(item);
  }
  processes.incomplete = false;
  return processes;
}

export function parsePosixProcessLine(line) {
  const fields = line.trim().split(/\s+/u);
  if (fields.length < 9) return null;
  const item = {
    pid: Number(fields[0]),
    parentPid: Number(fields[1]),
    processGroupId: Number(fields[2]),
    state: fields[3][0] ?? "",
    // BSD/macOS ps lstart: "Mon Aug 16 12:34:56 2026". Keeping the
    // complete timestamp lets later snapshots reject a reused PID.
    startIdentity: fields.slice(4).join(" "),
  };
  return Number.isInteger(item.pid) && Number.isInteger(item.parentPid) &&
    Number.isInteger(item.processGroupId) && item.state && item.startIdentity
    ? item : null;
}

function isLiveState(state) {
  return state !== "Z" && state !== "X" && state !== "x";
}

export async function refreshProcessTree(child, treeState, options = {}) {
  if (!Number.isInteger(child.pid)) return null;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await windowsProcessTreePids(child.pid, treeState, options);
    return null;
  }
  const processes = options.posixProcessSnapshot
    ? await options.posixProcessSnapshot(options)
    : platform === "linux"
      ? await linuxTrackedProcessSnapshot(
          child.pid,
          treeState,
          options.procRoot ?? "/proc",
          options.fsOps ?? { readdir, readFile },
          options.allowRootIdentityCapture === true,
        )
      : await posixProcessSnapshot(options);
  if (processes === null) return null;
  treeState.knownStarts ??= new Map();
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  // Remember the leader's own start identity so a later signal or liveness
  // check can detect that the PID exited and was reused by another process.
  const leader = byPid.get(child.pid);
  const expectedLeaderStart = treeState.knownStarts.get(child.pid);
  if (options.allowRootIdentityCapture === true && leader?.startIdentity &&
      !expectedLeaderStart) {
    treeState.knownStarts.set(child.pid, leader.startIdentity);
  }
  const leaderIsOriginal = Boolean(leader?.startIdentity) &&
    treeState.knownStarts.get(child.pid) === leader.startIdentity;
  const matchesKnownIdentity = (item) => {
    const expected = treeState.knownStarts.get(item.pid);
    return Boolean(expected) && Boolean(item.startIdentity) && expected === item.startIdentity;
  };
  // A recycled leader PID must not seed ancestry or process-group discovery:
  // doing so would adopt and later signal the replacement process's children.
  const parents = new Set(leaderIsOriginal ? [child.pid] : []);
  for (const pid of treeState.knownPids) {
    const item = byPid.get(pid);
    if (item && matchesKnownIdentity(item)) parents.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes) {
      if (((leaderIsOriginal && item.processGroupId === child.pid) || parents.has(item.parentPid)) &&
          !parents.has(item.pid)) {
        parents.add(item.pid);
        treeState.knownPids.add(item.pid);
        if (item.startIdentity) treeState.knownStarts.set(item.pid, item.startIdentity);
        changed = true;
      }
    }
  }
  return processes;
}

export async function isProcessTreeAlive(child, treeState, {
  ignoreZombieOnly = false,
  platform = process.platform,
  procRoot = "/proc",
  fsOps = { readdir, readFile },
  probeProcessGroup = (processGroupId) => process.kill(-processGroupId, 0),
  posixProcessSnapshot,
  runUtility: run = runUtility,
  windowsSnapshot,
} = {}) {
  if (!Number.isInteger(child.pid)) return false;
  if (platform === "win32") {
    await treeState.initialRefresh;
    return (await windowsProcessTreePids(child.pid, treeState, {
      runUtility: run, windowsSnapshot,
    })).length > 0;
  }
  let processes = await refreshProcessTree(child, treeState, {
    platform, procRoot, fsOps, posixProcessSnapshot, runUtility: run,
  });
  if (treeState.processIdentityUncertain === true) return true;
  const snapshotHasTrackedLive = (snapshot) => {
    const knownStarts = treeState.knownStarts ?? new Map();
    const leaderStart = knownStarts.get(child.pid);
    const currentLeader = snapshot.find((item) => item.pid === child.pid);
    const leaderWasReused = Boolean(currentLeader) &&
      (!leaderStart || !currentLeader.startIdentity || currentLeader.startIdentity !== leaderStart);
    const originalGroupAnchored = !leaderWasReused && snapshot.some((item) => {
      if (item.processGroupId !== child.pid || !item.startIdentity) return false;
      if (item.pid === child.pid) return Boolean(leaderStart) && item.startIdentity === leaderStart;
      const expected = knownStarts.get(item.pid);
      return treeState.knownPids.has(item.pid) && Boolean(expected) && item.startIdentity === expected;
    });
    return snapshot.some((item) => {
      if (!isLiveState(item.state)) return false;
      if (item.processGroupId === child.pid && originalGroupAnchored) return true;
      if (!treeState.knownPids.has(item.pid)) return false;
      const expected = knownStarts.get(item.pid);
      return !expected || !item.startIdentity || expected === item.startIdentity;
    });
  };
  if (processes === null) return true;
  if (processes !== null) {
    if (snapshotHasTrackedLive(processes)) return true;
    // A detached child can inherit the run marker slightly after its very
    // short-lived parent disappears from /proc. Observe for a bounded grace
    // instead of making one empty scan authoritative and releasing the lock.
    if (platform === "linux" && treeState.runMarker &&
        !processes.some((item) => item.pid === child.pid) &&
        treeState.markerObservationComplete !== true) {
      const configuredGrace = Number(treeState.markerObservationGraceMs);
      const observationGraceMs = Number.isFinite(configuredGrace) && configuredGrace >= 0
        ? configuredGrace
        : MARKER_OBSERVATION_GRACE_MS;
      const observationDeadline = Date.now() + observationGraceMs;
      while (Date.now() < observationDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        processes = await refreshProcessTree(child, treeState, {
          platform, procRoot, fsOps, posixProcessSnapshot, runUtility: run,
        });
        if (treeState.processIdentityUncertain === true) return true;
        if (processes === null) break;
        if (snapshotHasTrackedLive(processes)) return true;
      }
      treeState.markerObservationComplete = true;
    }
    if (processes !== null && ignoreZombieOnly && !processes.incomplete) {
      return treeState.processIdentityUncertain === true ? true : false;
    }
  }
  try {
    probeProcessGroup(child.pid);
  } catch (error) {
    // Only ESRCH is a reliable negative result. Permission and unexpected
    // probe errors fail safe so callers quarantine rather than reuse a live
    // workspace.
    if (treeState.processIdentityUncertain === true) return true;
    return error.code !== "ESRCH";
  }
  if (ignoreZombieOnly && platform === "linux") {
    const classification = await linuxProcessGroupHasLiveMembers(child.pid, procRoot, fsOps);
    return classification !== false;
  }
  return true;
}

export async function signalProcessTree(child, signal, treeState, {
  platform = process.platform,
  posixProcessSnapshot: snapshot = posixProcessSnapshot,
  runUtility: run = runUtility,
  windowsSnapshot,
  queryRootIdentity = windowsProcessStartIdentity,
  taskkill = async (pid) => {
    const result = await run("taskkill.exe", ["/PID", String(pid), "/F"]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "taskkill failed");
  },
  taskkillTree = async (pid) => {
    const result = await run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "taskkill /T failed");
  },
  killOne = (pid, sig) => process.kill(pid, sig),
  killGroup = (pgid, sig) => process.kill(-pgid, sig),
} = {}) {
  if (!Number.isInteger(child.pid)) return;
  if (platform === "win32") {
    await treeState.initialRefresh;
    const expectedRootIdentity = treeState.knownStarts?.get(child.pid);
    const rootHandleLive = child.exitCode === null && child.signalCode === null;
    if (rootHandleLive && !expectedRootIdentity) {
      throw new Error("cannot terminate Windows process tree: worker creation identity is unavailable");
    }
    if (rootHandleLive) {
      const observedRootIdentity = await queryRootIdentity(child.pid, run);
      if (observedRootIdentity !== expectedRootIdentity) {
        throw new Error("cannot terminate Windows process tree: worker PID creation identity changed");
      }
      if (child.exitCode === null && child.signalCode === null) {
        await taskkillTree(child.pid);
      }
    }
    const killVerified = async (pids) => {
      const order = [
        ...pids.filter((pid) => pid !== child.pid).reverse(),
        ...(pids.includes(child.pid) ? [child.pid] : []),
      ];
      for (const pid of order) {
        const expected = treeState.knownStarts.get(pid);
        let current;
        try { current = await queryRootIdentity(pid, run); }
        catch { continue; }
        if (!expected || current !== expected) continue;
        await taskkill(pid);
      }
    };
    let remaining = await windowsProcessTreePids(child.pid, treeState, {
      runUtility: run, windowsSnapshot,
    });
    await killVerified(remaining);
    remaining = await windowsProcessTreePids(child.pid, treeState, {
      runUtility: run, windowsSnapshot,
    });
    await killVerified(remaining);
    return;
  }
  await refreshProcessTree(child, treeState, {
    platform, posixProcessSnapshot: snapshot, runUtility: run,
  });
  const processes = await snapshot();
  const byPid = processes === null ? new Map() : new Map(processes.map((item) => [item.pid, item]));
  // Signal the process group only while it is still provably ours: the leader
  // must be alive, still lead the group, and match its recorded start identity.
  // Otherwise the PGID may have been recycled onto an unrelated group. When
  // enumeration itself is unavailable (restricted /proc, failing ps) identity
  // cannot be verified either way, so containment wins: signal the group rather
  // than leave a possibly-live worker running through both grace periods.
  const leaderStart = treeState.knownStarts?.get(child.pid);
  const currentLeader = processes === null ? null : byPid.get(child.pid);
  const leaderWasReused = Boolean(currentLeader) &&
    (!leaderStart || !currentLeader.startIdentity || currentLeader.startIdentity !== leaderStart);
  const groupIsOriginal = processes !== null && !leaderWasReused && processes.some((item) => {
    if (item.processGroupId !== child.pid || !item.startIdentity) return false;
    if (item.pid === child.pid) {
      return Boolean(leaderStart) && item.startIdentity === leaderStart;
    }
    const expected = treeState.knownStarts?.get(item.pid);
    return treeState.knownPids.has(item.pid) && Boolean(expected) && item.startIdentity === expected;
  });
  if (groupIsOriginal || processes === null) {
    try {
      killGroup(child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (const pid of [...treeState.knownPids].reverse()) {
    if (pid === child.pid) continue;
    const item = byPid.get(pid);
    const expected = treeState.knownStarts?.get(pid);
    // A successful snapshot proves an absent PID has exited. Never signal its
    // numeric value after the enumeration, where it could already be reused.
    if (processes !== null && !item) continue;
    if (processes !== null && (!item || !expected || !item.startIdentity ||
        expected !== item.startIdentity)) continue;
    try { killOne(pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

export async function waitForProcessTreeExit(child, timeoutMs, treeState, options = {}) {
  const deadline = Date.now() + timeoutMs;
  while (await isProcessTreeAlive(child, treeState, options)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export async function waitForChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
