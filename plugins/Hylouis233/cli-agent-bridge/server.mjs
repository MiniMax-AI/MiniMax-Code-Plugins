#!/usr/bin/env node
// cli-agent-bridge: a dependency-free stdio MCP server that lets MiniMax Code
// delegate coding tasks to locally installed coding CLIs (Claude Code, Codex,
// Kimi Code, ZCode, DSH). The server makes no network calls of its own; each
// backend CLI runs headless with the local user authentication.
//
// License: MIT. See NOTICE for upstream credits.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  resolvePathCommand, safeGitInvocation, subscribePathCommand, subscribeTrustedGitExecutable,
} from "./git-executable.mjs";
import { initializeProcessTree, isProcessTreeAlive, refreshProcessTree, signalProcessTree, waitForChildExit, waitForProcessTreeExit } from "./process-tree.mjs";
import {
  acquireGitWorkspaceLock,
  WORKSPACE_LOCK_REF_PREFIX,
  WorkspaceLockCancelledError,
  WorkspaceLockDeadlineError,
} from "./workspace-lock.mjs";

const SERVER_NAME = "cli-agent-bridge";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 1_200_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 3_600_000;
const VERSION_CHECK_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 30_000;
const TEST_KILL_GRACE_MS = process.env.NODE_ENV === "test"
  ? Number(process.env.CLI_AGENT_BRIDGE_TEST_KILL_GRACE_MS)
  : NaN;
const KILL_GRACE_MS = Number.isInteger(TEST_KILL_GRACE_MS) && TEST_KILL_GRACE_MS >= 50
  ? Math.min(10_000, TEST_KILL_GRACE_MS)
  : 10_000;
const MAX_CAPTURE_CHARS = 5_000_000;
const MAX_TRACE_EVENT_CHARS = 256_000;
const TRACE_PARSE_YIELD_CHARS = 64 * 1024;
const TRACE_CLEANUP_TIMEOUT_MS = 1_000;
const backgroundFinalizers = new Set();
const RAW_TAIL_CHARS = 60_000;
const FETCH_PROVENANCE_TIPS = Symbol("fetchProvenanceTips");
const QUARANTINE_RECORD_FILE = "record.json";
const WORKSPACE_QUARANTINE_DIRECTORY = "cli-agent-bridge-quarantines";
const TEST_RUNTIME_PLATFORM = process.env.NODE_ENV === "test"
  ? process.env.CLI_AGENT_BRIDGE_TEST_PLATFORM
  : "";
const RUNTIME_PLATFORM = ["darwin", "freebsd", "linux", "win32"].includes(TEST_RUNTIME_PLATFORM)
  ? TEST_RUNTIME_PLATFORM
  : process.platform;

function supportsReliableProcessContainment(platform = RUNTIME_PLATFORM) {
  return platform === "linux" || platform === "win32";
}

function trustedWindowsPowerShell() {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  if (!path.win32.isAbsolute(windowsRoot)) {
    throw new Error("cannot locate the trusted Windows PowerShell executable");
  }
  return path.win32.join(
    windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
}

// Built-in defaults. A missing or invalid bundled sibling backends.json falls
// back to this table. An explicitly configured CLI_AGENT_BRIDGE_BACKENDS path
// is authoritative and fails closed on every load or validation error.
const FALLBACK_BACKENDS = {
  claude: {
    label: "Claude Code",
    command: "claude",
    buildArgs: ["-p", "<task>", "--output-format", "text", "--permission-mode", "acceptEdits"],
    resumeArgs: ["-p", "<task>", "--output-format", "text", "--permission-mode", "acceptEdits", "--resume", "<session>"],
    experimental: false,
  },
  codex: {
    label: "OpenAI Codex CLI",
    command: "codex",
    buildArgs: ["exec", "--", "<task>"],
    resumeArgs: ["exec", "resume", "<session>", "--", "<task>"],
    experimental: false,
  },
  kimi: {
    label: "Kimi Code",
    command: "kimi",
    buildArgs: ["-p", "<task>"],
    resumeArgs: ["-S", "<session>", "-p", "<task>"],
    experimental: false,
  },
  zcode: {
    label: "ZCode",
    command: "zcode",
    buildArgs: ["-p", "<task>"],
    resumeArgs: null,
    experimental: true,
    notes: "Desktop ZCode builds have no verified headless mode; set command to your CLI if your distribution provides one.",
  },
  dsh: {
    label: "DeepSeek Harness (dsh)",
    command: "dsh",
    buildArgs: ["--profile", "headless", "<task>"],
    resumeArgs: null,
    experimental: true,
    notes: "Uses the documented headless profile; requires a headless profile under DSH_HOME/profiles.",
  },
};

const TOOLS = [
  {
    name: "list_backends",
    title: "List Delegation Backends",
    description:
      "List the configured coding-CLI backends (claude, codex, kimi, zcode, dsh) and report which ones are installed and available on this machine. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "workspace_status",
    title: "Workspace Git Status",
    description:
      "Return git status, diff stat, and changed files for a workspace before delegating work. Does not change the worktree, but acquires and releases hidden Git-ref lock metadata while snapshotting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        workspacePath: {
          type: "string",
          minLength: 1,
          description: "Absolute or resolvable path to the target git repository.",
        },
      },
      required: ["workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "delegate_task",
    title: "Delegate Task To A Coding CLI",
    description:
      "Run a coding task with a locally installed coding CLI (backend: claude, codex, kimi, zcode, or dsh) inside the given workspace, headless. Returns the CLI exit code, readable output tail, stderr tail, and the git snapshot (staged, unstaged, untracked, and committed deltas) produced by the run. Refuses to run when the working tree is dirty unless allowDirty=true. Paths that resolve to the same canonical Git worktree are serialized across bridge processes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        backend: {
          type: "string",
          minLength: 1,
          description: "Backend name as listed by list_backends (claude, codex, kimi, zcode, dsh).",
        },
        task: {
          type: "string",
          minLength: 1,
          description: "Self-contained task to hand to the backend CLI. Include file paths and acceptance criteria; never include credentials.",
        },
        workspacePath: {
          type: "string",
          minLength: 1,
          description: "Absolute or resolvable path to the target git repository.",
        },
        allowDirty: {
          type: "boolean",
          default: false,
          description: "When false (default), refuse to run if git status --short is non-empty.",
        },
        resumeSessionId: {
          type: "string",
          minLength: 1,
          description: "Optional existing session id to resume in the backend CLI (where the backend template supports it).",
        },
        timeoutMs: {
          type: "integer",
          minimum: MIN_TIMEOUT_MS,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
          description: "Overall deadline in milliseconds, including workspace lock acquisition, preflight Git checks, the worker, and post-run snapshots. Defaults to 1200000 (20 minutes). Confirming safe process-tree termination may extend beyond the deadline by the kill grace period.",
        },
      },
      required: ["backend", "task", "workspacePath"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

function validateBackendConfiguration(parsed, file) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !parsed.backends || typeof parsed.backends !== "object" || Array.isArray(parsed.backends)) {
    throw new Error("backend configuration must contain a backends object");
  }
  const entries = Object.entries(parsed.backends);
  if (entries.length === 0) throw new Error("backend configuration backends object is empty");
  const configDirectory = path.dirname(file);
  return Object.fromEntries(entries.map(([name, spec]) => {
    if (!name.trim() || !spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("backend configuration entry " + JSON.stringify(name) + " is invalid");
    }
    if (typeof spec.command !== "string" || !spec.command.trim()) {
      throw new Error("backend configuration entry " + JSON.stringify(name) + " has no command");
    }
    if (!Array.isArray(spec.buildArgs) || !spec.buildArgs.every((arg) => typeof arg === "string")) {
      throw new Error("backend configuration entry " + JSON.stringify(name) + " has invalid buildArgs");
    }
    if (spec.resumeArgs !== undefined && spec.resumeArgs !== null &&
        (!Array.isArray(spec.resumeArgs) || !spec.resumeArgs.every((arg) => typeof arg === "string"))) {
      throw new Error("backend configuration entry " + JSON.stringify(name) + " has invalid resumeArgs");
    }
    return [name, /[\\/]/u.test(spec.command)
      ? { ...spec, command: path.resolve(configDirectory, spec.command) }
      : spec];
  }));
}

function trackBackgroundFinalizer(promise) {
  const finalizer = Promise.resolve(promise).catch(() => {});
  backgroundFinalizers.add(finalizer);
  void finalizer.finally(() => { backgroundFinalizers.delete(finalizer); });
  return finalizer;
}

async function readBackendConfiguration(file) {
  return validateBackendConfiguration(JSON.parse(await readFile(file, "utf8")), file);
}

export async function loadBackends() {
  const hasOverride = Object.prototype.hasOwnProperty.call(
    process.env, "CLI_AGENT_BRIDGE_BACKENDS",
  );
  if (hasOverride) {
    const override = process.env.CLI_AGENT_BRIDGE_BACKENDS;
    if (typeof override !== "string" || !override.trim()) {
      throw new Error("explicit backend configuration path is empty");
    }
    const file = path.resolve(override);
    try {
      return await readBackendConfiguration(file);
    } catch (error) {
      throw new Error("cannot load explicit backend configuration " + file + ": " + error.message);
    }
  }
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), "backends.json");
  try {
    return await readBackendConfiguration(bundled);
  } catch {
    return FALLBACK_BACKENDS;
  }
}

function substituteArgs(template, task, session) {
  return template.map((arg) => {
    let out = arg;
    if (typeof session === "string" && session.trim()) out = out.replaceAll("<session>", session.trim());
    return out.replaceAll("<task>", task);
  });
}

// Bounded capture: chunks are kept in a ring buffer with a running length, so a
// runaway CLI never triggers repeated multi-megabyte string copies.
function capture(binary = false) {
  let chunks = [];
  let length = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (binary ? !Buffer.isBuffer(chunk) : typeof chunk !== "string") return;
      if (chunk.length === 0) return;
      chunks.push(chunk);
      length += chunk.length;
      while (length > MAX_CAPTURE_CHARS && chunks.length > 0) {
        const dropped = chunks.shift();
        length -= dropped.length;
        truncated = true;
      }
    },
    value() { return binary ? Buffer.concat(chunks, length) : chunks.join(""); },
    truncated() { return truncated; },
  };
}

