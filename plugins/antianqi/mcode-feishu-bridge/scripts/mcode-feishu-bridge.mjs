/**
 * mcode-feishu-bridge
 *
 * Drive MiniMax Code remotely from a Lark/Feishu conversation: a message in
 * Feishu becomes a local mcode turn, and the answer is written back into that
 * same message in place.
 *
 * Zero npm dependencies. It shells out to two CLIs the user already has:
 * `lark-cli` and `mcode`. It ships no credentials of its own.
 *
 * Cross-platform traps (all reproduced on Windows, not theoretical):
 *
 *  1. [The expensive one] Never forward arguments through `cmd /c`.
 *     Node builds a command line, then cmd.exe parses it again — two parses.
 *     mcode answers can contain resource markup such as
 *     <media type="file" src="/tmp/x.txt" />, and the < > " inside it are
 *     redirection and quote operators to cmd. The command is shredded:
 *     exit 1, empty stdout, empty stderr, no diagnosable cause, and the
 *     failure then drives a retry loop that floods the chat.
 *     Measured with the same payload against the same message:
 *         cmd /c lark-cli ...   -> exit 1, no output
 *         spawn(lark-cli)       -> exit 0, delivered
 *     So every child process is spawned directly, with shell:false, and the
 *     shell is never involved.
 *
 *  2. `>` and `2>` are not redirections when passed as argv. A binary does not
 *     parse them; it treats them as ordinary arguments and fails.
 *
 *  3. lark-cli implements the `+xxx` subcommands in bin/lark-cli (a compiled
 *     binary); scripts/run.js only forwards to it. When bypassing the shell,
 *     spawn the binary, not run.js.
 *
 *  4. lark-cli does not paginate +chat-list or +chat-messages-list by default.
 *     See selectFresh(): ordering and paging are what make the bridge go deaf
 *     when a conversation outgrows one page.
 *
 *  5. --text silently drops text containing a newline. Always send --content
 *     with a JSON body.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync,
         readdirSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { inspect } from "node:util";

const IS_WIN = process.platform === "win32";

// ─────────────────────────── configuration ───────────────────────────
/**
 * Data directory. The runtime reserves PLUGIN_DATA for a Plugin; honour it so
 * the bridge is sandboxed with the rest of the Plugin, and fall back to a
 * per-user directory rather than the shared temp dir (a temp dir is wiped and
 * is world-writable, neither of which suits state and downloaded attachments).
 */
const DATA_DIR = process.env.PLUGIN_DATA
  || process.env.MCODE_FEISHU_BRIDGE_DATA
  || join(homedir(), ".mcode-feishu-bridge");
const STATE_FILE = join(DATA_DIR, "state.json");
const LOCK_FILE = join(DATA_DIR, "bridge.lock");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const LOG_FILE_DEFAULT = join(DATA_DIR, "bridge.log");
const WS_ROOT = join(DATA_DIR, "workspaces");
const DOWNLOAD_ROOT = join(DATA_DIR, "media");
const TMP = tmpdir();

const PERMISSION = "full";

const args = process.argv.slice(2);
/**
 * The chat to watch. Never ship a default: a chat id is a private identifier
 * and belongs to whoever configured it.
 * Resolution order: --chat, then $MCODE_FEISHU_CHAT, then config.json.
 */
const CHAT_ID = argOf("--chat") || process.env.MCODE_FEISHU_CHAT || configChatId();
const WATCH = args.includes("--watch");
const INTERVAL = Number(argOf("--interval")) || 3000;
/** Hard ceiling on one mcode turn. The default is 10 minutes: a normal turn
 *  takes 10-15s, so 10 minutes is generous while still short enough that a
 *  hung agent does not leave the chat waiting forever. */
const MCODE_TIMEOUT_MS = Number(argOf("--timeout")) || 10 * 60 * 1000;
/** Grace period after a kill is issued, waiting for the process to really die. */
const KILL_GRACE_MS = 3000;

function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

/** Read a non-secret setting from the data-dir config file. */
function configValue(key) {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    const v = raw?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch { return null; }
}
function configChatId() { return configValue("chatId"); }

// ─────────────────────────── self-logging ───────────────────────────
/**
 * --log <path> (default: <data-dir>/bridge.log) appends console output to a file.
 *
 * Redirecting from the launcher instead looks simpler, but a long-lived child
 * spawned that way still inherits the launcher's std handles, so an automated
 * caller (a login hook, for example) blocks until the child's pipe closes.
 * Having the process write its own log keeps it fully detached, and the log
 * stays readable while the bridge runs.
 */
const LOG_FILE = argOf("--log") ?? (WATCH ? LOG_FILE_DEFAULT : null);
if (LOG_FILE) {
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  for (const k of ["log", "warn", "error"]) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      orig(...a);
      try { appendFileSync(LOG_FILE, a.map((x) => (typeof x === "string" ? x : inspect(x))).join(" ") + "\n", "utf8"); }
      catch {}
    };
  }
}

