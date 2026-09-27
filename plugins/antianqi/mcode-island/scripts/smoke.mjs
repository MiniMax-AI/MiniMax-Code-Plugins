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

import { readFile, stat } from 'node:fs/promises';
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

    // 5c2. Click toggle extension (round-14 refactor).
    // The pill's MouseLeftButtonUp must call Toggle-CallerWindow, NOT
    // Focus-CallerWindow. Single-click show is one-way and forces the
    // CLI to the front every time the user clicks, which is wrong for
    // "I clicked the pill to hide the CLI" — the second click would
    // re-show it and surprise the user. Toggle semantics match the
    // user's "单击收起单击调出" mental model.
    // Drift lock: Resolve-CallerWindow + Toggle-CallerWindow must
    // exist as named functions (refactor target), and the click
    // handler must invoke Toggle-CallerWindow, not Focus-CallerWindow.
    if (await exists(substepWidgetPath)) {
        const widget = await readFile(substepWidgetPath, 'utf8');
        if (!/function Resolve-CallerWindow\b/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: Resolve-CallerWindow function missing (toggle refactor target)');
        } else {
            out('PASS', 'mcode-island.ps1: Resolve-CallerWindow function present');
        }
        if (!/function Toggle-CallerWindow\b/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: Toggle-CallerWindow function missing');
        } else {
            out('PASS', 'mcode-island.ps1: Toggle-CallerWindow function present');
        }
        // Toggle-CallerWindow must dispatch on IsWindowVisible (the
        // core visibility check). A regression that always calls
        // ShowWindow(SW_HIDE) without checking state would silently
        // break the toggle (every click = hide, never show).
        if (!/IsWindowVisible\s*\(\s*\$r\.Hwnd\s*\)/.test(widget)) {
            out('FAIL', 'mcode-island.ps1: Toggle-CallerWindow does not check IsWindowVisible');
        } else {
            out('PASS', 'mcode-island.ps1: Toggle-CallerWindow gates on IsWindowVisible');
        }
        // The click handler must call Toggle-CallerWindow, not Focus.
        // We anchor on the MouseLeftButtonUp event to scope the check.
        const clickMatch = widget.match(/Add_MouseLeftButtonUp\([\s\S]*?\}\s*\)\s*$/m);
        if (!clickMatch) {
            out('WARN', 'mcode-island.ps1: Add_MouseLeftButtonUp handler not found (drift lock skipped)');
        } else if (!/Toggle-CallerWindow\b/.test(clickMatch[0])) {
            out('FAIL', 'mcode-island.ps1: MouseLeftButtonUp does not invoke Toggle-CallerWindow (still using Focus-only)');
        } else if (/Focus-CallerWindow\b/.test(clickMatch[0])) {
            out('FAIL', 'mcode-island.ps1: MouseLeftButtonUp invokes both Toggle and Focus — pick one');
        } else {
            out('PASS', 'mcode-island.ps1: MouseLeftButtonUp invokes Toggle-CallerWindow (single click toggles show/hide)');
        }

        // Round-15: Toggle's restore branch must call SW_MAXIMIZE (3), not
        // SW_SHOW (5) / SW_RESTORE (9). SW_HIDE preserves the window's
        // "non-maximized size"; if the WT window got accidentally resized
        // to a thin strip (e.g., 480x84 from a snap gesture or our own
        // mouse_event test artifacts), SW_SHOW / SW_RESTORE would re-show
        // it as that strip — the user's complaint was "hide works, show is
        // a thin strip". SW_MAXIMIZE forces full-screen on hidden /
        // minimized / normal windows alike; no-op on already-maximized.
        const toggleMatch = widget.match(/function Toggle-CallerWindow[\s\S]*?\n\}\n/);
        if (!toggleMatch) {
            out('WARN', 'mcode-island.ps1: Toggle-CallerWindow body not found (drift lock skipped)');
        } else {
            const toggleBody = toggleMatch[0];
            // Extract the `else` branch (the restore path) so the check
            // is anchored on the show branch, not the hide branch (which
            // intentionally uses SW_HIDE=0).
            const elseMatch = toggleBody.match(/else\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\}\s*$/m);
            const restoreBody = elseMatch ? elseMatch[1] : '';
            if (!restoreBody) {
                out('FAIL', 'mcode-island.ps1: Toggle-CallerWindow else branch not parseable');
            } else if (!/ShowWindow\(\s*\$r\.Hwnd\s*,\s*3\s*\)/.test(restoreBody)) {
                out('FAIL', 'mcode-island.ps1: Toggle restore branch does not call SW_MAXIMIZE (ShowWindow(_, 3)). A regression to SW_SHOW (5) or SW_RESTORE (9) re-shows the window at its pre-hide size (e.g., 480x84 strip if WT got accidentally resized).');
            } else if (/ShowWindow\(\s*\$r\.Hwnd\s*,\s*5\s*\)/.test(restoreBody)) {
                out('FAIL', 'mcode-island.ps1: Toggle restore branch calls SW_SHOW (5) in addition to SW_MAXIMIZE — keep only SW_MAXIMIZE; SW_SHOW re-shows at pre-hide size and defeats the maximize intent.');
            } else {
                out('PASS', 'mcode-island.ps1: Toggle restore branch forces SW_MAXIMIZE (full-screen on show, fixes 480x84 strip bug)');
            }

            // Round-16: Toggle's restore branch must also force the window
            // to fill the actual monitor work area (MonitorFromWindow +
            // GetMonitorInfo + SetWindowPos). SW_MAXIMIZE alone is
            // insufficient on multi-monitor + DPI-virtualized setups: the
            // user's primary monitor is physically 2560x1440, but WinForms
            // [Screen]::PrimaryScreen reports 1920x1080 (DPI virtualization).
            // SW_MAXIMIZE follows the 1920x1080 number and leaves WT at
            // ~75% of the physical screen — visually "in the top-left corner"
            // of the user's 2K monitor. The drift lock forces the explicit
            // SetWindowPos path.
            if (!/GetWorkAreaForWindow|GetMonitorInfo|MonitorFromWindow/.test(toggleBody)) {
                out('FAIL', 'mcode-island.ps1: Toggle restore branch does not query monitor work area. Without MonitorFromWindow + SetWindowPos(explicit size), SW_MAXIMIZE alone fills only the WinForms 1920x1080 logical work area, not the actual 2560x1440 physical monitor — leaves WT at the top-left 75%.');
            } else if (!/SetWindowPos\([^)]*\$wa\.|SetWindowPos\(\$r\.Hwnd,[^,]+,\s*\$wa\.Left,\s*\$wa\.Top,\s*\$cx,\s*\$cy/.test(toggleBody)) {
                out('FAIL', 'mcode-island.ps1: Toggle restore branch has monitor query but does not SetWindowPos with work-area coords. The contract is: read monitor work area, then SetWindowPos with explicit (Left, Top, cx, cy) — never rely on SW_MAXIMIZE alone for size.');
            } else {
                out('PASS', 'mcode-island.ps1: Toggle restore branch forces work-area size via MonitorFromWindow + SetWindowPos (fills 2560x1440 physical monitor, not just 1920x1080 logical)');
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
            ['$S_WAITING is defined', /\$S_WAITING\s*=\s*_s\s*\(/],
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
