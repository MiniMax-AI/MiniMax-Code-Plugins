---
name: dynamic-workflow
description: Plan and coordinate complex tasks as editable JavaScript workflows with multiple MCode agents. Create a pending-review draft, automatically open its topology in the MCode built-in browser, let the user edit and start it, then track parallel research, code reviews, batch processing, verification, and synthesis with live statuses, logs, results, configurable budgets, pause, cancel, resume, and error-guided repair with reviewed reuse of successful results.
---

# Dynamic Workflow

Use this skill when the user explicitly requests a workflow, a batch of independent tasks, or visual multi-agent orchestration. Do not expand an ordinary small task into a workflow. Communicate with the user and write task-facing labels and reports in the user's language, even though these instructions are in English.

## Project binding

Before using workflow tools, obtain the actual project directory from the current host session or the user's explicit target. Verify it is an existing absolute directory. If the task has no known project, ask the user for one. Never infer the project from this Skill location, `PLUGIN_ROOT`, the MCP process working directory, or a previous workflow.

The normal plugin MCP entry is a project router. Every tool except `workflow_validate` requires `workspace`. Pass the same explicit project path to `workflow_dashboard`, `workflow_start`, and all status, edit, result, wait, pause, cancel, and resume calls. Multiple projects can share one MCP connection; never rely on a last-selected project. Check the returned dashboard `workspace` and draft `workspace` against the intended project before opening or executing it. A run ID belongs to its original project and cannot be resumed in another project.

Project services, history, templates, budgets and saved ports are isolated under `~/.mcode-dynamic-workflows/projects/<canonical-path-sha256>/`. No history is automatically moved from legacy service directories. A manually configured `--workspace` / `settings.workspace` MCP connection retains its fixed-project behavior; its tools do not require a workspace argument.

If MCP tools are unavailable, report the connection error and stop workflow submission. Do not silently replace the requested visual workflow with raw parallel CLI calls. To diagnose a missing entry point, check `<plugin-root>/dist/main.mjs` directly using the exact root derived from this Skill location; official cache directories are digest-named and cannot be discovered by globbing for the plugin name.

## Workflow

