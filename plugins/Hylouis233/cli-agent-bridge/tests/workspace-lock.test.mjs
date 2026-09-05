import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  acquireGitWorkspaceLock,
  localHostIdentity,
  tryAcquireGitWorkspaceLock,
  workspaceHistoryRef,
  workspaceLockRef,
  workspaceRecoveryRef,
  WorkspaceLockCancelledError,
  WorkspaceLockDeadlineError,
} from "../workspace-lock.mjs";

const execFileAsync = promisify(execFile);

function cancellationToken() {
  const listeners = new Set();
  let resolvePromise;
  return {
    cancelled: false,
    promise: new Promise((resolve) => { resolvePromise = resolve; }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      resolvePromise();
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch { /* keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for " + file);
}

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

test("a recovery-authorization failure cannot prevent exact owner deletion", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const ownerOid = await git(repo, ["rev-parse", first.lease.ref]);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const recoveryRefPath = path.join(
    gitDirectory, ...workspaceRecoveryRef(first.lease.ref, ownerOid).split("/"),
  );
  await mkdir(path.dirname(recoveryRefPath), { recursive: true });
  const blocker = recoveryRefPath + ".lock";
  await writeFile(blocker, "intentional recovery authorization failure\n");
  context.after(() => rm(blocker, { force: true }));

  await first.lease.release();
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", first.lease.ref], { cwd: repo }),
    /Command failed/u,
  );
  await rm(blocker, { force: true });
  const second = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(second.acquired, true, "the live server must not remain blocked by its deleted owner");
  await second.lease.release();
});

test("local recovery records remain isolated across stale owner retries", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const ownerOid = await git(repo, ["rev-parse", first.lease.ref]);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const ownerRefPath = path.join(gitDirectory, ...first.lease.ref.split("/"));
  const recoveryRefPath = path.join(
    gitDirectory, ...workspaceRecoveryRef(first.lease.ref, ownerOid).split("/"),
  );
  await mkdir(path.dirname(ownerRefPath), { recursive: true });
  await mkdir(path.dirname(recoveryRefPath), { recursive: true });
  const ownerBlocker = ownerRefPath + ".lock";
  const recoveryBlocker = recoveryRefPath + ".lock";
  await writeFile(ownerBlocker, "block exact delete\n");
  await writeFile(recoveryBlocker, "block recovery publication\n");
  context.after(() => rm(ownerBlocker, { force: true }));
  context.after(() => rm(recoveryBlocker, { force: true }));

  await assert.rejects(
    first.lease.release(),
    /cannot persist recovery authorization or delete the workspace lock ref/iu,
  );
  await rm(ownerBlocker, { force: true });
  await rm(recoveryBlocker, { force: true });

  const otherModule = await import("../workspace-lock.mjs?local-abandonment=" + Date.now());
  const outside = await otherModule.tryAcquireGitWorkspaceLock({
    cwd: repo, key, heartbeatMs: 60_000,
  });
  assert.deepEqual(outside, { acquired: false, reason: "held" },
    "a new module/process must remain fail-closed without durable authorization");

  const recovered = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(recovered.acquired, true,
    "the same FIFO domain may retry the exact abandoned OID and token");
  const recoveredOid = await git(repo, ["rev-parse", recovered.lease.ref]);
  const recoveredRecoveryRefPath = path.join(
    gitDirectory, ...workspaceRecoveryRef(recovered.lease.ref, recoveredOid).split("/"),
  );
  await mkdir(path.dirname(recoveredRecoveryRefPath), { recursive: true });
  const recoveredRecoveryBlocker = recoveredRecoveryRefPath + ".lock";
  context.after(() => rm(recoveredRecoveryBlocker, { force: true }));
  await writeFile(ownerBlocker, "block replacement exact delete\n");
  await writeFile(recoveredRecoveryBlocker, "block replacement recovery publication\n");
  await assert.rejects(
    recovered.lease.release(),
    /cannot persist recovery authorization or delete the workspace lock ref/iu,
  );

  await rm(ownerBlocker, { force: true });
  await rm(recoveredRecoveryBlocker, { force: true });
  // Make the store briefly unavailable so the stale first lease cannot read
  // back the replacement OID after either Git operation fails. Its local
  // record must not overwrite the replacement owner's separately keyed entry.
  const unavailableRepo = repo + "-unavailable";
  await rename(repo, unavailableRepo);
  await assert.rejects(
    first.lease.release(),
    /cannot persist recovery authorization or delete the workspace lock ref/iu,
  );
  await rename(unavailableRepo, repo);

  const stillOutside = await otherModule.tryAcquireGitWorkspaceLock({
    cwd: repo, key, heartbeatMs: 60_000,
  });
  assert.deepEqual(stillOutside, { acquired: false, reason: "held" });
  const third = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(third.acquired, true,
    "the current exact local record must survive a stale owner's later failure");
  await third.lease.release();
});

test("owner-sharded recovery survives a stale prior holder retry", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const firstOid = await git(repo, ["rev-parse", first.lease.ref]);
  const firstRecoveryRef = workspaceRecoveryRef(first.lease.ref, firstOid);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const ownerRefPath = path.join(gitDirectory, ...first.lease.ref.split("/"));
  await mkdir(path.dirname(ownerRefPath), { recursive: true });
  const blocker = ownerRefPath + ".lock";
  await writeFile(blocker, "block first release\n");
  await assert.rejects(first.lease.release(), /cannot delete workspace lock ref/iu);
  assert.match(await git(repo, ["rev-parse", firstRecoveryRef]), /^[0-9a-f]{40,64}$/u);

  await rm(blocker, { force: true });
  const second = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(second.acquired, true);
  const secondOid = await git(repo, ["rev-parse", second.lease.ref]);
  const secondRecoveryRef = workspaceRecoveryRef(second.lease.ref, secondOid);
  await writeFile(blocker, "block second release\n");
  await assert.rejects(second.lease.release(), /cannot delete workspace lock ref/iu);
  const secondAuthorizationOid = await git(repo, ["rev-parse", secondRecoveryRef]);

  await rm(blocker, { force: true });
  await assert.rejects(first.lease.release(), /ownership changed before release/iu);
  assert.equal(await git(repo, ["rev-parse", secondRecoveryRef]), secondAuthorizationOid,
    "a stale holder must not overwrite or clear the current owner's authorization");
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", firstRecoveryRef], { cwd: repo }),
    /Command failed/u,
  );

  const third = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(third.acquired, true, "the current owner's shard must authorize exact takeover");
  await third.lease.release();
});

test("a legacy recovery authorization is consumed only when it authorizes the current owner", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const token = "legacy-recovery-owner";
  const now = Date.now();
  const ownerOid = await installOwner(repo, ref, {
    version: 1,
    token,
    hostIdentity: localHostIdentity(),
    ownerPid: process.pid,
    ownerIdentity: null,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now,
    heartbeatAt: now,
  });
  const legacyRef = ref + ".recovery";
  await installOwner(repo, legacyRef, {
    version: 1, lockRef: ref, ownerOid, ownerToken: token, authorizedAt: now,
  });

  const acquired = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(acquired.acquired, true);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", legacyRef], { cwd: repo }),
    /Command failed/u,
  );
  await acquired.lease.release();
});

test("an owner shard takes precedence without clearing a legacy authorization", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const token = "shard-precedence-owner";
  const now = Date.now();
  const ownerOid = await installOwner(repo, ref, {
    version: 1,
    token,
    hostIdentity: localHostIdentity(),
    ownerPid: process.pid,
    ownerIdentity: null,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now,
    heartbeatAt: now,
  });
  const authorization = { version: 1, lockRef: ref, ownerOid, ownerToken: token };
  const shardRef = workspaceRecoveryRef(ref, ownerOid);
  await installOwner(repo, shardRef, authorization);
  const legacyRef = ref + ".recovery";
  const legacyOid = await installOwner(repo, legacyRef, {
    ...authorization, legacyFixture: true,
  });

  const acquired = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(acquired.acquired, true);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", shardRef], { cwd: repo }),
    /Command failed/u,
  );
  assert.equal(await git(repo, ["rev-parse", legacyRef]), legacyOid,
    "the successful CAS must clear only the authorization it actually used");
  await git(repo, ["update-ref", "-d", legacyRef, legacyOid]);
  await acquired.lease.release();
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
  assert.equal(looseCount, 2,
    "read-only heartbeat probes must add nothing beyond the owner and one activity blob");
  await result.lease.release();
});

test("each acquisition publishes a unique clock-independent activity marker", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const historyRef = workspaceHistoryRef(key);
  const first = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(first.acquired, true);
  const firstOid = (await git(repo, ["rev-parse", historyRef])).trim();
  const firstRecord = JSON.parse(await git(repo, ["cat-file", "blob", firstOid]));
  await first.lease.release();

  const second = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(second.acquired, true);
  const secondOid = (await git(repo, ["rev-parse", historyRef])).trim();
  const secondRecord = JSON.parse(await git(repo, ["cat-file", "blob", secondOid]));
  assert.notEqual(secondOid, firstOid, "activity identity must not depend on Date.now granularity");
  assert.notEqual(secondRecord.ownerToken, firstRecord.ownerToken);
  assert.match(secondRecord.ownerOid, /^[0-9a-f]{40,64}$/u);
  await second.lease.release();
});

test("post-CAS cancellation reconciles the committed owner before returning", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const gitDirectory = path.resolve(repo, await git(repo, ["rev-parse", "--git-dir"]));
  const refPath = path.join(gitDirectory, ...ref.split("/"));
  await mkdir(path.dirname(refPath), { recursive: true });
  const blocker = refPath + ".lock";
  const startedFile = path.join(path.dirname(repo), "cas-result-started");
  const releaseFile = path.join(path.dirname(repo), "cas-result-release");
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    started: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE,
    release: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE,
  };
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = startedFile;
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = releaseFile;
  context.after(() => {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.started === undefined) {
      delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
    } else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = saved.started;
    if (saved.release === undefined) {
      delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
    } else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = saved.release;
  });
  const cancel = cancellationToken();
  const acquisition = tryAcquireGitWorkspaceLock({
    cwd: repo, key, cancel, heartbeatMs: 60_000,
  });
  await waitForFile(startedFile);
  assert.match(await git(repo, ["rev-parse", ref]), /^[0-9a-f]{40,64}$/u,
    "the real acquisition CAS must commit before cancellation");
  await writeFile(blocker, "intentional compensating-delete failure\n");
  cancel.cancel();
  await writeFile(releaseFile, "release\n");
  await assert.rejects(acquisition, WorkspaceLockCancelledError);
  assert.match(await git(repo, ["rev-parse", ref]), /^[0-9a-f]{40,64}$/u,
    "a failed exact delete must leave a recoverable owner ref");
  await rm(blocker, { force: true });
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
  const recovered = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(recovered.acquired, true);
  await recovered.lease.release();
});

test("post-CAS deadline reconciliation deletes the exact committed owner", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const startedFile = path.join(path.dirname(repo), "cas-deadline-started");
  const releaseFile = path.join(path.dirname(repo), "cas-deadline-release");
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    started: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE,
    release: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE,
  };
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = startedFile;
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = releaseFile;
  context.after(() => {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.started === undefined) {
      delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
    } else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = saved.started;
    if (saved.release === undefined) {
      delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
    } else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = saved.release;
  });
  const passive = { cancelled: false, promise: new Promise(() => {}), subscribe: () => () => {} };
  const deadline = Date.now() + 3_000;
  const acquisition = tryAcquireGitWorkspaceLock({
    cwd: repo, key, cancel: passive, deadline, heartbeatMs: 60_000,
  });
  await waitForFile(startedFile);
  assert.match(await git(repo, ["rev-parse", ref]), /^[0-9a-f]{40,64}$/u);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 20)));
  await writeFile(releaseFile, "release\n");
  await assert.rejects(acquisition, WorkspaceLockDeadlineError);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: repo }), /Command failed/u,
  );
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
  const recovered = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(recovered.acquired, true);
  await recovered.lease.release();
});

test("interrupted state CAS cleanup covers both exact commit outcomes", async (context) => {
  const repo = await makeRepo(context);
  const key = "git-worktree:" + repo;
  const ref = workspaceLockRef(key);
  const result = await tryAcquireGitWorkspaceLock({ cwd: repo, key, heartbeatMs: 60_000 });
  assert.equal(result.acquired, true);
  const previousOid = await git(repo, ["rev-parse", ref]);
  const startedFile = path.join(path.dirname(repo), "state-cas-result-started");
  const releaseFile = path.join(path.dirname(repo), "state-cas-result-release");
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    started: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE,
    release: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE,
    readFailures: process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_RELEASE_READBACK_FAILURES,
  };
  process.env.NODE_ENV = "test";
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = startedFile;
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = releaseFile;
  context.after(() => {
    if (saved.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved.nodeEnv;
    if (saved.started === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
    else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE = saved.started;
    if (saved.release === undefined) delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
    else process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE = saved.release;
    if (saved.readFailures === undefined) {
      delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_RELEASE_READBACK_FAILURES;
    } else {
      process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_RELEASE_READBACK_FAILURES = saved.readFailures;
    }
  });
  const cancel = cancellationToken();
  const update = result.lease.markWorkerStarting({ cancel });
  await waitForFile(startedFile);
  const candidateOid = await git(repo, ["rev-parse", ref]);
  assert.notEqual(candidateOid, previousOid, "the real state CAS must commit its candidate OID");
  cancel.cancel();
  await writeFile(releaseFile, "release\n");
  await assert.rejects(update, WorkspaceLockCancelledError);
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_STARTED_FILE;
  delete process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_CAS_RESULT_RELEASE_FILE;
  process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_RELEASE_READBACK_FAILURES = "1";

  await result.lease.release();
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", ref], { cwd: repo }), /Command failed/u,
  );
  const otherModule = await import("../workspace-lock.mjs?state-cas-recovery=" + Date.now());
  const recovered = await otherModule.tryAcquireGitWorkspaceLock({
    cwd: repo, key, heartbeatMs: 60_000,
  });
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
