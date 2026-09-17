import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isProcessTreeAlive,
  initializeProcessTree,
  linuxProcessGroupHasLiveMembers,
  parsePosixProcessLine,
  posixProcessSnapshot,
  refreshProcessTree,
  signalProcessTree,
  waitForProcessTreeExit,
  windowsProcessTreePids,
} from "../process-tree.mjs";

test("BSD ps snapshots retain process start identity for PID-reuse checks", () => {
  assert.deepEqual(
    parsePosixProcessLine(" 432  1  432 S  Sun Aug 16 12:34:56 2026"),
    {
      pid: 432,
      parentPid: 1,
      processGroupId: 432,
      state: "S",
      startIdentity: "Sun Aug 16 12:34:56 2026",
    },
  );
});

async function writeProcStat(root, pid, {
  state, group, parent = 1, startIdentity = pid, command = "worker",
}) {
  const directory = path.join(root, String(pid));
  await mkdir(directory, { recursive: true });
  const fields = [state, String(parent), String(group), String(group)];
  while (fields.length < 20) fields.push("0");
  fields[19] = String(startIdentity);
  await writeFile(path.join(directory, "stat"), `${pid} (${command}) ${fields.join(" ")}\n`);
}

async function writeTaskChildren(root, pid, children) {
  const taskDirectory = path.join(root, String(pid), "task", String(pid));
  await mkdir(taskDirectory, { recursive: true });
  await writeFile(path.join(taskDirectory, "children"), children.join(" ") + "\n");
}

async function writeRunMarker(root, pid, marker) {
  await writeFile(
    path.join(root, String(pid), "environ"),
    `PATH=/fixture\0CLI_AGENT_BRIDGE_RUN_ID=${marker}\0`,
  );
}

test("Linux ancestry refresh follows task children without scanning all of procfs", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 601, { state: "S", group: 601, startIdentity: 10 });
  await writeProcStat(procRoot, 602, {
    state: "S", group: 602, parent: 601, startIdentity: 11,
  });
  await writeTaskChildren(procRoot, 601, [602]);
  await writeTaskChildren(procRoot, 602, []);
  const fsOps = {
    readdir: async (target, options) => {
      assert.notEqual(target, procRoot, "targeted refresh must not enumerate the proc root");
      return await readdir(target, options);
    },
    readFile,
  };
  const treeState = { knownPids: new Set([601]), knownStarts: new Map() };
  const snapshot = await refreshProcessTree({ pid: 601 }, treeState, {
    platform: "linux", procRoot, fsOps, allowRootIdentityCapture: true,
  });
  assert.deepEqual(new Set(snapshot.map((item) => item.pid)), new Set([601, 602]));
  assert.equal(treeState.knownStarts.get(602), "11");
});

test("Linux falls back safely when the live main task has no children file", async () => {
  let childrenReads = 0;
  const directory = (name) => ({ name: String(name), isDirectory: () => true });
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") return [directory(100)];
      if (target === "/fixture-proc") return [directory(100), directory(200)];
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/task/100/children")) {
        childrenReads += 1;
        throw missingProcessError("ENOENT");
      }
      if (target.endsWith("/100/stat")) {
        return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
      }
      if (target.endsWith("/200/stat")) {
        return procStatLine(200, { parent: 100, group: 200, startIdentity: 20 });
      }
      throw missingProcessError();
    },
  };
  const child = { pid: 100, exitCode: null, signalCode: null };
  const treeState = { knownPids: new Set([100]), knownStarts: new Map() };
  await initializeProcessTree(child, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(treeState.linuxTaskChildrenUnavailable, true);
  assert.equal(treeState.knownStarts.get(100), "10");
  assert.equal(treeState.knownStarts.get(200), "20");
  assert.equal(treeState.processIdentityUncertain, undefined);
  await refreshProcessTree(child, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(childrenReads, 1, "capability detection is cached after the verified fallback");
});

test("Linux children-file fallback recovers a reparented marked descendant", async () => {
  const directory = (name) => ({ name: String(name), isDirectory: () => true });
  const fsOps = {
    readdir: async (target) => target === "/fixture-proc" ? [directory(300)] : [],
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) throw missingProcessError();
      if (target.endsWith("/300/stat")) {
        return procStatLine(300, { parent: 1, group: 300, startIdentity: 30 });
      }
      if (target.endsWith("/300/environ")) {
        return Buffer.from("PATH=/fixture\0CLI_AGENT_BRIDGE_RUN_ID=fallback-run\0");
      }
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]),
    knownStarts: new Map([[100, "10"]]),
    linuxTaskChildrenUnavailable: true,
    runMarker: "fallback-run",
  };
  const snapshot = await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.deepEqual(snapshot.map((item) => item.pid), [300]);
  assert.equal(treeState.knownStarts.get(300), "30");
  assert.equal(treeState.processIdentityUncertain, undefined);
});

