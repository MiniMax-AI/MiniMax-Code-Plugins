#!/usr/bin/env node
/**
 * MCode Trajectory Studio entry point.
 *
 *   node server/main.mjs              # MCP over stdio (used by mcode)
 *   node server/main.mjs --serve      # Trajectory Studio panel only
 *   node server/main.mjs --doctor     # print data-source diagnostics and exit
 *   node server/main.mjs --help       # print usage and exit
 *
 * An unrecognised flag, or a flag whose value is missing, is an error: it names the
 * offending token, prints the usage on stderr and exits non-zero. Silently falling
 * back to the default mode is the failure mode this replaced — it answered a request
 * for diagnostics with a silent stdio server and a success code.
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { isNodeSupported, isWithinVerifiedRange, nodeFloorMessage, NODE_FLOOR_TEXT, VERIFIED_RANGE_TEXT } from './node-version.mjs';
import { openStore, resolveDataDir, resolveHomeDir } from './store.mjs';
import { resolveRedactRoots } from './config.mjs';
import { createHandler, serveStdio } from './mcp.mjs';
import { createStudio } from './http.mjs';

/**
 * A command line this entry point cannot parse.
 *
 * Its own type so the handler can tell "the user mistyped a flag" from "the server
 * failed". The first deserves a sentence and the usage; the second deserves a stack.
 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * The command line, as this Plugin's own entry point reads it.
 *
 * Parsed strictly, because the alternative is worse than a crash. Every token this
 * does not recognise used to be dropped and every missing value used to be filled
 * with `null`/`NaN`, after which the process started the default stdio server and
 * exited `0`. Six wrong invocations were indistinguishable from a correct one:
 * a mistyped `--doctr`, a `--port` with no value, a `--session` with no value,
 * and `--help` all produced no output and a success code. A user who asked the
 * Plugin for diagnostics and got silence had no way to tell the Plugin had not
 * answered from the Plugin having nothing to say.
 *
 * So: an unknown flag and a missing value are both errors, and `--help` is a real
 * flag with a real answer rather than a token to ignore.
 *
 * @returns {{mode: string, port: number|null, sessionId: string|null, help: boolean}}
 * @throws {UsageError} on anything it cannot parse. The message names the offending
 *   token so the caller is told what to fix rather than merely that something is wrong.
 */
export function parseArgs(argv) {
  const args = { mode: 'stdio', port: null, sessionId: null, help: false };
  /**
   * The value that follows a flag, or an error naming what was missing.
   *
   * A token that is itself a long flag is *not* a value. `--session --doctor` used to
   * read `--doctor` as the session id, which silently turned a request for
   * diagnostics into a stdio server that printed nothing — the two flags are both
   * recognised, so nothing anywhere reported a problem.
   *
   * Only `--` counts. A single dash is left alone so `--port -1` reaches the port
   * check and is told the value is out of range, rather than being told there was no
   * value when one was plainly typed. A bare `-x` is still rejected as an unknown
   * argument when it stands on its own.
   */
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new UsageError(`${flag} needs a value`);
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (HELP_FLAGS.has(token)) {
      args.help = true;
    } else if (MODE_FLAGS.has(token)) {
      args.mode = token === '--http' ? 'serve' : token.slice(2);
    } else if (VALUE_FLAGS.has(token)) {
      const raw = value(index, token);
      index += 1;
      if (token === '--port') {
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new UsageError(`--port must be a number between 0 and 65535, got "${raw}"`);
        }
        args.port = parsed;
      } else {
        args.sessionId = raw;
      }
    } else {
      throw new UsageError(`unknown argument: ${token}`);
    }
  }
  return args;
}

/**
 * Every flag this entry point accepts, in one place.
 *
 * `USAGE` is written by hand and these are used to read the command line, so the two
 * could drift: `--http` and `-h` were both accepted while the help text that claims
 * to describe the surface listed neither. Help is the CLI's contract, and a contract
 * that omits half the surface is a lie told to exactly the person who has no other
 * way to see it. Exported so `cli-args.test.mjs` can walk the real set and fail when
 * a flag is added here and forgotten there.
 */
export const MODE_FLAGS = new Set(['--serve', '--http', '--doctor', '--stdio']);

export const VALUE_FLAGS = new Set(['--port', '--session']);

export const HELP_FLAGS = new Set(['--help', '-h']);

