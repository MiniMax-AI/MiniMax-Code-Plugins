#!/usr/bin/env node

import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ownPath = fileURLToPath(import.meta.url);
const spec = JSON.parse(process.argv[2] ?? "{}");

if (spec.ignoreSigterm === true && process.platform !== "win32") {
  process.on("SIGTERM", () => {});
}

function event(name) {
  if (!spec.eventFile) return;
  appendFileSync(spec.eventFile, JSON.stringify({ event: name, name: spec.name ?? "", pid: process.pid }) + "\n");
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (spec.branchRoundTrip) {
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-b", spec.branchName ?? "worker-branch"]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "branch-work.txt"), spec.contents ?? "branch commit\n");
  execFileSync("git", ["add", spec.writeFile ?? "branch-work.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker branch commit"]);
  execFileSync("git", ["checkout", original]);
  event("end");
} else if (spec.checkoutExisting) {
  // Merely check out a pre-existing divergent branch; no commits are created.
  event("start");
  execFileSync("git", ["checkout", spec.branchName]);
  event("end");
} else if (spec.commitCurrent) {
  // Commit on the currently checked-out branch: HEAD and its branch ref move together.
  event("start");
  if (spec.environmentFile) {
    writeFileSync(spec.environmentFile, JSON.stringify({
      GIT_DIR: process.env.GIT_DIR ?? null,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE ?? null,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE ?? null,
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES ?? null,
      GIT_NO_REPLACE_OBJECTS: process.env.GIT_NO_REPLACE_OBJECTS ?? null,
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? null,
      GH_TOKEN: process.env.GH_TOKEN ?? null,
    }));
  }
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "current.txt"), spec.contents ?? "current\n");
  execFileSync("git", ["add", spec.writeFile ?? "current.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker commit on current branch"]);
  if (spec.refName) {
    const oid = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", spec.refName, oid]);
  }
  event("end");
} else if (spec.fetchAndCommit) {
  // Simulate a fetch that adds external history, followed by one local worker
  // commit based on the fetched tip.
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", "-b", "fixture-upstream"]);
  writeFileSync(path.resolve(process.cwd(), "upstream.txt"), "external upstream history\n");
  execFileSync("git", ["add", "upstream.txt"]);
  execFileSync("git", ["commit", "-m", "fetched upstream commit"]);
  const upstreamOid = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", original]);
  execFileSync("git", ["branch", "-D", "fixture-upstream"]);
  if (spec.fetchTagOnly) {
    execFileSync("git", ["update-ref", "refs/tags/fetched-tag", upstreamOid]);
  } else if (spec.fetchPrefetch) {
    execFileSync("git", ["update-ref", "refs/prefetch/remotes/origin/main", upstreamOid]);
  } else {
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", upstreamOid]);
  }
  execFileSync("git", ["checkout", "-b", spec.branchName ?? "fetched-work", upstreamOid]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "worker-after-fetch.txt"), "worker\n");
  execFileSync("git", ["add", spec.writeFile ?? "worker-after-fetch.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker commit after fetch"]);
  execFileSync("git", ["checkout", original]);
  event("end");
} else if (spec.fetchIntoLocalRef) {
  // Exercise fetch's arbitrary destination refspec. FETCH_HEAD, rather than
  // the refs/heads destination namespace, is the provenance signal.
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  const importedRef = spec.importedRef ?? "refs/heads/imported-upstream";
  execFileSync("git", [
    "fetch", spec.remotePath, "refs/heads/topic:" + importedRef,
  ]);
  execFileSync("git", ["checkout", "-b", spec.branchName ?? "local-fetch-work", importedRef]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "worker-after-local-fetch.txt"), "worker\n");
  execFileSync("git", ["add", spec.writeFile ?? "worker-after-local-fetch.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker commit after local-ref fetch"]);
  execFileSync("git", ["checkout", original]);
  event("end");
} else if (spec.pullNoRebase) {
  event("start");
  execFileSync("git", ["pull", "--no-rebase", "--no-edit", spec.remotePath, "topic"]);
  event("end");
} else if (spec.fetchOtherRepositoryThenCommit) {
  event("start");
  execFileSync("git", ["-C", spec.otherRepository, "fetch", spec.remotePath, "refs/heads/topic"]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile), "target work\n");
  execFileSync("git", ["add", spec.writeFile]);
  execFileSync("git", ["commit", "-m", spec.commitMessage]);
  event("end");
} else if (spec.fetchOnlyThenWrite) {
  event("start");
  execFileSync("git", ["fetch", spec.remotePath, "refs/heads/topic"]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile), "worktree-only change\n");
  event("end");
} else if (spec.writeConcurrencyHistory) {
  event("start");
  const record = JSON.stringify({
    version: 1,
    acquiredAt: spec.acquiredAt,
    endedAt: spec.endedAt,
    hostIdentity: "fixture:clock-skewed-host",
  }) + "\n";
  const oid = execFileSync(
    "git", ["hash-object", "-w", "--stdin"],
    { cwd: spec.historyStore, input: record, encoding: "utf8" },
  ).trim();
  execFileSync("git", ["update-ref", spec.historyRef, oid], { cwd: spec.historyStore });
  if (spec.writeFile) {
    writeFileSync(path.resolve(process.cwd(), spec.writeFile), "clock-independent overlap\n");
  }
  event("end");
} else if (spec.corruptTraceThenWrite) {
  event("start");
  appendFileSync(process.env.GIT_TRACE2_EVENT, "{malformed-trace2-event\n");
  writeFileSync(path.resolve(process.cwd(), spec.writeFile), "trace fallback worktree change\n");
  event("end");
} else if (spec.replaceTraceThenWrite) {
  event("start");
  const tracePath = process.env.GIT_TRACE2_EVENT;
  if (spec.traceRootFile) writeFileSync(spec.traceRootFile, path.dirname(tracePath));
  unlinkSync(tracePath);
  writeFileSync(tracePath, "");
  writeFileSync(path.resolve(process.cwd(), spec.writeFile), "replacement trace worktree change\n");
  event("end");
} else if (spec.writeBeforeDelay) {
  event("start");
  writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? "written before cancellation\n");
  event("written");
  await delay(spec.delayMs ?? 60_000);
  event("end");
} else if (spec.mirrorPush) {
  event("start");
  execFileSync("git", ["push", "--mirror", spec.remotePath]);
  event("end");
} else if (spec.newBranchFromExisting) {
  // Fork a new branch from a pre-existing divergent branch, commit, and return.
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", spec.fromBranch]);
  execFileSync("git", ["checkout", "-b", spec.branchName ?? "forked-work"]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "fork.txt"), spec.contents ?? "fork\n");
  execFileSync("git", ["add", spec.writeFile ?? "fork.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker fork commit"]);
  execFileSync("git", ["checkout", original]);
  event("end");
} else if (spec.blobTag) {
  // Create a legal ref that points at a blob, not a commit.
  event("start");
  const oid = execFileSync(
    "git",
    ["hash-object", "-w", "--stdin"],
    { input: "blob payload\n", encoding: "utf8" },
  ).trim();
  execFileSync("git", ["update-ref", spec.refName ?? "refs/tags/blobtag", oid]);
  event("end");
} else if (spec.moveBlobRefToCommit) {
  // Move a pre-existing non-commit ref to a commit created during this run,
  // without leaving another changed branch ref that could mask attribution.
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  const temporaryBranch = spec.branchName ?? "temporary-ref-commit";
  execFileSync("git", ["checkout", "-b", temporaryBranch]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "ref-commit.txt"), "ref commit\n");
  execFileSync("git", ["add", spec.writeFile ?? "ref-commit.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "commit behind moved ref"]);
  const oid = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", original]);
  execFileSync("git", ["branch", "-D", temporaryBranch]);
  execFileSync("git", ["update-ref", spec.refName, oid]);
  event("end");
} else if (spec.forceRefFromExisting) {
  // Force-move an existing ref onto a different pre-existing lineage, then
  // add exactly one worker commit without leaving a temporary branch behind.
  event("start");
  const original = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
  const temporaryBranch = spec.temporaryBranch ?? "temporary-force-ref";
  execFileSync("git", ["checkout", spec.fromBranch]);
  execFileSync("git", ["checkout", "-b", temporaryBranch]);
  writeFileSync(path.resolve(process.cwd(), spec.writeFile ?? "forced-ref.txt"), "worker\n");
  execFileSync("git", ["add", spec.writeFile ?? "forced-ref.txt"]);
  execFileSync("git", ["commit", "-m", spec.commitMessage ?? "worker commit on forced ref"]);
  const oid = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["checkout", original]);
  execFileSync("git", ["branch", "-D", temporaryBranch]);
  execFileSync("git", ["update-ref", spec.refName, oid]);
  event("end");
} else if (spec.mode === "descendant") {
  event("descendant-start");
  await delay(spec.delayMs ?? 1_000);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? "descendant survived\n");
  event("descendant-end");
} else if (spec.spawnDescendant) {
  event("parent-start");
  const descendant = spawn(process.execPath, [ownPath, JSON.stringify({
    mode: "descendant",
    name: spec.name,
    eventFile: spec.eventFile,
    delayMs: spec.descendantDelayMs,
    writeFile: spec.descendantWriteFile,
    contents: spec.contents,
  })], {
    cwd: process.cwd(),
    detached: spec.detachedDescendant === true,
    windowsHide: true,
    stdio: spec.detachedDescendant === true ? "ignore" : "inherit",
  });
  if (spec.detachedDescendant === true) descendant.unref();
  await delay(spec.parentDelayMs ?? 120_000);
} else if (spec.stdoutChars) {
  process.stdout.write("x".repeat(spec.stdoutChars));
} else {
  event("start");
  await delay(spec.delayMs ?? 0);
  if (spec.writeFile) writeFileSync(path.resolve(process.cwd(), spec.writeFile), spec.contents ?? spec.name ?? "done");
  event("end");
}