test("Linux children-file fallback rejects an unavailable full snapshot", async () => {
  const directory = (name) => ({ name: String(name), isDirectory: () => true });
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") return [directory(100)];
      if (target === "/fixture-proc") {
        throw Object.assign(new Error("procfs denied"), { code: "EACCES" });
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/task/100/children")) throw missingProcessError("ENOENT");
      if (target.endsWith("/100/stat")) {
        return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
      }
      throw missingProcessError();
    },
  };
  const treeState = { knownPids: new Set([100]), knownStarts: new Map() };
  await assert.rejects(initializeProcessTree(
    { pid: 100, exitCode: null, signalCode: null }, treeState,
    { platform: "linux", procRoot: "/fixture-proc", fsOps },
  ), /identity was not captured/iu);
  assert.equal(treeState.processIdentityUncertain, true);
  assert.equal(treeState.knownStarts.size, 0);
});

test("Linux refresh recovers a marked detached child after its parent exits", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 702, {
    state: "S", group: 702, parent: 1, startIdentity: 22,
  });
  await writeTaskChildren(procRoot, 702, []);
  await writeRunMarker(procRoot, 702, "fixture-run");
  const treeState = {
    knownPids: new Set([701]),
    knownStarts: new Map(),
    runMarker: "fixture-run",
  };
  const snapshot = await refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot, fsOps: { readdir, readFile },
  });
  assert.deepEqual(snapshot.map((item) => item.pid), [702]);
  assert.ok(treeState.knownPids.has(702),
    "the inherited run marker preserves containment after orphan reparenting");
});

function procStatLine(pid, { state = "S", parent = 1, group = pid, startIdentity }) {
  const fields = [state, String(parent), String(group), String(group)];
  while (fields.length < 20) fields.push("0");
  fields[19] = String(startIdentity);
  return `${pid} (worker) ${fields.join(" ")}\n`;
}

function missingProcessError(code = "ENOENT") {
  return Object.assign(new Error("process exited"), { code });
}

function markerReuseFixture(startIdentities) {
  let statReads = 0;
  return {
    fsOps: {
      readdir: async (target) => target === "/fixture-proc"
        ? [{ name: "702", isDirectory: () => true }]
        : [],
      readFile: async (target) => {
        if (target.endsWith("/701/stat")) throw missingProcessError();
        if (target.endsWith("/702/environ")) {
          return Buffer.from("CLI_AGENT_BRIDGE_RUN_ID=fixture-run\0");
        }
        if (target.endsWith("/702/stat")) {
          const identity = startIdentities[Math.min(statReads, startIdentities.length - 1)];
          statReads += 1;
          return procStatLine(702, { startIdentity: identity });
        }
        throw missingProcessError();
      },
    },
    treeState: {
      knownPids: new Set([701]), knownStarts: new Map(), runMarker: "fixture-run",
    },
  };
}

test("Linux marker recovery rejects a PID reused while its environment is read", async () => {
  const { fsOps, treeState } = markerReuseFixture([22, 23]);
  await assert.rejects(refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  }), /run-marker process identity changed during inspection/iu);
  assert.ok(!treeState.knownPids.has(702));
  assert.equal(treeState.processIdentityUncertain, true);
});

test("Linux marker recovery rechecks identity before enrolling a marked PID", async () => {
  const { fsOps, treeState } = markerReuseFixture([22, 22, 23]);
  await assert.rejects(refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  }), /run-marker process identity changed between observations/iu);
  assert.ok(!treeState.knownPids.has(702));
  assert.equal(treeState.processIdentityUncertain, true);
});

test("Linux marker recovery never rebinds an already tracked PID", async () => {
  const { fsOps, treeState } = markerReuseFixture([23, 23]);
  treeState.knownPids.add(702);
  treeState.knownStarts.set(702, "22");
  const snapshot = await refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.deepEqual(snapshot.map((item) => item.pid), []);
  assert.equal(treeState.knownStarts.get(702), "22",
    "a marker cannot bless a replacement process that reused a tracked PID");
  assert.equal(treeState.processIdentityUncertain, true,
    "an identity conflict must keep later liveness checks fail-closed");
});

