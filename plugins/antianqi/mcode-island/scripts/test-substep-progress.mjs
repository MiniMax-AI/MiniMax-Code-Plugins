// test-substep-progress.mjs — behavioral tests for the sub-step progress
// contract and the summary redaction rules.
//
// These are behavioral on purpose. The round-19 review (hetaoBackend) called
// out that the previous suite was "text-shaped": it asserted that a source
// file contained a given substring, so it could not tell a working
// implementation from a deleted code path wrapped in a comment. Every check
// below runs the real code.
//
//   node scripts/test-substep-progress.mjs
//
// Exit 0 = all passed. Any failure exits 1.

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);

let pass = 0;
let fail = 0;
const failures = [];

function ok(name) { pass++; console.log(`[ok  ] ${name}`); }
function bad(name, why) {
    fail++;
    failures.push(`${name}: ${why}`);
    console.log(`[FAIL] ${name}\n       ${why}`);
}
function check(name, cond, why) { cond ? ok(name) : bad(name, why); }
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    a === e ? ok(name) : bad(name, `expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// PowerShell harness
// ---------------------------------------------------------------------------

const PS = process.env.PS_BIN || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');

// A user-specific path is not a test result. Fall back to PATH the way a CI
// runner would, and skip loudly rather than silently passing.
function resolvePs() {
    if (PS.includes('\\') || PS.includes('/')) {
        if (existsSync(PS)) return PS;
    }
    for (const candidate of ['pwsh', 'powershell.exe', 'powershell']) {
        try {
            execFileSync(candidate, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
                { stdio: 'ignore' });
            return candidate;
        } catch { /* try the next one */ }
    }
    return null;
}

const PS_BIN = resolvePs();

// Scratch dir for the behavioral checks. Kept out of the repo so a failed run
// cannot leave fixtures behind for the next one to read.
const TMP = mkdtempSync(join(tmpdir(), 'island-substep-'));

function runPs(script) {
    const file = join(TMP, `run-${Math.random().toString(36).slice(2)}.ps1`);
    // Force UTF-8 on both ends of the pipe. The console code page here is 936
    // (GBK), so a middle dot in a script literal comes back as the two bytes
    // A1 A4 and every UTF-8 decoder turns it into a replacement char --
    // which fails assertions that are actually correct. Setting
    // [Console]::OutputEncoding makes the child emit UTF-8 regardless of what
    // the console is set to. The BOM matters for the other direction: without
    // it PowerShell 5.1 reads the .ps1 as ANSI and mangles the literal.
    const preamble = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n';
    writeFileSync(file, '\uFEFF' + preamble + script, 'utf8');
    const out = execFileSync(PS_BIN, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
        { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = out;
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        buf = buf.subarray(3);
    }
    return buf.toString('utf8');
}

/** Extract a top-level `function Name(...) { ... }` block from a PowerShell file. */
function extractFn(src, name) {
    // PowerShell allows both `function Name {` and `function Name($a) {`, and
    // this repo uses the bare form. Requiring the paren made every lookup miss.
    const start = src.search(new RegExp(`^function ${name}\\s*(\\(|\\{)`, 'm'));
    if (start < 0) throw new Error(`function ${name} not found`);
    const rest = src.slice(start);
    // walk braces from the first one after the signature
    const open = rest.indexOf('{');
    if (open < 0) throw new Error(`no opening brace in ${name}`);
    let depth = 0;
    for (let i = open; i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        else if (rest[i] === '}') {
            depth--;
            if (depth === 0) return rest.slice(0, i + 1);
        }
    }
    throw new Error(`unbalanced braces in ${name}`);
}

/** Extract a `@{ ... }` hashtable assignment that starts at `from` lines in. */
function extractTable(lines, startLine) {
    const out = [];
    for (let i = startLine; i < lines.length; i++) {
        out.push(lines[i]);
        if (/^\}/.test(lines[i])) return out.join('\n');
    }
    throw new Error(`unterminated table at line ${startLine}`);
}

function findLine(lines, re) {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) throw new Error(`pattern not found: ${re}`);
    return i + 1;
}

// ---------------------------------------------------------------------------
// 1. Secret redaction (round-19 review #1)
// ---------------------------------------------------------------------------

// The canary is the whole point of this section. A test that only checks the
// source no longer contains `tool_input.text` would pass against an
// implementation that redacts by accident, or one where the redaction was
// replaced by a different leak. Plant a recognizable secret, run the real
// Format-ToolSummary, and assert the secret is absent from the output.
const CANARY = 'SUPER-SECRET-PASSWORD-8f3a91c2';

if (!PS_BIN) {
    bad('PowerShell available', 'no pwsh/powershell on PATH; behavioral checks cannot run');
} else {
    const libPath = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts', '_lib.ps1');
    const lib = readFileSync(libPath, 'utf8');

    // Format-ToolSummary calls Protect-SecretText, which lives in a
    // separate lib (round-20). Extracting the function body alone would
    // leave the call unresolvable and the harness would die on an
    // undefined command rather than on a real assertion -- so the harness
    // dot-sources the lib, exactly as _lib.ps1 does in production.
    const protectLibPath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Protect-Text.ps1');

    let formatToolSummary;
    try {
        formatToolSummary = extractFn(lib, 'Format-ToolSummary');
    } catch (e) {
        bad('Format-ToolSummary is extractable', e.message);
    }

    if (formatToolSummary) {
        ok('Format-ToolSummary is extractable');

        const harness = `
$ErrorActionPreference = 'Stop'
. '${protectLibPath.replace(/'/g, "''")}'
${formatToolSummary}
$evt = [PSCustomObject]@{
  tool_name = 'mcode-computer-use'
  tool_input = [PSCustomObject]@{ action = 'type'; coordinate = $null; text = '${CANARY}' }
}
Format-ToolSummary $evt
`;
        const out = runPs(harness);

        // The secret must not appear anywhere in the output.
        check('typed text is redacted: secret absent from summary',
            !out.includes(CANARY),
            `secret leaked into Format-ToolSummary output: ${JSON.stringify(out.trim())}`);

        // And the pill must still answer the useful question: is it typing?
        check('typed text is redacted: action still reported',
            /type/.test(out),
            `expected the action name to survive redaction, got ${JSON.stringify(out.trim())}`);

        // Length is a safe signal to keep: it says nothing about content.
        check('typed text is redacted: length is reported instead',
            new RegExp(String(CANARY.length)).test(out) && /redacted/i.test(out),
            `expected "<${CANARY.length} chars, redacted>"-style output, got ${JSON.stringify(out.trim())}`);

        // Negative control: a non-secret coordinate path must still work, or
        // the redaction could have been implemented by disabling the branch.
        const coordHarness = `
$ErrorActionPreference = 'Stop'
. '${protectLibPath.replace(/'/g, "''")}'
${formatToolSummary}
$evt = [PSCustomObject]@{
  tool_name = 'mcode-computer-use'
  tool_input = [PSCustomObject]@{ action = 'click'; coordinate = @(1024,768); text = $null }
}
Format-ToolSummary $evt
`;
        const coordOut = runPs(coordHarness);
        check('coordinate path is unaffected by redaction',
            /1024,768/.test(coordOut),
            `expected the coordinate to render as (1024,768), got ${JSON.stringify(coordOut.trim())}`);
    }
}

// ---------------------------------------------------------------------------
// 2. Sub-step rendering (round-19 review #4)
// ---------------------------------------------------------------------------

const widgetPath = join(PLUGIN_ROOT, 'mcode-island.ps1');
const widget = readFileSync(widgetPath, 'utf8');
let buildDisplayMessage;
try {
    buildDisplayMessage = extractFn(widget, 'Build-DisplayMessage');
    ok('Build-DisplayMessage is extractable');
} catch (e) {
    bad('Build-DisplayMessage is extractable', e.message);
}

if (buildDisplayMessage && PS_BIN) {
    const cases = [
        // [name, Message, Step, Total, Detail, expected]
        ['step with total and detail renders "step 1/1 · detail"',
            'bash ok', 1, 1, 'ls -la /tmp', 'step 1/1 · ls -la /tmp'],
        ['step without total renders "step 3 · detail"',
            'bash ok', 3, -1, 'build project', 'step 3 · build project'],
        ['step with empty detail renders "step 3/12" only',
            'bash ok', 3, 12, '', 'step 3/12'],
        ['no step falls back to the message (detail is NOT shown)',
            'bash ok', -1, -1, 'ls -la /tmp', 'bash ok'],
        ['no step and no message renders empty',
            '', -1, -1, 'ls -la', ''],
    ];

    for (const [name, msg, step, total, detail, expected] of cases) {
        const harness = `
$ErrorActionPreference = 'Stop'
${buildDisplayMessage}
Build-DisplayMessage -Message '${msg.replace(/'/g, "''")}' -Step ${step} -Total ${total} -Detail '${detail.replace(/'/g, "''")}'
`;
        const out = runPs(harness).trim();
        eq(name, out, expected);
    }
}

// The review's #4 was that post-tool-use passes -Detail but no -Step, so
// Build-DisplayMessage's Step<=0 branch discards it. Prove the two sides
// actually connect: BOTH Push-Island calls must pass a Step, and the renderer
// must use it.
//
// Counting matters here. A single `[\s\S]*?` scan across the file passes as
// soon as ONE call carries -Step, so removing it from just the error branch
// left the check green -- a false green the negative-injection pass caught.
// Each call is matched on its own line and both must pass.
{
    const postTool = readFileSync(
        join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts', 'post-tool-use.ps1'), 'utf8');

    const calls = postTool.split('\n')
        .map((l, i) => ({ line: l, n: i + 1 }))
        .filter((x) => /^\s*Push-Island\b/.test(x.line));

    check('post-tool-use has both Push-Island calls (error + done)',
        calls.length === 2,
        `expected 2 Push-Island calls, found ${calls.length}; a new branch was added without the sub-step arguments`);

    for (const call of calls) {
        const label = /-State\s+error/.test(call.line) ? 'error' : 'done';
        check(`post-tool-use ${label} call passes -Step`,
            /-Step\s+\$step\b/.test(call.line),
            `the ${label} branch (line ${call.n}) calls Push-Island with -Detail but no -Step, so Build-DisplayMessage discards the detail`);
        check(`post-tool-use ${label} call passes -Total`,
            /-Total\s+\$total\b/.test(call.line),
            `the ${label} branch (line ${call.n}) does not pass -Total, so the pill cannot render "step N/M"`);
    }

    // Passing -Step is necessary but not sufficient. If the local $step/$total
    // are ever set to the "unset" sentinel (-1, which is what both
    // notify-island.ps1 and Build-DisplayMessage treat as absent), the flag
    // check above still passes while the detail is discarded again at render
    // time. A negative-injection pass caught exactly this: setting
    // `$step = -1` left every assertion green.
    const stepAssign = postTool.match(/^\$step\s*=\s*(-?\d+)\s*$/m);
    const totalAssign = postTool.match(/^\$total\s*=\s*(-?\d+)\s*$/m);

    check('post-tool-use assigns a positive $step',
        !!stepAssign && Number(stepAssign[1]) > 0,
        stepAssign
            ? `$step is ${stepAssign[1]}, which is the "unset" sentinel; the pill will discard the detail at render time`
            : 'post-tool-use.ps1 never assigns $step, so -Step $step forwards an undefined value');

    check('post-tool-use assigns a positive $total',
        !!totalAssign && Number(totalAssign[1]) > 0,
        totalAssign
            ? `$total is ${totalAssign[1]}, which is the "unset" sentinel; the pill cannot render "step N/M"`
            : 'post-tool-use.ps1 never assigns $total, so -Total $total forwards an undefined value');
}

// ---------------------------------------------------------------------------
// 3. Detector preserves sub-step fields across a rewrite (review #2)
// ---------------------------------------------------------------------------

// Read-StatusObj + the field-preservation block in Write-Status. A behavioral
// check: start from a status.json carrying sub-step fields, run the real
// Write-Status payload construction, and confirm the fields survive.
if (PS_BIN) {
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    const detect = readFileSync(detectPath, 'utf8');
    const detectLines = detect.split('\n');

    const writeStatusFn = extractFn(detect, 'Write-Status');

    // Extract the sub-step decision block as a standalone repro of the
    // logic, so the test does not need the detector's whole environment.
    //
    // The block is bounded by two stable statements rather than by the
    // internal ordering of the read-modify-write: round-20 #5 wrapped it
    // in `if ($KeepSubStep) { ... }`, so a regex anchored on `$prev`
    // appearing before `$detailField` silently stopped matching. Anchor on
    // the initialisers and the payload construction instead, and drive the
    // switch explicitly -- this section pins the PRESERVE half; section 5
    // pins the reset half and the call-site wiring.
    const preserveMatch = writeStatusFn.match(/\$stepField\s*=\s*-1[\s\S]*?\$payload\s*=/);

    if (!preserveMatch) {
        bad('Write-Status preserves sub-step fields',
            'could not find the step/total/detail decision block in Write-Status');
    } else {
        ok('Write-Status preserves sub-step fields');

        const harness = `
$ErrorActionPreference = 'Stop'
$statusFile = $env:ISLAND_TEST_STATUS
$KeepSubStep = $true
function Read-StatusObj {
  if (!(Test-Path $statusFile)) { return $null }
  try { return ([System.IO.File]::ReadAllText($statusFile) | ConvertFrom-Json) } catch { return $null }
}
${preserveMatch[0].replace(/\$payload\s*=$/, '')}
"$stepField|$totalField|$detailField"
`;
        const statusFile = join(TMP, 'status.json');
        writeFileSync(statusFile, JSON.stringify({
            state: 'working', message: 'bash', family: 'shell',
            step: 4, total: 12, detail: 'running tests', source: 'hook',
        }), 'utf8');

        const out = runPs(
            `$env:ISLAND_TEST_STATUS = '${statusFile.replace(/'/g, "''")}'\n` + harness).trim();
        eq('detector rewrite preserves step/total/detail', out, '4|12|running tests');

        // And the no-prior case must still default sanely, otherwise a fresh
        // install would render "step -1/-1".
        writeFileSync(statusFile, JSON.stringify({ state: 'idle', message: '', source: 'detector' }), 'utf8');
        const out2 = runPs(
            `$env:ISLAND_TEST_STATUS = '${statusFile.replace(/'/g, "''")}'\n` + harness).trim();
        eq('detector rewrite defaults sub-step to unset', out2, '-1|-1|');
    }
}

