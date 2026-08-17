import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  localHostIdentity, WORKSPACE_LOCK_REF_PREFIX, workspaceLockRef,
} from "../workspace-lock.mjs";
import {
  resolvePathCommand, safeGitInvocation, subscribePathCommand, subscribeTrustedGitExecutable,
  trustedGitExecutable,
} from "../git-executable.mjs";
import {
  backendEntryFromProbe, backendGitProvenanceEnvironment, closestExistingBase, committedDelta,
  loadBackends, markWorkspaceQuarantined,
  populateCommitishCache, readBackendGitProvenance, runCommand, runGitCommand,
} from "../server.mjs";

const execFileAsync = promisify(execFile);
const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testsRoot, "..");
const serverPath = path.join(pluginRoot, "server.mjs");
const fakeBackendPath = path.join(testsRoot, "fake-backend.mjs");
const requestKey = (id) => typeof id + ":" + String(id);

test("failed backend command resolutions are retried after installation", async (context) => {
  const binRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-resolution-retry-test-"));
  context.after(() => rm(binRoot, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  process.env.PATH = binRoot + path.delimiter + (originalPath ?? "");
  context.after(() => { process.env.PATH = originalPath; });
  const command = "late-installed-backend-" + String(process.pid) + "-" + String(Date.now());
  const first = resolvePathCommand(command);
  const concurrent = resolvePathCommand(command);
  assert.equal(first, concurrent, "concurrent callers should share one filesystem lookup");
  assert.deepEqual(await Promise.all([first, concurrent]), [null, null]);

  const executable = path.join(binRoot, command + (process.platform === "win32" ? ".exe" : ""));
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  assert.equal(await resolvePathCommand(command), await realpath(executable));
});

test("abandoned command-resolution waiters detach from the shared lookup", async (context) => {
  const binRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-resolution-waiter-test-"));
  context.after(() => rm(binRoot, { recursive: true, force: true }));
  const originalPath = process.env.PATH;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDelay = process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS;
  process.env.PATH = binRoot + path.delimiter + (originalPath ?? "");
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS = "100";
  context.after(() => {
    process.env.PATH = originalPath;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDelay === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS;
    else process.env.CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS = originalDelay;
  });
  const command = "detachable-backend-" + String(process.pid) + "-" + String(Date.now());
  const executable = path.join(binRoot, command + (process.platform === "win32" ? ".exe" : ""));
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  let callbacks = 0;
  const unsubscribe = subscribePathCommand(
    command,
    () => { callbacks += 1; },
    () => { callbacks += 1; },
  );
  unsubscribe();
  assert.equal(await resolvePathCommand(command), await realpath(executable));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks, 0, "a cancelled/deadline waiter must not be retained until core lookup settles");
});

test("trusted Git resolution caches success while abandoned waiters stay detached", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-git-entry-test-"));
  const startedFile = path.join(root, "started.txt");
  context.after(() => rm(root, { recursive: true, force: true }));
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    delay: process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS,
    started: process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE,
  };
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS = "100";
  process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE = startedFile;
  context.after(() => {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.delay === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS;
    else process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS = saved.delay;
    if (saved.started === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE;
    else process.env.CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE = saved.started;
  });

  let abandonedCallbacks = 0;
  const unsubscribePending = subscribeTrustedGitExecutable(
    () => { abandonedCallbacks += 1; }, () => { abandonedCallbacks += 1; },
  );
  unsubscribePending();
  const first = await trustedGitExecutable();
  assert.equal(first, await realpath(first));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abandonedCallbacks, 0);
  assert.equal((await readFile(startedFile, "utf8")).trim().split(/\r?\n/u).length, 1);
  assert.equal(await trustedGitExecutable(), first, "the canonical positive result must stay cached");
  assert.equal((await readFile(startedFile, "utf8")).trim().split(/\r?\n/u).length, 1,
    "a positive cached result must not restart filesystem resolution");

  const unsubscribeSettled = subscribeTrustedGitExecutable(
    () => { abandonedCallbacks += 1; }, () => { abandonedCallbacks += 1; },
  );
  unsubscribeSettled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abandonedCallbacks, 0,
    "same-tick unsubscribe must suppress an already-settled queued callback");
});

test("failed trusted Git resolutions are retried", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-git-retry-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  process.env.PATH = root;
  context.after(() => { process.env.PATH = savedPath; });
  const module = await import(new URL(
    "../git-executable.mjs?git-retry=" + encodeURIComponent(String(Date.now())), import.meta.url,
  ));
  await assert.rejects(module.trustedGitExecutable(), /cannot locate git/iu);
  const executable = path.join(root, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(executable, "fixture\n");
  if (process.platform !== "win32") await chmod(executable, 0o755);
  assert.equal(await module.trustedGitExecutable(), await realpath(executable));
});

test("safe Git invocations use an unpopulatable hook sink and ignore inherited repositories", async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-safe-git-env-test-"));
  const workspace = path.join(tempRoot, "workspace");
  const unrelated = path.join(tempRoot, "unrelated.git");
  await mkdir(workspace);
  await initializeFixtureRepository(workspace);
  await execFileAsync("git", ["init", "--bare", unrelated]);
  context.after(() => rm(tempRoot, { recursive: true, force: true }));

  const invocation = await safeGitInvocation(["rev-parse", "--git-common-dir"], {
    ...process.env,
    GIT_COMMON_DIR: unrelated,
    Git_Dir: unrelated,
    GIT_NAMESPACE: "foreign-namespace",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.join(tempRoot, "attacker-controlled-hooks"),
  });
  assert.ok(invocation.args.includes("core.hooksPath=/dev/null"));
  assert.deepEqual(
    Object.keys(invocation.env).filter((name) => /^GIT_/iu.test(name)).sort(),
    ["GIT_OPTIONAL_LOCKS", "GIT_PAGER"],
  );
  const { stdout } = await execFileAsync(invocation.command, invocation.args, {
    cwd: workspace,
    env: invocation.env,
  });
  assert.equal(
    await realpath(path.resolve(workspace, stdout.trim())),
    await realpath(path.join(workspace, ".git")),
  );

  const tracePath = path.join(tempRoot, "packet.trace");
  const backendEnv = backendGitProvenanceEnvironment(tracePath, {
    ...process.env,
    GIT_COMMON_DIR: unrelated,
    GIT_DIR: unrelated,
    GIT_WORK_TREE: tempRoot,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.worktree",
    GIT_CONFIG_VALUE_0: tempRoot,
    GIT_REFLOG_ACTION: "fetch",
    GIT_TRACE2_EVENT: path.join(tempRoot, "attacker-trace2"),
    git_config_count: "1",
    git_config_key_0: "core.abbrev",
    git_config_value_0: "12",
  });
  assert.equal(backendEnv.GIT_COMMON_DIR, undefined);
  assert.equal(backendEnv.GIT_DIR, undefined);
  assert.equal(backendEnv.GIT_WORK_TREE, undefined);
  assert.equal(backendEnv.GIT_CONFIG_COUNT, undefined);
  assert.equal(backendEnv.GIT_REFLOG_ACTION, undefined);
  assert.equal(backendEnv.GIT_TRACE_PACKET, undefined);
  assert.equal(backendEnv.GIT_TRACE2_EVENT, tracePath);
  const backendDiscovery = await execFileAsync(invocation.command, ["rev-parse", "--git-common-dir"], {
    cwd: workspace, env: backendEnv,
  });
  assert.equal(
    await realpath(path.resolve(workspace, backendDiscovery.stdout.trim())),
    await realpath(path.join(workspace, ".git")),
  );
});

test("delegated workers ignore inherited Git routing while preserving authentication", async (context) => {
  const unrelatedRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-worker-routing-test-"));
  const unrelated = path.join(unrelatedRoot, "unrelated");
  await mkdir(unrelated);
  await initializeFixtureRepository(unrelated);
  context.after(() => rm(unrelatedRoot, { recursive: true, force: true }));
  const { stdout: unrelatedHeadText } = await execFileAsync(
    "git", ["rev-parse", "HEAD"], { cwd: unrelated },
  );
  const authentication = {
    GIT_SSH_COMMAND: "ssh -F preserved-fixture-config",
    GH_TOKEN: "preserved-fixture-token",
  };
  const { tempRoot, workspace, client } = await makeHarness(context, {
    extraEnv: {
      GIT_DIR: path.join(unrelated, ".git"),
      GIT_WORK_TREE: unrelated,
      GIT_INDEX_FILE: path.join(unrelated, ".git", "index"),
      GIT_CEILING_DIRECTORIES: unrelatedRoot,
    GIT_NO_REPLACE_OBJECTS: null,
      ...authentication,
    },
  });
  const environmentFile = path.join(tempRoot, "delegated-environment.json");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "sanitized-worker-routing",
    commitCurrent: true,
    writeFile: "target-worker.txt",
    commitMessage: "commit in requested workspace",
    environmentFile,
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.commits.log, /commit in requested workspace/u);
  await access(path.join(workspace, "target-worker.txt"));
  await assert.rejects(access(path.join(unrelated, "target-worker.txt")), /ENOENT/u);
  const { stdout: unrelatedAfter } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: unrelated,
  });
  assert.equal(unrelatedAfter.trim(), unrelatedHeadText.trim());
  assert.deepEqual(JSON.parse(await readFile(environmentFile, "utf8")), {
    GIT_DIR: null,
    GIT_WORK_TREE: null,
    GIT_INDEX_FILE: null,
    GIT_CEILING_DIRECTORIES: null,
    GIT_NO_REPLACE_OBJECTS: null,
    ...authentication,
  });
});

function unconfirmedGitResult(overrides = {}) {
  return {
    stdout: "", stderr: "", exitCode: null, timedOut: false, killed: true,
    orphanedProcesses: true, treeTerminated: false,
    terminationError: "fixture descendants remain uncertain",
    errorMessage: "", spawnError: null,
    stdoutTruncated: false, stderrTruncated: false,
    ...overrides,
  };
}

test("Git interruption never outruns unconfirmed descendant quarantine", async () => {
  const cancelled = { cancelled: false, controller: null };
  const cancelledResult = await runGitCommand(["version"], {
    cwd: pluginRoot,
    cancel: cancelled,
    containProcessTree: true,
    commandRunner: async () => {
      cancelled.cancelled = true;
      return unconfirmedGitResult();
    },
  });
  assert.equal(cancelledResult.treeTerminated, false,
    "the snapshot caller must receive the unsafe cleanup result before cancellation is reported");

  const deadline = Date.now() + 40;
  const deadlineResult = await runGitCommand(["version"], {
    cwd: pluginRoot,
    deadline,
    containProcessTree: true,
    commandRunner: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return unconfirmedGitResult({ timedOut: true });
    },
  });
  assert.equal(deadlineResult.treeTerminated, false,
    "the snapshot caller must receive the unsafe cleanup result before the deadline is reported");
});

test("Git commands do not launch after invocation setup crosses the deadline", async (context) => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedDelay = process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS;
  await trustedGitExecutable();
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS = "100";
  context.after(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedDelay === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS;
    else process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS = savedDelay;
  });
  let runnerCalls = 0;
  await assert.rejects(runGitCommand(["version"], {
    cwd: pluginRoot,
    deadline: Date.now() + 50,
    commandRunner: async () => {
      runnerCalls += 1;
      return unconfirmedGitResult({ treeTerminated: true, terminationError: "" });
    },
  }), /deadline/iu);
  assert.equal(runnerCalls, 0);
});

test("committed-delta baseline preparation uses bounded batch queries", async () => {
  const target = "a".repeat(40);
  const boundary = "b".repeat(40);
  const baselines = Array.from({ length: 1_000 }, (_, index) =>
    index.toString(16).padStart(40, "0"));
  const invocations = [];
  const cache = new Map();
  await populateCommitishCache(pluginRoot, baselines, cache, {
    commandRunner: async (_command, args, options) => {
      invocations.push({ args, stdinText: options.stdinText });
      const stdout = options.stdinText.trim().split("\n").map((revision) =>
        revision.replace(/\^\{commit\}$/u, "") + " commit").join("\n") + "\n";
      return {
        ...unconfirmedGitResult(), stdout, exitCode: 0, killed: false,
        orphanedProcesses: false, treeTerminated: true, terminationError: "",
      };
    },
  });
  assert.equal(cache.size, baselines.length);
  assert.equal(invocations.length, 1, "ref count must not determine cat-file process count");

  const selected = await closestExistingBase(pluginRoot, target, baselines, {
    commandRunner: async (_command, args, options) => {
      invocations.push({ args, stdinText: options.stdinText });
      return {
        ...unconfirmedGitResult(),
        stdout: target + "\n-" + boundary + "\n",
        exitCode: 0,
        killed: false,
        orphanedProcesses: false,
        treeTerminated: true,
        terminationError: "",
      };
    },
  });
  assert.equal(selected, boundary);
  assert.equal(invocations.length, 2, "baseline selection must add only one graph process");
  assert.equal(invocations[1].stdinText.trim().split("\n").length, baselines.length);
  assert.ok(invocations[1].args.includes("--boundary"));
});

test("post-exit process-tree inspection failures settle fail-closed", async () => {
  const result = await runCommand(process.execPath, ["-e", ""], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    initializeProcessTree: async () => {},
    inspectProcessTree: async () => { throw new Error("inspection unavailable"); },
  });
  assert.equal(result.treeTerminated, false);
  assert.match(result.terminationError, /process-tree inspection failed: inspection unavailable/iu);
});

test("post-exit inspection waits for an in-flight ancestry refresh", async () => {
  let refreshStartedResolve;
  let releaseRefresh;
  const refreshStarted = new Promise((resolve) => { refreshStartedResolve = resolve; });
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let inspectedAfterRefresh = false;
  let resolved = false;
  const pending = runCommand(process.execPath, ["-e", "setTimeout(()=>{},1300)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    initializeProcessTree: async () => {},
    refreshProcessTree: async (_child, state) => {
      refreshStartedResolve();
      await refreshGate;
      state.completedRefresh = true;
    },
    inspectProcessTree: async (_child, state) => {
      inspectedAfterRefresh = state.completedRefresh === true;
      return false;
    },
  });
  void pending.then(() => { resolved = true; });
  await refreshStarted;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(resolved, false, "close must not settle ahead of the active ancestry refresh");
  releaseRefresh();
  const result = await pending;
  assert.equal(result.treeTerminated, true);
  assert.equal(inspectedAfterRefresh, true);
});

test("periodic process-tree polling starts only after initialization", async () => {
  let releaseInitialization;
  const initializationGate = new Promise((resolve) => { releaseInitialization = resolve; });
  let initializing = true;
  let refreshCalls = 0;
  let refreshRaced = false;
  const pending = runCommand(process.execPath, ["-e", "setTimeout(()=>{},1200)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    initializeProcessTree: async (_child, state) => {
      await initializationGate;
      state.fixtureRootIdentity = true;
      initializing = false;
    },
    refreshProcessTree: async (_child, state) => {
      refreshCalls += 1;
      if (initializing || state.fixtureRootIdentity !== true) refreshRaced = true;
    },
    inspectProcessTree: async () => false,
  });

  // Windows test-mode polling uses the production 250 ms interval; hold the
  // initializer beyond that boundary so this deterministically fails if the
  // timer is ever installed before the startup barrier completes.
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(refreshCalls, 0, "the timer must not inspect a partially initialized tree");
  releaseInitialization();
  await waitFor(() => refreshCalls > 0);
  const result = await pending;
  assert.equal(refreshRaced, false);
  assert.equal(result.treeTerminated, true, JSON.stringify(result));
});

test("runner exit starts tree cleanup before escaped descendants close inherited streams", {
  skip: process.platform === "win32" ? "POSIX process-group fixture" : false,
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-exit-before-close-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "escaped.pid");
  let escapedPid = null;
  context.after(() => {
    if (Number.isInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)']," +
      "{detached:true,stdio:['ignore',process.stdout,process.stderr]})",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
    "child.unref()",
  ].join(";");
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ["-e", parentCode], {
    cwd: root,
    manageProcessTree: true,
    timeoutMs: 3_000,
    initializeProcessTree: async () => {},
    refreshProcessTree: async () => {},
    inspectProcessTree: async () => {
      escapedPid = Number(await readFile(pidFile, "utf8"));
      return true;
    },
    signalProcessTree: async (_child, signal) => {
      if (Number.isInteger(escapedPid)) {
        try { process.kill(escapedPid, signal); } catch { /* already gone */ }
      }
    },
    waitForProcessTreeExit: async () => true,
  });
  assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.equal(result.orphanedProcesses, true);
  assert.ok(Date.now() - startedAt < 2_500,
    "tree inspection must start on exit instead of waiting for descendant-held stream handles");
});