// ─────────────────────────── executable resolution ───────────────────────────
/** Find a command on PATH. Cross-platform; no drive letter or absolute prefix is hardcoded. */
function resolveOnPath(name) {
  try {
    const r = spawnSync(IS_WIN ? "where.exe" : "which", [name], {
      encoding: "utf8", windowsHide: true,
    });
    return String(r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { return null; }
}

/**
 * Locate the real lark-cli binary.
 *
 * The npm shim on Windows is `<npm>/lark-cli.cmd`, which runs node run.js,
 * and run.js in turn execFileSync's `<npm>/node_modules/@larksuite/cli/bin/lark-cli.exe`.
 * So derive the binary from the shim found on PATH; never hardcode a drive letter.
 */
function resolveLarkExe() {
  if (process.env.MCODE_FEISHU_LARK_BIN && existsSync(process.env.MCODE_FEISHU_LARK_BIN)) {
    return process.env.MCODE_FEISHU_LARK_BIN;
  }
  const shim = (IS_WIN && resolveOnPath("lark-cli.cmd")) || resolveOnPath("lark-cli");
  if (shim) {
    const binName = IS_WIN ? "lark-cli.exe" : "lark-cli";
    const cand = join(dirname(shim), "node_modules", "@larksuite", "cli", "bin", binName);
    if (existsSync(cand)) return cand;
  }
  // Some installs expose the binary itself on PATH.
  return resolveOnPath(IS_WIN ? "lark-cli.exe" : "lark-cli");
}

/**
 * Locate the mcode JS entry point.
 *
 * The Windows launcher is `node.exe cli.js %*`, i.e. plain JavaScript, so it can
 * be run by spawning node directly and the shell is bypassed entirely. The
 * launcher directory is discovered from the `mcode` command on PATH, and the
 * active release is read from the install's own `current` marker file.
 */
function resolveMcodeCli() {
  if (process.env.MCODE_FEISHU_MCODE_CLI && existsSync(process.env.MCODE_FEISHU_MCODE_CLI)) {
    return process.env.MCODE_FEISHU_MCODE_CLI;
  }
  const cliAt = (base) => {
    const rel = (() => { try { return readFileSync(join(base, "current"), "utf8").trim(); } catch { return null; } })();
    const tryVer = (v) => (v ? join(base, "releases", v, "node_modules", "@minimax-ai", "code", "cli.js") : null);
    if (rel && existsSync(tryVer(rel))) return tryVer(rel);
    // `current` is missing or points at a version that is not installed:
    // fall back to any release directory, newest first.
    try {
      for (const v of readdirSync(join(base, "releases")).sort().reverse()) {
        if (existsSync(tryVer(v))) return tryVer(v);
      }
    } catch {}
    return null;
  };

  // Install roots, discovered from PATH where possible so nothing is hardcoded.
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  push(join(homedir(), ".minimax-code"));
  const shim = resolveOnPath("mcode.cmd") || resolveOnPath("mcode");
  if (shim) push(dirname(dirname(shim)));
  if (process.env.MCODE_HOME) push(process.env.MCODE_HOME);

  for (const r of roots) {
    const hit = cliAt(r);
    if (hit) return hit;
  }
  return null;
}

const LARK_EXE = resolveLarkExe();
const MCODE_CLI = resolveMcodeCli();

// Fail fast when a required executable is missing — but not under the test
// harness. The suite imports this module on hosts (CI included) that have no
// mcode installed, and an exit(1) at import time would fail the whole file
// before a single assertion runs. The suite probes resolveMcodeCli() itself and
// skips the live-host cases.
if ((!LARK_EXE || !MCODE_CLI) && process.env.MCODE_FEISHU_BRIDGE_TEST !== "1") {
  console.error("Cannot locate the required executables:");
  if (!LARK_EXE) console.error("  lark-cli binary (override with MCODE_FEISHU_LARK_BIN)");
  if (!MCODE_CLI) console.error("  mcode cli.js (override with MCODE_FEISHU_MCODE_CLI)");
  process.exit(1);
}

// ─────────────────────────── exec layer ───────────────────────────
/**
 * Run an executable, collecting stdout/stderr over pipes, never through a shell.
 *
 * Why not `cmd /c` plus `> file`: see notes 1 and 2 in the file header.
 * Buffer.toString("utf8") is also encoding-safe; a console code page affects
 * terminal display, not Buffer decoding.
 *
 * Returns {code, text, err, ok}. `ok` only means the process exited cleanly and
 * says nothing about success: lark-cli can exit 0 on a Feishu-side failure, so
 * the caller must inspect the payload.
 */
function runCli(exe, argv, { onData } = {}) {
  return new Promise((resolve) => {
    const p = spawn(exe, argv, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "", err = "", settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, text, err, ok: code === 0 });
    };
    p.stdout.on("data", (d) => {
      const s = d.toString("utf8");
      text += s;
      onData?.(s);
    });
    p.stderr.on("data", (d) => (err += d.toString("utf8")));
    p.on("close", done);
    p.on("error", (e) => { err += String(e); done(-1); });
  });
}

const lark = (argv) => runCli(LARK_EXE, argv);
const larkJson = async (argv) => {
  const { text } = await lark([...argv, "--format", "json"]);
  try { return JSON.parse(text); } catch { return null; }
};

// ─────────────────────────── mcode layer ───────────────────────────
/**
 * Kill a whole process tree.
 *
 * child.kill() only reaps the direct child. mcode spawns its own children
 * (tools, plugin hosts) which keep file handles and locks if left alive, so
 * Windows needs taskkill /T for a tree kill, and POSIX needs a process-group
 * signal. Both are invoked without a shell.
 */
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    try {
      const p = spawn("taskkill.exe", ["/F", "/T", "/PID", String(pid)],
        { shell: false, windowsHide: true, stdio: "ignore" });
      p.on("error", () => { try { process.kill(pid, "SIGKILL"); } catch {} });
    } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    return;
  }
  // POSIX: signal the group when we can, otherwise the single process.
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

