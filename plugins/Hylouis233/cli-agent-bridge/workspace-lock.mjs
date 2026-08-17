import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import os from "node:os";

import { safeGitInvocation, subscribeTrustedGitExecutable } from "./git-executable.mjs";

export const WORKSPACE_LOCK_REF_PREFIX = "refs/cli-agent-bridge/workspace-locks/";
const WORKSPACE_HISTORY_REF_SUFFIX = ".history";
const WORKSPACE_RECOVERY_REF_SUFFIX = ".recovery";
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_POLL_MS = 100;
const GIT_TIMEOUT_MS = 5_000;
const CAPTURE_LIMIT = 64_000;
const PIPE_DRAIN_MS = 100;
const RELEASE_RETRY_MS = 50;
const RELEASE_ATTEMPTS = 3;
export class WorkspaceLockCancelledError extends Error {}
export class WorkspaceLockDeadlineError extends Error {}

export function localHostIdentity() {
  let userIdentity;
  try {
    const user = os.userInfo();
    userIdentity = Number.isInteger(user.uid) && user.uid >= 0
      ? "uid:" + String(user.uid)
      : "user:" + user.username + ":" + user.homedir;
  } catch {
    userIdentity = "user:" + (process.env.USERNAME ?? process.env.USER ?? "unknown");
  }
  return `${process.platform}:${os.hostname().toLowerCase()}:${userIdentity}`;
}

export function workspaceLockRef(key) {
  return WORKSPACE_LOCK_REF_PREFIX + createHash("sha256").update(key).digest("hex");
}

// A completed delegation leaves a persistent run-window record under this ref
// so later snapshots in the same repository can prove their attribution window
// overlapped another worker, even after that worker's lease ref was deleted.
export function workspaceHistoryRef(key) {
  return workspaceLockRef(key) + WORKSPACE_HISTORY_REF_SUFFIX;
}

async function writeRunHistory(cwd, lockRef, owner) {
  try {
    const record = {
      version: 1,
      acquiredAt: Number.isFinite(owner.acquiredAt) ? owner.acquiredAt : null,
      endedAt: Date.now(),
      hostIdentity: owner.hostIdentity,
    };
    const oidResult = await runGit(cwd, ["hash-object", "-w", "--stdin"], {
      stdinText: JSON.stringify(record) + "\n",
    });
    const oid = oidResult.stdout.trim();
    if (oidResult.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(oid)) return;
    await runGit(cwd, ["update-ref", "--no-deref", lockRef + WORKSPACE_HISTORY_REF_SUFFIX, oid]);
  } catch {
    // Best effort: a missing history record only weakens concurrency
    // disclosure, never correctness of locking.
  }
}

async function writeRecoveryAuthorization(cwd, lockRef, ownerOid, ownerToken) {
  const recoveryRef = lockRef + WORKSPACE_RECOVERY_REF_SUFFIX;
  const record = {
    version: 1,
    lockRef,
    ownerOid,
    ownerToken,
    authorizedAt: Date.now(),
  };
  const recordOid = await writeOwnerBlob(cwd, record);
  const result = await runGit(cwd, ["update-ref", "--no-deref", recoveryRef, recordOid]);
  if (result.exitCode !== 0) {
    throw new Error("cannot persist workspace lock recovery authorization: " + (
      result.stderr.trim() || "git update-ref exited with code " + String(result.exitCode)
    ));
  }
  return { ref: recoveryRef, oid: recordOid };
}

async function readRecoveryAuthorization(cwd, lockRef, options = {}) {
  return await readCurrentOwner(cwd, lockRef + WORKSPACE_RECOVERY_REF_SUFFIX, options);
}

async function clearRecoveryAuthorization(cwd, authorization) {
  if (!authorization) return;
  try {
    await compareAndDelete(cwd, authorization.ref, authorization.oid);
  } catch {
    // A stale authorization is harmless because it names one exact owner OID
    // and token. A later holder can overwrite or remove it.
  }
}