test("stream draining cannot finalize ahead of termination started after exit", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-drain-termination-race-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, "stream-holder.pid");
  let escapedPid = null;
  let controller;
  let signalStartedResolve;
  let releaseSignal;
  const signalStarted = new Promise((resolve) => { signalStartedResolve = resolve; });
  const signalGate = new Promise((resolve) => { releaseSignal = resolve; });
  context.after(() => {
    if (Number.isInteger(escapedPid)) {
      try { process.kill(escapedPid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    "const fs=require('node:fs')",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},20000)']," +
      "{detached:true,stdio:['ignore',process.stdout,process.stderr]})",
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
    "child.unref()",
  ].join(";");
  let resolved = false;
  const pending = runCommand(process.execPath, ["-e", parentCode], {
    cwd: root,
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    killGraceMs: 250,
    streamDrainMs: 250,
    initializeProcessTree: async () => {},
    refreshProcessTree: async () => {},
    inspectProcessTree: async () => false,
    signalProcessTree: async (_child, signal) => {
      signalStartedResolve();
      await signalGate;
      if (Number.isInteger(escapedPid)) {
        try { process.kill(escapedPid, signal); } catch { /* already gone */ }
      }
    },
    waitForProcessTreeExit: async () => true,
    onChild: (value) => { controller = value; },
  });
  void pending.then(() => { resolved = true; });
  await waitFor(async () => {
    try { escapedPid = Number(await readFile(pidFile, "utf8")); return true; } catch { return false; }
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  const terminating = controller.terminate("cancelled");
  await signalStarted;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(resolved, false, "stream timeout must still wait for active termination cleanup");
  releaseSignal();
  const result = await pending;
  await terminating;
  assert.equal(result.timedOut, false);
  await waitFor(async () => {
    try {
      if (process.platform === "linux") {
        const statLine = await readFile("/proc/" + String(escapedPid) + "/stat", "utf8");
        const state = statLine.slice(statLine.lastIndexOf(")") + 1).trim().split(/\s+/u)[0];
        return ["Z", "X", "x"].includes(state);
      }
      process.kill(escapedPid, 0);
      return false;
    } catch { return true; }
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  escapedPid = null;
});

test("post-exit inspection cannot settle ahead of concurrent termination", async () => {
  let controller;
  let inspectionStartedResolve;
  let releaseInspection;
  let signalStartedResolve;
  let releaseSignal;
  const inspectionStarted = new Promise((resolve) => { inspectionStartedResolve = resolve; });
  const inspectionGate = new Promise((resolve) => { releaseInspection = resolve; });
  const signalStarted = new Promise((resolve) => { signalStartedResolve = resolve; });
  const signalGate = new Promise((resolve) => { releaseSignal = resolve; });
  let resolved = false;
  const pending = runCommand(process.execPath, ["-e", ""], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    initializeProcessTree: async () => {},
    refreshProcessTree: async () => {},
    inspectProcessTree: async () => {
      inspectionStartedResolve();
      await inspectionGate;
      return false;
    },
    signalProcessTree: async () => {
      signalStartedResolve();
      await signalGate;
    },
    waitForProcessTreeExit: async () => true,
    onChild: (value) => { controller = value; },
  });
  void pending.then(() => { resolved = true; });
  await inspectionStarted;
  const terminating = controller.terminate("test-race");
  await signalStarted;
  releaseInspection();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resolved, false, "close must await termination started during inspection");
  releaseSignal();
  const result = await pending;
  await terminating;
  assert.equal(result.treeTerminated, true);
});

test("cancellation published with the controller waits for tree initialization", async () => {
  let cancellationChecks = 0;
  let releaseInitialization;
  let signalStarted = false;
  const initializationGate = new Promise((resolve) => { releaseInitialization = resolve; });
  const pending = runCommand(process.execPath, ["-e", "process.exit(99)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    shouldCancel: () => {
      cancellationChecks += 1;
      return cancellationChecks >= 2;
    },
    initializeProcessTree: async () => { await initializationGate; },
    signalProcessTree: async (child) => {
      signalStarted = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    },
    waitForProcessTreeExit: async () => true,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(signalStarted, false, "termination must not outrun startup identity capture");
  releaseInitialization();
  const result = await pending;
  assert.equal(signalStarted, true);
  assert.equal(result.timedOut, false);
});

test("the first termination reason remains authoritative", async () => {
  let controller;
  const pending = runCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    killGraceMs: 250,
    initializeProcessTree: async () => {},
    signalProcessTree: async (child, signal) => {
      try { child.kill(signal); } catch { /* already gone */ }
    },
    waitForProcessTreeExit: async () => true,
    onChild: (value) => { controller = value; },
  });
  assert.ok(controller);
  const cancelled = controller.terminate("cancelled");
  const sameTermination = controller.terminate("timeout");
  assert.equal(cancelled, sameTermination);
  const result = await pending;
  await cancelled;
  assert.equal(result.timedOut, false,
    "a later timer must not relabel an already-started cancellation as a timeout");
});

test("process-tree refresh uncertainty is sticky and cleanup waits are bounded", async () => {
  let refreshStarted = false;
  const result = await runCommand(process.execPath, ["-e", "setTimeout(()=>{},400)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 3_000,
    killGraceMs: 250,
    processTreeInspectionWaitMs: 50,
    streamDrainMs: 50,
    initializeProcessTree: async () => {},
    refreshProcessTree: async () => {
      refreshStarted = true;
      await new Promise(() => {});
    },
    signalProcessTree: async () => {},
    waitForProcessTreeExit: async () => true,
    inspectProcessTree: async () => false,
  });
  assert.equal(refreshStarted, true);
  assert.equal(result.treeTerminated, false);
  assert.match(result.terminationError, /process-tree refresh did not finish/iu);
});

test("a post-spawn child error cannot finalize ahead of termination cleanup", async () => {
  let signalStartedResolve;
  let releaseSignal;
  const signalStarted = new Promise((resolve) => { signalStartedResolve = resolve; });
  const signalGate = new Promise((resolve) => { releaseSignal = resolve; });
  let resolved = false;
  const pending = runCommand(process.execPath, ["-e", "setTimeout(()=>{},5000)"], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    killGraceMs: 250,
    initializeProcessTree: async () => {},
    signalProcessTree: async (child, signal) => {
      signalStartedResolve();
      await signalGate;
      try { child.kill(signal); } catch { /* already gone */ }
    },
    waitForProcessTreeExit: async () => true,
    onChild: ({ child }) => {
      setImmediate(() => {
        const error = new Error("fixture post-spawn failure");
        error.code = "EIO";
        child.emit("error", error);
      });
    },
  });
  void pending.then(() => { resolved = true; });
  await signalStarted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resolved, false);
  releaseSignal();
  const result = await pending;
  assert.equal(result.treeTerminated, false);
  assert.equal(result.spawnError, null,
    "a runtime child error must never be mistaken for a pre-spawn failure and retried");
  assert.match(result.terminationError, /backend process error after spawn/iu);
});

test("a controller cannot terminate again after runCommand settles", async () => {
  let controller;
  let signals = 0;
  const result = await runCommand(process.execPath, ["-e", ""], {
    manageProcessTree: true,
    processTreeTestMode: true,
    timeoutMs: 5_000,
    initializeProcessTree: async () => {},
    inspectProcessTree: async () => false,
    signalProcessTree: async () => { signals += 1; },
    waitForProcessTreeExit: async () => true,
    onChild: (value) => { controller = value; },
  });
  assert.equal(result.treeTerminated, true);
  assert.equal(signals, 0);
  await controller.terminate("late-ownership-loss");
  assert.equal(signals, 0, "a settled controller must never signal a reused numeric process id");
});

test("Windows Job runner contains launch and preserves backend streams and exit code", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-job-runner-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const backend = path.join(root, "backend-fixture.cmd");
  await writeFile(path.join(root, "powershell.exe"), "workspace shadow must not execute\n");
  await writeFile(backend, [
    "@echo off",
    "echo job-stdout-ok",
    "echo job-stderr-ok 1>&2",
    "exit /b 37",
    "",
  ].join("\r\n"));
  const result = await runCommand(backend, [], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 37, JSON.stringify(result));
  assert.match(result.stdout, /job-stdout-ok/u);
  assert.match(result.stderr, /job-stderr-ok/u);
  assert.equal(result.treeTerminated, true);

  const exactArgument = "任务 \"quoted\" % (x) & caret^";
  const exact = await runCommand(process.execPath, [
    "-e", "process.stdout.write(process.argv[1])", exactArgument,
  ], { cwd: root, manageProcessTree: true, timeoutMs: 5_000 });
  assert.equal(exact.exitCode, 0, JSON.stringify(exact));
  assert.equal(exact.stdout, exactArgument,
    "the PowerShell containment layer must preserve UTF-8 and option-like task text exactly");

  const scriptBackend = path.join(root, "echo-argument.ps1");
  await writeFile(scriptBackend, [
    "param([string]$Value)",
    "[Console]::Out.Write($Value)",
    "",
  ].join("\r\n"));
  const fallbackExact = await runCommand(scriptBackend, [exactArgument], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(fallbackExact.exitCode, 0, JSON.stringify(fallbackExact));
  assert.equal(fallbackExact.stdout, exactArgument,
    "the contained PowerShell shim fallback must preserve the same argument bytes");

  const argvFixture = path.join(root, "node_modules", "fixture", "argv-fixture.mjs");
  const cmdShim = path.join(root, "npm-style-shim.cmd");
  await mkdir(path.dirname(argvFixture), { recursive: true });
  await writeFile(argvFixture,
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  await writeFile(cmdShim, [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    "IF EXIST \"%dp0%\\node.exe\" (",
    "  SET \"_prog=%dp0%\\node.exe\"",
    ") ELSE (",
    "  SET \"_prog=node\"",
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
      "\"%_prog%\" \"%dp0%\\node_modules\\fixture\\argv-fixture.mjs\" %*",
    "",
  ].join("\r\n"));
  const exactArguments = [
    "", " ", exactArgument, "tail\\", "two\\\\", "line1\nline2", "crlf1\r\ncrlf2", "汉🙂",
  ];
  const shimExact = await runCommand(cmdShim, exactArguments, {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(shimExact.exitCode, 0, JSON.stringify(shimExact));
  assert.deepEqual(JSON.parse(shimExact.stdout), exactArguments,
    "the final Node process behind an npm-style .cmd shim must receive exact argv values");

  const customCmd = await runCommand(backend, [exactArgument], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(customCmd.exitCode, 127, JSON.stringify(customCmd));
  assert.match(customCmd.stderr, /non-standard \.cmd\/\.bat backend/iu);

  const errorBackend = path.join(root, "stderr-and-exit.ps1");
  await writeFile(errorBackend, [
    "Write-Error 'fixture-nonterminating-error'",
    "exit 37",
    "",
  ].join("\r\n"));
  const errorResult = await runCommand(errorBackend, [], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(errorResult.exitCode, 37, JSON.stringify(errorResult));
  assert.match(errorResult.stderr, /fixture-nonterminating-error/iu);

  const handledNativeFailure = path.join(root, "handled-native-failure.ps1");
  await writeFile(handledNativeFailure, [
    "& $env:ComSpec /d /c 'exit 23' | Out-Null",
    "[Console]::Out.Write('handled')",
    "",
  ].join("\r\n"));
  const handledResult = await runCommand(handledNativeFailure, [], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(handledResult.exitCode, 0, JSON.stringify(handledResult));
  assert.equal(handledResult.stdout, "handled",
    "a stale LASTEXITCODE must not override normal PowerShell script completion");

  const throwingBackend = path.join(root, "throwing-backend.ps1");
  await writeFile(throwingBackend, "throw 'fixture-terminating-error'\r\n");
  const throwingResult = await runCommand(throwingBackend, [], {
    cwd: root, manageProcessTree: true, timeoutMs: 5_000,
  });
  assert.equal(throwingResult.exitCode, 127, JSON.stringify(throwingResult));
  assert.match(throwingResult.stderr, /fixture-terminating-error/iu);

  const invalidMarker = path.join(root, "invalid-argv-started.txt");
  const invalidArgument = await runCommand(process.execPath, [
    "-e", `require('node:fs').writeFileSync(${JSON.stringify(invalidMarker)}, 'started')`,
    "A\0B", "tail",
  ], { cwd: root, manageProcessTree: true, timeoutMs: 5_000 });
  assert.equal(invalidArgument.exitCode, 127, JSON.stringify(invalidArgument));
  assert.match(invalidArgument.stderr, /invalid process-tree runner command/iu);
  await assert.rejects(access(invalidMarker), /ENOENT/u);

  const earlyExit = await runCommand(process.execPath, ["-e", "process.exit(0)"], {
    cwd: root, manageProcessTree: true, stdinText: "x".repeat(1_000_000), timeoutMs: 5_000,
  });
  assert.equal(earlyExit.exitCode, 0, JSON.stringify(earlyExit));

  const source = await readFile(path.join(pluginRoot, "windows-job-runner.ps1"), "utf8");
  const containmentReady = source.indexOf(
    "$jobHandle = [CliAgentBridgeJobObject]::CreateKillOnCloseJobForCurrentProcess()",
  );
  const payloadRead = source.indexOf("[Console]::In.ReadToEnd()");
  const backendLaunch = source.indexOf("& $NodeExecutable $NodeRunner");
  assert.ok(containmentReady >= 0 && containmentReady < payloadRead && payloadRead < backendLaunch,
    "Job containment must be live before the payload can launch a backend");
});

test("a failed Windows containment runner never falls back to the backend", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-job-failure-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "backend-started.txt");
  const backend = path.join(root, "must-not-start.cmd");
  await writeFile(backend, `@echo started>${marker}\r\n`);
  const failedRunner = path.join(root, "failed-job-runner.ps1");
  await writeFile(failedRunner, [
    "param([string]$NodeExecutable, [string]$NodeRunner)",
    "$null = [Console]::In.ReadToEnd()",
    "[Console]::Error.WriteLine('job-object initialization failed: fixture')",
    "exit 125",
    "",
  ].join("\r\n"));
  const result = await runCommand(backend, [], {
    cwd: root,
    manageProcessTree: true,
    windowsJobRunnerPath: failedRunner,
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 125, JSON.stringify(result));
  assert.match(result.stderr, /job-object initialization failed/iu);
  await assert.rejects(access(marker), /ENOENT/u);

  const missingRunner = await runCommand(process.execPath, [
    "-e", "process.exit(0)", "x".repeat(2_000_000),
  ], {
    cwd: root,
    manageProcessTree: true,
    windowsJobRunnerPath: path.join(root, "missing-job-runner.ps1"),
    timeoutMs: 5_000,
  });
  assert.notEqual(missingRunner.exitCode, 0,
    "a bootstrap failure with a large pending payload must resolve without crashing the bridge");
});

test("cancellation in the spawn-to-controller window never launches the backend", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-cancel-window-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "must-not-start.txt");
  let checks = 0;
  const result = await runCommand(process.execPath, [
    "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  ], {
    cwd: root,
    manageProcessTree: true,
    timeoutMs: 5_000,
    shouldCancel: () => {
      checks += 1;
      return checks >= 2;
    },
  });
  assert.equal(result.timedOut, false, JSON.stringify(result));
  assert.equal(result.treeTerminated, true, JSON.stringify(result));
  await assert.rejects(access(marker), /ENOENT/u);
});

async function canonicalGitCommonDirectory(workspace) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: workspace });
  return await realpath(path.resolve(workspace, stdout.replace(/\r?\n$/u, "")));
}

async function coordinationLockStore(workspace) {
  return path.join(await canonicalGitCommonDirectory(workspace), "cli-agent-bridge-lock-store.git");
}

async function repositoryIdFromStore(store) {
  const { stdout: oid } = await execFileAsync(
    "git", ["rev-parse", "--verify", "refs/cli-agent-bridge/repository-id"], { cwd: store },
  );
  const { stdout: repositoryId } = await execFileAsync(
    "git", ["cat-file", "blob", oid.trim()], { cwd: store },
  );
  return repositoryId.trim();
}

async function repositoryKey(canonicalGitCommonDir) {
  if (process.platform === "linux") {
    const repositoryId = await repositoryIdFromStore(path.join(
      canonicalGitCommonDir, "cli-agent-bridge-lock-store.git",
    ));
    return "git-common-dir-id:" + repositoryId;
  }
  return "git-common-dir:" + path.normalize(canonicalGitCommonDir);
}

async function repositoryStatePaths(canonicalGitCommonDir) {
  const key = await repositoryKey(canonicalGitCommonDir);
  const digest = createHash("sha256").update(key).digest("hex");
  const root = path.join(
    canonicalGitCommonDir, "cli-agent-bridge-lock-store.git", "cli-agent-bridge-quarantines",
  );
  return {
    root,
    quarantinePath: path.join(root, digest + ".quarantine"),
    recoveryPath: path.join(root, digest + ".quarantine.recovery-approved"),
  };
}

