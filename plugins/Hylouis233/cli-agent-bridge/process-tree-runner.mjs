// Keep this small, known root alive until the bridge captures its creation
// identity, then launch the requested backend beneath it. This prevents a
// short-lived backend from disappearing before process-tree tracking starts.
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let payloadText = "";
let activeWorker = null;
const LINUX_EXIT_TRACKING_GRACE_MS = 150;
function recordWorkerExit(worker, code) {
  if (activeWorker === worker) activeWorker = null;
  const publishExit = () => {
    process.exitCode = Number.isInteger(code) ? code : 1;
  };
  // Keep the stable runner/root identity alive for several 25 ms ancestry
  // samples after a very short Git/backend worker exits. This lets the bridge
  // bind or rule out the worker's final children without weakening the
  // pending-child fail-closed boundary.
  if (process.platform === "linux") setTimeout(publishExit, LINUX_EXIT_TRACKING_GRACE_MS);
  else publishExit();
}
function trustedWindowsPowerShell() {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  if (!path.win32.isAbsolute(windowsRoot)) return null;
  return path.win32.join(
    windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
}

function trustedWindowsCommandProcessor() {
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "";
  if (!path.win32.isAbsolute(windowsRoot)) return null;
  return path.win32.join(windowsRoot, "System32", "cmd.exe");
}

function isFile(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

function resolveWindowsCommand(command) {
  const hasDirectory = path.win32.isAbsolute(command) || /[\\/]/u.test(command);
  const searchRoots = hasDirectory
    ? [process.cwd()]
    : [process.cwd(), ...(process.env.PATH ?? "").split(path.delimiter)];
  const extensions = path.win32.extname(command)
    ? [""]
    : ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
      .split(";").filter(Boolean), ".ps1"];
  for (const rawRoot of searchRoots) {
    const root = rawRoot.replace(/^"|"$/gu, "");
    for (const extension of extensions) {
      const unresolved = command + extension;
      const candidate = path.win32.isAbsolute(unresolved)
        ? unresolved
        : path.resolve(root || process.cwd(), unresolved);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/gu;
function escapeCmdCommand(value) {
  return value.replace(CMD_META, "^$1");
}

function parseStandardNpmCmdShim(commandFile) {
  let source;
  try {
    if (statSync(commandFile).size > 64_000) return null;
    source = readFileSync(commandFile, "utf8");
  } catch {
    return null;
  }
  if (!/^[ \t]*SET dp0=%~dp0[ \t]*$/imu.test(source) ||
      !/^[ \t]*IF EXIST "%dp0%\\node\.exe" \([ \t]*$/imu.test(source) ||
      !/^[ \t]*SET "_prog=node"[ \t]*$/imu.test(source)) return null;
  const invocation = source.match(
    /^endLocal\s+&\s+goto\s+#_undefined_#\s+2>NUL\s+\|\|\s+title\s+%COMSPEC%\s+&\s+"%_prog%"\s+"%dp0%\\([^"\r\n]+)"\s+%\*\s*$/imu,
  );
  if (!invocation || invocation[1].includes("%") || invocation[1].includes("!") ||
      path.win32.isAbsolute(invocation[1])) return null;
  const shimDirectory = path.dirname(commandFile);
  const entry = path.resolve(shimDirectory, invocation[1]);
  const allowedRoot = path.basename(shimDirectory).toLowerCase() === ".bin" &&
      path.basename(path.dirname(shimDirectory)).toLowerCase() === "node_modules"
    ? path.dirname(shimDirectory)
    : shimDirectory;
  const relativeEntry = path.relative(allowedRoot, entry);
  if (!relativeEntry || relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) return null;
  return isFile(entry) ? entry : null;
}

function monitorWorker(worker) {
  activeWorker = worker;
  worker.once("error", (error) => {
    process.stderr.write(error.message + "\n");
    process.exitCode = 127;
  });
  worker.once("exit", (code) => {
    recordWorkerExit(worker, code);
  });
  return worker;
}

function launchWindowsCmd(commandFile, payload) {
  const commandProcessor = trustedWindowsCommandProcessor();
  if (!commandProcessor) {
    process.stderr.write("cannot locate the trusted Windows command processor\n");
    process.exitCode = 127;
    return;
  }
  const shellCommand = escapeCmdCommand(path.win32.normalize(commandFile));
  let worker;
  try {
    worker = spawn(commandProcessor, ["/d", "/s", "/c", `"${shellCommand}"`], {
      cwd: process.cwd(), env: process.env, windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: [payload.stdinText === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 127;
    return;
  }
  monitorWorker(worker);
  if (worker.stdin) {
    worker.stdin.on("error", () => {});
    worker.stdin.end(payload.stdinText);
  }
}

function launchWindowsNpmShim(entry, payload) {
  let worker;
  try {
    worker = spawn(process.execPath, [entry, ...payload.args], {
      cwd: process.cwd(), env: process.env, windowsHide: true,
      stdio: [payload.stdinText === undefined ? "ignore" : "pipe", "inherit", "inherit"],
    });
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 127;
    return;
  }
  monitorWorker(worker);
  if (worker.stdin) {
    worker.stdin.on("error", () => {});
    worker.stdin.end(payload.stdinText);
  }
}

function launchWindowsPowerShell(payload) {
  const powershell = trustedWindowsPowerShell();
  if (!powershell) {
    process.stderr.write("cannot locate the trusted Windows PowerShell executable\n");
    process.exitCode = 127;
    return;
  }
  const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "ps1-json-runner.ps1");
  let worker;
  try {
    worker = spawn(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runner,
    ], {
      cwd: process.cwd(), env: process.env, windowsHide: true,
      stdio: ["pipe", "inherit", "inherit"],
    });
  } catch (error) {
    process.stderr.write(error.message + "\n");
    process.exitCode = 127;
    return;
  }
  monitorWorker(worker);
  worker.stdin.on("error", () => {});
  worker.stdin.end(JSON.stringify(payload));
}

function launchWindowsFallback(payload, launchError) {
  const commandFile = resolveWindowsCommand(payload.command);
  const extension = commandFile ? path.win32.extname(commandFile) : "";
  const recoverableError = ["EACCES", "EFTYPE", "EINVAL", "ENOENT", "EPERM", "UNKNOWN"]
    .includes(launchError?.code);
  if (!recoverableError || ![".bat", ".cmd", ".ps1"].includes(extension.toLowerCase())) {
    process.stderr.write((launchError?.message ?? "backend launch failed") + "\n");
    process.exitCode = 127;
    return;
  }
  if (extension.toLowerCase() === ".cmd" || extension.toLowerCase() === ".bat") {
    const npmEntry = parseStandardNpmCmdShim(commandFile);
    if (npmEntry) {
      launchWindowsNpmShim(npmEntry, payload);
      return;
    }
    if (payload.args.length > 0) {
      process.stderr.write(
        "cannot safely pass arguments to a non-standard .cmd/.bat backend; " +
        "configure its real executable instead\n",
      );
      process.exitCode = 127;
      return;
    }
    launchWindowsCmd(commandFile, payload);
    return;
  }
  launchWindowsPowerShell(commandFile ? { ...payload, command: commandFile } : payload);
}

process.on("SIGTERM", () => {
  // Keep the stable process-group leader alive through the graceful phase so
  // the bridge can still prove and SIGKILL the same group if a backend ignores
  // SIGTERM before ancestry polling records it.
  if (activeWorker) {
    try { activeWorker.kill("SIGTERM"); } catch { /* already gone */ }
  }
});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { payloadText += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch (error) {
    process.stderr.write("invalid process-tree runner payload: " + error.message + "\n");
    process.exitCode = 127;
    return;
  }

  const launch = (command, args, allowWindowsFallback) => {
    let worker;
    try {
      worker = spawn(command, args, {
        cwd: process.cwd(),
        env: process.env,
        windowsHide: true,
        stdio: [payload.stdinText === undefined ? "ignore" : "pipe", "inherit", "inherit"],
      });
    } catch (error) {
      if (allowWindowsFallback && process.platform === "win32") {
        launchWindowsFallback(payload, error);
        return;
      }
      process.stderr.write(error.message + "\n");
      process.exitCode = 127;
      return;
    }
    activeWorker = worker;
    let failed = false;
    worker.once("error", (error) => {
      if (failed) return;
      failed = true;
      if (allowWindowsFallback && process.platform === "win32") {
        launchWindowsFallback(payload, error);
        return;
      }
      process.stderr.write(error.message + "\n");
      process.exitCode = 127;
    });
    worker.once("exit", (code) => {
      if (!failed) recordWorkerExit(worker, code);
    });
    if (worker.stdin) {
      // A valid backend may exit without reading stdin. Its exit code, not an
      // asynchronous EPIPE on the parent-side pipe, is authoritative.
      worker.stdin.on("error", () => {});
      worker.stdin.end(payload.stdinText);
    }
  };

  if (typeof payload.command !== "string" || !Array.isArray(payload.args) ||
      payload.command.includes("\0") || payload.args.some((argument) =>
        typeof argument !== "string" || argument.includes("\0"))) {
    process.stderr.write("invalid process-tree runner command\n");
    process.exitCode = 127;
    return;
  }
  launch(payload.command, payload.args, true);
});