/**
 * Run one mcode turn. Uses stream-json so a status message can be sent at key
 * moments (a tool call, for example).
 *
 * Spawns node on cli.js directly and consumes stdout line by line through a
 * pipe — far simpler than the old "redirect to a file, then poll the file size
 * with setInterval", and genuinely streaming. That also disposes of an old
 * problem: the file-polling dance existed to dodge PowerShell's GBK, but
 * Buffer.toString("utf8") never had an encoding problem, so it was all
 * self-inflicted.
 *
 * onProgress(kind, detail):
 *   kind = "tool"  a tool call { name, nth, status }
 *         "stage" a turn/exec stage change
 */
function mcodeRun(prompt, { cwd, sessionId, files = [], onProgress, timeoutMs = MCODE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const argv = ["exec", "--cwd", cwd, "--output-format", "stream-json", "--permission", PERMISSION];
    if (sessionId) argv.push("--session", sessionId);
    for (const f of files) argv.push("--file", f);
    argv.push(prompt);

    const p = spawn(process.execPath, [MCODE_CLI, ...argv], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });

    const t0 = Date.now();
    const seen = new Set();
    let toolCount = 0;
    let finalOutput = null;
    let usage = null;
    let streamErr = "";
    let pending = "";     // trailing bytes that do not yet form a line
    let settled = false;
    let timeoutFired = false;
    const timeoutExtra = () => ({
      timedOut: true,
      stderr: `still running after ${Math.round(timeoutMs / 1000)}s, force-killed (pid ${p.pid})`,
    });

    const handleLine = (ln) => {
      if (!ln.trim()) return;
      let ev;
      try { ev = JSON.parse(ln); } catch { return; }
      const type = ev.type ?? ev.subtype ?? "";
      if (ev.usage) usage = ev.usage;
      if (/^(turn|exec)\./.test(type)) onProgress?.("stage", type);

      const tc = ev.item?.toolCall;
      if (tc?.name) {
        const key = tc.id ?? tc.name;
        if (!seen.has(key)) {
          seen.add(key);
          toolCount++;
          onProgress?.("tool", { name: tc.name, nth: toolCount, status: tc.status });
        }
      }
      const item = ev.item ?? {};
      if (item.type === "text" && (item.content || item.text)) finalOutput = item.content ?? item.text;
      if (/^(turn|exec)\.completed$/.test(type)) {
        const o = ev.output ?? ev.result?.output ?? ev.item?.content;
        if (o) finalOutput = o;
      }
    };

    p.stdout.on("data", (d) => {
      pending += d.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const ln of lines) handleLine(ln);
    });
    p.stderr.on("data", (d) => (streamErr += d.toString("utf8")));

    let timer = null;
    const settle = (code, extra = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      if (pending.trim()) handleLine(pending);
      pending = "";
      resolve({
        output: finalOutput, usage, toolCount, code, timedOut: false,
        ...extra,
        stderr: extra.stderr ?? streamErr.slice(0, 300), ms: Date.now() - t0,
      });
    };
    let killGrace = null;

    // Hard timeout. The worst case in a remote setup is mcode hanging: without
    // a timeout the bridge hangs forever and the placeholder message stays on
    // "calling xxx…", recoverable only by restarting the process.
    //
    // Key detail: killTree merely initiates termination, and taskkill is itself
    // asynchronous. So do not resolve right away; wait for the close event to
    // really arrive (with a 3s backstop) — otherwise the next message races a
    // not-yet-dead mcode for the same workspace and session.
    timer = setTimeout(() => {
      timeoutFired = true;
      onProgress?.("timeout", { ms: Date.now() - t0 });
      killTree(p.pid);
      killGrace = setTimeout(() => settle(-2, timeoutExtra()), KILL_GRACE_MS);
    }, timeoutMs);

    p.on("close", (c) => settle(timeoutFired ? -2 : c, timeoutFired ? timeoutExtra() : {}));
    p.on("error", (e) => { streamErr += String(e); settle(-1); });
  });
}

// ─────────────────────────── single-instance lock ───────────────────────────
/**
 * A pid lock, guaranteeing that only one bridge runs on a given machine.
 *
 * Why it is mandatory: two instances would poll the same chat at the same time,
 * each reading the same state file and each claiming the same new message — the
 * result is mcode running twice, duplicate placeholders, and the two states
 * overwriting each other. That is harder to diagnose than a crash, so it is
 * blocked at the entry point.
 *
 * A zombie lock (process force-killed, cleanup never ran) must be reclaimed
 * automatically: probe whether the pid is alive, do not rely on file existence.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);          // signal 0 only probes existence, it sends nothing
    return true;
  } catch (e) {
    // EPERM means the process exists but the current user may not signal it, so it is alive
    return e?.code === "EPERM";
  }
}

function acquireLock(file = LOCK_FILE) {
  if (existsSync(file)) {
    const prev = Number(String(readFileSync(file, "utf8")).trim());
    // The lock is ours → let it through idempotently. acquireLock may be called
    // from several places, and holding the lock must not make us reject
    // ourselves as "some other instance".
    if (Number.isInteger(prev) && prev === process.pid) {
      return { ok: true, pid: prev, reentrant: true };
    }
    if (Number.isInteger(prev) && prev > 0 && isPidAlive(prev)) {
      return { ok: false, pid: prev };
    }
    // Zombie lock: overwrite directly, do not block startup
    try { unlinkSync(file); } catch {}
  }
  writeFileSync(file, String(process.pid), "utf8");
  return { ok: true, pid: process.pid };
}

function releaseLock(file = LOCK_FILE) {
  try {
    const cur = Number(String(readFileSync(file, "utf8")).trim());
    if (cur === process.pid) unlinkSync(file);   // only ever remove our own lock
  } catch {}
}

// ─────────────────────────── state layer ───────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { chats: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { chats: {} }; }
}

/**
 * Write the state file atomically: stage next to the target, fsync, then rename.
 *
 * The bridge can be killed at any moment (a user closing the terminal, a reboot,
 * the mcode hard timeout). A half-written state file would make loadState() fall
 * back to an empty state and the bridge would reprocess the whole conversation,
 * re-running mcode on messages it already answered. Rename is atomic on both
 * POSIX and Windows, so a reader either sees the old file or the new one.
 */