class McpClient {
  constructor(configPath, extraEnv = {}) {
    this.child = execServer(configPath, extraEnv);
    this.pending = new Map();
    this.stderr = "";
    this.nextId = 1;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      const entry = this.pending.get(requestKey(message.id));
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(requestKey(message.id));
      entry.resolve(message);
    });
    this.child.on("exit", (code) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("server exited with code " + String(code) + ": " + this.stderr));
      }
      this.pending.clear();
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cli-agent-bridge-test", version: "1.0.0" },
    });
    assert.equal(response.result.protocolVersion, "2025-06-18");
    this.notify("notifications/initialized", {});
  }

  request(method, params, id = this.nextId++) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestKey(id));
        reject(new Error("timed out waiting for request " + String(id) + ": " + this.stderr));
      }, 25_000);
      this.pending.set(requestKey(id), { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close() {
    if (this.child.exitCode !== null) return;
    this.child.kill();
    await new Promise((resolve) => this.child.once("exit", resolve));
  }

  async disconnectInput() {
    if (this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.stdin.end();
    let timer = null;
    try {
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("server did not exit after stdin closed")), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function execServer(configPath, extraEnv = {}) {
  return spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...extraEnv, CLI_AGENT_BRIDGE_BACKENDS: configPath },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function makeHarness(context, { unborn = false, extraEnv = {} } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-test-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace);
  await initializeFixtureRepository(workspace, { unborn });
  const configPath = path.join(tempRoot, "backends.json");
  await writeFile(configPath, JSON.stringify({
    backends: {
      fake: {
        label: "Fake backend",
        command: process.execPath,
        buildArgs: [fakeBackendPath, "<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const client = new McpClient(configPath, extraEnv);
  await client.initialize();
  context.after(async () => {
    await client.close();
    await rm(tempRoot, { recursive: true, force: true });
  });
  return { tempRoot, workspace, configPath, client };
}

async function initializeFixtureRepository(workspace, { unborn = false } = {}) {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: workspace });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: workspace });
  if (!unborn) {
    await writeFile(path.join(workspace, "baseline.txt"), "baseline\n");
    await execFileAsync("git", ["add", "baseline.txt"], { cwd: workspace });
    await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: workspace });
  }
}

function taskArguments(workspacePath, spec, extra = {}) {
  return {
    name: "delegate_task",
    arguments: {
      backend: "fake",
      task: JSON.stringify(spec),
      workspacePath,
      ...extra,
    },
  };
}

async function events(file) {
  try {
    return (await readFile(file, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeTraceFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-trace-fd-test-"));
  const tracePath = path.join(root, "git.trace");
  const handle = await open(tracePath, "wx+", 0o600);
  const identity = await handle.stat({ bigint: true });
  let closed = false;
  context.after(async () => {
    if (!closed) await handle.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    tracePath,
    handle,
    identity,
    async close() {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

function testCancellation() {
  const listeners = new Set();
  return {
    cancelled: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("explicit backend configuration overrides fail closed atomically", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-explicit-config-test-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await initializeFixtureRepository(workspace);
  context.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: "empty-path", configPath: "" },
    { name: "missing-file", configPath: path.join(root, "missing.json") },
    { name: "malformed-json", content: "{" },
    { name: "missing-backends", content: "{}" },
    { name: "array-backends", content: JSON.stringify({ backends: [] }) },
    { name: "empty-backends", content: JSON.stringify({ backends: {} }) },
    { name: "invalid-entry", content: JSON.stringify({
      backends: { broken: { command: process.execPath, buildArgs: "<task>" } },
    }) },
  ];
  for (const fixture of cases) {
    const configPath = fixture.configPath ?? path.join(root, fixture.name + ".json");
    if (fixture.content !== undefined) await writeFile(configPath, fixture.content);
    const client = new McpClient(configPath);
    await client.initialize();
    try {
      const listed = await client.request("tools/call", {
        name: "list_backends", arguments: {},
      });
      assert.equal(listed.error?.code, -32603, fixture.name + ": " + JSON.stringify(listed));
      assert.match(listed.error.message, /explicit backend configuration/iu);
      const delegated = await client.request("tools/call", {
        name: "delegate_task",
        arguments: { backend: "codex", task: "must not start", workspacePath: workspace },
      });
      assert.equal(delegated.error?.code, -32603,
        fixture.name + ": " + JSON.stringify(delegated));
      assert.match(delegated.error.message, /explicit backend configuration/iu);
    } finally {
      await client.close();
    }
  }
});

test("an unset backend override still loads the bundled configuration", async (context) => {
  const original = process.env.CLI_AGENT_BRIDGE_BACKENDS;
  delete process.env.CLI_AGENT_BRIDGE_BACKENDS;
  context.after(() => {
    if (original === undefined) delete process.env.CLI_AGENT_BRIDGE_BACKENDS;
    else process.env.CLI_AGENT_BRIDGE_BACKENDS = original;
  });
  const backends = await loadBackends();
  assert.ok(backends.codex);
  assert.deepEqual(backends.codex.buildArgs, ["exec", "--", "<task>"]);
});

test("explicit invalid delegation timeouts are rejected before side effects", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "invalid-timeout-events.jsonl");
  for (const timeoutMs of ["5000", 5_000.5, null, false, 4_999, 3_600_001]) {
    const response = await client.request("tools/call", taskArguments(workspace, {
      name: "invalid-timeout", eventFile,
    }, { timeoutMs }));
    assert.equal(response.error?.code, -32602, JSON.stringify(response));
    assert.equal(
      response.error.message,
      "timeoutMs must be an integer between 5000 and 3600000 milliseconds",
    );
  }
  assert.deepEqual(await events(eventFile), [], "an invalid timeout must not launch a worker");
});

test("Git executable resolution obeys request cancellation, deadline, and shutdown", async (context) => {
  const resolverRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-git-resolution-test-"));
  const startedFile = path.join(resolverRoot, "started.txt");
  context.after(() => rm(resolverRoot, { recursive: true, force: true }));
  const { tempRoot, workspace, client } = await makeHarness(context, {
    extraEnv: {
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS: "60000",
      CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE: startedFile,
    },
  });

  const cancelledRequest = client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  }, 51_001);
  await waitFor(async () => {
    try { return (await readFile(startedFile, "utf8")).includes("started"); } catch { return false; }
  });
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 51_001 });
  const cancelled = await cancelledRequest;
  assert.equal(cancelled.result.structuredContent.cancelled, true, JSON.stringify(cancelled));
  assert.ok(Date.now() - cancelledAt < 1_500, "Git resolution cancellation must detach promptly");

  const eventFile = path.join(tempRoot, "git-resolution-events.jsonl");
  const timed = await client.request("tools/call", taskArguments(workspace, {
    name: "git-resolution-deadline", eventFile,
  }, { timeoutMs: 5_000 }), 51_002);
  assert.equal(timed.result.structuredContent.timedOut, true, JSON.stringify(timed));
  assert.match(timed.result.structuredContent.error, /identifying the Git worktree/iu);
  assert.deepEqual(await events(eventFile), [], "the backend must not start after resolution timeout");
  assert.equal((await readFile(startedFile, "utf8")).trim().split(/\r?\n/u).length, 1,
    "cancelled and timed-out waiters must share one core Git lookup");

  const pending = client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  }, 51_003);
  void pending.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  const shutdownAt = Date.now();
  await client.disconnectInput();
  assert.ok(Date.now() - shutdownAt < 3_000,
    "stdin shutdown must detach the active Git-resolution waiter");
});

test("list_backends rejects a successful probe whose tree cleanup is unconfirmed", () => {
  const entry = backendEntryFromProbe("fixture", {
    label: "Fixture", command: "fixture", buildArgs: ["<task>"], resumeArgs: null,
  }, {
    exitCode: 0,
    treeTerminated: false,
    terminationError: "fixture version-probe descendant remains",
    errorMessage: "",
    stdout: "fixture 1.2.3\n",
  });
  assert.equal(entry.available, false);
  assert.equal(entry.version, null);
  assert.equal(entry.error, "fixture version-probe descendant remains");
});

test("cancellation requires a fresh workspace_status to reveal earlier edits", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "cancelled-edit-events.jsonl");
  const changedFile = "cancelled-edit.txt";
  const pending = client.request("tools/call", taskArguments(workspace, {
    name: "cancelled-edit", eventFile, writeBeforeDelay: true, writeFile: changedFile,
  }), 51_004);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "written"));
  client.notify("notifications/cancelled", { requestId: 51_004 });
  const cancelled = await pending;
  const cancelledOut = cancelled.result.structuredContent;
  assert.equal(cancelledOut.cancelled, true, JSON.stringify(cancelledOut));
  assert.equal(cancelledOut.treeTerminated, true, JSON.stringify(cancelledOut));
  assert.equal(cancelledOut.git, null,
    "the cancelled response must not be treated as evidence that no edits occurred");

  const status = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  const statusOut = status.result.structuredContent;
  assert.equal(statusOut.ok, true, JSON.stringify(statusOut));
  assert.ok(statusOut.git.changedFiles.includes(changedFile), JSON.stringify(statusOut.git));
});

test("provenance setup obeys cancellation and deadline before worker launch", async (context) => {
  const setupRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-trace-setup-test-"));
  const startedFile = path.join(setupRoot, "started.txt");
  context.after(() => rm(setupRoot, { recursive: true, force: true }));
  const { tempRoot, workspace, client } = await makeHarness(context, {
    extraEnv: {
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_DELAY_MS: "60000",
      CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_STARTED_FILE: startedFile,
    },
  });
  const eventFile = path.join(tempRoot, "trace-setup-events.jsonl");
  const cancelledRequest = client.request("tools/call", taskArguments(workspace, {
    name: "cancelled-trace-setup", eventFile,
  }), 51_005);
  await waitFor(async () => {
    try { return (await readFile(startedFile, "utf8")).trim().length > 0; } catch { return false; }
  }, 20_000);
  client.notify("notifications/cancelled", { requestId: 51_005 });
  const cancelled = await cancelledRequest;
  assert.equal(cancelled.result.structuredContent.cancelled, true, JSON.stringify(cancelled));

  const timed = await client.request("tools/call", taskArguments(workspace, {
    name: "expired-trace-setup", eventFile,
  }, { timeoutMs: 5_000 }), 51_006);
  assert.equal(timed.result.structuredContent.timedOut, true, JSON.stringify(timed));
  assert.match(timed.result.structuredContent.error, /preparing Git provenance/iu);
  assert.deepEqual(await events(eventFile), [], "trace setup interruption must precede worker launch");
  for (const traceRoot of (await readFile(startedFile, "utf8")).trim().split(/\r?\n/u)) {
    await assert.rejects(access(traceRoot), /ENOENT/u,
      "interrupted provenance setup must close its handle and remove its private root");
  }
});

test("shutdown waits for a late provenance-setup cleanup", async (context) => {
  const setupRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-trace-shutdown-test-"));
  const startedFile = path.join(setupRoot, "started.txt");
  const releaseFile = path.join(setupRoot, "release.txt");
  context.after(() => rm(setupRoot, { recursive: true, force: true }));
  const { tempRoot, workspace, client } = await makeHarness(context, {
    extraEnv: {
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_TRACE_PENDING_STEP_RELEASE_FILE: releaseFile,
      CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_STARTED_FILE: startedFile,
    },
  });
  const eventFile = path.join(tempRoot, "trace-shutdown-events.jsonl");
  const pending = client.request("tools/call", taskArguments(workspace, {
    name: "pending-trace-setup", eventFile,
  }), 51_007);
  await waitFor(async () => {
    try { return (await readFile(startedFile, "utf8")).trim().length > 0; } catch { return false; }
  }, 20_000);
  const traceRoot = (await readFile(startedFile, "utf8")).trim();
  client.notify("notifications/cancelled", { requestId: 51_007 });
  const response = await pending;
  assert.equal(response.result.structuredContent.cancelled, true, JSON.stringify(response));
  await writeFile(releaseFile, "release\n");
  await client.disconnectInput();
  await assert.rejects(access(traceRoot), /ENOENT/u,
    "shutdown must await the registered late cleanup before exiting");
  assert.deepEqual(await events(eventFile), []);
});

test("Codex templates delimit option-looking task text", async () => {
  const backends = JSON.parse(await readFile(path.join(pluginRoot, "backends.json"), "utf8")).backends;
  assert.deepEqual(backends.codex.buildArgs, ["exec", "--", "<task>"]);
  assert.deepEqual(backends.codex.resumeArgs, ["exec", "resume", "<session>", "--", "<task>"]);
  const source = await readFile(serverPath, "utf8");
  assert.match(source, /buildArgs: \["exec", "--", "<task>"\]/u);
  assert.match(source, /resumeArgs: \["exec", "resume", "<session>", "--", "<task>"\]/u);
});

test("unsupported POSIX platforms fail before probing Git or a backend", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-unsupported-platform-test-"));
  const workspace = path.join(root, "workspace");
  const marker = path.join(workspace, "backend-started.txt");
  const sentinel = path.join(workspace, "sentinel.txt");
  const configPath = path.join(root, "backends.json");
  await mkdir(workspace);
  await writeFile(sentinel, "unchanged\n");
  await writeFile(configPath, JSON.stringify({
    backends: {
      fake: {
        label: "Fake backend",
        command: process.execPath,
        buildArgs: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        resumeArgs: null,
      },
    },
  }));
  const client = new McpClient(configPath, {
    NODE_ENV: "test", CLI_AGENT_BRIDGE_TEST_PLATFORM: "darwin",
  });
  await client.initialize();
  context.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await client.request("tools/call", {
    name: "list_backends", arguments: {},
  });
  const backend = listed.result.structuredContent.backends[0];
  assert.equal(backend.available, false);
  assert.equal(backend.version, null);
  assert.match(backend.error, /unsupported platform/iu);

  const delegated = await client.request("tools/call", taskArguments(workspace, { name: "run" }));
  const out = delegated.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /unsupported on darwin/iu);
  assert.deepEqual(await readdir(workspace), ["sentinel.txt"]);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");
  await assert.rejects(access(marker), /ENOENT/u);
});

test("a bare backend command never resolves from the workspace cwd", {
  skip: process.platform !== "win32",
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-backend-shadow-test-"));
  const workspace = path.join(root, "workspace");
  const marker = path.join(workspace, "shadow-started.txt");
  const configPath = path.join(root, "backends.json");
  await mkdir(workspace);
  await copyFile(process.execPath, path.join(workspace, "workspace-shadow-backend.exe"));
  await writeFile(configPath, JSON.stringify({
    backends: {
      shadow: {
        label: "Shadow fixture",
        command: "workspace-shadow-backend",
        buildArgs: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        resumeArgs: null,
      },
    },
  }));
  const client = new McpClient(configPath);
  await client.initialize();
  context.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await client.request("tools/call", {
    name: "delegate_task",
    arguments: { backend: "shadow", task: "run", workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /command was not found/iu);
  await assert.rejects(access(marker), /ENOENT/u);
});

test("delegate_task rejects resume for a backend without resume support", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "unsupported-resume.txt",
  }, { resumeSessionId: "session-123" }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /does not support resuming/iu);
  await assert.rejects(access(path.join(workspace, "unsupported-resume.txt")), /ENOENT/u);
});

test("dirty checks include untracked files even when Git config hides them", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["config", "status.showUntrackedFiles", "no"], { cwd: workspace });
  await writeFile(path.join(workspace, "hidden-untracked.txt"), "pre-existing\n");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "worker-output.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /working tree is dirty/iu);
  assert.ok(out.gitBefore.changedFiles.includes("hidden-untracked.txt"));
  await assert.rejects(access(path.join(workspace, "worker-output.txt")), /ENOENT/u);
});

test("porcelain status preserves the unstaged first-column space", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await writeFile(path.join(workspace, "baseline.txt"), "unstaged change\n");
  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.match(response.result.structuredContent.git.statusShort, /^ M baseline\.txt$/u);
});

test("a staged-only diff stat keeps its staged source label", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await writeFile(path.join(workspace, "staged-only.txt"), "staged\n");
  await execFileAsync("git", ["add", "staged-only.txt"], { cwd: workspace });
  const { stdout: unstaged } = await execFileAsync("git", ["diff", "--stat"], { cwd: workspace });
  assert.equal(unstaged, "", "the fixture must contain no unstaged diff");

  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.match(out.git.diffStat, /staged-only\.txt/u);
  assert.ok(out.git.diffStat.split(/\r?\n/u).every((line) => line.startsWith("staged: ")),
    out.git.diffStat);
});

