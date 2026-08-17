import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquireGitWorkspaceLock,
  localHostIdentity,
  tryAcquireGitWorkspaceLock,
  workspaceLockRef,
  WorkspaceLockCancelledError,
  WorkspaceLockDeadlineError,
} from "../workspace-lock.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, args, input = undefined) {
  const result = await execFileAsync("git", args, {
    cwd,
    input,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function makeRepo(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cli-agent-lock-test-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  context.after(() => rm(root, { recursive: true, force: true }));
  return repo;
}

async function installOwner(repo, ref, owner) {
  const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: repo,
    input: JSON.stringify(owner) + "\n",
    encoding: "utf8",
  }).trim();
  await git(repo, ["update-ref", ref, oid]);
  return oid;
}

test("a stale same-host lock is replaced only when its owner is confirmed dead", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "dead-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    heartbeatMs: 60_000,
    processProbe: () => "dead",
  });
  assert.equal(result.acquired, true);
  const newOid = await git(repo, ["rev-parse", ref]);
  assert.notEqual(newOid, oldOid, "stale-owner takeover must CAS the ref to a new owner blob");
  await result.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: repo }), /Command failed/u);
});

test("a stale lock with a live owner is never stolen", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "live-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: 23456,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "alive",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("a stale owner PID reused by another process does not pin an idle lease", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  await installOwner(repo, ref, {
    version: 1,
    token: "reused-owner-pid",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    ownerIdentity: "original-start",
    workerState: "idle",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    heartbeatMs: 60_000,
    processProbe: () => "alive",
    processIdentityProbe: () => "reused-start",
  });
  assert.equal(result.acquired, true,
    "a live but differently-started PID is not the original stale owner");
  await result.lease.release();
});

test("uncertain worker liveness fails closed during stale-owner recovery", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "uncertain-worker",
    hostIdentity: localHostIdentity(),
    ownerPid: 34567,
    workerState: "starting",
    workerPid: null,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "dead",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("a stale running lock fails closed even when its original process group is gone", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  const oldOid = await installOwner(repo, ref, {
    version: 1,
    token: "escaped-descendant-uncertain",
    hostIdentity: localHostIdentity(),
    ownerPid: 45678,
    workerState: "running",
    workerPid: 56789,
    acquiredAt: now - 60_000,
    heartbeatAt: now - 60_000,
  });

  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    now,
    staleMs: 1_000,
    processProbe: () => "dead",
    processGroupProbe: async () => "dead",
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
  assert.equal(await git(repo, ["rev-parse", ref]), oldOid);
});

test("an update-ref infrastructure failure is not misclassified as contention", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const refPath = path.join(gitDirectory, ...ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  await writeFile(blocker, "intentional test lock\n");
  context.after(() => rm(blocker, { force: true }));

  await assert.rejects(
    tryAcquireGitWorkspaceLock({ cwd: repo, key }),
    /cannot update workspace lock ref/iu,
  );
});

test("a failed release can be recovered by the next holder in every completed state", async (context) => {
  for (const state of ["idle", "starting", "running"]) {
    const repo = await makeRepo(context);
    const key = "git-worktree:" + repo;
    const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
    assert.equal(first.acquired, true);
    if (state !== "idle") await first.lease.markWorkerStarting();
    if (state === "running") await first.lease.markWorkerRunning(process.pid);
    const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
    const refPath = path.join(gitDirectory, ...first.lease.ref.split("/"));
    await mkdir(path.dirname(refPath), { recursive: true });
    const blocker = refPath + ".lock";
    await writeFile(blocker, "intentional release failure\n");
    await assert.rejects(first.lease.release(), /cannot delete workspace lock ref/iu);
    await rm(blocker, { force: true });

    const second = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
    assert.equal(second.acquired, true, "the next local holder should replace the " + state + " ref");
    await second.lease.release();
  }
});