async function maintainLockStore(cwd) {
  try {
    // Git's automatic maintenance uses its own repository locks and its normal
    // prune grace period, so it is safe alongside acquisitions in other bridge
    // processes while eventually collecting superseded owner/history blobs.
    await runGit(cwd, ["gc", "--auto", "--quiet"]);
  } catch {
    // Maintenance is best effort and must never change lock correctness.
  }
}

export function probeProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  if (process.platform === "linux") {
    try {
      const raw = readFileSync("/proc/" + String(pid) + "/stat", "utf8");
      const close = raw.lastIndexOf(")");
      const state = close < 0 ? "" : raw.slice(close + 1).trim().split(/\s+/u)[0];
      if (["Z", "X", "x"].includes(state)) return "dead";
    } catch (error) {
      if (error?.code === "ENOENT") return "dead";
      // Fall through: kill(0) may still positively prove alive/dead.
    }
  }
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM") return "alive";
    return "unknown";
  }
}

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > CAPTURE_LIMIT ? combined.slice(-CAPTURE_LIMIT) : combined;
}

function checkInterrupted(cancel, deadline) {
  if (cancel?.cancelled) throw new WorkspaceLockCancelledError("workspace lock acquisition cancelled");
  if (deadline !== null && Date.now() >= deadline) {
    throw new WorkspaceLockDeadlineError("workspace lock acquisition deadline exceeded");
  }
}

function resolveTrustedGitExecutable(cancel, deadline) {
  checkInterrupted(cancel, deadline);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let unsubscribeCancel = () => {};
    let unsubscribeResolution = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribeCancel();
      unsubscribeResolution();
      callback(value);
    };
    const cancelled = () => finish(
      reject, new WorkspaceLockCancelledError("workspace lock acquisition cancelled"),
    );
    if (typeof cancel?.subscribe === "function") unsubscribeCancel = cancel.subscribe(cancelled);
    else if (cancel?.promise) void cancel.promise.then(cancelled);
    if (deadline !== null) {
      timer = setTimeout(() => finish(
        reject, new WorkspaceLockDeadlineError("workspace lock acquisition deadline exceeded"),
      ), Math.max(0, deadline - Date.now()));
    }
    unsubscribeResolution = subscribeTrustedGitExecutable(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

async function runGit(cwd, args, {
  stdinText,
  cancel = null,
  deadline = null,
  returnOnTimeout = false,
} = {}) {
  checkInterrupted(cancel, deadline);
  const resolutionDeadline = deadline ?? Date.now() + GIT_TIMEOUT_MS;
  const executable = await resolveTrustedGitExecutable(cancel, resolutionDeadline);
  const git = await safeGitInvocation(args, process.env, executable);
  checkInterrupted(cancel, resolutionDeadline);
  const remaining = resolutionDeadline - Date.now();
  if (remaining <= 0) {
    throw new WorkspaceLockDeadlineError("workspace lock acquisition deadline exceeded");
  }
  const timeoutMs = Math.min(GIT_TIMEOUT_MS, remaining);
  if (process.env.NODE_ENV === "test") {
    const spawnedFile = process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_GIT_SPAWNED_FILE;
    if (typeof spawnedFile === "string" && spawnedFile) {
      await appendFile(spawnedFile, "spawned\n");
    }
  }
  const result = await new Promise((resolve) => {
    const child = spawn(git.command, git.args, {
      cwd,
      env: git.env,
      windowsHide: true,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let exitCode = null;
    let exitDrainTimer = null;
    let unsubscribe = () => {};
    const finish = (exitCode, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(exitDrainTimer);
      unsubscribe();
      resolve({ exitCode, stdout, stderr, timedOut, error });
    };
    const terminate = () => {
      if (settled) return;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    if (typeof cancel?.subscribe === "function") unsubscribe = cancel.subscribe(terminate);
    else if (cancel?.promise) void cancel.promise.then(terminate);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish(null, error));
    child.on("exit", (code) => {
      exitCode = code;
      // A hook or helper can leave inherited pipes open after Git exits. Give
      // buffered output a brief drain window, then stop waiting on descendants.
      exitDrainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(exitCode);
      }, PIPE_DRAIN_MS);
    });
    child.on("close", (code) => finish(code ?? exitCode));
    if (child.stdin) child.stdin.end(stdinText);
  });
  checkInterrupted(cancel, deadline);
  if (result.timedOut && !returnOnTimeout) {
    throw new Error("git " + args[0] + " timed out while managing the workspace lock");
  }
  if (result.error) throw new Error("cannot run git while managing the workspace lock: " + result.error.message);
  return result;
}

async function writeOwnerBlob(cwd, owner, options = {}) {
  const result = await runGit(cwd, ["hash-object", "-w", "--stdin"], {
    ...options,
    stdinText: JSON.stringify(owner) + "\n",
  });
  const oid = result.stdout.trim();
  if (result.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new Error("cannot write workspace lock owner blob: " + (result.stderr.trim() || "invalid object id"));
  }
  return oid;
}

async function readRefOid(cwd, ref, options = {}) {
  const resolved = await runGit(cwd, ["rev-parse", "--verify", "--quiet", ref], options);
  if (resolved.exitCode === 1 && !resolved.stdout.trim()) return null;
  const oid = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new Error("cannot read workspace lock ref: " + (resolved.stderr.trim() || "invalid object id"));
  }
  return oid;
}