test("the private lock store inherits the repository sharing mode", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["config", "core.sharedRepository", "group"], { cwd: workspace });
  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(response.result.structuredContent.ok, true);
  const lockStore = await coordinationLockStore(workspace);
  const { stdout } = await execFileAsync(
    "git", ["--git-dir", lockStore, "config", "--get", "core.sharedRepository"],
  );
  assert.ok(["1", "group"].includes(stdout.trim()), stdout);
  if (process.platform !== "win32") {
    const storeMode = (await stat(lockStore)).mode & 0o777;
    assert.equal(storeMode & 0o070, 0o070, "the repository group must be able to traverse its lock store");
    const identityRefMode = (await stat(path.join(
      lockStore, "refs", "cli-agent-bridge", "repository-id",
    ))).mode & 0o777;
    assert.equal(identityRefMode & 0o060, 0o060,
      "the repository group must be able to read/write its identity ref");
    const legacyIdentityMode = (await stat(path.join(
      lockStore, "cli-agent-bridge-repository-id",
    ))).mode & 0o777;
    assert.equal(legacyIdentityMode & 0o060, 0o060,
      "rolling-upgrade readers in the repository group must be able to read the identity anchor");
    const quarantineRoot = path.join(lockStore, "cli-agent-bridge-quarantines");
    const quarantineRootMode = (await stat(quarantineRoot)).mode & 0o2777;
    const quarantineMode = quarantineRootMode & 0o777;
    assert.equal(quarantineMode & 0o070, 0o070,
      "the repository group must be able to publish and recover quarantine records");
    assert.equal(quarantineRootMode & 0o2000, 0o2000,
      "shared quarantine records must inherit the repository group");
    assert.deepEqual(
      (await readdir(lockStore)).filter((name) => name.startsWith(".cli-agent-bridge-quarantines-")),
      [],
      "atomic root publication must not leave a candidate directory behind",
    );
    const quarantine = await markWorkspaceQuarantined(
      quarantineRoot, "shared-quarantine-mode", { terminationError: "fixture" },
    );
    context.after(() => rm(quarantine.quarantinePath, { recursive: true, force: true }));
    const markerMode = (await stat(quarantine.quarantinePath)).mode & 0o2777;
    const recordMode = (await stat(path.join(
      quarantine.quarantinePath, "record.json",
    ))).mode & 0o777;
    assert.equal(markerMode & 0o2070, 0o2070,
      "other repository-group users must be able to traverse and rename the marker");
    assert.equal(recordMode & 0o060, 0o060,
      "other repository-group users must be able to read the incident-bound recovery id");
  }
});

test("stale starting and running lease refs remain visible to attribution", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const store = await coordinationLockStore(workspace);
  const otherRef = workspaceLockRef("fixture-stale-active-lease");
  const writeOwner = async (workerState) => {
    const ownerPath = path.join(tempRoot, "stale-" + workerState + "-owner.json");
    await writeFile(ownerPath, JSON.stringify({
      version: 1,
      token: "fixture-stale-" + workerState,
      hostIdentity: "fixture:other-bridge",
      ownerPid: 4242,
      ownerIdentity: "fixture-start",
      workerState,
      workerPid: workerState === "idle" ? null : 4343,
      acquiredAt: Date.now() - 180_000,
      heartbeatAt: Date.now() - 120_000,
    }));
    const { stdout } = await execFileAsync("git", ["hash-object", "-w", ownerPath], { cwd: store });
    await execFileAsync("git", ["update-ref", otherRef, stdout.trim()], { cwd: store });
  };
  context.after(async () => {
    try { await execFileAsync("git", ["update-ref", "-d", otherRef], { cwd: store }); } catch { /* already gone */ }
  });

  await writeOwner("running");
  const active = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(active.result.structuredContent.git.concurrentDelegations, 1,
    "a current running ref remains active even when its write timestamp is old");

  await writeOwner("idle");
  const idle = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(idle.result.structuredContent.git.concurrentDelegations, 0,
    "a stale idle owner is not an active delegation");
});

test("concurrent first requests publish one valid repository identity", async (context) => {
  const { workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const request = {
      name: "workspace_status", arguments: { workspacePath: workspace },
    };
    const [first, second] = await Promise.all([
      client.request("tools/call", request, 831),
      secondClient.request("tools/call", request, 832),
    ]);
    assert.equal(first.result.structuredContent.ok, true, JSON.stringify(first));
    assert.equal(second.result.structuredContent.ok, true, JSON.stringify(second));
    const commonDir = await canonicalGitCommonDirectory(workspace);
    const store = await coordinationLockStore(workspace);
    const repositoryId = await repositoryIdFromStore(store);
    assert.match(repositoryId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    assert.equal(
      (await readFile(path.join(store, "cli-agent-bridge-repository-id"), "utf8")).trim(),
      repositoryId,
      "a file-only older bridge must derive the same repository lock key",
    );
    assert.deepEqual(
      (await readdir(commonDir)).filter((name) => name.startsWith(".cli-agent-bridge-lock-store-")),
      [],
      "first-use initialization must not leave losing candidate stores behind",
    );
  } finally {
    await secondClient.close();
  }
});

test("repository identity sources disagree only by failing closed", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const store = await coordinationLockStore(workspace);
  const refIdentity = await repositoryIdFromStore(store);
  assert.equal(
    (await readFile(path.join(store, "cli-agent-bridge-repository-id"), "utf8")).trim(),
    refIdentity,
  );
  await writeFile(
    path.join(store, "cli-agent-bridge-repository-id"),
    "22222222-2222-4222-8222-222222222222\n",
  );
  const conflicted = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.match(conflicted.error?.message ?? "", /repository identity sources conflict/iu);
});

test("a legacy repository identity file is migrated into the CAS ref", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const store = await coordinationLockStore(workspace);
  await execFileAsync("git", ["update-ref", "-d", "refs/cli-agent-bridge/repository-id"], {
    cwd: store,
  });
  const legacyId = "11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(store, "cli-agent-bridge-repository-id"), legacyId + "\n");

  const migrated = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(migrated.result.structuredContent.ok, true, JSON.stringify(migrated));
  assert.equal(await repositoryIdFromStore(store), legacyId);
});

test("a repository recreated at the same path gets a new logical lock identity", {
  skip: process.platform !== "linux" ? "Linux persistent repository identity fixture" : false,
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  const initial = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initial.result.structuredContent.ok, true, JSON.stringify(initial));
  const firstCommonDir = await canonicalGitCommonDirectory(workspace);
  const firstId = await repositoryIdFromStore(path.join(
    firstCommonDir, "cli-agent-bridge-lock-store.git",
  ));
  const firstState = await repositoryStatePaths(firstCommonDir);
  await mkdir(firstState.root, { recursive: true });
  await writeFile(firstState.quarantinePath, JSON.stringify({ terminationError: "old repository" }));
  context.after(() => rm(firstState.quarantinePath, { force: true }));

  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace);
  await initializeFixtureRepository(workspace);
  const recreated = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(recreated.result.structuredContent.ok, true, JSON.stringify(recreated));
  const secondCommonDir = await canonicalGitCommonDirectory(workspace);
  const secondId = await repositoryIdFromStore(path.join(
    secondCommonDir, "cli-agent-bridge-lock-store.git",
  ));
  assert.notEqual(secondId, firstId);
});

test("Git commands ignore an executable shadow in the workspace cwd", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  await copyFile(process.execPath, path.join(workspace, "git.exe"));
  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.git.changedFiles.includes("git.exe"));
});

test("Git snapshot commands disable untrusted fsmonitor hooks", {
  skip: process.platform !== "linux" ? "POSIX executable-hook fixture" : false,
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const hook = path.join(tempRoot, "fsmonitor-hook.sh");
  const ready = path.join(tempRoot, "fsmonitor-ready.txt");
  const survivor = path.join(tempRoot, "fsmonitor-descendant-survived.txt");
  const childCode = [
    "const fs=require('node:fs')",
    "setTimeout(()=>fs.writeFileSync(process.argv[1],'survived\\n'),1200)",
  ].join(";");
  await writeFile(hook, [
    "#!/bin/sh",
    "printf invoked > " + JSON.stringify(ready),
    "setsid " + JSON.stringify(process.execPath) + " -e " + JSON.stringify(childCode) +
      " " + JSON.stringify(survivor) + " >/dev/null 2>&1 &",
    "printf 'fixture-token\\0'",
    "",
  ].join("\n"));
  await chmod(hook, 0o755);
  await execFileAsync("git", ["config", "core.fsmonitor", hook], { cwd: workspace });
  await execFileAsync("git", ["config", "core.fsmonitorHookVersion", "2"], { cwd: workspace });

  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(response.result.structuredContent.ok, true,
    JSON.stringify(response.result.structuredContent));
  await assert.rejects(access(ready), /ENOENT/u,
    "snapshot reads must override repository fsmonitor configuration");
  await assert.rejects(access(survivor), /ENOENT/u,
    "an untrusted fsmonitor hook must never start a descendant");
});

test("Git snapshot clean filters remain process-contained", {
  skip: process.platform !== "linux" ? "POSIX executable-filter fixture" : false,
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const filter = path.join(tempRoot, "clean-filter.sh");
  const ready = path.join(tempRoot, "clean-filter-ready.txt");
  const survivor = path.join(tempRoot, "clean-filter-descendant-survived.txt");
  const childCode = [
    "const fs=require('node:fs')",
    "setTimeout(()=>fs.writeFileSync(process.argv[1],'survived\\n'),1200)",
  ].join(";");
  await writeFile(filter, [
    "#!/bin/sh",
    "printf invoked > " + JSON.stringify(ready),
    "setsid " + JSON.stringify(process.execPath) + " -e " + JSON.stringify(childCode) +
      " " + JSON.stringify(survivor) + " >/dev/null 2>&1 &",
    "cat",
    "",
  ].join("\n"));
  await chmod(filter, 0o755);
  await writeFile(path.join(workspace, ".gitattributes"), "baseline.txt filter=audit\n");
  await execFileAsync("git", ["config", "filter.audit.clean", JSON.stringify(filter)], { cwd: workspace });
  await writeFile(path.join(workspace, "baseline.txt"), "changed\n");

  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  if (!out.ok) {
    assert.match(out.error, /repository helper process tree could not be confirmed/iu);
    assert.ok(out.quarantinePath, JSON.stringify(out));
    context.after(() => rm(out.quarantinePath, { recursive: true, force: true }));
  }
  assert.equal(await readFile(ready, "utf8"), "invoked",
    "the fixture must prove that Git executed the configured clean filter");
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(survivor), /ENOENT/u,
    "a detached clean-filter descendant must not outlive the snapshot command");
});

test("dirty checks override submodule ignore configuration", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const source = path.join(tempRoot, "submodule-source");
  await mkdir(source);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: source });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: source });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: source });
  await writeFile(path.join(source, "tracked.txt"), "baseline\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: source });
  await execFileAsync("git", ["commit", "-m", "submodule baseline"], { cwd: source });
  await execFileAsync("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested-submodule"], {
    cwd: workspace,
  });
  await execFileAsync("git", ["commit", "-am", "add submodule"], { cwd: workspace });
  await execFileAsync("git", ["config", "submodule.nested-submodule.ignore", "all"], { cwd: workspace });
  await writeFile(path.join(workspace, "nested-submodule", "tracked.txt"), "pre-existing edit\n");

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "submodule-bypass.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /working tree is dirty/iu);
  assert.match(out.gitBefore.statusShort, /nested-submodule/u);
  assert.ok(out.gitBefore.changedFiles.includes("nested-submodule"));
  await assert.rejects(access(path.join(workspace, "submodule-bypass.txt")), /ENOENT/u);
});

test("canonical Git worktree locking serializes root and symlink paths", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const alias = path.join(tempRoot, "workspace-alias");
  await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const eventFile = path.join(tempRoot, "events.jsonl");

  const first = client.request("tools/call", taskArguments(workspace, {
    name: "first", eventFile, delayMs: 500, writeFile: "first.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "first" && item.event === "start"));
  const second = client.request("tools/call", taskArguments(alias, {
    name: "second", eventFile, delayMs: 10, writeFile: "second.txt",
  }, { allowDirty: true }));

  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.result.structuredContent.ok, true);
  assert.equal(secondResponse.result.structuredContent.ok, true);
  assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
    "start:first", "end:first", "start:second", "end:second",
  ]);
  assert.equal(firstResponse.result.structuredContent.worktreeRoot, secondResponse.result.structuredContent.worktreeRoot);
});

test("a retargeted workspace symlink cannot redirect a queued worker", async (context) => {
  if (process.platform === "win32") return; // creating/retargeting symlinks is privilege-dependent
  const { tempRoot, workspace, client } = await makeHarness(context);
  const other = path.join(tempRoot, "other-workspace");
  await mkdir(other);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: other });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: other });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: other });
  await writeFile(path.join(other, "baseline.txt"), "other baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: other });
  await execFileAsync("git", ["commit", "-m", "other baseline"], { cwd: other });
  const alias = path.join(tempRoot, "retargetable-workspace");
  await symlink(workspace, alias, "dir");
  const eventFile = path.join(tempRoot, "retarget-events.jsonl");
  const holder = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 900, writeFile: "holder.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "holder" && item.event === "start"));
  const queued = client.request("tools/call", taskArguments(alias, {
    name: "queued", eventFile, writeFile: "queued.txt",
  }, { allowDirty: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await unlink(alias);
  await symlink(other, alias, "dir");

  assert.equal((await holder).result.structuredContent.ok, true);
  assert.equal((await queued).result.structuredContent.ok, true);
  await access(path.join(workspace, "queued.txt"));
  await assert.rejects(access(path.join(other, "queued.txt")), /ENOENT/u);
});

test("relative backend commands resolve from their configuration directory", async (context) => {
  if (process.platform === "win32") return; // executable symlink setup is POSIX-specific
  const { tempRoot, workspace } = await makeHarness(context);
  const configDirectory = path.join(tempRoot, "relative-config");
  await mkdir(configDirectory);
  const nodeAlias = path.join(configDirectory, "node-wrapper");
  await symlink(process.execPath, nodeAlias, "file");
  const configPath = path.join(configDirectory, "backends.json");
  await writeFile(configPath, JSON.stringify({ backends: { relative: {
    label: "Relative fixture", command: "./node-wrapper",
    buildArgs: [fakeBackendPath, "<task>"], resumeArgs: null, experimental: false,
  } } }));
  const relativeClient = new McpClient(configPath);
  context.after(() => relativeClient.close());
  await relativeClient.initialize();
  const listed = await relativeClient.request("tools/call", { name: "list_backends", arguments: {} });
  assert.equal(listed.result.structuredContent.backends[0].available, true);
  const delegated = await relativeClient.request("tools/call", {
    name: "delegate_task",
    arguments: {
      backend: "relative", task: JSON.stringify({ name: "relative", writeFile: "relative.txt" }),
      workspacePath: workspace,
    },
  });
  assert.equal(delegated.result.structuredContent.ok, true, delegated.result.structuredContent.error);
  await access(path.join(workspace, "relative.txt"));
});

test("canonical worktree locking serializes independent server processes", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-events.jsonl");
    const first = client.request("tools/call", taskArguments(workspace, {
      name: "first-server", eventFile, delayMs: 800, writeFile: "first-server.txt",
    }));
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "first-server" && item.event === "start",
    ));
    const second = secondClient.request("tools/call", taskArguments(workspace, {
      name: "second-server", eventFile, delayMs: 10, writeFile: "second-server.txt",
    }, { allowDirty: true }));

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.result.structuredContent.ok, true);
    assert.equal(secondResponse.result.structuredContent.ok, true);
    assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
      "start:first-server", "end:first-server", "start:second-server", "end:second-server",
    ]);
  } finally {
    await secondClient.close();
  }
});

test("a cross-process lock waiter can be cancelled without starting its backend", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-cancel-events.jsonl");
    const holder = client.request("tools/call", taskArguments(workspace, {
      name: "cancel-holder", eventFile, delayMs: 3_000,
    }), 121);
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "cancel-holder" && item.event === "start",
    ));
    const waiter = secondClient.request("tools/call", taskArguments(workspace, {
      name: "cancelled-waiter", eventFile,
    }), 122);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const cancelledAt = Date.now();
    secondClient.notify("notifications/cancelled", { requestId: 122 });

    const waiterResponse = await waiter;
    assert.ok(Date.now() - cancelledAt < 1_500, "cross-process lock cancellation must settle promptly");
    assert.equal(waiterResponse.result.structuredContent.cancelled, true);
    assert.equal((await events(eventFile)).some((item) => item.name === "cancelled-waiter"), false);
    assert.equal((await holder).result.structuredContent.ok, true);
  } finally {
    await secondClient.close();
  }
});