// ---------------------------------------------------------------------------
// 4. SWP_NOMOVE on the restore path (review #3)
// ---------------------------------------------------------------------------

{
    const toggle = extractFn(widget, 'Toggle-CallerWindow');
    const zorderCall = toggle.match(
        /SetWindowPos\([^)]*HWND_TOP[^)]*\)/);

    check('restore z-order call exists', !!zorderCall,
        'could not find the HWND_TOP SetWindowPos call in Toggle-CallerWindow');

    if (zorderCall) {
        // Pull the flags expression that feeds this specific call. Anchor on
        // the assignment and require the HWND_TOP call to be the very next
        // SetWindowPos: a broad `[\s\S]*` scan would happily pick up flags
        // belonging to the earlier work-area call and pass regardless.
        const flagsExpr = (toggle.match(/\$nofollow\s*=\s*([^\n\r]+)/) || [null, ''])[1];
        check('restore z-order flags include SWP_NOMOVE',
            /SWP_NOMOVE/.test(flagsExpr),
            'the restore path omits SWP_NOMOVE, so X=0/Y=0 moves the window to (0,0) on any monitor whose origin is not 0');

        check('restore z-order flags include SWP_NOSIZE',
            /SWP_NOSIZE/.test(flagsExpr),
            'the restore path omits SWP_NOSIZE, so cx=0/cy=0 resizes the window to 0x0');

        check('restore z-order flags do NOT include SWP_NOZORDER',
            !/SWP_NOZORDER/.test(flagsExpr),
            'the restore path passes HWND_TOP together with SWP_NOZORDER, which makes Windows ignore hWndInsertAfter and defeats the z-order call');
    }
}