const USAGE = `mcode-trajectory-studio — read-only session trajectory inspection

  node server/main.mjs [--stdio]        MCP over stdio (what mcode launches; the default)
  node server/main.mjs --serve          Trajectory Studio panel only
  node server/main.mjs --http           alias for --serve
  node server/main.mjs --serve --port N bind the panel to a specific port
  node server/main.mjs --serve --session ID   open the panel focused on one session
  node server/main.mjs --doctor         print data-source diagnostics as JSON, then exit
  node server/main.mjs --help, -h       print this message

The panel listens on 127.0.0.1 only and needs no writes; it requires a
per-process capability, so use the URL exactly as printed, including its #t= fragment.
`;

export function bootstrap({ env = process.env, homeDir } = {}) {
  const dataDir = resolveDataDir(env, homeDir);
  // Resolved once, with the same HOME/USERPROFILE fallback the data directory uses,
  // so home-prefix redaction works on Windows too.
  const home = resolveHomeDir(env, homeDir);
  // The roots folded to `~` on every egress: the home directory, the data directory
  // (which is the one absolute path this Plugin names on purpose) and anything the
  // operator added. Resolved once so every surface folds the same set.
  const redactRoots = resolveRedactRoots(env, dataDir);
  const warnings = [];
  const store = openStore({ dataDir, warnings });
  // Deliberately no PLUGIN_DATA: the panel keeps its capability in memory and
  // writes nothing, so there is no per-plugin state to place on disk.
  const studio = createStudio({ store, homeDir: home, redactRoots });
  const handler = createHandler({ store, studio, homeDir: home, redactRoots });
  return { dataDir, home, redactRoots, store, studio, handler };
}

async function doctor(context) {
  const { dataDir, redactRoots, store } = context;
  const sessions = store.listSessions({ limit: 5 });
  const [latest] = sessions;
  const stats = latest ? store.getStats(latest.sessionId) : null;
  return {
    node: process.version,
    nodeFloor: NODE_FLOOR_TEXT,
    nodeVerifiedRange: VERIFIED_RANGE_TEXT,
    dataDir,
    // The file actually opened on this machine, not the canonical guess.
    sqlitePath: store.sqliteFile,
    sqliteAvailable: Boolean(store.db),
    ftsAvailable: store.hasFts,
    sessionsRoot: store.sessionsRoot,
    // Printed verbatim, unlike every other surface: this is the diagnostic a user
    // reads and decides for themselves whether to share, so folding the paths here
    // would remove the only information that makes it useful.
    redactRoots,
    sessionsVisible: sessions.length,
    latestSession: latest ? { sessionId: latest.sessionId, title: latest.title, agent: latest.agent } : null,
    latestStats: stats
      ? {
          turns: stats.turns,
          steps: stats.steps,
          llmMs: stats.llmMs,
          toolMs: stats.toolMs,
          decodeMs: stats.decodeMs,
          ttftMs: stats.ttftMs,
          toolCalls: stats.toolCalls,
          compactions: stats.compactions,
          subagentTasks: stats.subagentTasks,
        }
      : null,
    warnings: store.warnings,
    ...(store.warningsDropped > 0 ? { warningsDropped: store.warningsDropped } : {}),
  };
}

async function main() {
  // Before anything else, so a too-old runtime gets a sentence rather than a
  // module-resolution stack trace.
  if (!isNodeSupported()) {
    process.stderr.write(nodeFloorMessage());
    process.exitCode = 1;
    return;
  }
  if (!isWithinVerifiedRange()) {
    // Not fatal: the Plugin degrades rather than refusing to run outside the host
    // range it is tested against. A warning is honest about which that is.
    process.stderr.write(
      `[trajectory-studio] Node.js ${process.versions.node} is outside the verified range ` +
      `${VERIFIED_RANGE_TEXT} (mcode's own engines field, and the range where the bundled ` +
      `SQLite has FTS5). Continuing, with reduced fidelity.\n`);
  }

  const args = parseArgs(process.argv.slice(2));

  // Before anything is opened. Answering a help request must not read the projection,
  // and a bad flag must not leave a database handle behind on the way out.
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const context = bootstrap();

  if (args.mode === 'doctor') {
    process.stdout.write(`${JSON.stringify(await doctor(context), null, 2)}\n`);
    context.store.close();
    return;
  }

  if (args.mode === 'serve') {
    const started = await context.studio.start({ sessionId: args.sessionId, port: args.port });
    process.stdout.write(`Trajectory Studio listening on ${started.url} (read-only, 127.0.0.1)\n`);
    return;
  }

  await serveStdio(context.handler);
  // mcode closing the MCP pipe ends the process; the panel must not keep it alive.
  await context.studio.stop();
  context.store.close();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    // A bad command line is a user error, not a crash: it names the token and prints
    // the usage, and exits non-zero so a script sees the failure. The previous shape
    // answered every one of these with silence and exit `0`.
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
