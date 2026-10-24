#!/usr/bin/env node
// mcode-island v0.3.0 — pre-submit self-check for the io.minimax.mcode
// Hooks extension. Cross-platform (Windows / macOS / Linux), no
// dependencies beyond Node.js >= 18.
//
// Run from the plugin root:
//     node scripts/smoke.mjs
//
// Exits 0 on full pass, 1 on any failure. Prints a per-check line
// with PASS / WARN / FAIL, then a summary.
//
// What it checks:
//   1. plugin.json: $schema / name / version / extensions.io.minimax.mcode
//   2. hooks.json: parses, top-level has `hooks` object
//   3. event catalog: every event is in the spec allowlist
//      (5 `yes` in 0.2.4, 7 `forward` — `forward` is a warn, not a fail)
//   4. hook entries: no reserved fields (type, shell, prompt, http,
//      agent, script, function), env does not reserve PLUGIN_ROOT /
//      PLUGIN_DATA, command is either a bare executable or a path
//      starting with ${PLUGIN_ROOT}/
//   5. script files: every hook entry's referenced .ps1 file actually
//      exists under io.minimax.mcode/hooks/scripts/
//   6. cross-platform: no hardcoded host-absolute paths, no
//      /Users/ or /home/ literals in any script or hooks.json entry

import { readFile, stat, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');

const RESERVED_FIELDS = new Set([
    'type', 'shell', 'prompt', 'http', 'agent', 'script', 'function',
]);
const RESERVED_ENV = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA']);

// 12-event catalog from proposals/hooks-detailed-spec.md. `yes` =
// confirmed in @minimax-ai/code@0.2.4 (Wso allowlist). `forward`
// = reserved by the portable spec, may or may not be wired in 0.2.4.
const EVENT_CATALOG = {
    SessionStart:     'yes',
    SessionEnd:       'yes',
    UserPromptSubmit: 'yes',
    PreToolUse:       'yes',
    PostToolUse:      'yes',
    Stop:             'forward',
    PreCompact:       'forward',
    Notification:     'forward',
    SubagentStart:    'forward',
    SubagentStop:     'forward',
    PermissionRequest:'forward',
    PermissionDenied: 'forward',
};

let pass = 0, warn = 0, fail = 0;
const out = (tag, msg) => {
    const sym = { PASS: 'OK  ', WARN: 'WARN', FAIL: 'FAIL' }[tag];
    console.log(`[${sym}] ${msg}`);
    if (tag === 'PASS') pass++;
    else if (tag === 'WARN') warn++;
    else fail++;
};

const exists = async (p) => {
    try { await stat(p); return true; } catch { return false; }
};

const readJson = async (p) => {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
};

const checkLiteralPaths = (s, where) => {
    // No hardcoded /Users/ or /home/ or C:\ prefixes inside the value.
    // ${PLUGIN_ROOT}/... is the only acceptable form.
    if (typeof s !== 'string') return;
    if (/^(\/Users\/|\/home\/|[A-Za-z]:\\|\/mnt\/)/.test(s)) {
        fail++;
        console.log(`[FAIL] ${where}: hardcoded host path "${s}"`);
    }
};

const checkEntry = async (event, entry) => {
    const where = `hooks.json[${event}]`;
    if (typeof entry !== 'object' || entry === null) {
        out('FAIL', `${where}: entry is not an object`); return;
    }

    for (const key of Object.keys(entry)) {
        if (RESERVED_FIELDS.has(key)) {
            out('FAIL', `${where}: uses reserved field "${key}"`);
        }
    }

    if (entry.env) {
        if (typeof entry.env !== 'object' || Array.isArray(entry.env)) {
            out('FAIL', `${where}: env is not a record`);
        } else {
            for (const k of Object.keys(entry.env)) {
                if (RESERVED_ENV.has(k)) {
                    out('FAIL', `${where}: env reserves "${k}"`);
                }
            }
        }
    }

    if (!entry.command) {
        out('FAIL', `${where}: missing "command"`);
    } else if (typeof entry.command !== 'string') {
        out('FAIL', `${where}: command is not a string`);
    }

    if (entry.args !== undefined && !Array.isArray(entry.args)) {
        out('FAIL', `${where}: args is not an array`);
    }

    if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
        out('FAIL', `${where}: matcher is not a string`);
    }

    if (entry.timeout !== undefined) {
        if (typeof entry.timeout !== 'number' || entry.timeout <= 0) {
            out('FAIL', `${where}: timeout is not a positive number`);
        } else if (entry.timeout > 30000) {
            out('WARN', `${where}: timeout ${entry.timeout}ms exceeds portable default 30000ms`);
        }
    }

    // Scan args for host-literal paths. The command itself we
    // already validated above; args often contain the actual script
    // path. We don't run any path-resolution here — that's the
    // Runtime's job. We only check that nothing is hardcoded.
    for (const a of (entry.args || [])) {
        checkLiteralPaths(a, `${where}.args[]`);
    }

    // Find the script path inside the args (last .ps1/.mjs/.js/.ps1
    // token that isn't a switch). We don't need exact matching — we
    // just check that at least one script file under
    // io.minimax.mcode/hooks/scripts/ exists and is referenced.
    const scriptArg = (entry.args || []).find(
        (a) => typeof a === 'string' && /\.(ps1|mjs|js)$/i.test(a)
    );
    if (scriptArg) {
        // Strip ${PLUGIN_ROOT}/ prefix and resolve relative to PLUGIN_ROOT.
        const cleaned = scriptArg.replace(/^\$\{PLUGIN_ROOT\}/, '');
        const absolute = join(PLUGIN_ROOT, cleaned);
        if (!(await exists(absolute))) {
            out('FAIL', `${where}: script not found: ${cleaned}`);
        } else {
            out('PASS', `${where}: script ${cleaned} exists`);
        }
    }
};

