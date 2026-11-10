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

// Strip XML comments out of an XAML block.
//
// NOT `replace(/<!--[\s\S]*?-->/g, '')`: that regex only removes a
// `<!--` that has a matching `-->`, so an unclosed `<!--` survives the
// "sanitisation" intact -- the sanitisation is incomplete, and a comment in
// the source can still feed the assertions below. CodeQL flags exactly that
// as js/incomplete-sanitization.
//
// This walks the text instead. A paired comment is dropped whole; an
// unpaired `<!--` drops everything after it. Either way the result carries
// no comment marker, which is the property the assertions actually need.
// Where the next HTML comment end tag starts, or -1.
//
// HTML5 accepts "--!>" as a comment end as well as "-->", so a filter that
// only knows "-->" leaves such a comment open (CodeQL:
// js/bad-html-filtering-regexp).
const xmlCommentEndAt = (s, from) => {
    const m = /--!?>/.exec(s.slice(from));
    if (!m) return null;
    return { at: from + m.index, len: m[0].length };
};

const stripXmlComments = (s) => {
    let keep = '';
    let i = 0;
    while (i < s.length) {
        const open = s.indexOf('<!--', i);
        if (open < 0) { keep += s.slice(i); break; }
        keep += s.slice(i, open);
        const close = xmlCommentEndAt(s, open + 4);
        if (!close) break;               // unclosed: drop the rest
        i = close.at + close.len;        // "-->" is 3 chars, "--!>" is 4
    }
    return keep;
};