function saveState(s) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(s, null, 2), "utf8");
    try { fsyncSync(fd); } catch {}      // best effort; not supported everywhere
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, STATE_FILE);
}

function binding(chatId) {
  const st = loadState();
  if (st.chats[chatId]) return { st, b: st.chats[chatId] };
  const cwd = join(WS_ROOT, chatId.replace(/\W/g, "").slice(-14) || "default");
  mkdirSync(cwd, { recursive: true });
  st.chats[chatId] = { cwd, sessionId: null, lastMessageId: null, turns: 0 };
  saveState(st);
  return { st, b: st.chats[chatId], fresh: true };
}

// ─────────────────────────── message parsing ───────────────────────────
/**
 * Extract text plus attachment file_keys from a Feishu message.
 *
 * Learned the hard way: Feishu merges "text + image" into msg_type=post, and the
 * content lark-cli returns is already markdown (`![Image](img_xxx)`), not
 * Feishu's original `{"zh_cn":{"content":[...]}}` structure. So post has to be
 * parsed as markdown.
 */
function parseMessage(m) {
  const out = { text: "", files: [] };
  const raw = m.content ?? "";

  if (m.msg_type === "text") {
    out.text = raw;
    return out;
  }

  if (m.msg_type === "image" || m.msg_type === "file") {
    let o = {};
    try { o = JSON.parse(raw); } catch {}
    const key = o.image_key ?? o.file_key;
    if (key) out.files.push({ key, type: m.msg_type === "image" ? "image" : "file" });
    out.text = m.msg_type === "image" ? "[user sent an image]" : "[user sent a file]";
    return out;
  }

  if (m.msg_type === "post" || m.msg_type === "rich") {
    // Could be markdown, could be Feishu's raw JSON — cover both
    let body = raw;
    if (raw.trimStart().startsWith("{")) {
      try {
        const o = JSON.parse(raw);
        const lang = o.zh_cn ?? o.en_us ?? Object.values(o)[0] ?? {};
        const nodes = lang.content ?? [];
        const parts = [];
        for (const n of nodes) {
          if (n.tag === "text") parts.push(n.text ?? "");
          else if (n.tag === "img" && n.image_key) {
            out.files.push({ key: n.image_key, type: "image" });
            parts.push("[image]");
          } else if (n.tag === "a" && n.href) parts.push(n.text ?? n.href);
          else if (n.tag === "at") parts.push(`@${n.user_name ?? "someone"}`);
        }
        body = parts.join("\n");
      } catch { /* not JSON, so fall through to markdown */ }
    } else {
      // markdown form: pull out ![Image](key) and [file](key)
      const imgRe = /!\[(?:Image|image)?[^\]]*\]\((img_v3_[^)]+)\)/g;
      let mt;
      while ((mt = imgRe.exec(raw)) !== null) out.files.push({ key: mt[1], type: "image" });
      const fileRe = /\[([^\]]*)\]\((file_v3_[^)]+)\)/g;
      while ((mt = fileRe.exec(raw)) !== null) out.files.push({ key: mt[2], type: "file" });
      // strip the markdown image/file syntax, leaving plain text
      body = raw
        .replace(imgRe, "")
        .replace(fileRe, "$1")
        .replace(/\[([^\]]*)\]\(https?:\/\/[^)]+\)/g, "$1")
        .trim();
    }
    if (out.files.length && !body) body = `[user sent ${out.files.length} attachments]`;
    out.text = body;
    return out;
  }

  out.text = `[unsupported message type: ${m.msg_type}]`;
  return out;
}

async function downloadResources(messageId, files, cwd) {
  const dir = join(DOWNLOAD_ROOT, messageId.replace(/\W/g, "").slice(-12));
  mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const f of files) {
    const target = join(dir, f.key);
    const r = await lark([
      "im", "+messages-resources-download",
      "--message-id", messageId, "--file-key", f.key,
      "--type", f.type, "--output", target, "--as", "user",
    ]);
    if (r.code === 0 && existsSync(target)) paths.push(target);
  }
  return paths;
}

// ─────────────────────────── sending layer ───────────────────────────
/**
 * Send a text message.
 *
 * Must use --content with a JSON body, never --text:
 * once --text content contains a newline, going through cmd /c makes the command
 * fail silently (the exit code is still 0, but the message is never sent).
 * Measured with 46 characters containing 3 newlines:
 *   --text    -> exit=0, output empty, message does not exist ❌
 *   --content -> exit=0, all 46 characters delivered ✅
 */
const textContent = (t) => JSON.stringify({ text: t });
const msgTypeFlag = ["--msg-type", "text"];

const sendMsg = (chatId, text) =>
  lark(["im", "+messages-send", "--chat-id", chatId, "--as", "bot",
        ...msgTypeFlag, "--content", textContent(text)]);