// ---------------------------------------------------------------------------
// 5. A detector state-inference write must CLEAR a stale sub-step
//    (round-20 #5)
// ---------------------------------------------------------------------------
//
// Section 3 pins the other half of the same contract: a metadata refresh
// must PRESERVE step/total/detail, because the 60s 5h-usage rewrite and
// the todo rewrite restate the current state rather than announcing a new
// step. Preserving unconditionally is only half right.
//
// A detector state-inference write is different in kind. It read a new
// tool call out of the session log and is asserting "the agent is doing
// THIS now". That message has no relationship to whatever sub-step a hook
// pushed last, so inheriting step/total/detail leaves the previous turn's
// counter on the pill indefinitely. Observed live: the pill sat on
// "step 1/1" showing a curl command from a finished tool call, through
// several subsequent turns, because nothing ever cleared it.
//
// The two write paths must therefore be distinguished explicitly, not by
// guessing from the message text.
{
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    const detect = readFileSync(detectPath, 'utf8');
    const writeStatusFn = extractFn(detect, 'Write-Status');

    const hasSwitch = /function\s+Write-Status[\s\S]*?\[switch\]\$KeepSubStep/.test(writeStatusFn);
    check('Write-Status exposes a -KeepSubStep switch',
        hasSwitch,
        'state-inference and metadata-refresh writes are not distinguished, so a stale sub-step can never be cleared');

    // Anchor on the two stable statements either side of the decision so
    // the extraction survives reformatting inside the block.
    const block = writeStatusFn.match(/\$stepField\s*=\s*-1[\s\S]*?\$payload\s*=/);

    if (!hasSwitch || !block) {
        bad('detector state write clears a stale sub-step',
            'could not extract the sub-step decision block from Write-Status');
    } else {
        ok('detector state write clears a stale sub-step');

        const harness = `
$ErrorActionPreference = 'Stop'
$statusFile = $env:ISLAND_TEST_STATUS
$KeepSubStep = [bool]::Parse($env:ISLAND_TEST_KEEP)
function Read-StatusObj {
  if (!(Test-Path $statusFile)) { return $null }
  try { return ([System.IO.File]::ReadAllText($statusFile) | ConvertFrom-Json) } catch { return $null }
}
${block[0].replace(/\$payload\s*=$/, '')}
"$stepField|$totalField|$detailField"
`;

        const statusFile = join(TMP, 'status.json');
        const run = (keep) => runPs(
            `$env:ISLAND_TEST_STATUS = '${statusFile.replace(/'/g, "''")}'\n` +
            `$env:ISLAND_TEST_KEEP = '${keep ? 'True' : 'False'}'\n` + harness).trim();

        // Previous status carries a finished sub-step from an agent push.
        const stale = {
            state: 'done', message: 'Bash ok', family: 'shell',
            step: 1, total: 1, detail: 'curl -H "Authorization: Bearer <redacted>"',
            source: 'agent',
        };

        writeFileSync(statusFile, JSON.stringify(stale), 'utf8');
        eq('state-inference write clears the stale sub-step', run(false), '-1|-1|');

        writeFileSync(statusFile, JSON.stringify(stale), 'utf8');
        eq('metadata-refresh write (-KeepSubStep) still preserves it',
            run(true), '1|1|curl -H "Authorization: Bearer <redacted>"');
    }

    // The call sites must actually differ. A switch nobody passes is the
    // dead-code shape this suite exists to catch.
    const callSites = detect.split('\n')
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /^\s*Write-Status\s+\$/.test(l));
    const keeps = callSites.filter(({ l }) => /-KeepSubStep/.test(l));
    const infers = callSites.filter(({ l }) => /\$inferred\.state/.test(l));

    eq('Write-Status has 3 call sites', callSites.length, 3);
    check('the state-inference call site does NOT pass -KeepSubStep',
        infers.length === 1 && !/-KeepSubStep/.test(infers[0].l),
        `inference call site must clear stale sub-step (line ${infers[0]?.n})`);
    check('the 5h-usage and todo call sites DO pass -KeepSubStep',
        keeps.length === 2,
        `expected 2 -KeepSubStep call sites, found ${keeps.length}`);
}

