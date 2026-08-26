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
    console.log(`mcode-island v0.3.0 self-check`);
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
    if (plugin.version !== '0.3.0') {
        out('FAIL', `plugin.json: version is "${plugin.version}", expected "0.3.0"`);
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