const replyTo = (messageId, text) =>
  lark(["im", "+messages-reply", "--message-id", messageId, "--as", "bot",
        ...msgTypeFlag, "--content", textContent(text)]);

/**
 * Edit an already-sent text message (placeholder → thinking → final result,
 * updated in place).
 *
 * Note: a bare `api PATCH /open-apis/im/v1/messages/:id` returns
 * 230001 "This message is NOT a card", because that endpoint only supports card
 * messages. Text messages must use the official `+messages-edit` wrapper, which
 * goes through a different endpoint.
 */
const editMsg = (messageId, text) =>
  lark(["im", "+messages-edit", "--message-id", messageId, "--as", "bot",
        ...msgTypeFlag, "--content", textContent(text)]);

const notify = (chatId, text) => sendMsg(chatId, text);

/**
 * Delivery determination.
 * Exit 0 only means the process did not crash — lark-cli can also exit 0 on a
 * Feishu-side failure (measured), so when there is JSON, inspect the top-level
 * ok, and fall back to the exit code only when there is not.
 */
const sent = (res) => {
  if (!res || res.code !== 0) return false;
  const t = (res.text || "").trim();
  if (!t.startsWith("{")) return true;
  try { return JSON.parse(t)?.ok !== false; } catch { return true; }
};

/**
 * Edits to the same message must be strictly serial.
 *
 * Learned the hard way (reproduced, not theoretical): a tool broadcast that
 * triggers
 *   editMsg(phId, hint).catch(() => {})   ← not awaited
 * together with the main flow's
 *   await editMsg(phId, final)
 * becomes two concurrent lark-cli processes. Feishu is last-write-wins, so
 * whichever lands last wins, and a single lark-cli start takes 1~2 seconds —
 * the hint can easily be slower than the final. In 6 reproduction runs, 1 lost
 * the final to the hint, leaving the user seeing only "calling read…" with the
 * final result never arriving; the demo2.txt run hit exactly this.
 *
 * The fix: funnel the edits into one promise chain, which is FIFO by nature;
 * seal before enqueuing the final, so a late tool event can never rewrite the
 * content back to the hint.
 */
function editQueue(editFn = editMsg) {
  const failed = (e) => ({ ok: false, code: -1, text: "", err: String(e) });
  let tail = Promise.resolve({ ok: true, text: "", code: 0 });
  let sealed = false;
  return {
    seal() { sealed = true; },
    /** The final result: still let through after seal, but always queued behind every hint already enqueued */
    push(messageId, text) {
      tail = tail.then(() => editFn(messageId, text)).catch(failed);
      return tail;
    },
    /** Tool broadcast: dropped once the final is enqueued, so a late tool event cannot rewrite the content back to the hint */
    pushHint(messageId, text) {
      if (sealed) return;
      tail = tail.then(() => editFn(messageId, text)).catch(failed);
    },
    /** Wait for the queue to drain, yielding the result of the last edit */
    drain() { return tail; },
  };
}

// ─────────────────────────── main flow ───────────────────────────
/** Quiet tools: read-only/retrieval kinds; announcing them carries no signal and only floods the chat */
const QUIET_TOOLS = /^(glob|grep|search|list|ls|think|wait|todo)/i;

/** Delivery retry: after the nth failure wait RETRY_BASE_MS*n, at most MAX_DELIVERY_ATTEMPTS tries */
const RETRY_BASE_MS = 5000;
const MAX_DELIVERY_ATTEMPTS = 5;
/** How many recent messages one poll fetches. In the normal case a single API call is enough. */
const PAGE_SIZE = 50;

/**
 * Pick out the messages newer than the watermark from one page of messages
 * (oldest first).
 *
 * This function is pulled out on its own because it once hid a bug that was very
 * hard to find: pollOnce used to call `--order asc --page-size 50`, which
 * returns the **oldest** 50 messages. Once a conversation grows, new messages
 * land on the second page, and if the watermark happens to be the 50th message
 * then fresh=[] — the bridge acts as if it saw nothing the user sent, and
 * **not a single log line is written**. Worse, as the conversation keeps going
 * the watermark gets pushed out of the first page, findIndex=-1, fresh is
 * still [], and the bridge is completely deaf.
 *
 * Returning watermarkFound=false means this page does not cover the watermark;
 * the caller must page through to make up the difference, and must never treat
 * "not found" as "no new messages".
 */
function selectFresh(pageNewestFirst, lastMessageId) {
  const msgs = [...pageNewestFirst].reverse();      // now oldest first
  if (!lastMessageId) return { fresh: msgs, watermarkFound: true, total: msgs.length };
  const i = msgs.findIndex((m) => m.message_id === lastMessageId);
  return {
    fresh: i >= 0 ? msgs.slice(i + 1) : [],
    watermarkFound: i >= 0,
    total: msgs.length,
  };
}

/**
 * Fetch messages. Normally only the most recent page is pulled (one API call);
 * it escalates to a full --page-all walk only when the watermark has been
 * pushed off that page (the bridge was stopped for a long time, or someone
 * dumped dozens of messages in). Combining --order asc with --page-all also
 * works, but pulling the entire history every 2 seconds turns into dozens of
 * API calls as soon as there are many messages, which easily hits rate limits.
 */