// ---------------------------------------------------------------------------
// 6. The pill never renders raw tool JSON (round-20 #6)
// ---------------------------------------------------------------------------
//
// The detector's `running` message used to be built as
//   "$verb " + (ConvertTo-Json $args -Compress) truncated to 60 chars
// which put this on screen:
//
//   Running {"command":"$ErrorActionPreference=\u0027Continue\u0027\n...
//
// Escaped quotes, a JSON key, and a truncation that can land mid-token.
// `skill` is not in $TOOL_ACTIONS / $TOOL_FAMILIES, so it always took that
// JSON path -- meaning one of the most frequent tools on screen was the
// least readable.
//
// The contract: a human-readable field, never the serialised argument
// object. Unknown tools resolve to the verb alone rather than dumping
// JSON, because "Using" is a fine pill and "Using {\"name\":...}" is not.
{
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    const detect = readFileSync(detectPath, 'utf8');

    let formatArgs;
    try {
        formatArgs = extractFn(detect, 'Format-ToolArgs');
    } catch (e) {
        bad('Format-ToolArgs is extractable', e.message);
    }

    if (!formatArgs) {
        bad('tool summaries are human-readable, not raw JSON',
            'Format-ToolArgs not found: the detector still renders ConvertTo-Json output');
    } else {
        ok('Format-ToolArgs is extractable');

        const protectLibPath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Protect-Text.ps1');
        const harness = `
$ErrorActionPreference = 'Stop'
. '${protectLibPath.replace(/'/g, "''")}'
${formatArgs}
$cases = ConvertFrom-Json $env:ISLAND_TEST_CASES
foreach ($c in $cases) {
  # $c.a is already a PSCustomObject -- the outer ConvertFrom-Json turned
  # the nested object into one. Re-parsing it fails on the '@'.
  $r = Format-ToolArgs $c.t $c.a
  '{0}={1}' -f $c.n, $r
}
`;

        const cases = [
            { n: 'bash',      t: 'bash',        a: { command: 'npm test' },                                   want: 'npm test' },
            { n: 'bashMulti', t: 'bash',        a: { command: "$x = 'Stop'\nGet-ChildItem" },                  want: '$x' },
            { n: 'read',      t: 'read',        a: { file_path: 'C:\\proj\\a\\file.ts' },                       want: 'file.ts' },
            { n: 'write',     t: 'write',       a: { file_path: 'C:\\proj\\a\\out.json' },                      want: 'out.json' },
            { n: 'edit',      t: 'edit',        a: { file_path: 'C:\\proj\\a\\x.ps1' },                         want: 'x.ps1' },
            { n: 'grep',      t: 'grep',        a: { pattern: 'TODO' },                                       want: 'TODO' },
            { n: 'glob',      t: 'glob',        a: { pattern: '**/*.ps1' },                                    want: '*.ps1' },
            { n: 'websearch', t: 'web_search',  a: { query: 'mcode changelog' },                              want: 'mcode changelog' },
            { n: 'webfetch',  t: 'web_fetch',   a: { url: 'https://example.com/y' },                          want: 'example.com' },
            // skill is absent from the tool taxonomy: this is the case
            // that was guaranteed to render as raw JSON.
            { n: 'skill',     t: 'skill',       a: { name: 'docx' },                                           want: 'docx' },
            { n: 'taskout',   t: 'task_output', a: { task_id: 'bg_abc123' },                                   want: 'bg_abc123' },
            // Unknown tool with an unrecognised shape: verb-only, not JSON.
            { n: 'unknown',   t: 'wibble',      a: { zzz: 1 },                                                want: '' },
            // Credential in a command must still be redacted on this path.
            { n: 'secret',    t: 'bash',        a: { command: "curl -H 'Authorization: Bearer eyJhbGciOi.SUPERSECRET'" } },
        ];

        const out = runPs(
            `$env:ISLAND_TEST_CASES = '${JSON.stringify(cases).replace(/'/g, "''")}'\n` + harness);
        const got = {};
        for (const line of out.split(/\r?\n/)) {
            const m = line.match(/^(\w+)=(.*)$/);
            if (m) got[m[1]] = m[2];
        }

        for (const c of cases) {
            if (!(c.n in got)) {
                bad(`summary ${c.n}`, `no output produced (got ${JSON.stringify(out.trim())})`);
                continue;
            }
            const v = got[c.n];
            // The blanket rule, asserted for every case including the
            // secret one: nothing JSON-shaped reaches the pill.
            const jsonish = /\{\s*"|":\s*"|\\u00[0-9a-f]{2}/i.test(v);
            if (jsonish) {
                bad(`summary ${c.n}`, `renders raw JSON: ${JSON.stringify(v)}`);
                continue;
            }
            if (c.want === '') {
                // Unknown tool with nothing worth showing: must be empty,
                // not merely "not JSON". A partial dump is still a dump.
                if (v !== '') {
                    bad(`summary ${c.n}`, `expected empty, got ${JSON.stringify(v)}`);
                    continue;
                }
            } else if (c.want !== undefined) {
                if (!v.toLowerCase().includes(String(c.want).toLowerCase())) {
                    bad(`summary ${c.n}`, `expected to contain ${JSON.stringify(c.want)}, got ${JSON.stringify(v)}`);
                    continue;
                }
            }
            if (c.n === 'secret' && /SUPERSECRET/.test(v)) {
                bad('summary secret', `credential survived: ${JSON.stringify(v)}`);
                continue;
            }
            ok(`summary ${c.n}${c.want !== undefined ? ` -> ${JSON.stringify(v)}` : ' (redacted)'}`);
        }

        // A multi-line command must not spill its body onto a one-line pill.
        if ('bashMulti' in got && /Get-ChildItem/.test(got.bashMulti)) {
            bad('summary bashMulti', 'a multi-line command leaked its second line onto the pill');
        } else if ('bashMulti' in got) {
            ok('summary bashMulti keeps only the first line');
        }
    }
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('-'.repeat(60));
console.log(`${pass} pass, ${fail} fail`);
if (fail > 0) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