test("a failed release in one linked worktree is recoverable from another", async (context) => {
  const repo = await makeRepo(context);
  await git(repo, ["config", "user.email", "fixture@example.com"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["commit", "--allow-empty", "-m", "baseline"]);
  const linked = path.join(path.dirname(repo), "linked");
  await git(repo, ["worktree", "add", "-b", "linked", linked]);
  const key = "git-common-dir:shared-fixture";
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const commonDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"]));
  const refPath = path.join(commonDirectory, ...first.lease.ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  await writeFile(blocker, "intentional linked-worktree release failure\n");
  await assert.rejects(first.lease.release(), /cannot delete workspace lock ref/iu);
  await rm(blocker, { force: true });

  // A cache-busted module instance has no shared JavaScript memory with the
  // first holder and therefore proves recovery authorization lives in Git.
  const otherModule = await import("../workspace-lock.mjs?shared-recovery=" + Date.now());
  const second = await otherModule.tryAcquireGitWorkspaceLock({
    cwd: linked, key, heartbeatMs: 60_000,
  });
  assert.equal(second.acquired, true,
    "the repository-scoped recovery record is visible across module/process boundaries");
  await second.lease.release();
});

test("periodic ownership probes do not create heartbeat blobs", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const result = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 10 });
  assert.equal(result.acquired, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const countOutput = await git(repo, ["count-objects", "-v"]);
  const looseCount = Number(/^count:\s+(\d+)$/mu.exec(countOutput)?.[1]);
  assert.equal(looseCount, 1,
    "read-only heartbeat probes must leave only the current owner blob");
  await result.lease.release();
});

test("post-CAS cancellation remains recoverable when its compensating delete fails", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const refPath = path.join(gitDirectory, ...ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  let cancellationChecks = 0;
  const cancel = {
    get cancelled() {
      cancellationChecks += 1;
      if (cancellationChecks === 7) writeFileSync(blocker, "intentional compensating-delete failure\n");
      return cancellationChecks >= 7;
    },
  };

  await assert.rejects(
    tryAcquireGitWorkspaceLock({ cwd: repo, key, cancel, heartbeatMs: 60_000 }),
    /cancelled/iu,
  );
  assert.equal(cancellationChecks, 7, "cancellation must be observed only after the CAS commits");
  await rm(blocker, { force: true });
  const recovered = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(recovered.acquired, true);
  await recovered.lease.release();
});

test("long lock waits unsubscribe cancellation listeners after every retry", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const holder = await tryAcquireGitWorkspaceLock({
    cwd: repo,
    key,
    ownerPid: 111_111,
    heartbeatMs: 60_000,
  });
  assert.equal(holder.acquired, true);
  const listeners = new Set();
  let resolveCancelled;
  let maximumListeners = 0;
  const cancel = {
    cancelled: false,
    promise: new Promise((resolve) => { resolveCancelled = resolve; }),
    subscribe(listener) {
      listeners.add(listener);
      maximumListeners = Math.max(maximumListeners, listeners.size);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      this.cancelled = true;
      resolveCancelled();
      for (const listener of [...listeners]) listener();
    },
  };

  const waiting = acquireGitWorkspaceLock({
    cwd: repo,
    key,
    ownerPid: 222_222,
    cancel,
    pollMs: 5,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  cancel.cancel();
  await assert.rejects(waiting, /cancelled/iu);
  assert.equal(listeners.size, 0);
  assert.ok(maximumListeners <= 1, "listeners accumulated across retries: " + String(maximumListeners));
  await holder.lease.release();
});

test("worker state updates honour the delegation cancellation and deadline", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const acquire = () => tryAcquireGitWorkspaceLock({
    cwd: repo, key, processProbe: () => "alive", heartbeatMs: 60_000,
  });

  // One interruption ends a lease's update lifecycle, so each case uses its own.
  const cancelledLease = await acquire();
  assert.equal(cancelledLease.acquired, true);
  const cancelled = { cancelled: true, promise: Promise.resolve(), subscribe: () => () => {} };
  await assert.rejects(cancelledLease.lease.markWorkerStarting({ cancel: cancelled }), WorkspaceLockCancelledError);
  await cancelledLease.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", workspaceLockRef(key)], { cwd: repo }), /Command failed/u);

  const expiredLease = await acquire();
  assert.equal(expiredLease.acquired, true);
  const expired = { cancelled: false, promise: new Promise(() => {}), subscribe: () => () => {} };
  await assert.rejects(
    expiredLease.lease.markWorkerStarting({ cancel: expired, deadline: Date.now() - 1 }),
    WorkspaceLockDeadlineError,
  );
  await expiredLease.lease.release();
  await assert.rejects(execFileAsync("git", ["rev-parse", "--verify", workspaceLockRef(key)], { cwd: repo }), /Command failed/u);
});