test("Linux marker recovery still runs when the leader PID was reused", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 701, { state: "S", group: 701, startIdentity: 99 });
  await writeTaskChildren(procRoot, 701, []);
  await writeProcStat(procRoot, 702, {
    state: "S", group: 702, parent: 1, startIdentity: 22,
  });
  await writeTaskChildren(procRoot, 702, []);
  await writeRunMarker(procRoot, 702, "fixture-run");
  const treeState = {
    knownPids: new Set([701]),
    knownStarts: new Map([[701, "10"]]),
    runMarker: "fixture-run",
  };
  const snapshot = await refreshProcessTree({ pid: 701 }, treeState, {
    platform: "linux", procRoot, fsOps: { readdir, readFile },
  });
  assert.deepEqual(snapshot.map((item) => item.pid), [702]);
  assert.equal(treeState.knownStarts.get(701), "10");
});

test("Linux liveness observes briefly for a late-visible marked child", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 802, {
    state: "S", group: 802, parent: 1, startIdentity: 33,
  });
  await writeTaskChildren(procRoot, 802, []);
  await writeRunMarker(procRoot, 802, "late-run");
  let markerScans = 0;
  const fsOps = {
    readdir: async (target, options) => {
      if (target === procRoot && ++markerScans < 3) return [];
      return await readdir(target, options);
    },
    readFile,
  };
  const treeState = {
    knownPids: new Set([801]), knownStarts: new Map(), runMarker: "late-run",
  };
  const alive = await isProcessTreeAlive({ pid: 801 }, treeState, {
    platform: "linux", procRoot, fsOps,
    probeProcessGroup: () => { const error = new Error("gone"); error.code = "ESRCH"; throw error; },
  });
  assert.equal(alive, true);
  assert.ok(markerScans >= 3, "the empty first scan must not release containment");
  assert.ok(treeState.knownPids.has(802));
});

test("Linux liveness ignores zombie-only process groups", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 101, { state: "Z", group: 77, command: "leader) name" });
  await writeProcStat(procRoot, 102, { state: "X", group: 77 });
  await writeProcStat(procRoot, 103, { state: "S", group: 88 });

  assert.equal(await linuxProcessGroupHasLiveMembers(77, procRoot), false);
});

test("Linux liveness keeps a process group with any non-zombie member", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 201, { state: "Z", group: 99 });
  await writeProcStat(procRoot, 202, { state: "D", group: 99 });

  assert.equal(await linuxProcessGroupHasLiveMembers(99, procRoot), true);
});

test("Linux liveness is unknown when no proc record matches the process group", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 250, { state: "S", group: 200 });

  assert.equal(await linuxProcessGroupHasLiveMembers(201, procRoot), null);
});

test("Linux liveness is unknown when a proc stat record is ambiguous", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  const directory = path.join(procRoot, "301");
  await mkdir(directory);
  await writeFile(path.join(directory, "stat"), "not a valid proc stat record\n");

  assert.equal(await linuxProcessGroupHasLiveMembers(101, procRoot), null);
});

test("Linux liveness is unknown when procfs is missing or restricted", async () => {
  const missingRoot = path.join(os.tmpdir(), `missing-proc-${process.pid}-${Date.now()}`);
  assert.equal(await linuxProcessGroupHasLiveMembers(401, missingRoot), null);

  const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
  const fsOps = {
    readdir: async () => [{ name: "402", isDirectory: () => true }],
    readFile: async () => { throw denied; },
  };
  assert.equal(await linuxProcessGroupHasLiveMembers(401, "/fake-proc", fsOps), null);
});

test("zombie-only groups count as exited only for the final post-SIGKILL wait", async (context) => {
  const procRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-proc-"));
  context.after(() => rm(procRoot, { recursive: true, force: true }));
  await writeProcStat(procRoot, 501, { state: "Z", group: 501 });
  const child = { pid: 501 };
  const treeState = {
    knownPids: new Set([501]), knownStarts: new Map([[501, "501"]]),
  };
  const probeProcessGroup = () => {};
  const common = { platform: "linux", procRoot, probeProcessGroup };

  assert.equal(await isProcessTreeAlive(child, treeState, common), true);
  assert.equal(await isProcessTreeAlive(child, treeState, { ...common, ignoreZombieOnly: true }), false);
  assert.equal(await waitForProcessTreeExit(child, 0, treeState, common), false);
  assert.equal(await waitForProcessTreeExit(child, 0, treeState, { ...common, ignoreZombieOnly: true }), true);
});