1. Before real execution, complete the dependency preflight below. Demo runs may skip it. Call `workflow_dashboard` for the current service's dashboard URL. Report connection failures; never invent a working page.
2. Establish the user's goal, permitted operations, input materials, and budget. Ask only for necessary missing information. Use `mcode` for real execution; explicitly label simulations as `demo`.
3. Write an asynchronous JavaScript function body without `import` or `export`. The only business interfaces are `ctx.agent`, `ctx.map`, `ctx.phase`, `ctx.log`, and `ctx.checkpoint`. `input` is frozen JSON.
4. Give each step a stable `id`, `label`, and `phase`. Describe upstream dependencies with an ID array such as `dependsOn: ["scope"]` (a single ID string is also supported), using the IDs you assigned; await successful upstream results before dispatching dependent steps. Declare known phases first. Additional tasks appear as the script creates them.
5. `ctx.agent` returns `status`, `output`, and `error`; always check `status`. A failed independent verification does not disprove the original finding. Record uncovered files and unverified claims in the final report.
6. Call `workflow_validate` to obtain a static structure preview, then submit `requestId`, `name`, `script`, `input`, `metadata`, and `executor` through `workflow_start`. This creates a durable `pending_review` draft and does not run agents. Reuse the same `requestId` when retrying the same submission. Immediately follow **Open the dashboard automatically** below to open this run in MCode's built-in browser. Tell the user to inspect the topology and click **Start execution** when ready; do not ask whether to open the dashboard. Do not approve through HTTP, shell, browser automation, or another tool on the user's behalf. Stop waiting while the run is pending review; do not poll or claim execution has begun. If the user requests edits, use `workflow_update` with the current `revision`; it regenerates the topology and remains pending review. Users can also edit the script, full JSON input, and budgets in the dashboard. Only unstarted drafts are directly editable; use the repair flow below for a run that already executed.
7. The default per-workflow concurrency is four agents (configurable from 1–16); the service-wide default is eight (the dashboard supports 1–32). Eligible workflows receive free slots in round-robin order. Lowering a limit does not interrupt running agents. Defaults are 120 model steps and 30 minutes per agent. For larger tasks, set `maxSteps`, `stepTimeoutMs`, `runTimeoutMs`, and `maxCalls` explicitly on `workflow_start`. Model steps and workflow agent calls are different limits. Keep the scope bounded and reserve budget for the final answer. After the user starts execution, wait for changes with `workflow_wait` and `afterSequence`; avoid frequent polling. Use `workflow_status` for details and paginate `workflow_results`.
8. Use the corresponding tools when the user requests pause, cancellation, or resume. Read `errorDetails` first and explain the specific cause: agent step limit, agent timeout, workflow timeout, CLI/authentication failure, or protocol error. Do not describe every failure as a timeout. Resume accepts updated `maxSteps`, `stepTimeoutMs`, `runTimeoutMs`, and `maxCalls`. Resume only when authorized by the user. Failed nodes restart from scratch; this is not continuation of their original MCode sessions. Treat `MCODE_CLEANUP_UNCONFIRMED` / `needs_attention` as a cleanup failure, not a completed cancellation. Report its PID and diagnostic; do not retry, repair, or start replacement work before old agents have been checked. Do not launch detached daemons or remote background jobs from workflow nodes: local process-tree cancellation cannot own them. After an abnormal crash or uncertain cleanup, do not assert `confirmStopped` yourself: first obtain the user's confirmation that the old agents have stopped.
9. A queued node may be waiting for the configurable service-wide agent limit (eight by default) across all workflows, or for its own workflow concurrency limit. Read `queueInfo` in `workflow_status` to explain the reason and which runs hold slots; do not equate queued with failure. Static topology is derived without executing the script: loops and callbacks are groups, conditional branches may not run, and inferred edges are not a guarantee of execution order. Review the source when aliases or dynamic references cannot be resolved.
10. Deliver the actual phases, node results, sources, coverage gaps, and local URL returned by `workflow_dashboard`. Never present fixed demo output as model-generated findings.

## Repair a workflow after an execution error

If a newly installed plugin reports `WORKFLOW_SERVICE_UPGRADE_REQUIRED`, the persistent project service is still running older code. Do not fall back to a new workflow or retry unsupported calls. Explain the mismatch; obtain authorization before stopping/restarting the service, stop active work through its normal controls first, and use the new bundle with `--stop-service` and the exact project workspace/data directory. Reconnect MCP afterward; the saved port and history remain. Closing a chat alone does not upgrade the service.

Use `workflow_resume` only when the original script and inputs remain correct and the user authorizes retrying transient failures or increasing budgets. When a parsing, schema, dependency, or JavaScript error requires changing the script, use `workflow_repair` instead.

1. Read `workflow_status` and all relevant pages of `workflow_results` with `includeDefinition: true` (and the same absolute `workspace`). Inspect the exact script, raw producer output, `errorDetails`, and downstream field reads. Do not guess a repair from a generic failure banner. Stop or pause an active run before repairing it. For `needs_attention`, first resolve the uncertain old-agent state through the existing user-confirmed recovery flow.
2. Make a minimal change to the complete script. Preserve stable IDs for unchanged tasks, add schemas and guards to producers consumed as objects, and declare **every** data or control dependency in `dependsOn`. An undeclared dependency cannot be invalidated by the engine. If a branch depends on a prior result, its agents depend on that producer even when the prompt does not embed the output.
3. Supply `reason` describing the observed cause and correction, and an explicit `reuseStepIds` list. Select only successful results whose meaning, external evidence, and side effects are still valid. Default to an empty list when uncertain. A successful CLI call with malformed output is NOT a valid reusable result: leave that producer out or change its schema/prompt, and rerun affected descendants. Never add a failed node to the list or silently treat a malformed result as correct. Files used by agents should be declared in `input.files` when supported; untracked files, external services, and side effects cannot be automatically fingerprinted.
4. Call `workflow_repair` with `workspace`, source `runId`, `sourceUpdatedAt` from the latest snapshot, a stable new `requestId`, the complete `script`, `reason`, and `reuseStepIds`. Optional `input` and execution budgets may be updated. Reuse the request ID only for identical submissions. If the source changed, reread it and reassess the patch before submitting again.
5. The result is a NEW `pending_review` run with the original record intact. Immediately open its dashboard in the built-in browser as described below. Explain the patch, selected reuse candidates, and expected reruns. Let the user review/edit the new topology and click **Start execution**; never approve it through automation. Do not start or resume the original run as a workaround.

