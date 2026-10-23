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

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);

let pass = 0;
let fail = 0;
// A skip that is not counted is a skip that reads as a pass. The suite
// skips a Windows-only section on other platforms, and that fact has
// to be visible in the summary rather than only in the scrollback.
let skipped = 0;
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

function runPs(script, extraEnv, allowFail) {
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
    const r = spawnSync(PS_BIN, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
        encoding: 'buffer',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    // The child's stderr is kept: a harness that dies before its first
    // check otherwise reports "0 passed", which reads like "there was
    // nothing to test" rather than "the harness is broken".
    const errText = (r.stderr || Buffer.alloc(0)).toString('utf8');
    if (r.status !== 0 && !allowFail) {
        throw new Error(`PS harness failed (exit ${r.status}): ${errText || (r.stdout || '').toString('utf8')}`);
    }
    let buf = r.stdout || Buffer.alloc(0);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        buf = buf.subarray(3);
    }
    let text = buf.toString('utf8');
    if (errText) {
        // Tagged so the TAP parser ignores it, but it is still in the
        // output the caller reads.
        text += `\n# stderr: ${errText.replace(/\r?\n/g, ' | ')}`;
    }
    return text;
}

/**
 * Start a PowerShell child and resolve with its exit code and output.
 * Used where a test needs two processes running at the same time; runPs
 * is synchronous and cannot express that.
 */