async function fetchMessages(chatId, lastMessageId) {
  const recent = await larkJson([
    "im", "+chat-messages-list", "--chat-id", chatId,
    "--order", "desc", "--page-size", String(PAGE_SIZE), "--as", "user",
  ]);
  if (!recent?.data?.messages?.length) return { messages: [], caughtUp: false, error: !recent };

  let msgs = recent.data.messages;
  let caughtUp = true;

  if (lastMessageId && !msgs.some((m) => m.message_id === lastMessageId)) {
    // The watermark is not in the most recent page → we have fallen too far behind and must walk the full history, or messages get lost
    console.warn(`  ⚠ watermark not in the most recent ${PAGE_SIZE}, escalating to a full paged fetch`);
    const full = await larkJson([
      "im", "+chat-messages-list", "--chat-id", chatId,
      "--order", "asc", "--page-all", "--as", "user",
    ]);
    if (full?.data?.messages?.length) {
      msgs = full.data.messages;
    } else {
      caughtUp = false;     // the full walk came up empty too; the watermark may have expired
    }
  }
  return { messages: msgs, caughtUp, error: false };
}

/**
 * Deliver the final result to Feishu: prefer editing the placeholder in place,
 * and fall back to a reply when that fails.
 *
 * Pulled out on its own so a unit test can cover it — this fallback had no test
 * coverage at all before, and under negative injection ("delete the fallback")
 * the suite still went entirely green, which means it had been running naked.
 * The user must never be stuck on a placeholder that stays on "calling xxx…"
 * forever.
 */
async function deliverFinal({ q, phId, messageId, finalText, reply = replyTo, log = console.warn }) {
  let res;
  if (q) {
    q.seal();                    // cut off late hints
    q.push(phId, finalText);     // queued behind every hint already enqueued
    res = await q.drain();
  } else {
    res = await reply(messageId, finalText);
  }
  if (!sent(res)) {
    // Log both stdout and stderr: some lark-cli errors go to stdout, and looking at stderr alone yields a blank page
    const detail = [(res?.err || "").trim(), (res?.text || "").trim()]
      .filter(Boolean).join(" | ").replace(/\s+/g, " ").slice(0, 200);
    log(`  ⚠ editing the final result failed code=${res?.code} payload=${finalText.length}ch `
      + `stdout=${(res?.text || "").length}B stderr=${(res?.err || "").length}B`
      + `${detail ? " :: " + detail : " :: (no output)"}`);
    if (process.env.MCODE_FEISHU_BRIDGE_DEBUG) {
      writeFileSync(join(TMP, "bridge-final-debug.json"),
        JSON.stringify({ phId, messageId, finalText }, null, 2), "utf8");
      log(`  🔍 payload written to ${join(TMP, "bridge-final-debug.json")}`);
    }
    res = await reply(messageId, finalText);
    if (!sent(res)) {
      log(`  ⚠ reply failed too code=${res?.code} payload=${finalText.length}ch `
        + `stdout=${(res?.text || "").length}B stderr=${(res?.err || "").length}B `
        + `:: ${[(res?.err || "").trim(), (res?.text || "").trim()].filter(Boolean).join(" | ").slice(0, 200)}`);
    }
  }
  return { res, ok: sent(res) };
}

/**
 * Classify what went wrong while fetching messages, **classify only, do not
 * print**.
 *
 * Why classify instead of throwing straight away: that way "whether anything
 * went wrong, and which kind" can be held by a unit test (deleting the warning
 * used to leave all 80 tests green anyway). What actually makes it loud is the
 * throw in collectFresh below.
 */
function reportFetchProblem({ error, watermarkFound, watermark }) {
  if (error) {
    return {
      ok: false, reason: "fetch-error",
      message: "Failed to fetch messages: lark-cli returned no usable data. Check whether the token is expired, plus network and permissions.",
    };
  }
  if (!watermarkFound) {
    return {
      ok: false, reason: "no-watermark",
      message: `The watermark ${watermark} is not in this page, so this round is skipped to avoid duplicates or lost messages.`
        + " (usually the bridge was stopped long enough that the history got pushed out of the most recent page; check logs/bridge.log)",
    };
  }
  return { ok: true, reason: "ok", message: "" };
}

class BridgeFetchError extends Error {
  constructor(problem) {
    super(`[${problem.reason}] ${problem.message}`);
    this.name = "BridgeFetchError";
    this.reason = problem.reason;
  }
}

/**
 * Collect the messages newer than the watermark.
 *
 * **If it cannot be fetched, throw — never silently return an empty array.**
 * A throw is used rather than a status code that has to be remembered and
 * checked, because "forgot to check the return value" is a failure mode tests
 * cannot catch (delete the single line `if (problem !== "ok") return 0` under
 * negative injection and the whole suite still goes green). Once thrown, the
 * only exit is the catch in the watch loop, which already logs — being loud
 * is guaranteed structurally, not by discipline.
 */
async function collectFresh(chatId, lastMessageId, { fetch = fetchMessages } = {}) {
  const { messages = [], caughtUp, error } = await fetch(chatId, lastMessageId);

  // Treat every empty page as "failed to fetch messages", without depending on
  // the caller remembering to set the error flag. Depending on another function
  // to set a flag and depending on the caller to check a return value are the
  // same species of fragility.
  const problem = reportFetchProblem({
    error: !!error || messages.length === 0,
    watermarkFound: messages.length > 0 && selectFresh(messages, lastMessageId).watermarkFound,
    watermark: lastMessageId,
  });
  if (!problem.ok) throw new BridgeFetchError(problem);
  return { fresh: messages.length ? selectFresh(messages, lastMessageId).fresh : [], caughtUp };
}