The sandbox replays the repaired script from its beginning. Only explicitly selected successful agent calls can reuse frozen results, and only when runtime arguments, full input, executor, workspace, tracked-file hashes, and all reused dependencies match. A changed or rerun ancestor forces descendants to rerun even if its new output happens to be identical. Unreached branches stay unexecuted, checkpoints are recomputed, and reused results carry their source run ID without double-counting calls/tokens. This is agent-result reuse, not continuation of JavaScript state or a failed MCode session. Candidate selection is not a guarantee of reuse.

## Structured outputs and safe downstream reads

- If a later step reads any field from an agent's output, declare a JSON `schema` on that producer. A prompt saying “return JSON” is not a contract. Use a small schema containing only the required decision fields, with explicit `required`, types, array `items`, and allowed unknown values. Put long prose and citations in separate fields or a narrative report step. Do not request JSON-like examples with omitted values or JavaScript syntax.
- Tell the producer to make its **final response** the complete schema-conforming JSON, with sources inside that JSON. It must not append a second final message, reference-document placeholder, or Markdown summary. Earlier progress messages are not the result consumed by the workflow.
- The runtime checks the native result first. For a schema-constrained result that does not already validate, it can parse one complete JSON text or one complete JSON code fence, then validates again. It does not extract arbitrary objects from prose, choose among multiple blocks, coerce field types, invent defaults, or use an earlier message instead of a failed final answer. Plain report outputs without a schema remain unchanged.
- After every `ctx.agent`, check `status === 'succeeded'` before reading `output`. Guard required nested fields before branching. Unknown listing status or missing evidence is an explicit gap, never equivalent to `false`. If a prerequisite is invalid, return a coverage-gap result without launching dependent agents; do not let a property access throw incidentally. A node failure does not erase its raw output or other successful nodes.
- `ctx.agent` returns `status`, `output`, `error`, and `errorDetails` (and may return `cached`). Do not assume it returns `id`, `label`, or arbitrary spec fields. Retain IDs yourself: `const rows = await ctx.map(tasks, async task => ({id: task.id, label: task.label, result: await ctx.agent({...task})}));`. Build dependencies from those retained IDs after checking each `result.status`; include only successful prerequisites when partial progress is meaningful, and preserve failed items in the report.
- Do not silently retry invalid output or claim that successful execution proves factual correctness. Report the step and validation reason, inspect its raw output, and obtain user direction before spending another agent call. Resume reuses successful cached outputs; changing a producer's schema or script requires a new reviewed workflow, not editing completed records.

Example of a structured decision followed by guarded access:

```js
const identified = await ctx.agent({
  id: 'identify-company', prompt: 'Identify the company from the supplied input. Return only the final JSON matching the schema, including source URLs. Use listed: null if unverified.',
  input,
  schema: {
    type: 'object', required: ['selected', 'sources'],
    properties: {
      selected: {
        type: 'object', required: ['name', 'listed'],
        properties: {name: {type: 'string', minLength: 1}, listed: {type: ['boolean', 'null']}}
      },
      sources: {type: 'array', items: {type: 'string'}, minItems: 1}
    }
  }
});
if (identified.status !== 'succeeded') {
  return {summary: 'Company identification is incomplete.', gaps: [{stepId: 'identify-company', error: identified.error, details: identified.errorDetails}]};
}
const company = identified.output?.selected;
if (!company?.name || typeof company.listed !== 'boolean') {
  return {summary: 'Listing status is unverified.', gaps: ['Do not select a listed or private-company branch until verified.']};
}
// Only now branch on company.listed and launch dependent agents.
```