function spawnPs(script, extraEnv) {
    const file = join(TMP, `spawn-${Math.random().toString(36).slice(2)}.ps1`);
    writeFileSync(file, '\uFEFF' + '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + script, 'utf8');
    const child = spawn(PS_BIN, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
        env: { ...process.env, ...(extraEnv || {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    return new Promise((resolve) => {
        child.on('close', (code) => resolve({ code, out, err }));
    });
}

/**
 * An isolated %APPDATA% so a test can exercise the real code paths that
 * resolve %APPDATA%\mcode-island\status.json without touching the
 * developer's live island.
 */
function makeIsolatedAppData(tag) {
    const dir = join(TMP, `appdata-${tag}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'mcode-island'), { recursive: true });
    return dir;
}

/**
 * Read a JSON file the way the widget reads it.
 *
 * status.json is written with [System.Text.Encoding]::UTF8, which emits
 * a BOM. Every PowerShell reader strips it (ReadAllText detects it,
 * Get-Content -Encoding UTF8 tolerates it); JSON.parse does not, and
 * would report a syntax error on a file that is perfectly valid.
 */
function readJsonFile(path) {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/**
 * Strip PowerShell comments so a static check looks at CODE, not at prose.
 *
 * The detector documents removed identifiers in its comments; a check for
 * "this identifier must not appear" would otherwise trip over the
 * comment that explains why it was removed.
 */
function stripPsComments(src) {
    return src.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
}

/**
 * Extract a balanced-brace block from PowerShell source, starting at the
 * first occurrence of `marker`. Returns null when the marker is absent
 * or the braces do not balance.
 */
function detectCodeBlock(src, marker) {
    const start = src.indexOf(marker);
    if (start < 0) return null;
    const open = src.indexOf('{', start);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    return null;
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
// 3. The metadata refresh preserves the sub-step fields (round-21 #1)
// ---------------------------------------------------------------------------
//
// This section runs the REAL Write-Status against a REAL status.json in
// an isolated %APPDATA%, instead of extracting a fragment of the
// function body and stubbing the reader.
//
// The old harness stubbed Read-StatusObj and pasted the decision block
// into a synthetic script. That could not tell a working implementation
// from one that read the file twice, because the second read was exactly
// what the stub hid -- and a second read IS the bug the review named:
// "Write-Status -KeepSubStep performs a second independent read for
// step/detail/source before overwriting the file".
//
// The contract:
//   - a metadata refresh restates the current state, preserves the
//     sub-step fields and preserves the state owner;
//   - a state-inference write resets the sub-step fields and claims
//     ownership;
//   - both take exactly ONE snapshot and write under the shared lock;
//   - every write advances the monotonic version exactly once.

const storeLibPath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Status-Store.ps1');
const storeLibRef = storeLibPath.replace(/'/g, "''");

if (PS_BIN) {
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    const detect = readFileSync(detectPath, 'utf8');
    const detectCode = stripPsComments(detect);
    const lines = detectCode.split('\n');

    const writeStatusFn = extractFn(detect, 'Write-Status');
    const writeStatusUnderLockFn = extractFn(detect, 'Write-StatusUnderLock');

    check('the status store lib exists', existsSync(storeLibPath), `${storeLibPath} not found`);

    // The lock has to be taken and released around the whole write, and
    // the snapshot has to be read exactly once. A second read is still a
    // second read: it can observe a generation the payload was not built
    // from, and that is what produced the mixed-generation payloads.
    check('Write-Status takes the cross-process lock',
        /Enter-StatusLock/.test(writeStatusFn),
        'Write-Status writes status.json without taking the lock, so a hook write can land between its read and its write');
    check('Write-Status releases the lock',
        /Exit-StatusLock/.test(writeStatusFn),
        'Write-Status takes the lock but never releases it; every later writer would block until the lock timed out');

    const readsInWriter = (writeStatusFn.match(/Read-StatusSnapshot/g) || []).length;
    const readsInBody = (writeStatusUnderLockFn.match(/Read-StatusSnapshot/g) || []).length;
    eq('the write path reads status.json exactly once', readsInWriter + readsInBody, 1);
    eq('the snapshot is not read outside the locked body', readsInWriter, 0);
    eq('the locked body takes the snapshot once', readsInBody, 1);

    check('the detector no longer has an unlocked reader',
        !/Read-StatusObj/.test(stripPsComments(detect)),
        'Read-StatusObj read status.json without the lock; it is the read that made a lost update possible');

    // The two layers have to be bound together. Section 7 proves the
    // PROTOCOL (two real processes, one file, no lost write) using
    // hand-written writers, because the deterministic choreography needs
    // the read to be separable from the write -- and the real code
    // deliberately does not separate them. These checks are what say
    // that the real detector code goes through that protocol.
    const arbitration = detectCodeBlock(detectCode, 'if ($inferred) {');
    check('the arbitration block takes the lock',
        !!arbitration && /Enter-StatusLock/.test(arbitration),
        'the arbitration read and the write it authorises are not one critical section, so a hook push can be judged against a stale snapshot and then overwritten');
    check('the arbitration block writes through the locked body',
        !!arbitration && /Write-StatusUnderLock/.test(arbitration),
        'the arbitration path does not write through Write-StatusUnderLock, so it is not covered by the lock');
    const unlockedWrites = lines.filter((l) =>
        /Write-StatusUnderLock/.test(l)
        && !/^\s*function\s+Write-StatusUnderLock/.test(l)
        && !/Write-StatusUnderLock\s+\$state/.test(l)
        && !/Write-StatusUnderLock\s+\$newState/.test(l));
    eq('every write goes through the locked body', unlockedWrites.length, 0);

    // The call sites must differ. A switch nobody passes is the dead-code
    // shape this suite exists to catch.
    //
    // Four call sites exist, and they are three different things:
    //   - the inference path, which must NOT preserve the sub-step;
    //   - the two metadata refreshes, which must;
    //   - the wrapper's own forward, which passes the switch through
    //     and is not a metadata site.
    // Counting "3 call sites" the way the old suite did no longer
    // describes anything, so each kind is pinned separately.
    const refreshes = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /^\s*Write-Status\s+-MetadataRefresh\s*$/.test(l));
    const infers = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /^\s*Write-StatusUnderLock\s+\$newState/.test(l));
    const forwards = lines
        .map((l, i) => ({ l, n: i + 1 }))
        .filter(({ l }) => /^\s*Write-StatusUnderLock\s+\$state\s+\$message\s+\$family\s+-MetadataRefresh:/.test(l));

    eq('the 5h-usage and todo call sites pass -MetadataRefresh', refreshes.length, 2);
    check('the state-inference call site does NOT pass -MetadataRefresh',
        infers.length === 1 && !/-MetadataRefresh/.test(infers[0].l),
        `inference call site must clear the stale sub-step (found ${infers.length})`);
    eq('the lock wrapper forwards the switch exactly once', forwards.length, 1);

    // The harness: the real functions, the real store lib, an isolated
    // %APPDATA%. $S_IDLE / $S_DETECTOR are script-scope constants in the
    // detector; the extracted functions need them to resolve.
    const buildHarness = (call) => `
$ErrorActionPreference = 'Stop'
. '${storeLibRef}'
$S_IDLE = 'idle'
$S_DETECTOR = 'detector'
$script:plan5hRemainingPct = $null
$script:plan5hResetMs = $null
$script:plan5hTodoData = $null
${writeStatusFn}
${writeStatusUnderLockFn}
${call}
'DONE'
`;

    const appdata = makeIsolatedAppData('write-status');
    const statusPath = join(appdata, 'mcode-island', 'status.json');
    const seed = {
        state: 'working', message: 'bash', family: 'shell',
        step: 4, total: 12, detail: 'running tests', source: 'agent', version: 3,
    };

    writeFileSync(statusPath, JSON.stringify(seed), 'utf8');
    const refreshOut = runPs(buildHarness('Write-Status -MetadataRefresh'), { APPDATA: appdata });
    // The marker is what makes this check mean something: without it an
    // empty output would look exactly like a clean run.
    check('the metadata refresh ran to completion',
        /DONE/.test(refreshOut) && !/Exception/i.test(refreshOut),
        `metadata refresh did not complete: ${JSON.stringify(refreshOut.trim())}`);
    // The detector calls the write path from inside its main loop, and
    // the daemon's stdout goes to a log file. A write path that returns
    // its version therefore echoes a bare number on every write. This
    // check failed once for exactly that reason.
    eq('the write path does not echo anything to the caller', refreshOut.trim(), 'DONE');

    const afterRefresh = readJsonFile(statusPath);
    eq('metadata refresh preserves step', afterRefresh.step, 4);
    eq('metadata refresh preserves total', afterRefresh.total, 12);
    eq('metadata refresh preserves detail', afterRefresh.detail, 'running tests');
    eq('metadata refresh preserves the state owner', afterRefresh.source, 'agent');
    eq('metadata refresh restates the state', afterRefresh.state, 'working');
    eq('metadata refresh restates the message', afterRefresh.message, 'bash');
    eq('metadata refresh preserves the family', afterRefresh.family, 'shell');
    eq('metadata refresh advances the version exactly once', afterRefresh.version, 4);
}

// ---------------------------------------------------------------------------
// 4. SWP_NOMOVE on the restore path (review #3)
// ---------------------------------------------------------------------------

{
    const toggle = extractFn(widget, 'Toggle-Window');
    const zorderCall = toggle.match(
        /SetWindowPos\([^)]*HWND_TOP[^)]*\)/);

    check('restore z-order call exists', !!zorderCall,
        'could not find the HWND_TOP SetWindowPos call in Toggle-Window');

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
//
// Both halves run the real Write-Status against a real status.json in an
// isolated %APPDATA% -- no extracted fragment, no stubbed reader. The
// call-site wiring is asserted in section 3.
if (PS_BIN) {
    const appdata = makeIsolatedAppData('state-inference');
    const statusPath = join(appdata, 'mcode-island', 'status.json');

    const buildHarness = (call) => `
$ErrorActionPreference = 'Stop'
. '${storeLibRef}'
$S_IDLE = 'idle'
$S_DETECTOR = 'detector'
$script:plan5hRemainingPct = $null
$script:plan5hResetMs = $null
$script:plan5hTodoData = $null
${extractFn(readFileSync(join(PLUGIN_ROOT, 'mcode-status-detect.ps1'), 'utf8'), 'Write-Status')}
${extractFn(readFileSync(join(PLUGIN_ROOT, 'mcode-status-detect.ps1'), 'utf8'), 'Write-StatusUnderLock')}
${call}
'DONE'
`;

    // Previous status carries a finished sub-step from an agent push.
    const stale = {
        state: 'done', message: 'Bash ok', family: 'shell',
        step: 1, total: 1, detail: 'curl -H "Authorization: Bearer <redacted>"',
        source: 'agent', version: 7,
    };

    writeFileSync(statusPath, JSON.stringify(stale), 'utf8');
    runPs(buildHarness("Write-Status 'done' 'Bash ok' 'shell'"), { APPDATA: appdata });
    const inferred = readJsonFile(statusPath);

    eq('state-inference write clears the stale sub-step (step)', inferred.step, -1);
    eq('state-inference write clears the stale sub-step (total)', inferred.total, -1);
    eq('state-inference write clears the stale sub-step (detail)', inferred.detail, '');
    // round-20 #7: a metadata refresh must not change who owns the
    // state. `source` is the arbitration token -- the detector treats
    // `source == detector` as "mine to rewrite" -- so a 5h-usage
    // refresh that stamps `detector` onto an agent-owned state
    // silently hands write authority back to the detector. The
    // detector then re-derives `error` from the same stale failed
    // toolResult on every poll and clobbers the Stop hook's `done`.
    // That is the observed "pill stopped on Command failed".
    eq('state-inference write claims ownership', inferred.source, 'detector');
    eq('state-inference write advances the version exactly once', inferred.version, 8);
    eq('state-inference write keeps the family it was given', inferred.family, 'shell');

    // The no-prior case must still default sanely, otherwise a fresh
    // install would render "step -1/-1" and claim a state nobody set.
    const freshDir = makeIsolatedAppData('state-inference-fresh');
    runPs(buildHarness("Write-Status 'working' 'bash' 'shell'"), { APPDATA: freshDir });
    const fresh = readJsonFile(join(freshDir, 'mcode-island', 'status.json'));
    eq('a fresh install starts at version 1', fresh.version, 1);
    eq('a fresh install defaults the sub-step to unset', `${fresh.step}|${fresh.total}|${fresh.detail}`, '-1|-1|');
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
            // round-20 #8: a leading `$var = ...` preamble is agent boilerplate,
            // not the work. The first *executed* line is what the user wants
            // to read on the pill.
            { n: 'bashMulti', t: 'bash',        a: { command: "$x = 'Stop'\nGet-ChildItem" },                  want: 'Get-ChildItem' },
            // Every line an assignment: nothing to fall through to, so the
            // first line must still render rather than the pill going blank.
            { n: 'bashAllVar', t: 'bash',       a: { command: "$a = 1\n$b = 2" },                               want: '$a = 1' },
            // Comments are boilerplate too.
            { n: 'bashComment', t: 'bash',      a: { command: "# setup\nnpm run build" },                       want: 'npm run build' },
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

        // A multi-line command must not spill its body onto a one-line pill,
        // and the boilerplate preamble must not be what the user reads.
        if ('bashMulti' in got && /\$x/.test(got.bashMulti)) {
            bad('summary bashMulti', 'the variable-assignment preamble was shown instead of the first executed line');
        } else if ('bashMulti' in got) {
            ok('summary bashMulti skips the assignment preamble');
        }
    }
}

// ---------------------------------------------------------------------------
// 7. Two writers, one file (round-21 review hetaoBackend #1)
// ---------------------------------------------------------------------------
//
// The review: "The loop reads old state/message, then Write-Status
// -KeepSubStep performs a second independent read for step/detail/source
// before overwriting the file. An agent write between the reads produces
// a mixed-generation payload, or a write after the second read is lost."
//
// This is the regression for exactly that sentence, with two real
// PowerShell processes:
//
//   writer A  the detector's metadata refresh -- take the lock, read,
//             then write a payload merged from that read
//   writer B  the agent hook's push -- take the lock, write a full
//             payload
//
// The choreography is what makes it deterministic. A signals that it has
// read, then waits for B to signal that it is ABOUT to write. B's signal
// is published BEFORE B takes the lock, so:
//
//   with the lock    A holds it, B blocks, A writes, B writes last
//                    -> the file ends up carrying B's values
//   without the lock B writes immediately, A writes 400 ms later from
//                    its stale read
//                    -> the file ends up carrying A's stale values and
//                       B's write is gone
//
// A payload that happens to look plausible is not enough. The version
// counter is a second, independent witness: both writers derive it from
// the snapshot they read, so two writers that read the same generation
// mint the same version. That collision is visible even when the
// surviving payload reads fine.
if (PS_BIN) {
    const appdata = makeIsolatedAppData('two-writers');
    const storeDir = join(appdata, 'mcode-island');
    const statusPath = join(storeDir, 'status.json');
    const markerRead = join(storeDir, 'a-read');
    const markerAttempt = join(storeDir, 'b-attempt');

    writeFileSync(statusPath, JSON.stringify({
        state: 'idle', message: '', step: 1, total: 3, detail: 'seed',
        source: 'agent', version: 0,
    }), 'utf8');

    const writerA = `
$ErrorActionPreference = 'Stop'
. '${storeLibRef}'
$lock = Enter-StatusLock
try {
  $prev = Read-StatusSnapshot
  Set-Content -Path $env:ISLAND_MARKER_READ -Value 'read' -Encoding ASCII
  $deadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path $env:ISLAND_MARKER_ATTEMPT)) {
    if ((Get-Date) -ge $deadline) { throw 'writer B never signalled its intent to write' }
    Start-Sleep -Milliseconds 20
  }
  # Without the lock, B's write lands inside this window. With it, B is
  # blocked and the sleep only makes the test slower.
  Start-Sleep -Milliseconds 400
  $payload = [PSCustomObject]@{
    state = [string]$prev.state
    message = [string]$prev.message
    step = [int]$prev.step
    total = [int]$prev.total
    detail = [string]$prev.detail
    source = [string]$prev.source
    usage5h = 77
  }
  Write-StatusSnapshot -Payload $payload -Previous $prev
} finally {
  Exit-StatusLock $lock
}
'OK-A'
`;

    const writerB = `
$ErrorActionPreference = 'Stop'
. '${storeLibRef}'
Set-Content -Path $env:ISLAND_MARKER_ATTEMPT -Value 'attempt' -Encoding ASCII
$lock = Enter-StatusLock
try {
  $payload = [PSCustomObject]@{
    state = 'working'
    message = 'hook push'
    step = 5
    total = 6
    detail = 'hook detail'
    source = 'agent'
  }
  Write-StatusSnapshot -Payload $payload
} finally {
  Exit-StatusLock $lock
}
'OK-B'
`;

    const env = {
        APPDATA: appdata,
        ISLAND_MARKER_READ: markerRead,
        ISLAND_MARKER_ATTEMPT: markerAttempt,
    };

    // A reader that polls the file while the writers run. The widget
    // polls status.json every 400 ms with Get-Content, so a reader with
    // the same habits is the one that has to be protected.
    let torn = 0;
    let reads = 0;
    let polling = true;
    const poll = (async () => {
        while (polling) {
            try {
                const j = readJsonFile(statusPath);
                reads++;
                if (!j.state) torn++;
            } catch (e) {
                // A file that is momentarily absent is not a torn read; a
                // payload that will not parse is.
                if (e instanceof SyntaxError) torn++;
            }
            await new Promise((r) => setTimeout(r, 3));
        }
    })();

    const a = spawnPs(writerA, env);
    // B must not start before A has taken its snapshot, or the ordering
    // the whole test depends on is never established.
    //
    // The wait is BOUNDED. An unbounded spin here turns "writer A died"
    // into a suite that hangs forever instead of a suite that fails,
    // and a hanging test is worse than a failing one: it looks like a
    // stuck CI job rather than a broken contract.
    const markerDeadline = Date.now() + 30000;
    while (!existsSync(markerRead)) {
        if (Date.now() > markerDeadline) {
            bad('writer A took its snapshot',
                'writer A never signalled that it had read the file within 30s; it probably died before it could take the lock');
            break;
        }
        await new Promise((r) => setTimeout(r, 10));
    }
    const b = spawnPs(writerB, env);
    // Bounded, for the same reason: a child that never exits must fail
    // the test, not hang the suite.
    const timeoutResult = { code: 'TIMEOUT', out: '', err: 'the writer did not finish within 60s' };
    const [ra, rb] = await Promise.race([
        Promise.all([a, b]),
        new Promise((r) => setTimeout(() => r([timeoutResult, timeoutResult]), 60000)),
    ]);
    polling = false;
    await poll;

    check('writer A (detector-style read-modify-write) completed',
        ra.code === 0,
        `exit ${ra.code}: ${(ra.err || ra.out).trim()}`);
    check('writer B (agent-style push) completed',
        rb.code === 0,
        `exit ${rb.code}: ${(rb.err || rb.out).trim()}`);

    const final = readJsonFile(statusPath);
    eq('the later write is not clobbered by a stale read (step)', final.step, 5);
    eq('the later write is not clobbered by a stale read (detail)', final.detail, 'hook detail');
    eq('the later write is not clobbered by a stale read (state)', final.state, 'working');
    eq('every write advances the version exactly once', final.version, 2);
    eq('a reader never observes a torn payload', torn, 0);
    check('the reader actually observed the file',
        reads > 0,
        'the poll loop never read status.json, so the torn-read check proved nothing');
}

// ---------------------------------------------------------------------------
// 8. The agent-side write takes the same lock (round-21 review #1)
// ---------------------------------------------------------------------------
//
// notify-island.ps1 is the other writer. If it staged through its own
// path without the lock, it could still rename the detector's half-written
// file into place, and the detector could still clobber it. The static
// checks below are the cheap ones; the behavioral proof is section 7.
{
    const notify = readFileSync(join(PLUGIN_ROOT, 'notify-island.ps1'), 'utf8');

    check('notify-island dot-sources the shared store lib',
        /Status-Store\.ps1/.test(notify),
        'notify-island.ps1 writes status.json without the shared protocol, so the two writers are not mutually excluded');
    check('notify-island takes the cross-process lock',
        /Enter-StatusLock/.test(notify),
        'notify-island.ps1 writes status.json without taking the lock');
    check('notify-island releases the lock',
        /Exit-StatusLock/.test(notify),
        'notify-island.ps1 takes the lock but never releases it');
    check('notify-island no longer stages through a shared status.json.tmp',
        !/"\$statusFile\.tmp"/.test(notify),
        'notify-island.ps1 stages through $statusFile.tmp, the same path the detector used, so one could rename the other\'s half-written file into place');
    // The positive contract, not a spelling. The check above looks for
    // one literal spelling of the shared path; a rewrite that spells the
    // same path differently walks right past it, and the suite stays
    // green while the bug is back. That is not hypothetical -- the
    // negative-injection pass hit exactly this. So: status.json may
    // only be written through the shared store.
    const notifyCode = stripPsComments(notify);
    check('notify-island writes status.json only through the shared store',
        !/WriteAllText\([^)]*status/i.test(notifyCode) && !/Move-Item[^\n]*status\.json/i.test(notifyCode),
        'notify-island.ps1 writes status.json directly; the shared store owns that path, so the staging file and the lock stay in one place');
    check('notify-island does not write a raw payload with its own ts',
        !/ts\s*=\s*\$ts[\s\S]{0,400}source\s*=\s*'agent'/.test(notify),
        'notify-island.ps1 stamps its own ts; the store owns ts and version so both writers agree on the format');
}

// ---------------------------------------------------------------------------
// 9. PostToolUse classifies a structured tool result (round-21 #2)
// ---------------------------------------------------------------------------
//
// The review: "PostToolUse error classification stringifies the result
// and only recognizes textual error prefixes. A structured
// {isError:true,...} result can be reported as `done`. Prefer the
// structured boolean and test object/string/null success and failure
// payloads through the real hook subprocess."
//
// The old code did `$s = [string]$result` and matched a textual prefix.
// A structured result stringifies to "@{isError=True; content=...}",
// which matches no prefix -- so a FAILED tool was reported as a
// SUCCESS and the pill showed green.
//
// These cases run the real hook as a real child process, with a real
// event on stdin, and read back what it wrote to status.json. A
// function-body test would not prove the hook wires the classification
// to the state it pushes.
//
// WINDOWS ONLY. The hook calls `chcp 65001` and `Add-Type` with Win32
// P/Invoke signatures, so it cannot run anywhere else -- there is no
// console to change the code page of and no user32.dll to bind. The
// repository's `node --test` picks this file up on the ubuntu job as
// well as the Windows one, so this section is gated rather than
// failing there. It is skipped LOUDLY: a skip that is invisible reads
// as a pass.
//
// The rest of the suite runs on both platforms. The status.json
// protocol is plain PowerShell, and the suite supplies an isolated
// %APPDATA% so the store resolves to a scratch directory.

/**
 * Run a hook script as a real child process with a JSON event on stdin.
 * The hook reads its event from stdin and pushes the result to
 * status.json, so the only honest way to test it is to feed it a
 * payload and read back what it wrote.
 */
function runHookWithStdin(hookPath, eventJson, extraEnv) {
    return new Promise((resolve) => {
        const child = spawn(PS_BIN, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hookPath], {
            env: { ...process.env, ...(extraEnv || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString('utf8'); });
        child.stderr.on('data', (d) => { err += d.toString('utf8'); });
        child.on('close', (code) => resolve({ code, out, err }));
        child.stdin.end(eventJson);
    });
}

if (process.platform !== 'win32') {
    console.log('[skip] section 9: the PostToolUse hook needs Windows (chcp, Add-Type with Win32 P/Invoke)');
    skipped++;
} else if (PS_BIN) {
    const hookPath = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts', 'post-tool-use.ps1');
    const postTool = readFileSync(hookPath, 'utf8');

    check('post-tool-use delegates the classification to the shared helper',
        /Test-ToolResultError/.test(postTool),
        'post-tool-use.ps1 still classifies the result inline, so a structured isError flag is ignored');
    check('post-tool-use no longer stringifies the tool result',
        !/\[string\]\$result/.test(postTool),
        'post-tool-use.ps1 stringifies tool_result before classifying it, which is what hid the structured isError flag');

    const cases = [
        // The two the review named.
        { n: 'structured failure', result: { isError: true, output: 'command not found' }, want: 'error' },
        { n: 'structured success', result: { isError: false, output: 'all good' }, want: 'done' },
        // The flag survives a nested payload.
        { n: 'structured failure with a nested payload', result: { isError: true, content: { text: 'boom' } }, want: 'error' },
        { n: 'structured success with a nested payload', result: { isError: false, content: { text: 'ok' } }, want: 'done' },
        // A bare string falls back to the textual heuristic.
        { n: 'a string with an error prefix', result: 'Error: command not found', want: 'error' },
        { n: 'a plain string', result: 'all good', want: 'done' },
        // A result that is a JSON string still carries the flag.
        { n: 'a JSON string carrying the failure flag', result: '{"isError":true,"output":"boom"}', want: 'error' },
        { n: 'a JSON string carrying the success flag', result: '{"isError":false,"output":"ok"}', want: 'done' },
        // Nothing at all is a failure: the tool produced no result.
        { n: 'a null result', result: null, want: 'error' },
        { n: 'an empty string result', result: '', want: 'error' },
    ];

    for (const c of cases) {
        // A fresh %APPDATA% per case, so each run writes its own
        // status.json and the assertion cannot read a previous case.
        const appdata = makeIsolatedAppData('post-tool-use');
        const event = {
            session_id: 'ci-fake-session',
            transcript_path: 'C:\\fake\\transcript',
            cwd: 'C:\\fake\\cwd',
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm test' },
            tool_result: c.result,
        };

        const r = await runHookWithStdin(hookPath, JSON.stringify(event), { APPDATA: appdata });
        check(`post-tool-use ${c.n}: the hook exited cleanly`,
            r.code === 0,
            `exit ${r.code}: ${(r.err || r.out).trim().slice(0, 300)}`);

        const statusPath = join(appdata, 'mcode-island', 'status.json');
        if (!existsSync(statusPath)) {
            bad(`post-tool-use ${c.n}`, `the hook wrote no status.json (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 300)}`);
            continue;
        }
        const status = readJsonFile(statusPath);
        eq(`post-tool-use ${c.n}: the pushed state`, status.state, c.want);
        eq(`post-tool-use ${c.n}: the pushed message`, status.message, c.want === 'error' ? 'Bash failed' : 'Bash ok');
    }
}

// ---------------------------------------------------------------------------
// 9. The detector follows the NEW session even when its last line is fat
// ---------------------------------------------------------------------------
//
// The reported bug: "after the first test the state is fine, but in a new
// conversation the pill stops updating and keeps showing the previous
// task's finished state".
//
// The mechanism: a session-log line can be far bigger than the tail window
// the reader used to look at. An agent that reads a screenshot writes the
// base64 image into ONE line (200 KB - 560 KB in the wild), so the 64 KB
// window held nothing but a fragment of that line. The fragment did not
// parse, and the catch-all answered with the PREVIOUSLY cached inference
// -- a message that belonged to an earlier session. The pill then showed
// the previous task's state for the whole new conversation.
//
// The regression is behavioral on purpose: the real functions are extracted
// from the real detector and run against a synthetic session tree, so a
// text-shaped lock cannot pass while the behaviour is broken.
{
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    const detect = readFileSync(detectPath, 'utf8');

    let readLastMessage;
    let getLastJsonLine;
    try {
        readLastMessage = extractFn(detect, 'Read-LastMessage');
        getLastJsonLine = extractFn(detect, 'Get-LastJsonLine');
    } catch (e) {
        bad('the session-log reader is extractable', e.message);
    }

    if (!readLastMessage || !getLastJsonLine) {
        bad('the tail reader handles a fat last line',
            'Get-LastJsonLine / Read-LastMessage not found: the reader is still the 64 KB window that drops a fat line');
    } else {
        ok('the session-log reader is extractable');

        const sessions = join(TMP, 'sessions');
        const oldDir = join(sessions, '2026', '10', '23', '09-00-00-000-session_old');
        const newDir = join(sessions, '2026', '10', '23', '10-00-00-000-session_new');
        mkdirSync(oldDir, { recursive: true });
        mkdirSync(newDir, { recursive: true });

        const oldFile = join(oldDir, 'messages.jsonl');
        const newFile = join(newDir, 'messages.jsonl');

        // The previous task: its last line is a `read` toolResult.
        const oldLine = JSON.stringify({
            message_id: 'msg-old',
            turn_id: 'turn-old',
            message: {
                role: 'toolResult',
                toolName: 'read',
                content: [{ type: 'text', text: 'old task done' }],
            },
        });
        writeFileSync(oldFile, oldLine + '\n', 'utf8');

        // The new conversation: ONE line of 200 KB, exactly the shape a
        // screenshot read produces.
        const fatLine = JSON.stringify({
            message_id: 'msg-new',
            turn_id: 'turn-new',
            message: {
                role: 'toolResult',
                toolName: 'bash',
                content: [{ type: 'text', text: 'x'.repeat(200000) }],
            },
        });
        writeFileSync(newFile, fatLine, 'utf8');

        const script = `
$ErrorActionPreference = 'Stop'
$FMT_O_FULL = 'O'
$script:lastMsgsSnapshot = @{ path = ''; mtime = ''; lastInferred = $null }
${getLastJsonLine}
${readLastMessage}
$old = Read-LastMessage '${oldFile.replace(/'/g, "''")}'
$new = Read-LastMessage '${newFile.replace(/'/g, "''")}'
Write-Output ("OLD=" + [string]$old.message.toolName)
Write-Output ("NEW=" + [string]$new.message.toolName)
`;

        let out = '';
        try {
            out = runPs(script);
        } catch (e) {
            bad('the tail reader handles a fat last line',
                `the extracted reader threw: ${(e.stdout || e.message || '').toString().slice(0, 300)}`);
        }

        const oldTool = (out.match(/OLD=(\S*)/) || [])[1];
        const newTool = (out.match(/NEW=(\S*)/) || [])[1];

        eq('the reader returns the previous session\'s last message', oldTool, 'read');
        eq('the reader follows the new session whose last line is 200 KB', newTool, 'bash');
    }
}

// ---------------------------------------------------------------------------
// 10. The CLI install and the Marketplace package resolve the click target
//     differently, and each build says so in the code
// ---------------------------------------------------------------------------
//
// The two are different products. The CLI runtime loads the
// io.minimax.mcode hooks, so the agent pushes the state itself and a click
// keeps the CLI habit of hiding the terminal and bringing it back. The
// Marketplace package ships no Hook material, the agent is hosted by the
// desktop app, and there the click has to focus the app window.
//
// So the source carries ONE switch and the package builder flips it. Both
// sides are checked behaviorally here: the resolver is extracted from the
// real file, the two lookups are stubbed so that BOTH a desktop app and a
// caller terminal exist, and the resolution has to pick the right one.
{
    const sourcePath = join(PLUGIN_ROOT, 'mcode-island.ps1');
    // The Marketplace package is only present on the branch that ships it.
    const packagePath = join(PLUGIN_ROOT, '..', '..', '..', 'marketplace', 'mcode-island', 'mcode-island.ps1');

    /**
     * Resolve the click target against one file, with both a desktop app
     * window and a caller terminal available.
     */
    function resolveClickTarget(file) {
        const src = readFileSync(file, 'utf8');
        const pref = (src.match(/\$script:clickPrefers\s*=\s*'([a-z]+)'/) || [])[1];
        if (!pref) throw new Error('the file does not declare $script:clickPrefers');
        const fn = extractFn(src, 'Resolve-ClickTarget');
        const script = `