function snapshotOf(processes) {
  const list = processes.map((item) => ({ startIdentity: "", ...item }));
  list.incomplete = false;
  return async () => list;
}

test("the process group is signaled only while its leader identity is original", async () => {
  const child = { pid: 9001 };
  const treeState = { knownPids: new Set([9001]), knownStarts: new Map() };
  const original = snapshotOf([
    { pid: 9001, parentPid: 1, processGroupId: 9001, state: "S", startIdentity: "start-a" },
    { pid: 9002, parentPid: 9001, processGroupId: 9001, state: "S", startIdentity: "start-b" },
  ]);
  await refreshProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: original, allowRootIdentityCapture: true,
  });

  const groupSignals = [];
  const oneSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux",
    posixProcessSnapshot: original,
    killGroup: (pgid) => { groupSignals.push(pgid); },
    killOne: (pid) => { oneSignals.push(pid); },
  });
  assert.deepEqual(groupSignals, [9001], "the original group is signaled");
  assert.ok(oneSignals.includes(9002), "tracked descendants are signaled individually");

  // The leader exits; during the kill grace its PID is reused by an unrelated
  // process that leads a new group. The saved PGID must never be signaled.
  const reused = snapshotOf([
    { pid: 9002, parentPid: 1, processGroupId: 9001, state: "S", startIdentity: "start-b" },
    { pid: 9001, parentPid: 404, processGroupId: 9001, state: "S", startIdentity: "start-reused" },
  ]);
  const groupSignalsAfterReuse = [];
  await signalProcessTree(child, "SIGKILL", treeState, {
    platform: "linux",
    posixProcessSnapshot: reused,
    killGroup: (pgid) => { groupSignalsAfterReuse.push(pgid); },
    killOne: () => {},
  });
  assert.deepEqual(groupSignalsAfterReuse, [], "a reused leader identity stops group signaling");
});

test("a reused POSIX leader cannot contribute unrelated descendants", async () => {
  const child = { pid: 9300 };
  const treeState = {
    knownPids: new Set([9300]),
    knownStarts: new Map([[9300, "original-leader"]]),
  };
  const reused = snapshotOf([
    { pid: 9300, parentPid: 1, processGroupId: 9300, state: "S", startIdentity: "replacement-leader" },
    { pid: 9301, parentPid: 9300, processGroupId: 9300, state: "S", startIdentity: "unrelated-child" },
  ]);
  await refreshProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: reused,
  });
  assert.equal(treeState.knownPids.has(9301), false,
    "children of the replacement leader must not enter the tracked tree");
  const oneSignals = [];
  await signalProcessTree(child, "SIGKILL", treeState, {
    platform: "linux", posixProcessSnapshot: reused,
    killGroup: () => { throw new Error("a reused group must not be signaled"); },
    killOne: (pid) => { oneSignals.push(pid); },
  });
  assert.deepEqual(oneSignals, []);
});

test("a post-launch refresh cannot first-bind a replacement leader", async () => {
  const child = { pid: 9350 };
  const treeState = { knownPids: new Set([9350]), knownStarts: new Map() };
  const replacement = snapshotOf([
    { pid: 9350, parentPid: 1, processGroupId: 9350, state: "S", startIdentity: "replacement" },
    { pid: 9351, parentPid: 9350, processGroupId: 9350, state: "S", startIdentity: "unrelated" },
  ]);
  await refreshProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: replacement,
  });
  assert.equal(treeState.knownStarts.has(9350), false);
  assert.equal(treeState.knownPids.has(9351), false);
  const groupSignals = [];
  const oneSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux", posixProcessSnapshot: replacement,
    killGroup: (pid) => { groupSignals.push(pid); },
    killOne: (pid) => { oneSignals.push(pid); },
  });
  assert.deepEqual(groupSignals, []);
  assert.deepEqual(oneSignals, []);
});

test("a leader with an unavailable current identity cannot seed ancestry", async () => {
  const child = { pid: 9370 };
  const treeState = {
    knownPids: new Set([9370]), knownStarts: new Map([[9370, "original"]]),
  };
  const unknown = snapshotOf([
    { pid: 9370, parentPid: 1, processGroupId: 9370, state: "S", startIdentity: "" },
    { pid: 9371, parentPid: 9370, processGroupId: 9370, state: "S", startIdentity: "unrelated" },
  ]);
  await refreshProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: unknown,
  });
  assert.equal(treeState.knownPids.has(9371), false);
  const groupSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux", posixProcessSnapshot: unknown,
    killGroup: (pid) => { groupSignals.push(pid); }, killOne: () => {},
  });
  assert.deepEqual(groupSignals, []);
});