test("workspace-lock Git operations disable repository transaction hooks", {
  // This fixture depends on executable-hook semantics.
  skip: process.platform !== "linux",
}, async (context) => {
  const repo = await makeRepo(context);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const hook = path.join(gitDirectory, "hooks", "reference-transaction");
  const ready = path.join(path.dirname(repo), "hook-ready");
  const release = path.join(path.dirname(repo), "hook-release");
  await writeFile(hook, [
    "#!/usr/bin/env node",
    "const { existsSync, writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(ready)}, 'ready\\n');`,
    `while (!existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);`,
    "",
  ].join("\n"));
  await chmod(hook, 0o755);
  context.after(() => writeFile(release, "release\n").catch(() => {}));
  const acquisition = await tryAcquireGitWorkspaceLock({
    cwd: repo, key: "git-worktree:" + repo, heartbeatMs: 60_000,
  });
  assert.equal(acquisition.acquired, true);
  await assert.rejects(access(ready), /ENOENT/u,
    "coordination refs must never execute repository-controlled transaction hooks");
  await acquisition.lease.release();
});

test("workspace-lock Git resolution detaches cancelled and expired waiters", async (context) => {
  const repo = await makeRepo(context);
  const startedFile = path.join(path.dirname(repo), "git-resolution-started.txt");
  const moduleUrl = new URL("../workspace-lock.mjs", import.meta.url).href;
  const source = [
    `import {tryAcquireGitWorkspaceLock,WorkspaceLockCancelledError,WorkspaceLockDeadlineError} from ${JSON.stringify(moduleUrl)}`,
    "const listeners=new Set()",
    "let resolveCancelled",
    "const cancel={cancelled:false,promise:new Promise(r=>{resolveCancelled=r}),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},cancel(){this.cancelled=true;resolveCancelled();for(const fn of [...listeners])fn()}}",
    "setTimeout(()=>cancel.cancel(),100)",
    `const repo=${JSON.stringify(repo)}`,
    "const outcomes=[]",
    "try{await tryAcquireGitWorkspaceLock({cwd:repo,key:'cancelled-resolution',cancel,deadline:Date.now()+5000})}catch(error){outcomes.push(error instanceof WorkspaceLockCancelledError?'cancelled':error.name)}",
    "const passive={cancelled:false,promise:new Promise(()=>{}),subscribe(){return()=>{}}}",
    "try{await tryAcquireGitWorkspaceLock({cwd:repo,key:'expired-resolution',cancel:passive,deadline:Date.now()+200})}catch(error){outcomes.push(error instanceof WorkspaceLockDeadlineError?'deadline':error.name)}",
    "process.stdout.write(outcomes.join(','))",
    "process.exit(outcomes.join(',')==='cancelled,deadline'?0:3)",
  ].join(";");
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", source,
  ], {
    timeout: 5_000,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_DELAY_MS: "60000",
      CLI_AGENT_BRIDGE_TEST_GIT_RESOLUTION_STARTED_FILE: startedFile,
    },
  });
  assert.equal(stdout, "cancelled,deadline");
  assert.equal((await readFile(startedFile, "utf8")).trim().split(/\r?\n/u).length, 1,
    "both abandoned callers must share one underlying Git lookup");

  const gitModuleUrl = new URL("../git-executable.mjs", import.meta.url).href;
  const spawnMarker = path.join(path.dirname(repo), "workspace-git-spawned.txt");
  const launchGuardSource = [
    `import {tryAcquireGitWorkspaceLock,WorkspaceLockDeadlineError} from ${JSON.stringify(moduleUrl)}`,
    `import {trustedGitExecutable} from ${JSON.stringify(gitModuleUrl)}`,
    "await trustedGitExecutable()",
    "process.env.NODE_ENV='test'",
    "process.env.CLI_AGENT_BRIDGE_TEST_GIT_INVOCATION_DELAY_MS='250'",
    `process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_GIT_SPAWNED_FILE=${JSON.stringify(spawnMarker)}`,
    `const repo=${JSON.stringify(repo)}`,
    "const passive={cancelled:false,promise:new Promise(()=>{}),subscribe(){return()=>{}}}",
    "let outcome='resolved'",
    "try{await tryAcquireGitWorkspaceLock({cwd:repo,key:'post-builder-deadline',cancel:passive,deadline:Date.now()+100})}catch(error){outcome=error instanceof WorkspaceLockDeadlineError?'deadline':error.name}",
    "process.stdout.write(outcome)",
    "process.exit(outcome==='deadline'?0:3)",
  ].join(";");
  const launchGuard = await execFileAsync(process.execPath, [
    "--input-type=module", "-e", launchGuardSource,
  ], { timeout: 5_000, env: { ...process.env } });
  assert.equal(launchGuard.stdout, "deadline",
    "workspace-lock must recheck the absolute deadline immediately before Git launch");
  await assert.rejects(access(spawnMarker), /ENOENT/u,
    "workspace-lock must not spawn Git after invocation setup exhausts the deadline");
});