test("a cross-process lock waiter obeys the delegation deadline", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "cross-process-deadline-events.jsonl");
    const holder = client.request("tools/call", taskArguments(workspace, {
      name: "deadline-holder", eventFile, delayMs: 7_000,
    }), 131);
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "deadline-holder" && item.event === "start",
    ));
    const startedAt = Date.now();
    const waiter = secondClient.request("tools/call", taskArguments(workspace, {
      name: "deadline-waiter", eventFile,
    }, { timeoutMs: 5_000 }), 132);

    const waiterResponse = await waiter;
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 4_500 && elapsed < 6_500, "lock wait should consume the overall deadline: " + String(elapsed));
    assert.equal(waiterResponse.result.structuredContent.timedOut, true);
    assert.match(waiterResponse.result.structuredContent.error, /waiting for the workspace lock/iu);
    assert.equal((await events(eventFile)).some((item) => item.name === "deadline-waiter"), false);
    assert.equal((await holder).result.structuredContent.ok, true);
  } finally {
    await secondClient.close();
  }
});

test("losing a Git-ref lease never strands the local FIFO gate", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const canonicalRoot = await canonicalGitCommonDirectory(workspace);
  const key = await repositoryKey(canonicalRoot);
  const ref = workspaceLockRef(key);
  const lockStore = await coordinationLockStore(workspace);
  const eventFile = path.join(tempRoot, "lost-lock-events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "loses-lock", eventFile, delayMs: 12_000,
  }), 141);
  await waitFor(async () => (await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "start",
  ));
  await waitFor(async () => {
    try {
      const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: lockStore });
      const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: lockStore });
      return JSON.parse(blob).workerState === "running";
    } catch {
      return false;
    }
  });

  const replacementPath = path.join(tempRoot, "replacement-owner.json");
  await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:test" }));
  const { stdout: replacementOidText } = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: lockStore });
  const replacementOid = replacementOidText.trim();
  const replacedAt = Date.now();
  await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: lockStore });
  context.after(async () => {
    try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore }); } catch { /* already gone */ }
  });

  const firstResponse = await first;
  assert.ok(Date.now() - replacedAt < 9_000, "heartbeat loss must terminate the active worker promptly");
  assert.match(firstResponse.error?.message ?? "", /workspace lock ownership changed/iu);
  assert.equal((await events(eventFile)).some(
    (item) => item.name === "loses-lock" && item.event === "end",
  ), false, "the original 12-second worker should be terminated before normal completion");
  await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore });

  const followUp = await client.request("tools/call", taskArguments(workspace, {
    name: "after-lost-lock", eventFile, delayMs: 10,
  }), 142);
  assert.equal(followUp.result.structuredContent.ok, true, JSON.stringify(followUp));
  assert.ok((await events(eventFile)).some((item) => item.name === "after-lost-lock" && item.event === "end"));
});

test("unconfirmed termination after lease loss quarantines delegation and status", {
  // This fixture forced taskkill failure through PATH. Windows worker cleanup
  // now uses a kill-on-close Job and never calls taskkill, so the injection no
  // longer exercises an unconfirmed-termination path.
  skip: "obsolete taskkill fault injection; Job bootstrap failure is covered above",
}, async (context) => {
  const { tempRoot, workspace, configPath } = await makeHarness(context);
  const shimDirectory = path.join(tempRoot, "failing-taskkill");
  await mkdir(shimDirectory);
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const realTaskkill = path.join(windowsRoot, "System32", "taskkill.exe");
  await copyFile(path.join(windowsRoot, "System32", "cmd.exe"), path.join(shimDirectory, "taskkill.exe"));
  const client = new McpClient(configPath, {
    NODE_ENV: "test",
    CLI_AGENT_BRIDGE_TEST_KILL_GRACE_MS: "100",
    PATH: shimDirectory + path.delimiter + process.env.PATH,
  });
  const eventFile = path.join(tempRoot, "quarantine-events.jsonl");
  let workerPid = null;
  let replacementOid = null;
  let ref = null;
  let lockStore = null;
  let quarantinePath = null;
  try {
    await client.initialize();
    const canonicalRoot = await canonicalGitCommonDirectory(workspace);
    ({ quarantinePath } = await repositoryStatePaths(canonicalRoot));
    context.after(() => rm(quarantinePath, { recursive: true, force: true }));
    const key = await repositoryKey(canonicalRoot);
    ref = workspaceLockRef(key);
    lockStore = await coordinationLockStore(workspace);
    const delegated = client.request("tools/call", taskArguments(workspace, {
      name: "unconfirmed-tree", eventFile, delayMs: 60_000,
    }), 151);
    await waitFor(async () => {
      const started = (await events(eventFile)).find(
        (item) => item.name === "unconfirmed-tree" && item.event === "start",
      );
      workerPid = started?.pid ?? null;
      return Number.isInteger(workerPid);
    });
    await waitFor(async () => {
      try {
        const { stdout: oid } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: lockStore });
        const { stdout: blob } = await execFileAsync("git", ["cat-file", "blob", oid.trim()], { cwd: lockStore });
        return JSON.parse(blob).workerState === "running";
      } catch {
        return false;
      }
    });
    const replacementPath = path.join(tempRoot, "quarantine-replacement-owner.json");
    await writeFile(replacementPath, JSON.stringify({ version: 1, hostIdentity: "foreign:quarantine" }));
    const replacement = await execFileAsync("git", ["hash-object", "-w", replacementPath], { cwd: lockStore });
    replacementOid = replacement.stdout.trim();
    const queuedStatus = client.request("tools/call", {
      name: "workspace_status",
      arguments: { workspacePath: workspace },
    }, 153);
    await execFileAsync("git", ["update-ref", ref, replacementOid], { cwd: lockStore });

    const failed = await delegated;
    assert.match(failed.error?.message ?? "", /workspace lock ownership changed/iu);
    const status = await queuedStatus;
    assert.equal(status.result.structuredContent.git, null);
    assert.match(status.result.structuredContent.error, /could not be confirmed terminated/iu);
    const followUp = await client.request("tools/call", taskArguments(workspace, {
      name: "must-not-start-after-quarantine", eventFile,
    }), 152);
    assert.equal(followUp.result.structuredContent.treeTerminated, false);
    assert.match(followUp.result.structuredContent.error, /quarantined/iu);
    assert.equal((await events(eventFile)).some(
      (item) => item.name === "must-not-start-after-quarantine",
    ), false);

    await execFileAsync(realTaskkill, ["/PID", String(workerPid), "/T", "/F"]);
    workerPid = null;
    await rm(quarantinePath, { recursive: true, force: true });
    await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore });
    replacementOid = null;
    const recovered = await client.request("tools/call", taskArguments(workspace, {
      name: "after-manual-quarantine-recovery", eventFile, delayMs: 10,
    }), 154);
    assert.equal(recovered.result.structuredContent.ok, true, JSON.stringify(recovered));
  } finally {
    if (ref && replacementOid && lockStore) {
      try { await execFileAsync("git", ["update-ref", "-d", ref, replacementOid], { cwd: lockStore }); } catch { /* already gone */ }
    }
    if (Number.isInteger(workerPid)) {
      try { await execFileAsync(realTaskkill, ["/PID", String(workerPid), "/T", "/F"]); } catch { /* already gone */ }
    }
    await client.close();
  }
});

test("a quarantine marker blocks delegations in every server process", async (context) => {
  const { workspace, configPath } = await makeHarness(context);
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const initialized = await secondClient.request("tools/call", {
      name: "workspace_status", arguments: { workspacePath: workspace },
    });
    assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
    const { root, quarantinePath } = await repositoryStatePaths(
      await canonicalGitCommonDirectory(workspace),
    );
    await mkdir(root, { recursive: true });
    context.after(() => rm(quarantinePath, { recursive: true, force: true }));
    await writeFile(quarantinePath, JSON.stringify({ terminationError: "fixture" }));
    const response = await secondClient.request("tools/call", taskArguments(workspace, {
      name: "must-not-run", writeFile: "quarantine-bypass.txt",
    }), 131);
    assert.equal(response.result.structuredContent.ok, false);
    assert.equal(response.result.structuredContent.quarantinePath, quarantinePath);
    assert.match(response.result.structuredContent.error, /quarantined/iu);
    await assert.rejects(access(path.join(workspace, "quarantine-bypass.txt")), /ENOENT/u);
  } finally {
    await secondClient.close();
  }
});

test("quarantine state ignores attacker-precreated temporary roots", async (context) => {
  const attackerTemp = await mkdtemp(path.join(os.tmpdir(), "cli-agent-attacker-temp-"));
  context.after(() => rm(attackerTemp, { recursive: true, force: true }));
  const user = os.userInfo();
  const identity = Number.isInteger(user.uid) && user.uid >= 0
    ? process.platform + ":uid:" + String(user.uid)
    : process.platform + ":" + user.username + ":" + user.homedir;
  const legacyRoot = path.join(
    attackerTemp,
    "minimax-cli-agent-bridge-locks-" +
      createHash("sha256").update(identity).digest("hex").slice(0, 20),
  );
  await mkdir(legacyRoot, { mode: 0o777 });
  if (process.platform !== "win32") await chmod(legacyRoot, 0o777);
  const tempEnvironment = process.platform === "win32"
    ? { TEMP: attackerTemp, TMP: attackerTemp }
    : { TMPDIR: attackerTemp };
  const { workspace, client } = await makeHarness(context, { extraEnv: tempEnvironment });
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const commonDir = await canonicalGitCommonDirectory(workspace);
  const key = await repositoryKey(commonDir);
  const digest = createHash("sha256").update(key).digest("hex");
  const forgedPath = path.join(legacyRoot, digest + ".quarantine");
  await writeFile(forgedPath, JSON.stringify({ terminationError: "attacker-controlled marker" }));

  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(response.result.structuredContent.ok, true, JSON.stringify(response));
  const state = await repositoryStatePaths(commonDir);
  assert.equal(
    state.root,
    path.join(commonDir, "cli-agent-bridge-lock-store.git", "cli-agent-bridge-quarantines"),
  );
  assert.notEqual(path.dirname(state.quarantinePath), legacyRoot);
});

test("a substituted quarantine-root link is rejected before marker state is trusted", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));
  const state = await repositoryStatePaths(await canonicalGitCommonDirectory(workspace));
  const attackerDirectory = path.join(tempRoot, "attacker-controlled-quarantine-root");
  await mkdir(attackerDirectory);
  await rm(state.root, { recursive: true, force: true });
  await symlink(
    attackerDirectory,
    state.root,
    process.platform === "win32" ? "junction" : "dir",
  );

  const response = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.match(response.error?.message ?? "", /quarantine root must be a real directory/iu,
    JSON.stringify(response));
  assert.deepEqual(await readdir(attackerDirectory), []);
});

test("quarantine publication uses an exclusive directory claim without hard links", async (context) => {
  const quarantineRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-quarantine-store-test-"));
  context.after(() => rm(quarantineRoot, { recursive: true, force: true }));
  const key = "quarantine-directory-publication:" + String(process.pid) + ":" + String(Date.now());
  const quarantine = await markWorkspaceQuarantined(quarantineRoot, key, {
    backend: "fixture", terminationError: "descendants remain uncertain",
  });
  context.after(() => rm(quarantine.quarantinePath, { recursive: true, force: true }));
  assert.equal((await stat(quarantine.quarantinePath)).isDirectory(), true);
  const record = JSON.parse(await readFile(
    path.join(quarantine.quarantinePath, "record.json"), "utf8",
  ));
  assert.equal(record.quarantineId, quarantine.quarantineId);
  assert.equal(record.terminationError, "descendants remain uncertain");
  await assert.rejects(
    markWorkspaceQuarantined(
      quarantineRoot, key, { terminationError: "must not replace the first incident" },
    ),
    /quarantine marker already exists/iu,
  );
});

test("quarantine recovery requires an explicit incident-bound approval", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const initialized = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.equal(initialized.result.structuredContent.ok, true, JSON.stringify(initialized));

  const commonDir = await canonicalGitCommonDirectory(workspace);
  const lockStore = await coordinationLockStore(workspace);
  const key = await repositoryKey(commonDir);
  const ref = workspaceLockRef(key);
  const quarantineId = "explicit-recovery-" + Date.now();
  const ownerPath = path.join(tempRoot, "quarantined-owner.json");
  const now = Date.now();
  await writeFile(ownerPath, JSON.stringify({
    version: 1,
    token: "explicit-recovery-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: client.child.pid,
    ownerIdentity: null,
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    quarantineId,
    workerPid: 4242,
    acquiredAt: now,
    heartbeatAt: now,
  }));
  const { stdout: oid } = await execFileAsync("git", ["hash-object", "-w", ownerPath], {
    cwd: lockStore,
  });
  await execFileAsync("git", ["update-ref", ref, oid.trim()], { cwd: lockStore });

  const { root, quarantinePath, recoveryPath } = await repositoryStatePaths(commonDir);
  await mkdir(root, { recursive: true });
  context.after(() => rm(quarantinePath, { recursive: true, force: true }));
  context.after(() => rm(recoveryPath, { recursive: true, force: true }));
  const record = JSON.stringify({ quarantineId, terminationError: "fixture" });
  await writeFile(quarantinePath, record);
  // Simulate routine temp cleanup. Absence alone must leave the live
  // quarantined lease held and must not start a worker.
  await unlink(quarantinePath);
  const eventFile = path.join(tempRoot, "explicit-recovery-events.jsonl");
  const absentOnly = await client.request("tools/call", taskArguments(workspace, {
    name: "must-not-run-after-marker-loss", eventFile,
  }, { timeoutMs: 5_000 }), 132);
  assert.equal(absentOnly.result.structuredContent.ok, false, JSON.stringify(absentOnly));
  assert.match(absentOnly.result.structuredContent.error, /timed out.*workspace lock/iu);
  assert.equal((await events(eventFile)).length, 0);

  // Renaming the incident record is the documented explicit approval. The CAS
  // winner consumes it only after acquiring the exact quarantined lease.
  await mkdir(quarantinePath);
  await writeFile(path.join(quarantinePath, "record.json"), record);
  await rename(quarantinePath, recoveryPath);
  const recovered = await client.request("tools/call", taskArguments(workspace, {
    name: "after-explicit-recovery", eventFile, delayMs: 10,
  }, { timeoutMs: 20_000 }), 133);
  assert.equal(recovered.result.structuredContent.ok, true, JSON.stringify(recovered));
  await assert.rejects(access(recoveryPath), /ENOENT/u,
    "the successful CAS owner must consume the recovery authorization");
});

test("a request cancelled while queued never starts its backend", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const first = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 3_000,
  }), 101);
  await waitFor(async () => (await events(eventFile)).some((item) => item.name === "holder" && item.event === "start"));
  const queued = client.request("tools/call", taskArguments(path.join(workspace, "."), {
    name: "cancelled", eventFile, writeFile: "must-not-exist.txt",
  }), 102);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 102, reason: "test cancellation" });

  const queuedResponse = await queued;
  assert.ok(Date.now() - cancelledAt < 1_500, "queued cancellation should bypass the held workspace lock");
  const third = client.request("tools/call", taskArguments(workspace, {
    name: "third", eventFile, delayMs: 10,
  }), 103);
  const [firstResponse, thirdResponse] = await Promise.all([first, third]);
  assert.equal(firstResponse.result.structuredContent.ok, true);
  assert.equal(thirdResponse.result.structuredContent.ok, true);
  assert.equal(queuedResponse.result.isError, true);
  assert.equal(queuedResponse.result.structuredContent.cancelled, true);
  assert.equal((await events(eventFile)).some((item) => item.name === "cancelled"), false);
  assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
    "start:holder", "end:holder", "start:third", "end:third",
  ]);
  await assert.rejects(access(path.join(workspace, "must-not-exist.txt")), /ENOENT/u);
});

test("cancellation interrupts initial Git repository discovery", {
  skip: process.platform === "win32",
}, async (context) => {
  const { tempRoot, workspace, configPath } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "git-discovery-events.jsonl");
  const wrapper = path.join(tempRoot, "git");
  await writeFile(wrapper, [
    "#!/usr/bin/env node",
    "const { appendFileSync } = require('node:fs');",
    "appendFileSync(" + JSON.stringify(eventFile) + ", JSON.stringify({event:'git-start'}) + '\\n');",
    "setTimeout(() => {}, 60000);",
  ].join("\n"));
  await chmod(wrapper, 0o755);
  const delayedClient = new McpClient(configPath, {
    PATH: tempRoot + path.delimiter + process.env.PATH,
  });
  try {
    await delayedClient.initialize();
    const pending = delayedClient.request("tools/call", taskArguments(workspace, {
      name: "must-not-start", writeFile: "discovery-cancelled.txt",
    }), 111);
    await waitFor(async () => (await events(eventFile)).some((item) => item.event === "git-start"));
    const cancelledAt = Date.now();
    delayedClient.notify("notifications/cancelled", { requestId: 111 });
    const response = await pending;
    assert.ok(Date.now() - cancelledAt < 1_500, "Git discovery cancellation should settle promptly");
    assert.equal(response.result.structuredContent.cancelled, true);
    await assert.rejects(access(path.join(workspace, "discovery-cancelled.txt")), /ENOENT/u);
  } finally {
    await delayedClient.close();
  }
});