test("Linux ancestry rejects a PID reused after a stale children entry", async () => {
  let rootStatReads = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") return [];
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
      }
      if (target.endsWith("/100/task/100/children")) return "200\n";
      if (target.endsWith("/200/stat")) {
        return procStatLine(200, { parent: 999, group: 200, startIdentity: 20 });
      }
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(rootStatReads, 2);
  assert.equal(treeState.knownPids.has(200), false);
  assert.equal(treeState.processIdentityUncertain, true);
});

test("Linux ancestry rechecks the parent before accepting its children", async () => {
  let rootStatReads = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") return [];
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        return procStatLine(100, {
          parent: 1, group: 100, startIdentity: rootStatReads === 1 ? 10 : 90,
        });
      }
      if (target.endsWith("/100/task/100/children")) return "200\n";
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(treeState.knownPids.has(200), false);
  assert.equal(treeState.processIdentityUncertain, true);
});

test("Linux ancestry accepts a childless root exit only after stable empty marker scans", async () => {
  let rootStatReads = 0;
  let markerScans = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") {
        markerScans += 1;
        return [];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        if (rootStatReads === 1) {
          return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
        }
        throw missingProcessError("ESRCH");
      }
      if (target.endsWith("/100/task/100/children")) return "\n";
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(markerScans, 2,
    "a disappearing parent requires two identical full marker observations");
  assert.equal(treeState.processIdentityUncertain, undefined,
    "a stable empty marker observation proves a childless exit cleanly");
});

test("Linux ancestry tolerates runner and worker exits between stable scans", async () => {
  let rootStatReads = 0;
  let markerScans = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") {
        markerScans += 1;
        if (markerScans === 1) {
          return [200, 201].map((pid) => ({ name: String(pid), isDirectory: () => true }));
        }
        return markerScans === 2
          ? [{ name: "200", isDirectory: () => true }]
          : [];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        if (rootStatReads === 1) {
          return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
        }
        throw missingProcessError();
      }
      if (target.endsWith("/100/task/100/children")) return "\n";
      if (target.endsWith("/200/stat")) {
        return procStatLine(200, { parent: 1, group: 200, startIdentity: 20 });
      }
      if (target.endsWith("/201/stat")) {
        return procStatLine(201, { parent: 200, group: 200, startIdentity: 21 });
      }
      if (target.endsWith("/200/environ") || target.endsWith("/201/environ")) {
        return Buffer.from("CLI_AGENT_BRIDGE_RUN_ID=fixture-run\0");
      }
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(markerScans, 4,
    "successive runner/worker exits still require two final identical scans");
  assert.equal(treeState.knownPids.has(200), false);
  assert.equal(treeState.knownPids.has(201), false);
  assert.equal(treeState.processIdentityUncertain, undefined);
});

test("Linux ancestry remains uncertain when a parent exits with a pending child", async () => {
  let rootStatReads = 0;
  let markerScans = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") {
        markerScans += 1;
        return [];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        if (rootStatReads === 1) {
          return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
        }
        throw missingProcessError();
      }
      if (target.endsWith("/100/task/100/children")) return "200\n";
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(markerScans, 2);
  assert.equal(treeState.knownPids.has(200), false,
    "the unverified pending child is never enrolled after its parent disappears");
  assert.equal(treeState.processIdentityUncertain, true,
    "a pending child keeps containment fail-closed despite stable empty markers");
});

test("Linux ancestry accepts an exiting parent whose pending child was already verified", async () => {
  let rootStatReads = 0;
  let markerScans = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [{ name: "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") {
        markerScans += 1;
        return [];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        if (rootStatReads === 1) {
          return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
        }
        throw missingProcessError();
      }
      if (target.endsWith("/100/task/100/children")) return "200\n";
      if (target.endsWith("/200/stat")) throw missingProcessError("ESRCH");
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100, 200]),
    knownStarts: new Map([[100, "10"], [200, "20"]]),
    runMarker: "fixture-run",
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(markerScans, 2,
    "the parent exit still requires two identical full marker observations");
  assert.equal(treeState.processIdentityUncertain, undefined,
    "an immutable known identity is not an unverified pending child");
});