// True when every `<!--` in the text has a comment end tag after it, in order.
const xmlCommentsArePaired = (s) => {
    let i = 0;
    while (i < s.length) {
        const open = s.indexOf('<!--', i);
        if (open < 0) return true;
        const close = xmlCommentEndAt(s, open + 4);
        if (!close) return false;
        i = close.at + close.len;
    }
    return true;
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
    console.log(`mcode-island v0.5.0 self-check`);
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
    if (plugin.version !== '0.5.0') {
        out('FAIL', `plugin.json: version is "${plugin.version}", expected "0.5.0"`);
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

        // (k) A session row has to reach the conversation it names.
        //
        // On the desktop app the session lives in the app's sidebar, and the
        // sidebar row is a Button whose accessibility name is the conversation
        // title -- so the row can be invoked. Without that, a row click on
        // the desktop could only fall through to "open a new terminal",
        // which is the one thing the session list promised never to do.
        if (/function Switch-ToAppConversation\b/.test(widget)) {
            out('PASS', 'mcode-island.ps1: Switch-ToAppConversation exists (a session row can reach the app conversation)');
        } else {
            out('FAIL', 'mcode-island.ps1: no Switch-ToAppConversation -- a session row cannot reach its conversation in the desktop app');
        }
        const sessionClickBody = (widget.match(/function Invoke-SessionClick[\s\S]*?\n\}\n/) || [''])[0];
        if (!sessionClickBody) {
            out('FAIL', 'mcode-island.ps1: Invoke-SessionClick body not found (session-row drift lock skipped)');
        } else if (!/Switch-ToAppConversation\s+\$names/.test(sessionClickBody)) {
            out('FAIL', 'mcode-island.ps1: Invoke-SessionClick does not try the app conversation');
        } else {
            out('PASS', 'mcode-island.ps1: Invoke-SessionClick tries the app conversation');
            // The "open a new terminal" fallback is gone and must stay gone.
            //
            // It built `powershell -Command "mcode --session <id>"` out of a
            // value that came from a session directory's base64 and from
            // sessions.json -- neither is trusted, so an id shaped like
            // `x; Set-Content ...` was executable PowerShell. It also
            // contradicted the feature: clicking a row means "go back to that
            // session", never "start a second one".
            //
            // Two shapes of lock: the function is gone from the file, and the
            // click handler spawns nothing. The handler's comments describe
            // the old path, so the code check drops comment lines first --
            // otherwise a comment could satisfy or break the lock by itself.
            if (/function\s+Start-SessionTerminal\b/.test(widget)) {
                out('FAIL', 'mcode-island.ps1: Start-SessionTerminal is back -- it turns a session id into PowerShell source');
            } else if (/--session\s+\$/.test(widget)) {
                out('FAIL', 'mcode-island.ps1: something interpolates a session id into a --session command line');
            } else {
                out('PASS', 'mcode-island.ps1: no code path turns a session id into a command line');
            }
            const clickCode = sessionClickBody.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
            if (/Start-Process|Start-SessionTerminal/.test(clickCode)) {
                out('FAIL', 'mcode-island.ps1: Invoke-SessionClick still spawns something -- a row click must fail closed');
            } else if (!/\$id\s+-notmatch\s+'/.test(clickCode)) {
                out('FAIL', 'mcode-island.ps1: Invoke-SessionClick does not validate the session id before using it');
            } else {
                out('PASS', 'mcode-island.ps1: Invoke-SessionClick validates the id and spawns nothing');
            }
        }

        // (k2) The per-row dismiss button.
        //
        // Clicking a row means "go back to that session", and it also drops
        // the row from the list. Those are two different intentions: "I am
        // done with this one" does not mean "take me there" -- switching
        // would yank the user out of whatever they are doing.
        //
        // So each row carries a dismiss mark that only dismisses. Three
        // things have to hold, and each is a separate lock:
        //   1. the mark exists on the row,
        //   2. it calls the dismiss path (not the click path),
        //   3. it cannot reach the click path -- the row's own handler is
        //      on the parent Border, and MouseLeftButtonDown bubbles, so
        //      the mark has to mark the event handled.
        const rowBody = (widget.match(/function Add-SessionRow[\s\S]*?\n\}\n/) || [''])[0];
        // Comments inside the row mention the dismiss function by name, so a
        // text search would be satisfied by the comment alone -- the row would
        // look wired even with the call gone. Strip the comment lines first.
        const rowCode = rowBody.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
        if (!rowBody) {
            out('FAIL', 'mcode-island.ps1: Add-SessionRow body not found (dismiss-button lock skipped)');
        } else if (!/\$xMark\s*=/.test(rowCode) || !/Invoke-SessionDismiss/.test(rowCode)) {
            out('FAIL', 'mcode-island.ps1: the session row has no dismiss mark, or it does not call Invoke-SessionDismiss');
        } else {
            out('PASS', 'mcode-island.ps1: the session row carries a dismiss mark wired to Invoke-SessionDismiss');
            // The mark must not be able to reach the click handler: that
            // handler switches the user to the session.
            const dismissBlock = (rowCode.match(/\$xMark\.Add_MouseLeftButtonDown\(\{[\s\S]*?\}\)/) || [''])[0];
            if (!dismissBlock) {
                out('FAIL', 'mcode-island.ps1: the dismiss mark has no MouseLeftButtonDown handler');
            } else if (!/Handled\s*=\s*\$true/.test(dismissBlock)) {
                out('FAIL', 'mcode-island.ps1: the dismiss mark does not mark the event handled -- the click would bubble to the row and switch the session');
            } else if (/Invoke-SessionClick/.test(dismissBlock)) {
                out('FAIL', 'mcode-island.ps1: the dismiss mark calls the click path -- dismissing would also switch the session');
            } else {
                out('PASS', 'mcode-island.ps1: the dismiss mark stops the event and never calls the click path');
            }
        }

        // The dismiss mark must also be keyboard-operable.
        //
        // A plain TextBlock is not focusable: Tab cannot reach it and
        // Enter/Space do nothing, so the dismiss would be mouse-only. The
        // panel is an overlay the user reaches with the mouse in the first
        // place, but once the mark has the focus the keyboard has to work
        // too.
        // The keyboard handler has to be sliced out on its own: the mouse
        // handler right above it also calls Invoke-SessionDismiss, so a
        // wider window would let the mouse handler feed this assertion.
        const xMarkKey = (rowCode.match(/\$xMark\.Add_KeyDown\(\{[\s\S]*?\}\.GetNewClosure\(\)/) || [''])[0];
        const xMarkSetup = (rowCode.match(/\$xMark\s*=[\s\S]*?\$xMark\.Add_KeyDown\(\{/) || [''])[0];
        if (!xMarkKey) {
            out('FAIL', 'mcode-island.ps1: the dismiss mark has no keyboard handler -- Enter/Space would do nothing');
        } else if (!/Focusable\s*=\s*\$true/.test(xMarkSetup)) {
            out('FAIL', 'mcode-island.ps1: the dismiss mark is not focusable -- Tab cannot reach it');
        } else if (!/Invoke-SessionDismiss/.test(xMarkKey)) {
            out('FAIL', 'mcode-island.ps1: the keyboard handler does not dismiss the row');
        } else if (!/'Return'/.test(xMarkKey) || !/'Enter'/.test(xMarkKey)) {
            out('FAIL', 'mcode-island.ps1: the keyboard handler ignores the Enter key -- WPF calls the main one Return, the keypad one Enter');
        } else if (!/'Space'/.test(xMarkKey)) {
            out('FAIL', 'mcode-island.ps1: the keyboard handler ignores Space');
        } else {
            out('PASS', 'mcode-island.ps1: the dismiss mark is focusable and Enter/Space dismiss the row');
        }

        // The dismiss path itself must not switch sessions: it only writes
        // the ack, records the pending dismissal and redraws.
        const dismissBody = (widget.match(/function Invoke-SessionDismiss[\s\S]*?\n\}\n/) || [''])[0];
        if (!dismissBody) {
            out('FAIL', 'mcode-island.ps1: Invoke-SessionDismiss not found');
        } else {
            const dismissCode = dismissBody.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
            if (/Invoke-SessionClick|Select-SessionTerminal|Switch-ToAppConversation|Activate-/.test(dismissCode)) {                out('FAIL', 'mcode-island.ps1: Invoke-SessionDismiss switches to the session -- dismissing must not move the user');
            } else if (!/Write-AckSignal/.test(dismissCode)) {
                out('FAIL', 'mcode-island.ps1: Invoke-SessionDismiss does not write the ack -- the row would come back');
            } else if (!/\$id\s+-notmatch\s+'/.test(dismissCode)) {
                out('FAIL', 'mcode-island.ps1: Invoke-SessionDismiss does not validate the session id');
            } else {
                out('PASS', 'mcode-island.ps1: Invoke-SessionDismiss only acks the row (no switch, id validated)');
            }
        }

        // The focus has to go back to where it was.
        //
        // Pressing the mouse button hands focus to the pressed window -- the
        // pill. For "jump to that session" that is fine (it jumps anyway).
        // For "just dismiss it" it is the opposite of the intent: the user
        // asked not to be interrupted, and losing the editor's focus means
        // the next keystroke goes somewhere unknown.
        //
        // So the foreground has to be captured before the click (on
        // MouseEnter) and handed back afterwards.
        if (!/function\s+Save-ForegroundBeforeAction\b/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: no Save-ForegroundBeforeAction -- the pill keeps the focus it stole');
        } else if (!/function\s+Restore-ForegroundAfterAction\b/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: no Restore-ForegroundAfterAction -- the pill keeps the focus it stole');
        } else if (!/Restore-ForegroundAfterAction/.test(dismissBody)) {
            out('FAIL', 'mcode-island.ps1: Invoke-SessionDismiss does not give the focus back');
        } else {
            out('PASS', 'mcode-island.ps1: dismissing gives the focus back to where it was');
        }
        // The capture has to happen on MouseEnter: by MouseDown the pill
        // already owns the focus, and there would be nothing to give back.
        const mouseEnterBlock = (widget.match(/\$window\.Add_MouseEnter\(\{[\s\S]*?\}\)/) || [''])[0];
        if (!mouseEnterBlock) {
            out('FAIL', 'mcode-island.ps1: no window MouseEnter handler -- the foreground cannot be captured before the click');
        } else if (!/Save-ForegroundBeforeAction/.test(mouseEnterBlock)) {
            out('FAIL', 'mcode-island.ps1: MouseEnter does not capture the foreground -- by click time the pill already owns it');
        } else {
            out('PASS', 'mcode-island.ps1: the foreground is captured on MouseEnter, before any click');
        }

        // The ack file has to carry more than one id. The dismiss button
        // makes dismissing several rows in a row a normal thing to do, and
        // the detector consumes the file once a second -- a single-id file
        // loses every dismiss but the last one.
        if (!/function\s+Write-AckSignal\b/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: no Write-AckSignal -- the ack path is still the single-id one');
        } else {
            out('PASS', 'mcode-island.ps1: the ack is written through Write-AckSignal');
        }
        const trackerSrc = await readFile(join(PLUGIN_ROOT, 'scripts', 'lib', 'Session-Tracker.ps1'), 'utf8');
        // (k3) sessions.json has a byte budget, not just a row budget.
        //
        // The row cap bounds how many sessions are tracked; it does not bound
        // the file, because every row also carries its title history and the
        // dismissed map has no cap at all. The write path has to measure the
        // serialized bytes and drop the oldest rows until it fits.
        const byteCap = trackerSrc.match(/\$script:MAX_SESSIONS_JSON_BYTES\s*=\s*(\d+)/);
        const writeBody = (trackerSrc.match(/function\s+Write-SessionsFile[\s\S]*?\n\}\n/) || [''])[0];
        const limitBody = (trackerSrc.match(/function\s+Limit-SessionsJson[\s\S]*?\n\}\n/) || [''])[0];
        if (!byteCap) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: no $script:MAX_SESSIONS_JSON_BYTES -- the sessions.json file size is unbounded');
        } else if (+byteCap[1] < 4096 || +byteCap[1] > 1048576) {
            out('FAIL', `scripts/lib/Session-Tracker.ps1: $script:MAX_SESSIONS_JSON_BYTES = ${byteCap[1]} is outside 4KB..1MB`);
        } else if (!writeBody) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Write-SessionsFile body not found');
        } else if (!/\$json\s*=\s*Limit-SessionsJson\b/.test(writeBody)) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Write-SessionsFile does not apply the byte cap -- the file grows with the title history');
        } else if (!limitBody) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Limit-SessionsJson body not found');
        } else if (!/GetByteCount/.test(limitBody)) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Limit-SessionsJson does not measure the bytes -- it cannot enforce a byte budget');
        } else {
            out('PASS', 'scripts/lib/Session-Tracker.ps1: sessions.json is capped in bytes at the write path');
        }
        const ackBody = (trackerSrc.match(/function\s+Read-AckSignal[\s\S]*?\n\}\n/) || [''])[0];
        if (!ackBody) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Read-AckSignal body not found');
        } else if (!/-split\s+"`r\?`n"/.test(ackBody)) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Read-AckSignal reads one id -- dismissing several rows in a second would lose all but the last');
        } else if (!/Move-Item[\s\S]*ackFile[\s\S]*taken/.test(ackBody)) {
            out('FAIL', 'scripts/lib/Session-Tracker.ps1: Read-AckSignal does not take the file by rename -- an ack written while it reads would be lost');
        } else {
            out('PASS', 'scripts/lib/Session-Tracker.ps1: the ack carries many ids and is taken by rename');
        }
        // The UIA lookup has to filter by name. Reading every element of the
        // app's tree costs ~500ms, and the click handler runs on the UI
        // thread -- that would freeze the pill.
        const lookupBody = (widget.match(/function Get-AppConversationButton[\s\S]*?\n\}\n/) || [''])[0];
        if (!lookupBody) {
            out('FAIL', 'mcode-island.ps1: Get-AppConversationButton body not found');
        } else if (!/NameProperty/.test(lookupBody)) {
            out('FAIL', 'mcode-island.ps1: the app conversation lookup does not filter by name -- scanning the whole tree blocks the UI thread');
        } else {
            out('PASS', 'mcode-island.ps1: the app conversation lookup filters by name (no full-tree scan)');
        }

        // (k2) The list has a height budget, not just a data budget.
        //
        // The detector caps the data side ($script:MAX_SESSIONS), but 20 rows
        // at ~48px is taller than the work area on most screens: the bottom
        // of the list runs off the screen and still covers the windows
        // underneath. Three locks: a sane row cap, the overflow notice
        // (silent truncation would claim nothing else is running -- the exact
        // question this list exists to answer), and the work-area clamp.
        const listBody = (widget.match(/function Show-SessionList[\s\S]*?\n\}\n/) || [''])[0];
        const rowCap = widget.match(/\$script:MAX_SESSION_ROWS\s*=\s*(\d+)/);
        if (!listBody) {
            out('FAIL', 'mcode-island.ps1: Show-SessionList body not found (height-cap drift lock skipped)');
        } else if (!rowCap) {
            out('FAIL', 'mcode-island.ps1: no $script:MAX_SESSION_ROWS -- the session list height is unbounded');
        } else if (+rowCap[1] < 6 || +rowCap[1] > 20) {
            out('FAIL', `mcode-island.ps1: $script:MAX_SESSION_ROWS = ${rowCap[1]} is outside 6..20 -- too small hides work, too large runs off the screen`);
        } else if (!/Select-Object -First \$script:MAX_SESSION_ROWS/.test(listBody)) {
            out('FAIL', 'mcode-island.ps1: Show-SessionList does not slice the rows by $script:MAX_SESSION_ROWS');
        } else if (!/if\s*\(\s*\$hidden\s*-gt\s*0\s*\)\s*\{\s*Add-SessionOverflowRow\s+\$hidden\s*\}/.test(listBody)) {
            out('FAIL', 'mcode-island.ps1: rows beyond the cap vanish without the "还有 N 条" notice (or the notice is not gated on $hidden)');
        } else {
            out('PASS', `mcode-island.ps1: the list is capped at ${rowCap[1]} rows and says how many are hidden`);
        }
        if (!listBody) {
            // already reported above
        } else if (!/GetWorkAreaForWindow/.test(listBody) || !/\$window\.Height\s*=/.test(listBody)) {
            out('FAIL', 'mcode-island.ps1: the list height is not clamped to the work area -- it can end up taller than the screen');
        } else {
            out('PASS', 'mcode-island.ps1: the list height is clamped to the work area');
        }

        // (l) The click must be scoped to the sidebar's conversation list.
        //
        // "Any button in the window with that name" is not a conversation
        // click: the same name can be a heading, a label or a button in
        // another panel. The list container is found first -- the one
        // element that holds SEVERAL known session titles -- and the target
        // is looked up only inside it.
        if (/function Get-AppConversationList\b/.test(widget)) {
            out('PASS', 'mcode-island.ps1: the app conversation lookup resolves the sidebar list first');
        } else {
            out('FAIL', 'mcode-island.ps1: no Get-AppConversationList -- the click would look for a button by name across the whole window');
        }
        if (!/Get-AppConversationList\s+\$hwnd/.test(lookupBody)) {
            out('FAIL', 'mcode-island.ps1: the button lookup does not go through the conversation list');
        } else if (/AutomationElement\]::FromHandle/.test(lookupBody)) {
            out('FAIL', 'mcode-island.ps1: the button lookup still starts from the window root instead of the conversation list');
        } else {
            out('PASS', 'mcode-island.ps1: the button lookup is scoped to the conversation list');
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

    // ==== 6. Liquid Glass 材质引擎 =====================================
    //
    // 守的是 Apple HIG "Materials" 的两条硬规矩：
    //   1. 材质没有固有颜色 —— 颜色来自它背后的内容；
    //   2. regular 变体要"按需调整背景明度，以保证文字可读"。
    //
    // 第 2 条不能靠"看着对"来保证：真机上确实出现过背后是白纸时次级文字
    // 对比度掉到 2.7:1、"3h25m 99%"几乎看不见的情况。所以这一节把源码里
    // 的材质参数**读出来**，按最坏背景复算前景/背景的 WCAG 对比度：参数读
    // 不出来、或者算出来不达标，就 FAIL。改一行材质参数，对应的断言打红。
    {
        const widgetPath = join(PLUGIN_ROOT, 'mcode-island.ps1');
        if (!(await exists(widgetPath))) {
            out('FAIL', 'mcode-island.ps1 missing (Liquid Glass material checks skipped)');
        } else {
            const src = await readFile(widgetPath, 'utf8');
            // 注释会喂绿断言：文本匹配类检查必须先剥掉注释行。
            const psCode = src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
            // XAML 里的 XML 注释同理（材质层的说明都写在注释里）。
            const xamlMatch = src.match(/\$xaml\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
            const xamlRaw = xamlMatch ? xamlMatch[1] : '';
            if (!xamlMatch) {
                out('FAIL', 'xaml read: the XAML block could not be read -- the material assertions would run against nothing');
            } else if (!xmlCommentsArePaired(xamlRaw)) {
                out('FAIL', 'xaml comments: an XML comment in the XAML is never closed -- the assertions below would be reading a half-deleted source');
            } else {
                out('PASS', 'xaml comments: every XML comment in the XAML is closed');
            }
            const xaml = stripXmlComments(xamlRaw);
            if (!/<!--|--!?>/.test(xaml)) {
                out('PASS', 'xaml comments: the stripped XAML carries no comment marker');
            } else {
                out('FAIL', 'xaml comments: a comment marker survived the strip -- a comment in the source can feed the material assertions');
            }
            // The strip has to know BOTH comment end tags. A probe is the
            // only way to prove it: the widget's own XAML never uses "--!>",
            // so without a probe a strip that only knew "-->" would look
            // perfect here.
            const probe = '<a><!-- c --!><b>keep</b>';
            if (stripXmlComments(probe) === '<a><b>keep</b>') {
                out('PASS', 'xaml comments: the strip recognises every HTML comment end tag');
            } else {
                out('FAIL', 'xaml comments: the strip does not recognise every HTML comment end tag -- "--!>" closes a comment too');
            }

            const numOf = (name) => {
                const m = psCode.match(new RegExp('\\$script:' + name + '\\s*=\\s*([0-9.]+)'));
                return m ? parseFloat(m[1]) : null;
            };
            const needNum = (name) => {
                const v = numOf(name);
                if (v === null) {
                    out('FAIL', `mcode-island.ps1: $script:${name} is missing or not a plain number -- the material contract cannot be verified`);
                    return null;
                }
                return v;
            };

            // --- 6.1 材质没有固有颜色 -----------------------------------
            // HIG "Color": "Liquid Glass has no inherent color, and instead
            // takes on colors from the content directly behind it".
            //
            // 旧实现是画上去的半透明深蓝灰（#99232734 那一套）。那不是玻璃，
            // 是"一块染了色的矩形"。所以那三个色值必须消失，而且玻璃的底色
            // 必须由运行时抓屏刷上去。
            const legacyTints = ['#99232734', '#7312161C', '#851A1E28'];
            const legacyHits = legacyTints.filter((h) => src.toUpperCase().includes(h.toUpperCase()));
            if (legacyHits.length === 0) {
                out('PASS', 'glass material: the legacy hardcoded tint colours are gone (the material takes its colour from what is behind it)');
            } else {
                out('FAIL', `glass material: still carries the legacy hardcoded tint ${legacyHits.join(', ')} -- a tinted plate is not glass`);
            }
            if (/Background\s*=\s*\$pillCap\.Brush/.test(psCode) && /Background\s*=\s*\$panelCap\.Brush/.test(psCode)) {
                out('PASS', 'glass material: both glass surfaces are filled from the captured backdrop at runtime');
            } else {
                out('FAIL', 'glass material: the glass surfaces are not filled from the captured backdrop (the material would keep a fixed colour)');
            }

            // --- 6.2 抓屏必须把自己排除掉 -------------------------------
            // 不排除的话抓到的是自己的上一帧：模糊之后是一团脏影子，而不是
            // 身后的桌面。实测排除前采样点全是窗口自己的颜色。
            if (/SetWindowDisplayAffinity\(\$hwnd,\s*0x00000011\)/.test(psCode)) {
                out('PASS', 'glass capture: the widget excludes itself from the screen grab (WDA_EXCLUDEFROMCAPTURE)');
            } else {
                out('FAIL', 'glass capture: the widget does not exclude itself from the screen grab -- it would blur its own previous frame');
            }

            // --- 6.3 离屏渲染必须先 Measure + Arrange -------------------
            // RenderTargetBitmap.Render() 只画"已经摆好"的视觉对象。离屏的
            // Image 从没被排过版，Render 出来就是一张全黑：实测同一张图，不
            // 排版亮度 0.0，排版后 0.35。
            const mIdx = psCode.indexOf('$img.Measure(');
            const aIdx = psCode.indexOf('$img.Arrange(');
            const rIdx = psCode.indexOf('$rtb.Render($img)');
            if (mIdx >= 0 && aIdx > mIdx && rIdx > aIdx) {
                out('PASS', 'glass capture: the offscreen image is measured and arranged before it is rendered (otherwise it renders black)');
            } else {
                out('FAIL', 'glass capture: the offscreen image is rendered without a prior Measure/Arrange -- the blurred backdrop would come out black');
            }

            // --- 6.4 形状用 Clip，不是 CornerRadius ---------------------
            // Border 的 CornerRadius 不裁剪子元素，光靠它画出来是方的。
            if (/\$glass\.Clip\s*=\s*\$geo/.test(psCode) && /function New-RoundedRectGeometry/.test(psCode)) {
                out('PASS', 'glass shape: the material is clipped by a real rounded path (Border.CornerRadius would not clip the layers)');
            } else {
                out('FAIL', 'glass shape: the glass surface is not clipped by a rounded path (the corners render square)');
            }
            // 面板要走苹果的"连续圆角"（超椭圆），药丸是正圆弧的胶囊。
            if (/New-RoundedRectGeometry\s+\$w\s+\$h\s+\$Radius\s+\$Smooth\s+0/.test(psCode)
                && /New-RoundedRectGeometry\s+\$w\s+\$h\s+\$Radius\s+\$Smooth\s+1\.25/.test(psCode)) {
                out('PASS', 'glass shape: the rim and the edge strokes are inset paths of the same rounded geometry');
            } else {
                out('FAIL', 'glass shape: the rim/edge strokes are not inset paths of the glass geometry (they would not follow the corner radius)');
            }

            // --- 6.5 模糊半径按物理像素折算 -----------------------------
            // 降采样 1/4 再模糊，Radius 必须按折算后的尺度给。写死 9 的话，
            // 70px 高的药丸（缩小后只有 17px）会被抹成一块纯色板。
            const sd = psCode.match(/\$scaleDown\s*=\s*([0-9.]+)/);
            const br = psCode.match(/\$blur\.Radius\s*=\s*([0-9.]+)/);
            if (sd && br) {
                const phys = parseFloat(sd[1]) * parseFloat(br[1]);
                if (phys >= 16 && phys <= 48) {
                    out('PASS', `glass blur: the blur radius is scaled for physical pixels (${sd[1]}x downscale x ${br[1]} = ${phys}px)`);
                } else {
                    out('FAIL', `glass blur: the effective blur is ${phys}px (${sd[1]}x downscale x ${br[1]}) -- outside the 16..48px band that reads as frosted glass`);
                }
            } else {
                out('FAIL', 'glass blur: $scaleDown / $blur.Radius not found (the blur scale cannot be verified)');
            }

            // --- 6.6 颗粒要克制 -----------------------------------------
            if (/Opacity\s*=\s*0\.0[0-2]/.test(psCode)) {
                out('PASS', 'glass grain: the grain layer stays below 3% opacity (it is a surface frost, not a texture)');
            } else {
                out('FAIL', 'glass grain: the grain opacity is not a small value (a visible speckle destroys the frosted look)');
            }

            // --- 6.7 两极的前景色 / 状态色 / 家族色表 --------------------
            const inkOf = (name) => {
                const m = psCode.match(new RegExp('\\$script:' + name + '\\s*=\\s*@\\{([\\s\\S]*?)\\n\\}'));
                const out = {};
                if (!m) return out;
                const re = /[ \t]*([A-Za-z]+)[ \t]*=[ \t]*'(#[0-9A-Fa-f]{8})'/g;
                let mm;
                while ((mm = re.exec(m[1])) !== null) out[mm[1]] = mm[2];
                return out;
            };
            const inkDark = inkOf('glassInkDark');
            const inkLight = inkOf('glassInkLight');
            if (Object.keys(inkDark).length >= 8 && Object.keys(inkLight).length >= 8) {
                out('PASS', `glass ink: both poles define a full foreground palette (dark ${Object.keys(inkDark).length}, light ${Object.keys(inkLight).length} entries)`);
            } else {
                out('FAIL', `glass ink: the foreground palettes are incomplete (dark ${Object.keys(inkDark).length}, light ${Object.keys(inkLight).length} entries; need >= 8 each)`);
            }
            // 两套色表的键必须一样 —— 少一个键就是某个字在浅色极上没人管。
            const inkKeys = Object.keys(inkDark).sort().join(',');
            const inkKeysLight = Object.keys(inkLight).sort().join(',');
            if (inkKeys && inkKeys === inkKeysLight) {
                out('PASS', 'glass ink: the two poles expose the same foreground roles');
            } else {
                out('FAIL', 'glass ink: the two poles expose different foreground roles (a control would keep the wrong colour on one pole)');
            }

            // 状态色表 / 家族色表也要成对，且键集一致。
            const mapKeys = (srcText, varName) => {
                const m = srcText.match(new RegExp('\\$' + varName + '\\s*=\\s*@\\{([\\s\\S]*?)\\n\\}'));
                if (!m) return null;
                const keys = [];
                const re = /^[ \t]*([A-Za-z][A-Za-z0-9]*)[ \t]*=/gm;
                let mm;
                while ((mm = re.exec(m[1])) !== null) keys.push(mm[1]);
                return keys;
            };
            const stateDark = mapKeys(psCode, 'stateMap');
            const stateLight = mapKeys(psCode, 'stateMapLight');
            const famDark = mapKeys(psCode, 'familyMap');
            const famLight = mapKeys(psCode, 'familyMapLight');
            if (stateDark && stateLight && stateDark.slice().sort().join(',') === stateLight.slice().sort().join(',')) {
                out('PASS', 'glass colour maps: the state table has a light-pole twin with the same states');
            } else {
                out('FAIL', 'glass colour maps: the state table and its light-pole twin cover different states');
            }
            if (famDark && famLight && famDark.slice().sort().join(',') === famLight.slice().sort().join(',')) {
                out('PASS', 'glass colour maps: the family table has a light-pole twin with the same families');
            } else {
                out('FAIL', 'glass colour maps: the family table and its light-pole twin cover different families');
            }
            // 家族色两两之间要分得开（CIE76 dE），两极都要查。
            const deltaE = (hexA, hexB) => {
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
                const la = toLab(hexA), lb = toLab(hexB);
                return Math.sqrt((la[0] - lb[0]) ** 2 + (la[1] - lb[1]) ** 2 + (la[2] - lb[2]) ** 2);
            };
            const famBlockOf = (srcText, varName) => {
                const m = srcText.match(new RegExp('\\$' + varName + '\\s*=\\s*@\\{([\\s\\S]*?)\\n\\}'));
                return m ? m[1] : '';
            };
            const famHexes = (block) => {
                const map = new Map();
                const re = /[ \t]*([a-z]+)[ \t]*=[ \t]*'(#[0-9A-Fa-f]{8})'/g;
                let mm;
                while ((mm = re.exec(block)) !== null) map.set(mm[1], mm[2].slice(3).toUpperCase());
                return map;
            };
            const sepCheck = (label, block) => {
                const colors = famHexes(block);
                if (colors.size < 7) {
                    out('FAIL', `glass colour maps: ${label} parses only ${colors.size}/7 family colours -- the separation check below would be vacuous`);
                    return;
                }
                let worst = Infinity, worstPair = '';
                const entries = [...colors.entries()];
                for (let i = 0; i < entries.length; i++) {
                    for (let j = i + 1; j < entries.length; j++) {
                        const d = deltaE(entries[i][1], entries[j][1]);
                        if (d < worst) { worst = d; worstPair = `${entries[i][0]}/${entries[j][0]}`; }
                    }
                }
                if (worst >= 20) {
                    out('PASS', `glass colour maps: ${label} family colours are all separable (closest pair ${worstPair} dE ${worst.toFixed(1)} >= 20)`);
                } else {
                    out('FAIL', `glass colour maps: ${label} family colours ${worstPair} are only dE ${worst.toFixed(1)} apart -- they read as the same colour on the pill`);
                }
            };
            sepCheck('dark pole', famBlockOf(psCode, 'familyMap'));
            sepCheck('light pole', famBlockOf(psCode, 'familyMapLight'));

            // --- 6.8 换极阈值 + 对比度保证 ------------------------------
            //
            // 这里是这一节的核心：把源码里的材质参数读出来，按**最坏背景**
            // 复算前景/背景的对比度。
            //
            // 模型跟代码一一对应：
            //   - 玻璃的底色 = 背后屏幕的模糊图（L 是它的加权亮度）。
            //   - 染色层是渐变色标：暗色极有"暗背景/亮背景"两套，浅色极一套。
            //   - 标题行落在渐变偏移 0.25 附近，正文行落在 0.55 附近
            //     （药丸高 70，内容上边距 6，标题行高约 22）。
            //   - 前景色是带透明度的墨色，合成到玻璃上再算 WCAG 对比度。
            const P = {
                lightOn: needNum('glassPoleLightOn'),
                lightOff: needNum('glassPoleLightOff'),
                targetDark: needNum('glassTargetByteDark'),
                targetLight: needNum('glassTargetByteLight'),
                thickDark: needNum('glassThickDark'),
                thickLight: needNum('glassThickLight'),
            };
            const allNum = Object.values(P).every((v) => v !== null);
            if (!allNum) {
                out('FAIL', 'glass contrast: the material constants are incomplete -- the legibility guarantee cannot be verified');
            } else {
                // 迟滞：两个阈值必须分得开，否则背景亮度在阈值附近抖一下，
                // 药丸就跟着闪一下。
                if (P.lightOn > P.lightOff) {
                    out('PASS', `glass pole: the light/dark switch is hysteretic (on at ${P.lightOn}, back at ${P.lightOff})`);
                } else {
                    out('FAIL', `glass pole: the light switch (${P.lightOn}) is not above the dark switch (${P.lightOff}) -- the material would flicker`);
                }

                // 渐变色标：只取染色层（$tintBrush）上的那些，边缘高光和
                // 厚度暗边用的是同一套 New-GlassStop，按颜色过滤掉。
                const tintStops = (block) => {
                    const stops = [];
                    for (const line of block.split(/\r?\n/)) {
                        if (!/\$tintBrush\.GradientStops\.Add\(/.test(line)) continue;
                        const m = line.match(/New-GlassStop\s+\$(white|dark)\s+([0-9.]+)\s+\(([^)]*)\)/);
                        if (!m) continue;
                        const expr = m[3].trim();
                        let factor = null, lit = null, over = null;
                        const vm = expr.match(/^\$veil\s*\*\s*([0-9.]+)$/);
                        const vb = expr.match(/^\$veil$/);
                        const lm = expr.match(/^\$lift\s*\*\s*([0-9.]+)$/);
                        const lb = expr.match(/^\$lift$/);
                        const pm = expr.match(/^([0-9.]+)$/);
                        if (vm) { factor = parseFloat(vm[1]); over = 'veil'; }
                        else if (vb) { factor = 1; over = 'veil'; }
                        else if (lm) { factor = parseFloat(lm[1]); over = 'lift'; }
                        else if (lb) { factor = 1; over = 'lift'; }
                        else if (pm) { lit = parseFloat(pm[1]); }
                        stops.push({ kind: m[1], offset: parseFloat(m[2]), factor, lit, over });
                    }
                    return stops;
                };
                // 两套渐变：背后比目标亮（混黑）/ 比目标暗（混白）。两极共用，
                // 差的只是目标灰度。
                // 锚点只能用代码：psCode 已经把注释行剥掉了（注释会喂绿断言）。
                const veilBranch = psCode.indexOf('if ($veil -gt 0.0) {');
                const veilElse = veilBranch < 0 ? -1 : psCode.indexOf('\n    } else {', veilBranch);
                const tintAfter = veilElse < 0 ? -1 : psCode.indexOf('$tintPath = $window.FindName', veilElse);
                const stopsBlack = veilBranch < 0 || veilElse < 0 ? [] : tintStops(psCode.slice(veilBranch, veilElse));
                const stopsWhite = veilElse < 0 || tintAfter < 0 ? [] : tintStops(psCode.slice(veilElse, tintAfter));
                if (stopsBlack.length >= 4 && stopsWhite.length >= 4) {
                    out('PASS', `glass tint: the two tint gradients are readable (washed-black ${stopsBlack.length}, washed-white ${stopsWhite.length} stops)`);
                } else {
                    out('FAIL', 'glass tint: the tint gradients could not be parsed -- the contrast model would be vacuous');
                }

                // 玻璃在某个渐变偏移上的实际颜色。
                const glassAt = (stops, offset, veil, lift, backdrop) => {
                    if (!stops.length) return backdrop;
                    const sorted = [...stops].sort((a, b) => a.offset - b.offset);
                    let s1 = sorted[0], s2 = sorted[sorted.length - 1];
                    for (let i = 0; i < sorted.length - 1; i++) {
                        if (offset >= sorted[i].offset && offset <= sorted[i + 1].offset) {
                            s1 = sorted[i]; s2 = sorted[i + 1];
                            break;
                        }
                    }
                    const span = s2.offset - s1.offset;
                    const t = span > 0 ? Math.max(0, Math.min(1, (offset - s1.offset) / span)) : 0;
                    const alphaOf = (s) => {
                        if (s.lit !== null) return s.lit;
                        if (s.factor === null) return 0;
                        if (s.over === 'lift') return s.factor * lift;
                        return s.factor * veil;
                    };
                    const a1 = alphaOf(s1), a2 = alphaOf(s2);
                    const a = a1 + (a2 - a1) * t;
                    const c1 = s1.kind === 'white' ? 255 : 0;
                    const c2 = s2.kind === 'white' ? 255 : 0;
                    const c = c1 + (c2 - c1) * t;
                    return backdrop * (1 - a) + c * a;
                };
                // 收敛模型：先定目标灰度，再反推要混多少。
                //   背后比目标亮 -> 混黑 veil = 1 - target / L
                //   背后比目标暗 -> 混白 lift = (target - L) / (1 - L)
                // 混完之后玻璃落在目标灰度上，跟背后是什么无关。
                const mixOf = (L, target) => (L > target
                    ? { veil: 1 - target / L, lift: 0 }
                    : { veil: 0, lift: (target - L) / (1 - L) });
                // sRGB -> WCAG
                const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
                const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
                const ratio = (a, b) => {
                    const la = lum(a), lb = lum(b);
                    const hi = Math.max(la, lb), lo = Math.min(la, lb);
                    return (hi + 0.05) / (lo + 0.05);
                };
                const inkRgb = (hex8) => {
                    const a = parseInt(hex8.slice(1, 3), 16) / 255;
                    return { a, rgb: [parseInt(hex8.slice(3, 5), 16), parseInt(hex8.slice(5, 7), 16), parseInt(hex8.slice(7, 9), 16)] };
                };
                const over = (fg, bg) => fg.rgb.map((c, i) => fg.a * c + (1 - fg.a) * bg);

                const TITLE_OFF = 0.25;   // 标题行在药丸里的纵向位置
                const BODY_OFF = 0.55;    // 正文行
                const worst = { darkPrimary: Infinity, darkSecondary: Infinity, lightPrimary: Infinity, lightSecondary: Infinity };
                for (let i = 0; i <= 600; i++) {
                    const L = i / 600;
                    const backdrop = 255 * L;
                    // 深色极：玻璃收敛到目标灰度，不管背后是白纸还是黑终端。
                    {
                        const m = mixOf(L, P.targetDark);
                        const stops = m.veil > 0 ? stopsBlack : stopsWhite;
                        const gTitle = glassAt(stops, TITLE_OFF, m.veil, m.lift, backdrop);
                        const gBody = glassAt(stops, BODY_OFF, m.veil, m.lift, backdrop);
                        const p = ratio(over(inkRgb(inkDark.Primary), gTitle), [gTitle, gTitle, gTitle]);
                        const s = Math.min(
                            ratio(over(inkRgb(inkDark.Secondary), gTitle), [gTitle, gTitle, gTitle]),
                            ratio(over(inkRgb(inkDark.Secondary), gBody), [gBody, gBody, gBody]),
                        );
                        if (p < worst.darkPrimary) worst.darkPrimary = p;
                        if (s < worst.darkSecondary) worst.darkSecondary = s;
                    }
                    // 浅色极：同一个模型，目标灰度换成浅的那档。
                    {
                        const m = mixOf(L, P.targetLight);
                        const stops = m.veil > 0 ? stopsBlack : stopsWhite;
                        const gTitle = glassAt(stops, TITLE_OFF, m.veil, m.lift, backdrop);
                        const gBody = glassAt(stops, BODY_OFF, m.veil, m.lift, backdrop);
                        const p = ratio(over(inkRgb(inkLight.Primary), gTitle), [gTitle, gTitle, gTitle]);
                        const s = Math.min(
                            ratio(over(inkRgb(inkLight.Secondary), gTitle), [gTitle, gTitle, gTitle]),
                            ratio(over(inkRgb(inkLight.Secondary), gBody), [gBody, gBody, gBody]),
                        );
                        if (p < worst.lightPrimary) worst.lightPrimary = p;
                        if (s < worst.lightSecondary) worst.lightSecondary = s;
                    }
                }
                // 主文字：HIG 说 regular 变体要"maintain legibility of text"，
                // 4.5:1 是 WCAG AA 对正文的要求，这里按主文字执行。
                // 次级文字：Apple 自己在半透明材质上就是 2.7~3.4 这一档
                // （secondaryLabel 压在非纯白底上就是这个数），所以门槛取
                // 2.5：再低就真的看不见了。
                const PRIMARY_MIN = 4.5;
                const SECONDARY_MIN = 2.5;
                if (worst.darkPrimary >= PRIMARY_MIN) {
                    out('PASS', `glass contrast: the dark pole keeps the primary text at ${worst.darkPrimary.toFixed(2)}:1 over the worst backdrop (>= ${PRIMARY_MIN}:1)`);
                } else {
                    out('FAIL', `glass contrast: the dark pole drops the primary text to ${worst.darkPrimary.toFixed(2)}:1 over the worst backdrop (needs ${PRIMARY_MIN}:1)`);
                }
                if (worst.lightPrimary >= PRIMARY_MIN) {
                    out('PASS', `glass contrast: the light pole keeps the primary text at ${worst.lightPrimary.toFixed(2)}:1 over the worst backdrop (>= ${PRIMARY_MIN}:1)`);
                } else {
                    out('FAIL', `glass contrast: the light pole drops the primary text to ${worst.lightPrimary.toFixed(2)}:1 over the worst backdrop (needs ${PRIMARY_MIN}:1)`);
                }
                if (worst.darkSecondary >= SECONDARY_MIN) {
                    out('PASS', `glass contrast: the dark pole keeps the secondary text at ${worst.darkSecondary.toFixed(2)}:1 over the worst backdrop (>= ${SECONDARY_MIN}:1)`);
                } else {
                    out('FAIL', `glass contrast: the dark pole drops the secondary text to ${worst.darkSecondary.toFixed(2)}:1 over the worst backdrop (needs ${SECONDARY_MIN}:1)`);
                }
                if (worst.lightSecondary >= SECONDARY_MIN) {
                    out('PASS', `glass contrast: the light pole keeps the secondary text at ${worst.lightSecondary.toFixed(2)}:1 over the worst backdrop (>= ${SECONDARY_MIN}:1)`);
                } else {
                    out('FAIL', `glass contrast: the light pole drops the secondary text to ${worst.lightSecondary.toFixed(2)}:1 over the worst backdrop (needs ${SECONDARY_MIN}:1)`);
                }
            }

            // --- 6.9 大元素 = 更厚的材质 --------------------------------
            // HIG "Materials": "Liquid Glass appears more opaque in larger
            // elements". 面板比药丸大得多，再透就成了一块挡板的玻璃。
            //
            // 两极各有一处 Thick 分支，都要检查：只要有一极的系数掉到 1
            // 以下，那一极的面板就比药丸还透，玻璃的厚度感就没了。
            // 新模型里"更厚"不是把染色系数调大，而是把**目标灰度**推得更靠近
            // 材料自己的颜色：深色极更黑，浅色极更白。
            const thickDarkOk = /\$target\s*=\s*\$target\s*\*\s*\(1\.0\s*-\s*\$thickMix\)/.test(psCode);
            const thickLightOk = /\$target\s*=\s*\$target\s*\+\s*\(1\.0\s*-\s*\$target\)\s*\*\s*\$thickMix/.test(psCode);
            const thickOk = thickDarkOk && thickLightOk && P.thickDark > 0 && P.thickLight > 0;
            if (thickOk) {
                out('PASS', `glass depth: the panel is thicker than the pill in both poles (dark ${P.thickDark}, light ${P.thickLight})`);
            } else {
                out('FAIL', `glass depth: the panel is not thicker than the pill (dark branch ${thickDarkOk}, light branch ${thickLightOk}) -- the large element would stay as transparent as the pill`);
            }

            // --- 6.10 XAML 里不能有硬编码的材质色 ----------------------
            // 材质层在 XAML 里只能是占位（Transparent），颜色一律运行时刷。
            const materialPaths = ['PillTint', 'PillGrain', 'PillRim', 'PillEdge', 'PanelTint', 'PanelGrain', 'PanelRim', 'PanelEdge'];
            const badMaterial = [];
            for (const name of materialPaths) {
                const re = new RegExp('x:Name="' + name + '"[^>]*');
                const m = xaml.match(re);
                if (!m) { badMaterial.push(`${name}:missing`); continue; }
                const tag = m[0];
                if (!/Fill="Transparent"/.test(tag) || !/Stroke="Transparent"/.test(tag)) badMaterial.push(name);
            }
            if (badMaterial.length === 0) {
                out('PASS', `glass layers: all ${materialPaths.length} material layers start uncoloured and are painted at runtime`);
            } else {
                out('FAIL', `glass layers: ${badMaterial.join(', ')} carry a baked-in colour instead of being painted at runtime`);
            }

            // --- 6.10b 材质层不能参与测量 ------------------------------
            //
            // Path 的 DesiredSize 来自 Data 的 Bounds，而材质的四条 Path 的
            // Data 正是"整块玻璃那么大"的矩形。放在 Grid 里它们就参与测量：
            // 面板所在的是 Auto 行，于是面板高度 = max(上一次的材质矩形,
            // 内容高度) —— 内容变矮时高度不降，材质矩形永远停在上一轮，
            // 面板只增不减，最后黑成一条到底的长条。
            //
            // Canvas 不测量子元素（DesiredSize 是 0）。材质层必须住在
            // Canvas 里：只画，不撑。
            const materialCanvas = (prefix) => {
                const open = xaml.indexOf(`<Canvas x:Name="${prefix}Material">`);
                if (open < 0) return null;
                const close = xaml.indexOf('</Canvas>', open);
                if (close < 0) return null;
                return { open, close };
            };
            const zones = { Pill: materialCanvas('Pill'), Panel: materialCanvas('Panel') };
            const outsideCanvas = [];
            for (const name of materialPaths) {
                const idx = xaml.indexOf(`x:Name="${name}"`);
                const zone = name.startsWith('Pill') ? zones.Pill : zones.Panel;
                if (idx < 0 || !zone || idx < zone.open || idx > zone.close) outsideCanvas.push(name);
            }
            if (outsideCanvas.length === 0) {
                out('PASS', 'glass layout: every material path lives in a Canvas -- it paints without taking part in measuring');
            } else {
                out('FAIL', `glass layout: ${outsideCanvas.join(', ')} are not inside a Canvas -- a Path measures as big as its Data, so the panel height sticks to the previous one`);
            }

            // --- 6.10c 会话日志的遍历边界 ------------------------------
            //
            // round-24 review (hetaoBackend)：两个 scanner 以前都用
            // EnumerateXxx(..., AllDirectories)，而微软的文档写明
            // AllDirectories **包含 reparse point**（符号链接、junction、
            // 挂载点）：
            // https://learn.microsoft.com/en-us/dotnet/api/system.io.searchoption
            //
            // sessions 目录底下放一个 junction，递归就会顺着它走进外面，
            // 读到不属于这个用户的日志。所以源码里不能再有这种盲递归：
            // 两个 scanner 都得走 scripts/lib/Safe-Traversal.ps1 那个有界的
            // 遍历 —— 它拒绝 reparse point，并且在打开之前验证 canonical
            // containment。
            const safeLibPath = join(PLUGIN_ROOT, 'scripts', 'lib', 'Safe-Traversal.ps1');
            const safeLibExists = await exists(safeLibPath);
            if (safeLibExists) {
                out('PASS', 'traversal: the bounded traversal lib exists');
            } else {
                out('FAIL', 'traversal: scripts/lib/Safe-Traversal.ps1 is missing -- the scanners have no bounded way to walk the sessions root');
            }
            const blindWalk = [];
            const notBounded = [];
            if (safeLibExists) {
                const safeText = await readFile(safeLibPath, 'utf8');
                const safeCode = safeText.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
                if (/AllDirectories/.test(safeCode)) blindWalk.push('scripts/lib/Safe-Traversal.ps1');
                if (!/TopDirectoryOnly/.test(safeCode)) blindWalk.push('scripts/lib/Safe-Traversal.ps1 (it does not walk one level at a time)');
                // 检查的是**调用点**，不是函数定义：定义里带着 ReparsePoint /
                // Test-PathContained 这两个词，而调用点才是真正在把关的地方。
                if (!/Test-PathIsReparsePoint\s+\$d/.test(safeCode)) blindWalk.push('scripts/lib/Safe-Traversal.ps1 (it never rejects a reparse point)');
                if (!/Test-PathContained\s+\$rootFull\s+\$d/.test(safeCode)) blindWalk.push('scripts/lib/Safe-Traversal.ps1 (it never checks containment)');
                for (const rel of ['scripts/lib/Session-Tracker.ps1', 'mcode-status-detect.ps1']) {
                    const text = await readFile(join(PLUGIN_ROOT, ...rel.split('/')), 'utf8');
                    const code = text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
                    if (/AllDirectories/.test(code)) blindWalk.push(rel);
                    if (!/Get-SafeSessionEntries/.test(code)) notBounded.push(rel);
                }
            }
            if (blindWalk.length === 0 && safeLibExists) {
                out('PASS', 'traversal: no scanner walks the sessions root with a blind AllDirectories recursion');
            } else {
                out('FAIL', `traversal: ${blindWalk.join(', ')} still recurse with AllDirectories -- it follows reparse points out of the sessions root`);
            }
            if (notBounded.length === 0 && safeLibExists) {
                out('PASS', 'traversal: both scanners go through the bounded traversal');
            } else {
                out('FAIL', `traversal: ${notBounded.join(', ')} do not use Get-SafeSessionEntries`);
            }

            // --- 6.11 每块面各判各的极 ----------------------------------
            // HIG "Materials": 每块材质各自调整明度来保住可读性。药丸和展开
            // 面板背后可能差得很远（药丸压着一段亮色标题栏，面板底下却是一
            // 片深色编辑器），所以极性和墨色必须**按面拆开**。
            //
            // 共用一份极性的后果真机见过：面板判出浅色极把全局翻了，药丸就
            // 变成"暗玻璃 + 深色字"，看着像渲染坏了 —— 而且两块面每 100ms
            // 互相翻一次，整个 UI 在浅色/深色之间闪。
            {
                const hasPanelPole = /\$script:glassPanelPole\s*=\s*'dark'/.test(psCode);
                if (hasPanelPole) {
                    out('PASS', 'glass poles: the panel keeps a pole of its own, independent of the pill');
                } else {
                    out('FAIL', 'glass poles: the panel has no pole of its own ($script:glassPanelPole) -- both surfaces would share one polarity, and the one that disagrees would end up unreadable');
                }

                // 判极的函数必须是纯的：迟滞相对"这块面自己的极"判断。
                // 一旦它去读全局极性，两块面就又绑在一起了。
                const resolverBody = (psCode.match(/function Resolve-GlassPole \{[\s\S]*?\n\}/) || [''])[0];
                const resolverPure = /param\(\[double\]\$L, \[string\]\$Current\)/.test(resolverBody)
                    && !/\$script:glassPole\b/.test(resolverBody)
                    && !/\$script:glassPanelPole\b/.test(resolverBody);
                if (resolverPure) {
                    out('PASS', 'glass poles: the pole resolver is pure -- hysteresis is judged against the surface it is handed');
                } else {
                    out('FAIL', 'glass poles: Resolve-GlassPole reads or writes a global pole -- the pill and the panel would keep flipping each other');
                }

                // 两块面必须各写各的极。
                const writesPill = /\$script:glassPole\s*=\s*\$pole/.test(psCode);
                const writesPanel = /\$script:glassPanelPole\s*=\s*\$pole/.test(psCode);
                const picksPerPrefix = /\$isPanel\s*=\s*\(\$Prefix\s+-eq\s+'Panel'\)/.test(psCode)
                    && /Resolve-GlassPole\s+\$L\s+\$curPole/.test(psCode);
                if (writesPill && writesPanel && picksPerPrefix) {
                    out('PASS', 'glass poles: the material picks the pole per surface (pill and panel each store their own)');
                } else {
                    out('FAIL', `glass poles: the material does not pick a pole per surface (pill write ${writesPill}, panel write ${writesPanel}, per-prefix branch ${picksPerPrefix})`);
                }

                // 列表行画在面板上，字的墨色必须跟面板的极走。
                const rowBody = (psCode.match(/function Add-SessionRow[\s\S]*?\n\}/) || [''])[0];
                const rowsUsePanelInk = /Get-PanelInk/.test(rowBody)
                    && /Get-PanelStateMap/.test(rowBody)
                    && !/Get-GlassInk/.test(rowBody)
                    && !/Get-GlassStateMap/.test(rowBody);
                if (rowsUsePanelInk) {
                    out('PASS', 'glass poles: the session rows take their ink and state colours from the panel they are drawn on');
                } else {
                    out('FAIL', 'glass poles: the session rows still take their colours from the global pole -- a dark panel would get dark text');
                }

                // 药丸的字跟药丸自己的极走，不能被面板的极带偏。
                const inkBody = (psCode.match(/function Update-GlassInk \{[\s\S]*?\n\}/) || [''])[0];
                const pillInkOwn = /Get-GlassInk/.test(inkBody) && !/Get-PanelInk/.test(inkBody);
                if (pillInkOwn) {
                    out('PASS', 'glass poles: the pill text takes its ink from the pill pole, not the panel pole');
                } else {
                    out('FAIL', 'glass poles: the pill text is coloured from the panel pole -- the pill and the panel would fight over one ink set');
                }

                // 颗粒笔刷同理：暗玻璃白点、亮玻璃黑点，两块面各用各的。
                const grainPerSurface = /Update-GlassGrain\s+'PillGrain'\s+\$script:glassPole/.test(psCode)
                    && /Update-GlassGrain\s+'PanelGrain'\s+\$script:glassPanelPole/.test(psCode);
                if (grainPerSurface) {
                    out('PASS', 'glass poles: the grain brush follows each surface pole (white specks on dark glass, black on light)');
                } else {
                    out('FAIL', 'glass poles: the grain brush is not chosen per surface -- one of the two glass bodies gets the wrong speck colour');
                }

                // 亮度日志也按面分开。
                //
                // 两块面共用一个槽位时，亮度行只在变化超过 0.12 时才记，两块面
                // 轮流往同一个槽位写，后写的那面几乎永远落不下自己的一行 ——
                // "面板为什么变白了"就成了查不出来的事（面板换了极，日志里只剩
                // 药丸的亮度）。日志是排查这类问题的唯一入口，不能自己瞎掉。
                const lumPerSurface = /\$script:glassLoggedLum\s*=\s*@\{\}/.test(psCode)
                    && /\$null -eq \$script:glassLoggedLum\[\$Prefix\]/.test(psCode);
                if (lumPerSurface) {
                    out('PASS', 'glass poles: each surface logs its own luminance (the panel would never get a brightness line of its own)');
                } else {
                    out('FAIL', 'glass poles: the luminance log slot is shared between the two surfaces -- the panel would almost never get a brightness line of its own');
                }
            }

            // --- 6.12 收敛到目标灰度（"统一黑色"）------------------------
            //
            // HIG "Materials": regular 变体 "blurs and **adjusts the luminosity**
            // of background content to maintain legibility of text"。所以算法
            // 必须是"先定目标灰度，再反推混多少"，而不是"压固定比例的黑"。
            //
            // 不这么做的后果真机见过：白底上玻璃停在中灰（字节 106 ≈ #6A6A6A），
            // 深色字压上去就是一团脏灰 —— 用户嫌它"灰突突"。
            {
                const converges = /\$veil\s*=\s*1\.0\s*-\s*\(\$target\s*\/\s*\$L\)/.test(psCode)
                    && /\$lift\s*=\s*\(\$target\s*-\s*\$L\)\s*\/\s*\(1\.0\s*-\s*\$L\)/.test(psCode);
                if (converges) {
                    out('PASS', 'glass convergence: the glass mixes towards a target grey instead of a fixed black wash');
                } else {
                    out('FAIL', 'glass convergence: the material does not solve for a target grey -- the glass lands on a mid grey over a bright backdrop');
                }

                // 深色极的目标必须落在"真黑"那一档：macOS 那个 Dynamic Island
                // 是 #1C1C1E（字节 28 ≈ 0.11），再深就糊成一团分不出玻璃。
                const darkTarget = P.targetDark;
                if (darkTarget !== null && darkTarget >= 0.09 && darkTarget <= 0.15) {
                    out('PASS', `glass convergence: the dark pole converges on the island black (target ${darkTarget}, ~#${Math.round(255 * darkTarget).toString(16).padStart(2, '0').toUpperCase()})`);
                } else {
                    out('FAIL', `glass convergence: the dark pole target ${darkTarget} is not the island black (0.09..0.15) -- the glass would read as grey, not as a black slab`);
                }

                // 默认必须是统一的黑玻璃：浅色极在白底上"灰突突"就是它惹的。
                const defaultIsDark = /materialPole\s*=\s*'dark'/.test(psCode);
                if (defaultIsDark) {
                    out('PASS', 'glass convergence: the default material is the unified black glass');
                } else {
                    out('FAIL', 'glass convergence: the default material is not the black glass -- the island would still switch to a grey material over a bright backdrop');
                }

                // 参数名不许和局部名撞车。
                //
                // PowerShell 的变量名不区分大小写，而且参数的类型约束还在：
                // 参数是 [bool]$Thick，函数体里再写 $thick = 0.25 会被强制转成
                // $true，接着 (1.0 - $thick) 算出 0，目标灰度被乘成 0 —— 玻璃
                // 成了纯黑（veil 恒等于 1）。
                //
                // 这类坑静态断言看不出来（数值都"对"，只是被转换了），所以只能
                // 把"参数名和局部名不撞车"这条纪律本身锁住。
                const applyStart = psCode.indexOf('function Apply-GlassMaterial {');
                const applyEnd = psCode.indexOf('\nfunction ', applyStart + 10);
                const applyBody = applyStart < 0 ? '' : psCode.slice(applyStart, applyEnd < 0 ? undefined : applyEnd);
                const thickIsTyped = /param\([^)]*\[bool\]\$Thick\)/.test(applyBody);
                const thickShadowed = /\$thick(?![\w])\s*=/i.test(applyBody);
                if (thickIsTyped && !thickShadowed) {
                    out('PASS', 'glass convergence: the thickness factor does not shadow the typed parameter ($Thick)');
                } else {
                    out('FAIL', 'glass convergence: the thickness factor shadows the [bool]$Thick parameter -- PowerShell would coerce it and the target grey would collapse to 0');
                }
            }
        }
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