async function readCurrentOwner(cwd, ref, options = {}) {
  const oid = await readRefOid(cwd, ref, options);
  if (oid === null) return null;
  const blob = await runGit(cwd, ["cat-file", "blob", oid], options);
  if (blob.exitCode !== 0) {
    throw new Error("cannot read workspace lock owner blob: " + blob.stderr.trim());
  }
  let owner = null;
  try {
    owner = JSON.parse(blob.stdout);
  } catch {
    // A malformed owner is deliberately treated as unclaimable.
  }
  return { oid, owner };
}

async function compareAndSwap(cwd, ref, newOid, expectedOid, options = {}) {
  const result = await runGit(cwd, ["update-ref", "--no-deref", ref, newOid, expectedOid], {
    ...options,
    returnOnTimeout: true,
  });
  if (result.exitCode === 0) return true;
  const observedOid = await readRefOid(cwd, ref, options);
  if (observedOid === newOid) return true;
  const expectedAbsent = /^0+$/u.test(expectedOid);
  if (expectedAbsent ? observedOid !== null : observedOid !== expectedOid) return false;
  throw new Error("cannot update workspace lock ref: " + (
    result.stderr.trim() || "git update-ref exited with code " + String(result.exitCode)
  ));
}

async function compareAndDelete(cwd, ref, expectedOid) {
  const result = await runGit(cwd, ["update-ref", "--no-deref", "-d", ref, expectedOid], {
    returnOnTimeout: true,
  });
  if (result.exitCode === 0) return true;
  const observedOid = await readRefOid(cwd, ref);
  if (observedOid === null) return true;
  if (observedOid !== expectedOid) return false;
  throw new Error("cannot delete workspace lock ref: " + (
    result.stderr.trim() || "git update-ref exited with code " + String(result.exitCode)
  ));
}