test("Linux ancestry retries a torn task sample while its parent identity remains stable", async () => {
  let rootStatReads = 0;
  let markerScans = 0;
  let taskScans = 0;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        taskScans += 1;
        return [{ name: taskScans === 1 ? "101" : "100", isDirectory: () => true }];
      }
      if (target === "/fixture-proc") {
        markerScans += 1;
        return [];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        rootStatReads += 1;
        return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
      }
      if (target.endsWith("/100/task/101/children")) throw missingProcessError();
      if (target.endsWith("/100/task/100/children")) return "\n";
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run",
  };
  const snapshot = await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(rootStatReads, 3);
  assert.equal(taskScans, 2);
  assert.equal(markerScans, 1,
    "a live verified parent recovers markers before retrying its complete task list");
  assert.deepEqual(snapshot.map((item) => item.pid), [100]);
  assert.equal(treeState.processIdentityUncertain, undefined);
});

test("Linux ancestry preserves children observed before repeated task-list churn", async () => {
  let rootAlive = true;
  const fsOps = {
    readdir: async (target) => {
      if (target === "/fixture-proc/100/task") {
        return [100, 101].map((pid) => ({ name: String(pid), isDirectory: () => true }));
      }
      if (target === "/fixture-proc/200/task") return [];
      if (target === "/fixture-proc") {
        return [{ name: "200", isDirectory: () => true }];
      }
      return [];
    },
    readFile: async (target) => {
      if (target.endsWith("/100/stat")) {
        if (!rootAlive) throw missingProcessError();
        return procStatLine(100, { parent: 1, group: 100, startIdentity: 10 });
      }
      if (target.endsWith("/200/stat")) {
        return procStatLine(200, {
          parent: rootAlive ? 100 : 1, group: 200, startIdentity: 20,
        });
      }
      if (target.endsWith("/100/task/100/children")) return "200\n";
      if (target.endsWith("/100/task/101/children")) throw missingProcessError();
      if (target.endsWith("/200/environ")) return Buffer.from("PATH=/fixture\0");
      throw missingProcessError();
    },
  };
  const treeState = {
    knownPids: new Set([100]), knownStarts: new Map([[100, "10"]]),
    runMarker: "fixture-run", markerObservationGraceMs: 0,
  };
  await refreshProcessTree({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
  });
  assert.equal(treeState.knownPids.has(200), true,
    "a child from the successful task read survives later torn task reads");
  assert.equal(treeState.knownStarts.get(200), "20");
  assert.equal(treeState.processIdentityUncertain, true,
    "repeatedly incomplete task enumeration remains fail-closed");

  rootAlive = false;
  const alive = await isProcessTreeAlive({ pid: 100 }, treeState, {
    platform: "linux", procRoot: "/fixture-proc", fsOps,
    probeProcessGroup: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  });
  assert.equal(alive, true,
    "the escaped unmarked child cannot make the uncertain tree look terminated");
});

test("POSIX startup cannot bind a replacement after the child handle exits", async () => {
  const child = { pid: 9380, exitCode: null, signalCode: null };
  const treeState = { knownPids: new Set([9380]), knownStarts: new Map() };
  await assert.rejects(initializeProcessTree(child, treeState, {
    platform: "linux",
    posixProcessSnapshot: async () => {
      child.exitCode = 0;
      return [{
        pid: 9380, parentPid: 1, processGroupId: 9380,
        state: "S", startIdentity: "replacement",
      }];
    },
  }), /identity was not captured while its process handle was live/iu);
  assert.equal(treeState.knownStarts.size, 0);
});

test("POSIX startup fails closed when the root identity is unavailable", async () => {
  const child = { pid: 9390, exitCode: null, signalCode: null };
  const treeState = { knownPids: new Set([9390]), knownStarts: new Map() };
  await assert.rejects(initializeProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: async () => [],
  }), /identity was not captured/iu);
});

test("POSIX startup fails closed when process enumeration is unavailable", async () => {
  const child = { pid: 9391, exitCode: null, signalCode: null };
  const treeState = { knownPids: new Set([9391]), knownStarts: new Map() };
  await assert.rejects(initializeProcessTree(child, treeState, {
    platform: "linux", posixProcessSnapshot: async () => null,
  }), /identity was not captured/iu);
});

