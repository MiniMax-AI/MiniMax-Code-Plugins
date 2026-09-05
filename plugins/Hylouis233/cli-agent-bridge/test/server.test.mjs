// Self-contained tests for the cli-agent-bridge stdio MCP server.
// Run with: node --test test/server.test.mjs
// No network access is required: the delegation test uses a fake slow backend.
//
// Every test drives its server through withServer(), which always stops the
// child process - a leaked server holds stdin/stdout pipes and would keep the
// node --test runner from ever exiting when an assertion fails.

import { after, before, test } from "node:test";
import { acquireCliAgentBridgeTestLock } from "../tests/plugin-test-lock.mjs";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let releasePluginTestLock = async () => {};
before(async () => {
  releasePluginTestLock = await acquireCliAgentBridgeTestLock();
});
after(async () => {
  await releasePluginTestLock();
});


const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [server], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      CLI_AGENT_BRIDGE_TEST_PROCESS_TREE_MODE: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  const rpc = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  const stop = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  return { child, rpc, notify, stop };
}

async function withServer(extraEnv, fn) {
  const s = startServer(extraEnv);
  try {
    await s.rpc(1, "initialize", {});
    return await fn(s);
  } finally {
    s.stop(); // always released, even when an assertion throws
  }
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-test-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
  execSync("git config user.email test@example.com", { cwd: dir });
  writeFileSync(path.join(dir, "hello.txt"), "hello");
  execSync("git add hello.txt && git commit -q -m init", { cwd: dir });
  return dir;
}

function writeBackends(name, backends) {
  const cfg = path.join(tmpdir(), name);
  writeFileSync(cfg, JSON.stringify({ backends }));
  return { CLI_AGENT_BRIDGE_BACKENDS: cfg };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("initialize negotiates only the supported protocol version", async () => {
  const s = startServer();
  const init = await s.rpc(1, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "cli-agent-bridge");
  s.stop();
});

test("tools/list exposes the three bridge tools", async () => {
  await withServer({}, async (s) => {
    const list = await s.rpc(2, "tools/list");
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["delegate_task", "list_backends", "workspace_status"]);
    const delegate = list.result.tools.find((t) => t.name === "delegate_task");
    assert.equal(delegate.annotations.destructiveHint, true);
    const status = list.result.tools.find((t) => t.name === "workspace_status");
    assert.equal(status.annotations.readOnlyHint, false);
    assert.equal(status.annotations.idempotentHint, false);
  });
});

test("workspace_status reports changed files including untracked ones", async () => {
  await withServer({}, async (s) => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "new-file.txt"), "new");
    const res = await s.rpc(2, "tools/call", { name: "workspace_status", arguments: { workspacePath: repo } });
    assert.equal(res.result.structuredContent.ok, true);
    assert.ok(res.result.structuredContent.git.changedFiles.includes("new-file.txt"));
  });
});

test("delegate_task refuses a dirty tree without allowDirty and sets isError", async () => {
  const env = writeBackends("bridge-dirty-backends.json", {
    fake: { command: process.execPath, buildArgs: ["-e", "", "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "dirty.txt"), "dirty");
    const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "fake", task: "x", workspacePath: repo } });
    assert.equal(res.result.structuredContent.ok, false);
    assert.equal(res.result.isError, true);
    assert.match(res.result.structuredContent.error, /dirty/);
  });
});

test("delegate_task rejects unknown backends", async () => {
  await withServer({}, async (s) => {
    const repo = makeRepo();
    const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "nope", task: "x", workspacePath: repo } });
    assert.match(res.error.message, /unknown backend/);
  });
});

test("notifications/cancelled terminates an in-flight worker", async () => {
  const env = writeBackends("bridge-slow-backends.json", {
    slow: { command: "node", buildArgs: ["-e", "setTimeout(()=>{},120000)", "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const repo = makeRepo();
    const start = Date.now();
    const promise = s.rpc(7, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "do nothing", workspacePath: repo, timeoutMs: 60_000 } });
    setTimeout(() => s.notify("notifications/cancelled", { requestId: 7 }), 500);
    const res = await promise;
    const elapsed = Date.now() - start;
    assert.equal(res.result.structuredContent.cancelled, true);
    assert.equal(res.result.isError, true);
    assert.ok(elapsed < 10_000, "cancellation must settle well before the 60s backend timeout");
  });
});

test("delegate_task returns before and after snapshots and committed deltas", async () => {
  const env = writeBackends("bridge-fake-backends.json", {
    fake: { command: "node", buildArgs: ["-e", "require('node:fs').appendFileSync('marker.txt','ok')", "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const repo = makeRepo();
    const res = await s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "fake", task: "make a marker", workspacePath: repo } });
    const out = res.result.structuredContent;
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.ok(out.gitBefore && out.git, "before and after snapshots must both be present");
    assert.ok(out.git.changedFiles.includes("marker.txt"));
    assert.equal(out.commits, null, "internal lease heartbeats must not appear as committed changes");
    assert.ok(Object.keys(out.gitBefore.refs).every((ref) =>
      !ref.startsWith("refs/cli-agent-bridge/workspace-locks/")));
    assert.ok(Object.keys(out.git.refs).every((ref) =>
      !ref.startsWith("refs/cli-agent-bridge/workspace-locks/")));
  });
});