## Design for review, progress, and delivery

- Include `metadata: {objective, inputDescription, deliverables}` in `workflow_start` and relevant edits. Explain the concrete goal, required input, and expected outputs before execution. `objective` and `inputDescription` are each at most 1,500 characters; `deliverables` is at most 12 nonempty strings of 300 characters. The brief belongs to the reviewed revision. Do not promise a file the workflow never creates.
- When each item has independent stages, use `ctx.map(items, async (item, i) => { ... })` and await that item's audit, then verification, inside the callback. This lets a fast item's verification proceed while another item is still being audited. Retain an aggregate barrier only for synthesis that genuinely requires all item results. This is JavaScript composition, not a separate `ctx.pipeline` API. Respect concurrency and call budgets; never launch an unbounded set of agents.
- Give every agent a self-contained prompt, necessary input, stable ID, and appropriate output schema. A worker does not implicitly inherit the main conversation. Use exact successful upstream IDs in `dependsOn`. When intentionally continuing after partial failure, filter dependencies to successful nodes and keep failed nodes and coverage gaps in the final report. A dependency declaration does not wait for upstream execution; explicitly await and check its status first. Validate every returned status and preserve gaps instead of presenting partial verification as full coverage.
- Use `await ctx.log(message, {stepId, phase})` for factual milestones: starting a task, receiving a result, finding a stated number of issues, or identifying a failed verification. Both context fields are optional; use assigned IDs. Logs are limited to 200 per execution and 4,000 characters per message. Do not log fabricated percentages, full prompts, credentials, or large raw outputs. The dashboard displays the latest progress and retains the event history.
- Return a readable structured result with the conclusion, evidence or sources when relevant, and explicit limitations. The dashboard renders structured results and offers HTML and Markdown downloads after completion, failure, interruption, or pause. Exports use persisted run and node results, identify demo runs, and include failures; they do not prove factual correctness. Download files are created only when requested in the dashboard, not silently written to an invented workspace path.
- The dashboard's **Save as template** stores the definition, current input, brief, executor, and budgets locally. It excludes run results and approval state. **Use template** opens an editable draft form; saving creates a new pending-review run. Recheck input and scope every time and leave execution approval to the user. Templates are local to this service's data directory and can be deleted without deleting run history.

## Open the dashboard automatically

Opening the dashboard is part of using this workflow Skill. Do it after creating a draft, after saving a user-requested edit, and when the user asks to inspect or continue an existing run. Navigation does not authorize starting, resuming, cancelling, changing global settings, or accepting the workflow for the user.

1. Call `workflow_dashboard` and use the exact returned local URL. Set its `run` query parameter to the actual run ID while preserving any fragment returned by a legacy service. For a new draft, open the pending-review page before yielding to the user. Do not construct a port, copy a stale URL, discard a fragment returned by a legacy service.
2. Discover the Browser Use Skill in the current host's Skill catalog (for example, `browser-use:control-in-app-browser` only if that exact name is listed). Load its complete instructions in a single dedicated tool call, wait for the result, and follow its session receipt/reload rules. Do not invent a browser skill name or tool schema.
3. Use the host's actual `mcp_browser({action, input})` tool. Follow the loaded Browser Skill's tab rules: open a new tab when an unrelated loaded page should be preserved; navigate a blank tab; inspect an already-open target before acting. Use the exact dashboard URL from step 1. Do not use the system browser, shell `open`, an external automation browser, a new MCP server, or a new Host Binding as a substitute.
4. Inspect the resulting page and confirm it shows the intended workflow name and review/execution state. For a pending draft, leave **Start execution** to the user. Report an open request as successful only after the browser confirms the page, not merely because `workflow_dashboard` returned a URL.
5. If the Browser Use Skill, its tool, or the host browser is unavailable or disabled, keep the draft, briefly explain the specific limitation, and provide the dashboard link for manual opening. Do not automatically enable another plugin or silently claim the page opened. Browser availability must not discard a valid draft.