test("cancellation interrupts workspace filesystem canonicalization", async (context) => {
  const { workspace, configPath } = await makeHarness(context);
  const delayedClient = new McpClient(configPath, {
    NODE_ENV: "test",
    CLI_AGENT_BRIDGE_TEST_WORKSPACE_VALIDATION_DELAY_MS: "10000",
  });
  context.after(() => delayedClient.close());
  await delayedClient.initialize();
  const request = delayedClient.request("tools/call", taskArguments(workspace, {
    name: "must-not-start", writeFile: "canonicalization-bypass.txt",
  }), 611);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  delayedClient.notify("notifications/cancelled", { requestId: 611 });
  const response = await request;
  assert.ok(Date.now() - cancelledAt < 1_500,
    "filesystem validation must not pin the request after cancellation");
  assert.equal(response.result.structuredContent.cancelled, true);
  await assert.rejects(access(path.join(workspace, "canonicalization-bypass.txt")), /ENOENT/u);
});

test("backend command resolution obeys cancellation and the absolute request deadline", async (context) => {
  const resolutionRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-resolution-deadline-test-"));
  const resolutionStartedFile = path.join(resolutionRoot, "started.txt");
  context.after(() => rm(resolutionRoot, { recursive: true, force: true }));
  const { tempRoot, workspace, client } = await makeHarness(context, {
    extraEnv: {
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_DELAY_MS: "60000",
      CLI_AGENT_BRIDGE_TEST_COMMAND_RESOLUTION_STARTED_FILE: resolutionStartedFile,
    },
  });
  const eventFile = path.join(tempRoot, "resolution-must-not-start.jsonl");
  const cancelledRequest = client.request("tools/call", taskArguments(workspace, {
    name: "cancelled-during-resolution", eventFile,
  }, { timeoutMs: 20_000 }), 612);
  await waitFor(() => access(resolutionStartedFile).then(() => true, () => false));
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 612 });
  const cancelled = await cancelledRequest;
  assert.ok(Date.now() - cancelledAt < 1_500,
    "command resolution must stop pinning a cancelled request promptly");
  assert.equal(cancelled.result.structuredContent.cancelled, true, JSON.stringify(cancelled));

  const deadlineStarted = Date.now();
  const timedOut = await client.request("tools/call", taskArguments(workspace, {
    name: "timed-out-during-resolution", eventFile,
  }, { timeoutMs: 5_000 }), 613);
  const elapsed = Date.now() - deadlineStarted;
  assert.ok(elapsed >= 4_500 && elapsed < 8_000,
    "command resolution must use the request's existing absolute deadline");
  assert.equal(timedOut.result.structuredContent.timedOut, true, JSON.stringify(timedOut));
  assert.equal(timedOut.result.structuredContent.treeTerminated, true);
  assert.match(timedOut.result.structuredContent.error, /resolving the backend command/iu);
  assert.equal((await readFile(resolutionStartedFile, "utf8")).trim().split(/\r?\n/u).length, 1,
    "cancelled and timed-out callers must share the same underlying filesystem lookup");
  assert.equal((await events(eventFile)).length, 0, "the backend must never be launched");
});

test("cancellation terminates descendants before returning", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 1_200,
    descendantWriteFile: "descendant-survived.txt",
  }), 201);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  client.notify("notifications/cancelled", { requestId: 201, reason: "test process-tree cancellation" });

  const response = await delegated;
  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.cancelled, true);
  assert.equal(response.result.structuredContent.treeTerminated, true, JSON.stringify(response));
  const followUp = await client.request("tools/call", taskArguments(workspace, {
    name: "after-cancel", writeFile: "follow-up.txt", contents: "safe\n",
  }));
  assert.equal(followUp.result.structuredContent.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "descendant-survived.txt")), /ENOENT/u);
});

test("cancellation terminates a descendant that creates a new POSIX session", {
  skip: process.platform === "win32",
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "detached-descendant-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "detached-tree",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    descendantDelayMs: 1_200,
    descendantWriteFile: "detached-descendant-survived.txt",
  }), 211);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  // Give the 25 ms ancestry monitor time to record the detached child before cancellation.
  await new Promise((resolve) => setTimeout(resolve, 100));
  client.notify("notifications/cancelled", { requestId: 211 });

  const response = await delegated;
  assert.equal(response.result.structuredContent.cancelled, true);
  assert.equal(response.result.structuredContent.treeTerminated, true);
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "detached-descendant-survived.txt")), /ENOENT/u);
});

test("a detached child remains contained when its parent exits before ancestry polling", {
  skip: process.platform !== "linux",
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "fast-parent-events.jsonl");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fast-parent",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    parentDelayMs: 0,
    descendantDelayMs: 1_200,
    descendantWriteFile: "fast-parent-descendant-survived.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.treeTerminated, true, JSON.stringify(out));
  assert.equal(out.orphanedProcesses, true,
    "the close path discovers the reparented child through its inherited run marker");
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(access(path.join(workspace, "fast-parent-descendant-survived.txt")), /ENOENT/u);
});

test("Windows Job cleanup removes a detached child after normal backend exit", {
  skip: process.platform !== "win32",
}, async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "windows-job-detached-events.jsonl");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "windows-job-detached",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    parentDelayMs: 0,
    descendantDelayMs: 1_200,
    descendantWriteFile: "windows-job-descendant-survived.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.treeTerminated, true, JSON.stringify(out));
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  await assert.rejects(
    access(path.join(workspace, "windows-job-descendant-survived.txt")), /ENOENT/u,
  );
});

test("timeout terminates descendants before releasing the request", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "events.jsonl");
  const startedAt = Date.now();
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "timeout-tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 8_000,
    descendantWriteFile: "timeout-descendant-survived.txt",
  }, { timeoutMs: 5_000 }), 202);

  assert.ok(response.result, JSON.stringify(response));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.timedOut, true);
  assert.equal(response.result.structuredContent.treeTerminated, true);
  const remaining = Math.max(0, 8_500 - (Date.now() - startedAt));
  await new Promise((resolve) => setTimeout(resolve, remaining));
  await assert.rejects(access(path.join(workspace, "timeout-descendant-survived.txt")), /ENOENT/u);
});

test("workspace status and delegation support an unborn HEAD", async (context) => {
  const { workspace, client } = await makeHarness(context, { unborn: true });
  const status = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: workspace },
  });
  assert.equal(status.result.structuredContent.ok, true);
  assert.equal(status.result.structuredContent.git.head, "");

  const delegated = await client.request("tools/call", taskArguments(workspace, {
    name: "unborn", writeFile: "created.txt", contents: "created\n",
  }));
  assert.equal(delegated.result.structuredContent.ok, true);
  assert.equal(delegated.result.structuredContent.gitBefore.head, "");
  assert.deepEqual(delegated.result.structuredContent.git.changedFiles, ["created.txt"]);
});

test("commits on a new branch are reported when the worker returns to the original HEAD", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "branch-round-trip",
    branchRoundTrip: true,
    branchName: "worker-created-branch",
    writeFile: "branch-only.txt",
    commitMessage: "commit outside final HEAD",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify({
    error: out.error, terminationError: out.terminationError,
  }));
  assert.equal(out.gitBefore.head, out.git.head, "worker must return to the original HEAD");
  assert.deepEqual(out.git.changedFiles, []);
  assert.ok(out.commits, "ref changes must produce a commits block even when HEAD is unchanged");
  assert.ok(out.commits.refsChanged.some((item) =>
    item.ref === "refs/heads/worker-created-branch" && !item.before && item.after,
  ), JSON.stringify(out.commits.refsChanged));
  assert.match(out.commits.log, /commit outside final HEAD/u);
});

test("changedFiles preserves unusual names and scans from the worktree root", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const nested = path.join(workspace, "nested", "deep");
  await mkdir(nested, { recursive: true });
  await execFileAsync("git", ["config", "core.quotePath", "true"], { cwd: workspace });
  const leading = path.join(nested, " leading.txt");
  await writeFile(leading, "before\n");
  await execFileAsync("git", ["add", "nested/deep/ leading.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "add unusual path"], { cwd: workspace });
  await writeFile(leading, "after\n");
  await writeFile(path.join(nested, "café-staged.txt"), "staged\n");
  await execFileAsync("git", ["add", "nested/deep/café-staged.txt"], { cwd: workspace });
  await writeFile(path.join(nested, "café-untracked.txt"), "untracked\n");
  await writeFile(path.join(workspace, "root-new.txt"), "root\n");

  const status = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: nested },
  });
  const names = status.result.structuredContent.git.changedFiles;
  assert.ok(names.includes("nested/deep/ leading.txt"), JSON.stringify(names));
  assert.ok(names.includes("nested/deep/café-staged.txt"), JSON.stringify(names));
  assert.ok(names.includes("nested/deep/café-untracked.txt"), JSON.stringify(names));
  assert.ok(names.includes("root-new.txt"), JSON.stringify(names));
  assert.equal(status.result.structuredContent.worktreeRoot, await realpath(workspace));
});

test("changedFiles losslessly represents non-UTF-8 Git path bytes", {
  // Linux filesystems expose arbitrary byte names. macOS normalizes/rejects
  // invalid UTF-8 (EILSEQ), and Windows filenames use Unicode APIs.
  skip: process.platform !== "linux",
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  const rawName = Buffer.from([0x62, 0x61, 0x64, 0x2d, 0x80, 0x2e, 0x74, 0x78, 0x74]);
  const rawPath = Buffer.concat([Buffer.from(workspace), Buffer.from(path.sep), rawName]);
  await writeFile(rawPath, "invalid UTF-8 filename\n");
  const status = await client.request("tools/call", {
    name: "workspace_status", arguments: { workspacePath: workspace },
  });
  assert.ok(status.result.structuredContent.git.changedFiles.includes(
    "\0git-path-bytes:" + rawName.toString("hex"),
  ), JSON.stringify(status.result.structuredContent.git.changedFiles));
});

test("truncated backend capture is disclosed instead of presented as complete", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "large-output", stdoutChars: 5_100_000,
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true);
  assert.equal(out.outputTruncated, true);
  assert.ok(out.outputTail.length <= 60_000);
});

test("numeric and string JSON-RPC request IDs remain distinct", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const secondWorkspace = path.join(tempRoot, "workspace-two");
  await mkdir(secondWorkspace);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: secondWorkspace });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: secondWorkspace });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: secondWorkspace });
  await writeFile(path.join(secondWorkspace, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: secondWorkspace });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: secondWorkspace });
  const eventFile = path.join(tempRoot, "typed-id-events.jsonl");

  const numeric = client.request("tools/call", taskArguments(workspace, {
    name: "numeric", eventFile, delayMs: 2_500, writeFile: "numeric.txt",
  }), 301);
  const string = client.request("tools/call", taskArguments(secondWorkspace, {
    name: "string", eventFile, delayMs: 300, writeFile: "string.txt",
  }), "301");
  await waitFor(async () => {
    const seen = await events(eventFile);
    return seen.some((item) => item.name === "numeric" && item.event === "start") &&
      seen.some((item) => item.name === "string" && item.event === "start");
  });
  client.notify("notifications/cancelled", { requestId: 301 });

  const [numericResponse, stringResponse] = await Promise.all([numeric, string]);
  assert.equal(numericResponse.result.structuredContent.cancelled, true);
  assert.equal(stringResponse.result.structuredContent.ok, true);
  await assert.rejects(access(path.join(workspace, "numeric.txt")), /ENOENT/u);
  await access(path.join(secondWorkspace, "string.txt"));
});

test("workspace_status waits for an active delegation on the same worktree", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const nested = path.join(workspace, "nested");
  await mkdir(nested);
  const eventFile = path.join(tempRoot, "status-lock-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 1_200, writeFile: "finished.txt",
  }));
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "start"));
  const status = client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: nested },
  });
  const early = await Promise.race([
    status.then(() => "completed"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 250)),
  ]);
  assert.equal(early, "pending", "status snapshot must wait for the delegation lock");
  const [delegatedResponse, statusResponse] = await Promise.all([delegated, status]);
  assert.equal(delegatedResponse.result.structuredContent.ok, true);
  assert.ok(statusResponse.result.structuredContent.git.changedFiles.includes("finished.txt"));
});

test("workspace_status can be cancelled while queued for the workspace lock", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "status-cancel-events.jsonl");
  const delegated = client.request("tools/call", taskArguments(workspace, {
    name: "holder", eventFile, delayMs: 2_000,
  }), 501);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "start"));
  const status = client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: workspace },
  }, 502);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = Date.now();
  client.notify("notifications/cancelled", { requestId: 502 });

  const statusResponse = await status;
  assert.ok(Date.now() - cancelledAt < 1_500, "queued status cancellation should settle promptly");
  assert.equal(statusResponse.result.isError, true);
  assert.equal(statusResponse.result.structuredContent.cancelled, true);
  assert.equal(statusResponse.result.structuredContent.git, null);
  assert.equal((await delegated).result.structuredContent.ok, true);
});

test("closing MCP stdin terminates active worker descendants", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const eventFile = path.join(tempRoot, "shutdown-events.jsonl");
  const pending = client.request("tools/call", taskArguments(workspace, {
    name: "shutdown-tree",
    eventFile,
    spawnDescendant: true,
    descendantDelayMs: 1_500,
    descendantWriteFile: "shutdown-descendant-survived.txt",
  }), 401).catch(() => null);
  await waitFor(async () => (await events(eventFile)).some((item) => item.event === "descendant-start"));
  await client.disconnectInput();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  await assert.rejects(access(path.join(workspace, "shutdown-descendant-survived.txt")), /ENOENT/u);
});

test("broken MCP stdout awaits active worker shutdown and lease release", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const secondWorkspace = path.join(tempRoot, "stdout-late-workspace");
  await mkdir(secondWorkspace);
  await initializeFixtureRepository(secondWorkspace);
  const eventFile = path.join(tempRoot, "stdout-shutdown-events.jsonl");
  const survivor = path.join(workspace, "stdout-descendant-survived.txt");
  const pending = client.request("tools/call", taskArguments(workspace, {
    name: "stdout-shutdown-tree",
    eventFile,
    spawnDescendant: true,
    detachedDescendant: true,
    ignoreSigterm: true,
    descendantDelayMs: 1_500,
    descendantWriteFile: path.basename(survivor),
  }), 411).catch(() => null);
  await waitFor(async () => (await events(eventFile)).some(
    (item) => item.event === "descendant-start",
  ));

  const exited = new Promise((resolve) => client.child.once("exit", resolve));
  client.child.stdout.destroy();
  // Force a response write while the delegation above is active. The broken
  // pipe must enter the awaited shutdown path instead of crashing immediately.
  client.child.stdin.write(JSON.stringify({
    jsonrpc: "2.0", id: 412, method: "tools/list", params: {},
  }) + "\n", () => {});
  // Keep the first cleanup in flight on Linux, then attempt a request for an
  // independent repository. Without a dispatch gate it can start after the
  // shutdown snapshot and escape the awaited cleanup set.
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (client.child.exitCode === null) {
    client.child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 414,
      method: "tools/call",
      params: taskArguments(secondWorkspace, {
        name: "must-not-start-after-stdout-shutdown", eventFile, delayMs: 60_000,
      }),
    }) + "\n", () => {});
  }
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("server did not exit after stdout disconnected")), 15_000,
    )),
  ]);
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  await assert.rejects(access(survivor), /ENOENT/u,
    "the server must not exit before its detached worker tree is terminated");
  assert.equal((await events(eventFile)).some(
    (item) => item.name === "must-not-start-after-stdout-shutdown",
  ), false, "shutdown must close dispatch before snapshotting active requests");

  const replacement = new McpClient(configPath);
  context.after(() => replacement.close());
  await replacement.initialize();
  const recovered = await replacement.request("tools/call", taskArguments(workspace, {
    name: "after-stdout-shutdown", delayMs: 10,
  }), 413);
  assert.equal(recovered.result.structuredContent.ok, true, JSON.stringify(recovered));
});