async function canReclaim(owner, {
  now,
  staleMs,
  hostIdentity,
  processProbe,
  processIdentityProbe = null,
  operatorRecoveryApproved = null,
}) {
  if (!owner || owner.version !== 1 || owner.hostIdentity !== hostIdentity) return false;
  if (!Number.isFinite(owner.heartbeatAt)) return false;
  // A quarantined lease means termination already failed and the operator was
  // told to inspect leftovers. It becomes reclaimable only through a durable,
  // token-bound recovery authorization. Owner death cannot prove that an
  // escaped descendant died too, and mere marker absence may be routine
  // temporary-directory cleanup; neither is approval.
  if (owner.workerState === "quarantined") {
    // This bit is written only after the shared marker was durably created.
    // Older/partial records cannot distinguish "operator removed" from
    // "marker creation failed" and therefore remain fail-closed.
    if (owner.quarantineMarkerPersisted !== true) return false;
    if (typeof owner.quarantineId === "string" && owner.quarantineId && operatorRecoveryApproved) {
      try {
        if (await operatorRecoveryApproved(owner)) return true;
      } catch { /* treat a failed check as not approved */ }
    }
    return false;
  }
  // Publication starts by persisting this state before any temporary marker
  // work. A bridge crash in that window cannot turn an uncertain escaped tree
  // back into a reclaimable idle lease.
  if (owner.workerState === "quarantine-pending") return false;
  if (now - owner.heartbeatAt < staleMs) return false;
  if (await originalOwnerStatus(owner, processProbe, processIdentityProbe) !== "dead") return false;
  if (owner.workerState === "idle" && owner.workerPid === null) return true;
  // Starting/running records always fail closed. The live bridge tracks
  // descendants that escape into new POSIX sessions, but that in-memory tree
  // cannot be reconstructed after an owner crash from workerPid alone.
  return false;
}

async function originalOwnerStatus(owner, processProbe, processIdentityProbe) {
  const status = await processProbe(owner.ownerPid);
  if (status !== "alive" || !owner.ownerIdentity || !processIdentityProbe) return status;
  try {
    const observed = await processIdentityProbe(owner.ownerPid);
    if (typeof observed === "string" && observed) {
      return observed === owner.ownerIdentity ? "alive" : "dead";
    }
  } catch { /* identity uncertainty fails closed */ }
  return "unknown";
}

function makeOwner({ hostIdentity, ownerPid, ownerIdentity, now }) {
  return {
    version: 1,
    token: randomUUID(),
    hostIdentity,
    ownerPid,
    ownerIdentity,
    workerState: "idle",
    workerPid: null,
    acquiredAt: now,
    heartbeatAt: now,
  };
}

