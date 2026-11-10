#!/usr/bin/env node
// Negative-injection harness for the Liquid Glass material checks.
//
// Each case mutates exactly ONE line of the widget source, runs the smoke
// suite and asserts that the EXPECTED check flips to FAIL. Then the line is
// restored. At the end the suite must be green again.
//
// The point: a check that cannot go red proves nothing. Every guard added to
// smoke.mjs has to survive this table -- a green suite that stays green no
// matter what you break is decoration, not a test.
//
//   node scripts/test-material-injection.mjs
//
// It mutates a COPY of the plugin, never the working tree.
//
// The old version rewrote plugins/antianqi/mcode-island/mcode-island.ps1 in
// place. `node --test` runs every suite in the repository in PARALLEL, so a
// sibling suite that read the widget while this harness was writing it saw
// a HALF-WRITTEN file -- writeFile truncates before it writes -- and the
// reader reported "function Build-DisplayMessage not found" for a function
// that is in the file. That is a race, not a test failure, and it took the
// ubuntu CI job down. Working on a copy removes the race for good: the
// checked-in sources are never open for writing, so a parallel reader always
// sees a complete file, and an interrupted run cannot leave the tree
// half-mutated.

import { readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(ROOT, '..', '..', '..');

// The copy mirrors the repository layout on purpose: smoke.mjs imports the
// shared validator from the repository root, five levels up from its own
// file (../../../../../scripts/lib/validation.mjs). A flat temp directory
// would resolve that import to the wrong place and silently drop the
// hooks.json schema check from the copy's run.
const TMP = mkdtempSync(join(tmpdir(), 'mcode-island-injection-'));
const TMP_PLUGIN = join(TMP, 'plugins', 'antianqi', 'mcode-island');
cpSync(ROOT, TMP_PLUGIN, { recursive: true });
const VALIDATOR = join(REPO_ROOT, 'scripts', 'lib', 'validation.mjs');
if (existsSync(VALIDATOR)) {
    mkdirSync(join(TMP, 'scripts', 'lib'), { recursive: true });
    cpSync(VALIDATOR, join(TMP, 'scripts', 'lib', 'validation.mjs'));
}

// The working-tree sources the harness would rewrite if it still worked in
// place. The watcher below proves that it never touches them.
const REAL_WIDGET = join(ROOT, 'mcode-island.ps1');
const REAL_SAFE = join(ROOT, 'scripts', 'lib', 'Safe-Traversal.ps1');
const REAL_TRACKER = join(ROOT, 'scripts', 'lib', 'Session-Tracker.ps1');
const REAL_DETECTOR = join(ROOT, 'mcode-status-detect.ps1');

const WIDGET = join(TMP_PLUGIN, 'mcode-island.ps1');
const SMOKE = join(TMP_PLUGIN, 'scripts', 'smoke.mjs');
const SAFE = join(TMP_PLUGIN, 'scripts', 'lib', 'Safe-Traversal.ps1');
const TRACKER = join(TMP_PLUGIN, 'scripts', 'lib', 'Session-Tracker.ps1');
const DETECTOR = join(TMP_PLUGIN, 'mcode-status-detect.ps1');

const CASES = [
    {
        // 这条守的是"浅色极在**暗**背景下也要读得清"。老模型里浅色极只在
        // 亮背景才成立（对比度只在那半边复算），收敛模型之后两极在所有背景
        // 上都可读，这条不能丢。
        name: 'the pale glass stops being readable over a dark backdrop',
        file: WIDGET,
        find: 'New-GlassStop $white 0.68 ($lift * 0.76)',
        replace: 'New-GlassStop $white 0.68 ($lift * 0.05)',
        expect: 'glass contrast: the light pole drops the secondary text',
    },
    {
        name: 'the dark target grey is too bright -> white text on the glass stops being readable',
        file: WIDGET,
        find: '$script:glassTargetByteDark  = 0.115',
        replace: '$script:glassTargetByteDark  = 0.55',
        expect: 'glass contrast: the dark pole drops the primary text',
    },
    {
        name: 'the dark target is no longer the island black -> the glass reads as a grey plate again',
        file: WIDGET,
        find: '$script:glassTargetByteDark  = 0.115',
        replace: '$script:glassTargetByteDark  = 0.30',
        expect: 'glass convergence: the dark pole target',
    },
    {
        name: 'the light target collapses -> the pale glass stops being readable',
        file: WIDGET,
        find: '$script:glassTargetByteLight = 0.90',
        replace: '$script:glassTargetByteLight = 0.30',
        expect: 'glass contrast: the light pole drops the primary text',
    },
    {
        name: 'the convergence formula is gone -> the glass falls back to a fixed black wash',
        file: WIDGET,
        find: '$veil = 1.0 - ($target / $L)',
        replace: '$veil = 0.85',
        expect: 'glass convergence: the material does not solve for a target grey',
    },
    {
        name: 'the default material is no longer the unified black -> a bright backdrop gets the grey one',
        file: WIDGET,
        find: "materialPole = 'dark'",
        replace: "materialPole = 'auto'",
        expect: 'glass convergence: the default material is not the black glass',
    },
    {
        name: 'light-pole primary ink turned white -> white on a light glass',
        file: WIDGET,
        find: "Primary   = '#D9000000'   # macOS label: 85% 黑",
        replace: "Primary   = '#FFFFFFFF'   # macOS label: 85% 黑",
        expect: 'glass contrast: the light pole drops the primary text',
    },
    {
        name: 'self-exclusion dropped -> the capture blurs the widget itself',
        file: WIDGET,
        find: 'SetWindowDisplayAffinity($hwnd, 0x00000011)',
        replace: 'SetWindowDisplayAffinity($hwnd, 0x00000000)',
        expect: 'glass capture: the widget does not exclude itself',
    },
    {
        name: 'offscreen render without layout -> the blurred backdrop renders black',
        file: WIDGET,
        find: '    $img.Measure((New-Object System.Windows.Size($smallW, $smallH)))\n',
        replace: '',
        expect: 'glass capture: the offscreen image is rendered without a prior Measure/Arrange',
    },
    {
        name: 'shape clip removed -> the corners render square',
        file: WIDGET,
        find: '    $glass.Clip = $geo',
        replace: '    # $glass.Clip = $geo',
        expect: 'glass shape: the glass surface is not clipped by a rounded path',
    },
    {
        name: 'blur radius not scaled for physical pixels -> the pill turns into a flat plate',
        file: WIDGET,
        find: '    $scaleDown = 4',
        replace: '    $scaleDown = 1',
        expect: 'glass blur: the effective blur is',
    },
    {
        name: 'grain turned visible -> the frosted surface turns speckled',
        file: WIDGET,
        find: '$target.Fill = $grain; $target.Opacity = 0.015',
        replace: '$target.Fill = $grain; $target.Opacity = 0.050',
        expect: 'glass grain: the grain opacity is not a small value',
    },
    {
        name: 'state table twin loses a state -> one state keeps the wrong colour on the light pole',
        file: WIDGET,
        find: "  error    = @{ dot='#FFD70015'; ring='#FFD70015'; label='mcode · 出错';       icon='✕' }\n}\n\n$familyMapLight",
        replace: "}\n\n$familyMapLight",
        expect: 'glass colour maps: the state table and its light-pole twin cover different states',
    },
    {
        name: 'two family colours collapsed -> they read as the same colour on the pill',
        file: WIDGET,
        find: "  write  = '#FFA88700'   # edit / write → 琥珀",
        replace: "  write  = '#FF8E8E93'   # edit / write → 琥珀",
        expect: 'glass colour maps: light pole family colours',
    },
    {
        name: 'the thickness factor shadows the typed parameter -> the target grey collapses to zero',
        file: WIDGET,
        find: '$thickMix = $script:glassThickDark',
        replace: '$thick = $script:glassThickDark',
        expect: 'glass convergence: the thickness factor shadows the [bool]$Thick parameter',
    },
    {
        name: 'panel no longer thicker than the pill -> a big panel stays as transparent as the pill',
        file: WIDGET,
        find: '$target = $target * (1.0 - $thickMix)',
        replace: '$target = $target * (1.0 + $thickMix)',
        expect: 'glass depth: the panel is not thicker than the pill',
    },
    {
        name: 'a material layer gets a baked-in colour -> the material stops taking its colour from behind',
        file: WIDGET,
        find: '<Path x:Name="PillTint" Fill="Transparent" Stroke="Transparent"/>',
        replace: '<Path x:Name="PillTint" Fill="#FF99232734" Stroke="Transparent"/>',
        expect: 'glass layers:',
    },
    {
        name: 'the legacy hardcoded tint comes back -> a tinted plate is not glass',
        file: WIDGET,
        find: '<Grid x:Name="PillGlass" Background="#FF16181D">',
        replace: '<Grid x:Name="PillGlass" Background="#99232734">',
        expect: 'glass material: still carries the legacy hardcoded tint',
    },
    {
        name: 'pole hysteresis removed -> the material flickers at the threshold',
        file: WIDGET,
        find: '$script:glassPoleLightOn  = 0.60',
        replace: '$script:glassPoleLightOn  = 0.58',
        expect: 'glass pole: the light switch',
    },
    {
        name: 'the panel loses its own pole -> both surfaces share one polarity',
        file: WIDGET,
        find: "$script:glassPanelPole = 'dark'",
        replace: "$script:glassPanelPole = 'auto'",
        expect: 'glass poles: the panel has no pole of its own',
    },
    {
        name: 'the pole resolver reads the global pole -> the two surfaces flip each other',
        file: WIDGET,
        find: 'param([double]$L, [string]$Current)',
        replace: 'param([double]$L, [string]$Current2)',
        expect: 'glass poles: Resolve-GlassPole reads or writes a global pole',
    },
    {
        name: 'the panel writes the pill pole -> one surface overwrites the other',
        file: WIDGET,
        find: '$script:glassPanelPole = $pole',
        replace: '$script:glassPole = $pole',
        expect: 'glass poles: the material does not pick a pole per surface',
    },
    {
        name: 'the session rows go back to the global ink -> a dark panel gets dark text',
        file: WIDGET,
        find: '  $ink = Get-PanelInk',
        replace: '  $ink = Get-GlassInk',
        expect: 'glass poles: the session rows still take their colours from the global pole',
    },
    {
        name: 'the pill text is coloured from the panel pole -> the pill and the panel fight over one ink set',
        file: WIDGET,
        find: '  $ink = Get-GlassInk\n  try {',
        replace: '  $ink = Get-PanelInk\n  try {',
        expect: 'glass poles: the pill text is coloured from the panel pole',
    },
    {
        name: 'the panel grain follows the pill pole -> one glass body gets the wrong speck colour',
        file: WIDGET,
        find: "Update-GlassGrain 'PanelGrain' $script:glassPanelPole",
        replace: "Update-GlassGrain 'PanelGrain' $script:glassPole",
        expect: 'glass poles: the grain brush is not chosen per surface',
    },
    {
        name: 'the luminance log slot goes back to one shared value -> the panel never gets a brightness line',
        file: WIDGET,
        find: '$script:glassLoggedLum = @{}',
        replace: '$script:glassLoggedLum = $null',
        expect: 'glass poles: the luminance log slot is shared between the two surfaces',
    },
    {
        name: 'the luminance log loses its per-surface key -> both surfaces overwrite one slot again',
        file: WIDGET,
        find: '$null -eq $script:glassLoggedLum[$Prefix] -or [Math]::Abs($L - $script:glassLoggedLum[$Prefix])',
        replace: '$null -eq $script:glassLoggedLum -or [Math]::Abs($L - $script:glassLoggedLum)',
        expect: 'glass poles: the luminance log slot is shared between the two surfaces',
    },
    {
        // 注释没闭合时，旧写法 replace(/<!--[\s\S]*?-->/g,'') 会把没配对的
        // <!-- 原样留下 —— 消毒不完整，注释照样能喂绿后面的断言（CodeQL 的
        // js/incomplete-sanitization 判的就是这个）。新写法必须能判死它。
        name: 'an XML comment is never closed -> the assertions would read a half-deleted source',
        file: WIDGET,
        // 注入点必须在最后一个注释之后：XAML 里的注释是按顺序配对的，
        // 在中间插一个 <!-- 会被后面某个 --> 配上，那就不是"没闭合"了。
        find: '</Window>',
        replace: '  <!-- never closed\n</Window>',
        expect: 'xaml comments: an XML comment in the XAML is never closed',
    },
    {
        name: 'the XAML block cannot be read -> the material assertions would run against nothing',
        file: WIDGET,
        find: "$xaml = @'",
        replace: "$xaml = @#",
        expect: 'xaml read: the XAML block could not be read',
    },
    {
        // 剥离动作本身坏了：断言必须能抓到"标记还在"。
        name: 'the XAML strip stops removing comments -> a comment can feed the material assertions',
        file: SMOKE,
        find: '        keep += s.slice(i, open);',
        replace: '        keep += s.slice(i);',
        expect: 'xaml comments: a comment marker survived the strip',
    },
    {
        // HTML5 里 "--!>" 也是合法的注释结束标记。只认 "-->" 的过滤器会把它
        // 当成没闭合，CodeQL 的 js/bad-html-filtering-regexp 正是判这个。
        name: 'the strip only knows "-->" -> a comment ended by "--!>" stays open',
        file: SMOKE,
        find: '    const m = /--!?>/.exec(s.slice(from));',
        replace: '    const m = /-->/.exec(s.slice(from));',
        expect: 'xaml comments: the strip does not recognise every HTML comment end tag',
    },
    {
        // 结束标记有两个长度（"-->" 3 个字符，"--!>" 4 个），推进量按 3 走会
        // 在 "--!>" 后面多留一个字符。这条就是当时真实犯的那个 bug。
        name: 'the strip advances by the wrong length -> a character survives the comment',
        file: SMOKE,
        find: '        i = close.at + close.len;        // "-->" is 3 chars, "--!>" is 4',
        replace: '        i = close.at + 3;        // "-->" is 3 chars, "--!>" is 4',
        expect: 'xaml comments: the strip does not recognise every HTML comment end tag',
    },
    {
        // 材质层放回 Grid 里：Path 的 DesiredSize 来自 Data 的 Bounds，
        // 也就是"整块玻璃那么大"。于是它参与测量，面板高度被撑到上一轮，
        // 内容变矮时高度不降 —— 黑条只会越来越长。
        name: 'the pill material paths go back into the Grid -> they take part in measuring again',
        file: WIDGET,
        find: '      <Canvas x:Name="PillMaterial">',
        replace: '      <Grid x:Name="PillMaterial">',
        expect: 'glass layout:',
    },
    {
        name: 'the panel material paths go back into the Grid -> the panel height sticks to the previous one',
        file: WIDGET,
        find: '      <Canvas x:Name="PanelMaterial">',
        replace: '      <Grid x:Name="PanelMaterial">',
        expect: 'glass layout:',
    },
    {
        // review 第 4 条要的是"有界的数据"。条数上限管不了文件大小：每条会话
        // 还带着 titles 历史，dismissed 那张表也没有条数上限。写盘前要按字节
        // 砍一遍 —— 这一条把那个砍法去掉，文件就又会长回去。
        name: 'the sessions.json byte cap goes away -> the file grows with the title history',
        file: TRACKER,
        find: "    $json = Limit-SessionsJson $items $script:dismissedSessions $script:MAX_SESSIONS_JSON_BYTES",
        replace: "    $json = [PSCustomObject]@{ sessions = $items; dismissed = $script:dismissedSessions; ts = (Get-Date).ToString('o') } | ConvertTo-Json -Compress -Depth 6",
        expect: 'Write-SessionsFile does not apply the byte cap',
    },    {
        // round-24 review (hetaoBackend)：AllDirectories 会跟着 reparse point
        // 走进 sessions root 之外。盲递归回来，遍历就又不设防了。
        name: 'the tracker goes back to a blind AllDirectories recursion',
        file: TRACKER,
        find: "  foreach ($dir in (Get-SafeSessionEntries -Root $root -Pattern '*session_*')) {",
        replace: "  foreach ($dir in [System.IO.Directory]::EnumerateDirectories($root, '*session_*', 'AllDirectories')) {",
        expect: 'traversal: scripts/lib/Session-Tracker.ps1 still recurse with AllDirectories',
    },
    {
        name: 'the detector goes back to a blind AllDirectories recursion',
        file: DETECTOR,
        find: "  foreach ($f in (Get-SafeSessionEntries -Root $sessionsRoot -Pattern '*.jsonl' -Files)) {",
        replace: "  foreach ($f in [System.IO.Directory]::EnumerateFiles($sessionsRoot, '*.jsonl', 'AllDirectories')) {",
        expect: 'traversal: mcode-status-detect.ps1 still recurse with AllDirectories',
    },
    {
        name: 'the traversal stops rejecting reparse points -> a junction is followed out of the root',
        file: SAFE,
        find: '                if (Test-PathIsReparsePoint $d) { continue }',
        replace: '                if ($false) { continue }',
        expect: 'traversal: scripts/lib/Safe-Traversal.ps1 (it never rejects a reparse point)',
    },
    {
        name: 'the traversal stops checking containment -> a candidate outside the root is opened',
        file: SAFE,
        find: '                if (-not (Test-PathContained $rootFull $d)) { continue }',
        replace: '                if ($false) { continue }',
        expect: 'traversal: scripts/lib/Safe-Traversal.ps1 (it never checks containment)',
    },
    {
        // 键盘可达这条断言有四个分支，每一个都得能被抓住：抓不住就等于没写。
        name: 'the dismiss mark stops being focusable -> Tab can no longer reach it',
        file: WIDGET,
        find: '  $xMark.Focusable = $true',
        replace: '  $xMark.Focusable = $false',
        expect: 'the dismiss mark is not focusable',
    },
    {
        name: 'the keyboard handler is never attached -> Enter and Space do nothing',
        file: WIDGET,
        find: '  $xMark.Add_KeyDown({',
        replace: '  $xMark.Add_KeyDownX({',
        expect: 'the dismiss mark has no keyboard handler',
    },
    {
        name: 'the keyboard handler no longer dismisses -> the row survives the key press',
        file: WIDGET,
        find: '    Dbg ("session dismissed by keyboard: " + $key + " " + $id)\n    Invoke-SessionDismiss $id',
        replace: '    Dbg ("session dismissed by keyboard: " + $key + " " + $id)',
        expect: 'the keyboard handler does not dismiss the row',
    },
    {
        name: 'the keyboard handler drops Space -> half of the keys do nothing',
        file: WIDGET,
        find: "if ($key -ne 'Return' -and $key -ne 'Enter' -and $key -ne 'Space') { return }",
        replace: "if ($key -ne 'Return' -and $key -ne 'Enter') { return }",
        expect: 'the keyboard handler ignores Space',
    },
    {
        name: 'the keyboard handler drops Return -> the main Enter key does nothing',
        file: WIDGET,
        find: "if ($key -ne 'Return' -and $key -ne 'Enter' -and $key -ne 'Space') { return }",
        replace: "if ($key -ne 'Enter' -and $key -ne 'Space') { return }",
        expect: 'the keyboard handler ignores the Enter key',
    },
];

async function runSmoke() {
    try {
        const { stdout } = await exec('node', [SMOKE], { cwd: TMP_PLUGIN, maxBuffer: 64 * 1024 * 1024 });
        return { code: 0, out: stdout };
    } catch (e) {
        return { code: e.code ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
}

// --- the working tree must stay byte-identical while the harness runs ----
//
// The regression test for the ubuntu CI failure: `node --test` runs every
// suite in the repository at once, and a sibling suite that reads a file
// while this harness writes it sees a half-written file. The watch below
// re-reads the working-tree sources for the whole run and fails if any of
// them moved.
const WATCHED = [REAL_WIDGET, REAL_SAFE, REAL_TRACKER, REAL_DETECTOR];
const baseline = new Map();
for (const p of WATCHED) baseline.set(p, await readFile(p, 'utf8'));

let violation = null;
let watching = true;
const watcher = (async () => {
    while (watching) {
        for (const p of WATCHED) {
            let now;
            try {
                now = await readFile(p, 'utf8');
            } catch (e) {
                violation = `${p} (${e.message})`;
                return;
            }
            if (now !== baseline.get(p)) {
                violation = p;
                return;
            }
        }
        await new Promise((r) => setTimeout(r, 20));
    }
})();

let bad = 0;
for (const c of CASES) {
    const original = await readFile(c.file, 'utf8');
    if (!original.includes(c.find)) {
        console.log(`[SKIP] ${c.name} -- anchor not found: ${JSON.stringify(c.find.slice(0, 60))}`);
        bad++;
        continue;
    }
    await writeFile(c.file, original.replace(c.find, c.replace), 'utf8');
    try {
        const res = await runSmoke();
        const hit = res.out.split(/\r?\n/).filter((l) => l.includes(c.expect) && l.includes('FAIL'));
        const otherFails = res.out.split(/\r?\n/).filter((l) => l.startsWith('[FAIL]'));
        if (hit.length === 0) {
            console.log(`[FAIL] ${c.name} -- expected a FAIL on "${c.expect}", got none`);
            console.log(`        other failures: ${otherFails.length ? otherFails.join(' | ') : 'none'}`);
            bad++;
        } else {
            console.log(`[OK  ] ${c.name} -> ${hit[0].trim().slice(0, 150)}`);
        }
    } finally {
        await writeFile(c.file, original, 'utf8');
    }
}

const final = await runSmoke();
const summary = (final.out.match(/summary: .*/) || ['(no summary)'])[0];
const fails = final.out.split(/\r?\n/).filter((l) => l.startsWith('[FAIL]'));
console.log('-'.repeat(60));
console.log(`restored: ${summary}`);
if (fails.length) {
    console.log(`leftover failures:\n${fails.join('\n')}`);
    bad++;
}

watching = false;
await watcher;
if (violation) {
    console.log(`[FAIL] the injection harness never rewrites the working tree -- ${violation} changed while the harness ran`);
    bad++;
} else {
    console.log(`[OK  ] the injection harness never rewrites the working tree`);
}

try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
if (bad) {
    console.log(`INJECTION HARNESS: ${bad} problem(s)`);
    process.exit(1);
}
console.log(`INJECTION HARNESS: all ${CASES.length} injections behaved as expected`);