test("checking out a pre-existing divergent branch is not reported as worker commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  // Create a divergent branch whose commits predate the delegation.
  await execFileAsync("git", ["checkout", "-b", "divergent"], { cwd: workspace });
  await writeFile(path.join(workspace, "divergent.txt"), "pre-existing history\n");
  await execFileAsync("git", ["add", "divergent.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "pre-existing divergent commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "checkout-only", checkoutExisting: true, branchName: "divergent",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.notEqual(out.gitBefore.head, out.git.head, "worker must have moved HEAD");
  assert.ok(out.commits, "a HEAD movement must still produce a commits block");
  assert.match(out.commits.log, /branch checkout or reset/u);
  assert.doesNotMatch(out.commits.log, /pre-existing divergent commit/u,
    "history that predates the delegation must not be attributed to the worker");
});

test("switching symbolic HEAD at the same commit is reported", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["branch", "same-tip"], { cwd: workspace });
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "same-tip-checkout", checkoutExisting: true, branchName: "same-tip",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.gitBefore.head, out.git.head);
  assert.equal(out.gitBefore.headRef, "refs/heads/main");
  assert.equal(out.git.headRef, "refs/heads/same-tip");
  assert.ok(out.commits);
  assert.match(out.commits.log, /HEAD symbolic target refs\/heads\/main -> refs\/heads\/same-tip/u);
});

test("a worker ref pointing at a non-commit object is reported without failing the delegation", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "blob-tag", blobTag: true, refName: "refs/tags/blobtag",
  }));
  assert.equal(response.result.error, undefined, "the delegation must not surface a JSON-RPC error");
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.ok(out.commits.refsChanged.some((item) => item.ref === "refs/tags/blobtag" && item.after),
    JSON.stringify(out.commits.refsChanged));
  assert.match(out.commits.log, /non-commit object/u);
});

test("a worker commit reachable only through a new tag remains attributed", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const refName = "refs/tags/tag-only-worker-commit";
  const temporaryBranch = "temporary-tag-only-worker-commit";
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "tag-only-worker-commit",
    moveBlobRefToCommit: true,
    refName,
    branchName: temporaryBranch,
    writeFile: "tag-only-worker.txt",
    commitMessage: "worker commit retained only by tag",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.gitBefore.head, out.git.head, "the temporary branch must not move final HEAD");
  assert.deepEqual(out.commits.refsChanged.map((item) => item.ref), [refName]);
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.equal((out.commits.log.match(/worker commit retained only by tag/gu) ?? []).length, 1);
  assert.match(out.commits.diffStat, /tag-only-worker\.txt/u);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", "refs/heads/" + temporaryBranch], {
      cwd: workspace,
    }),
  );
});

test("target refs resembling coordination refs remain visible to attribution", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const refName = WORKSPACE_LOCK_REF_PREFIX + "legitimate-target-ref";
  const oldBlobPath = path.join(tempRoot, "legitimate-target-ref-blob.txt");
  await writeFile(oldBlobPath, "old target ref blob\n");
  const { stdout: blobOid } = await execFileAsync(
    "git", ["hash-object", "-w", oldBlobPath], { cwd: workspace },
  );
  await execFileAsync("git", ["update-ref", refName, blobOid.trim()], { cwd: workspace });
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "legitimate-coordination-like-ref", moveBlobRefToCommit: true, refName,
    writeFile: "legitimate-ref-commit.txt", commitMessage: "commit behind legitimate target ref",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.commits.refsChanged.some((item) => item.ref === refName && item.after),
    JSON.stringify(out.commits.refsChanged));
  assert.match(out.commits.log, /commit behind legitimate target ref/u);
  assert.match(out.commits.diffStat, /legitimate-ref-commit\.txt/u);
});

test("a ref moved from a blob to a new commit uses a commit-safe diff base", async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-commit-safe-base-test-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace);
  await initializeFixtureRepository(workspace);
  context.after(() => rm(tempRoot, { recursive: true, force: true }));
  const refName = "refs/tags/blob-to-commit";
  const oldBlobPath = path.join(tempRoot, "old-blob.txt");
  await writeFile(oldBlobPath, "old blob\n");
  const { stdout: blobOid } = await execFileAsync(
    "git", ["hash-object", "-w", oldBlobPath], { cwd: workspace },
  );
  await execFileAsync("git", ["update-ref", refName, blobOid.trim()], { cwd: workspace });
  const { stdout: headText } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
  const head = headText.trim();
  const before = {
    head,
    headRef: "refs/heads/main",
    refs: { "refs/heads/main": head, [refName]: blobOid.trim() },
    fetchHeads: [],
  };

  await execFileAsync("git", ["checkout", "-b", "temporary-ref-commit"], { cwd: workspace });
  await writeFile(path.join(workspace, "ref-commit.txt"), "ref commit\n");
  await execFileAsync("git", ["add", "ref-commit.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "commit behind moved ref"], { cwd: workspace });
  const { stdout: newCommitText } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
  });
  const newCommit = newCommitText.trim();
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });
  await execFileAsync("git", ["branch", "-D", "temporary-ref-commit"], { cwd: workspace });
  await execFileAsync("git", ["update-ref", refName, newCommit], { cwd: workspace });
  const after = {
    head,
    headRef: "refs/heads/main",
    refs: { "refs/heads/main": head, [refName]: newCommit },
    fetchHeads: [],
  };

  const commits = await committedDelta(workspace, before, after);
  assert.match(commits.log, /commit behind moved ref/u);
  assert.match(commits.diffStat, /ref-commit\.txt/u);
  assert.doesNotMatch(commits.diffStat, new RegExp(blobOid.trim(), "u"));
});

test("a force-moved ref diffs from an ancestral pre-run baseline", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["branch", "force-target"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "-b", "source-lineage"], { cwd: workspace });
  await writeFile(path.join(workspace, "source-only.txt"), "pre-existing source history\n");
  await execFileAsync("git", ["add", "source-only.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "pre-existing source commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "force-ref", forceRefFromExisting: true, fromBranch: "source-lineage",
    refName: "refs/heads/force-target", writeFile: "forced-worker.txt",
    commitMessage: "worker commit after force move",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /worker commit after force move/u);
  assert.doesNotMatch(out.commits.log, /pre-existing source commit/u);
  assert.match(out.commits.diffStat, /forced-worker\.txt/u);
  assert.doesNotMatch(out.commits.diffStat, /source-only\.txt/u,
    "the old non-ancestral ref tip must not be used as the diff base");
});

test("linked worktrees sharing Git refs serialize across server processes", async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const linkedWorkspace = path.join(tempRoot, "linked-worktree");
  await execFileAsync("git", ["worktree", "add", "-b", "comparison-worktree", linkedWorkspace], {
    cwd: workspace,
  });
  assert.equal(
    await canonicalGitCommonDirectory(workspace),
    await canonicalGitCommonDirectory(linkedWorkspace),
  );
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "linked-worktree-events.jsonl");
    const first = client.request("tools/call", taskArguments(workspace, {
      name: "main-worktree", eventFile, delayMs: 800, writeFile: "main-only.txt",
    }));
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "main-worktree" && item.event === "start",
    ));
    const second = secondClient.request("tools/call", taskArguments(linkedWorkspace, {
      name: "linked-worktree", eventFile, delayMs: 10, writeFile: "linked-only.txt",
    }));

    const responses = await Promise.all([first, second]);
    assert.ok(responses.every((response) => response.result.structuredContent.ok));
    assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
      "start:main-worktree", "end:main-worktree",
      "start:linked-worktree", "end:linked-worktree",
    ]);
  } finally {
    await secondClient.close();
  }
});

test("repository renames cannot create a second cross-process lease", {
  skip: process.platform !== "linux" ? "Linux rename-stable directory handle fixture" : false,
}, async (context) => {
  const { tempRoot, workspace, configPath, client } = await makeHarness(context);
  const movedWorkspace = path.join(tempRoot, "renamed-workspace");
  const secondClient = new McpClient(configPath);
  try {
    await secondClient.initialize();
    const eventFile = path.join(tempRoot, "renamed-repository-events.jsonl");
    const first = client.request("tools/call", taskArguments(workspace, {
      name: "pre-rename-holder", eventFile, delayMs: 3_000,
    }), 17881);
    await waitFor(async () => (await events(eventFile)).some(
      (item) => item.name === "pre-rename-holder" && item.event === "start",
    ));
    await rename(workspace, movedWorkspace);
    const second = secondClient.request("tools/call", taskArguments(movedWorkspace, {
      name: "post-rename-waiter", eventFile, delayMs: 10, writeFile: "second-after-rename.txt",
    }), 17882);
    const early = await Promise.race([
      second.then(() => "completed"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    assert.equal(early, "pending", "the moved repository must retain the original lease identity");
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal((await events(eventFile)).some(
      (item) => item.name === "post-rename-waiter" && item.event === "start",
    ), false, "the second process must reach the shared lease before the first worker exits");
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.match(firstResponse.error?.message ?? "", /git snapshot unreliable/iu,
      "the old absolute worktree path should fail its post-run snapshot explicitly");
    assert.equal(secondResponse.result.structuredContent.ok, true, JSON.stringify(secondResponse));
    assert.deepEqual((await events(eventFile)).map((item) => item.event + ":" + item.name), [
      "start:pre-rename-holder", "end:pre-rename-holder",
      "start:post-rename-waiter", "end:post-rename-waiter",
    ]);
  } finally {
    await secondClient.close();
  }
});


test("a commit on the checked-out branch is reported exactly once", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "current-commit", commitCurrent: true,
    writeFile: "current.txt", commitMessage: "single worker commit",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.ok(out.commits, "HEAD and its branch both moved; a commits block must exist");
  assert.equal(out.commits.newCommitCount, 1,
    "HEAD and refs/heads/main move across the same pair; count must not double");
  assert.equal(out.commits.log.split("single worker commit").length - 1, 1,
    out.commits.log);
  assert.match(out.commits.log, /HEAD, refs\/heads\/main/u,
    "the deduplicated target carries both labels");
});

test("one commit reached through a branch and tag is counted and logged once", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "current-commit-with-tag", commitCurrent: true,
    writeFile: "tagged-current.txt", commitMessage: "single tagged worker commit",
    refName: "refs/tags/worker-tag",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 1);
  assert.equal(out.commits.log.split("single tagged worker commit").length - 1, 1,
    out.commits.log);
  assert.match(out.commits.log, /HEAD, refs\/heads\/main, refs\/tags\/worker-tag/u,
    "the unique commit retains every contributing ref label");
  assert.match(out.commits.diffStat, /HEAD, refs\/heads\/main, refs\/tags\/worker-tag/u,
    "the identical commit range is emitted once with every contributing ref label");
});

test("a new branch forked from a divergent branch diffs only its own commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  await execFileAsync("git", ["checkout", "-b", "divergent"], { cwd: workspace });
  await writeFile(path.join(workspace, "divergent.txt"), "pre-existing divergent file\n");
  await execFileAsync("git", ["add", "divergent.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "divergent baseline commit"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fork-worker", newBranchFromExisting: true,
    fromBranch: "divergent", branchName: "forked-work",
    writeFile: "fork.txt", commitMessage: "forked worker commit",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.match(out.commits.log, /forked worker commit/u);
  assert.doesNotMatch(out.commits.log, /divergent baseline commit/u);
  assert.doesNotMatch(out.commits.diffStat, /divergent\.txt/u,
    "the diff base is the fork point, not the original HEAD");
  assert.match(out.commits.diffStat, /fork\.txt/u);
});

test("new-branch attribution considers baselines beyond the first 256 tips", {
  skip: process.platform === "win32",
}, async (context) => {
  const { workspace, client } = await makeHarness(context);
  const { stdout: mainTree } = await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: workspace });
  for (let index = 0; index < 256; index += 1) {
    const { stdout: oid } = await execFileAsync(
      "git",
      ["commit-tree", mainTree.trim(), "-p", "HEAD", "-m", "filler " + String(index)],
      { cwd: workspace },
    );
    await execFileAsync(
      "git", ["update-ref", `refs/heads/a-filler-${String(index).padStart(3, "0")}`, oid.trim()],
      { cwd: workspace },
    );
  }
  await execFileAsync("git", ["checkout", "-b", "zzz-source"], { cwd: workspace });
  await writeFile(path.join(workspace, "late-source.txt"), "pre-existing late baseline\n");
  await execFileAsync("git", ["add", "late-source.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "late source baseline"], { cwd: workspace });
  await execFileAsync("git", ["checkout", "main"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "late-baseline-worker", newBranchFromExisting: true,
    fromBranch: "zzz-source", branchName: "late-baseline-work",
    writeFile: "late-worker.txt", commitMessage: "late baseline worker commit",
  }, { timeoutMs: 120_000 }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.match(out.commits.log, /late baseline worker commit/u);
  assert.doesNotMatch(out.commits.diffStat, /late-source\.txt/u,
    "the source tip after 256 other baselines remains the selected diff base");
  assert.match(out.commits.diffStat, /late-worker\.txt/u);
});

test("direct remote-tracking ref writes do not hide worker-created commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fetch-then-work", fetchAndCommit: true,
    branchName: "fetched-work", writeFile: "worker-after-fetch.txt",
    commitMessage: "worker commit after fetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 2, out.commits.log);
  assert.match(out.commits.log, /worker commit after fetch/u);
  assert.match(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.diffStat, /upstream\.txt/u);
  assert.match(out.commits.diffStat, /worker-after-fetch\.txt/u);
});

test("provenance reads stay bound to the originally opened regular file", async (context) => {
  const fixture = await makeTraceFixture(context);
  await unlink(fixture.tracePath);
  await writeFile(fixture.tracePath, "");
  await assert.rejects(
    readBackendGitProvenance(fixture, pluginRoot),
    /no longer identifies the original regular file/iu,
  );
});

test("provenance reads reject FIFO and device symlink replacements without hanging", {
  skip: process.platform !== "linux",
}, async () => {
  const source = [
    "import {execFileSync} from 'node:child_process'",
    "import {mkdtemp,open,rm,symlink,unlink} from 'node:fs/promises'",
    "import os from 'node:os'",
    "import path from 'node:path'",
    `import {readBackendGitProvenance} from ${JSON.stringify(pathToFileURL(serverPath).href)}`,
    "const mode=process.argv[1]",
    "const root=await mkdtemp(path.join(os.tmpdir(),'trace-replacement-child-'))",
    "const tracePath=path.join(root,'git.trace')",
    "const handle=await open(tracePath,'wx+',0o600)",
    "const identity=await handle.stat({bigint:true})",
    "await unlink(tracePath)",
    "if(mode==='fifo')execFileSync('mkfifo',[tracePath]);else await symlink('/dev/zero',tracePath)",
    "let rejected=false",
    "try{await readBackendGitProvenance({tracePath,handle,identity},process.cwd())}catch{rejected=true}",
    "await handle.close();await rm(root,{recursive:true,force:true})",
    "if(!rejected)process.exit(3)",
  ].join(";");
  for (const mode of ["fifo", "device"]) {
    await execFileAsync(process.execPath, [
      "--max-old-space-size=32", "--input-type=module", "-e", source, mode,
    ], { timeout: 3_000, maxBuffer: 1_000_000 });
  }
});

test("provenance reads are bounded and interruptible", async (context) => {
  const oversized = await makeTraceFixture(context);
  await oversized.handle.truncate(5_000_001);
  await assert.rejects(
    readBackendGitProvenance(oversized, pluginRoot),
    /capture limit/iu,
  );

  const cancelledFixture = await makeTraceFixture(context);
  let readStartedResolve;
  const readStarted = new Promise((resolve) => { readStartedResolve = resolve; });
  const stalledHandle = {
    stat: (...args) => cancelledFixture.handle.stat(...args),
    read: async () => {
      readStartedResolve();
      return await new Promise(() => {});
    },
  };
  const cancel = testCancellation();
  const cancelledRead = readBackendGitProvenance({
    ...cancelledFixture, handle: stalledHandle,
  }, pluginRoot, { cancel });
  await readStarted;
  const cancelledAt = Date.now();
  cancel.cancel();
  await assert.rejects(cancelledRead, /cancelled/iu);
  assert.ok(Date.now() - cancelledAt < 1_000);

  let expiredCalls = 0;
  const expiredHandle = {
    stat: async () => { expiredCalls += 1; return cancelledFixture.identity; },
    read: async () => { expiredCalls += 1; return { bytesRead: 0 }; },
  };
  await assert.rejects(readBackendGitProvenance({
    ...cancelledFixture, handle: expiredHandle,
  }, pluginRoot, { deadline: Date.now() - 1 }), /deadline/iu);
  assert.equal(expiredCalls, 0, "an already-expired read must not start filesystem I/O");

  const denseFixture = await makeTraceFixture(context);
  const denseTrace = Buffer.from("{}\n".repeat(1_600_000));
  await denseFixture.handle.write(denseTrace, 0, denseTrace.length, 0);
  const parsingAt = Date.now();
  await assert.rejects(readBackendGitProvenance(
    denseFixture, pluginRoot, { deadline: parsingAt + 100 },
  ), /deadline/iu);
  assert.ok(Date.now() - parsingAt < 1_500,
    "parsing a dense bounded trace must continue to observe the request deadline");
});

test("a replaced backend provenance path degrades attribution and is cleaned up", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const traceRootFile = path.join(tempRoot, "trace-root.txt");
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "replace-provenance",
    replaceTraceThenWrite: true,
    traceRootFile,
    writeFile: "replacement-provenance.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.git.changedFiles.includes("replacement-provenance.txt"), JSON.stringify(out.git));
  assert.equal(out.commits.attributionUnavailable, true, JSON.stringify(out.commits));
  assert.equal(out.commits.newCommitCount, null);
  const traceRoot = await readFile(traceRootFile, "utf8");
  await assert.rejects(access(traceRoot), /ENOENT/u,
    "the controlled provenance directory should be removed after the worker settles");
});