test("an unavailable POSIX snapshot keeps an escaped tree fail-closed", async () => {
  const child = { pid: 9392 };
  const treeState = {
    knownPids: new Set([9392, 9393]),
    knownStarts: new Map([[9392, "root"], [9393, "escaped"]]),
  };
  assert.equal(await isProcessTreeAlive(child, treeState, {
    platform: "linux", posixProcessSnapshot: async () => null,
    probeProcessGroup: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); },
  }), true);
});

test("a verified surviving member anchors its original POSIX process group", async () => {
  const child = { pid: 9395 };
  const treeState = {
    knownPids: new Set([9395, 9396]),
    knownStarts: new Map([[9395, "root"], [9396, "anchor"]]),
  };
  const snapshot = snapshotOf([
    { pid: 9396, parentPid: 1, processGroupId: 9395, state: "Z", startIdentity: "anchor" },
    { pid: 9397, parentPid: 1, processGroupId: 9395, state: "S", startIdentity: "sibling" },
  ]);
  assert.equal(await isProcessTreeAlive(child, treeState, {
    platform: "linux", posixProcessSnapshot: snapshot, ignoreZombieOnly: true,
  }), true, "a live sibling keeps the identity-anchored original group alive");
  const groupSignals = [];
  await signalProcessTree(child, "SIGKILL", treeState, {
    platform: "linux", posixProcessSnapshot: snapshot,
    killGroup: (pid) => { groupSignals.push(pid); }, killOne: () => {},
  });
  assert.deepEqual(groupSignals, [9395], "group signaling covers siblings missed by ancestry polling");
});

test("tracked POSIX PIDs absent from a successful signal snapshot are skipped", async () => {
  const child = { pid: 9400 };
  const treeState = {
    knownPids: new Set([9400, 9401]),
    knownStarts: new Map([[9400, "leader"], [9401, "exited-child"]]),
  };
  const snapshot = snapshotOf([
    { pid: 9400, parentPid: 1, processGroupId: 9400, state: "S", startIdentity: "leader" },
  ]);
  const oneSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux", posixProcessSnapshot: snapshot,
    killGroup: () => {}, killOne: (pid) => { oneSignals.push(pid); },
  });
  assert.deepEqual(oneSignals, [], "the stale numeric PID could already belong to another process");
});

test("windows tree inspection drops known PIDs whose creation identity changed", async () => {
  const treeState = {
    knownPids: new Set([500, 501]),
    knownStarts: new Map([[500, "100"], [501, "200"]]),
  };
  const fakeUtility = async (command, args) => {
    assert.match(args.join(" "), /CreationTicks/u, "the CIM projection must request creation times");
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        { ProcessId: 500, ParentProcessId: 1, CreationTicks: "300" },
        { ProcessId: 501, ParentProcessId: 500, CreationTicks: "200" },
        { ProcessId: 502, ParentProcessId: 501, CreationTicks: "400" },
      ]),
      stderr: "",
    };
  };
  const pids = await windowsProcessTreePids(500, treeState, { runUtility: fakeUtility });
  assert.ok(pids.includes(501) && pids.includes(502), "genuine descendants are kept");
  assert.ok(!pids.includes(500), "the reused root PID is dropped from the tree");
  assert.ok(!treeState.knownPids.has(500), "the reused PID leaves the tracked set");
  assert.equal(treeState.knownStarts.get(500), "100", "the original identity is retained for comparison");
});

test("Windows startup binds the root identity only while its child handle is live", async () => {
  const live = { pid: 10, exitCode: null, signalCode: null };
  const liveState = { knownPids: new Set([10]), knownStarts: new Map() };
  await initializeProcessTree(live, liveState, {
    platform: "win32", queryRootIdentity: async () => "100",
  });
  assert.equal(liveState.knownStarts.get(10), "100");

  const exited = { pid: 20, exitCode: null, signalCode: null };
  const exitedState = { knownPids: new Set([20]), knownStarts: new Map() };
  await assert.rejects(initializeProcessTree(exited, exitedState, {
    platform: "win32",
    queryRootIdentity: async () => {
      exited.exitCode = 0;
      return "200";
    },
  }), /exited before startup identity/iu);
  assert.equal(exitedState.knownStarts.has(20), false);
});

test("Windows tracking fails closed after startup identity capture fails", async () => {
  const child = { pid: 10, exitCode: 0, signalCode: null };
  const treeState = {
    knownPids: new Set([10]), knownStarts: new Map(),
    windowsRootIdentityAttempted: true,
  };
  await assert.rejects(isProcessTreeAlive(child, treeState, {
    platform: "win32", windowsSnapshot: async () => [],
  }), /identity was not captured/iu);
});

