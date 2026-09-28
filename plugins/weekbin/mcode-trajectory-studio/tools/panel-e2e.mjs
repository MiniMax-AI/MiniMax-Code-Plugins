#!/usr/bin/env node
/**
 * Panel end-to-end harness: seed a hostile session, serve the panel, print the URL.
 *
 * This is not part of `node --test` by default, because the default mode exists to
 * produce the evidence a unit test cannot: that a payload which *would* execute if
 * the client ever built markup from a string does not execute in a real browser, and
 * that a credential planted in a title, a task command and a tool argument reaches
 * the page already redacted.
 *
 * `--smoke` runs the half of that a machine can judge, over a real socket rather than
 * a stub `req`/`res`: the panel boots, serves its document, refuses an API call
 * without the capability, answers one with it, and returns the planted credential
 * and markup payloads as escaped data. It exits with a status, so it is usable as a
 * CI step — the interactive mode holds a fixture until SIGINT and would hang a job.
 *
 * Usage:
 *   node tools/panel-e2e.mjs [--port 7421] [--keep]   # interactive; open the URL
 *   node tools/panel-e2e.mjs --smoke                  # self-checking, exits
 *
 * Then open the printed URL in a browser and check:
 *   window.__XSS === undefined
 *   document.querySelectorAll('img').length === 0
 *   document.body.textContent.includes('<img src=x onerror=')
 *
 * `--keep` leaves the fixture directory behind for inspection.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { bootstrap } from '../server/main.mjs';
import { createFixtureProjection, FIXTURE_WORKSPACE } from './fixture.mjs';

/**
 * The payloads. None of them matches a credential pattern, so redaction leaves them
 * intact — which is what makes this a render test rather than a redaction test.
 */
const IMG_PAYLOAD = '<img src=x onerror="window.__XSS=1">';
const SCRIPT_PAYLOAD = '"><script>window.__XSS=2</script>';
const SVG_PAYLOAD = '<svg onload="window.__XSS=3">';

/** A credential, to prove the pipeline scrubs it before the page sees it. */
const SECRET = 'ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

function parseArgs(argv) {
  const args = { port: 7421, keep: false, smoke: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') args.port = Number.parseInt(argv[++index] ?? '', 10);
    else if (argv[index] === '--keep') args.keep = true;
    else if (argv[index] === '--smoke') args.smoke = true;
  }
  return args;
}

async function seed(dataDir) {
  const projection = await createFixtureProjection(dataDir);
  const now = 1_700_000_000_000;
  // The newest session is the one the panel selects on load, so every payload
  // renders without anyone having to click anything.
  projection.session({
    id: 'sess-render-e2e',
    title: `XSS canary with a credential ${SECRET} in the title`,
    updatedAtMs: now,
    workspaceDir: FIXTURE_WORKSPACE,
  });
  projection.row({
    sessionId: 'sess-render-e2e', msgId: 'e2e-1', role: 'user', turnId: 'turn-1', createdAtMs: now - 900,
    data: {
      msg_id: 'e2e-1', role: 'user', source: 'api', msg_type: 1, turn_id: 'turn-1',
      msg_content: `Please render this literally: ${IMG_PAYLOAD}`,
    },
  });
  projection.row({
    sessionId: 'sess-render-e2e', msgId: 'e2e-2', role: 'assistant', turnId: 'turn-1', createdAtMs: now - 800,
    data: {
      msg_id: 'e2e-2', role: 'assistant', source: 'api', msg_type: 2, turn_id: 'turn-1',
      msg_content: `Handled ${SVG_PAYLOAD}`,
      thinking_content: `thinking about ${IMG_PAYLOAD}`,
      finish_reason: 'toolUse',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, request_duration_ms: 100 },
      tool_calls: [{
        tool_call_id: 'call-1',
        tool_name: 'bash',
        tool_call_args: { command: `printf '${SCRIPT_PAYLOAD}'`, token: SECRET },
        tool_call_result_data: `exit 0 ${IMG_PAYLOAD}`,
        tool_call_status: 2,
      }],
    },
  });
  projection.task({
    taskId: 'task-e2e', sessionId: 'sess-render-e2e', status: 'failed',
    createdAtMs: now - 850, endedAtMs: now - 700,
    record: {
      description: `curl -H 'Authorization: Bearer ${SECRET}' https://example.invalid ${IMG_PAYLOAD}`,
      toolCallId: 'call-1',
      metadata: { command: `curl --token ${SECRET} ${IMG_PAYLOAD}` },
    },
  });
  projection.close();
}

/**
 * The machine-checkable half of the harness, over a real loopback socket.
 *
 * Each check below corresponds to a claim that would otherwise only be made in
 * prose. Nothing here asserts anything about the browser's rendering — that is still
 * the interactive mode's job — so the scope is honest about what it does prove: the
 * panel boots and binds, the document is served under the hardening headers, the
 * capability is required and sufficient, and a payload that would execute if the
 * client built markup from a string reaches the wire as data.
 */
