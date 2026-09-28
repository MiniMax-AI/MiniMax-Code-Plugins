#!/usr/bin/env node
/**
 * MCode Trajectory Studio entry point.
 *
 *   node server/main.mjs              # MCP over stdio (used by mcode)
 *   node server/main.mjs --serve      # Trajectory Studio panel only
 *   node server/main.mjs --doctor     # print data-source diagnostics and exit
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { isNodeSupported, isWithinVerifiedRange, nodeFloorMessage, NODE_FLOOR_TEXT, VERIFIED_RANGE_TEXT } from './node-version.mjs';
import { openStore, resolveDataDir, resolveHomeDir } from './store.mjs';
import { resolveRedactRoots } from './config.mjs';
import { createHandler, serveStdio } from './mcp.mjs';
import { createStudio } from './http.mjs';

function parseArgs(argv) {
  const args = { mode: 'stdio', port: null, sessionId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--serve' || token === '--http') args.mode = 'serve';
    else if (token === '--doctor') args.mode = 'doctor';
    else if (token === '--stdio') args.mode = 'stdio';
    else if (token === '--port') args.port = Number.parseInt(argv[++index] ?? '', 10);
    else if (token === '--session') args.sessionId = argv[++index] ?? null;
  }
  return args;
}

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
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