export async function runCommand(command, args, options = {}) {
  const spawnOnce = (argv, shellArgs) => new Promise((resolve) => {
    const binaryStdout = options.binaryStdout === true;
    if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
      resolve({
        stdout: binaryStdout ? Buffer.alloc(0) : "", stderr: "", exitCode: null, timedOut: false, killed: false,
        orphanedProcesses: false, treeTerminated: true, terminationError: "",
        errorMessage: "command cancelled before spawn", spawnError: null,
        stdoutTruncated: false, stderrTruncated: false,
      });
      return;
    }
    const manageProcessTree = options.manageProcessTree === true;
    const useWindowsJobRunner = manageProcessTree && process.platform === "win32" && !shellArgs &&
      options.processTreeTestMode !== true;
    const useProcessTreeRunner = manageProcessTree && process.platform !== "win32" && !shellArgs;
    const trackProcessTree = manageProcessTree && !useWindowsJobRunner;
    const processTreeRunnerPayload = (useWindowsJobRunner || useProcessTreeRunner) ? JSON.stringify({
      command,
      args: argv,
      ...(options.stdinText === undefined ? {} : { stdinText: options.stdinText }),
    }) : "";
    const linuxRunMarker = manageProcessTree && process.platform === "linux"
      ? randomUUID()
      : null;
    const baseEnvironment = options.env ?? process.env;
    const childEnvironment = linuxRunMarker
      ? { ...baseEnvironment, CLI_AGENT_BRIDGE_RUN_ID: linuxRunMarker }
      : baseEnvironment;
    const child = useWindowsJobRunner
      ? spawn(trustedWindowsPowerShell(), [
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
          options.windowsJobRunnerPath ??
            path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-job-runner.ps1"),
          "-NodeExecutable", process.execPath,
          "-NodeRunner", path.join(
            path.dirname(fileURLToPath(import.meta.url)), "process-tree-runner.mjs",
          ),
        ], {
          cwd: options.cwd,
          env: childEnvironment,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : useProcessTreeRunner
      ? spawn(process.execPath, [
          path.join(path.dirname(fileURLToPath(import.meta.url)), "process-tree-runner.mjs"),
        ], {
          cwd: options.cwd,
          env: childEnvironment,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        })
      : shellArgs
      ? spawn(shellArgs[0], shellArgs.slice(1), {
          cwd: options.cwd,
          env: childEnvironment,
          detached: manageProcessTree && process.platform !== "win32",
          windowsHide: true,
          stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        })
      : spawn(command, argv, {
          cwd: options.cwd,
          env: childEnvironment,
          detached: manageProcessTree && process.platform !== "win32",
          windowsHide: true,
          stdio: [options.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
    let childSpawned = false;
    child.once("spawn", () => { childSpawned = true; });
    // A containment/bootstrap process can fail before consuming a large
    // payload. Its exit status/stderr carry the failure; absorb the pipe-side
    // EPIPE so it cannot become an unhandled error that crashes the bridge.
    child.stdin?.on("error", () => {});
    const stdoutBuf = capture(binaryStdout);
    const stderrBuf = capture();
    let settled = false;
    let settlingPromise = null;
    let resolveStreamsClosed;
    const streamsClosed = new Promise((resolve) => { resolveStreamsClosed = resolve; });
    let spawnError = null;
    let timedOut = false;
    let killed = false;
    let orphanedProcesses = false;
    let treeTerminated = true;
    let terminationError = "";
    let exitCode = null;
    let terminationCleanupPromise = null;
    let terminationPromise = null;
    let terminationReason = null;
    let timer = null;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    const inspectionWaitMs = options.processTreeInspectionWaitMs ??
      Math.max(250, Math.min(killGraceMs, 2_000));
    const streamDrainMs = options.streamDrainMs ??
      Math.max(250, Math.min(killGraceMs, 2_000));
    const waitBounded = async (promise, waitMs) => {
      let waitTimer;
      const completed = await Promise.race([
        Promise.resolve(promise).then(() => true),
        new Promise((resolveWait) => { waitTimer = setTimeout(() => resolveWait(false), waitMs); }),
      ]);
      clearTimeout(waitTimer);
      return completed;
    };
    const treeState = {
      knownPids: new Set(Number.isInteger(child.pid) ? [child.pid] : []),
      knownStarts: new Map(),
      runMarker: linuxRunMarker,
      markerObservationGraceMs: options.markerObservationGraceMs,
    };
    let treeRefreshPromise = null;
    let treeRefreshTimer = null;
    let treeRefreshStopped = false;
    const refreshTree = () => {
      if (!trackProcessTree || treeRefreshStopped) return Promise.resolve();
      if (treeRefreshPromise) return treeRefreshPromise;
      const refresh = options.refreshProcessTree ?? refreshProcessTree;
      treeRefreshPromise = Promise.resolve().then(() => refresh(child, treeState))
        .then((snapshot) => {
          if (process.platform !== "win32" && snapshot === null) {
            treeState.processInspectionUncertain = true;
            treeTerminated = false;
            terminationError ||= "process-tree refresh returned an incomplete snapshot";
          }
        })
        .catch((error) => {
          treeState.processInspectionUncertain = true;
          treeTerminated = false;
          terminationError ||= "process-tree inspection failed: " + error.message;
        })
        .finally(() => { treeRefreshPromise = null; });
      return treeRefreshPromise;
    };
    const stopTreeRefresh = async () => {
      treeRefreshStopped = true;
      if (treeRefreshTimer) {
        clearInterval(treeRefreshTimer);
        treeRefreshTimer = null;
      }
      if (!await waitBounded(treeState.initialRefresh, inspectionWaitMs)) {
        treeState.processInspectionUncertain = true;
        treeTerminated = false;
        terminationError ||= "process-tree initialization did not finish before cleanup";
      }
      const inFlightRefresh = treeRefreshPromise;
      if (inFlightRefresh && !await waitBounded(inFlightRefresh, inspectionWaitMs)) {
        treeState.processInspectionUncertain = true;
        treeTerminated = false;
        terminationError ||= "process-tree refresh did not finish before cleanup";
      }
    };
    const settle = () => {
      if (settled) return Promise.resolve();
      if (settlingPromise) return settlingPromise;
      settlingPromise = (async () => {
        // `exit` identifies backend/supervisor termination and starts cleanup.
        // `close` is only the stdout/stderr drain barrier; an escaped process
        // retaining those handles must not postpone tree inspection until the
        // overall command timeout.
        if (!await waitBounded(streamsClosed, streamDrainMs)) {
          treeTerminated = false;
          terminationError ||= "backend output streams did not close after cleanup";
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        if (terminationCleanupPromise) await terminationCleanupPromise;
        if (settled) return;
        settled = true;
        treeRefreshStopped = true;
        clearTimeout(timer);
        if (treeRefreshTimer) clearInterval(treeRefreshTimer);
        resolve({
          stdout: stdoutBuf.value(),
          stderr: stderrBuf.value(),
          exitCode,
          timedOut,
          killed,
          orphanedProcesses,
          treeTerminated,
          terminationError,
          errorMessage: "",
          spawnError,
          stdoutTruncated: stdoutBuf.truncated(),
          stderrTruncated: stderrBuf.truncated(),
        });
      })();
      return settlingPromise;
    };

    const terminate = (reason) => {
      if (settled) return Promise.resolve();
      if (terminationPromise) return terminationPromise;
      terminationReason = reason;
      if (terminationReason === "timeout") timedOut = true;
      if (terminationReason === "orphaned") orphanedProcesses = true;
      terminationCleanupPromise = Promise.resolve().then(async () => {
        if (trackProcessTree) await stopTreeRefresh();
        const signalTree = options.signalProcessTree ?? signalProcessTree;
        const waitForTreeExit = options.waitForProcessTreeExit ?? waitForProcessTreeExit;
        if (trackProcessTree) await signalTree(child, "SIGTERM", treeState);
        else try { child.kill("SIGTERM"); } catch { /* already gone */ }
        const exited = trackProcessTree
          ? await waitForTreeExit(child, killGraceMs, treeState)
          : await waitForChildExit(child, killGraceMs);
        if (!exited) {
          killed = true;
          if (trackProcessTree) await signalTree(child, "SIGKILL", treeState);
          else try { child.kill("SIGKILL"); } catch { /* already gone */ }
          treeTerminated = trackProcessTree
            ? await waitForTreeExit(child, killGraceMs, treeState, { ignoreZombieOnly: true })
            : await waitForChildExit(child, killGraceMs);
          if (!treeTerminated) {
            terminationError ||= "process tree still appears alive after forceful termination";
          }
        }
        if (treeState.processInspectionUncertain === true) treeTerminated = false;
      }).catch((error) => {
        treeTerminated = false;
        terminationError ||= error.message;
      });
      terminationPromise = terminationCleanupPromise.then(() => settle());
      return terminationPromise;
    };

    if (trackProcessTree) {
      // Capture the root's start identity immediately so termination can later
      // detect a reused PID. POSIX keeps polling to track descendants that
      // escape the process group.
      // Linux follows only tracked /proc task children, so a short interval
      // catches session escapes without scanning the host process table.
      const initializeTree = options.initializeProcessTree ?? initializeProcessTree;
      treeState.initialRefresh = Promise.resolve().then(() => initializeTree(child, treeState)).catch((error) => {
        treeState.processInspectionUncertain = true;
        treeTerminated = false;
        terminationError ||= "process-tree initialization failed: " + error.message;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      });
      if (process.platform !== "win32" || options.refreshProcessTree) {
        // Initialization captures the immutable root identity and mutates the
        // same tracking state as a periodic refresh. Do not let the timer race
        // that startup barrier or revive polling after startup failed/cleanup
        // already stopped the tree tracker.
        void treeState.initialRefresh.then(() => {
          if (treeRefreshStopped || terminationPromise || !treeTerminated ||
              treeState.processInspectionUncertain === true ||
              child.exitCode !== null || child.signalCode !== null) return;
          const refreshIntervalMs = process.platform === "linux" &&
            treeState.linuxTaskChildrenUnavailable !== true ? 25 : 250;
          treeRefreshTimer = setInterval(() => { void refreshTree(); }, refreshIntervalMs);
          treeRefreshTimer.unref?.();
        });
      }
    }
    // Publish the controller only after the startup identity barrier exists.
    // A synchronous cancellation callback can then terminate immediately
    // without racing signal delivery ahead of initialization.
    if (typeof options.onChild === "function" && Number.isInteger(child.pid)) {
      options.onChild({ child, terminate });
    }
    if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
      void terminate("cancelled");
    }
    if (child.stdin) {
      if (useWindowsJobRunner) {
        // The PowerShell runner establishes and joins a kill-on-close Job
        // before reading stdin, so sending the payload cannot race containment.
        if (!terminationPromise) child.stdin.end(processTreeRunnerPayload);
      } else if (useProcessTreeRunner) {
        void treeState.initialRefresh.then(() => {
          if (!treeTerminated || terminationPromise || treeRefreshStopped ||
              child.exitCode !== null || child.signalCode !== null ||
              (typeof options.shouldCancel === "function" && options.shouldCancel())) return;
          child.stdin.end(processTreeRunnerPayload);
        });
      } else {
        child.stdin.end(options.stdinText);
      }
    }

    timer = setTimeout(() => { void terminate("timeout"); }, timeoutMs);

    if (!binaryStdout) child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutBuf.push(chunk); });
    child.stderr.on("data", (chunk) => { stderrBuf.push(chunk); });

    child.on("error", (error) => {
      if (settled) return;
      if (childSpawned) {
        treeTerminated = false;
        terminationError ||= "backend process error after spawn: " + error.message;
        void terminate("process-error");
        return;
      }
      spawnError = error;
      settled = true;
      treeRefreshStopped = true;
      clearTimeout(timer);
      if (treeRefreshTimer) clearInterval(treeRefreshTimer);
      resolve({
        stdout: stdoutBuf.value(),
        stderr: stderrBuf.value(),
        exitCode: null,
        timedOut,
        killed,
        orphanedProcesses,
        treeTerminated,
        terminationError,
        errorMessage: error.message,
        spawnError,
        stdoutTruncated: stdoutBuf.truncated(),
        stderrTruncated: stderrBuf.truncated(),
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      exitCode = code;
      if (terminationPromise) return;
      void (async () => {
        try {
          if (trackProcessTree) await stopTreeRefresh();
          if (terminationPromise) {
            await terminationPromise;
            return;
          }
          const inspectTree = options.inspectProcessTree ?? isProcessTreeAlive;
          if (trackProcessTree && treeState.processInspectionUncertain === true) {
            await terminate("orphaned");
            return;
          }
          if (trackProcessTree && await inspectTree(child, treeState)) {
            await terminate("orphaned");
            return;
          }
          if (terminationPromise) {
            await terminationPromise;
            return;
          }
          await settle();
        } catch (error) {
          if (terminationPromise) {
            await terminationPromise;
            return;
          }
          // An inspection failure (for example WMI unavailable on Windows) must
          // settle through the fail-closed path, not surface as an unhandled
          // rejection that could take down the whole server.
          treeTerminated = false;
          terminationError = "process-tree inspection failed: " + error.message;
          await settle();
        }
      })();
    });
    child.on("close", () => { resolveStreamsClosed(); });
  });

  const direct = await spawnOnce(args, null);
  if (process.platform !== "win32" || !direct.spawnError) return direct;
  // A managed Windows backend must never fall back to an uncontained process.
  // The Job runner already resolves native executables and PowerShell/.cmd shims.
  if (options.manageProcessTree === true) return direct;
  if (typeof options.shouldCancel === "function" && options.shouldCancel()) return direct;

  // Windows shim fallback: .ps1/.cmd npm shims cannot be launched by CreateProcess,
  // so retry through the bundled PowerShell runner, which forwards every argument
  // verbatim (no cmd.exe re-interpretation).
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "ps1-runner.ps1");
  return await spawnOnce(null, [
    trustedWindowsPowerShell(),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    runner,
    command,
    ...args,
  ]);
}

function tail(text, count) {
  return text.length > count ? text.slice(-count) : text;
}

function interruptibleFilesystemOperation(operation, { cancel = null, deadline = null } = {}) {
  if (cancel?.cancelled) return Promise.reject(new OperationCancelledError("operation cancelled by client"));
  if (deadline !== null && Date.now() >= deadline) {
    return Promise.reject(new DeadlineExceededError("delegation deadline exceeded"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let unsubscribe = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      callback(value);
    };
    const cancelled = () => finish(reject, new OperationCancelledError("operation cancelled by client"));
    if (typeof cancel?.subscribe === "function") unsubscribe = cancel.subscribe(cancelled);
    else if (cancel?.promise) void cancel.promise.then(cancelled);
    if (deadline !== null) {
      timer = setTimeout(() => finish(
        reject, new DeadlineExceededError("delegation deadline exceeded"),
      ), Math.max(0, deadline - Date.now()));
    }
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function waitForResolution(subscribe, options = {}) {
  const { cancel = null, deadline = null } = options;
  if (cancel?.cancelled) return Promise.reject(new OperationCancelledError("operation cancelled by client"));
  if (deadline !== null && Date.now() >= deadline) {
    return Promise.reject(new DeadlineExceededError("delegation deadline exceeded"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let unsubscribeCancel = () => {};
    let unsubscribeResolution = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribeCancel();
      unsubscribeResolution();
      callback(value);
    };
    const cancelled = () => finish(
      reject, new OperationCancelledError("operation cancelled by client"),
    );
    if (typeof cancel?.subscribe === "function") unsubscribeCancel = cancel.subscribe(cancelled);
    else if (cancel?.promise) void cancel.promise.then(cancelled);
    if (deadline !== null) {
      timer = setTimeout(() => finish(
        reject, new DeadlineExceededError("delegation deadline exceeded"),
      ), Math.max(0, deadline - Date.now()));
    }
    unsubscribeResolution = subscribe(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function resolveBackendCommand(command, options = {}) {
  return waitForResolution(
    (resolve, reject) => subscribePathCommand(command, resolve, reject), options,
  );
}

function resolveTrustedGitExecutable(options = {}) {
  return waitForResolution(subscribeTrustedGitExecutable, options);
}

async function validateWorkspace(workspacePath, options = {}) {
  if (typeof workspacePath !== "string" || !workspacePath.trim()) {
    throw new Error("workspacePath must be a non-empty string");
  }
  const resolved = path.resolve(workspacePath);
  let stats;
  try {
    if (process.env.NODE_ENV === "test") {
      const delayMs = Number(process.env.CLI_AGENT_BRIDGE_TEST_WORKSPACE_VALIDATION_DELAY_MS ?? 0);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        await interruptibleFilesystemOperation(
          new Promise((resolve) => setTimeout(resolve, delayMs)), options,
        );
      }
    }
    stats = await interruptibleFilesystemOperation(stat(resolved), options);
  } catch (error) {
    if (error instanceof OperationCancelledError || error instanceof DeadlineExceededError) throw error;
    throw new Error("workspacePath does not exist: " + resolved);
  }
  if (!stats.isDirectory()) throw new Error("workspacePath must be a directory: " + resolved);
  try {
    // Keep the execution directory bound to the directory validated here. A
    // symlink supplied by the caller may be retargeted while the request waits
    // for the repository lease, so it must not be resolved again at launch.
    return await interruptibleFilesystemOperation(realpath(resolved), options);
  } catch (error) {
    if (error instanceof OperationCancelledError || error instanceof DeadlineExceededError) throw error;
    throw new Error("cannot canonicalize workspacePath: " + error.message);
  }
}

async function requireGitRepo(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--is-inside-work-tree"], {
    cwd: workspacePath, timeoutMs: 15_000, ...options,
  });
  if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
    throw new Error("workspacePath is not a git repository: " + workspacePath);
  }
}

async function gitWorktreeRoot(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--show-toplevel"], {
    cwd: workspacePath, ...options,
  });
  const failure = snapshotFailure("git rev-parse --show-toplevel", result);
  // Strip only Git's trailing line terminator: a legitimate directory name can
  // end in whitespace, which .trim() would silently delete.
  const output = result.stdout.replace(/\r?\n$/u, "");
  if (failure || !output) {
    throw new Error("cannot identify Git worktree root: " + (failure || "empty output"));
  }
  try {
    return await interruptibleFilesystemOperation(realpath(output), options);
  } catch (error) {
    throw new Error("cannot canonicalize Git worktree root: " + error.message);
  }
}

async function gitCommonDirectory(workspacePath, options = {}) {
  const result = await runGitCommand(["rev-parse", "--git-common-dir"], {
    cwd: workspacePath, ...options,
  });
  const failure = snapshotFailure("git rev-parse --git-common-dir", result);
  const output = result.stdout.replace(/\r?\n$/u, "");
  if (failure || !output) {
    throw new Error("cannot identify Git common directory: " + (failure || "empty output"));
  }
  try {
    return await interruptibleFilesystemOperation(
      realpath(path.resolve(workspacePath, output)), options,
    );
  } catch (error) {
    throw new Error("cannot canonicalize Git common directory: " + error.message);
  }
}

function repositoryLockKey(gitCommonDir, repositoryId = null) {
  if (process.platform === "linux" && repositoryId) {
    return "git-common-dir-id:" + repositoryId;
  }
  const normalized = path.normalize(gitCommonDir);
  // realpath() has already canonicalized ordinary aliases and path casing.
  // Preserve the result: NTFS directories can opt into case sensitivity and
  // may legally contain distinct repositories whose names differ only by case.
  return "git-common-dir:" + normalized;
}

async function openRepositoryAccess(gitCommonDir, options = {}) {
  if (process.platform !== "linux") {
    return {
      commonDir: gitCommonDir,
      key: repositoryLockKey(gitCommonDir),
      close: async () => {},
    };
  }
  const opening = open(gitCommonDir, "r");
  let handle;
  try {
    handle = await interruptibleFilesystemOperation(opening, options);
  } catch (error) {
    // Cancellation/deadline cannot cancel fs.open itself. Close a handle that
    // arrives after the interrupt so the rename-stable directory pin cannot leak.
    void opening.then((lateHandle) => lateHandle.close()).catch(() => {});
    throw error;
  }
  try {
    const identity = await interruptibleFilesystemOperation(handle.stat({ bigint: true }), options);
    if (!identity.isDirectory()) throw new Error("Git common directory is not a directory");
    const commonDir = "/proc/" + String(process.pid) + "/fd/" + String(handle.fd);
    const observed = await interruptibleFilesystemOperation(stat(commonDir, { bigint: true }), options);
    if (observed.dev !== identity.dev || observed.ino !== identity.ino) {
      throw new Error("cannot establish a rename-stable Git common-directory handle");
    }
    let closed = false;
    return {
      commonDir,
      key: null,
      async close() {
        if (closed) return;
        closed = true;
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

const WORKSPACE_LOCK_STORE_NAME = "cli-agent-bridge-lock-store.git";
const REPOSITORY_ID_FILE = "cli-agent-bridge-repository-id";
const REPOSITORY_ID_REF = "refs/cli-agent-bridge/repository-id";
const REPOSITORY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function validateRepositoryId(value, source) {
  const normalized = String(value ?? "").trim();
  if (!REPOSITORY_ID_PATTERN.test(normalized)) {
    throw new Error("workspace lock store repository identity is malformed in " + source);
  }
  return normalized;
}

async function readLegacyRepositoryId(idPath, options = {}) {
  const metadata = await interruptibleFilesystemOperation(stat(idPath), options);
  if (!metadata.isFile() || metadata.size > 128) {
    throw new Error("workspace lock store repository identity is invalid");
  }
  return validateRepositoryId(
    await interruptibleFilesystemOperation(readFile(idPath, "utf8"), options),
    "legacy identity file",
  );
}

async function repositoryIdMode(storeRoot, options = {}) {
  const result = await runGitCommand(["config", "--get", "core.sharedRepository"], {
    cwd: storeRoot, ...options,
  });
  if (result.exitCode === 1 && !result.stdout.trim() && !result.timedOut) return 0o600;
  const failure = snapshotFailure("git config core.sharedRepository", result);
  if (failure) throw new Error("cannot inspect lock-store sharing mode: " + failure);
  const value = result.stdout.trim().toLowerCase();
  if (["all", "world", "everybody", "2"].includes(value)) return 0o664;
  if (["group", "true", "1"].includes(value)) return 0o660;
  if (/^0?[0-7]{3}$/u.test(value)) return Number.parseInt(value, 8) & 0o666;
  return 0o600;
}

async function readPublishedLegacyRepositoryId(idPath, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readLegacyRepositoryId(idPath, options);
    } catch (error) {
      if (error instanceof OperationCancelledError || error instanceof DeadlineExceededError) throw error;
      lastError = error;
      if (attempt + 1 < 40) {
        await interruptibleFilesystemOperation(
          new Promise((resolve) => setTimeout(resolve, 10)), options,
        );
      }
    }
  }
  throw lastError;
}

async function publishLegacyRepositoryId(storeRoot, repositoryId, options = {}) {
  const idPath = path.join(storeRoot, REPOSITORY_ID_FILE);
  const mode = await repositoryIdMode(storeRoot, options);
  const writing = writeFile(idPath, repositoryId + "\n", { flag: "wx", mode });
  try {
    await interruptibleFilesystemOperation(writing, options);
    await interruptibleFilesystemOperation(chmod(idPath, mode), options);
  } catch (error) {
    if (error.code !== "EEXIST") {
      // Cancellation cannot abort the small exclusive write. Leave a completed
      // identity as a safe compatibility anchor for the next request; a partial
      // write is malformed and therefore fails closed in both bridge versions.
      void writing.then(() => chmod(idPath, mode)).catch(() => {});
      throw error;
    }
  }
  return await readPublishedLegacyRepositoryId(idPath, options);
}

async function readRepositoryIdRef(storeRoot, options = {}) {
  const refResult = await runGitCommand(["rev-parse", "--verify", "--quiet", REPOSITORY_ID_REF], {
    cwd: storeRoot, ...options,
  });
  if (refResult.exitCode === 1 && !refResult.stdout.trim() && !refResult.timedOut) return null;
  const refFailure = snapshotFailure("git rev-parse repository identity ref", refResult);
  if (refFailure) throw new Error("cannot read lock-store repository identity: " + refFailure);
  const oid = refResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
    throw new Error("workspace lock store repository identity ref is invalid");
  }
  const blobResult = await runGitCommand(["cat-file", "blob", oid], {
    cwd: storeRoot, ...options,
  });
  const blobFailure = snapshotFailure("git cat-file repository identity", blobResult);
  if (blobFailure) throw new Error("cannot read lock-store repository identity: " + blobFailure);
  return validateRepositoryId(blobResult.stdout, "repository identity ref");
}

async function publishRepositoryIdRef(storeRoot, candidateId, options = {}) {
  const existing = await readRepositoryIdRef(storeRoot, options);
  if (existing) {
    if (existing !== candidateId) {
      throw new Error("workspace lock store repository identity ref conflicts with legacy identity");
    }
    return existing;
  }
  const blobResult = await runGitCommand(["hash-object", "-w", "--stdin"], {
    cwd: storeRoot, ...options, stdinText: candidateId + "\n",
  });
  const blobFailure = snapshotFailure("git hash-object repository identity", blobResult);
  const candidateOid = blobResult.stdout.trim();
  if (blobFailure || !/^[0-9a-f]{40,64}$/u.test(candidateOid)) {
    throw new Error("cannot write lock-store repository identity: " + (
      blobFailure || "invalid object id"
    ));
  }
  const updateResult = await runGitCommand([
    "update-ref", "--no-deref", REPOSITORY_ID_REF, candidateOid, "0".repeat(candidateOid.length),
  ], { cwd: storeRoot, ...options });
  if (updateResult.exitCode === 0) return candidateId;
  // A concurrent initializer may have won the create-only CAS. Read its value
  // instead of treating the expected contention as an initialization failure.
  const winner = await readRepositoryIdRef(storeRoot, options);
  if (winner) {
    if (winner !== candidateId) {
      throw new Error("workspace lock store repository identity CAS selected a conflicting value");
    }
    return winner;
  }
  const updateFailure = snapshotFailure("git update-ref repository identity", updateResult);
  throw new Error("cannot publish lock-store repository identity: " + (
    updateFailure || "repository identity ref was not created"
  ));
}

async function ensureRepositoryId(storeRoot, options = {}) {
  const refIdentity = await readRepositoryIdRef(storeRoot, options);
  const idPath = path.join(storeRoot, REPOSITORY_ID_FILE);
  let legacyIdentity = null;
  try {
    legacyIdentity = await readLegacyRepositoryId(idPath, options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (refIdentity && legacyIdentity && refIdentity !== legacyIdentity) {
    throw new Error("workspace lock store repository identity sources conflict");
  }
  if (refIdentity) {
    const publishedLegacy = legacyIdentity ??
      await publishLegacyRepositoryId(storeRoot, refIdentity, options);
    if (publishedLegacy !== refIdentity) {
      throw new Error("workspace lock store legacy identity conflicts with repository identity ref");
    }
    return refIdentity;
  }
  // Publish the file-compatible anchor first so an older bridge running during
  // a rolling upgrade can never create a second UUID/lock domain. `wx` is the
  // only required filesystem primitive; partial/crashed writes are malformed
  // and fail closed rather than allowing a different identity to be published.
  const publishedLegacy = legacyIdentity ??
    await publishLegacyRepositoryId(storeRoot, randomUUID(), options);
  return await publishRepositoryIdRef(storeRoot, publishedLegacy, options);
}

async function ensureWorkspaceQuarantineRoot(storeRoot, options = {}) {
  const storeMetadata = await interruptibleFilesystemOperation(lstat(storeRoot), options);
  if (!storeMetadata.isDirectory() || storeMetadata.isSymbolicLink()) {
    throw new Error("workspace lock store must be a real directory before quarantine state is trusted");
  }
  const quarantineRoot = path.join(storeRoot, WORKSPACE_QUARANTINE_DIRECTORY);
  const fileMode = await repositoryIdMode(storeRoot, options);
  const directoryMode = fileMode | ((fileMode & 0o444) >> 2) |
    (process.platform !== "win32" && (fileMode & 0o060) === 0o060 ? 0o2000 : 0);
  let metadata = null;
  try {
    metadata = await interruptibleFilesystemOperation(lstat(quarantineRoot), options);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!metadata) {
    const creatingCandidate = mkdtemp(path.join(storeRoot, ".cli-agent-bridge-quarantines-"));
    let candidateRoot;
    try {
      candidateRoot = await interruptibleFilesystemOperation(creatingCandidate, options);
    } catch (error) {
      void creatingCandidate.then((lateRoot) => rm(lateRoot, { recursive: true, force: true }))
        .catch(() => {});
      throw error;
    }
    try {
      if (process.platform !== "win32") {
        await interruptibleFilesystemOperation(chmod(candidateRoot, directoryMode), options);
      }
      try {
        await interruptibleFilesystemOperation(rename(candidateRoot, quarantineRoot), options);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      }
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
    metadata = await interruptibleFilesystemOperation(lstat(quarantineRoot), options);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("workspace quarantine root must be a real directory inside the lock store");
  }
  if (process.platform !== "win32" &&
      (metadata.mode & directoryMode) !== directoryMode) {
    throw new Error("workspace quarantine root does not preserve the repository sharing mode");
  }
  return quarantineRoot;
}

async function ensureWorkspaceLockStore(gitCommonDir, options = {}) {
  const storeRoot = path.join(gitCommonDir, WORKSPACE_LOCK_STORE_NAME);
  let initialized = false;
  try {
    const head = await interruptibleFilesystemOperation(stat(path.join(storeRoot, "HEAD")), options);
    initialized = head.isFile();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!initialized) {
    const sharedResult = await runGitCommand([
      "--git-dir", gitCommonDir, "config", "--get", "core.sharedRepository",
    ], { cwd: gitCommonDir, ...options });
    const sharedFailure = sharedResult.exitCode === 1 && !sharedResult.stdout.trim()
      ? ""
      : snapshotFailure("git config core.sharedRepository", sharedResult);
    if (sharedFailure) {
      throw new Error("cannot inspect repository sharing mode: " + sharedFailure);
    }
    const shared = sharedResult.stdout.replace(/\r?\n$/u, "");
    const creatingCandidate = mkdtemp(path.join(gitCommonDir, ".cli-agent-bridge-lock-store-"));
    let candidateRoot;
    try {
      candidateRoot = await interruptibleFilesystemOperation(creatingCandidate, options);
    } catch (error) {
      void creatingCandidate.then((lateRoot) => rm(lateRoot, { recursive: true, force: true })).catch(() => {});
      throw error;
    }
    try {
      const initArgs = ["init", "--bare", "--quiet", "--template="];
      if (shared) initArgs.push("--shared=" + shared);
      initArgs.push(candidateRoot);
      const result = await runGitCommand(initArgs, {
        cwd: gitCommonDir, ...options, containProcessTree: true,
      });
      const failure = snapshotFailure("git init --bare workspace lock store", result);
      if (failure) throw new Error("cannot initialize workspace lock store: " + failure);
      try {
        await interruptibleFilesystemOperation(rename(candidateRoot, storeRoot), options);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      }
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
  }
  const head = await interruptibleFilesystemOperation(stat(path.join(storeRoot, "HEAD")), options);
  if (!head.isFile()) throw new Error("workspace lock store HEAD is not a file");
  // On Linux storeRoot may be below /proc/<bridge-pid>/fd/<directory-fd>.
  // Keep that stable alias instead of resolving it back to a pathname that a
  // concurrent repository rename can invalidate while the lease is active.
  const repositoryId = await ensureRepositoryId(storeRoot, options);
  return {
    root: storeRoot,
    repositoryId,
    quarantineRoot: await ensureWorkspaceQuarantineRoot(storeRoot, options),
  };
}

function snapshotFailure(label, result) {
  if (result.treeTerminated === false) {
    return label + " process tree could not be confirmed terminated" +
      (result.terminationError ? ": " + result.terminationError : "");
  }
  if (result.timedOut) return label + " timed out";
  if (result.stdoutTruncated || result.stderrTruncated) {
    return label + " exceeded the " + String(MAX_CAPTURE_CHARS) + " character capture limit";
  }
  if (result.errorMessage) return label + " could not start: " + result.errorMessage;
  if (result.exitCode !== 0) return label + " failed with exit code " + String(result.exitCode);
  return "";
}

class OperationCancelledError extends Error {}
class DeadlineExceededError extends Error {}
class InvalidArgumentsError extends Error {}
class GitProcessTreeUnconfirmedError extends Error {
  constructor(label, terminationError, quarantine = null) {
    super(label + " process tree could not be confirmed terminated: " + terminationError);
    this.terminationError = terminationError;
    this.quarantine = quarantine;
  }
}

const BACKEND_GIT_ROUTING_VARIABLES = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG",
  "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH", "GIT_REFERENCE_BACKEND",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
]);

function gitCommandIndex(argv) {
  const valueOptions = new Set([
    "-C", "-c", "--config-env", "--exec-path", "--git-dir", "--namespace",
    "--super-prefix", "--work-tree",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const value = String(argv[index] ?? "");
    if (value === "--") return index + 1 < argv.length ? index + 1 : -1;
    if (!value.startsWith("-")) return index;
    if (!value.includes("=") && valueOptions.has(value)) index += 1;
  }
  return -1;
}

export function backendGitProvenanceEnvironment(tracePath, baseEnvironment = process.env) {
  if (typeof tracePath !== "string" || !path.isAbsolute(tracePath)) {
    throw new Error("Git fetch provenance trace path is unavailable");
  }
  const env = { ...baseEnvironment };
  for (const name of Object.keys(env)) {
    const canonical = process.platform === "win32" ? name.toUpperCase() : name;
    if (BACKEND_GIT_ROUTING_VARIABLES.has(canonical) ||
        /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(canonical) ||
        canonical === "GIT_REFLOG_ACTION" || canonical.startsWith("GIT_TRACE")) {
      delete env[name];
    }
  }
  // Trace2 identifies successful fetch/pull commands in the canonical target
  // repository. Git does not expose a complete, cross-version per-fetch tip
  // log, so their presence makes commit attribution explicitly unavailable
  // instead of relying on the last (overwritable) FETCH_HEAD contents.
  env.GIT_TRACE2_EVENT = tracePath;
  return env;
}

async function createBackendGitProvenance(baseEnvironment = process.env, options = {}) {
  let root = "";
  let tracePath = "";
  let handle = null;
  let pendingOperation = Promise.resolve();
  const step = async (start, remember = () => {}) => {
    checkTraceInterruption(options);
    const operation = Promise.resolve().then(start).then((value) => {
      remember(value);
      return value;
    });
    pendingOperation = operation.catch(() => {});
    return await interruptibleFilesystemOperation(operation, options);
  };
  const cleanup = async () => {
    await pendingOperation;
    await handle?.close().catch(() => {});
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  };
  try {
    root = await step(
      () => mkdtemp(path.join(os.tmpdir(), "minimax-cli-agent-fetch-")),
      (value) => { root = value; tracePath = path.join(value, "git.trace"); },
    );
    if (process.env.NODE_ENV === "test") {
      const releaseFile = process.env.CLI_AGENT_BRIDGE_TEST_TRACE_PENDING_STEP_RELEASE_FILE;
      if (typeof releaseFile === "string" && path.isAbsolute(releaseFile)) {
        await step(async () => {
          const startedFile = process.env.CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_STARTED_FILE;
          if (typeof startedFile === "string" && path.isAbsolute(startedFile)) {
            await writeFile(startedFile, root + "\n", { flag: "a" });
          }
          while (true) {
            try {
              await stat(releaseFile);
              break;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
        });
      }
    }
    await step(() => chmod(root, 0o700));
    const rootIdentity = await step(() => lstat(root, { bigint: true }));
    if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() ||
        !sameTraceIdentity(rootIdentity, rootIdentity)) {
      throw new Error("Git fetch provenance root has no stable directory identity");
    }
    handle = await step(
      () => open(tracePath, "wx+", 0o600),
      (value) => { handle = value; },
    );
    await step(() => handle.chmod(0o600));
    const identity = await step(() => handle.stat({ bigint: true }));
    if (!identity.isFile() || !sameTraceIdentity(identity, identity)) {
      throw new Error("Git fetch provenance trace has no stable regular-file identity");
    }
    if (process.env.NODE_ENV === "test") {
      const delayMs = Number(process.env.CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_DELAY_MS ?? 0);
      if (Number.isFinite(delayMs) && delayMs > 0) {
        const startedFile = process.env.CLI_AGENT_BRIDGE_TEST_TRACE_CREATION_STARTED_FILE;
        if (typeof startedFile === "string" && path.isAbsolute(startedFile)) {
          await writeFile(startedFile, root + "\n", { flag: "a" });
        }
        await interruptibleFilesystemOperation(
          new Promise((resolve) => setTimeout(resolve, delayMs)), options,
        );
      }
    }
    return {
      root, rootIdentity, tracePath, handle, identity,
      env: backendGitProvenanceEnvironment(tracePath, baseEnvironment),
    };
  } catch (error) {
    if (error instanceof OperationCancelledError || error instanceof DeadlineExceededError) {
      // A raced filesystem call may finish after the request unwinds. Its
      // remembered root/handle is cleaned asynchronously once that call settles.
      trackBackgroundFinalizer(cleanup());
    } else {
      await cleanup();
    }
    throw error;
  }
}

function sameTraceIdentity(left, right) {
  return left.dev !== 0n && left.ino !== 0n &&
    left.dev === right.dev && left.ino === right.ino;
}

function sameTraceSnapshot(left, right) {
  return sameTraceIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readBoundedTrace(handle, options = {}) {
  const captured = Buffer.allocUnsafe(MAX_CAPTURE_CHARS + 1);
  let offset = 0;
  while (offset < captured.length) {
    checkTraceInterruption(options);
    const length = Math.min(64 * 1024, captured.length - offset);
    const { bytesRead } = await interruptibleFilesystemOperation(
      handle.read(captured, offset, length, offset), options,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_CAPTURE_CHARS) {
    throw new Error("Git fetch provenance trace exceeded the capture limit");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(captured.subarray(0, offset));
}

function checkTraceInterruption({ cancel = null, deadline = null } = {}) {
  if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
  if (deadline !== null && Date.now() >= deadline) {
    throw new DeadlineExceededError("delegation deadline exceeded");
  }
}

export async function readBackendGitProvenance(provenance, worktreeRoot, options = {}) {
  if (!provenance?.handle || !provenance?.identity) {
    throw new Error("Git fetch provenance trace handle is unavailable");
  }
  checkTraceInterruption(options);
  const [before, pathBefore] = await Promise.all([
    interruptibleFilesystemOperation(provenance.handle.stat({ bigint: true }), options),
    interruptibleFilesystemOperation(lstat(provenance.tracePath, { bigint: true }), options),
  ]);
  if (!before.isFile() || !pathBefore.isFile() ||
      !sameTraceIdentity(before, provenance.identity) || !sameTraceIdentity(pathBefore, before)) {
    throw new Error("Git fetch provenance trace path no longer identifies the original regular file");
  }
  if (before.size > BigInt(MAX_CAPTURE_CHARS)) {
    throw new Error("Git fetch provenance trace exceeded the capture limit");
  }
  const trace = await readBoundedTrace(provenance.handle, options);
  checkTraceInterruption(options);
  const [after, pathAfter] = await Promise.all([
    interruptibleFilesystemOperation(provenance.handle.stat({ bigint: true }), options),
    interruptibleFilesystemOperation(lstat(provenance.tracePath, { bigint: true }), options),
  ]);
  if (!pathAfter.isFile() || !sameTraceSnapshot(before, after) ||
      !sameTraceIdentity(pathAfter, after)) {
    throw new Error("Git fetch provenance trace changed while it was being read");
  }
  const sessions = new Map();
  const normalizeWorktree = (value) => {
    const normalized = path.resolve(String(value ?? ""));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const targetWorktree = normalizeWorktree(worktreeRoot);
  let offset = 0;
  let nextYield = TRACE_PARSE_YIELD_CHARS;
  checkTraceInterruption(options);
  while (offset <= trace.length) {
    const newline = trace.indexOf("\n", offset);
    const end = newline === -1 ? trace.length : newline;
    if (end - offset > MAX_TRACE_EVENT_CHARS) {
      throw new Error("Git fetch provenance trace contained an oversized Trace2 event");
    }
    let line = trace.slice(offset, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("{")) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("Git fetch provenance trace contained malformed Trace2 JSON");
      }
      if (event?.event === "start") {
        const commandIndex = Array.isArray(event.argv) ? gitCommandIndex(event.argv) : -1;
        const command = commandIndex >= 0 ? event.argv[commandIndex] : "";
        if (command === "fetch" || command === "pull") {
          sessions.set(event.sid, { command, worktree: null, exitCode: null, exited: false });
        }
      } else if (event?.event === "def_repo") {
        const session = sessions.get(event.sid);
        if (session) session.worktree = normalizeWorktree(event.worktree);
      } else if (event?.event === "exit") {
        const session = sessions.get(event.sid);
        if (session) {
          session.exited = true;
          session.exitCode = event.code;
        }
      }
    }
    if (newline === -1) break;
    offset = end + 1;
    if (offset >= nextYield) {
      checkTraceInterruption(options);
      await new Promise((resolve) => setImmediate(resolve));
      checkTraceInterruption(options);
      nextYield = offset + TRACE_PARSE_YIELD_CHARS;
    }
  }
  let uncertain = false;
  let sawFetch = false;
  for (const session of sessions.values()) {
    if (session.worktree === null || !session.exited) {
      uncertain = true;
      continue;
    }
    if (session.worktree === targetWorktree && session.exitCode === 0) {
      sawFetch = true;
      uncertain = true;
    }
  }
  return { uncertain, sawFetch };
}

async function cleanupBackendGitProvenance(provenance) {
  // Only operate through the retained original handle and exact path names.
  // The backend knows this directory and may replace entries inside it, so a
  // recursive removal could be redirected or made unbounded after the worker.
  const options = { deadline: Date.now() + TRACE_CLEANUP_TIMEOUT_MS };
  await interruptibleFilesystemOperation(
    provenance?.handle?.truncate(0), options,
  ).catch(() => {});
  await interruptibleFilesystemOperation(
    provenance?.handle?.close(), options,
  ).catch(() => {});
  try {
    checkTraceInterruption(options);
    const root = await interruptibleFilesystemOperation(
      lstat(provenance.root, { bigint: true }), options,
    );
    if (!root.isDirectory() || root.isSymbolicLink() ||
        !sameTraceIdentity(root, provenance.rootIdentity)) return;
    await interruptibleFilesystemOperation(unlink(provenance.tracePath), options).catch(() => {});
    await interruptibleFilesystemOperation(rmdir(provenance.root), options).catch(() => {});
  } catch {
    // A replaced/missing root is untrusted. Leave it untouched; the retained
    // original trace handle has already been truncated and closed.
  }
}

export async function runGitCommand(args, {
  cwd,
  cancel = null,
  deadline = null,
  stdinText,
  binaryStdout = false,
  timeoutMs = GIT_TIMEOUT_MS,
  containProcessTree = false,
  commandRunner = runCommand,
} = {}) {
  if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
  const resolutionDeadline = deadline ?? Date.now() + timeoutMs;
  const executable = await resolveTrustedGitExecutable({ cancel, deadline: resolutionDeadline });
  const git = await safeGitInvocation(args, process.env, executable);
  if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
  const remaining = resolutionDeadline - Date.now();
  if (remaining <= 0) throw new DeadlineExceededError("delegation deadline exceeded");
  let controller = null;
  const result = await commandRunner(git.command, git.args, {
    cwd,
    env: git.env,
    stdinText,
    binaryStdout,
    manageProcessTree: containProcessTree,
    markerObservationGraceMs: 0,
    timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)),
    killGraceMs: 1_000,
    shouldCancel: () => Boolean(cancel?.cancelled),
    onChild: (current) => {
      controller = current;
      if (cancel) cancel.controller = current;
    },
  });
  if (cancel?.controller === controller) cancel.controller = null;
  // A contained Git command can be cancelled or hit the overall deadline at
  // the same time that descendant cleanup becomes uncertain. Preserve that
  // result so the snapshot caller can quarantine the retained lease before
  // reporting the interruption; throwing here would release the lease.
  if (!(containProcessTree && result.treeTerminated === false)) {
    if (cancel?.cancelled) throw new OperationCancelledError("operation cancelled by client");
    if (deadline !== null && result.timedOut && Date.now() >= deadline) {
      throw new DeadlineExceededError("delegation deadline exceeded");
    }
  }
  return result;
}

// A starting/running lease ref is conservatively active until its exact owner
// CAS removes or transitions it. Periodic ownership probes intentionally avoid
// writing heartbeat blobs, and a stale timestamp cannot prove that an escaped
// worker (or a worker on another host sharing the repository) has stopped.

async function gitSnapshot(worktreeRoot, options = {}) {
  const ownLockRef = typeof options.ownLockRef === "string" ? options.ownLockRef : null;
  const lockStoreRoot = typeof options.lockStoreRoot === "string" ? options.lockStoreRoot : null;
  const jobs = [
    ["git status --short", "status", ["status", "--short", "--untracked-files=all", "--ignore-submodules=none"], false, false, true],
    ["git diff --stat", "diffStat", ["diff", "--ignore-submodules=none", "--stat"], false, false, true],
    ["git diff --name-only -z", "diffNames", ["diff", "--ignore-submodules=none", "--name-only", "-z"], false, true, true],
    ["git diff --cached --stat", "cachedDiffStat", ["diff", "--cached", "--ignore-submodules=none", "--stat"]],
    ["git diff --cached --name-only -z", "cachedDiffNames", ["diff", "--cached", "--ignore-submodules=none", "--name-only", "-z"], false, true],
    ["git ls-files --others --exclude-standard -z", "untracked", ["ls-files", "--others", "--exclude-standard", "-z"], false, true],
    ["git rev-parse --verify --quiet HEAD", "head", ["rev-parse", "--verify", "--quiet", "HEAD"], true],
    ["git symbolic-ref --quiet HEAD", "headRef", ["symbolic-ref", "--quiet", "HEAD"], true],
    ["git for-each-ref", "refs", ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs"]],
    ["git rev-parse --git-path FETCH_HEAD", "fetchHeadPath", ["rev-parse", "--git-path", "FETCH_HEAD"]],
  ];
  // Run serially: status/diff may both refresh the index, so concurrent Git
  // processes can race for .git/index.lock on the same repository.
  const out = {};
  for (const job of jobs) {
    const result = await runGitCommand(job[2], {
      cwd: worktreeRoot, ...options, binaryStdout: job[4] === true,
      // Worktree status/diff can execute arbitrary clean filters despite
      // --no-ext-diff/--no-textconv. Keep those commands contained; commands
      // that only read refs/index metadata stay on the lightweight path.
      containProcessTree: options.containProcessTree === true || job[5] === true,
    });
    const contained = options.containProcessTree === true || job[5] === true;
    if (contained && result.treeTerminated === false) {
      const terminationError = result.terminationError ||
        "repository helper descendants may still be running";
      const quarantine = typeof options.onUnconfirmedProcessTree === "function"
        ? await options.onUnconfirmedProcessTree({ label: job[0], terminationError })
        : null;
      throw new GitProcessTreeUnconfirmedError(job[0], terminationError, quarantine);
    }
    if (job[3] === true && result.exitCode === 1 && !result.timedOut) {
      out[job[1]] = "";
      continue;
    }
    const failure = snapshotFailure(job[0], result);
    // Fail closed immediately: continuing with later commands only delays
    // lease release when a repository was renamed or removed mid-delegation.
    if (failure) throw new Error("git snapshot unreliable: " + failure);
    out[job[1]] = result.stdout;
  }
  const seen = new Set();
  const nulNames = (value) => {
    if (!Buffer.isBuffer(value)) {
      return String(value ?? "").split("\0").filter((name) => name.length > 0);
    }
    const names = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;
    for (let index = 0; index <= value.length; index += 1) {
      if (index < value.length && value[index] !== 0) continue;
      if (index > start) {
        const raw = value.subarray(start, index);
        try {
          names.push(decoder.decode(raw));
        } catch {
          // JSON strings cannot contain invalid UTF-8 bytes. A leading NUL can
          // never be a legal Git path, so this reserved representation is both
          // unambiguous and lossless for callers that need the original bytes.
          names.push("\0git-path-bytes:" + raw.toString("hex"));
        }
      }
      start = index + 1;
    }
    return names;
  };
  const changedFiles = [
    ...nulNames(out.diffNames),
    ...nulNames(out.cachedDiffNames),
    ...nulNames(out.untracked),
  ].filter((f) => (seen.has(f) ? false : (seen.add(f), true)));
  const diffStat = [
    ["", String(out.diffStat ?? "").trim()],
    ["staged: ", String(out.cachedDiffStat ?? "").trim()],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([prefix, value]) => value.split(/\r?\n/u).map((line) => prefix + line).join("\n"))
    .join("\n");
  const refs = {};
  for (const line of String(out.refs ?? "").split(/\r?\n/u)) {
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const ref = line.slice(0, separator);
    refs[ref] = line.slice(separator + 1);
  }
  const fetchHeads = [];
  const fetchHeadPath = path.resolve(
    worktreeRoot, String(out.fetchHeadPath ?? "").replace(/\r?\n$/u, ""),
  );
  try {
    const rawFetchHead = await interruptibleFilesystemOperation(readFile(fetchHeadPath, "utf8"), options);
    for (const line of rawFetchHead.split(/\r?\n/u)) {
      if (!line) continue;
      const oid = line.split("\t", 1)[0];
      if (!/^[0-9a-f]{40,64}$/u.test(oid)) {
        throw new Error("malformed FETCH_HEAD record");
      }
      if (!fetchHeads.includes(oid)) fetchHeads.push(oid);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      if (error instanceof OperationCancelledError || error instanceof DeadlineExceededError) throw error;
      throw new Error("git snapshot unreliable: cannot read FETCH_HEAD: " + error.message);
    }
  }
  const lockRefs = [];
  if (lockStoreRoot) {
    const storedRefs = await runGitCommand([
      "for-each-ref", "--format=%(refname)%09%(objectname)", WORKSPACE_LOCK_REF_PREFIX,
    ], { cwd: lockStoreRoot, ...options });
    const storedRefsFailure = snapshotFailure("git for-each-ref workspace lock store", storedRefs);
    if (storedRefsFailure) throw new Error("git snapshot unreliable: " + storedRefsFailure);
    for (const line of String(storedRefs.stdout ?? "").split(/\r?\n/u)) {
      if (!line) continue;
      const separator = line.indexOf("\t");
      if (separator <= 0) continue;
      const ref = line.slice(0, separator);
      if (ref !== ownLockRef) lockRefs.push(line.slice(separator + 1));
    }
  }
  // Linked worktrees serialize per worktree but share repository refs, so a
  // commit from a parallel delegation can land between our two snapshots.
  // Detection combines two signals: leases that are active right now, and the
  // persistent run-history records completed delegations leave behind, whose
  // [acquiredAt, endedAt] window is checked against this snapshot's window.
  const windowStart = Number.isFinite(options.concurrencyWindowStart)
    ? options.concurrencyWindowStart
    : Number.POSITIVE_INFINITY;
  let concurrentDelegations = 0;
  for (const oid of lockRefs) {
    const blob = await runGitCommand(["cat-file", "blob", oid], { cwd: lockStoreRoot, ...options });
    if (blob.exitCode !== 0) continue; // unreadable owner blob: ignore for disclosure
    try {
      const record = JSON.parse(blob.stdout);
      if (Number.isFinite(record?.endedAt)) {
        const acquiredAt = Number.isFinite(record.acquiredAt) ? record.acquiredAt : record.endedAt;
        if (acquiredAt <= Date.now() && record.endedAt >= windowStart) {
          concurrentDelegations += 1;
        }
        continue;
      }
      const active = record &&
        (record.workerState === "starting" || record.workerState === "running");
      if (active) concurrentDelegations += 1;
    } catch { /* malformed owner blob: ignore for disclosure */ }
  }
  const snapshot = {
    // The leading space in porcelain's first XY column is significant (for
    // example, " M" means unstaged). Remove only Git's final line terminator.
    statusShort: String(out.status ?? "").replace(/\r?\n$/u, ""),
    diffStat,
    changedFiles,
    head: String(out.head ?? "").trim(),
    headRef: String(out.headRef ?? "").replace(/\r?\n$/u, ""),
    refs,
    fetchHeads,
    concurrentDelegations,
  };
  return snapshot;
}

// Peel an object id to a commit id. Returns null for blob/tree objects (legal
// ref targets) and for tags that do not dereference to a commit.
async function peelCommitish(worktreeRoot, oid, cache = new Map(), options = {}) {
  if (!oid || !/^[0-9a-f]{40,64}$/u.test(oid)) return null;
  if (cache.has(oid)) return cache.get(oid);
  const typeResult = await runGitCommand(["cat-file", "-t", oid], {
    cwd: worktreeRoot, ...options,
  });
  let commit = null;
  if (typeResult.exitCode === 0) {
    const type = typeResult.stdout.trim();
    if (type === "commit") {
      commit = oid;
    } else if (type === "tag") {
      const peeled = await runGitCommand(
        ["rev-parse", "--verify", "--quiet", oid + "^{commit}"],
        { cwd: worktreeRoot, ...options },
      );
      if (peeled.exitCode === 0 && peeled.stdout.trim()) commit = peeled.stdout.trim();
    }
  }
  cache.set(oid, commit);
  return commit;
}

export async function populateCommitishCache(worktreeRoot, oids, cache, options = {}) {
  const pending = [...new Set(oids)].filter((oid) =>
    typeof oid === "string" && /^[0-9a-f]{40,64}$/u.test(oid) && !cache.has(oid));
  // Keep each response comfortably below the bounded capture limit while
  // reducing thousands of per-ref cat-file processes to a few batch queries.
  const chunkSize = 4_000;
  for (let offset = 0; offset < pending.length; offset += chunkSize) {
    const chunk = pending.slice(offset, offset + chunkSize);
    const result = await runGitCommand([
      "cat-file", "--batch-check=%(objectname) %(objecttype)",
    ], {
      cwd: worktreeRoot,
      ...options,
      stdinText: chunk.map((oid) => oid + "^{commit}").join("\n") + "\n",
    });
    const failure = snapshotFailure("git cat-file --batch-check", result);
    if (failure) throw new Error("cannot classify repository tips: " + failure);
    const lines = String(result.stdout ?? "").replace(/\r?\n$/u, "").split(/\r?\n/u);
    if (lines.length !== chunk.length) {
      throw new Error("cannot classify repository tips: incomplete git cat-file response");
    }
    for (let index = 0; index < chunk.length; index += 1) {
      const match = /^([0-9a-f]{40,64}) commit$/u.exec(lines[index]);
      if (!match && !lines[index].endsWith(" missing")) {
        throw new Error("cannot classify repository tips: malformed git cat-file response");
      }
      cache.set(chunk[index], match ? match[1] : null);
    }
  }
}

export async function closestExistingBase(worktreeRoot, target, baselineCommits, options = {}) {
  if (baselineCommits.length === 0) return null;
  // One boundary walk finds the pre-run commits immediately adjacent to the
  // target's new history. Supplying exclusions on stdin avoids command-line
  // limits and, unlike one merge-base/rev-list process per ref, keeps Git
  // process count constant even for repositories with thousands of tips.
  const walk = await runGitCommand([
    "rev-list", "--topo-order", "--boundary", target, "--stdin",
  ], {
    cwd: worktreeRoot,
    ...options,
    stdinText: baselineCommits.map((commit) => "^" + commit).join("\n") + "\n",
  });
  const failure = snapshotFailure("git rev-list --boundary " + target, walk);
  if (failure) throw new Error("cannot select committed-delta baseline: " + failure);
  for (const line of String(walk.stdout ?? "").split(/\r?\n/u)) {
    if (!line.startsWith("-")) continue;
    const boundary = line.slice(1).trim();
    if (/^[0-9a-f]{40,64}$/u.test(boundary)) return boundary;
  }
  // Disjoint histories have no excluded boundary; callers use the empty tree
  // so the stat still represents the newly reachable target history.
  return null;
}

export async function committedDelta(worktreeRoot, before, after, options = {}) {
  const refNames = new Set([...Object.keys(before.refs ?? {}), ...Object.keys(after.refs ?? {})]);
  const refsChanged = [...refNames].sort().flatMap((ref) => {
    const beforeOid = before.refs?.[ref] ?? "";
    const afterOid = after.refs?.[ref] ?? "";
    return beforeOid === afterOid ? [] : [{ ref, before: beforeOid, after: afterOid }];
  });
  const provenance = after?.[FETCH_PROVENANCE_TIPS] ?? null;
  if (provenance?.uncertain) {
    return {
      attributionUnavailable: true,
      attributionError: "Git fetch or pull ran in the workspace; per-fetch external tips could not be proven completely",
      refsChanged,
      newCommitCount: null,
      log: "",
      diffStat: null,
    };
  }
  if (before.head === after.head && before.headRef === after.headRef && refsChanged.length === 0) return null;

  let emptyTreeId = "";
  async function emptyTree() {
    if (emptyTreeId) return emptyTreeId;
    const emptyTree = await runGitCommand(["mktree"], {
      cwd: worktreeRoot,
      ...options,
      stdinText: "",
      containProcessTree: true,
    });
    const failure = snapshotFailure("git mktree", emptyTree);
    if (failure || !emptyTree.stdout.trim()) {
      throw new Error("cannot compute committed delta from unborn HEAD: " + (failure || "empty tree id missing"));
    }
    emptyTreeId = emptyTree.stdout.trim();
    return emptyTreeId;
  }

  const cache = new Map();
  await populateCommitishCache(worktreeRoot, [
    before.head,
    ...Object.values(before.refs ?? {}),
    ...(before.fetchHeads ?? []),
    after.head,
    ...Object.values(after.refs ?? {}),
    ...refsChanged.flatMap((change) => [change.before, change.after]),
  ], cache, options);
  // Baseline: every commit that already existed before the worker ran. New
  // commits are attributed to the worker only when they are reachable from the
  // after-state but from none of these, so merely checking out an existing
  // divergent branch is never reported as "commits made by the worker".
  const baselineCommits = [];
  async function addBaseline(oid) {
    const commit = await peelCommitish(worktreeRoot, oid, cache, options);
    if (commit && !baselineCommits.includes(commit)) baselineCommits.push(commit);
  }
  await addBaseline(before.head);
  for (const oid of new Set([
    ...Object.values(before.refs ?? {}),
    ...(before.fetchHeads ?? []),
    ...refsChanged.map((change) => change.before),
  ])) {
    await addBaseline(oid);
  }
  // A worker committing on the checked-out branch moves HEAD and its branch ref
  // across the same object pair; deduplicate by that pair so the log, diff, and
  // commit count are emitted once with both labels.
  const targets = [];
  const targetIndex = new Map();
  function addTarget(label, beforeOid, afterOid) {
    const key = (beforeOid || "") + "\0" + (afterOid || "");
    const existing = targetIndex.get(key);
    if (existing !== undefined) {
      targets[existing].labels.push(label);
      return;
    }
    targetIndex.set(key, targets.length);
    targets.push({ labels: [label], beforeOid, afterOid });
  }
  addTarget("HEAD", before.head, after.head);
  for (const change of refsChanged) {
    addTarget(change.ref, change.before, change.after);
  }

  const movementLogs = [];
  if ((before.headRef ?? "") !== (after.headRef ?? "")) {
    movementLogs.push(
      "HEAD symbolic target " + (before.headRef || "(detached)") +
      " -> " + (after.headRef || "(detached)"),
    );
  }
  const statNotes = [];
  const statRanges = new Map();
  const attributedCommits = new Map();
  for (const { labels, beforeOid, afterOid } of targets) {
    if (!afterOid || beforeOid === afterOid) continue;
    const label = labels.join(", ");
    const target = await peelCommitish(worktreeRoot, afterOid, cache, options);
    if (!target) {
      // Legal non-commit ref (for example a tag pointing at a blob): report the
      // movement, never build a commit range from it.
      movementLogs.push(label + " -> " + afterOid + " (non-commit object; no commit log)");
      statNotes.push(label + ": (non-commit ref target)");
      continue;
    }
    // Everything reachable from the pre-delegation state is excluded, so only
    // commits the worker actually created remain attributed to it.
    const exclusions = baselineCommits;
    const revList = await runGitCommand(
      exclusions.length > 0
        ? ["log", "--format=%H%x09%s", target, "--stdin"]
        : ["log", "--format=%H%x09%s", target],
      {
        cwd: worktreeRoot,
        ...options,
        stdinText: exclusions.length > 0
          ? exclusions.map((commit) => "^" + commit).join("\n") + "\n"
          : undefined,
      },
    );
    const revListFailure = snapshotFailure("git log " + target, revList);
    if (revListFailure) throw new Error("committed delta unreliable: " + revListFailure);
    const newCommits = String(revList.stdout ?? "").trim();
    if (!newCommits) {
      const note = labels.includes("HEAD") && beforeOid
        ? "HEAD moved from " + beforeOid.slice(0, 12) + " to " + afterOid.slice(0, 12) +
          " without creating commits (branch checkout or reset); the target history predates the delegation"
        : label + " now points to pre-existing history; no new commits";
      movementLogs.push(label + ": " + note);
      statNotes.push(label + ": (no new commits)");
      continue;
    }
    for (const line of newCommits.split("\n")) {
      const separator = line.indexOf("\t");
      const oid = separator === -1 ? line : line.slice(0, separator);
      const subject = separator === -1 ? "" : line.slice(separator + 1);
      const existing = attributedCommits.get(oid);
      if (existing) {
        for (const item of labels) existing.labels.add(item);
      } else {
        attributedCommits.set(oid, { oid, subject, labels: new Set(labels) });
      }
    }
    // Diff from the closest ancestral pre-run tip, even for an existing ref.
    // A force update can move a ref onto a pre-existing descendant lineage;
    // using its older (but still ancestral) tip would attribute that lineage's
    // already-existing changes to the worker.
    let base;
    const previousTarget = beforeOid
      ? await peelCommitish(worktreeRoot, beforeOid, cache, options)
      : null;
    if (baselineCommits.length > 0) {
      base = await closestExistingBase(worktreeRoot, target, baselineCommits, options) ?? await emptyTree();
    } else if (previousTarget) {
      base = previousTarget;
    } else {
      base = before.head || await emptyTree();
    }
    const range = base + ".." + target;
    const diff = await runGitCommand(["diff", "--stat", range], {
      cwd: worktreeRoot, ...options,
    });
    const diffFailure = snapshotFailure("git diff --stat " + range, diff);
    if (diffFailure) throw new Error("committed delta unreliable: " + diffFailure);
    const existingRange = statRanges.get(range);
    if (existingRange) {
      for (const item of labels) existingRange.labels.add(item);
    } else {
      statRanges.set(range, {
        labels: new Set(labels),
        text: String(diff.stdout ?? "").trim() || "(empty)",
      });
    }
  }
  const commitLogs = [...attributedCommits.values()].map((commit) =>
    [...commit.labels].join(", ") + ": " + commit.oid.slice(0, 12) +
      (commit.subject ? " " + commit.subject : ""),
  );
  const logs = [...movementLogs];
  if (commitLogs.length > 0) {
    logs.push("worker-created commits (deduplicated across moved refs)\n" + commitLogs.join("\n"));
  }
  const stats = [
    ...statNotes,
    ...[...statRanges.entries()].map(([range, entry]) =>
      [...entry.labels].join(", ") + " [" + range + "]\n" + entry.text,
    ),
  ];
  return {
    range: logs.length > 0 ? "attribution: new commits only (pre-existing history excluded)" : "",
    refsChanged,
    newCommitCount: attributedCommits.size,
    log: logs.join("\n\n") || "(no ref or HEAD movements)",
    diffStat: stats.join("\n\n") || "(empty)",
  };
}

export function backendEntryFromProbe(name, spec, check) {
  const available = check.exitCode === 0 && check.treeTerminated === true;
  const probeError = check.treeTerminated !== true
    ? (check.terminationError || "backend version probe process tree could not be confirmed terminated")
    : (check.errorMessage || "command not found or not executable");
  return {
    name,
    label: typeof spec.label === "string" ? spec.label : name,
    command: spec.command,
    available,
    experimental: Boolean(spec.experimental),
    version: available ? tail(check.stdout, 200).trim() : null,
    error: available ? "" : probeError,
    resumeSupported: Array.isArray(spec.resumeArgs),
    notes: typeof spec.notes === "string" ? spec.notes : "",
  };
}

async function listBackends(cancel = null) {
  const backends = await loadBackends();
  const entries = [];
  for (const [name, spec] of Object.entries(backends)) {
    // A hung `--version` probe must not pin the request: the client can cancel
    // the discovery call, terminating the current probe and skipping the rest.
    if (cancel?.cancelled) break;
    if (!spec || typeof spec.command !== "string") continue;
    if (!supportsReliableProcessContainment()) {
      entries.push({
        name,
        label: typeof spec.label === "string" ? spec.label : name,
        command: spec.command,
        available: false,
        experimental: Boolean(spec.experimental),
        version: null,
        error: "unsupported platform: reliable descendant containment is available only on Windows and Linux",
        resumeSupported: Array.isArray(spec.resumeArgs),
        notes: typeof spec.notes === "string" ? spec.notes : "",
      });
      continue;
    }
    let resolvedCommand;
    try {
      resolvedCommand = await resolveBackendCommand(spec.command, { cancel });
    } catch (error) {
      if (error instanceof OperationCancelledError) break;
      throw error;
    }
    if (!resolvedCommand) {
      entries.push({
        name,
        label: typeof spec.label === "string" ? spec.label : name,
        command: spec.command,
        available: false,
        experimental: Boolean(spec.experimental),
        version: null,
        error: "command not found or not executable",
        resumeSupported: Array.isArray(spec.resumeArgs),
        notes: typeof spec.notes === "string" ? spec.notes : "",
      });
      continue;
    }
    const check = await runCommand(resolvedCommand, ["--version"], {
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
      manageProcessTree: true,
      shouldCancel: () => Boolean(cancel?.cancelled),
      onChild: (controller) => {
        if (cancel) cancel.controller = controller;
      },
    });
    if (cancel?.controller) cancel.controller = null;
    entries.push(backendEntryFromProbe(name, spec, check));
  }
  return entries;
}

function workspaceQuarantinePath(quarantineRoot, key) {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(quarantineRoot, digest + ".quarantine");
}

function workspaceQuarantineRecoveryPath(quarantineRoot, key) {
  return workspaceQuarantinePath(quarantineRoot, key) + ".recovery-approved";
}

async function readWorkspaceQuarantine(quarantineRoot, key) {
  const quarantinePath = workspaceQuarantinePath(quarantineRoot, key);
  try {
    const marker = await stat(quarantinePath);
    let raw = null;
    if (marker.isDirectory()) {
      try {
        raw = await readFile(path.join(quarantinePath, QUARANTINE_RECORD_FILE), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else if (marker.isFile()) {
      // Compatibility with quarantine marker files created by older bridges.
      raw = await readFile(quarantinePath, "utf8");
    }
    let details;
    try {
      details = typeof raw === "string" ? JSON.parse(raw) : { error: "invalid quarantine record" };
    } catch { details = { error: "invalid quarantine record" }; }
    return { quarantinePath: await realpath(quarantinePath), details };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Recovery is an explicit, durable rename of the quarantine record rather than
// inference from an absent temporary file. The random id binds authorization
// to the exact quarantined lease and prevents a stale approval from carrying
// over to a later incident.
async function quarantineRecoveryApproved(quarantineRoot, key, owner) {
  try {
    const recoveryPath = workspaceQuarantineRecoveryPath(quarantineRoot, key);
    const marker = await stat(recoveryPath);
    const raw = marker.isDirectory()
      ? await readFile(path.join(recoveryPath, QUARANTINE_RECORD_FILE), "utf8")
      : await readFile(recoveryPath, "utf8");
    const record = JSON.parse(raw);
    return typeof owner?.quarantineId === "string" &&
      record?.quarantineId === owner.quarantineId;
  } catch {
    return false;
  }
}

async function clearQuarantineRecoveryApproval(quarantineRoot, key) {
  await rm(workspaceQuarantineRecoveryPath(quarantineRoot, key), { recursive: true, force: true });
}

export async function markWorkspaceQuarantined(
  quarantineRoot, key, details, quarantineId = randomUUID(),
) {
  if (typeof quarantineId !== "string" || !quarantineId) {
    throw new Error("quarantine id is unavailable");
  }
  const rootMetadata = await lstat(quarantineRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("workspace quarantine root is not a trusted lock-store directory");
  }
  const quarantinePath = workspaceQuarantinePath(quarantineRoot, key);
  const markerDirectoryMode = process.platform === "win32"
    ? 0o700
    : rootMetadata.mode & 0o2777;
  const markerFileMode = process.platform === "win32"
    ? 0o600
    : rootMetadata.mode & 0o666;
  const token = process.pid + "-" + randomUUID();
  const temporaryPath = quarantinePath + ".owner-" + token;
  const record = {
    ...details,
    quarantineId,
    serverPid: process.pid,
    processIdentity: await cachedProcessStartIdentity(process.pid),
    quarantinedAt: new Date().toISOString(),
  };
  await mkdir(temporaryPath, { mode: markerDirectoryMode });
  if (process.platform !== "win32") await chmod(temporaryPath, markerDirectoryMode);
  await writeFile(path.join(temporaryPath, QUARANTINE_RECORD_FILE), JSON.stringify(record), {
    flag: "wx", mode: markerFileMode,
  });
  if (process.platform !== "win32") {
    await chmod(path.join(temporaryPath, QUARANTINE_RECORD_FILE), markerFileMode);
  }
  let preserveTemporary = false;
  let published = false;
  try {
    try {
      await stat(quarantinePath);
      throw new Error("workspace quarantine marker already exists at " + quarantinePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      // A populated directory is complete before its same-filesystem rename
      // makes the final marker visible. Concurrent publishers cannot replace a
      // non-empty winner, and no hard-link support is required.
      await rename(temporaryPath, quarantinePath);
      published = true;
    } catch (error) {
      try {
        await stat(quarantinePath);
        throw new Error("workspace quarantine marker already exists at " + quarantinePath);
      } catch (observed) {
        if (observed.code !== "ENOENT") throw observed;
      }
      preserveTemporary = true;
      error.message += "; complete recovery record remains at " + temporaryPath;
      throw error;
    }
  } finally {
    if (!preserveTemporary) await rm(temporaryPath, { recursive: true, force: true });
  }
  return { quarantinePath: await realpath(quarantinePath), quarantineId, details: record };
}

let linuxBootIdPromise = null;
const processIdentityCache = new Map();
async function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      linuxBootIdPromise ??= readFile("/proc/sys/kernel/random/boot_id", "utf8")
        .then((value) => value.trim());
      const [bootId, raw] = await Promise.all([
        linuxBootIdPromise,
        readFile("/proc/" + String(pid) + "/stat", "utf8"),
      ]);
      const close = raw.lastIndexOf(")");
      if (close < 0) return null;
      const fields = raw.slice(close + 1).trim().split(/\s+/u);
      if (["Z", "X", "x"].includes(fields[0])) return null;
      return "linux:" + bootId + ":" + fields[19]; // field 22: start time since boot
    } catch (error) {
      if (error.code === "ENOENT") return null;
    }
  } else if (process.platform === "win32") {
    const script = "$p=Get-Process -Id " + String(pid) +
      " -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.StartTime.ToUniversalTime().Ticks }";
    const result = await runCommand(trustedWindowsPowerShell(), [
      "-NoProfile", "-NonInteractive", "-Command", script,
    ], { timeoutMs: 5_000 });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return "windows:" + result.stdout.trim();
    }
  } else {
    const result = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)], {
      timeoutMs: 5_000,
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      return process.platform + ":" + result.stdout.trim();
    }
  }
  return null;
}

async function cachedProcessStartIdentity(pid) {
  const cached = processIdentityCache.get(pid);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await processStartIdentity(pid);
  processIdentityCache.set(pid, { value, expiresAt: Date.now() + 1_000 });
  return value;
}

let serverProcessIdentityPromise = null;
async function serverProcessStartIdentity() {
  serverProcessIdentityPromise ??= processStartIdentity(process.pid);
  const identity = await serverProcessIdentityPromise;
  if (!identity) {
    serverProcessIdentityPromise = null;
    throw new Error("cannot establish the bridge process start identity for workspace locking");
  }
  return identity;
}

// The in-memory queue preserves FIFO order within this server. A Git-ref CAS
// lease extends the same canonical-worktree mutex across independent stdio
// server processes without a read-then-unlink stale-owner race.
const workspaceLocks = new Map();
const quarantinedWorkspaces = new Set();
async function quarantineLeaseForProcessTree({
  quarantineRoot, lockKey, workspaceLease, backend, workspacePath, worktreeRoot,
  terminationError,
}) {
  quarantinedWorkspaces.add(lockKey);
  workspaceLease.retain();
  const quarantineId = randomUUID();
  await workspaceLease.markWorkerQuarantinePending(quarantineId);
  const details = {
    backend, workspacePath, worktreeRoot, lockRef: workspaceLease.ref, terminationError,
  };
  const quarantine = await markWorkspaceQuarantined(
    quarantineRoot, lockKey, details, quarantineId,
  );
  await workspaceLease.markWorkerQuarantined(quarantine.quarantineId);
  quarantinedWorkspaces.delete(lockKey);
  return { quarantinePath: quarantine.quarantinePath, details: quarantine.details };
}
async function withWorkspaceLock(key, lockStoreRoot, fn, {
  cancel = null,
  deadline = null,
  onCancelled = null,
  onDeadline = null,
  isUnavailable = null,
  onUnavailable = null,
  operatorRecoveryApproved = null,
  onAcquired = null,
} = {}) {
  const prev = workspaceLocks.get(key) ?? Promise.resolve();
  const prevDone = prev.catch(() => {});
  let release;
  const gate = new Promise((r) => { release = r; });
  const next = prevDone.then(() => gate);
  workspaceLocks.set(key, next);
  let deadlineTimer = null;
  const waiters = [prevDone.then(() => "acquired")];
  if (cancel) waiters.push(cancel.promise.then(() => "cancelled"));
  if (deadline !== null) {
    waiters.push(new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(0, deadline - Date.now()));
    }));
  }
  const localResult = await Promise.race(waiters);
  clearTimeout(deadlineTimer);
  if (localResult !== "acquired") {
    release();
    // Keep the already-resolved gate chained behind its predecessor until the
    // predecessor releases. Deleting the map entry now would let a third
    // request bypass the still-running first holder.
    void next.finally(() => {
      if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
    });
    if (localResult === "cancelled") {
      return typeof onCancelled === "function" ? onCancelled() : undefined;
    }
    return typeof onDeadline === "function" ? onDeadline() : undefined;
  }
  let lease = null;
  try {
    if (typeof isUnavailable === "function" && await isUnavailable()) {
      return typeof onUnavailable === "function" ? onUnavailable() : undefined;
    }
    try {
      lease = await acquireGitWorkspaceLock({
        cwd: lockStoreRoot,
        key,
        cancel,
        deadline,
        operatorRecoveryApproved,
        ownerIdentity: await serverProcessStartIdentity(),
        processIdentityProbe: processStartIdentity,
      });
    } catch (error) {
      if (error instanceof WorkspaceLockCancelledError) {
        return typeof onCancelled === "function" ? onCancelled() : undefined;
      }
      if (error instanceof WorkspaceLockDeadlineError) {
        return typeof onDeadline === "function" ? onDeadline() : undefined;
      }
      throw error;
    }
    if (typeof onAcquired === "function") await onAcquired(lease);
    return await fn(lease);
  } finally {
    try {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          // release() persisted exact-owner recovery authorization in the
          // shared lock store before attempting deletion.
          throw error;
        }
      }
    } finally {
      release();
      if (workspaceLocks.get(key) === next) workspaceLocks.delete(key);
    }
  }
}

function createCancellation() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  const listeners = new Set();
  return {
    controller: null,
    cancelled: false,
    promise,
    subscribe(listener) {
      if (this.cancelled) {
        queueMicrotask(listener);
        return () => {};
      }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel() {
      if (this.cancelled) return;
      this.cancelled = true;
      resolve();
      for (const listener of listeners) listener();
      listeners.clear();
      if (this.controller) void this.controller.terminate("cancelled");
    },
  };
}

function cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before = null }) {
  return {
    ok: false,
    error: "delegation cancelled by client before the worker started",
    backend,
    workspacePath,
    worktreeRoot,
    exitCode: null,
    timedOut: false,
    killed: false,
    cancelled: true,
    treeTerminated: true,
    outputTail: "",
    stderrTail: "",
    gitBefore: before,
    git: before,
    commits: null,
    experimental: Boolean(spec.experimental),
  };
}

function lockDeadlineDelegation({
  backend,
  workspacePath,
  worktreeRoot,
  spec,
  error = "delegation timed out while waiting for the workspace lock; the worker never started",
}) {
  return {
    ok: false,
    error,
    backend,
    workspacePath,
    worktreeRoot,
    exitCode: null,
    timedOut: true,
    killed: false,
    cancelled: false,
    treeTerminated: true,
    outputTail: "",
    stderrTail: "",
    gitBefore: null,
    git: null,
    commits: null,
    experimental: Boolean(spec.experimental),
  };
}

function quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, sharedQuarantine = null) {
  return {
    ok: false,
    error: "this workspace is quarantined because a previous worker or repository helper process tree could not be confirmed terminated; inspect leftover processes, then rename the reported quarantine file with the .recovery-approved suffix",
    backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
    treeTerminated: false, outputTail: "", stderrTail: "",
    gitBefore: null, git: null, commits: null,
    quarantinePath: sharedQuarantine?.quarantinePath ?? "",
    quarantine: sharedQuarantine?.details ?? null,
    experimental: Boolean(spec.experimental),
  };
}

function cancelledWorkspaceStatus(id, { workspacePath = "", worktreeRoot = "" } = {}) {
  const out = {
    ok: false,
    error: "workspace status cancelled by client",
    cancelled: true,
    workspacePath,
    worktreeRoot,
    git: null,
  };
  return jsonRpcResult(id, {
    content: [{ type: "text", text: textResult("Workspace Status", out) }],
    structuredContent: out,
    isError: true,
  });
}

function quarantinedWorkspaceStatus(id, { workspacePath = "", worktreeRoot = "" } = {}, sharedQuarantine = null) {
  const out = {
    ok: false,
    error: "workspace status is unavailable because an earlier worker or repository helper process tree could not be confirmed terminated; after inspection, rename quarantinePath with the .recovery-approved suffix",
    cancelled: false,
    workspacePath,
    worktreeRoot,
    git: null,
    quarantinePath: sharedQuarantine?.quarantinePath ?? "",
    quarantine: sharedQuarantine?.details ?? null,
  };
  return jsonRpcResult(id, {
    content: [{ type: "text", text: textResult("Workspace Status", out) }],
    structuredContent: out,
    isError: true,
  });
}

async function delegateTask(rawArgs, cancel) {
  const hasTimeout = Boolean(rawArgs && Object.prototype.hasOwnProperty.call(rawArgs, "timeoutMs"));
  if (hasTimeout && (!Number.isInteger(rawArgs.timeoutMs) ||
      rawArgs.timeoutMs < MIN_TIMEOUT_MS || rawArgs.timeoutMs > MAX_TIMEOUT_MS)) {
    throw new InvalidArgumentsError(
      "timeoutMs must be an integer between " + String(MIN_TIMEOUT_MS) +
        " and " + String(MAX_TIMEOUT_MS) + " milliseconds",
    );
  }
  const timeoutMs = hasTimeout ? rawArgs.timeoutMs : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const backends = await loadBackends();
  if (!rawArgs || typeof rawArgs.backend !== "string" || !rawArgs.backend.trim()) {
    throw new Error("backend must be a non-empty string");
  }
  const backend = rawArgs.backend.trim();
  const spec = backends[backend];
  if (!spec || typeof spec.command !== "string") {
    throw new Error("unknown backend \"" + backend + "\"; use list_backends to see configured backends");
  }
  if (typeof rawArgs.task !== "string" || !rawArgs.task.trim()) {
    throw new Error("task must be a non-empty string");
  }
  if (!supportsReliableProcessContainment()) {
    return {
      ok: false,
      error: "delegate_task is unsupported on " + RUNTIME_PLATFORM +
        ": reliable descendant containment is available only on Windows and Linux",
      backend,
      workspacePath: typeof rawArgs.workspacePath === "string" ? rawArgs.workspacePath : "",
      worktreeRoot: "",
      exitCode: null,
      timedOut: false,
      killed: false,
      cancelled: false,
      treeTerminated: true,
      outputTail: "",
      stderrTail: "",
      gitBefore: null,
      git: null,
      commits: null,
      experimental: Boolean(spec.experimental),
    };
  }
  let backendCommand;
  try {
    backendCommand = await resolveBackendCommand(spec.command, { cancel, deadline });
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      return cancelledDelegation({ backend, workspacePath: "", worktreeRoot: "", spec });
    }
    if (error instanceof DeadlineExceededError) {
      return lockDeadlineDelegation({
        backend,
        workspacePath: "",
        worktreeRoot: "",
        spec,
        error: "delegation timed out while resolving the backend command; the worker never started",
      });
    }
    throw error;
  }
  if (!backendCommand) {
    return {
      ok: false,
      error: "backend \"" + backend + "\" command was not found or is not executable",
      backend,
      workspacePath: typeof rawArgs.workspacePath === "string" ? rawArgs.workspacePath : "",
      worktreeRoot: "",
      exitCode: null,
      timedOut: false,
      killed: false,
      cancelled: false,
      treeTerminated: true,
      outputTail: "",
      stderrTail: "",
      gitBefore: null,
      git: null,
      commits: null,
      experimental: Boolean(spec.experimental),
    };
  }
  let workspacePath = "";
  let worktreeRoot = "";
  let gitCommonDir = "";
  let lockStoreRoot = "";
  let quarantineRoot = "";
  let repositoryAccess = null;
  try {
    if (cancel?.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    workspacePath = await validateWorkspace(rawArgs.workspacePath, { cancel, deadline });
    if (Date.now() >= deadline) throw new DeadlineExceededError("delegation deadline exceeded");
    await requireGitRepo(workspacePath, { cancel, deadline });
    worktreeRoot = await gitWorktreeRoot(workspacePath, { cancel, deadline });
    gitCommonDir = await gitCommonDirectory(workspacePath, { cancel, deadline });
    repositoryAccess = await openRepositoryAccess(gitCommonDir, { cancel, deadline });
    const lockStore = await ensureWorkspaceLockStore(repositoryAccess.commonDir, { cancel, deadline });
    lockStoreRoot = lockStore.root;
    quarantineRoot = lockStore.quarantineRoot;
    repositoryAccess.key = repositoryLockKey(gitCommonDir, lockStore.repositoryId);
  } catch (error) {
    await repositoryAccess?.close().catch(() => {});
    if (error instanceof OperationCancelledError) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    if (error instanceof DeadlineExceededError) {
      return lockDeadlineDelegation({
        backend,
        workspacePath,
        worktreeRoot,
        spec,
        error: "delegation timed out while identifying the Git worktree; the worker never started",
      });
    }
    throw error;
  }
  const lockKey = repositoryAccess.key;
  try {
    const existingQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
    if (quarantinedWorkspaces.has(lockKey) || existingQuarantine) {
      return quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, existingQuarantine);
    }
    let observedQuarantine = null;
    return await withWorkspaceLock(lockKey, lockStoreRoot, async (workspaceLease) => {
    const sharedQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
    if (quarantinedWorkspaces.has(lockKey) || sharedQuarantine) {
      return quarantinedDelegation({ backend, workspacePath, worktreeRoot, spec }, sharedQuarantine);
    }
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
    }
    let gitProcessQuarantine = null;
    const quarantineGitProcessTree = async ({ label, terminationError }) => {
      gitProcessQuarantine ??= await quarantineLeaseForProcessTree({
        quarantineRoot,
        lockKey,
        workspaceLease,
        backend: label,
        workspacePath,
        worktreeRoot,
        terminationError,
      });
      return gitProcessQuarantine;
    };
    const allowDirty = rawArgs.allowDirty === true;
    // Attribution window for concurrency disclosure: everything between the
    // before-snapshot and the after-snapshot.
    const attributionWindowStart = Date.now();
    let before;
    try {
      before = await gitSnapshot(worktreeRoot, {
        cancel, deadline, ownLockRef: workspaceLease.ref, lockStoreRoot,
        onUnconfirmedProcessTree: quarantineGitProcessTree,
      });
    } catch (error) {
      if (error instanceof GitProcessTreeUnconfirmedError) {
        return quarantinedDelegation(
          { backend, workspacePath, worktreeRoot, spec }, error.quarantine,
        );
      }
      if (error instanceof OperationCancelledError) {
        return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec });
      }
      if (error instanceof DeadlineExceededError) {
        return {
          ok: false,
          error: "delegation timed out during the preflight git snapshot; the worker never started",
          backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
          treeTerminated: true, outputTail: "", stderrTail: "",
          gitBefore: null, git: null, commits: null,
          experimental: Boolean(spec.experimental),
        };
      }
      throw error;
    }
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }
    if (!allowDirty && before.statusShort) {
      return {
        ok: false,
        error: "working tree is dirty; review current changes first or set allowDirty=true deliberately",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: true,
        outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }

    let template;
    const resumeRequested = typeof rawArgs.resumeSessionId === "string" && rawArgs.resumeSessionId.trim();
    if (resumeRequested && !Array.isArray(spec.resumeArgs)) {
      return {
        ok: false,
        error: "backend \"" + backend + "\" does not support resuming sessions",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: true, outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    if (resumeRequested) {
      template = spec.resumeArgs;
    } else if (Array.isArray(spec.buildArgs)) {
      template = spec.buildArgs;
    } else {
      return {
        ok: false,
        error: "backend \"" + backend + "\" has no command template configured",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: false, killed: false, cancelled: false,
        treeTerminated: true,
        outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }

    const args = substituteArgs(template, rawArgs.task.trim(), rawArgs.resumeSessionId ?? "");

    // Cancellation can arrive while this request waits for the mutex or while
    // the read-only preflight snapshot runs. Never spawn after that signal.
    if (cancel && cancel.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }

    // The lease state update shares the request's cancellation/deadline so a
    // hung reference-transaction hook cannot pin the request here.
    try {
      await workspaceLease.markWorkerStarting({ cancel, deadline });
    } catch (error) {
      if (error instanceof WorkspaceLockCancelledError) {
        return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
      }
      if (error instanceof WorkspaceLockDeadlineError) {
        return {
          ok: false,
          error: "delegation timed out after preflight; the worker never started",
          backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
          treeTerminated: true, outputTail: "", stderrTail: "",
          gitBefore: before, git: before, commits: null,
          experimental: Boolean(spec.experimental),
        };
      }
      throw error;
    }
    let remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        ok: false,
        error: "delegation timed out after preflight; the worker never started",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
        treeTerminated: true, outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    // Keep this check immediately adjacent to the backend launch. The request
    // may have been cancelled during preflight or argument preparation.
    if (cancel?.cancelled) {
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }
    let workerController = null;
    let workerFinished = false;
    let ownershipLostError = null;
    let ownershipTermination = Promise.resolve();
    let ownershipTerminationStarted = false;
    let ownershipTerminationError = null;
    const recordOwnershipLoss = (error) => {
      ownershipLostError ??= error;
      if (workerController && !workerFinished && !ownershipTerminationStarted) {
        ownershipTerminationStarted = true;
        ownershipTermination = workerController.terminate("workspace-lock-lost").catch((terminationError) => {
          ownershipTerminationError ??= terminationError;
        });
      }
      return ownershipTermination;
    };
    void workspaceLease.lost.then(recordOwnershipLoss).catch((error) => {
      ownershipLostError ??= error;
    });
    let workerLockUpdate = Promise.resolve();
    let gitProvenance;
    try {
      gitProvenance = await createBackendGitProvenance(process.env, { cancel, deadline });
    } catch (error) {
      if (error instanceof OperationCancelledError) {
        return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
      }
      if (error instanceof DeadlineExceededError) {
        return {
          ok: false,
          error: "delegation timed out while preparing Git provenance; the worker never started",
          backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
          treeTerminated: true, outputTail: "", stderrTail: "",
          gitBefore: before, git: before, commits: null,
          experimental: Boolean(spec.experimental),
        };
      }
      throw error;
    }
    remaining = deadline - Date.now();
    if (cancel?.cancelled) {
      await cleanupBackendGitProvenance(gitProvenance);
      return cancelledDelegation({ backend, workspacePath, worktreeRoot, spec, before });
    }
    if (remaining <= 0) {
      await cleanupBackendGitProvenance(gitProvenance);
      return {
        ok: false,
        error: "delegation timed out after preflight; the worker never started",
        backend, workspacePath, worktreeRoot, exitCode: null, timedOut: true, killed: false, cancelled: false,
        treeTerminated: true, outputTail: "", stderrTail: "",
        gitBefore: before, git: before, commits: null,
        experimental: Boolean(spec.experimental),
      };
    }
    let fetchProvenanceTips = { uncertain: false, sawFetch: false };
    let result;
    let workerRunFailed = false;
    let workerRunError = null;
    try {
      result = await runCommand(backendCommand, args, {
        cwd: workspacePath,
        // Git's private per-run Trace2 stream detects target-repository
        // fetch/pull commands without trusting the overwritable FETCH_HEAD.
        env: gitProvenance.env,
        timeoutMs: remaining,
        manageProcessTree: true,
        shouldCancel: () => Boolean(cancel && cancel.cancelled),
        onChild: (controller) => {
          workerController = controller;
          if (cancel) cancel.controller = controller;
          if (ownershipLostError) void recordOwnershipLoss(ownershipLostError);
          workerLockUpdate = workspaceLease.markWorkerRunning(controller.child.pid, { cancel, deadline })
            .catch((error) => {
              // Interruption of the state update is expected during cancellation
              // or timeout: the worker lifecycle itself is managed by terminate().
              if (error instanceof WorkspaceLockCancelledError ||
                  error instanceof WorkspaceLockDeadlineError) {
                return;
              }
              return recordOwnershipLoss(error);
            });
        },
      });
    } catch (error) {
      workerRunFailed = true;
      workerRunError = error;
    } finally {
      // Once runCommand settles it has completed tree cleanup. Clear the
      // numeric-PID controller before any later I/O can fail or yield.
      workerFinished = true;
      if (cancel?.controller === workerController) cancel.controller = null;
      workerController = null;
    }
    if (workerRunFailed) {
      await cleanupBackendGitProvenance(gitProvenance);
      throw workerRunError;
    }
    let quarantinePath = "";
    try {
      // The controller is already cleared above; only the ref-state update may
      // still be settling here. Quarantine an unconfirmed tree before touching
      // its trace, which a surviving descendant may still be writing.
      await workerLockUpdate;
      if (!result.treeTerminated) {
        quarantinedWorkspaces.add(lockKey);
        workspaceLease.retain();
        const quarantineId = randomUUID();
        await workspaceLease.markWorkerQuarantinePending(quarantineId);
        // The pending CAS above makes a crash during marker publication
        // unreclaimable. Only a complete, atomically published record advances
        // the lease to the operator-recoverable quarantined state.
        const quarantine = await markWorkspaceQuarantined(quarantineRoot, lockKey, {
          backend,
          workspacePath,
          worktreeRoot,
          lockRef: workspaceLease.ref,
          terminationError: result.terminationError,
        }, quarantineId);
        quarantinePath = quarantine.quarantinePath;
        await workspaceLease.markWorkerQuarantined(quarantine.quarantineId);
        // The shared marker is now authoritative and can be explicitly renamed
        // by an operator after inspection; retain the local fallback only when
        // writing that marker failed.
        quarantinedWorkspaces.delete(lockKey);
      } else if (!ownershipLostError) {
        try {
          await workspaceLease.markWorkerIdle({ cancel, deadline });
        } catch (error) {
          if (!(error instanceof WorkspaceLockCancelledError) &&
              !(error instanceof WorkspaceLockDeadlineError)) {
            await recordOwnershipLoss(error);
          }
        }
      }
      if (ownershipLostError) {
        await ownershipTermination;
        if (ownershipTerminationError && ownershipLostError.cause === undefined) {
          ownershipLostError.cause = ownershipTerminationError;
        }
        throw ownershipLostError;
      }
      if (result.treeTerminated) {
        try {
          fetchProvenanceTips = await readBackendGitProvenance(
            gitProvenance, worktreeRoot, { cancel, deadline },
          );
        } catch {
          // A malformed, truncated, or missing trace cannot justify commit
          // attribution. Preserve the completed worker result and disclose the
          // uncertainty instead of letting trace I/O bypass workspace safety.
          fetchProvenanceTips = { uncertain: true, sawFetch: false };
        }
      }
    } finally {
      // Cleanup is privacy hygiene, not a workspace-safety gate. In particular,
      // it must never replace a durable quarantine result with a released lease.
      await cleanupBackendGitProvenance(gitProvenance);
    }
    let after = null;
    let commits = null;
    let postRunDeadlineExceeded = false;
    if (result.treeTerminated) {
      try {
        after = await gitSnapshot(worktreeRoot, {
          cancel,
          deadline,
          ownLockRef: workspaceLease.ref,
          lockStoreRoot,
          concurrencyWindowStart: attributionWindowStart,
          onUnconfirmedProcessTree: quarantineGitProcessTree,
        });
        Object.defineProperty(after, FETCH_PROVENANCE_TIPS, { value: fetchProvenanceTips });
        commits = await committedDelta(worktreeRoot, before, after, { cancel, deadline });
      } catch (error) {
        if (error instanceof GitProcessTreeUnconfirmedError) {
          result.treeTerminated = false;
          result.terminationError = error.terminationError;
          quarantinePath = error.quarantine?.quarantinePath ?? "";
          after = null;
        } else if (error instanceof OperationCancelledError) {
          // The worker is already stopped; report cancellation without a
          // misleading partial snapshot assembled from interrupted Git calls.
          after = null;
        } else if (error instanceof DeadlineExceededError) {
          postRunDeadlineExceeded = true;
          after = null;
        } else {
          throw error;
        }
      }
    }
    // Linked worktrees of one repository serialize per worktree only. If any
    // other delegation held an active lease in the same repository during our
    // before/after snapshots, ref movements may include its commits: disclose
    // the overlap instead of presenting attribution as exact.
    const repositoryConcurrency = Boolean(
      (before.concurrentDelegations ?? 0) > 0 || (after?.concurrentDelegations ?? 0) > 0,
    );
    let error = "";
    if (!result.treeTerminated) {
      error = "backend or Git snapshot process tree could not be confirmed terminated; the shared workspace quarantine remains until an operator checks for leftovers and renames quarantinePath with the .recovery-approved suffix";
    } else if (cancel && cancel.cancelled) {
      error = "delegation cancelled by client; post-run snapshot may be unavailable";
    } else if (result.timedOut) {
      error = "backend \"" + backend + "\" timed out after " + timeoutMs + " ms" + (result.killed ? " and was force-killed" : "");
    } else if (postRunDeadlineExceeded) {
      error = "backend exited, but the post-run Git snapshot or commit attribution exceeded the overall deadline";
    } else if (result.orphanedProcesses) {
      error = "backend exited while descendant processes were still running; the bridge terminated the remaining process tree";
    } else if (result.errorMessage) {
      error = "backend \"" + backend + "\" failed to start: " + result.errorMessage;
    } else if (result.exitCode !== 0) {
      error = "backend \"" + backend + "\" exited with code " + String(result.exitCode);
    }

    return {
      ok: !error,
      error,
      backend,
      workspacePath,
      worktreeRoot,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      postRunDeadlineExceeded,
      killed: result.killed,
      cancelled: Boolean(cancel && cancel.cancelled),
      orphanedProcesses: result.orphanedProcesses,
      treeTerminated: result.treeTerminated,
      terminationError: result.terminationError,
      quarantinePath,
      repositoryConcurrency,
      outputTail: tail(result.stdout, RAW_TAIL_CHARS),
      stderrTail: tail(result.stderr, RAW_TAIL_CHARS),
      outputTruncated: Boolean(result.stdoutTruncated),
      stderrTruncated: Boolean(result.stderrTruncated),
      gitBefore: before,
      git: after,
      commits,
      experimental: Boolean(spec.experimental),
    };
    }, {
      cancel,
      deadline,
      onCancelled: () => cancelledDelegation({ backend, workspacePath, worktreeRoot, spec }),
      onDeadline: () => lockDeadlineDelegation({ backend, workspacePath, worktreeRoot, spec }),
      operatorRecoveryApproved: (owner) => quarantineRecoveryApproved(
        quarantineRoot, lockKey, owner,
      ),
      onAcquired: () => clearQuarantineRecoveryApproval(quarantineRoot, lockKey),
      isUnavailable: async () => {
        observedQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
        return quarantinedWorkspaces.has(lockKey) || Boolean(observedQuarantine);
      },
      onUnavailable: () => quarantinedDelegation(
        { backend, workspacePath, worktreeRoot, spec }, observedQuarantine,
      ),
    });
  } finally {
    await repositoryAccess.close().catch(() => {});
  }
}

function textResult(header, obj) {
  const lines = ["# " + header, ""];
  for (const [key, value] of Object.entries(obj)) {
    if (["outputTail", "stderrTail", "git", "gitBefore", "commits"].includes(key)) continue;
    lines.push("- " + key + ": " + String(value ?? ""));
  }
  const gitBlock = (label, git) => {
    if (!git) return;
    lines.push("", "## " + label + " git status --short", "", "~~~text", git.statusShort || "(clean)", "~~~");
    lines.push("", "## " + label + " git diff stat", "", "~~~text", git.diffStat || "(empty)", "~~~");
    lines.push("", "## " + label + " changed files", "", "~~~text", (git.changedFiles ?? []).join("\n") || "(none)", "~~~");
    lines.push("", "## " + label + " HEAD", "", "~~~text", git.head || "(unborn)", "~~~");
    lines.push("", "## " + label + " symbolic HEAD", "", "~~~text", git.headRef || "(detached/unborn)", "~~~");
  };  gitBlock("before", obj.gitBefore);
  gitBlock("after", obj.git);
  if (obj.commits) {
    if (obj.commits.refsChanged?.length) {
      lines.push("", "## refs changed by the worker", "", "~~~text",
        obj.commits.refsChanged.map((item) =>
          item.ref + " " + (item.before || "(absent)") + " -> " + (item.after || "(deleted)"),
        ).join("\n"), "~~~");
    }
    const commitsHeading = obj.repositoryConcurrency
      ? "## commits attributed to the worker (other delegations were active in this repository; attribution may overlap)"
      : "## commits made by the worker";
    lines.push("", commitsHeading, "", "~~~text", obj.commits.log || "(none)", "~~~");
    lines.push("", "## commit diff stat", "", "~~~text", obj.commits.diffStat || "(empty)", "~~~");
  }
  if (obj.repositoryConcurrency) {
    lines.push(
      "",
      "## attribution note",
      "",
      "other delegations were active in this repository during the run; commits and ref changes may overlap those workers",
    );
  }
  if (obj.outputTail) lines.push("", "## output tail", "", "~~~text", obj.outputTail, "~~~");
  if (obj.stderrTail) lines.push("", "## stderr tail", "", "~~~text", obj.stderrTail, "~~~");
  if (obj.error) lines.push("", "## error", "", obj.error);
  return lines.join("\n");
}

function jsonRpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonRpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

// In-flight cancellable tool requests, keyed by the original JSON-RPC id type,
// so notifications/cancelled can interrupt workers, lock waits, and snapshots.
const activeRequests = new Map();
let shutdownRequested = false;

function trackActiveRequest(id, cancel) {
  let resolveDone;
  const entry = { cancel, done: new Promise((resolve) => { resolveDone = resolve; }) };
  activeRequests.set(id, entry);
  return () => {
    if (activeRequests.get(id) === entry) activeRequests.delete(id);
    resolveDone();
  };
}

async function terminateActiveRequests(reason = "shutdown") {
  const entries = [...activeRequests.values()];
  const waits = [];
  for (const { cancel } of entries) {
    const controller = cancel.controller;
    cancel.cancel();
    if (controller) waits.push(controller.terminate(reason));
  }
  await Promise.allSettled(waits);
  // Let each request unwind its lock/snapshot finally blocks before the server
  // exits, avoiding an unnecessary stale cross-process lock after clean shutdown.
  await Promise.allSettled(entries.map((entry) => entry.done));
  // An interrupted provenance setup may have a native filesystem operation
  // completing after its request returns. Give its known-root cleanup a short,
  // bounded shutdown window without letting a stalled filesystem pin exit.
  if (backgroundFinalizers.size > 0) {
    let timer = null;
    try {
      await Promise.race([
        Promise.allSettled([...backgroundFinalizers]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, TRACE_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

function installShutdownHandlers(stdin, stdout = process.stdout) {
  const shutdown = (exitCode) => {
    if (shutdownRequested) return;
    // Close the dispatch gate before snapshotting activeRequests. Otherwise a
    // request arriving while termination is in progress would not be included
    // in the awaited snapshot and process.exit could skip its lease cleanup.
    shutdownRequested = true;
    stdin.pause?.();
    void terminateActiveRequests().finally(() => process.exit(exitCode));
  };
  process.once("SIGTERM", () => shutdown(0));
  process.once("SIGINT", () => shutdown(130));
  stdin.once("end", () => shutdown(0));
  stdin.once("close", () => shutdown(0));
  // A disconnected MCP host turns the next response write into EPIPE. Treat
  // that as the same awaited shutdown as stdin closure so active workers are
  // terminated and their lease finalizers finish before this process exits.
  stdout.once("error", () => shutdown(1));
  // Last-chance best effort. On POSIX, controller.terminate signals the
  // detached process group synchronously before its first await.
  process.once("exit", () => {
    for (const { cancel } of activeRequests.values()) cancel.cancel();
  });
}

async function handleMessage(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (message.method === "notifications/cancelled") {
    const requestId = message.params?.requestId ?? message.params?.id;
    const entry = activeRequests.get(requestId);
    if (entry && entry.cancel) {
      entry.cancel.cancel();
    }
    return null;
  }
  if (message.id === undefined) return null; // other notification

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(message.id, {
          // Negotiate honestly: this server implements exactly one protocol
          // version, so it always reports that version rather than echoing an
          // unsupported client request.
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, title: "CLI Agent Bridge", version: SERVER_VERSION },
          instructions:
            "Delegate coding tasks to locally installed coding CLIs. Prefer workspace_status first, then delegate_task, then review the returned git snapshot. Never put credentials in task text.",
        });
      case "ping":
        return jsonRpcResult(message.id, {});
      case "tools/list":
        return jsonRpcResult(message.id, { tools: TOOLS });
      case "tools/call": {
        const params = message.params ?? {};
        if (typeof params.name !== "string") return jsonRpcError(message.id, -32602, "tools/call requires params.name");
        const args = params.arguments ?? {};
        if (params.name === "list_backends") {
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          try {
            const entries = await listBackends(cancel);
            const lines = ["# Delegation Backends", ""];
            for (const e of entries) {
              lines.push("- " + e.name + " (" + e.label + "): " + (e.available ? "available" : "unavailable") + (e.experimental ? " [experimental]" : ""));
              if (e.version) lines.push("  version: " + e.version);
              if (e.error) lines.push("  error: " + e.error);
              if (e.notes) lines.push("  note: " + e.notes);
            }
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: lines.join("\n") }],
              structuredContent: { backends: entries },
            });
          } finally {
            finishRequest();
          }
        }
        if (params.name === "workspace_status") {
          if (!supportsReliableProcessContainment()) {
            const out = {
              ok: false,
              error: "workspace_status is unsupported on " + RUNTIME_PLATFORM +
                ": reliable Git helper containment is available only on Windows and Linux",
              cancelled: false,
              workspacePath: typeof args.workspacePath === "string" ? args.workspacePath : "",
              worktreeRoot: "",
              git: null,
            };
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: textResult("Workspace Status", out) }],
              structuredContent: out,
              isError: true,
            });
          }
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          let workspacePath = "";
          let worktreeRoot = "";
          let gitCommonDir = "";
          let lockStoreRoot = "";
          let quarantineRoot = "";
          let repositoryAccess = null;
          try {
            workspacePath = await validateWorkspace(args.workspacePath, { cancel });
            if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath });
            try {
              await requireGitRepo(workspacePath, { cancel });
              if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath });
              worktreeRoot = await gitWorktreeRoot(workspacePath, { cancel });
              gitCommonDir = await gitCommonDirectory(workspacePath, { cancel });
              repositoryAccess = await openRepositoryAccess(gitCommonDir, { cancel });
              const lockStore = await ensureWorkspaceLockStore(repositoryAccess.commonDir, { cancel });
              lockStoreRoot = lockStore.root;
              quarantineRoot = lockStore.quarantineRoot;
              repositoryAccess.key = repositoryLockKey(gitCommonDir, lockStore.repositoryId);
            } catch (error) {
              if (error instanceof OperationCancelledError) {
                return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
              }
              throw error;
            }
            if (cancel.cancelled) return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
            const lockKey = repositoryAccess.key;
            const existingQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
            if (quarantinedWorkspaces.has(lockKey) || existingQuarantine) {
              return quarantinedWorkspaceStatus(
                message.id, { workspacePath, worktreeRoot }, existingQuarantine,
              );
            }
            let observedQuarantine = null;
            return await withWorkspaceLock(lockKey, lockStoreRoot, async (workspaceLease) => {
              const sharedQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
              if (quarantinedWorkspaces.has(lockKey) || sharedQuarantine) {
                return quarantinedWorkspaceStatus(
                  message.id, { workspacePath, worktreeRoot }, sharedQuarantine,
                );
              }
              let gitProcessQuarantine = null;
              const quarantineGitProcessTree = async ({ label, terminationError }) => {
                gitProcessQuarantine ??= await quarantineLeaseForProcessTree({
                  quarantineRoot,
                  lockKey,
                  workspaceLease,
                  backend: label,
                  workspacePath,
                  worktreeRoot,
                  terminationError,
                });
                return gitProcessQuarantine;
              };
              try {
                const git = await gitSnapshot(worktreeRoot, {
                  cancel, ownLockRef: workspaceLease.ref, lockStoreRoot,
                  onUnconfirmedProcessTree: quarantineGitProcessTree,
                });
                if (cancel.cancelled) {
                  return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
                }
                return jsonRpcResult(message.id, {
                  content: [{ type: "text", text: textResult("Workspace Status", { workspacePath, worktreeRoot, git }) }],
                  structuredContent: { ok: true, workspacePath, worktreeRoot, git },
                });
              } catch (error) {
                if (error instanceof GitProcessTreeUnconfirmedError) {
                  return quarantinedWorkspaceStatus(
                    message.id, { workspacePath, worktreeRoot }, error.quarantine,
                  );
                }
                if (error instanceof OperationCancelledError) {
                  return cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot });
                }
                throw error;
              }
            }, {
              cancel,
              onCancelled: () => cancelledWorkspaceStatus(message.id, { workspacePath, worktreeRoot }),
              operatorRecoveryApproved: (owner) => quarantineRecoveryApproved(
                quarantineRoot, lockKey, owner,
              ),
              onAcquired: () => clearQuarantineRecoveryApproval(quarantineRoot, lockKey),
              isUnavailable: async () => {
                observedQuarantine = await readWorkspaceQuarantine(quarantineRoot, lockKey);
                return quarantinedWorkspaces.has(lockKey) || Boolean(observedQuarantine);
              },
              onUnavailable: () => quarantinedWorkspaceStatus(
                message.id, { workspacePath, worktreeRoot }, observedQuarantine,
              ),
            });
          } finally {
            await repositoryAccess?.close().catch(() => {});
            finishRequest();
          }
        }
        if (params.name === "delegate_task") {
          const cancel = createCancellation();
          const finishRequest = trackActiveRequest(message.id, cancel);
          try {
            const out = await delegateTask(args, cancel);
            return jsonRpcResult(message.id, {
              content: [{ type: "text", text: textResult("Delegated Task Result", out) }],
              structuredContent: out,
              isError: !out.ok,
            });
          } finally {
            finishRequest();
          }
        }
        return jsonRpcError(message.id, -32602, "Unknown tool: " + params.name);
      }
      default:
        return jsonRpcError(message.id, -32601, "Method not found: " + String(message.method));
    }
  } catch (error) {
    return jsonRpcError(
      message.id,
      error instanceof InvalidArgumentsError ? -32602 : -32603,
      error.message,
    );
  }
}

function startStdioServer({ stdin = process.stdin, stdout = process.stdout } = {}) {
  stdin.setEncoding("utf8");
  let buffer = "";
  stdin.on("data", (chunk) => {
    if (shutdownRequested) return;
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      if (shutdownRequested) {
        buffer = "";
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        stdout.write(JSON.stringify(jsonRpcError(null, -32700, "Parse error")) + "\n");
        continue;
      }
      handleMessage(message).then((response) => {
        if (response) stdout.write(JSON.stringify(response) + "\n");
      }).catch((error) => {
        stdout.write(JSON.stringify(jsonRpcError(null, -32603, error.message)) + "\n");
      });
    }
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  startStdioServer();
  installShutdownHandlers(process.stdin, process.stdout);
}