test("quarantined leases require an explicit token-bound recovery approval", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const now = Date.now();
  await installOwner(repo, ref, {
    version: 1,
    token: "quarantined-owner",
    hostIdentity: localHostIdentity(),
    ownerPid: process.pid,
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    quarantineId: "quarantine-incident-1",
    workerPid: 4242,
    acquiredAt: now,
    heartbeatAt: now,
  });

  const stillHeld = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 60_000, processProbe: () => "alive",
    operatorRecoveryApproved: () => false,
  });
  assert.deepEqual(stillHeld, { acquired: false, reason: "held" });

  const reclaimed = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 60_000, processProbe: () => "alive",
    operatorRecoveryApproved: (owner) => owner.quarantineId === "quarantine-incident-1",
  });
  assert.equal(reclaimed.acquired, true, "a matching durable approval authorizes takeover");
  await reclaimed.lease.release();
});

test("a quarantined lease without proof of a durable marker fails closed", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "marker-never-persisted",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "quarantined",
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorRecoveryApproved: () => true,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" },
    "approval is invalid unless marker persistence and an incident id were recorded");
});

test("a quarantine publication interrupted before its marker remains fail closed", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "quarantine-publication-pending",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "quarantine-pending",
    quarantineMarkerPersisted: false,
    quarantineId: "pending-incident",
    workerPid: null,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorRecoveryApproved: () => true,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
});

test("a different OS user cannot clear another user's quarantined lease", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "other-user-quarantine",
    hostIdentity: localHostIdentity() + ":other-user",
    ownerPid: 12345,
    ownerIdentity: "other-user-process",
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    quarantineId: "other-user-incident",
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorRecoveryApproved: () => true,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" });
});

test("a crashed quarantined owner remains held without explicit recovery approval", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const now = Date.now();
  await installOwner(repo, workspaceLockRef(key), {
    version: 1,
    token: "crashed-quarantine",
    hostIdentity: localHostIdentity(),
    ownerPid: 12345,
    workerState: "quarantined",
    quarantineMarkerPersisted: true,
    quarantineId: "crashed-incident",
    workerPid: 5353,
    acquiredAt: now - 120_000,
    heartbeatAt: now - 120_000,
  });
  const result = await tryAcquireGitWorkspaceLock({
    cwd: repo, key, now, staleMs: 30_000, processProbe: () => "dead",
    operatorRecoveryApproved: () => false,
  });
  assert.deepEqual(result, { acquired: false, reason: "held" },
    "owner death cannot prove that escaped descendants terminated");
});