test("Windows tracking rejects children older than their verified parent", async () => {
  const child = { pid: 10, exitCode: null, signalCode: null };
  const treeState = {
    knownPids: new Set([10]), knownStarts: new Map([[10, "300"]]),
  };
  assert.equal(await isProcessTreeAlive(child, treeState, {
    platform: "win32",
    windowsSnapshot: async () => [
      { pid: 10, parentPid: 1, startIdentity: "300" },
      { pid: 20, parentPid: 10, startIdentity: "200" },
    ],
  }), true);
  assert.equal(treeState.knownPids.has(20), false);
});

test("Windows tracking fails closed for a new child of a disappeared known parent", async () => {
  const child = { pid: 10, exitCode: 0, signalCode: null };
  const treeState = {
    knownPids: new Set([10, 20]),
    knownStarts: new Map([[10, "100"], [20, "200"]]),
  };
  await assert.rejects(isProcessTreeAlive(child, treeState, {
    platform: "win32",
    windowsSnapshot: async () => [{ pid: 30, parentPid: 20, startIdentity: "300" }],
  }), /unverified descendant remained/iu);
});

test("Windows tracking fails closed for an older child of a reused parent PID", async () => {
  const child = { pid: 10, exitCode: 0, signalCode: null };
  const treeState = {
    knownPids: new Set([10, 20]),
    knownStarts: new Map([[10, "100"], [20, "200"]]),
  };
  await assert.rejects(isProcessTreeAlive(child, treeState, {
    platform: "win32",
    windowsSnapshot: async () => [
      { pid: 20, parentPid: 1, startIdentity: "400" },
      { pid: 30, parentPid: 20, startIdentity: "300" },
    ],
  }), /unverified descendant remained/iu);
});

test("Windows signaling never binds or kills a reused root after exit", async () => {
  const child = { pid: 10, exitCode: 0, signalCode: null };
  const treeState = { knownPids: new Set([10]), knownStarts: new Map() };
  const killed = [];
  await assert.rejects(signalProcessTree(child, "SIGKILL", treeState, {
    platform: "win32",
    windowsSnapshot: async () => [{ pid: 10, parentPid: 1, startIdentity: "300" }],
    taskkill: async (pid) => { killed.push(pid); },
    taskkillTree: async (pid) => { killed.push(pid); },
  }), /identity was not captured/iu);
  assert.deepEqual(killed, []);
});

test("Windows tree signaling revalidates the live root before taskkill tree", async () => {
  const child = { pid: 10, exitCode: null, signalCode: null };
  const treeState = {
    knownPids: new Set([10]), knownStarts: new Map([[10, "100"]]),
  };
  const killedTrees = [];
  await assert.rejects(signalProcessTree(child, "SIGKILL", treeState, {
    platform: "win32",
    queryRootIdentity: async () => "101",
    windowsSnapshot: async () => [],
    taskkillTree: async (pid) => { killedTrees.push(pid); },
  }), /creation identity changed/iu);
  assert.deepEqual(killedTrees, []);
});

test("the group is still signaled when process enumeration is unavailable", async () => {
  const child = { pid: 9200 };
  const treeState = { knownPids: new Set([9200]), knownStarts: new Map() };
  await refreshProcessTree(child, treeState, {
    platform: "linux",
    posixProcessSnapshot: async () => [{ pid: 9200, parentPid: 1, processGroupId: 9200, state: "S", startIdentity: "start-z" }],
    allowRootIdentityCapture: true,
  });
  const groupSignals = [];
  await signalProcessTree(child, "SIGTERM", treeState, {
    platform: "linux",
    posixProcessSnapshot: async () => null,
    killGroup: (pgid) => { groupSignals.push(pgid); },
    killOne: () => {},
  });
  assert.deepEqual(groupSignals, [9200],
    "containment wins when identity cannot be verified: the group is signaled");
});

test("BSD process snapshots reject truncation and malformed records", async () => {
  const valid = "10 1 10 S Mon Jan  1 00:00:00 2024\n";
  assert.equal(await posixProcessSnapshot({
    platform: "darwin",
    runUtility: async () => ({ exitCode: 0, stdout: valid, stdoutTruncated: true }),
  }), null);
  assert.equal(await posixProcessSnapshot({
    platform: "darwin",
    runUtility: async () => ({ exitCode: 0, stdout: valid + "malformed\n" }),
  }), null);
});
