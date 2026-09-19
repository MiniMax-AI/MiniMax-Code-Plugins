# Dynamic Workflow

Turn a complex task into a reviewable multi-agent workflow. Inspect and edit the topology before execution, follow each agent's progress and output, then repair a failed script without discarding valid completed work.

Version **0.8.0** · Apache-2.0 · one English Skill and one local MCP server with 11 tools.

## Try it

After installing and enabling this plugin, start a new MCode conversation in your project:

> Use dynamic-workflow to create a demo with two parallel research branches and a synthesis step. Open its dashboard so I can review the topology before starting.

Expected result: a local dashboard opens in the host's built-in browser when that capability is available. The workflow stays **Pending review** until you click **Start execution**. Demo mode produces simulated results and makes no model calls.

For real work:

> Use dynamic-workflow to review this project's correctness and security independently, verify the findings, and produce an evidence-based report. Let me review the workflow before execution.

To fix an interrupted task:

> Diagnose this workflow's error, repair its script, reuse only results that are still valid, and open a new review draft.

The dashboard includes Chinese/English switching (system language by default), a dependency graph with all known nodes, detailed input/output/error inspection, configurable budgets, and HTML/Markdown report downloads. Browser support is a host capability; without it, the Skill provides the local dashboard URL.

## Requirements and installation

- An MCode host that supports local stdio MCP and Skills. Both the portable `plugin.json`/`mcp.json` contract and a `.claude-plugin/plugin.json` manifest are included. Real-agent execution requires the `mcode exec` protocol; development verification used MCode 0.4.8+, not every older host version.
- Node.js **22.19+ in the 22.x line, or 24–26**, available as `node` on the MCP host's PATH. Node's SQLite module is required.
- Real execution requires an already installed MCode CLI, working authentication/provider configuration, network access and model quota. Your provider may charge for calls. Demo mode requires none of those.
- macOS is locally tested. Windows and Linux code paths are provided but real CLI/host installation on those platforms has not been verified for this submission.

Install this plugin folder through your host's local plugin workflow. Its MCP entry starts `node ./dist/main.mjs --stdio` with the plugin root as its working directory. All runtime JavaScript and portable QuickJS WebAssembly are bundled; **no npm install is required to use the plugin**. No OS-native executable, CLI installer, or automatic download is included. Install Node/MCode separately using their official distributions if missing. A private Node bundled with a CLI may not be available to the MCP host.

Do not enable another copy of Dynamic Workflow alongside this one in the same host. Services and data are scoped by project, not by distribution channel; another version can reuse an already running service. If `WORKFLOW_SERVICE_UPGRADE_REQUIRED` appears, pause/cancel active runs and explicitly stop the project service with the new bundle's `--stop-service`, keeping the same `--workspace` and `--data-dir`, then reconnect MCP. Closing a chat alone does not restart a service.

## Review, execution and repair

1. The host agent writes a bounded JavaScript orchestration script and submits a draft.
2. Review/edit the script, input, topology and budgets in the dashboard, then start it yourself.
3. Independent agents run with configurable concurrency; dependent tasks wait for successful prerequisites. Defaults are four concurrent agents per workflow, 120 model steps and 30 minutes per agent, and 120 minutes per workflow.
4. Pause/cancel stops dispatch and waits for bounded cleanup of in-flight CLI process trees. Ordinary descendants are stopped together (a dedicated process group on macOS/Linux; `taskkill /T /F` on Windows). If cleanup cannot be confirmed, the run enters `needs_attention`, keeps the diagnostic and CLI PID, and requires stopped-agent confirmation before resume or repair. Explicitly detached daemons and remote jobs are outside this ownership boundary; do not start them from workflow nodes. **Resume** replays the unchanged script and reuses successful steps; failed agents restart, rather than continuing their old sessions.
5. **Edit & repair** retains the original run and creates a new pending-review version. Select results known to remain valid; selection is opt-in and can be reduced during review. Runtime arguments, inputs, executor, workspace, tracked files and reused dependencies must still match. A changed or rerun upstream invalidates downstream reuse. Reused nodes link to their original run without double-counting calls or tokens.

Tracked files are regular workspace files (up to 1 MB each), fingerprinted from their exact bytes so binary changes invalidate reuse.

The repaired script runs from its beginning; checkpoints are recomputed and unreached branches are not premarked complete. Declare every data/control dependency in `dependsOn`. Untracked files, external evidence and side effects cannot be checked automatically, so stale or incorrect results must not be selected for reuse. Schema-constrained outputs accept native values, complete JSON text, or one complete JSON fence; validation errors preserve the raw output. Each node has an independent schema namespace, including local references, so repeated schema identifiers cannot conflict across nodes or runs.

## Cross-run reuse