test("locks are keyed by the worktree root, so subdir paths serialize with the root", async () => {
  // Each run appends "start", waits, appends "end" to an absolute-path log.
  // If the root path and a subdirectory path shared no lock, the log would
  // read start,start,end,end instead of strictly alternating.
  const repo = makeRepo();
  const sub = path.join(repo, "nested", "deep");
  mkdirSync(sub, { recursive: true });
  const logFile = path.join(repo, "order.log").replace(/\\/g, "/");
  const script = `const fs=require('node:fs');` +
    `fs.appendFileSync(${JSON.stringify(logFile)},'start\\n');` +
    `setTimeout(()=>{fs.appendFileSync(${JSON.stringify(logFile)},'end\\n')},700);`;
  const env = writeBackends("bridge-order-backends.json", {
    orderer: { command: "node", buildArgs: ["-e", script, "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const first = s.rpc(2, "tools/call", { name: "delegate_task", arguments: { backend: "orderer", task: "x", workspacePath: repo, timeoutMs: 60_000 } });
    // Let the first request deterministically acquire the lock and start its
    // worker before sending the second, which runs from a subdirectory.
    await sleep(600);
    // The queued follow-up must accept the tree the first run leaves dirty
    // (order.log is untracked); allowDirty=false would refuse it.
    const second = s.rpc(3, "tools/call", { name: "delegate_task", arguments: { backend: "orderer", task: "x", workspacePath: sub, allowDirty: true, timeoutMs: 60_000 } });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.result.structuredContent.ok, true, JSON.stringify(r1.result?.structuredContent?.error ?? r1.error));
    assert.equal(r2.result.structuredContent.ok, true, JSON.stringify(r2.result?.structuredContent?.error ?? r2.error));
    const log = readFileSync(path.join(repo, "order.log"), "utf8").trim().split(/\r?\n/);
    assert.deepEqual(log, ["start", "end", "start", "end"], "root and subdir delegations must serialize: " + log.join(","));
  });
});

test("a delegation cancelled while queued for the lock never starts its worker", async () => {
  const env = writeBackends("bridge-queue-cancel.json", {
    slow: { command: "node", buildArgs: ["-e", "setTimeout(()=>{},4000)", "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const repo = makeRepo();
    const first = s.rpc(10, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "hold the lock", workspacePath: repo, timeoutMs: 60_000 } });
    // Let the first request actually acquire the lock and start its worker
    // before sending the second, so the second is deterministically queued.
    await sleep(600);
    const second = s.rpc(11, "tools/call", { name: "delegate_task", arguments: { backend: "slow", task: "queued", workspacePath: repo, timeoutMs: 60_000 } });
    await sleep(600); // second request is now queued behind the lock
    s.notify("notifications/cancelled", { requestId: 11 });
    const [r1, r2] = await Promise.all([first, second]);
    assert.equal(r1.result.structuredContent.ok, true);
    assert.equal(r2.result.structuredContent.cancelled, true);
    assert.match(r2.result.structuredContent.error, /cancelled.*worker.*started/iu);
    assert.equal(r2.result.structuredContent.exitCode, null, "the cancelled worker must never have started");
    assert.equal(readFileSync(path.join(repo, "hello.txt"), "utf8"), "hello", "workspace untouched");
  });
});

test("repositories with an unborn HEAD (no commits yet) are supported", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-unborn-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.name test && git config user.email test@example.com", { cwd: dir });
  const env = writeBackends("bridge-unborn-backends.json", {
    fake: { command: "node", buildArgs: ["-e", "require('node:fs').writeFileSync('first.txt','ok')", "<task>"], experimental: true },
  });
  await withServer(env, async (s) => {
    const status = await s.rpc(2, "tools/call", { name: "workspace_status", arguments: { workspacePath: dir } });
    assert.equal(status.result.structuredContent.ok, true, JSON.stringify(status.error ?? ""));
    const res = await s.rpc(3, "tools/call", { name: "delegate_task", arguments: { backend: "fake", task: "first file", workspacePath: dir, timeoutMs: 30_000 } });
    const out = res.result.structuredContent;
    assert.equal(out.ok, true, JSON.stringify(out.error));
    assert.equal(out.gitBefore.head, "");
    assert.ok(out.git.changedFiles.includes("first.txt"));
  });
});

test("codex templates delimit the prompt from CLI options with --", () => {
  const backends = JSON.parse(readFileSync(path.join(path.dirname(server), "backends.json"), "utf8")).backends;
  assert.deepEqual(backends.codex.buildArgs, ["exec", "--", "<task>"]);
  assert.deepEqual(backends.codex.resumeArgs, ["exec", "resume", "<session>", "--", "<task>"]);
});