const main = async () => {
    console.log(`mcode-island v0.4.0 self-check`);
    console.log(`plugin root: ${PLUGIN_ROOT}`);
    console.log('-'.repeat(60));

    // 1. plugin.json
    const pluginJsonPath = join(PLUGIN_ROOT, 'plugin.json');
    if (!(await exists(pluginJsonPath))) {
        out('FAIL', 'plugin.json missing'); return finish();
    }
    let plugin;
    try {
        plugin = await readJson(pluginJsonPath);
        out('PASS', 'plugin.json parses');
    } catch (e) {
        out('FAIL', `plugin.json: ${e.message}`); return finish();
    }

    if (plugin.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') {
        out('FAIL', `plugin.json: $schema is "${plugin.$schema}", expected agent-plugins 1.0.0`);
    } else {
        out('PASS', 'plugin.json: $schema is agent-plugins 1.0.0');
    }
    if (plugin.name !== 'mcode-island') {
        out('FAIL', `plugin.json: name is "${plugin.name}"`);
    } else {
        out('PASS', `plugin.json: name is "${plugin.name}"`);
    }
    if (plugin.version !== '0.4.0') {
        out('FAIL', `plugin.json: version is "${plugin.version}", expected "0.4.0"`);
    } else {
        out('PASS', `plugin.json: version is "${plugin.version}"`);
    }

    if (!plugin.extensions || !plugin.extensions['io.minimax.mcode']) {
        out('FAIL', 'plugin.json: missing extensions["io.minimax.mcode"]');
    } else {
        const ext = plugin.extensions['io.minimax.mcode'];
        out('PASS', 'plugin.json: extensions.io.minimax.mcode is present');
        if (!ext.hooks) {
            out('FAIL', 'plugin.json: extensions.io.minimax.mcode.hooks is missing');
        } else {
            const hooksRel = ext.hooks.replace(/^\.\//, '');
            const hooksAbs = join(PLUGIN_ROOT, hooksRel);
            if (!(await exists(hooksAbs))) {
                out('FAIL', `plugin.json: extensions.io.minimax.mcode.hooks points to missing file ${hooksRel}`);
            } else {
                out('PASS', `plugin.json: extensions.io.minimax.mcode.hooks resolves to ${hooksRel}`);
            }
        }
    }

    // 2. hooks.json
    const hooksJsonPath = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'hooks.json');
    if (!(await exists(hooksJsonPath))) {
        out('FAIL', 'io.minimax.mcode/hooks/hooks.json missing'); return finish();
    }
    let hooksDoc;
    try {
        hooksDoc = await readJson(hooksJsonPath);
        out('PASS', 'io.minimax.mcode/hooks/hooks.json parses');
    } catch (e) {
        out('FAIL', `io.minimax.mcode/hooks/hooks.json: ${e.message}`); return finish();
    }

    const hooksRoot = hooksDoc.hooks || hooksDoc;
    if (typeof hooksRoot !== 'object' || Array.isArray(hooksRoot) || hooksRoot === null) {
        out('FAIL', 'io.minimax.mcode/hooks/hooks.json: `hooks` is not an object keyed by event');
        return finish();
    }
    out('PASS', 'io.minimax.mcode/hooks/hooks.json: `hooks` is an object');

    // 2b. closed-schema conformance (round-4 R21-1).
    // The companion proposal (MiniMax-Code-Plugins PR #20) defines the
    // root keys as a closed allowlist of { $schema, hooks }. Anything
    // else (notably the historical `_comment` field) is rejected. We
    // import the shared validator to avoid drifting from the proposal.
    try {
        const { validateHooksDocument, HOOK_SCHEMA } = await import(
            fileURLToPath(new URL('../../../../../scripts/lib/validation.mjs', import.meta.url))
        ).catch(() => ({}));
        if (typeof validateHooksDocument === 'function') {
            try {
                validateHooksDocument(hooksDoc, 'mcode-island/hooks.json');
                out('PASS', 'hooks.json conforms to closed schema (HOOK_DOCUMENT_FIELDS)');
            } catch (e) {
                // Round-4: a stray _comment or any unknown root key
                // becomes a hard FAIL, not a soft WARN.
                out('FAIL', `hooks.json: ${e.message} (closed schema: $schema + hooks only)`);
                return finish();
            }
            if (hooksDoc.$schema && hooksDoc.$schema !== HOOK_SCHEMA) {
                out('FAIL', `hooks.json: $schema is ${hooksDoc.$schema} but the proposal pins ${HOOK_SCHEMA}`);
                return finish();
            }
            if (hooksDoc.$schema === HOOK_SCHEMA) {
                out('PASS', `hooks.json: $schema pinned to ${HOOK_SCHEMA}`);
            }
        } else {
            // Fallback: do the closed-schema check inline so the test
            // does not depend on the validator being importable.
            const known = new Set(['$schema', 'hooks']);
            const unknown = Object.keys(hooksDoc).filter((k) => !known.has(k));
            if (unknown.length > 0) {
                out('FAIL', `hooks.json: unknown root field(s) ${unknown.map((k) => JSON.stringify(k)).join(', ')} (closed schema: $schema + hooks only)`);
                return finish();
            }
            out('PASS', 'hooks.json: closed schema (no unknown root fields)');
        }
    } catch (e) {
        out('WARN', `hooks.json: closed-schema check skipped: ${e.message}`);
    }

    // 3. event catalog
    const eventNames = Object.keys(hooksRoot);
    if (eventNames.length === 0) {
        out('FAIL', 'io.minimax.mcode/hooks/hooks.json: no events declared');
    }
    for (const ev of eventNames) {
        if (!(ev in EVENT_CATALOG)) {
            out('FAIL', `event "${ev}" is not in the portable spec allowlist`);
        } else if (EVENT_CATALOG[ev] === 'forward') {
            out('WARN', `event "${ev}" is "forward" (not confirmed in @minimax-ai/code@0.2.4)`);
        } else {
            out('PASS', `event "${ev}" is "yes" (confirmed in 0.2.4)`);
        }
    }
    for (const ev of Object.keys(EVENT_CATALOG)) {
        if (!eventNames.includes(ev)) {
            out('WARN', `spec allowlist includes "${ev}" but it is not declared in hooks.json`);
        }
    }

    // 4. entries
    for (const [event, entries] of Object.entries(hooksRoot)) {
        if (!Array.isArray(entries)) {
            out('FAIL', `hooks.json[${event}]: not an array`); continue;
        }
        for (const entry of entries) {
            await checkEntry(event, entry);
        }
    }

    // 5. _lib.ps1 exists and parses (basic check)
    const libPath = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts', '_lib.ps1');
    if (!(await exists(libPath))) {
        out('FAIL', 'io.minimax.mcode/hooks/scripts/_lib.ps1 missing');
    } else {
        const lib = await readFile(libPath, 'utf8');
        for (const fn of ['Read-HookStdin', 'Push-Island', 'Test-IsSelfPush', 'Format-ToolSummary']) {
            if (!lib.includes(`function ${fn}`)) {
                out('WARN', `_lib.ps1: function ${fn} not found`);
            }
        }
        out('PASS', '_lib.ps1: shared helper present');
    }

    // 5d. The 5h-usage lib must exist (round-11 refactor). The
    // detector dot-sources it at the top of its init block, AND
    // .github/workflows/mcode-island-windows.yml step 4 dot-sources
    // it on a CI runner that has no mcode installed. A missing
    // lib breaks both: the detector silently no-ops (the
    // dot-source line throws "is not recognized" in strict mode,
    // or the function just does not exist) and the CI step 4
    // fails with "term 'Get-5hUsage' is not recognized". Either
    // way, this smoke FAIL surfaces the regression before the
    // PR is submitted.
    const usageLibPath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Get-5hUsage.ps1');
    if (!(await exists(usageLibPath))) {
        out('FAIL', 'scripts/lib/Get-5hUsage.ps1 missing (round-11 lib required by detector and CI step 4)');
    } else {
        const usageLib = await readFile(usageLibPath, 'utf8');
        if (!usageLib.includes('function Get-5hUsage')) {
            out('FAIL', 'scripts/lib/Get-5hUsage.ps1: function Get-5hUsage not found');
        } else {
            out('PASS', 'scripts/lib/Get-5hUsage.ps1: function Get-5hUsage present');
        }
        if (!/\$PLAN_API_HOST\s*=/.test(usageLib) || !/\$PLAN_API_PATH\s*=/.test(usageLib)) {
            out('FAIL', 'scripts/lib/Get-5hUsage.ps1: $PLAN_API_HOST or $PLAN_API_PATH constant missing');
        } else {
            out('PASS', 'scripts/lib/Get-5hUsage.ps1: URL constants present');
        }
    }

    // 5c1. Sub-step progress extension (round-13 refactor).
    // notify-island.ps1 must accept -Step/-Total/-Detail and write them
    // into status.json. mcode-island.ps1 widget must define
    // Build-DisplayMessage and pass step/total/detail to it.
    // _lib.ps1 Format-ToolSummary must extract mcode-computer-use
    // action+coordinate; Push-Island must forward the new fields.
    // The detailed functional tests live in test-substep-progress.mjs;
    // here we lock the surface contract so a future refactor that
    // drops the params surfaces in smoke (fast path) before reaching
    // the slower pwsh-spawned tests.
    const substepNotifyPath = join(PLUGIN_ROOT, 'notify-island.ps1');
    const substepWidgetPath = join(PLUGIN_ROOT, 'mcode-island.ps1');
    if (!(await exists(substepNotifyPath))) {
        out('FAIL', 'notify-island.ps1 missing (sub-step lock skipped)');
    } else {
        const notify = await readFile(substepNotifyPath, 'utf8');
        if (!/\[int\]\$Step\s*=\s*-1/.test(notify) ||
            !/\[int\]\$Total\s*=\s*-1/.test(notify) ||
            !/\[string\]\$Detail\s*=\s*''/.test(notify)) {
            out('FAIL', 'notify-island.ps1: missing -Step/-Total/-Detail params');
        } else {
            out('PASS', 'notify-island.ps1: declares -Step -Total -Detail');
        }
        if (!/step\s*=\s*\$Step/.test(notify) ||
            !/total\s*=\s*\$Total/.test(notify) ||
            !/detail\s*=\s*\$Detail/.test(notify)) {
            out('FAIL', 'notify-island.ps1: status.json payload missing step/total/detail fields');
        } else {
            out('PASS', 'notify-island.ps1: writes step/total/detail to status.json');
        }
    }
    if (await exists(substepWidgetPath)) {
        const widget = await readFile(substepWidgetPath, 'utf8');
        if (!/function Build-DisplayMessage/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: Build-DisplayMessage function missing');
        } else {
            out('PASS', 'mcode-island.ps1: Build-DisplayMessage function present');
        }
        if (!/\[int\]\$Step\s*=\s*-1/.test(widget) ||
            !/\[int\]\$Total\s*=\s*-1/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: Update-State missing Step/Total params');
        } else {
            out('PASS', 'mcode-island.ps1: Update-State accepts Step/Total/Detail');
        }
    }
    const substepTestPath = join(PLUGIN_ROOT, 'scripts', 'test-substep-progress.mjs');
    if (!(await exists(substepTestPath))) {
        out('WARN', 'scripts/test-substep-progress.mjs missing (sub-step detailed tests not run)');
    } else {
        out('PASS', 'scripts/test-substep-progress.mjs exists (run separately for full suite)');
    }

    // 5c2. Click target resolution (desktop-app adaptation).
    //
    // The click used to be a plain show/hide toggle of the caller's terminal.
    // In the desktop app the agent is hosted by the app and that terminal
    // window belongs to the app session, so "hide the terminal" is
    // meaningless there -- the agent keeps running behind a static pill.
    // What the user wants is "take me back to the app window".
    //
    // The contract is a priority chain, resolved on every click:
    //   1. manual pin (pin.json)   -> focus that window
    //   2. desktop app main window -> focus it
    //   3. the caller's terminal   -> keep the old show/hide toggle
    //
    // These locks are text-shaped (the widget is a WPF app; there is no
    // headless way to click it), so every one of them has to anchor on the
    // code that actually carries the contract -- and has to be able to fail.
    if (await exists(substepWidgetPath)) {
        const widget = await readFile(substepWidgetPath, 'utf8');

        // (a) the resolution helpers exist as named functions
        for (const [name, re] of [
            ['Resolve-CallerWindow', /function Resolve-CallerWindow\b/],
            ['Toggle-CallerWindow', /function Toggle-CallerWindow\b/],
            ['Resolve-ClickTarget', /function Resolve-ClickTarget\b/],
            ['Resolve-PinnedWindow', /function Resolve-PinnedWindow\b/],
            ['Find-DesktopAppWindow', /function Find-DesktopAppWindow\b/],
            ['Invoke-ClickTarget', /function Invoke-ClickTarget\b/],
            ['Focus-Window', /function Focus-Window\b/],
            ['Toggle-Window', /function Toggle-Window\b/],
        ]) {
            if (re.test(widget)) {
                out('PASS', `mcode-island.ps1: ${name} function present`);
            } else {
                out('FAIL', `mcode-island.ps1: ${name} function missing (click-target contract broken)`);
            }
        }

        // (b) the priority chain is in the right ORDER inside
        // Resolve-ClickTarget. Order is the whole contract: a pin that loses
        // to the desktop app is useless for a CLI user who happens to have
        // the app open at the same time.
        const clickTargetBody = (widget.match(/function Resolve-ClickTarget[\s\S]*?\n\}\n/) || [''])[0];
        if (!clickTargetBody) {
            out('FAIL', 'mcode-island.ps1: Resolve-ClickTarget body not found (priority drift lock skipped)');
        } else {
            const pinAt = clickTargetBody.indexOf('Resolve-PinnedWindow');
            const appAt = clickTargetBody.indexOf('Find-DesktopAppWindow');
            const callerAt = clickTargetBody.indexOf('Resolve-CallerWindow');
            if (pinAt < 0 || appAt < 0 || callerAt < 0) {
                out('FAIL', `mcode-island.ps1: Resolve-ClickTarget does not consult all three sources (pin=${pinAt} app=${appAt} caller=${callerAt})`);
            } else if (!(pinAt < appAt && appAt < callerAt)) {
                out('FAIL', `mcode-island.ps1: Resolve-ClickTarget priority order is wrong -- it must be pin -> desktop app -> caller terminal (offsets pin=${pinAt} app=${appAt} caller=${callerAt})`);
            } else {
                out('PASS', 'mcode-island.ps1: Resolve-ClickTarget resolves pin -> desktop app -> caller terminal in that order');
            }
            if (!/Mode\s*=\s*'focus'/.test(clickTargetBody)) {
                out('FAIL', "mcode-island.ps1: Resolve-ClickTarget does not mark any target as Mode = 'focus'");
            } else {
                out('PASS', "mcode-island.ps1: Resolve-ClickTarget marks the pin / desktop app as Mode = 'focus'");
            }
            if (!/Mode\s*=\s*'toggle'/.test(clickTargetBody)) {
                out('FAIL', "mcode-island.ps1: Resolve-ClickTarget does not keep Mode = 'toggle' for the caller's terminal");
            } else {
                out('PASS', "mcode-island.ps1: Resolve-ClickTarget keeps the caller's terminal on Mode = 'toggle'");
            }
        }

        // (c) the click handler goes through the dispatcher, not straight to
        // the toggle. A handler that still called Toggle-CallerWindow would
        // hide the terminal instead of focusing the app.
        const clickMatch = widget.match(/Add_MouseLeftButtonUp\([\s\S]*?\}\s*\)\s*$/m);
        if (!clickMatch) {
            out('WARN', 'mcode-island.ps1: Add_MouseLeftButtonUp handler not found (drift lock skipped)');
        } else if (!/Invoke-ClickTarget\b/.test(clickMatch[0])) {
            out('FAIL', 'mcode-island.ps1: MouseLeftButtonUp does not invoke Invoke-ClickTarget (the click would skip the desktop-app target)');
        } else if (/Toggle-CallerWindow\b/.test(clickMatch[0])) {
            out('FAIL', 'mcode-island.ps1: MouseLeftButtonUp still calls Toggle-CallerWindow directly -- it must go through Invoke-ClickTarget');
        } else {
            out('PASS', 'mcode-island.ps1: MouseLeftButtonUp invokes Invoke-ClickTarget (pin / desktop app / terminal resolved per click)');
        }

        // (d) the dispatcher honours the resolved Mode. Always focusing would
        // break the CLI "click to hide my terminal" muscle memory; always
        // toggling would hide the desktop app window.
        const dispatchBody = (widget.match(/function Invoke-ClickTarget[\s\S]*?\n\}\n/) || [''])[0];
        if (!dispatchBody) {
            out('FAIL', 'mcode-island.ps1: Invoke-ClickTarget body not found (mode dispatch drift lock skipped)');
        } else if (!/Focus-Window\s+\$t\b/.test(dispatchBody)) {
            out('FAIL', 'mcode-island.ps1: Invoke-ClickTarget does not call Focus-Window for a focus target');
        } else if (!/Toggle-Window\s+\$t\b/.test(dispatchBody)) {
            out('FAIL', 'mcode-island.ps1: Invoke-ClickTarget does not call Toggle-Window for a toggle target');
        } else if (!/\$t\.Mode\s*-eq\s*'focus'/.test(dispatchBody)) {
            out('FAIL', "mcode-island.ps1: Invoke-ClickTarget does not branch on the resolved Mode -- a dispatcher that always picks one behaviour breaks the other target kind");
        } else {
            out('PASS', 'mcode-island.ps1: Invoke-ClickTarget dispatches focus vs toggle by the resolved Mode');
        }

        // (e) the desktop app is found by process name, and only inside the
        // widget's own session. A cross-session match could focus another
        // session's app instance.
        const appFn = (widget.match(/function Find-DesktopAppWindow[\s\S]*?\n\}\n/) || [''])[0];
        if (!appFn) {
            out('FAIL', 'mcode-island.ps1: Find-DesktopAppWindow body not found');
        } else {
            if (!/MiniMax Inside Code/.test(widget)) {
                out('FAIL', "mcode-island.ps1: the desktop app allowlist does not contain 'MiniMax Inside Code' (the desktop app window would never be found)");
            } else {
                out('PASS', "mcode-island.ps1: the desktop app allowlist contains 'MiniMax Inside Code'");
            }
            if (!/SessionId\s*-eq\s*\$mySession/.test(appFn)) {
                out('FAIL', 'mcode-island.ps1: Find-DesktopAppWindow does not restrict the search to the widget session');
            } else {
                out('PASS', 'mcode-island.ps1: Find-DesktopAppWindow only considers processes in the widget session');
            }
        }

        // (f) focusing must never hide. Focus-Window serves the desktop app
        // and a pinned window; hiding the app would take the agent surface
        // away from the user, which is exactly the bug this adaptation fixes.
        const focusBody = (widget.match(/function Focus-Window[\s\S]*?\n\}\n/) || [''])[0];
        if (!focusBody) {
            out('FAIL', 'mcode-island.ps1: Focus-Window body not found');
        } else if (/ShowWindow\(\s*\$Target\.Hwnd\s*,\s*0\s*\)/.test(focusBody)) {
            out('FAIL', 'mcode-island.ps1: Focus-Window calls ShowWindow(SW_HIDE) -- focusing the desktop app must never hide it');
        } else if (!/SetForegroundWindow/.test(focusBody)) {
            out('FAIL', 'mcode-island.ps1: Focus-Window does not call SetForegroundWindow');
        } else {
            out('PASS', 'mcode-island.ps1: Focus-Window raises and activates without ever hiding the target');
        }

        // (g) the pin has to be sticky. It lives in pin.json, not in the
        // caller.json that every status transition overwrites: a pin stored
        // in caller.json dies at the next notify, which makes "the pin beats
        // the desktop app" unreachable in practice.
        const pinBody = (widget.match(/function Resolve-PinnedWindow[\s\S]*?\n\}\n/) || [''])[0];
        if (!pinBody) {
            out('FAIL', 'mcode-island.ps1: Resolve-PinnedWindow body not found');
        } else if (!/Join-Path[^\n]*pin\.json/.test(pinBody)) {
            // Anchor on the path expression, not on the bare file name: a
            // Dbg message that merely mentions pin.json must not satisfy
            // this lock.
            out('FAIL', 'mcode-island.ps1: Resolve-PinnedWindow does not read pin.json (the pin would be overwritten by every status transition)');
        } else {
            out('PASS', 'mcode-island.ps1: Resolve-PinnedWindow reads the sticky pin.json');
        }

        // (h) the writer has to write the file the resolver reads, and it
        // must not write caller.json -- that file is overwritten by every
        // status transition, so a pin stored there is gone at the next
        // notify.
        const pinWriterPath = join(PLUGIN_ROOT, 'pin-island.ps1');
        if (!(await exists(pinWriterPath))) {
            out('FAIL', 'pin-island.ps1 missing (pin writer drift lock skipped)');
        } else {
            const pinWriter = await readFile(pinWriterPath, 'utf8');
            // Anchor on the destination expression, not on the bare file
            // name: the file explains in a comment why it does NOT use
            // caller.json, and that comment must not satisfy this lock.
            if (!/Join-Path[^\n]*'pin\.json'/.test(pinWriter)) {
                out('FAIL', 'pin-island.ps1 does not write pin.json (the pin would not survive the next status transition)');
            } else if (/Join-Path[^\n]*'caller\.json'/.test(pinWriter)) {
                out('FAIL', 'pin-island.ps1 still writes caller.json (the pin would be overwritten by every status transition)');
            } else {
                out('PASS', 'pin-island.ps1 writes the sticky pin.json');
            }
        }

        // (i) unpin has to clear the sticky pin, otherwise the pin survives
        // the one command that exists to remove it.
        const cmdPath = join(PLUGIN_ROOT, 'mcode-island.cmd');
        if (!(await exists(cmdPath))) {
            out('FAIL', 'mcode-island.cmd missing (unpin drift lock skipped)');
        } else {
            const cmd = await readFile(cmdPath, 'utf8');
            // The label has to start the line: the dispatch table also
            // mentions "unpin" ("if /i "%1"=="unpin" goto :unpin").
            const unpinBlock = (cmd.match(/\r?\n:unpin[\s\S]*?exit \/b %errorlevel%/i) || [''])[0];
            if (!unpinBlock) {
                out('FAIL', 'mcode-island.cmd: the unpin command is missing');
            } else if (!/Remove-Item[^\n]*'mcode-island\\pin\.json'/.test(unpinBlock)) {
                // Anchor on the removal itself: the command's own output text
                // mentions "pin.json" and must not satisfy this lock.
                out('FAIL', 'mcode-island.cmd: unpin does not clear pin.json (the pinned window would stay the click target)');
            } else {
                out('PASS', 'mcode-island.cmd: unpin clears the sticky pin.json');
            }
        }

        // (j) the CLI install and the Marketplace package resolve the click
        // target differently, and the source says which one it is. The
        // Marketplace builder flips this ONE line to 'app' and fails the
        // build when it cannot find it, so a renamed switch cannot silently
        // ship the CLI behaviour to the desktop users.
        if (/\$script:clickPrefers\s*=\s*'terminal'/.test(widget)) {
            out('PASS', 'mcode-island.ps1: the CLI install prefers the caller terminal');
        } else {
            out('FAIL', "mcode-island.ps1: the CLI install does not declare $script:clickPrefers = 'terminal' -- the Marketplace builder flips that exact line");
        }
        if (/\$script:clickPrefers\s+-eq\s+'app'/.test(widget)) {
            out('PASS', 'mcode-island.ps1: Resolve-ClickTarget branches on the preference');
        } else {
            out('FAIL', 'mcode-island.ps1: Resolve-ClickTarget does not branch on $script:clickPrefers, so the two builds cannot differ');
        }

        // Round-15: Toggle's restore branch must call SW_MAXIMIZE (3), not
        // SW_SHOW (5) / SW_RESTORE (9). SW_HIDE preserves the window's
        // "non-maximized size"; if the WT window got accidentally resized
        // to a thin strip (e.g., 480x84 from a snap gesture or our own
        // mouse_event test artifacts), SW_SHOW / SW_RESTORE would re-show
        // it as that strip — the user's complaint was "hide works, show is
        // a thin strip". SW_MAXIMIZE forces full-screen on hidden /
        // minimized / normal windows alike; no-op on already-maximized.
        const toggleMatch = widget.match(/function Toggle-Window[\s\S]*?\n\}\n/);
        if (!toggleMatch) {
            out('WARN', 'mcode-island.ps1: Toggle-Window body not found (drift lock skipped)');
        } else {
            const toggleBody = toggleMatch[0];
            // Round-15 (rewritten): "show the window full-screen" now lives
            // in ONE helper, and every caller must use it.
            //
            //   SW_MAXIMIZE (3), not SW_SHOW (5) / SW_RESTORE (9): SW_HIDE
            //   preserves the window's "non-maximized size", and if that
            //   size got clobbered -- a SetWindowPos without SWP_NOSIZE
            //   resizes WT to 0x0 and WT clamps it to a ~480x84 strip --
            //   then SW_SHOW / SW_RESTORE re-shows the strip instead of the
            //   window. That was the user's "show is a thin strip" bug.
            //
            // The session-list click needs the same guarantee (it raises
            // the terminal without toggling it), so the helper is shared
            // and the lock has to check the helper AND both callers
            // instead of the text inside Toggle-Window alone.
            const fullScreenMatch = widget.match(/function Show-WindowFullScreen[\s\S]*?\n\}\n/);
            if (!fullScreenMatch) {
                out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen helper not found -- the restore path and the session click both need one implementation that maximizes to the work area');
            } else {
                const fsBody = fullScreenMatch[0];
                const maximizeAt = fsBody.search(/ShowWindow\(\s*\$h\s*,\s*3\s*\)/);
                const restoreAt = fsBody.search(/ShowWindow\(\s*\$h\s*,\s*9\s*\)/);
                const showAt = fsBody.search(/ShowWindow\(\s*\$h\s*,\s*5\s*\)/);
                if (maximizeAt < 0) {
                    out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen does not call SW_MAXIMIZE (ShowWindow(_, 3)). A regression to SW_SHOW (5) or SW_RESTORE (9) re-shows the window at its pre-hide size (e.g., 480x84 strip if WT got accidentally resized).');
                } else if (showAt >= 0) {
                    out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen calls SW_SHOW (5) -- SW_SHOW re-shows the window at its pre-hide size and defeats the maximize intent.');
                } else if (restoreAt < 0) {
                    // SW_RESTORE has to come FIRST: the SetWindowPos that
                    // writes the restored size only takes effect while the
                    // window is in its normal (not maximized) state.
                    out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen does not call SW_RESTORE (9) before the maximize -- without it the SetWindowPos cannot write the restored size, so a stale size (e.g. a 480x84 strip) survives the next restore.');
                } else if (restoreAt > maximizeAt) {
                    out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen calls SW_RESTORE (9) AFTER SW_MAXIMIZE (3) -- restoring after the maximize puts the window back at its pre-hide size (the 480x84 strip bug).');
                } else if (!/Show-WindowFullScreen/.test(toggleBody)) {
                    out('FAIL', 'mcode-island.ps1: Toggle-Window does not call Show-WindowFullScreen -- the show path would skip the maximize and go back to the pre-hide size.');
                } else {
                    const focusTermMatch = widget.match(/function Focus-TerminalWindow[\s\S]*?\n\}\n/);
                    const focusTermBody = focusTermMatch ? focusTermMatch[0] : '';
                    if (!focusTermBody) {
                        out('FAIL', 'mcode-island.ps1: Focus-TerminalWindow body not found -- the session click must raise the terminal full-screen too');
                    } else if (!/Show-WindowFullScreen/.test(focusTermBody)) {
                        out('FAIL', 'mcode-island.ps1: Focus-TerminalWindow does not call Show-WindowFullScreen -- raising the terminal from the session list would restore whatever "normal size" the window last had (e.g. a 480x84 strip in the top-left corner)');
                    } else {
                        out('PASS', 'mcode-island.ps1: the restore path and the session click both force SW_MAXIMIZE via Show-WindowFullScreen (full-screen on show, fixes the 480x84 strip)');
                    }
                }
            }

            // Round-16 (rewritten): the work-area size lives in the same
            // helper now, so the lock follows it there.
            //
            // SW_MAXIMIZE alone is insufficient on multi-monitor +
            // DPI-virtualized setups: the user's primary monitor is
            // physically 2560x1440, but WinForms [Screen]::PrimaryScreen
            // reports 1920x1080 (DPI virtualization). SW_MAXIMIZE follows
            // the 1920x1080 number and leaves WT at ~75% of the physical
            // screen -- visually "in the top-left corner" of the user's 2K
            // monitor. The drift lock forces the explicit SetWindowPos
            // path.
            const fullScreenBody = fullScreenMatch ? fullScreenMatch[0] : '';
            if (!/GetWorkAreaForWindow|GetMonitorInfo|MonitorFromWindow/.test(fullScreenBody)) {
                out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen does not query the monitor work area. Without MonitorFromWindow + SetWindowPos(explicit size), SW_MAXIMIZE alone fills only the WinForms 1920x1080 logical work area, not the actual 2560x1440 physical monitor -- leaves WT at the top-left 75%.');
            } else if (!/SetWindowPos\([^)]*\$wa\.|SetWindowPos\(\$h,[^,]+,\s*\$wa\.Left,\s*\$wa\.Top,\s*\$cx,\s*\$cy/.test(fullScreenBody)) {
                out('FAIL', 'mcode-island.ps1: Show-WindowFullScreen has the monitor query but does not SetWindowPos with work-area coords. The contract is: read monitor work area, then SetWindowPos with explicit (Left, Top, cx, cy) -- never rely on SW_MAXIMIZE alone for size.');
            } else {
                out('PASS', 'mcode-island.ps1: the full-screen path forces work-area size via MonitorFromWindow + SetWindowPos (fills 2560x1440 physical monitor, not just 1920x1080 logical)');
            }

            // Round-17 + round-19: the follow-up z-order SetWindowPos call
            // (HWND_TOP, to push WT forward without foreground permission)
            // must carry both SWP_NOSIZE and SWP_NOMOVE, and must NOT carry
            // SWP_NOZORDER.
            //
            //   SWP_NOSIZE  cx=0/cy=0 is otherwise "resize to 0x0", triggering
            //               WT's min-size fallback to a 480x76 strip — the
            //               exact regression the user saw in round-17.
            //   SWP_NOMOVE  X=0/Y=0 is otherwise "move to (0,0)". Invisible on
            //               a single primary monitor, but any secondary monitor
            //               whose origin is not 0 gets the restored window
            //               yanked to the primary's top-left corner
            //               (round-19 review #3).
            //   no SWP_NOZORDER  that flag makes Windows ignore
            //               hWndInsertAfter entirely, so passing HWND_TOP
            //               alongside it is self-defeating: the whole point of
            //               this call is the z-order change.
            //
            // The round-17 version of this lock asserted the literal
            // `SWP_NOZORDER -bor SWP_NOSIZE`, which is exactly the pair the
            // review asked to change, so it had to be rewritten rather than
            // updated. Match on the flag names, not their order.
            if (!/SWP_NOSIZE\s*=\s*0x0001/.test(widget)) {
                out('FAIL', 'mcode-island.ps1: WinAPI class missing SWP_NOSIZE constant (0x0001).');
            } else if (!/SWP_NOMOVE\s*=\s*0x0002/.test(widget)) {
                out('FAIL', 'mcode-island.ps1: WinAPI class missing SWP_NOMOVE constant (0x0002).');
            } else {
                // Pull the flags expression that feeds the HWND_TOP call. It
                // is assigned just ABOVE the call, not inside it, so anchor on
                // the assignment and look for the HWND_TOP call within the
                // same statement rather than scanning forward from the call.
                const flagsExpr = (toggleBody.match(/\$nofollow\s*=\s*([^\n\r]+)/) || [null, ''])[1];
                const hasZorderCall = /SetWindowPos\([^)]*HWND_TOP/.test(toggleBody);

                const problems = [];
                if (!hasZorderCall) {
                    problems.push('the HWND_TOP SetWindowPos call is gone, so the window is never pushed forward');
                }
                if (!/SWP_NOSIZE/.test(flagsExpr)) {
                    problems.push('SWP_NOSIZE (cx=0/cy=0 would resize WT to 0x0 and trigger its 480x76 min-size fallback)');
                }
                if (!/SWP_NOMOVE/.test(flagsExpr)) {
                    problems.push('SWP_NOMOVE (X=0/Y=0 would move the window to (0,0) on any monitor whose origin is not 0)');
                }
                if (/SWP_NOZORDER/.test(flagsExpr)) {
                    problems.push('SWP_NOZORDER is present, which makes Windows ignore hWndInsertAfter and defeats the HWND_TOP z-order call');
                }

                if (problems.length > 0) {
                    for (const p of problems) {
                        out('FAIL', `mcode-island.ps1: Toggle z-order SetWindowPos(HWND_TOP) — ${p}`);
                    }
                } else {
                    out('PASS', 'mcode-island.ps1: Toggle z-order SetWindowPos carries SWP_NOSIZE + SWP_NOMOVE and omits SWP_NOZORDER (size preserved, position preserved, z-order actually applied)');
                }
            }
        }
    }

    // 5d. Drift lock: the round-18 tool-verb table. The pill shows a
    // present-tense verb ("Running") while a tool is in flight and a
    // past-tense one ("Ran") once it returns, mirroring the mcode CLI TUI
    // descriptor table (launcher-GHPADSKI.js HL[]). Before this the pill
    // showed the bare tool name for every phase, so "working" and "done"
    // were indistinguishable at a glance.
    //
    // These locks are deliberately text-shaped rather than behavioral: a
    // behavioral test would need a real mcode session log. What we can
    // cheaply guarantee is that (a) the table exists, (b) it covers the
    // tools the detector actually infers, and (c) all three Infer-State
    // branches route through the verb lookup instead of hardcoding names.
    const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
    if (!(await exists(detectPath))) {
        out('FAIL', 'mcode-status-detect.ps1 missing (tool-verb drift lock skipped)');
    } else {
        const detect = await readFile(detectPath, 'utf8');

        // (a) table + helpers present
        for (const [label, re] of [
            ['$TOOL_ACTIONS table', /\$TOOL_ACTIONS\s*=\s*@\{/],
            ['$TOOL_FAMILIES table', /\$TOOL_FAMILIES\s*=\s*@\{/],
            ['Get-ToolKey helper', /function Get-ToolKey\s*\(/],
            ['Get-ToolVerb helper', /function Get-ToolVerb\s*\(/],
            ['Get-ToolVerbFallback helper', /function Get-ToolVerbFallback\s*\(/],
            ['Get-ToolFamily helper', /function Get-ToolFamily\s*\(/],
        ]) {
            if (re.test(detect)) {
                out('PASS', `mcode-status-detect.ps1: ${label} present`);
            } else {
                out('FAIL', `mcode-status-detect.ps1: ${label} missing (round-18 tool-verb contract broken)`);
            }
        }

        // (b) the table covers the tools users actually see. Each entry must
        // carry all three phases; a partial entry would render an empty
        // message and the pill would silently go blank for that tool.
        const actionsMatch = detect.match(/\$TOOL_ACTIONS\s*=\s*@\{([\s\S]*?)\n\}/);
        if (!actionsMatch) {
            out('FAIL', 'mcode-status-detect.ps1: cannot slice $TOOL_ACTIONS body');
        } else {
            const body = actionsMatch[1];
            const entryRe = /'([a-z0-9_]+)'\s*=\s*@\{\s*running\s*=\s*'([^']*)'\s*;\s*done\s*=\s*'([^']*)'\s*;\s*fail\s*=\s*'([^']*)'\s*\}/g;
            const found = new Map();
            let m;
            while ((m = entryRe.exec(body)) !== null) {
                found.set(m[1], { running: m[2], done: m[3], fail: m[4] });
            }
            out('PASS', `mcode-status-detect.ps1: $TOOL_ACTIONS has ${found.size} entries with all 3 phases`);

            for (const required of ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'task']) {
                if (found.has(required)) {
                    out('PASS', `$TOOL_ACTIONS covers "${required}"`);
                } else {
                    out('FAIL', `$TOOL_ACTIONS is missing "${required}" (the pill would show a bare name for it)`);
                }
            }
            // Every mapped family must resolve to a family, otherwise the
            // widget's $familyMap lookup silently falls back to the state
            // color and the round-18 tinting never happens.
            const famMatch = detect.match(/\$TOOL_FAMILIES\s*=\s*@\{([\s\S]*?)\n\}/);
            if (!famMatch) {
                out('FAIL', 'mcode-status-detect.ps1: cannot slice $TOOL_FAMILIES body');
            } else {
                for (const [key, fam] of Object.entries({
                    bash: 'shell', read: 'read', edit: 'write', write: 'write',
                    grep: 'search', glob: 'search', task: 'task',
                    task_output: 'task', ask_user: 'task',
                    web_search: 'web', web_fetch: 'web', todowrite: 'plan',
                })) {
                    // ask_user is intentionally excluded from this list. It was
                    // mapped to the 'task' family in round-18 and is deliberately
                    // unmapped in 5d2, where it reports `waiting` instead.
                    if (key === 'ask_user') continue;
                    const re = new RegExp(`'${key}'\\s*=\\s*'${fam}'`);
                    if (re.test(famMatch[1])) {
                        out('PASS', `$TOOL_FAMILIES maps "${key}" -> "${fam}"`);
                    } else {
                        out('FAIL', `$TOOL_FAMILIES does not map "${key}" -> "${fam}" (widget tinting will not fire for it)`);
                    }
                }
            }
        }

        // (c) all three Infer-State branches must route through the verb
        // lookup. This is the actual regression: reverting any one branch to
        // `"$($m.toolName) $MSG_OK"` would still pass a "table exists" check
        // while the pill went back to showing a bare name.
        //
        // There are TWO sites per state (the ledger.jsonl branch and the
        // messages.jsonl branch), so a presence test is not enough -- breaking
        // only the ledger branch leaves the messages branch matching and the
        // check stays green. These locks assert a minimum occurrence count so
        // that reverting EITHER site goes red.
        for (const [label, re, min] of [
            ['WORKING branch uses Get-ToolVerb', /state=\$S_WORKING;\s*message="\$verb\s/g, 2],
            ['DONE branch uses Get-ToolVerb', /state=\$S_DONE;\s*message=\$verb/g, 2],
            ['ERROR branch uses Get-ToolVerb', /state=\$S_ERROR;\s*message=\$verb/g, 2],
        ]) {
            const hits = detect.match(re);
            const n = hits ? hits.length : 0;
            if (n >= min) {
                out('PASS', `mcode-status-detect.ps1: ${label} (${n}/${min} sites)`);
            } else {
                out('FAIL', `mcode-status-detect.ps1: ${label} -- only ${n}/${min} sites use the verb lookup; a branch was reverted to a hardcoded tool name`);
            }
        }

        // (d) family must be threaded to disk, or the widget can never tint.
        if (/family\s*=\s*\$famField/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: Write-Status emits the family field');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: Write-Status does not emit `family` (widget tinting is dead code)');
        }

        // 5d2. Drift lock: ask_user must report `waiting`, not `working`.
        //
        // ask_user is the only tool whose "in flight" state means the agent is
        // BLOCKED on the user rather than busy. Showing it as `working` tells
        // the user "leave it alone, it is making progress", which is the
        // opposite of the truth and defeats the entire point of the state.
        // This matters most on `full access` setups, where the permission hook
        // never fires and ask_user is the only thing that ever blocks.
        for (const [label, re] of [
            ['$S_WAITING is defined', /\$S_WAITING\s*=\s*(?:_s\s*\(|')/],
            ['Test-IsAskUser helper', /function Test-IsAskUser\s*\(/],
            ['Get-AskQuestionCount helper', /function Get-AskQuestionCount\s*\(/],
        ]) {
            if (re.test(detect)) {
                out('PASS', `mcode-status-detect.ps1: ${label} present`);
            } else {
                out('FAIL', `mcode-status-detect.ps1: ${label} missing (ask_user cannot report waiting)`);
            }
        }

        // Both tool paths (ledger.jsonl and messages.jsonl) must route
        // ask_user to waiting. A presence test is not enough here for the same
        // reason as the verb locks above: there are two sites, and breaking one
        // leaves the other matching.
        const askSites = detect.match(/state=\$S_WAITING;\s*message="Asking \$n question/g) || [];
        if (askSites.length >= 2) {
            out('PASS', `mcode-status-detect.ps1: both ask_user tool paths report waiting (${askSites.length}/2 sites)`);
        } else {
            out('FAIL', `mcode-status-detect.ps1: only ${askSites.length}/2 ask_user paths report waiting; a path still treats a blocked agent as busy`);
        }

        // $args is a PowerShell automatic variable. Naming a function parameter
        // $args shadows it, and every read inside the function returns the
        // function's own argument list instead of the caller's value -- which
        // here silently produced a question count of 0 for every input. Lock
        // the parameter name so the regression cannot come back unnoticed.
        if (/function Get-AskQuestionCount\(\$toolArgs\)/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: Get-AskQuestionCount avoids the $args automatic variable');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: Get-AskQuestionCount takes $args, which shadows the PowerShell automatic variable and always yields a count of 0');
        }

        // waiting must be in BOTH settle sets. The 60s no-activity fallback
        // would otherwise downgrade a pending questionnaire to "已静默 60s"
        // exactly when the user has been away longest, and the takeover
        // arbitration would let a hook-pushed `working` win forever.
        for (const [label, re] of [
            ['60s idle fallback exempts waiting', /\$isSettled\s*=.*-or\s*\(\$curState\s+-eq\s+\$S_WAITING\)/],
            ['takeover arbitration treats waiting as settle', /\$isSettleNew\s*=.*-or\s*\(\$newState\s+-eq\s+\$S_WAITING\)/],
        ]) {
            if (re.test(detect)) {
                out('PASS', `mcode-status-detect.ps1: ${label}`);
            } else {
                out('FAIL', `mcode-status-detect.ps1: ${label} (a pending ask_user would be downgraded or shadowed)`);
            }
        }

        // ask_user must NOT carry a family tint: it wears the waiting state
        // color, and painting it the task cyan would look like an in-flight
        // delegation -- the confusion this change exists to remove.
        if (!/'ask_user'\s*=\s*'task'/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: ask_user carries no family tint (waits in the state color)');
        } else {
            out('FAIL', "mcode-status-detect.ps1: ask_user is still mapped to the 'task' family, so a blocked agent wears the delegation color");
        }

        // (h) The session-log reader must survive a fat last line.
        //
        // One session-log line can be hundreds of KB (a screenshot read
        // writes the base64 image into a single line). A reader that looks at
        // a fixed 64 KB tail window sees nothing but a fragment of that
        // line, fails to parse it, and answers with the previously cached
        // inference -- which belongs to an EARLIER session. The pill then
        // shows the previous task's state for the whole new conversation.
        // This is the reported bug; the behavioral proof lives in
        // test-substep-progress.mjs, these are the cheap guards.
        if (/function Get-LastJsonLine\b/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: the session-log reader has a dedicated tail-line reader');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: no Get-LastJsonLine -- the reader is still the fixed 64 KB window that drops a fat last line');
        }
        if (/\$window\s*\*\s*2/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: the tail window grows until a line parses');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: the tail window never grows -- a last line bigger than the window can never be read');
        }
        // The cache must be keyed on the path as well as the mtime: a
        // session switch must never answer with the previous file's message.
        if (/\$script:lastMsgsSnapshot\.path\s*-eq\s*\$file/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: the message cache is keyed on path AND mtime');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: the message cache is keyed on the mtime alone -- a session switch can return the previous file\'s message');
        }
        // A read failure must answer "no information", never another
        // session's message.
        const readLastBody = (detect.match(/function Read-LastMessage[\s\S]*?\n\}\n/) || [''])[0];
        if (!readLastBody) {
            out('FAIL', 'mcode-status-detect.ps1: Read-LastMessage body not found (fat-line drift lock skipped)');
        } else {
            const catchBlock = (readLastBody.match(/catch\s*\{[\s\S]*?\n\s{2,}\}/) || [''])[0];
            if (/lastInferred/.test(catchBlock)) {
                out('FAIL', 'mcode-status-detect.ps1: a read failure answers with the cached inference -- that inference belongs to an earlier file, so the pill shows the previous conversation');
            } else {
                out('PASS', "mcode-status-detect.ps1: a read failure never answers with another session's message");
            }
        }
    }

    // 5e. Drift lock: the widget must consume `family` and apply it ONLY to
    // active states. Tinting `done`/`error` by family would destroy the
    // green=success / red=failure signal the user relies on.
    const widgetPath = join(PLUGIN_ROOT, 'mcode-island.ps1');
    if (!(await exists(widgetPath))) {
        out('FAIL', 'mcode-island.ps1 missing (family-tint drift lock skipped)');
    } else {
        const widget = await readFile(widgetPath, 'utf8');
        // Hoisted out of the if/else below: the hue-separation check further
        // down needs the same slice, and a block-scoped const would be out of
        // scope by then.
        const famBlock = widget.match(/\$familyMap\s*=\s*@\{([\s\S]*?)\n\}/);
        if (!famBlock) {
            out('FAIL', 'mcode-island.ps1: $familyMap table missing');
        } else {
            for (const fam of ['shell', 'read', 'write', 'search', 'task', 'web', 'plan']) {
                if (new RegExp(`^\\s*${fam}\\s*=`, 'm').test(famBlock[1])) {
                    out('PASS', `$familyMap covers "${fam}"`);
                } else {
                    out('FAIL', `$familyMap does not cover "${fam}"`);
                }
            }
        }
        if (/\[string\]\$Family\s*=\s*''/.test(widget)) {
            out('PASS', 'mcode-island.ps1: Update-State takes a $Family parameter');
        } else {
            out('FAIL', 'mcode-island.ps1: Update-State has no $Family parameter');
        }
        // The gate must be checked on the *family tint* line specifically.
        // `$State -in @('thinking','working','waiting')` also appears on the
        // pulse / elapsed / progress branches, so a bare substring test stays
        // green after the tint is ungated -- a false green this section exists
        // to prevent. Anchor on the `$Family -and $State` conjunction instead.
        if (/\$Family\s+-and\s+\$State\s+-in\s+@\('thinking','working','waiting'\)/.test(widget)) {
            out('PASS', 'mcode-island.ps1: family tint is gated to active states (done/error keep their result color)');
        } else {
            out('FAIL', 'mcode-island.ps1: family tint is not gated to active states (done/error would lose their green/red result signal)');
        }
        if (/\$script:statusDot\.Fill\s*=\s*C\s+\$dotHex/.test(widget)
            && /\$script:pulseRing\.Fill\s*=\s*C\s+\$ringHex/.test(widget)) {
            out('PASS', 'mcode-island.ps1: dot/ring are painted from the resolved color (family-aware)');
        } else {
            out('FAIL', 'mcode-island.ps1: dot/ring still read $s.dot directly, bypassing family tinting');
        }

        // Perceptual separation. Two families landing on near-identical colors
        // are indistinguishable on the pill, which defeats the point of
        // tinting. Measured with CIE76 dE in CIELAB, NOT raw luminance:
        // luminance alone calls blue and purple "identical" (0.02 apart) even
        // though they are plainly different hues, so a luminance threshold
        // just produces false alarms. dE < 20 is the usual "not the same color
        // to a human eye" cutoff for flat UI fills.
        const famColors = new Map();
        // No `^` anchor: with the `m` flag a leading `\s*` is free to swallow
        // the preceding newline and match mid-line, and with a greedy
        // [\s\S]* body it can also skip the first entry. A `g`-only scan with
        // a `[ \t]*` (not `\s*`) indent keeps one match per table row.
        // Colors in the table are 8-digit #AARRGGBB (the alpha byte is FF),
        // so the pattern has to be {8} or the closing quote never lines up.
        const colorRe = /[ \t]*([a-z]+)[ \t]*=[ \t]*'(#[0-9A-Fa-f]{8})'/g;
        let cm;
        while ((cm = colorRe.exec(famBlock[1])) !== null) {
            famColors.set(cm[1], cm[2].slice(3).toUpperCase()); // drop #FF alpha
        }
        if (famColors.size < 7) {
            out('FAIL', `$familyMap: parsed only ${famColors.size}/7 family colors; the separation check below would be vacuous`);
        } else {
            out('PASS', `$familyMap: parsed all ${famColors.size} family colors`);
        }
        // sRGB -> XYZ (D65) -> CIELAB
        const toLab = (hex) => {
            const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
            const lin = ch.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
            const [r, g, b] = lin;
            const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
            const Y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
            const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
            const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
            const [fx, fy, fz] = [f(X), f(Y), f(Z)];
            return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
        };
        const deltaE = (a, b) => {
            const [la, aa, ba] = toLab(a);
            const [lb, ab, bb] = toLab(b);
            return Math.hypot(la - lb, aa - ab, ba - bb);
        };
        const MIN_DE = 20;
        const keys = [...famColors.keys()];
        let tooClose = 0;
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                const d = deltaE(famColors.get(keys[i]), famColors.get(keys[j]));
                if (d < MIN_DE) {
                    out('FAIL', `$familyMap colors "${keys[i]}" (#${famColors.get(keys[i])}) and "${keys[j]}" (#${famColors.get(keys[j])}) are only dE ${d.toFixed(1)} apart (< ${MIN_DE}); they read as the same color on the pill`);
                    tooClose++;
                }
            }
        }
        if (tooClose === 0) {
            out('PASS', `$familyMap: all ${keys.length} family colors are perceptually distinct (min pairwise CIELAB dE >= ${MIN_DE})`);
        }
    }

    // 5b. Drift lock: permission-request.ps1 must emit `{"decision":"ask"}`,
    // not `allow` or `deny`. The 0.2.4 Runtime default for PermissionRequest
    // is fail-closed; an observer Hook that returns `allow` or `deny`
    // would silently change the user-facing permission flow. The portable
    // spec (PR #20) added `ask` exactly so observers can opt into
    // "ask the user" without becoming the permission owner. This lock
    // prevents a future change from regressing that invariant.
    const permReqPath = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts', 'permission-request.ps1');
    if (!(await exists(permReqPath))) {
        out('FAIL', 'permission-request.ps1 missing (drift lock skipped)');
    } else {
        const permReq = await readFile(permReqPath, 'utf8');
        const decisionMatch = permReq.match(/WriteLine\(\s*'([^']*\{[^']*\})'\s*\)/);
        if (!decisionMatch) {
            out('FAIL', 'permission-request.ps1: cannot locate WriteLine decision JSON');
        } else {
            const decisionJson = decisionMatch[1];
            let parsed;
            try { parsed = JSON.parse(decisionJson); }
            catch (e) {
                out('FAIL', `permission-request.ps1: decision JSON is not valid JSON: ${e.message}`);
            }
            if (parsed) {
                if (parsed.decision !== 'ask') {
                    out('FAIL', `permission-request.ps1: decision is "${parsed.decision}", expected "ask" (observer opt-in, per PR #20). Returning "allow" or "deny" from an observer Hook silently changes the user-facing permission flow.`);
                } else {
                    out('PASS', `permission-request.ps1: decision is locked to "ask" (observer opt-in)`);
                }
                if (!parsed.reason || typeof parsed.reason !== 'string') {
                    out('FAIL', 'permission-request.ps1: missing or non-string `reason` field');
                } else {
                    out('PASS', 'permission-request.ps1: reason field present');
                }
            }
        }
    }

    // 5c. Drift lock: README must not say `{"decision":"allow"}` for
    // PermissionRequest. The v0.2.1 baseline docstring is the most
    // common place this regresses, since the script changed from
    // `allow` to `ask` between v0.2.1 and v0.3.0.
    const readmePath = join(PLUGIN_ROOT, 'README.md');
    if (await exists(readmePath)) {
        const readme = await readFile(readmePath, 'utf8');
        if (/PermissionRequest[\s\S]{0,400}decision[\s\S]{0,40}"allow"/i.test(readme)) {
            out('FAIL', 'README.md: contains "decision":"allow" near PermissionRequest (the v0.3.0 spec uses "ask")');
        } else {
            out('PASS', 'README.md: no stale "decision":"allow" near PermissionRequest');
        }
    }

    // 6. cross-platform: scan all .ps1 files for hardcoded paths
    console.log('-'.repeat(60));
    console.log('cross-platform scan:');
    const scriptsDir = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'scripts');
    for (const fname of [
        '_lib.ps1', 'session-start.ps1', 'session-end.ps1', 'user-prompt-submit.ps1',
        'pre-tool-use.ps1', 'post-tool-use.ps1', 'stop.ps1', 'pre-compact.ps1',
        'notification.ps1', 'subagent-start.ps1', 'subagent-stop.ps1',
        'permission-request.ps1', 'permission-denied.ps1',
    ]) {
        const p = join(scriptsDir, fname);
        if (!(await exists(p))) continue;
        const text = await readFile(p, 'utf8');
        // Look for hardcoded host paths inside string literals.
        // ${PLUGIN_ROOT} is fine; ${env:...} is fine; $PSScriptRoot is fine.
        // We only flag literal C:\, /Users/, /home/, /mnt/ outside of comments.
        const lines = text.split(/\r?\n/);
        let bad = 0;
        for (const [i, line] of lines.entries()) {
            // Skip pure comment lines.
            if (/^\s*#/.test(line)) continue;
            // Match a literal path-looking token (not preceded by $).
            const m = line.match(/(^|[^$])(\/Users\/|\/home\/|[A-Za-z]:\\[^$]*|\/mnt\/[^$\s]*)/);
            if (m) {
                out('FAIL', `${fname}:${i+1}: hardcoded host path "${m[2].trim()}"`);
                bad++;
            }
        }
        if (bad === 0) out('PASS', `${fname}: no hardcoded host paths`);
    }

    // 6b. Same scan for the round-11 5h-usage lib. The byte-array
    //     obfuscation in the lib (PS 5.1 parser-quirk defense) does
    //     NOT contain any host paths, but a future refactor that
    //     "tidies" the lib into a literal `'https://api.minimax.com'`
    //     string would still need to pass this scan, since the URL
    //     is the production endpoint and is intentionally obfuscated.
    const usageLibAbs = join(PLUGIN_ROOT, 'scripts', 'lib', 'Get-5hUsage.ps1');
    if (await exists(usageLibAbs)) {
        const text = await readFile(usageLibAbs, 'utf8');
        const lines = text.split(/\r?\n/);
        let bad = 0;
        for (const [i, line] of lines.entries()) {
            if (/^\s*#/.test(line)) continue;
            const m = line.match(/(^|[^$])(\/Users\/|\/home\/|[A-Za-z]:\\[^$]*|\/mnt\/[^$\s]*)/);
            if (m) {
                out('FAIL', `Get-5hUsage.ps1:${i+1}: hardcoded host path "${m[2].trim()}"`);
                bad++;
            }
        }
        if (bad === 0) out('PASS', 'Get-5hUsage.ps1: no hardcoded host paths');
    }

    // 7. 5h endpoint disclosure consistency (round-20).
    //
    // Contract: every MiniMax API host the plugin NAMES in user-facing
    // docs (and in the lib's own trailing comment) must be the SAME host
    // the code actually calls. The endpoint used to be obfuscated into a
    // byte array, so this check DECODED that array and compared the docs
    // against the decoded truth. The endpoint is plain text now -- the
    // byte array only hid it from a grep, which is indistinguishable from
    // hiding it from review -- so the check reads the literal. It still
    // never hard-codes the endpoint itself, which matters twice over: the
    // check cannot drift into becoming a second copy of the disclosure it
    // is meant to police, and it cannot be satisfied by "fixing" the docs
    // to match whatever the code happens to be tomorrow.
    //
    // This exists because the two drifted. The README carried an absolute
    // security claim ("no request is ever sent to a host other than
    // api.minimax.io") that was simply false -- the code never called
    // that host. A disclosure that overstates isolation is worse than no
    // disclosure at all.
    const planLibAbs = join(PLUGIN_ROOT, 'scripts', 'lib', 'Get-5hUsage.ps1');
    if (await exists(planLibAbs)) {
        const libText = await readFile(planLibAbs, 'utf8');
        const hostArr = libText.match(/\$PLAN_API_HOST\s*=\s*(?:_s\s*\(([^)]*)\)|'([^']*)')/);
        if (!hostArr) {
            out('FAIL', 'Get-5hUsage.ps1: cannot locate the $PLAN_API_HOST constant (disclosure check has no truth to compare against)');
        } else {
            const realUrl = hostArr[2] !== undefined
                ? hostArr[2]
                : Buffer.from(
                    hostArr[1].split(',')
                        .map(s => parseInt(s.trim().replace(/^0x/i, ''), 16))
                        .filter(n => Number.isFinite(n))
                  ).toString('utf8');
            let realHost = null;
            try { realHost = new URL(realUrl).hostname; } catch { realHost = null; }
            if (!realHost) {
                out('FAIL', `Get-5hUsage.ps1: $PLAN_API_HOST is not a parseable URL ("${realUrl}")`);
            } else {
                out('PASS', `Get-5hUsage.ps1: $PLAN_API_HOST names a valid host (${realHost})`);

                const namedHosts = [
                    'README.md',
                    join('skills', 'SKILL.md'),
                    join('skills', 'mcode-island', 'SKILL.md'),
                    join('scripts', 'lib', 'Get-5hUsage.ps1'),
                ];
                let drift = 0, named = 0;
                for (const rel of namedHosts) {
                    const abs = join(PLUGIN_ROOT, rel);
                    if (!(await exists(abs))) continue;
                    const text = await readFile(abs, 'utf8');
                    // Fresh regex per line: no shared lastIndex state.
                    for (const [i, line] of text.split(/\r?\n/).entries()) {
                        for (const hit of line.match(/api\.minimax[a-z]*\.(?:com|io|ai|cn)/gi) || []) {
                            named++;
                            if (hit.toLowerCase() !== realHost.toLowerCase()) {
                                out('FAIL', `${rel}:${i + 1}: names "${hit}" but the code calls "${realHost}"`);
                                drift++;
                            }
                        }
                    }
                }
                if (drift === 0) {
                    out('PASS', `5h disclosure: all ${named} host mention(s) match the real endpoint (${realHost})`);
                }
            }
        }
    } else {
        out('FAIL', 'scripts/lib/Get-5hUsage.ps1 missing (disclosure check skipped)');
    }

    // 7b. Credential handling (round-21).
    //
    // The Marketplace review rejected an earlier submission for three
    // credential problems in the 5h usage path, and none of them is
    // visible in a file listing:
    //
    //   * the request carried "MM-API-Source: Minimax-MCP", i.e. it
    //     claimed to be a MiniMax-owned surface;
    //   * the endpoint and several strings were assembled from byte
    //     arrays, which reads as hiding them from review;
    //   * the token was stored in the clear in config.json, and an
    //     ambient environment token was picked up and sent without the
    //     user ever opting in.
    //
    // These checks make the contract explicit, so a later edit cannot
    // quietly reintroduce any of them.
    {
        const ps1Files = [];
        const walkPs1 = async (dir) => {
            let entries = [];
            try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const abs = join(dir, e.name);
                if (e.isDirectory()) await walkPs1(abs);
                else if (e.name.endsWith('.ps1')) ps1Files.push(abs);
            }
        };
        await walkPs1(PLUGIN_ROOT);

        let sourceHeader = 0, byteArray = 0;
        for (const abs of ps1Files) {
            const rel = abs.slice(PLUGIN_ROOT.length + 1).replace(/\\/g, '/');
            const text = await readFile(abs, 'utf8');
            // A header assignment, not a mention in a comment: the
            // comment that explains why the header was removed is
            // allowed to name it.
            if (/['"]MM-API-Source['"]\s*=/.test(text)) {
                out('FAIL', `${rel}: sends an MM-API-Source header (it claims to be a MiniMax-owned surface)`);
                sourceHeader++;
            }
            if (/_s\s*\(\s*0x/i.test(text)) {
                out('FAIL', `${rel}: builds a string from a byte array (hides it from review)`);
                byteArray++;
            }
        }
        if (sourceHeader === 0) out('PASS', 'no .ps1 sends an MM-API-Source header');
        if (byteArray === 0) out('PASS', 'no .ps1 builds a string from a byte array');

        const setTokenAbs = join(PLUGIN_ROOT, 'set-token.ps1');
        if (await exists(setTokenAbs)) {
            const st = await readFile(setTokenAbs, 'utf8');
            if (st.includes('planApiTokenEnc')) {
                out('PASS', 'set-token.ps1 stores the token as planApiTokenEnc (encrypted)');
            } else {
                out('FAIL', 'set-token.ps1 does not store the token as planApiTokenEnc');
            }
            // A plaintext write is the thing the review rejected. The
            // legacy field may still be READ (to migrate it), but it must
            // never be written back.
            const writesPlain = /NotePropertyValue\s+'?\$?Token'|planApiToken'\s*\]\s*=\s*\$Token/.test(st);
            const addsPlain = /Add-Member[^\n]*NotePropertyName\s+'planApiToken'/.test(st);
            if (writesPlain || addsPlain) {
                out('FAIL', 'set-token.ps1 writes a plaintext planApiToken');
            } else {
                out('PASS', 'set-token.ps1 never writes a plaintext planApiToken');
            }
        }

        if (await exists(planLibAbs)) {
            const lib = await readFile(planLibAbs, 'utf8');
            if (lib.includes('allowEnvToken')) {
                out('PASS', 'Get-5hUsage.ps1 gates the environment token behind allowEnvToken');
            } else {
                out('FAIL', 'Get-5hUsage.ps1 reads the environment token without an allowEnvToken gate');
            }
            if (lib.includes('planApiTokenEnc')) {
                out('PASS', 'Get-5hUsage.ps1 reads the token from planApiTokenEnc');
            } else {
                out('FAIL', 'Get-5hUsage.ps1 does not read the encrypted planApiTokenEnc');
            }
        }
    }

    // 8. Log growth is bounded (round-20).
    //
    // Contract: the two append-only logs under %APPDATA%\mcode-island\
    // must cap their own size. mcode-island.ps1 line 7 has documented
    // "keep only the last 1KB" since the widget was written, but Dbg was
    // a bare Add-Content and never implemented it -- widget.log reached
    // 37 MB in 38 days (~3.6 MB/day of POLL lines during active use), and
    // nothing ever trimmed it. A stated cap that no code enforces is a
    // comment, not a guarantee, so this check asserts the enforcement
    // rather than trusting the prose.
    for (const t of [
        { rel: 'mcode-island.ps1',        fn: 'Dbg' },
        { rel: 'mcode-status-detect.ps1', fn: 'Log-Line' },
    ]) {
        const abs = join(PLUGIN_ROOT, t.rel);
        if (!(await exists(abs))) {
            out('FAIL', `${t.rel} missing (log-cap check skipped)`);
            continue;
        }
        const text = await readFile(abs, 'utf8');
        const body = text.match(new RegExp(`function\\s+${t.fn}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`));
        if (!body) {
            out('FAIL', `${t.rel}: function ${t.fn} not found (cannot verify the log cap)`);
            continue;
        }
        const src = body[1];
        const capped = /Length/i.test(src) &&
                       /(gt|ge|gt\s)/i.test(src) &&
                       /(SetLength|WriteAllText|Truncate|Get-Content|Rotate|-Tail)/i.test(src);
        if (!capped) {
            out('FAIL', `${t.rel}: ${t.fn} appends with no size cap (log grows without bound)`);
        } else {
            out('PASS', `${t.rel}: ${t.fn} bounds its own log size`);
        }
    }

    // 9. Secret-shaped command text is redacted before it is persisted
    //    (round-20).
    //
    // Contract: tool-input text (Bash commands, Computer Use keystrokes)
    // is written to status.json, to the append-only logs, and rendered on
    // an always-on-top pill. The Computer Use branch of Format-ToolSummary
    // was redacted in round-19 #1; the Bash branch was not, so a command
    // carrying a bearer token or an API key landed on disk verbatim.
    //
    // There are two independent producers of that text -- the hook path
    // (_lib.ps1) and the detector, which re-derives messages from mcode's
    // own session log -- so a helper wired into only one of them is a
    // silent half-fix. The helper therefore lives in a shared lib, and
    // this check asserts BOTH consumers route through it. Asserting the
    // helper merely *exists* is the false-green shape: dead code passes it.
    const protectLibAbs = join(PLUGIN_ROOT, 'scripts', 'lib', 'Protect-Text.ps1');
    if (!(await exists(protectLibAbs))) {
        out('FAIL', 'scripts/lib/Protect-Text.ps1 missing (command secrets are persisted verbatim)');
    } else {
        const protectLib = await readFile(protectLibAbs, 'utf8');
        const helper = protectLib.match(/function\s+(Protect-SecretText|Redact-SecretText)/);
        if (!helper) {
            out('FAIL', 'scripts/lib/Protect-Text.ps1: Protect-SecretText not defined');
        } else {
            out('PASS', `scripts/lib/Protect-Text.ps1: ${helper[1]} defined`);

            for (const consumer of [
                { rel: join('io.minimax.mcode', 'hooks', 'scripts', '_lib.ps1'),  label: 'hook path' },
                { rel: 'mcode-status-detect.ps1',                                  label: 'detector' },
            ]) {
                const abs = join(PLUGIN_ROOT, consumer.rel);
                if (!(await exists(abs))) {
                    out('FAIL', `${consumer.rel} missing (${consumer.label} redaction not verified)`);
                    continue;
                }
                const text = await readFile(abs, 'utf8');
                if (!/Protect-Text\.ps1/.test(text)) {
                    out('FAIL', `${consumer.rel}: does not dot-source scripts/lib/Protect-Text.ps1`);
                    continue;
                }
                // The helper is DEFINED in the other file, so every
                // occurrence of its name in this consumer is an actual
                // invocation -- the dot-source line names the .ps1 file,
                // not the function. A consumer that dot-sources but never
                // calls therefore scores 0 and fails here, which is the
                // whole point of the check.
                const uses = (text.match(new RegExp(helper[1], 'g')) || []).length;
                if (uses < 1) {
                    out('FAIL', `${consumer.rel}: dot-sources Protect-Text.ps1 but never calls ${helper[1]} (${consumer.label} is unredacted)`);
                } else {
                    out('PASS', `${consumer.rel}: ${consumer.label} calls ${helper[1]} (${uses} site(s))`);
                }
            }
        }
    }

    // 10. Hook invocations survive an install path containing spaces
    //     (round-20).
    //
    // Contract: a plugin can legitimately be installed under a path with
    // spaces or shell metacharacters, and mcode 0.5.4 explicitly fixed
    // its own managed updater for exactly that case. ${PLUGIN_ROOT} is
    // substituted at runtime, so the only way to break a spaced path is
    // to hand the shell a pre-joined string instead of an argv array.
    // This asserts the array form survives -- a "command" that embeds the
    // path in a quoted shell string, or an args entry that is itself a
    // joined string with embedded quotes, is exactly the regression.
    const hooksJsonAbs = join(PLUGIN_ROOT, 'io.minimax.mcode', 'hooks', 'hooks.json');
    if (!(await exists(hooksJsonAbs))) {
        out('FAIL', 'io.minimax.mcode/hooks/hooks.json missing (space-path check skipped)');
    } else {
        let parsed = null;
        try {
            parsed = JSON.parse(await readFile(hooksJsonAbs, 'utf8'));
        } catch (e) {
            out('FAIL', `io.minimax.mcode/hooks/hooks.json: not parseable as JSON (${e.message})`);
        }
        if (parsed) {
            let entries = 0, bad = 0;
            for (const [event, list] of Object.entries(parsed.hooks || {})) {
                for (const h of (Array.isArray(list) ? list : [list])) {
                    if (!h || typeof h !== 'object') continue;
                    entries++;
                    const cmd = typeof h.command === 'string' ? h.command : '';
                    // A command that inlines the plugin root has been
                    // flattened into a shell string; ${PLUGIN_ROOT} must
                    // arrive as its own argv element.
                    if (cmd.includes('${PLUGIN_ROOT}')) {
                        out('FAIL', `${event}: command embeds ${PLUGIN_ROOT} ("${cmd}") - breaks on install paths with spaces`);
                        bad++;
                    }
                    if (!Array.isArray(h.args)) {
                        out('FAIL', `${event}: args is not an array (${JSON.stringify(h.args)}) - a joined string is not space-safe`);
                        bad++;
                    } else {
                        for (const a of h.args) {
                            if (typeof a === 'string' && /["']\s*\S+\s+.*\s*["']/.test(a)) {
                                out('FAIL', `${event}: args entry looks pre-quoted/joined ("${a}") - breaks on spaced paths`);
                                bad++;
                            }
                        }
                    }
                }
            }
            if (bad === 0 && entries > 0) {
                out('PASS', `hooks.json: all ${entries} hook entr(ies) use argv arrays (space-safe)`);
            }
        }
    }

    // 11. The status.json write path is atomic across processes
    //     (round-21 review hetaoBackend #1).
    //
    // Contract: the detector and the agent hooks are two independent
    // processes writing the same file. They must share one lock, one
    // snapshot and one staging path, or a write that lands between a
    // reader's read and its write is lost.
    //
    // These are the static drift locks. The behavioral proof -- two real
    // PowerShell processes interleaving -- lives in
    // scripts/test-substep-progress.mjs, section 7, because smoke does
    // not execute PowerShell.
    {
        const storePath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Status-Store.ps1');
        const detectPath = join(PLUGIN_ROOT, 'mcode-status-detect.ps1');
        const notifyPath = join(PLUGIN_ROOT, 'notify-island.ps1');

        const storeExists = await exists(storePath);
        const store = storeExists ? await readFile(storePath, 'utf8') : '';
        const detect = await readFile(detectPath, 'utf8');
        const notify = await readFile(notifyPath, 'utf8');

        if (!storeExists) {
            out('FAIL', 'Status-Store.ps1: the shared status.json protocol lib is missing');
        } else {
            // The lock must be a real OS file lock, not a flag file whose
            // presence we poll: a flag file has the same check-then-act
            // hole the payload has.
            if (/FileShare\]::None/.test(store) || /FileShare::None/.test(store)) {
                out('PASS', 'Status-Store.ps1: the cross-process lock uses an exclusive OS file lock');
            } else {
                out('FAIL', 'Status-Store.ps1: the lock does not use FileShare.None, so it is advisory and does not exclude another writer');
            }

            if (/function\s+Read-StatusSnapshot/.test(store) && /function\s+Write-StatusSnapshot/.test(store)) {
                out('PASS', 'Status-Store.ps1: exposes the shared read and write primitives');
            } else {
                out('FAIL', 'Status-Store.ps1: the shared read/write primitives are missing');
            }

            // The version counter is what lets a reader tell generations
            // apart. It has to be stamped on every write.
            if (/\[ordered\]@\{\}/.test(store) && /\$ordered\['version'\]/.test(store)) {
                out('PASS', 'Status-Store.ps1: every write stamps the monotonic version');
            } else {
                out('FAIL', 'Status-Store.ps1: writes do not stamp a version, so a reader cannot tell generations apart');
            }

            // The staging path must be shared-but-locked, not per-writer:
            // two writers staging through the same path is what let one
            // rename the other's half-written file into place.
            if (/Move-Item -Path \$tmp -Destination \$file -Force/.test(store)) {
                out('PASS', 'Status-Store.ps1: the status file is replaced through a staging file');
            } else {
                out('FAIL', 'Status-Store.ps1: the status file is not replaced through a staging file');
            }
        }

        // The detector must route every write through the shared lib.
        if (/Status-Store\.ps1/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: dot-sources the shared status store lib');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: does not dot-source the shared status store lib');
        }

        // The whole point: ONE read per write. A second read inside the
        // locked region can still observe a generation the payload was
        // not built from.
        const writeStatusBody = detect.match(/function Write-StatusUnderLock[\s\S]*?\n}\n/);
        if (!writeStatusBody) {
            out('FAIL', 'mcode-status-detect.ps1: Write-StatusUnderLock not found');
        } else {
            const reads = (writeStatusBody[0].match(/Read-StatusSnapshot/g) || []).length;
            if (reads === 1) {
                out('PASS', 'mcode-status-detect.ps1: the write path reads status.json exactly once');
            } else {
                out('FAIL', `mcode-status-detect.ps1: the write path reads status.json ${reads} times; a second read can observe a different generation than the payload was built from`);
            }
        }

        if (/Enter-StatusLock/.test(detect) && /Exit-StatusLock/.test(detect)) {
            out('PASS', 'mcode-status-detect.ps1: takes and releases the cross-process lock');
        } else {
            out('FAIL', 'mcode-status-detect.ps1: does not take/release the cross-process lock around the write');
        }

        // Both writers must use the same protocol, or the lock excludes
        // nobody.
        if (/Status-Store\.ps1/.test(notify) && /Enter-StatusLock/.test(notify) && /Exit-StatusLock/.test(notify)) {
            out('PASS', 'notify-island.ps1: the agent-side writer uses the same locked protocol');
        } else {
            out('FAIL', 'notify-island.ps1: the agent-side writer does not use the shared locked protocol, so the lock excludes nobody');
        }

        // A per-writer staging path for the agent side would be a second
        // protocol; a SHARED one is the bug.
        if (!/"\$statusFile\.tmp"/.test(notify)) {
            out('PASS', 'notify-island.ps1: does not stage status.json through a shared path');
        } else {
            out('FAIL', 'notify-island.ps1: stages status.json through $statusFile.tmp, the same path the detector used');
        }
    }

    // 12. Non-ASCII .ps1 files carry a UTF-8 BOM (round-20 #4).
    //
    // Contract: every hook and every script the plugin spawns with
    // `powershell` (Windows PowerShell 5.1) must survive 5.1's parser.
    // 5.1 decodes a BOM-less script using the system ANSI codepage, so a
    // file containing non-ASCII comments is mis-decoded and the C#
    // here-string in the detector stops being a here-string -- `using
    // System;` is then parsed as PowerShell and the script dies before
    // its first statement.
    //
    // .gitattributes pins `*.ps1 text eol=lf`, and its comment claims
    // "LF avoids both failure modes". That is backwards: bare LF is part
    // of the problem, and the guarantee is what propagates it. Either CRLF
    // or a UTF-8 BOM fixes the parse (both verified against 5.1), but
    // flipping .gitattributes to CRLF would re-break the Linux-side
    // validator the same comment is trying to protect. The BOM is the
    // narrower fix: it leaves the line-ending policy alone and is just
    // three bytes at the head of the file.
    //
    // This was not hypothetical. Syncing the committed tree into the
    // install directory via the documented `Copy-Item -Recurse -Force`
    // flow installed a detector that could not start under 5.1 -- the
    // only reason the running copy worked is that it had a BOM that the
    // repository does not carry.
    const ps1Files = [];
    const walk = async (dir) => {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
            const abs = join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'node_modules' || ent.name === '.git') continue;
                await walk(abs);
            } else if (ent.name.endsWith('.ps1')) {
                ps1Files.push(abs);
            }
        }
    };
    await walk(PLUGIN_ROOT);

    let missingBom = 0, nonAsciiCount = 0;
    for (const abs of ps1Files) {
        const buf = await readFile(abs);
        const rel = abs.slice(PLUGIN_ROOT.length + 1);
        const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        let nonAscii = false;
        for (let i = 0; i < buf.length; i++) {
            if (buf[i] > 0x7f) { nonAscii = true; break; }
        }
        if (!nonAscii) continue;      // ASCII-only is safe without a BOM
        nonAsciiCount++;
        if (!hasBom) {
            out('FAIL', `${rel}: contains non-ASCII but has no UTF-8 BOM (Windows PowerShell 5.1 cannot parse it)`);
            missingBom++;
        }
    }
    if (missingBom === 0) {
        out('PASS', `ps1 encoding: all ${nonAsciiCount} non-ASCII .ps1 file(s) carry a UTF-8 BOM (${ps1Files.length} scanned)`);
    }

    // --- PowerShell read-only automatic variables ------------------------
    //
    // Assigning to one of these throws "Cannot overwrite variable PID
    // because it is read-only or constant". PowerShell variable names are
    // case-insensitive, so `$pid` IS the automatic `$PID` -- and a `catch`
    // wrapped around the assignment swallows the error, which makes the
    // function look like it ran while it never did.
    //
    // This is not hypothetical. Focus-TerminalWindow assigned to `$pid`, so
    // every click on a session row threw, the catch ate it, and the log
    // said "session terminal switched" while the terminal never came
    // forward. The same class of bug already bit `$home` in Runtime-Titles
    // and `$args` in the detector.
    //
    // The scanner strips comments and string literals first, so a `$pid`
    // mentioned in prose, in a here-string, or in a log message is not a
    // hit. `$null = <expr>` is a legal discard and `$Error` / `$args` /
    // `$OutputEncoding` are writable, so none of them are in the set.
    const RESERVED_PS_VARS = new Set([
        'pid', 'home', 'pshome', 'psversiontable', 'host', 'iswindows',
        'islinux', 'ismacos', 'psculture', 'psuiculture', 'shellid',
        'myinvocation', 'enabledexperimentalfeatures', 'true', 'false',
    ]);

    // Remove comments and string literals, keeping the line structure so
    // hits can still be reported with a line number. PowerShell strings
    // are single- or double-quoted and escape the quote by doubling it;
    // here-strings (@'...'@ / @"..."@) span lines.
    const stripLiterals = (src) => {
        const outLines = [];
        let inHere = null;
        for (const line of src.split(/\r?\n/)) {
            if (inHere) {
                const trimmed = line.trim();
                if (trimmed.startsWith(inHere + '@')) inHere = null;
                outLines.push('');
                continue;
            }
            let res = '';
            let i = 0;
            while (i < line.length) {
                const ch = line[i];
                if (ch === '#') break;                    // comment to EOL
                if (ch === '@' && (line[i + 1] === "'" || line[i + 1] === '"')) {
                    const q = line[i + 1];
                    if (line.slice(i + 2).trim() === '') {
                        // multi-line here-string opener
                        inHere = q;
                        i = line.length;
                        continue;
                    }
                    i++;                                  // single-line form
                    continue;
                }
                if (ch === "'" || ch === '"') {
                    const q = ch;
                    i++;
                    while (i < line.length) {
                        if (line[i] === q) {
                            if (line[i + 1] === q) { i += 2; continue; }
                            i++;
                            break;
                        }
                        if (q === '"' && line[i] === '`') { i += 2; continue; }
                        i++;
                    }
                    res += '""';
                    continue;
                }
                res += ch;
                i++;
            }
            outLines.push(res);
        }
        return outLines;
    };

    // Parameters that shadow a read-only automatic variable. `param($pid)`
    // does not throw at definition time but throws the moment the
    // parameter is bound, so it has to be caught statically too.
    const findReservedParams = (code) => {
        const hits = [];
        const re = /\bparam\s*\(/gi;
        let m;
        while ((m = re.exec(code)) !== null) {
            let depth = 1;
            let i = m.index + m[0].length;
            while (i < code.length && depth > 0) {
                if (code[i] === '(') depth++;
                else if (code[i] === ')') depth--;
                i++;
            }
            const body = code.slice(m.index + m[0].length, i - 1);
            const nm = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
            let p;
            while ((p = nm.exec(body)) !== null) {
                const name = p[1];
                if (!RESERVED_PS_VARS.has(name.toLowerCase())) continue;
                let k = p.index - 1;
                while (k >= 0 && /\s/.test(body[k])) k--;
                if (k >= 0 && body[k] === '=') continue;  // default value, not a name
                const line = code.slice(0, m.index + p.index).split(/\r?\n/).length;
                hits.push({ line, name });
            }
        }
        return hits;
    };

    const ASSIGN_RE = /(?<![-!<>=\w$:])\$(?:(?:script|global|local|private|using):)*([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
    const BRACED_ASSIGN_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}\s*=(?!=)/g;

    let reservedHits = 0;
    for (const abs of ps1Files) {
        const rel = abs.slice(PLUGIN_ROOT.length + 1);
        const code = stripLiterals(await readFile(abs, 'utf8')).join('\n');
        const lines = code.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (const re of [ASSIGN_RE, BRACED_ASSIGN_RE]) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(lines[i])) !== null) {
                    const name = m[1];
                    if (!RESERVED_PS_VARS.has(name.toLowerCase())) continue;
                    out('FAIL', `${rel}:${i + 1}: assigns to $${name}, a read-only PowerShell automatic variable -- the assignment throws and a surrounding catch swallows it`);
                    reservedHits++;
                }
            }
        }
        for (const hit of findReservedParams(code)) {
            out('FAIL', `${rel}:${hit.line}: parameter $${hit.name} shadows the read-only PowerShell automatic variable`);
            reservedHits++;
        }
    }
    if (reservedHits === 0) {
        out('PASS', `ps1 reserved-variable guard: no assignment to a read-only PowerShell automatic variable (${ps1Files.length} scanned)`);
    }

    // --- SetWindowPos must not resize or move the target -----------------
    //
    // SetWindowPos(hwnd, after, X, Y, cx, cy, flags): cx=0/cy=0 and
    // X=0/Y=0 only mean "keep the current size / position" when the
    // matching flag is present.
    //
    //   missing SWP_NOSIZE -> the window is resized to 0x0. Windows
    //     Terminal has a min-size fallback, so the window collapses into a
    //     480x84 strip instead of disappearing.
    //   missing SWP_NOMOVE -> the window is really moved to (0,0).
    //
    // That is not a hypothetical: Focus-Window did exactly this, so every
    // "raise the terminal" collapsed it into a strip in the top-left
    // corner of the screen. The flags were also written through a local
    // variable, so the check has to resolve the variable instead of
    // looking at the call site only.
    const splitCallArgs = (body) => {
        const args = [];
        let cur = '';
        let d = 0;
        for (const ch of body) {
            if (ch === '(') { d++; cur += ch; continue; }
            if (ch === ')') { d--; cur += ch; continue; }
            if (ch === ',' && d === 0) { args.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        args.push(cur.trim());
        return args;
    };

    const findSetWindowPosCalls = (code) => {
        const calls = [];
        const re = /\bSetWindowPos\s*\(/g;
        let m;
        while ((m = re.exec(code)) !== null) {
            let depth = 1;
            let i = m.index + m[0].length;
            while (i < code.length && depth > 0) {
                if (code[i] === '(') depth++;
                else if (code[i] === ')') depth--;
                i++;
            }
            const body = code.slice(m.index + m[0].length, i - 1);
            calls.push({
                line: code.slice(0, m.index).split('\n').length,
                args: splitCallArgs(body),
            });
        }
        return calls;
    };

    // The flags argument is often a local variable ($nofollow / $flags);
    // resolve it so the guard sees the flags that are actually passed.
    const resolveFlags = (code, flagsArg) => {
        if (!flagsArg) return '';
        if (!flagsArg.startsWith('$')) return flagsArg;
        const name = flagsArg.slice(1).split(/[^\w]/)[0];
        const m = code.match(new RegExp('\\$' + name + '\\s*=\\s*([^\\r\\n]+)', 'i'));
        return m ? m[1] : '';
    };

    let swpHits = 0;
    for (const abs of ps1Files) {
        const rel = abs.slice(PLUGIN_ROOT.length + 1);
        const code = stripLiterals(await readFile(abs, 'utf8')).join('\n');
        for (const call of findSetWindowPosCalls(code)) {
            const a = call.args;
            if (a.length < 7) continue;              // not a real call site
            const flags = resolveFlags(code, a[6]);
            const x = a[2].trim();
            const y = a[3].trim();
            const cx = a[4].trim();
            const cy = a[5].trim();
            if (!/\bSWP_NOSIZE\b/.test(flags) && cx === '0' && cy === '0') {
                out('FAIL', `${rel}:${call.line}: SetWindowPos passes cx=0/cy=0 without SWP_NOSIZE -- that resizes the window to 0x0 (Windows Terminal clamps it to a ~480x84 strip)`);
                swpHits++;
            }
            if (!/\bSWP_NOMOVE\b/.test(flags) && x === '0' && y === '0') {
                out('FAIL', `${rel}:${call.line}: SetWindowPos passes X=0/Y=0 without SWP_NOMOVE -- that moves the window to the top-left corner`);
                swpHits++;
            }
        }
    }
    if (swpHits === 0) {
        out('PASS', `ps1 SetWindowPos guard: no call resizes or moves its target without SWP_NOSIZE / SWP_NOMOVE (${ps1Files.length} scanned)`);
    }

    finish();
};

const finish = () => {
    console.log('-'.repeat(60));
    console.log(`summary: ${pass} pass, ${warn} warn, ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
};

main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(2);
});