$ErrorActionPreference = 'Stop'
# Both targets exist, so the preference decides.
function Resolve-PinnedWindow { return $null }
function Find-DesktopAppWindow { return [PSCustomObject]@{ Hwnd = 1; Pid = 2; Exe = 'fake-app' } }
function Resolve-CallerWindow { return [PSCustomObject]@{ Hwnd = 3; Pid = 4; Exe = 'fake-caller'; Source = 'console-window' } }
$script:clickPrefers = '${pref}'
${fn}
$t = Resolve-ClickTarget
Write-Output ("ORIGIN=" + $t.Origin + " MODE=" + $t.Mode)
`;
        const out = runPs(script);
        const origin = (out.match(/ORIGIN=(\S*)/) || [])[1];
        const mode = (out.match(/MODE=(\S*)/) || [])[1];
        return { pref, origin, mode };
    }

    // (a) the CLI install: the terminal wins, and the click keeps toggling
    let cli;
    try {
        cli = resolveClickTarget(sourcePath);
    } catch (e) {
        bad('the CLI click target is extractable', e.message);
    }
    if (cli) {
        eq('the CLI install prefers the caller terminal', cli.pref, 'terminal');
        eq('the CLI install resolves the click to the terminal', cli.origin, 'caller');
        eq('the CLI install keeps the show/hide toggle', cli.mode, 'toggle');
    }

    // (b) the Marketplace package: the desktop app wins, and it is focused
    if (!existsSync(packagePath)) {
        skipped++;
        console.log('[skip] the Marketplace package is not on this branch (the CLI install was checked)');
    } else {
        let pkg;
        try {
            pkg = resolveClickTarget(packagePath);
        } catch (e) {
            bad('the package click target is extractable', e.message);
        }
        if (pkg) {
            eq('the Marketplace package prefers the desktop app', pkg.pref, 'app');
            eq('the Marketplace package resolves the click to the app window', pkg.origin, 'desktop-app');
            eq('the Marketplace package focuses instead of hiding', pkg.mode, 'focus');
        }
    }
}

// ---------------------------------------------------------------------------
// 10. The multi-session tracker (v0.5.0)
// ---------------------------------------------------------------------------
//
// The tracker is a separate PowerShell harness: it assembles the scope
// the tracker lib expects (the detector's constants, Get-LastJsonLine,
// Test-IsAskUser, the store lock) against a FIXTURE session tree, and
// asserts the state machine, the entry rule, the title extraction, the
// persistence and the dismissal. It emits TAP-ish lines.
//
// It runs in its own process because the tracker lib keeps state in
// $script: variables, and dot-sourcing it into this process would mix
// the fixture's state with the detector's.
if (PS_BIN) {
    const trackerSuite = join(PLUGIN_ROOT, 'scripts', 'test-session-tracker.ps1');
    check('the session tracker suite exists', existsSync(trackerSuite), `${trackerSuite} not found`);

    if (existsSync(trackerSuite)) {
        const out = runPs(`& '${trackerSuite.replace(/'/g, "''")}'`, undefined, true);
        const lines = out.split(/\r?\n/);
        let okCount = 0;
        let badCount = 0;
        const bad = [];
        for (const l of lines) {
            if (/^ok \d+ - /.test(l)) { okCount++; }
            else if (/^not ok \d+ - /.test(l)) { badCount++; bad.push(l.replace(/^not ok \d+ - /, '')); }
        }
        check('the session tracker suite passes', badCount === 0 && okCount > 0,
            `${okCount} passed, ${badCount} failed: ${bad.join(' | ')}`);
        for (const b of bad) {
            console.log(`    FAIL ${b}`);
        }
        // The count is pinned so a silently empty harness cannot pass.
        check('the session tracker suite ran its full set of checks', okCount >= 20,
            `only ${okCount} checks ran`);
    }
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

console.log('-'.repeat(60));
console.log(`${pass} pass, ${fail} fail${skipped ? `, ${skipped} skipped (platform)` : ''}`);
if (fail > 0) {
    console.log('\nfailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