Stored results are normally reused only within a run (resume) or through explicit repair selection. Passing `reuseAcrossRuns: true` to `workflow_start`, or setting it while a draft is pending review, additionally lets a node adopt a stored result from an earlier run of the same project. Adoption requires the node's full spec to hash identically (prompt, model, effort, input, schema, dependencies) and the run context to match on all four keys — workspace, input, executor and tracked-file fingerprints. The node's upstream lineage must match too: every step carries a lineage hash over its own spec and the lineage hashes of its declared dependencies in order, so a changed upstream (for example an edited upstream prompt) invalidates downstream candidates even when their own specs are unchanged. mcode nodes must declare an explicit model to be cross-run candidates — the default model comes from the CLI environment and is not part of the match key. Only runs executed with this feature stamp the context and lineage hashes on their steps, so legacy runs are not candidates. Adopted outputs are re-validated against the node's current schema; the step records provenance in `reusedFrom` — the immediate source run and step, `crossRun: true` — and in `originalProducer`, the run and step that originally produced the output, so chained adoptions stay traceable to their origin; it emits a `step.reused` event, and does not consume the workflow's agent-call budget.

Reuse proves only that the context was identical and that the stored result was carried over faithfully — it does not prove the original run's output was semantically correct. For critical nodes, prefer schemas with evidence fields or place an independent verification node downstream, and keep `reuseAcrossRuns` off when in doubt.

## Data, permissions and network

- Every project-scoped tool requires an absolute `workspace`; plugin process cwd is never treated as your project. Canonical project paths isolate runs, templates, history, limits and ports. Never use an unrelated project's path.
- State is stored in `~/.mcode-dynamic-workflows/projects/<sha256-of-canonical-project-path>/` by default. It includes scripts, inputs, prompts, raw outputs, reports, errors, session references, usage and reusable result snapshots in SQLite, plus service logs and the saved loopback address. It persists across chats/restarts; remove a project's data only after stopping its service and preserving anything needed.
- The server binds only to `127.0.0.1`. It uses same-origin checks and a custom request header, not an authentication token. Other local processes can access it; this is not an isolation boundary between OS users. Do not expose or forward the port.
- Dashboard assets and reports are local. This plugin has no telemetry, remote MCP endpoint, hardcoded model service, or automatic installer. Development-only `npm ci` downloads dependencies from `registry.npmjs.org`.
- Real agents run through the user's MCode CLI with its configured provider, tools and smart permissions. Project materials and prompts may be sent to that provider; agents may access other destinations and modify files as the task permits. These destinations depend on the user's configuration and task. Credentials remain managed by the CLI; the plugin does not ask for or store credentials, but prompts/outputs/logs can contain sensitive information supplied by users or tools.
- QuickJS isolates the orchestration script from direct Node/file/network access. **The spawned MCode agents are not an OS sandbox** and do not inherit the full parent conversation. Review prompts, budgets, side effects and permissions before execution or retries.
- A lifetime SQLite lock enforces one state owner even if a discovery lockfile is lost. The run list prioritizes active runs and recovery attention within its 100-entry window; crash recovery inspects every unfinished run.
- Tamper evidence: the append-only `events` and `repair_cache` surfaces each carry a SHA-256 hash chain whose per-row links are written in the same transaction as the insert. Digests bind each row's identity (`runId` plus `seq`/`id`) as well as its body, so moving a row to another run is detected like any body edit. The ledger lives in the same SQLite database as the data it covers: it is in-database tamper evidence, not an independent trust anchor. A party able to rewrite the whole database can also recompute the ledger and heads, so `verified: true` must not be read as proof against that attacker. What it does catch is accidental edits, partial rewrites, and tooling mistakes that leave the ledger inconsistent with the rows. `workflow_status` with `verifyIntegrity: true` recomputes both chains and returns heads, per-face verdicts and the first divergence. Verification covers the anchored prefix; any unanchored row fails closed (`unchained > 0` → `verified: false`). The default run list stays a plain JSON array; the object form with `integrityHeads` is only returned for `verifyIntegrity: true`.
- The project service and approved workflows survive a chat disconnect. No OS autostart is installed; machine shutdown interrupts execution. After abnormal termination, verify old agents have stopped before recovery.

## Source, build and tests

`src/` contains the engine, SQLite store, project router, executor and HTTP/MCP service. `web/` contains dashboard sources and the bundled browser entry. `dist/` contains the ready-to-run JavaScript and a portable QuickJS WASM asset, verified against the pinned npm package during builds. Licenses are in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

To rebuild, copy this plugin directory to a development location outside the registry checkout, then run:

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm run build
npm test
npm run test:package
```

The dev-only source checks use the pinned dependencies. They live in `checks/*.check.mjs` so the registry's dependency-free test discovery does not require a second dependency installation. `test/package.test.mjs` runs directly from the committed bundle and is included in the repository's `npm run check`.

Verification covers isolated demo execution, approval gating, selective reuse and invalidation, project routing, persistence, parsing, local HTTP protections and UI behavior. Controlled executors are not evidence of live model correctness, account authorization or provider availability. No paid model calls or user research reruns were used for this contribution.

## MCP tools

`workflow_validate`, `workflow_start`, `workflow_update`, `workflow_repair`, `workflow_status`, `workflow_results`, `workflow_wait`, `workflow_pause`, `workflow_cancel`, `workflow_resume`, `workflow_dashboard`.

Read the [Skill](skills/dynamic-workflow/SKILL.md), [English example](examples/audit-en.js) and [Chinese example](examples/audit.js). The dashboard is a local web page, not a native Mini App or TUI extension.
