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
// It rewrites mcode-island.ps1 while it runs, so keep the working tree clean
// before starting; the file is restored even if the run is interrupted
// between cases (the restore happens in a finally block).

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIDGET = join(ROOT, 'mcode-island.ps1');
const SMOKE = join(ROOT, 'scripts', 'smoke.mjs');

const CASES = [
    {
        name: 'light-pole threshold too low -> light pole would run on a mid backdrop',
        file: WIDGET,
        find: '$script:glassPoleLightOff = 0.58',
        replace: '$script:glassPoleLightOff = 0.30',
        expect: 'glass contrast: the light pole drops the primary text',
    },
    {
        name: 'dark-pole veil cap too low -> the glass stays too bright for white text',
        file: WIDGET,
        find: '$script:glassVeilCap      = 0.72',
        replace: '$script:glassVeilCap      = 0.20',
        expect: 'glass contrast: the dark pole drops the primary text',
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
        name: 'panel no longer thicker than the pill -> a big panel stays as transparent as the pill',
        file: WIDGET,
        find: '$veil = [Math]::Min(0.72, $veil * 1.35 + 0.10)',
        replace: '$veil = [Math]::Min(0.72, $veil * 0.50 + 0.10)',
        expect: 'glass depth: the panel is not tinted heavier than the pill',
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
];

async function runSmoke() {
    try {
        const { stdout } = await exec('node', [SMOKE], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
        return { code: 0, out: stdout };
    } catch (e) {
        return { code: e.code ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
}

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
if (bad) {
    console.log(`INJECTION HARNESS: ${bad} problem(s)`);
    process.exit(1);
}
console.log(`INJECTION HARNESS: all ${CASES.length} injections behaved as expected`);