function createLease({ cwd, ref, oid, owner, heartbeatMs }) {
  const ownerToken = owner.token;
  let currentOid = oid;
  let currentOwner = owner;
  let updateChain = Promise.resolve();
  let stopped = false;
  let released = false;
  let releasePromise = null;
  let retained = false;
  let lostError = null;
  let interruptedError = null;
  let resolveLost;
  const lost = new Promise((resolve) => { resolveLost = resolve; });
  let heartbeatPending = false;

  const rememberLoss = (error) => {
    if (lostError) return;
    lostError = error;
    resolveLost(error);
  };
  const isInterruption = (error) =>
    error instanceof WorkspaceLockCancelledError || error instanceof WorkspaceLockDeadlineError;

  // State transitions accept the delegation's cancellation/deadline so a hung
  // reference-transaction hook cannot pin a request past its advertised limit.
  // An interruption leaves the ref's actual value unknown (git may have
  // committed the CAS before being killed), so the lease stops updating and
  // release() resyncs by owner token before deleting.
  const queueUpdate = (change, interrupt = {}) => {
    if (interruptedError) return Promise.reject(interruptedError);
    updateChain = updateChain.then(async () => {
      if (stopped || lostError || interruptedError) return;
      const nextOwner = { ...currentOwner, ...change, heartbeatAt: Date.now() };
      const nextOid = await writeOwnerBlob(cwd, nextOwner, interrupt);
      if (!await compareAndSwap(cwd, ref, nextOid, currentOid, interrupt)) {
        throw new Error("workspace lock ownership changed during heartbeat");
      }
      currentOwner = nextOwner;
      currentOid = nextOid;
    }).catch((error) => {
      if (isInterruption(error)) {
        interruptedError ??= error;
        return;
      }
      rememberLoss(error);
    });
    return updateChain.then(() => {
      if (interruptedError) throw interruptedError;
      if (lostError) throw lostError;
    });
  };

  const queueOwnershipProbe = () => {
    updateChain = updateChain.then(async () => {
      if (stopped || lostError || interruptedError) return;
      const observedOid = await readRefOid(cwd, ref);
      if (observedOid !== currentOid) {
        throw new Error("workspace lock ownership changed during heartbeat probe");
      }
    }).catch((error) => {
      if (isInterruption(error)) {
        interruptedError ??= error;
        return;
      }
      rememberLoss(error);
    });
    return updateChain;
  };

  const timer = setInterval(() => {
    if (stopped || heartbeatPending || lostError || interruptedError) return;
    heartbeatPending = true;
    // Process liveness and start-identity checks protect stale acquisition, so
    // the periodic heartbeat only needs to prove this exact ref is still ours.
    // A read-only probe avoids creating an unreachable content-addressed blob
    // every few seconds during long delegations.
    void queueOwnershipProbe().catch(() => {}).finally(() => { heartbeatPending = false; });
  }, heartbeatMs);
  timer.unref?.();

  return {
    get ref() { return ref; },
    lost,
    async assertOwned() {
      await updateChain;
      if (lostError) throw lostError;
      if (interruptedError) throw interruptedError;
    },
    async markWorkerStarting(interrupt = {}) {
      await queueUpdate({ workerState: "starting", workerPid: null }, interrupt);
    },
    async markWorkerRunning(pid, interrupt = {}) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("worker pid is unavailable");
      await queueUpdate({ workerState: "running", workerPid: pid }, interrupt);
    },
    async markWorkerIdle(interrupt = {}) {
      await queueUpdate({ workerState: "idle", workerPid: null }, interrupt);
    },
    async markWorkerQuarantinePending(quarantineId) {
      if (typeof quarantineId !== "string" || !quarantineId) {
        throw new Error("quarantine id is unavailable");
      }
      await queueUpdate({
        workerState: "quarantine-pending", quarantineMarkerPersisted: false, quarantineId,
      });
    },
    async markWorkerQuarantined(quarantineId) {
      if (typeof quarantineId !== "string" || !quarantineId) {
        throw new Error("quarantine id is unavailable");
      }
      await queueUpdate({
        workerState: "quarantined", quarantineMarkerPersisted: true, quarantineId,
      });
    },
    retain() {
      retained = true;
    },
    async release() {
      if (released) return;
      if (releasePromise) return await releasePromise;
      stopped = true;
      clearInterval(timer);
      releasePromise = (async () => {
        await updateChain.catch(() => {});
        if (retained) {
          if (lostError) throw lostError;
          released = true;
          return;
        }
        // An interrupted state update may have committed its CAS after the git
        // process was killed, leaving currentOid stale. Resync by owner token
        // so cleanup still deletes this process's own lease record.
        if (interruptedError) {
          try {
            const observed = await readCurrentOwner(cwd, ref);
            if (observed && observed.owner?.token === ownerToken) currentOid = observed.oid;
          } catch { /* best effort; the delete below still uses the last known OID */ }
        }
        // Persist authorization before deleting. If deletion exhausts its
        // retries, every bridge process sharing this lock store can safely CAS
        // away only this exact completed owner record.
        const recoveryAuthorization = await writeRecoveryAuthorization(
          cwd, ref, currentOid, ownerToken,
        );
        let deleted = false;
        let deleteError = null;
        for (let attempt = 0; attempt < RELEASE_ATTEMPTS; attempt += 1) {
          try {
            deleted = await compareAndDelete(cwd, ref, currentOid);
            deleteError = null;
            break;
          } catch (error) {
            deleteError = error;
            if (attempt + 1 < RELEASE_ATTEMPTS) {
              await new Promise((resolve) => setTimeout(resolve, RELEASE_RETRY_MS));
            }
          }
        }
        if (deleteError) throw deleteError;
        released = true;
        if (deleted) await writeRunHistory(cwd, ref, currentOwner);
        await clearRecoveryAuthorization(cwd, recoveryAuthorization);
        await maintainLockStore(cwd);
        if (lostError) throw lostError;
        if (!deleted) throw new Error("workspace lock ownership changed before release");
      })();
      try {
        await releasePromise;
      } finally {
        releasePromise = null;
      }
    },
  };
}