test("a workspace fetch makes commit attribution explicitly unavailable", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const requestDirectory = path.join(workspace, "nested-request-directory");
  await mkdir(requestDirectory);
  const upstream = path.join(tempRoot, "local-ref-upstream");
  await mkdir(upstream);
  await execFileAsync("git", ["init"], { cwd: upstream });
  await execFileAsync("git", ["config", "user.name", "Upstream Fixture"], { cwd: upstream });
  await execFileAsync("git", ["config", "user.email", "upstream@example.invalid"], { cwd: upstream });
  await writeFile(path.join(upstream, "external-local-ref.txt"), "external history\n");
  await execFileAsync("git", ["add", "external-local-ref.txt"], { cwd: upstream });
  await execFileAsync("git", ["commit", "-m", "externally fetched local-ref commit"], { cwd: upstream });
  await execFileAsync("git", ["branch", "-M", "topic"], { cwd: upstream });

  const response = await client.request("tools/call", taskArguments(requestDirectory, {
    name: "fetch-local-ref-then-work", fetchIntoLocalRef: true, remotePath: upstream,
    importedRef: "refs/heads/imported-upstream", branchName: "local-fetch-work",
    writeFile: "worker-after-local-fetch.txt", commitMessage: "worker commit after local-ref fetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.commits.attributionUnavailable, true, JSON.stringify(out.commits));
  assert.equal(out.commits.newCommitCount, null);
  assert.equal(out.commits.log, "");
  assert.equal(out.commits.diffStat, null);
  assert.ok(out.commits.refsChanged.some((item) => item.ref === "refs/heads/imported-upstream"),
    JSON.stringify(out.commits.refsChanged));
});

test("successive fetches are detected even after FETCH_HEAD is overwritten", async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-successive-fetch-test-"));
  const workspace = path.join(tempRoot, "workspace");
  await mkdir(workspace);
  await initializeFixtureRepository(workspace);
  context.after(() => rm(tempRoot, { recursive: true, force: true }));
  const makeUpstream = async (name, fileName, message) => {
    const upstream = path.join(tempRoot, name);
    await mkdir(upstream);
    await execFileAsync("git", ["init"], { cwd: upstream });
    await execFileAsync("git", ["config", "user.name", "Upstream Fixture"], { cwd: upstream });
    await execFileAsync("git", ["config", "user.email", "upstream@example.invalid"], { cwd: upstream });
    await writeFile(path.join(upstream, fileName), message + "\n");
    await execFileAsync("git", ["add", fileName], { cwd: upstream });
    await execFileAsync("git", ["commit", "-m", message], { cwd: upstream });
    await execFileAsync("git", ["branch", "-M", "topic"], { cwd: upstream });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: upstream });
    return { upstream, oid: stdout.trim() };
  };
  const first = await makeUpstream("multi-fetch-a", "external-a.txt", "externally fetched A");
  const second = await makeUpstream("multi-fetch-b", "external-b.txt", "externally fetched B");
  const third = await makeUpstream("multi-fetch-c", "external-c.txt", "externally fetched C");
  // Preload A and B without retaining a ref/FETCH_HEAD baseline. Both in-run
  // fetches are up to date (no packet want); A also uses no destination and
  // suppresses FETCH_HEAD, so only the Trace2-bound explicit source
  // advertisement can prove its tip is external.
  await execFileAsync("git", ["fetch", first.upstream, "refs/heads/topic"], { cwd: workspace });
  await execFileAsync("git", ["fetch", second.upstream, "refs/heads/topic"], { cwd: workspace });
  await rm(path.join(workspace, ".git", "FETCH_HEAD"), { force: true });

  const tracePath = path.join(tempRoot, "successive-fetch.trace2");
  const traceHandle = await open(tracePath, "wx+", 0o600);
  context.after(() => traceHandle.close().catch(() => {}));
  const traceIdentity = await traceHandle.stat({ bigint: true });
  const env = backendGitProvenanceEnvironment(tracePath);
  await execFileAsync("git", [
    "-c", "protocol.version=0", "fetch", "--no-write-fetch-head",
    first.upstream, "refs/heads/topic",
  ], { cwd: workspace, env });
  await execFileAsync("git", ["update-ref", "refs/custom/imported-a", first.oid], { cwd: workspace, env });
  await execFileAsync("git", [
    "fetch", second.upstream, "refs/heads/topic:refs/custom/imported-b",
  ], { cwd: workspace, env });
  await execFileAsync("git", ["fetch", third.upstream, "refs/heads/topic"], { cwd: workspace, env });
  await execFileAsync("git", ["update-ref", "refs/custom/imported-c", third.oid], { cwd: workspace, env });

  const provenance = await readBackendGitProvenance({
    tracePath, handle: traceHandle, identity: traceIdentity,
  }, workspace);
  assert.equal(provenance.sawFetch, true);
  assert.equal(provenance.uncertain, true,
    "any successful target-repository fetch makes commit attribution unavailable");
  const fetchHead = await readFile(path.join(workspace, ".git", "FETCH_HEAD"), "utf8");
  assert.match(fetchHead, new RegExp(third.oid, "u"));
  assert.doesNotMatch(fetchHead, new RegExp(first.oid + "|" + second.oid, "u"),
    "the fixture must demonstrate that later fetches overwrote both earlier tips");
  for (const ref of ["refs/custom/imported-a", "refs/custom/imported-b", "refs/custom/imported-c"]) {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: workspace });
    assert.match(stdout, /^[0-9a-f]{40,64}\s*$/u);
  }
});

test("pull makes commit attribution explicitly unavailable", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const upstream = path.join(tempRoot, "pull-upstream");
  await execFileAsync("git", ["clone", workspace, upstream], { cwd: tempRoot });
  await execFileAsync("git", ["config", "user.name", "Upstream Fixture"], { cwd: upstream });
  await execFileAsync("git", ["config", "user.email", "upstream@example.invalid"], { cwd: upstream });
  await writeFile(path.join(upstream, "external-pull.txt"), "external\n");
  await execFileAsync("git", ["add", "external-pull.txt"], { cwd: upstream });
  await execFileAsync("git", ["commit", "-m", "external pull parent"], { cwd: upstream });
  await execFileAsync("git", ["branch", "-M", "topic"], { cwd: upstream });
  await writeFile(path.join(workspace, "local-before-pull.txt"), "local\n");
  await execFileAsync("git", ["add", "local-before-pull.txt"], { cwd: workspace });
  await execFileAsync("git", ["commit", "-m", "local baseline before pull"], { cwd: workspace });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "pull-with-local-merge", pullNoRebase: true, remotePath: upstream,
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.commits.attributionUnavailable, true, JSON.stringify(out.commits));
  assert.equal(out.commits.newCommitCount, null);
  assert.equal(out.commits.log, "");
});

test("a fetch in another repository does not disable target attribution", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const otherRepository = path.join(tempRoot, "other-repository");
  const upstream = path.join(tempRoot, "other-upstream");
  await mkdir(otherRepository);
  await mkdir(upstream);
  for (const repository of [otherRepository, upstream]) {
    await execFileAsync("git", ["init"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Other Fixture"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "other@example.invalid"], { cwd: repository });
    await writeFile(path.join(repository, "base.txt"), repository + "\n");
    await execFileAsync("git", ["add", "base.txt"], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "other baseline"], { cwd: repository });
  }
  await execFileAsync("git", ["branch", "-M", "topic"], { cwd: upstream });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "cross-repository-fetch", fetchOtherRepositoryThenCommit: true,
    otherRepository, remotePath: upstream,
    writeFile: "target-after-other-fetch.txt", commitMessage: "target commit after other fetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.commits.attributionUnavailable, undefined, JSON.stringify(out.commits));
  assert.equal(out.commits.newCommitCount, 1, out.commits.log);
  assert.match(out.commits.log, /target commit after other fetch/u);
  assert.match(out.commits.diffStat, /target-after-other-fetch\.txt/u);
});

test("fetch-only runs disclose unavailable attribution and retain worktree files", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const upstream = path.join(tempRoot, "fetch-only-upstream");
  await mkdir(upstream);
  await execFileAsync("git", ["init"], { cwd: upstream });
  await execFileAsync("git", ["config", "user.name", "Upstream Fixture"], { cwd: upstream });
  await execFileAsync("git", ["config", "user.email", "upstream@example.invalid"], { cwd: upstream });
  await writeFile(path.join(upstream, "external.txt"), "external\n");
  await execFileAsync("git", ["add", "external.txt"], { cwd: upstream });
  await execFileAsync("git", ["commit", "-m", "external fetch-only commit"], { cwd: upstream });
  await execFileAsync("git", ["branch", "-M", "topic"], { cwd: upstream });

  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fetch-only", fetchOnlyThenWrite: true, remotePath: upstream,
    writeFile: "after-fetch-only.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.commits.attributionUnavailable, true, JSON.stringify(out.commits));
  assert.deepEqual(out.commits.refsChanged, []);
  assert.equal(out.commits.newCommitCount, null);
  assert.ok(out.git.changedFiles.includes("after-fetch-only.txt"), JSON.stringify(out.git.changedFiles));
});

test("malformed provenance cannot discard a completed worktree snapshot", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "malformed-provenance", corruptTraceThenWrite: true,
    writeFile: "after-malformed-provenance.txt",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.commits.attributionUnavailable, true, JSON.stringify(out.commits));
  assert.equal(out.commits.newCommitCount, null);
  assert.ok(out.git.changedFiles.includes("after-malformed-provenance.txt"),
    JSON.stringify(out.git.changedFiles));
});

test("direct tag writes do not hide worker-created commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "fetch-tag-then-work", fetchAndCommit: true, fetchTagOnly: true,
    branchName: "fetched-tag-work", writeFile: "worker-after-tag.txt",
    commitMessage: "worker commit after fetched tag",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 2, out.commits.log);
  assert.match(out.commits.log, /worker commit after fetched tag/u);
  assert.match(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.diffStat, /upstream\.txt/u);
  assert.match(out.commits.diffStat, /worker-after-tag\.txt/u);
});

test("direct prefetch ref writes do not hide worker-created commits", async (context) => {
  const { workspace, client } = await makeHarness(context);
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "prefetch-then-work", fetchAndCommit: true, fetchPrefetch: true,
    branchName: "prefetched-work", writeFile: "worker-after-prefetch.txt",
    commitMessage: "worker commit after prefetch",
  }));
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error));
  assert.equal(out.commits.newCommitCount, 2, out.commits.log);
  assert.match(out.commits.log, /worker commit after prefetch/u);
  assert.match(out.commits.log, /fetched upstream commit/u);
  assert.match(out.commits.diffStat, /upstream\.txt/u);
  assert.match(out.commits.diffStat, /worker-after-prefetch\.txt/u);
});

test("workspace lock metadata is absent from mirrored repository refs", async (context) => {
  const { tempRoot, workspace, client } = await makeHarness(context);
  const mirror = path.join(tempRoot, "mirror.git");
  await execFileAsync("git", ["init", "--bare", mirror], { cwd: tempRoot });
  const response = await client.request("tools/call", taskArguments(workspace, {
    name: "mirror", mirrorPush: true, remotePath: mirror,
  }));
  const out = response.result.structuredContent;
  if (!out.ok) {
    assert.match(out.error, /process tree could not be confirmed terminated/iu);
    assert.ok(out.quarantinePath, JSON.stringify(out));
    context.after(() => rm(out.quarantinePath, { recursive: true, force: true }));
  }
  const { stdout: mirroredRefs } = await execFileAsync(
    "git", ["for-each-ref", "--format=%(refname)"], { cwd: mirror },
  );
  assert.match(mirroredRefs, /refs\/heads\/main/u);
  assert.doesNotMatch(mirroredRefs, /cli-agent-bridge|workspace-locks/iu,
    "coordination metadata must live outside the repository ref namespace");
  const { stdout: localInternalRefs } = await execFileAsync(
    "git", ["for-each-ref", "--format=%(refname)", "refs/cli-agent-bridge"], { cwd: workspace },
  );
  assert.equal(localInternalRefs, "");
});

test("list_backends can be cancelled while a version probe hangs", async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-agent-bridge-test-"));
  context.after(async () => { await rm(tempRoot, { recursive: true, force: true }); });
  const hangScript = path.join(tempRoot, "hang-version.mjs");
  await writeFile(hangScript, "setTimeout(() => {}, 60_000);\n");
  const configPath = path.join(tempRoot, "backends.json");
  await writeFile(configPath, JSON.stringify({
    backends: {
      hang: {
        label: "Hanging backend",
        command: process.execPath,
        buildArgs: [hangScript, "<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const client = new McpClient(configPath);
  await client.initialize();
  context.after(async () => { await client.close(); });
  const started = Date.now();
  const responsePromise = client.request("tools/call", { name: "list_backends", arguments: {} }, 4242);
  await new Promise((resolve) => setTimeout(resolve, 200));
  client.notify("notifications/cancelled", { requestId: 4242 });
  const response = await responsePromise;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12_000, "cancellation must terminate the probe well before the 15s timeout");
  assert.ok(Array.isArray(response.result.structuredContent.backends));
});

test("missing backend commands fail before workspace launch", {
  skip: process.platform === "win32",
}, async (context) => {
  const { workspace, configPath, client } = await makeHarness(context);
  await writeFile(configPath, JSON.stringify({
    backends: {
      missing: {
        label: "Missing backend",
        command: "cli-agent-bridge-command-that-does-not-exist",
        buildArgs: ["<task>"],
        resumeArgs: null,
        experimental: false,
      },
    },
  }));
  const response = await client.request("tools/call", {
    name: "delegate_task",
    arguments: { backend: "missing", task: "run", workspacePath: workspace },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, false);
  assert.match(out.error, /command was not found or is not executable/iu);
  assert.doesNotMatch(out.error, /exited with code null/iu);
});

test("PowerShell shim runner fails closed for a missing backend", {
  skip: process.platform !== "win32",
}, async () => {
  const runner = path.join(pluginRoot, "ps1-runner.ps1");
  let failure = null;
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "cli-agent-bridge-command-that-does-not-exist", "--version",
    ]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, "missing backend must return a non-zero exit code");
  assert.notEqual(failure.code, 0);
});

test("PowerShell shim runner preserves native backend exit codes", {
  skip: process.platform !== "win32",
}, async () => {
  const runner = path.join(pluginRoot, "ps1-runner.ps1");
  let failure = null;
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
      "cmd.exe", "/d", "/c", "exit", "37",
    ]);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, 37);
});

test("a worktree root ending in whitespace is canonicalized without trimming it", async (context) => {
  if (process.platform === "win32") return; // NTFS forbids trailing spaces in names
  const { tempRoot, client } = await makeHarness(context);
  const spaced = path.join(tempRoot, "workspace ");
  await mkdir(spaced);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: spaced });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: spaced });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: spaced });
  await writeFile(path.join(spaced, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: spaced });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: spaced });
  const response = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: spaced },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error ?? out));
  assert.ok(out.worktreeRoot.endsWith(" "),
    "the trailing space is part of the canonical root: " + JSON.stringify(out.worktreeRoot));
});

test("a separate Git common directory ending in whitespace is preserved", async (context) => {
  if (process.platform === "win32") return; // NTFS forbids trailing spaces in names
  const { tempRoot, client } = await makeHarness(context);
  const commonDirectory = path.join(tempRoot, "separate-git ");
  const worktree = path.join(tempRoot, "separate-worktree");
  await execFileAsync("git", [
    "init", "-b", "main", "--separate-git-dir", commonDirectory, worktree,
  ], { cwd: tempRoot });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: worktree });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], { cwd: worktree });
  await writeFile(path.join(worktree, "baseline.txt"), "baseline\n");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd: worktree });
  await execFileAsync("git", ["commit", "-m", "baseline"], { cwd: worktree });
  const response = await client.request("tools/call", {
    name: "workspace_status",
    arguments: { workspacePath: worktree },
  });
  const out = response.result.structuredContent;
  assert.equal(out.ok, true, JSON.stringify(out.error ?? out));
  assert.equal(await canonicalGitCommonDirectory(worktree), await realpath(commonDirectory));
});