async function pollOnce(chatId) {
  const { st, b } = binding(chatId);

  // Flush the previous round's undelivered result before considering new messages
  await flushPending(chatId);

  const { fresh } = await collectFresh(chatId, b.lastMessageId);

  if (fresh.length > 50) console.warn(`  ⚠ ${fresh.length} new messages backed up at once`);

  let handled = 0;
  for (const m of fresh) {
    if (m.deleted) { b.lastMessageId = m.message_id; continue; }
    const who = m.sender?.sender_type;
    if (who !== "user") continue;                 // ignore our own messages
    if (m.message_id === b.lastMessageId) continue;

    const { text, files } = parseMessage(m);
    if (!text.trim() && !files.length) {
      // Unknown type: warn but do not advance the watermark, so it can still be replayed once the parser catches up
      console.warn(`  ⚠ skipping an unparsable message type=${m.msg_type} id=${m.message_id}`);
      continue;
    }

    // ① Reply with a placeholder immediately, keeping the "received → some reaction" wait as short as possible
    const ph = await larkJson([
      "im", "+messages-send", "--chat-id", chatId, "--as", "bot",
      ...msgTypeFlag, "--content", textContent("🧠 Got it, thinking…"),
    ]);
    const phId = ph?.data?.message_id ?? ph?.data?.message?.message_id ?? null;
    if (!phId) console.warn("  ⚠ placeholder message failed to send, falling back to reply");

    // From the moment the placeholder goes out, every write to this message goes through one serial queue
    const q = phId ? editQueue() : null;

    // ② Download the attachments
    const paths = files.length ? await downloadResources(m.message_id, files, b.cwd) : [];
    if (paths.length && q) {
      q.pushHint(phId, `📎 Received ${paths.length} attachments, starting…`);
    }

    // ③ Run mcode. The placeholder is updated in place, no chat spam.
    //    Every edit goes through q (the serial queue); that is the key to fixing
    //    "the hint overwrites the final result".
    let toolCount = 0;
    let lastHint = "";
    const started = Date.now();
    const r = await mcodeRun(text, {
      cwd: b.cwd, sessionId: b.sessionId, files: paths,
      timeoutMs: MCODE_TIMEOUT_MS,
      onProgress: (kind, detail) => {
        if (kind === "timeout" && q) {
          q.pushHint(phId, `⏱ Over ${Math.round(MCODE_TIMEOUT_MS / 60000)} minutes, force-terminating…`);
          return;
        }
        if (kind !== "tool" || !q) return;
        toolCount = detail.nth;
        if (QUIET_TOOLS.test(detail.name)) return;
        const hint = `⚙️ Calling \`${detail.name}\`…`;
        if (hint === lastHint) return;
        lastHint = hint;
        q.pushHint(phId, hint);   // enqueueing is enough, do not await; the queue guarantees ordering
      },
    });

    // ④ The final result
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const bits = [`⏱ ${secs}s`];
    if (r.usage?.total_tokens) bits.push(`${r.usage.total_tokens} tokens`);
    if (toolCount) bits.push(`${toolCount} tool calls`);

    const finalText = r.timedOut
      ? `⏱ **timed out and was force-terminated** (${secs}s)\n\n`
        + `This mcode turn ran for ${secs}s without finishing, and the process has been killed.\n`
        + `Common causes: a tool stuck on an interactive prompt, a command waiting for input, or a hung network request.\n\n`
        + `${toolCount} tool calls had already completed, and their side effects on the workspace are still there,`
        + `so you can ask me to check the current state, or rephrase and try again.\n\n---\n${bits.join(" · ")}`
      : r.output
        ? `${r.output}\n\n---\n${bits.join(" · ")}`
        : `❌ Processing failed (${secs}s)\n\`\`\`\n${(r.stderr || "").slice(0, 300)}\n\`\`\``;

    // ④ Delivery: prefer editing the placeholder in place, automatically fall
    //    back to a reply if the edit fails
    const { ok } = await deliverFinal({ q, phId, messageId: m.message_id, finalText });

    // ⑤ Record. The watermark advances whether or not delivery succeeded, and an
    //    undelivered result is stored separately in b.pending.
    //    See the recordOutcome comment — this used to be the source of a
    //    runaway loop that flooded the chat.
    recordOutcome(b, { messageId: m.message_id, ok, phId, finalText, paths });
    saveState(st);
    handled++;
    console.log(`  ${ok ? "✓" : "⏳"} ${m.create_time} ${text.slice(0, 40)} → ${secs}s`
      + (ok ? "" : "(delivery failed, queued; only delivery is retried, mcode is not re-run)"));
  }
  return handled;
}

/** Linear backoff: after the nth failure wait base*n milliseconds */
const backoffMs = (attempts, base = RETRY_BASE_MS) => base * Math.max(1, attempts);
/** Give up once the consecutive failures hit the limit; never retry forever */
const shouldGiveUp = (attempts, max = MAX_DELIVERY_ATTEMPTS) => attempts >= max;

/**
 * Record the outcome of handling one message.
 *
 * The most critical contract: **the watermark advances whether or not delivery
 * succeeded**. It used to be written as "do not advance the watermark when
 * delivery fails", intending to re-deliver on the next round — but as soon as
 * delivery kept failing, the whole pollOnce re-ran from the start, re-running
 * mcode and re-sending a placeholder every round, flooding Feishu. A failed
 * result goes into b.pending instead, and only delivery is retried, never a
 * re-run of mcode.
 *
 * Extracted into a pure function so a unit test can hold this contract.
 */