The dashboard is a local web page, not a native Mini App. Current services return a plain loopback URL without an access token and enforce local-origin request checks. Only legacy services may return a credential fragment; preserve it for those services and do not share it publicly.

## CLI preflight (no installation)

Before real execution, use the host terminal to check `mcode --version` and `mcode exec --help`. Confirm support for `--output-format` and `--max-steps`. The service also detects an existing official user installation when PATH is stale. If the CLI is missing or incompatible, explain the prerequisite and ask the user to install or update MCode through their official distribution, then retry preflight. This community package contains no installer and must not download or execute installation scripts. Demo workflows remain available without the CLI.

An available executable does not prove authentication, network access, or model quota. Preserve existing provider, model and region settings. If execution reports an authentication error, guide the user through their existing CLI's interactive login flow; never request, read, copy or print credentials. Do not infer region from language or replace a custom provider.

Workflow Studio itself requires a compatible Node.js on the MCP host PATH: Node 22.19+ in the 22.x line or Node 24–26. A CLI-private runtime does not necessarily satisfy the MCP host requirement. Report CLI readiness and MCP startup separately.

## Example

```js
await ctx.phase({id:'check',label:'Parallel verification'});
const rows=await ctx.map(input.items,(item,i)=>ctx.agent({
  id:`check:${i}`,label:item.name,phase:'check',
  prompt:'Verify the input materials and provide supporting evidence.',input:item
}));
return {results:rows,failed:rows.filter(x=>x.status!=='succeeded').length};
```

See `examples/audit.js` in the plugin root for the complete review template. Adapt branches and verification logic to the task instead of applying a fixed agent count. Pass `model` and `effort` only when explicitly specified by the user.

## Boundaries

MCode workers use `smart` permissions. The plugin is not a read-only OS sandbox. Do not use `full` or `off` to bypass approvals. Do not claim exact inheritance of the main conversation's permissions, context, or native subagent identity. Replay reuses successful steps, but do not blindly retry unknown side effects. Current dashboard URLs are token-free loopback addresses; preserve credential fragments only when connecting to a legacy service.

Real execution requires a working MCode CLI and valid authentication or Provider configuration. If the CLI is missing, follow the setup and verification flow above. Never substitute demo output for real execution, change the user's model, or copy or store login credentials.

## Local service lifecycle

The MCP connection attaches to a persistent local service. Closing a chat or its stdio transport does not stop approved workflows or the dashboard. New installations return a plain loopback URL without an access token. The chosen port is saved in `address.json` in the data directory and reused after a service restart; an occupied saved port is an error, never a reason to silently choose another port. Use the URL returned by `workflow_dashboard`. Only an explicitly configured fixed-project connection reuses a matching live legacy service without changing its address or interrupting its work; it retains its legacy URL and lifetime until the user stops it and reconnects with the updated plugin.

For an explicit user request to stop the local service, first pause or cancel active workflows through their tools, then run `node ./dist/main.mjs --stop-service --workspace "<project>" --data-dir "<project-service-data-directory>"` from the installed plugin directory. Use the exact canonical project and matching hashed data directory described above, or the original explicit settings for a legacy fixed-project service; never stop another project service. This command refuses to stop while workflows are active. Do not stop services merely because a chat ends. State and the dashboard address are retained. Machine shutdown stops execution; crash recovery requires the existing stopped-agent confirmation. No OS autostart or proactive completion notification is installed.

## Persistent execution canvas

The dashboard preserves planned nodes after execution starts. Known literal or frozen-input `ctx.map` items can expand before approval; unsupported expressions and result-dependent collections remain explicit dynamic groups until real nodes are created. Never claim that every possible runtime node can be known in advance. Static analysis never runs the script.

The full canvas distinguishes planned, not started, queued, running, succeeded, failed, dependency-blocked, and not-executed nodes. These placeholder states are presentation only: they do not dispatch agents or consume budget. Actual dispatch determines queue status. A plan node that was never triggered is not marked as a successful or failed agent. The compact review page puts the goal and topology first; input details, budgets, and analysis limitations are available in the expandable task-details section.