export async function tryAcquireGitWorkspaceLock({
  cwd,
  key,
  cancel = null,
  deadline = null,
  staleMs = DEFAULT_STALE_MS,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  hostIdentity = localHostIdentity(),
  ownerPid = process.pid,
  ownerIdentity = null,
  now = Date.now(),
  processProbe = probeProcess,
  processIdentityProbe = null,
  operatorRecoveryApproved = null,
} = {}) {
  checkInterrupted(cancel, deadline);
  const ref = workspaceLockRef(key);
  const current = await readCurrentOwner(cwd, ref, { cancel, deadline });
  const recovery = await readRecoveryAuthorization(cwd, ref, { cancel, deadline });
  const sharedRecoveryAuthorized = Boolean(
    current && recovery?.owner?.version === 1 &&
    recovery.owner.lockRef === ref &&
    recovery.owner.ownerOid === current.oid &&
    recovery.owner.ownerToken === current.owner?.token,
  );
  if (current && !sharedRecoveryAuthorized && !await canReclaim(current.owner, {
    now, staleMs, hostIdentity, processProbe, processIdentityProbe, operatorRecoveryApproved,
  })) {
    return { acquired: false, reason: "held" };
  }
  const owner = makeOwner({ hostIdentity, ownerPid, ownerIdentity, now });
  const newOid = await writeOwnerBlob(cwd, owner, { cancel, deadline });
  let acquired = false;
  if (!current) {
    const zeroOid = "0".repeat(newOid.length);
    checkInterrupted(cancel, deadline);
    acquired = await compareAndSwap(cwd, ref, newOid, zeroOid, { cancel, deadline });
  } else {
    checkInterrupted(cancel, deadline);
    acquired = await compareAndSwap(cwd, ref, newOid, current.oid, { cancel, deadline });
  }
  if (!acquired) return { acquired: false, reason: "contended" };
  if (recovery) {
    await clearRecoveryAuthorization(cwd, {
      ref: ref + WORKSPACE_RECOVERY_REF_SUFFIX,
      oid: recovery.oid,
    });
  }
  const lease = createLease({ cwd, ref, oid: newOid, owner, heartbeatMs });
  try {
    checkInterrupted(cancel, deadline);
  } catch (error) {
    try {
      await lease.release();
    } catch (releaseError) {
      // release() persisted authorization before its compensating delete, so
      // another bridge process can recover the exact completed owner record.
      if (error.cause === undefined) error.cause = releaseError;
    }
    throw error;
  }
  return { acquired: true, lease };
}

async function waitForRetry(cancel, deadline, pollMs) {
  checkInterrupted(cancel, deadline);
  const remaining = deadline === null ? pollMs : Math.min(pollMs, Math.max(1, deadline - Date.now()));
  await new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, remaining);
    if (typeof cancel?.subscribe === "function") unsubscribe = cancel.subscribe(done);
    else if (cancel?.promise) void cancel.promise.then(done);
  });
  checkInterrupted(cancel, deadline);
}

export async function acquireGitWorkspaceLock(options = {}) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  while (true) {
    const result = await tryAcquireGitWorkspaceLock(options);
    if (result.acquired) return result.lease;
    await waitForRetry(options.cancel ?? null, options.deadline ?? null, pollMs);
  }
}