function recordOutcome(b, { messageId, ok, phId = null, finalText, paths = [], now = Date.now() }) {
  b.lastMessageId = messageId;
  b.turns = (b.turns ?? 0) + 1;
  if (paths.length) b.lastFiles = paths;
  b.pending = ok ? null : { messageId, phId, finalText, attempts: 1, nextTryAt: now + backoffMs(1) };
  return b;
}

/**
 * Re-deliver the previous round's undelivered result.
 * Only delivery is retried, mcode is not re-run, and no new placeholder is sent —
 * that placeholder stuck on "calling xxx…" is simply edited in place into the
 * final result.
 */
async function flushPending(chatId) {
  const { st, b } = binding(chatId);
  const p = b.pending;
  if (!p) return 0;
  if (Date.now() < (p.nextTryAt ?? 0)) return 0;

  const q = p.phId ? editQueue() : null;
  const { ok } = await deliverFinal({ q, phId: p.phId, messageId: p.messageId, finalText: p.finalText });
  if (ok) {
    b.pending = null;
    saveState(st);
    console.log(`  ✅ re-delivery succeeded (attempt ${p.attempts})`);
    return 1;
  }

  p.attempts = (p.attempts ?? 1) + 1;
  if (shouldGiveUp(p.attempts)) {
    b.pending = null;
    await notify(chatId, `⚠️ The result could not be delivered in ${p.attempts} consecutive attempts, giving up. The original result:\n\n${p.finalText}`);
    saveState(st);
    console.error(`  ✗ delivery failed ${p.attempts} times in a row, giving up (never retried forever)`);
    return 0;
  }
  p.nextTryAt = Date.now() + backoffMs(p.attempts);
  b.pending = p;
  saveState(st);
  console.warn(`  ⏳ delivery retry ${p.attempts}/${MAX_DELIVERY_ATTEMPTS}, in ${Math.round((p.nextTryAt - Date.now()) / 1000)}s`);
  return 0;
}

// ─────────────────────────── entry point ───────────────────────────
async function main() {
  // Only watch mode needs exclusivity: once mode is one-shot, and the lock would only get in the way
  if (WATCH) {
    const lock = acquireLock();
    if (!lock.ok) {
      console.error(`✗ A bridge is already running (pid ${lock.pid}).`);
      console.error(`  Two instances would claim the same message and overwrite each other's state; stop the old one first:`);
      console.error(`    node mcode-feishu-bridge.mjs --stop`);
      process.exit(3);
    }
    const bye = () => { releaseLock(); };
    process.on("exit", bye);
    process.on("SIGINT", () => { console.log("\nExiting…"); releaseLock(); process.exit(0); });
    process.on("SIGTERM", () => { releaseLock(); process.exit(0); });
    process.on("uncaughtException", (e) => {
      console.error(`Uncaught exception: ${e?.stack || e}`);
      releaseLock();
      process.exit(1);
    });
  }

  mkdirSync(WS_ROOT, { recursive: true });
  mkdirSync(DOWNLOAD_ROOT, { recursive: true });

  const { b } = binding(CHAT_ID);
  console.log(`chat      ${CHAT_ID}`);
  console.log(`workspace ${b.cwd}`);
  console.log(`session   ${b.sessionId ?? "(created on the first turn)"}`);
  console.log(`mode      ${WATCH ? `watch ${INTERVAL}ms` : "once"}`);
  console.log(`timeout   ${Math.round(MCODE_TIMEOUT_MS / 1000)}s`);
  console.log(`lock      ${WATCH ? `pid ${process.pid}` : "(no lock in once mode)"}\n`);

  if (!WATCH) {
    const n = await pollOnce(CHAT_ID);
    console.log(n ? `\nHandled ${n}` : "No new messages");
    return;
  }

  let running = true;
  process.on("SIGINT", () => { running = false; });

  console.log(`Watching, Ctrl+C to exit\n`);
  while (running) {
    try {
      await pollOnce(CHAT_ID);
    } catch (e) {
      console.error(`Polling error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  releaseLock();
  console.log("Exited.");
}

/** Stop the running watch instance (kills the process tree using the pid in the lock) */
function stopRunning() {
  if (!existsSync(LOCK_FILE)) {
    console.log("No running instance (no lock file).");
    return;
  }
  const pid = Number(String(readFileSync(LOCK_FILE, "utf8")).trim());
  if (!isPidAlive(pid)) {
    console.log(`The lock is a zombie (pid ${pid} no longer exists); cleaning it up.`);
    releaseLock();
    return;
  }
  killTree(pid);
  try { unlinkSync(LOCK_FILE); } catch {}
  console.log(`Stopped pid ${pid}.`);
}

// With MCODE_FEISHU_BRIDGE_TEST=1 this only exports and never starts watching, so
// the unit tests can import the real implementation instead of testing a copy of
// the logic (a copy is always green, which is the same as not testing at all).
export { editQueue, sent, parseMessage, textContent, QUIET_TOOLS, deliverFinal,
         backoffMs, shouldGiveUp, recordOutcome, killTree, isPidAlive,
         acquireLock, releaseLock, mcodeRun, selectFresh, reportFetchProblem, collectFresh,
         resolveMcodeCli, resolveLarkExe, DATA_DIR, IS_WIN,
         MCODE_TIMEOUT_MS, MAX_DELIVERY_ATTEMPTS, RETRY_BASE_MS, PAGE_SIZE };

if (process.env.MCODE_FEISHU_BRIDGE_TEST === "1") {
  // Unit-test mode: export only, do not start
} else if (args.includes("--stop")) {
  stopRunning();
} else {
  main();
}