async function smoke(context, started) {
  const problems = [];
  const base = `http://127.0.0.1:${started.port}`;
  const capability = new URL(started.url).hash.replace(/^#t=/, '');

  const document = await fetch(`${base}/`, { headers: { host: `127.0.0.1:${started.port}` } });
  const html = await document.text();
  if (document.status !== 200) problems.push(`GET / answered ${document.status}`);
  if (!/default-src 'none'/.test(String(document.headers.get('content-security-policy')))) {
    problems.push('GET / served without the deny-by-default CSP');
  }
  if (document.headers.get('referrer-policy') !== 'no-referrer') {
    problems.push('GET / served without no-referrer');
  }

  // The capability: absent, and wrong, must both be refused.
  const noToken = await fetch(`${base}/api/sessions`, { headers: { host: `127.0.0.1:${started.port}` } });
  if (noToken.status !== 403) problems.push(`an API call without the capability answered ${noToken.status}, not 403`);
  const wrongToken = await fetch(`${base}/api/sessions`, {
    headers: { host: `127.0.0.1:${started.port}`, 'x-trajectory-token': 'wrong-capability' },
  });
  if (wrongToken.status !== 403) problems.push(`a wrong capability answered ${wrongToken.status}, not 403`);

  const authed = await fetch(`${base}/api/sessions`, {
    headers: { host: `127.0.0.1:${started.port}`, 'x-trajectory-token': capability },
  });
  const body = await authed.text();
  if (authed.status !== 200) problems.push(`an authorised API call answered ${authed.status}: ${body}`);

  // The credential planted in the session title must not reach the wire.
  if (body.includes(SECRET)) problems.push('the planted credential reached the panel response');

  // The markup payloads are stored as message text and task commands; they may
  // appear in a JSON body as strings, but they must never be served as part of the
  // document, where the parser would act on them.
  if (html.includes(IMG_PAYLOAD) || html.includes(SCRIPT_PAYLOAD) || html.includes(SVG_PAYLOAD)) {
    problems.push('a stored payload was interpolated into the served document');
  }

  const full = await fetch(`${base}/api/events?id=sess-render-e2e&detailLevel=full`, {
    headers: { host: `127.0.0.1:${started.port}`, 'x-trajectory-token': capability },
  });
  const fullBody = await full.text();
  if (full.status !== 200) problems.push(`GET /api/events answered ${full.status}: ${fullBody}`);
  if (fullBody.includes(SECRET)) problems.push('the planted credential survived into full-detail events');
  // It is not redaction's job to remove markup from message text — it is the client's,
  // and the client builds nodes rather than parsing a string. What is checked here is
  // that the payload is *delivered as data*, which is what makes that safe. The
  // attribute value is matched rather than the whole payload because a JSON body
  // escapes the quotes inside it, and matching the raw payload would pass by accident
  // or fail for a reason that has nothing to do with the harness.
  if (!fullBody.includes('window.__XSS=1')) {
    problems.push('the harness fixture no longer carries its payload into full detail; this check is stale');
  }
  if (fullBody.includes('\\"onerror\\"')) {
    problems.push('a payload reached the client as markup rather than as a string');
  }

  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = await mkdtemp(path.join(tmpdir(), 'trajectory-e2e-'));
  await seed(dataDir);

  const context = bootstrap({ env: { ...process.env, MINIMAX_DATA_DIR: dataDir } });
  // Smoke binds an ephemeral port: a fixed one collides with a leftover interactive
  // instance, and CI runners are not a machine with one job on it.
  const started = await context.studio.start({ port: args.smoke ? 0 : args.port });

  const shutdown = async () => {
    await context.studio.stop();
    context.store.close();
    if (!args.keep) await rm(dataDir, { recursive: true, force: true });
  };

  if (args.smoke) {
    let problems = [];
    try {
      problems = await smoke(context, started);
    } finally {
      await shutdown();
    }
    if (problems.length > 0) {
      process.stderr.write(`${problems.length} panel smoke failure(s):\n`);
      for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('panel smoke: 8 checks passed over a real loopback socket\n');
    return;
  }

  process.stdout.write([
    'Trajectory Studio E2E fixture',
    `  data dir : ${dataDir}`,
    `  sqlite   : ${context.store.sqliteFile} (available: ${Boolean(context.store.db)}, fts: ${context.store.hasFts})`,
    `  sessions : ${context.store.listSessions({ limit: 5 }).length}`,
    `  panel    : ${started.url}`,
    '',
    'The panel opens in summary detail, so no message text is fetched yet. On load:',
    "  document.getElementById('full-detail').checked === false",
    '  window.__XSS === undefined',
    "  document.querySelectorAll('img').length === 0",
    '  no credential canary in document.body.innerHTML (the title is already [redacted])',
    '',
    'Then tick 显示正文 and re-check — the payloads must render as *literal text*:',
    '  document.body.textContent includes each of the three payloads verbatim',
    "  document.querySelectorAll('*') has no attribute starting with 'on'",
    '  window.__XSS === undefined',
    "  document.querySelectorAll('img').length === 0",
    '',
    'This harness holds the fixture until SIGINT. Run it under a tool that drives a',
    'browser, then stop it.',
    '',
  ].join('\n'));

  process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
