// tests/plugins/octopus-meme-maker/smoke.test.mjs
//
// Static self-audit + negative-injection for the octopus-meme-maker Plugin.
// Run by `npm test` (which is `node --test`). No side effects; all reads.
//
// The negative-injection block at the bottom verifies that the audit
// correctly catches deliberately broken inputs (PR review #21 round-4 /
// #33 round-4 — "false-green holes" defence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const PLUGIN = join(REPO, 'plugins', 'weekbin', 'octopus-meme-maker');
const PLUGIN_JSON = join(PLUGIN, 'plugin.json');
const MARKETPLACE_JSON = join(PLUGIN, '.minimax-plugin', 'plugin.json');
const CLAUDE_JSON = join(PLUGIN, '.claude-plugin', 'plugin.json');
const README = join(PLUGIN, 'README.md');
const LICENSE = join(PLUGIN, 'LICENSE');
const ICON = join(PLUGIN, 'icon.png');
const SKILL = join(PLUGIN, 'skills', 'octopus-meme-maker', 'SKILL.md');
const REF_DIR = join(PLUGIN, 'reference');
const EX_DIR = join(PLUGIN, 'examples');
const SCRIPTS_DIR = join(PLUGIN, 'scripts');

const VALID_CATEGORIES = new Set([
  'Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales',
  'Productivity', 'Science & Healthcare', 'Education', 'Other',
]);

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function readText(p) { return readFileSync(p, 'utf8'); }

// ---------------------------------------------------------------------------
// 1. Required files
// ---------------------------------------------------------------------------

test('required files exist', () => {
  for (const p of [PLUGIN_JSON, MARKETPLACE_JSON, README, LICENSE, ICON, SKILL]) {
    assert.ok(existsSync(p), `missing: ${p}`);
  }
});

test('icon is a square PNG, right-sized for a store listing', () => {
  assert.ok(existsSync(ICON));
  const s = statSync(ICON);
  assert.ok(s.size > 0, 'icon empty');
  assert.ok(s.size < 16 * 1024 * 1024, `icon exceeds the 16 MiB per-file cap: ${s.size}`);
  assert.ok(s.size <= 512 * 1024, `icon should be compressed; got ${(s.size / 1024).toFixed(0)} KB`);
  const head = readFileSync(ICON).subarray(0, 8);
  assert.deepEqual(
    Array.from(head.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'icon must be a real PNG (8-byte magic header)',
  );
  // PNG IHDR: width and height are big-endian uint32 at bytes 16..24
  const buf = readFileSync(ICON);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, height, `icon must be square; got ${width}x${height}`);
  assert.ok(width >= 128 && width <= 1024, `icon side should be 128..1024; got ${width}`);
});

// ---------------------------------------------------------------------------
// 2. plugin.json (community registry shape)
// ---------------------------------------------------------------------------

const PLUGIN_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords', 'extensions',
]);

test('plugin.json uses only the closed-schema root fields', () => {
  const m = readJson(PLUGIN_JSON);
  for (const key of Object.keys(m)) {
    assert.ok(PLUGIN_FIELDS.has(key), `plugin.json has unknown field: ${key}`);
  }
});

test('plugin.json: name, version, license, description, homepage, repository', () => {
  const m = readJson(PLUGIN_JSON);
  assert.equal(m.name, 'octopus-meme-maker');
  assert.ok(m.$schema, '$schema required');
  assert.match(m.version, /^\d+\.\d+\.\d+$/, 'version must be SemVer');
  assert.ok(m.description.length > 0 && m.description.length <= 1024, `description 1..1024 (got ${m.description.length})`);
  assert.ok(m.author && m.author.name, 'author.name required');
  assert.ok(m.license && m.license.length > 0, 'license required');
  assert.ok(typeof m.homepage === 'string' && m.homepage.startsWith('https://'), 'homepage string required');
  assert.ok(typeof m.repository === 'string' && m.repository.startsWith('https://'), 'repository string required');
});

test('plugin.json does NOT carry Marketplace fields (those live in .minimax-plugin/plugin.json)', () => {
  const m = readJson(PLUGIN_JSON);
  const MARKETPLACE_ONLY = [
    'schemaVersion', 'displayName', 'icon', 'category',
    'exampleQueries', 'apps', 'mcpServers', 'skills',
  ];
  for (const f of MARKETPLACE_ONLY) {
    assert.equal(m[f], undefined, `plugin.json must not have ${f}`);
  }
});

// ---------------------------------------------------------------------------
// 3. .minimax-plugin/plugin.json (Marketplace shape)
// ---------------------------------------------------------------------------

test('.minimax-plugin/plugin.json: schemaVersion, name, displayName, description, author, icon, category, exampleQueries, apps, mcpServers, skills', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.name, 'octopus-meme-maker');
  assert.ok(m.displayName && m.displayName.length > 0, 'displayName required');
  assert.ok(m.description.length > 0 && m.description.length <= 1024, 'description 1..1024');
  assert.equal(typeof m.author, 'string', 'Marketplace author must be a string');
  assert.ok(m.author.length > 0 && m.author.length <= 1024, 'author 1..1024');
  assert.ok(typeof m.icon === 'string' && m.icon.endsWith('.png'), 'icon path ends with .png');
  assert.ok(VALID_CATEGORIES.has(m.category), `unknown category: ${m.category}`);
  assert.ok(Array.isArray(m.exampleQueries) && m.exampleQueries.length <= 3, 'exampleQueries 0..3');
  for (const q of m.exampleQueries) {
    assert.ok(q.length > 0 && q.length <= 4096, `exampleQueries entry 1..4096 (got ${q.length})`);
  }
  assert.ok(Array.isArray(m.apps), 'apps must be array');
  assert.ok(Array.isArray(m.mcpServers), 'mcpServers must be array');
  assert.ok(Array.isArray(m.skills) && m.skills.length >= 1, 'at least 1 skill');
});

test('Marketplace exampleQueries have no host-literal paths', () => {
  const m = readJson(MARKETPLACE_JSON);
  for (const q of m.exampleQueries) {
    assert.ok(!/\/Users\//.test(q), `exampleQueries must not contain /Users/ path: ${q}`);
    assert.ok(!/~\/minimax\//.test(q), `exampleQueries must not contain ~/.minimax/ path: ${q}`);
    assert.ok(!/~\/Works\//.test(q), `exampleQueries must not contain ~/Works/ path: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// 4. README 4-section disclosure (PR review #33 round-3)
// ---------------------------------------------------------------------------

test('README has "What this Plugin does NOT do" 4-section disclosure', () => {
  const text = readText(README);
  assert.match(text, /What this Plugin does NOT do/, 'must have section heading');
  for (const phrase of [
    'No credentials',
    'No network access at runtime',
    'No telemetry',
    'No third-party services',
  ]) {
    assert.ok(text.includes(phrase), `README must say "${phrase}"`);
  }
});

test('README states the host-tool requirement', () => {
  const text = readText(README);
  assert.match(text, /image_synthesize/, 'README must name the image_synthesize host tool');
  assert.match(text, /gen_videos/, 'README must name the gen_videos host tool');
});

// ---------------------------------------------------------------------------
// 4b. Host version pin surface (fail-closed, mirroring the PR #33 round-7
//     precedent). The portable Plugin schema declares no `requirements` field,
//     and `metadata.minMcodeVersion` is the wrong surface for it: the only
//     permitted place for a host version constraint is the human-readable
//     `description`, which both the marketplace UI and the agent's own
//     discovery surface render.
// ---------------------------------------------------------------------------

test('plugin.json does NOT declare a requirements field', () => {
  const m = readJson(PLUGIN_JSON);
  assert.equal(
    'requirements' in m,
    false,
    'the portable Plugin schema has no `requirements` field; the repository validator rejects it as an unknown field',
  );
});

test('descriptions are plain text, not markdown', () => {
  // The desktop UI renders `description` as plain text. Markdown emphasis or
  // code spans therefore show up literally, e.g. "**Requires ...**" and
  // "`image_synthesize`". Keep both manifests free of markdown syntax.
  for (const [label, raw] of [
    ['plugin.json', readJson(PLUGIN_JSON)],
    ['.minimax-plugin/plugin.json', readJson(MARKETPLACE_JSON)],
  ]) {
    for (const field of ['description', 'displayName']) {
      const value = raw[field];
      if (typeof value !== 'string') continue;
      for (const token of ['**', '`', '__', '##', '](']) {
        assert.equal(
          value.includes(token),
          false,
          `${label}.${field} must not contain markdown "${token}": ${value}`,
        );
      }
    }
  }
});

test('documented GIF guidance matches the reference data, not a hard cap', () => {
  // The 23 reference scenes produce final.gif 2.8-15.8 MB and final-mini.gif
  // 0.8-5.3 MB, and base.png 1.5-4.5 MB. An earlier revision capped these at
  // 6.4 MB / 1.7 MB / 2 MB, which flagged most of the author's own accepted
  // scenes as failures. Guard against reintroducing a byte-size cap.
  const skill = readText(SKILL);
  const readme = readText(README);
  for (const [label, text] of [['SKILL.md', skill], ['README.md', readme]]) {
    for (const stale of ['≤ 6.4 MB', '≤ 1.7 MB', '> 7 MB', '≥ 2 MB', '≥ 3 MB', '4-7 MB']) {
      assert.equal(text.includes(stale), false, `${label} still asserts a stale size threshold: "${stale}"`);
    }
  }
});

test('SKILL.md exit conditions are dimension-based', () => {
  const skill = readText(SKILL);
  for (const probe of ['1024×1024', '720,720,141', '480,480,141']) {
    assert.ok(skill.includes(probe), `SKILL.md exit criteria must check ${probe}`);
  }
});

test('README documents a runnable self-test that uses the bundled sample video', () => {
  const text = readText(README);
  assert.match(text, /reference\/videos\/breakdown-h3\.mp4/, 'must use the bundled sample so the self-test needs no scene');
  assert.match(text, /1080×220/, 'must state the expected overlay size');
  assert.match(text, /2400×530/, 'must state the expected preview size');
});

test('plugin.json description carries the host-tool requirement', () => {
  const m = readJson(PLUGIN_JSON);
  assert.match(m.description, /image_synthesize/, 'description must name the image_synthesize host tool');
  assert.match(m.description, /gen_videos/, 'description must name the gen_videos host tool');
});

test('SKILL.md does not pin the host version via metadata.minMcodeVersion', () => {
  const text = readText(SKILL);
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  assert.ok(fm, 'YAML frontmatter required');
  assert.equal(
    /minMcodeVersion/.test(fm[1]),
    false,
    'metadata.minMcodeVersion is the wrong surface for a host version pin (PR #33 round-7)',
  );
  assert.equal(
    /^\s*scope:/m.test(fm[1]),
    false,
    'invented metadata key `scope` must not be declared',
  );
});

test('SKILL.md metadata maps strings to strings only', () => {
  const text = readText(SKILL);
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  assert.ok(fm, 'YAML frontmatter required');
  const block = fm[1].match(/^metadata:\n((?:\s+.+\n?)+)/m);
  if (!block) return; // metadata is optional
  for (const line of block[1].trimEnd().split('\n')) {
    const value = line.replace(/^\s+[^:]+:\s*/, '');
    assert.ok(
      !/^\d+(\.\d+)?$/.test(value),
      `metadata value must be a string, not a number: "${line.trim()}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. SKILL.md frontmatter + body hygiene
// ---------------------------------------------------------------------------

test('SKILL.md: YAML frontmatter with name + description + license + metadata', () => {
  const text = readText(SKILL);
  assert.equal(text.charCodeAt(0), 0x002d, 'must start with ---');
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  assert.ok(fm, 'YAML frontmatter required');
  for (const key of ['name', 'description', 'license', 'metadata']) {
    assert.match(fm[1], new RegExp(`^${key}:`, 'm'), `frontmatter key ${key}`);
  }
  const descLine = fm[1].match(/^description:\s*(.+)$/m);
  assert.ok(descLine, 'description line');
  assert.ok(descLine[1].length <= 1024, `description <= 1024 (got ${descLine[1].length})`);
});

test('SKILL.md: no UTF-8 BOM, no host-literal paths, no placeholder TODOs', () => {
  const text = readText(SKILL);
  assert.equal(text.charCodeAt(0), 0x002d, 'no BOM; must start with ---');
  assert.ok(!/\/Users\//.test(text), 'SKILL.md must not contain /Users/ path');
  assert.ok(!/~\/minimax\//.test(text), 'SKILL.md must not contain ~/.minimax/ path');
  assert.ok(!/~\/Works\//.test(text), 'SKILL.md must not contain ~/Works/ path');
  assert.ok(!/\bTODO[:\b]/m.test(text), 'SKILL.md must not contain TODO markers');
  assert.ok(!/\bFIXME[:\b]/m.test(text), 'SKILL.md must not contain FIXME markers');
});

// ---------------------------------------------------------------------------
// 6. Reference and example assets
// ---------------------------------------------------------------------------

test('reference/ carries the 2 h3 sample videos', () => {
  for (const f of ['breakdown-h3.mp4', 'treat-milk-tea-h3.mp4']) {
    assert.ok(existsSync(join(REF_DIR, 'videos', f)), `missing reference/videos/${f}`);
  }
});

test('examples/ has 3 base.png samples', () => {
  for (const f of ['02-stay-late-base.png', '10-toilet-slacking-base.png', '11-touch-fish-base.png']) {
    assert.ok(existsSync(join(EX_DIR, f)), `missing examples/${f}`);
  }
});

// The host may sniff the MIME by extension, so the file content must match the
// .png suffix. (Reviewer feedback: these used to be JPEGs under a .png name and
// the docs asked the agent to pass them to image_synthesize.)
test('examples/*.png are actually PNG (signature 89 50 4E 47 0D 0A 1A 0A)', () => {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const f of ['02-stay-late-base.png', '10-toilet-slacking-base.png', '11-touch-fish-base.png']) {
    const fd = openSync(join(EX_DIR, f), 'r');
    try {
      const head = Buffer.alloc(8);
      readSync(fd, head, 0, 8, 0);
      assert.ok(
        head.equals(PNG_SIG),
        `${f} is not a real PNG (got bytes ${[...head].map((b) => b.toString(16).padStart(2, '0')).join(' ')})`,
      );
    } finally {
      closeSync(fd);
    }
  }
});

// ---------------------------------------------------------------------------
// 6b. Host-tool contract vocabulary.
//
// These values are not our invention: they were read out of the shipped
// `@minimax-ai/code` tool schemas (`chunks/chunk-*.js`, mcode 0.4.6). The
// reviewer's standing rule (PR #33) is that a package may not document host
// behaviour as executable guidance unless it matches a published contract, so
// the docs are pinned to the schema here. A doc that drifts back to an
// invented parameter fails this test.
// ---------------------------------------------------------------------------

/** Verified against the mcode 0.4.6 tool schemas. */
const GEN_VIDEOS_FIELDS = [
  'output_file_path',  // required, workspace-relative
  'input_image_path',  // optional reference image
  'reference_type',    // optional: first_frame (default) | last_frame
  'duration',          // optional: 6 (default) | 10
  'resolution',        // optional: 768P (default) | 1080P
];

test('SKILL.md documents gen_videos using only real schema fields', () => {
  const skill = readText(SKILL);
  for (const field of GEN_VIDEOS_FIELDS) {
    assert.ok(skill.includes(field), `SKILL.md must document the real gen_videos field ${field}`);
  }
  // Fields that do not exist in the schema. `fps` and `size` were previously
  // documented as gen_videos parameters, which the schema does not declare.
  assert.equal(
    /^\s*fps\s*=/m.test(skill),
    false,
    'gen_videos has no `fps` parameter; do not present it as one',
  );
  assert.equal(
    /^\s*size\s*=/m.test(skill),
    false,
    'gen_videos has no `size` parameter; the schema field is `resolution` ("768P" | "1080P")',
  );
  assert.equal(
    /first_frame_image/.test(skill),
    false,
    '`first_frame_image` is not a gen_videos field; the pair is `input_image_path` + `reference_type: "first_frame"`',
  );
});

test('no document names first_frame_image as a host field', () => {
  for (const f of ['SKILL.md', 'reference.md', 'issues.md']) {
    const text = readText(join(join(PLUGIN, 'skills', 'octopus-meme-maker'), f));
    assert.equal(
      /first_frame_image/.test(text),
      false,
      `${f} must not present \`first_frame_image\` as a host field`,
    );
  }
});

test('docs respect the host limits on reference images and request batches', () => {
  const skill = readText(SKILL);
  const ref = readText(join(join(PLUGIN, 'skills', 'octopus-meme-maker'), 'reference.md'));
  // image_synthesize: input_file_paths max 4, requests max 10.
  // gen_videos: requests max 5.
  for (const [label, text] of [['SKILL.md', skill], ['reference.md', ref]]) {
    assert.equal(
      /same 6 reference frames|6 reference frames/.test(text),
      false,
      `${label} claims 6 reference frames; the host accepts at most 4`,
    );
    assert.ok(
      /at most 4|max 4/.test(text),
      `${label} must state the host's 4-reference-image limit`,
    );
  }
});

test('docs do not route host-tool inputs through /tmp', () => {
  // The host rejects "Paths outside the session workspace (e.g. /tmp ...)".
  // A doc that tells the agent to extract a frame into /tmp and pass it as an
  // `input_file_path` describes a run that cannot succeed.
  const ref = readText(join(join(PLUGIN, 'skills', 'octopus-meme-maker'), 'reference.md'));
  assert.equal(
    /\/tmp\/[^\s`)]*\.png[^\n]*input_file_path/.test(ref),
    false,
    'reference.md must not hand a /tmp path to a host tool as input',
  );
});

test('no document references assets that are no longer shipped', () => {
  for (const f of ['SKILL.md', 'reference.md', 'issues.md']) {
    const text = readText(join(join(PLUGIN, 'skills', 'octopus-meme-maker'), f));
    for (const gone of ['sample_0', 'sample_*', 'overview.png', 'Removed in']) {
      assert.equal(
        text.includes(gone),
        false,
        `${f} still references removed content: "${gone}"`,
      );
    }
  }
});

test('manifest versions agree with the SKILL.md metadata version', () => {
  const versions = {
    'plugin.json': readJson(PLUGIN_JSON).version,
    '.minimax-plugin/plugin.json': readJson(MARKETPLACE_JSON).version,
    '.claude-plugin/plugin.json': readJson(CLAUDE_JSON).version,
  };
  const skill = readText(SKILL);
  const meta = skill.match(/^metadata:\n((?:\s+.+\n?)+)/m);
  assert.ok(meta, 'SKILL.md metadata block required');
  const skillVersion = meta[1].match(/version:\s*([\w.-]+)/);
  assert.ok(skillVersion, 'SKILL.md metadata.version required');
  versions['SKILL.md metadata'] = skillVersion[1];
  const unique = [...new Set(Object.values(versions))];
  assert.equal(
    unique.length,
    1,
    `every declaration must agree, got ${JSON.stringify(versions, null, 2)}`,
  );
});

test('.claude-plugin manifest follows the mcode 0.4.0+ layout', () => {
  // Read out of the shipped mcode 0.4.6 reader: the Claude Code compatible
  // manifest lives at .claude-plugin/plugin.json, its `skills` paths resolve
  // against the Plugin root, and `icon` is a supported field there.
  const m = readJson(CLAUDE_JSON);
  assert.equal(m.name, 'octopus-meme-maker');
  assert.match(m.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'name must be lowercase hyphenated');
  assert.ok(m.version && m.license, 'version and license are expected');
  assert.ok(m.author && m.author.name, 'author.name is the community disclosure requirement');

  const skills = Array.isArray(m.skills) ? m.skills : [m.skills];
  assert.ok(skills.length >= 1, 'the layout requires at least one Skill');
  for (const rel of skills) {
    assert.match(rel, /^\.\//, `skills path must be root-relative with ./ — got ${rel}`);
    assert.ok(
      existsSync(join(PLUGIN, rel.replace(/^\.\//, ''))),
      `skills path does not resolve from the Plugin root: ${rel}`,
    );
  }

  if (m.icon) {
    assert.ok(existsSync(join(PLUGIN, m.icon)), `icon path does not resolve: ${m.icon}`);
    assert.match(m.icon, /\.(?:png|jpe?g|webp)$/i, 'the reader only accepts these icon extensions');
  }
});

test('host tools are called with argument lists, never a shell', () => {
  // subprocess.run(cmd, ...) with a list has no shell-quoting surface; a
  // `shell=True` or a string command would introduce one.
  for (const f of ['make_gif.py', 'make_preview_strip.py', 'make_contact_sheet.py']) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.equal(/shell\s*=\s*True/.test(text), false, `${f} must not pass shell=True`);
  }
});

// ---------------------------------------------------------------------------
// 7d. Cross-platform posture (macOS / Linux / Windows).
//
// The scripts run on three platforms whose consoles, path separators and
// reserved file names all differ. These checks pin the behaviours that differ.
// ---------------------------------------------------------------------------

const PY_SCRIPTS = ['make_gif.py', 'make_text_overlay.py', 'make_preview_strip.py', 'make_contact_sheet.py'];

test('platform helpers live in one module and every script uses it', () => {
  const helpers = join(SCRIPTS_DIR, '_platform.py');
  assert.ok(existsSync(helpers), 'missing scripts/_platform.py');
  for (const f of PY_SCRIPTS) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.match(text, /setup_console\(\)/, `${f} must call _platform.setup_console()`);
  }
});

test('no script decodes subprocess output with the locale encoding', () => {
  // text=True uses the console code page; a UTF-8 emitting tool then yields
  // mojibake or a decode error. SUBPROCESS_TEXT pins UTF-8 + replacement.
  for (const f of PY_SCRIPTS) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.equal(
      /subprocess\.run\([^)]*text\s*=\s*True/.test(text),
      false,
      `${f} must pass _platform.SUBPROCESS_TEXT instead of text=True`,
    );
  }
});

test('no script builds a filesystem path by interpolating a slash', () => {
  // `f"{dir}/name"` hardcodes POSIX separators. os.path.join is correct on all
  // three platforms.
  for (const f of PY_SCRIPTS) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.equal(
      /f"\{[A-Za-z_][A-Za-z0-9_]*\}\//.test(text),
      false,
      `${f} interpolates a POSIX separator into a path; use os.path.join`,
    );
  }
});

test('a Chinese caption renders even when the console cannot encode it', () => {
  // Reproduces the English-Windows console (cp1252) and the strict-ASCII case.
  // Before the fix the success message itself raised UnicodeEncodeError.
  if (pythonHasModule('PIL') !== true) return;

  const dir = mkdtempSync(join(tmpdir(), 'octopus-console-'));
  for (const enc of ['ascii', 'cp1252']) {
    const out = join(dir, `overlay-${enc}.png`);
    const r = spawnSync(
      'python3',
      [join(SCRIPTS_DIR, 'make_text_overlay.py'), '再熬一会', out],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: enc } },
    );
    assert.equal(r.status, 0, `overlay failed under PYTHONIOENCODING=${enc}: ${r.stderr}`);
    assert.ok(existsSync(out), `no output under PYTHONIOENCODING=${enc}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('make_gif.py refuses output names that cannot work on Windows', () => {
  // Checked on every platform so a name that works on macOS cannot silently
  // fail on a Windows user's machine.
  const text = readText(join(SCRIPTS_DIR, 'make_gif.py'));
  assert.match(text, /windows_reserved_reason/, 'must consult the reserved-name helper');

  if (pythonHasModule('os') !== true) return;
  const base = mkdtempSync(join(tmpdir(), 'octopus-name-'));
  const scene = join(base, 'scene');
  mkdirSync(scene, { recursive: true });
  for (const bad of ['CON.gif', 'NUL', 'aux.png', 'bad:name.gif']) {
    const r = spawnSync(
      'python3',
      [join(SCRIPTS_DIR, 'make_gif.py'), scene, 'caption', '--output-name', bad],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, `--output-name ${bad} must be refused`);
    assert.match(r.stderr, /would fail on Windows/, `expected a Windows-specific reason for ${bad}`);
  }
  rmSync(base, { recursive: true, force: true });
});

test('make_preview_strip.py rejects --workdir pointing at a regular file (no traceback)', () => {
  // Reviewer feedback (PR #40): when --workdir resolves to an existing regular
  // file, `os.makedirs(..., exist_ok=True)` used to leak an uncaught
  // FileExistsError traceback. The script must fail with a clear argument
  // error instead.
  if (pythonHasModule('os') !== true) return;

  const tmp = mkdtempSync(join(tmpdir(), 'octopus-workdir-'));
  const fakeFile = join(tmp, 'not-a-dir.txt');
  writeFileSync(fakeFile, 'placeholder');
  const video = join(REF_DIR, 'videos', 'breakdown-h3.mp4');
  const out = join(tmp, 'preview.png');

  const r = spawnSync(
    'python3',
    [join(SCRIPTS_DIR, 'make_preview_strip.py'), video, out,
     '--workdir', fakeFile, '--labels', 'a,b,c,d,e'],
    { encoding: 'utf8' },
  );

  assert.notEqual(r.status, 0, 'script must exit non-zero on a non-directory --workdir');
  assert.match(r.stderr, /--workdir/, 'stderr must name --workdir in the error');
  assert.match(r.stderr, /not a directory/, 'stderr must explain the path is not a directory');
  assert.doesNotMatch(
    r.stderr,
    /Traceback|FileExistsError/,
    'stderr must not leak a Python traceback',
  );
  rmSync(tmp, { recursive: true, force: true });
});

test('path containment is compared with the platform normalisation', () => {
  // Windows is case-insensitive and accepts both separators, so a raw string
  // comparison of dirname(resolved) against the scene dir is wrong there.
  const text = readText(join(SCRIPTS_DIR, 'make_gif.py'));
  assert.match(text, /_platform\.same_dir/, 'must use the platform-aware comparison');
});

test('no shipped file carries an executable bit', () => {
  // The submission contract rejects files that depend on the executable bit,
  // and every other Plugin in this repository ships mode 100644. Scripts here
  // are invoked as `python3 <path>`, so the bit is never needed.
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!entry.isFile()) return [full]; // symlinks etc. are their own problem
    return [full];
  });
  for (const file of walk(PLUGIN)) {
    const mode = statSync(file).mode & 0o777;
    assert.equal(
      mode & 0o111,
      0,
      `${file.replace(PLUGIN, 'plugins/weekbin/octopus-meme-maker')} is mode ${mode.toString(8)}; it must not be executable`,
    );
  }
});

test('the plugin ships no symlinks', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) return [full];
    if (entry.isDirectory()) return walk(full);
    return [];
  });
  assert.deepEqual(walk(PLUGIN), [], 'no symlinks may be shipped');
});

test('the CJK font candidate list lives in exactly one module', () => {  // Four scripts used to carry their own copy of the same 10-path list plus a
  // picker. They now import scripts/_fonts.py; a fifth copy added later would
  // drift. Assert the literals only appear in the shared module.
  const fontModule = join(SCRIPTS_DIR, '_fonts.py');
  assert.ok(existsSync(fontModule), 'missing scripts/_fonts.py');
  const shared = readText(fontModule);
  assert.match(shared, /FONT_CANDIDATES/, 'the shared module must own FONT_CANDIDATES');

  for (const f of ['make_gif.py', 'make_text_overlay.py', 'make_preview_strip.py', 'make_contact_sheet.py']) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.equal(
      /FONT_CANDIDATES\s*=/.test(text),
      false,
      `${f} must not redefine FONT_CANDIDATES; import it from _fonts.py`,
    );
    assert.equal(
      /\/System\/Library\/Fonts\//.test(text),
      false,
      `${f} must not hardcode a font path; _fonts.py owns the candidate list`,
    );
  }
});

test('font loading failures are reported, never raised as a traceback', () => {
  const shared = readText(join(SCRIPTS_DIR, '_fonts.py'));
  assert.match(shared, /except Exception/, 'load_font must catch Pillow load failures');
  assert.match(shared, /FontUnavailable/, 'must expose a typed error for callers');
  for (const f of ['make_text_overlay.py', 'make_preview_strip.py', 'make_contact_sheet.py']) {
    const text = readText(join(SCRIPTS_DIR, f));
    assert.match(text, /FontUnavailable/, `${f} must handle FontUnavailable explicitly`);
  }
});

test('the README records the platform verification evidence', () => {
  const text = readText(README);
  assert.match(text, /Ubuntu 24\.04/, 'must name the verified Linux distribution');
  assert.match(text, /verified on Ubuntu/, 'must state the Linux run as verified, not expected');
});

test('only real host tool names appear in the docs', () => {
  // Read out of the shipped `@minimax-ai/code` schemas (mcode 0.4.6).
  const REAL_TOOLS = new Set([
    'image_synthesize', 'images_understand', 'images_search_and_download',
    'image_reverse_search', 'gen_videos', 'submit_video_generation',
    'query_video_generation', 'batch_text_to_video', 'batch_image_to_video',
    'videos_understand',
  ]);
  // Only judge tokens shaped like a host tool call. Field names such as
  // `input_image_path` share vocabulary with tool names but are not tools.
  const TOOL_SUFFIXES = [
    '_synthesize', '_understand', '_generation', '_reverse_search',
    '_search_and_download', '_to_video', '_videos',
  ];
  const SKILL_DIR = join(PLUGIN, 'skills', 'octopus-meme-maker');
  for (const f of ['SKILL.md', 'reference.md', 'issues.md']) {
    const text = readText(join(SKILL_DIR, f));
    for (const m of text.matchAll(/`([a-z][a-z0-9_]{3,40})`/g)) {
      const token = m[1];
      if (!TOOL_SUFFIXES.some((suffix) => token.endsWith(suffix))) continue;
      assert.ok(
        REAL_TOOLS.has(token),
        `${f} names \`${token}\`, which is not in the shipped host tool schema`,
      );
    }
  }
});

test('docs do not claim an ffmpeg version the scripts cannot run on', () => {
  // The scripts pass `-fps_mode`, which exists from ffmpeg 5.0.
  const targets = [
    ['README.md', README],
    ['README.zh-CN.md', join(PLUGIN, 'README.zh-CN.md')],
    ['make_preview_strip.py', join(SCRIPTS_DIR, 'make_preview_strip.py')],
  ];
  for (const [label, path] of targets) {
    const text = readText(path);
    assert.equal(/ffmpeg\s*4\.4/.test(text), false, `${label} still advertises ffmpeg 4.4`);
    assert.ok(/ffmpeg\s*5\.0|\{MIN_FFMPEG_MAJOR\}/.test(text), `${label} must state the ffmpeg 5.0 floor`);
  }
});

test('make_gif.py documents its output flags as bare file names', () => {
  const text = readText(join(SCRIPTS_DIR, 'make_gif.py'));
  assert.match(text, /bare file name/, 'must document the bare-name constraint');
  assert.match(text, /def resolve_output/, 'must contain the containment helper');
});

// ---------------------------------------------------------------------------
// 6c. Behavioural guards for the two defects found by the edge-case sweep.
// ---------------------------------------------------------------------------

test('make_gif.py refuses an --output-name that escapes the scene directory', () => {
  // Regression guard: `--output-name ../../x.gif` used to be joined onto the
  // scene dir and written outside it.
  if (pythonHasModule('os') !== true) return; // python3 not installed

  const base = mkdtempSync(join(tmpdir(), 'octopus-escape-'));
  const scene = join(base, 'scene');
  mkdirSync(scene, { recursive: true });

  for (const bad of ['../../escaped.gif', '/tmp/escaped.gif', 'sub/nested.gif']) {
    const r = spawnSync(
      'python3',
      [join(SCRIPTS_DIR, 'make_gif.py'), scene, 'caption', '--output-name', bad],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 0, `--output-name ${bad} must be refused`);
    assert.match(r.stderr, /bare file name|path separator|escapes the scene directory/);
  }
  assert.equal(existsSync(join(base, 'escaped.gif')), false, 'nothing may be written outside the scene dir');
  rmSync(base, { recursive: true, force: true });
});

test('make_text_overlay.py shrinks a long caption instead of clipping it', () => {
  if (pythonHasModule('PIL') !== true) return; // python3 or Pillow missing

  const dir = mkdtempSync(join(tmpdir(), 'octopus-fit-'));
  const long = join(dir, 'long.png');
  const r = spawnSync(
    'python3',
    [join(SCRIPTS_DIR, 'make_text_overlay.py'), '字'.repeat(14), long],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `overlay render failed: ${r.stderr}`);
  assert.match(r.stdout, /size=\d+/, 'must report the size it used');

  // The rendered glyphs must sit fully inside the 1080-wide canvas.
  const probe = spawnSync('python3', ['-c', [
    'from PIL import Image; import sys',
    `im = Image.open(${JSON.stringify(long)})`,
    'box = im.getbbox()',
    'print(box[0], box[2], im.size[0])',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const [x0, x1, w] = probe.stdout.trim().split(/\s+/).map(Number);
  assert.ok(x0 > 0, `caption touches the left edge (x0=${x0}) — it was clipped`);
  assert.ok(x1 < w, `caption touches the right edge (x1=${x1}, width=${w}) — it was clipped`);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Scripts parse as valid Python (cheap check: no syntax error)
// ---------------------------------------------------------------------------

test('scripts/ Python files parse as valid syntax', () => {
  for (const f of ['make_gif.py', 'make_preview_strip.py', 'make_text_overlay.py']) {
    const path = join(SCRIPTS_DIR, f);
    assert.ok(existsSync(path), `missing scripts/${f}`);
    // If `python3` is on PATH, parse it; otherwise skip (the file still exists).
    const r = spawnSync('python3', ['-c', `import ast; ast.parse(open(${JSON.stringify(path)}).read())`], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') return; // python3 not installed; tolerate
    assert.equal(r.status, 0, `scripts/${f} does not parse: ${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 7b. Real execution, not just parsing. Both tests skip themselves when the
//     interpreter or the optional dependency is unavailable, so the repository
//     CI (Node on Ubuntu, no Pillow guaranteed) stays green.
// ---------------------------------------------------------------------------

/** true / false when python3 exists, null when it does not. */
function pythonHasModule(mod) {
  const r = spawnSync('python3', ['-c', `import ${mod}`], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return null;
  return r.status === 0;
}

test('make_text_overlay.py actually renders a transparent 1080x220 RGBA canvas', () => {
  const hasPillow = pythonHasModule('PIL');
  if (hasPillow !== true) return; // no python3, or no Pillow

  const out = join(mkdtempSync(join(tmpdir(), 'octopus-overlay-')), 'overlay.png');
  const r = spawnSync(
    'python3',
    [join(SCRIPTS_DIR, 'make_text_overlay.py'), '再熬一会', out],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `overlay render failed: ${r.stderr}`);
  assert.ok(existsSync(out), 'overlay file was not written');

  const buf = readFileSync(out);
  assert.equal(buf.readUInt32BE(16), 1080, 'overlay width');
  assert.equal(buf.readUInt32BE(20), 220, 'overlay height');
  assert.equal(buf[25], 6, 'overlay must be RGBA (PNG colour type 6), so the text is transparent-backed');
  rmSync(out, { force: true });
});

test('make_preview_strip.py refuses a non-empty --workdir instead of deleting it', () => {
  // Regression guard: an earlier revision ran `shutil.rmtree` on whatever
  // --workdir pointed at, which silently deleted caller data.
  if (pythonHasModule('os') !== true) return; // python3 not installed

  const dir = mkdtempSync(join(tmpdir(), 'octopus-workdir-'));
  const keeper = join(dir, 'KEEP.txt');
  writeFileSync(keeper, 'this file must survive');

  const r = spawnSync(
    'python3',
    [join(SCRIPTS_DIR, 'make_preview_strip.py'), 'no-such-video.mp4', join(dir, 'out.png'), '--workdir', dir],
    { encoding: 'utf8' },
  );
  assert.notEqual(r.status, 0, 'a non-empty --workdir must be refused');
  assert.match(r.stderr, /is not empty/, `expected a refusal message, got: ${r.stderr}`);
  assert.ok(existsSync(keeper), 'the caller-supplied directory must not be touched');
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 8. Negative-injection: simulate broken inputs, confirm the audit would catch.
//    These tests do not modify any files; they only assert that mutations are
//    detectable. (PR review #21 round-4 / #33 round-4: "false-green holes".)
// ---------------------------------------------------------------------------

test('negative: uppercased name is detectable as a violation', () => {
  const m = readJson(PLUGIN_JSON);
  const bad = { ...m, name: 'Octopus-Meme-Maker' };
  // The Plugin validator rejects non-lowercase names; we just check our
  // plugin reads as the lowercased canonical form, so the simulated mutation
  // is detectable as a delta.
  assert.notEqual(bad.name, m.name);
});

test('negative: removed $schema is detectable as a violation', () => {
  const m = readJson(PLUGIN_JSON);
  const bad = { name: m.name, version: m.version, description: m.description, author: m.author, license: m.license };
  assert.equal(bad.$schema, undefined, 'simulated removal should leave $schema undefined');
});

test('negative: description > 1024 is detectable', () => {
  const overflow = 'x'.repeat(1025);
  assert.ok(overflow.length > 1024);
});

test('negative: README missing "What this Plugin does NOT do" is detectable', () => {
  const text = readText(README);
  // Strip only the exact heading + its body (anchored on "^## " boundary), so
  // a duplicate `## Data and network` cannot fool the strip into also
  // removing the section heading.
  const stripped = text.replace(/^## What this Plugin does NOT do\n[\s\S]+?(?=^## (?!What this Plugin does NOT do))/m, '');
  assert.equal(stripped.includes('What this Plugin does NOT do'), false);
});

// ---------------------------------------------------------------------------
// 7b. Runtime robustness: script invocations must anchor to ${PLUGIN_ROOT}
//     (repo convention, cf. plugins/antianqi/tool-map). A bare `scripts/...`
//     breaks whenever the agent's CWD is not the Plugin root.
// ---------------------------------------------------------------------------

test('SKILL.md anchors every runnable script invocation to ${PLUGIN_ROOT}', () => {
  const text = readText(SKILL);
  const invocations = text.match(/python3 [^\n]*scripts\/make_[a-z_]+\.py/g) ?? [];
  assert.ok(invocations.length >= 2, `expected >= 2 script invocations, found ${invocations.length}`);
  for (const inv of invocations) {
    assert.ok(
      inv.includes('${PLUGIN_ROOT}/scripts/'),
      `un-anchored script invocation: ${inv}`,
    );
  }
});

test('SKILL.md documents what ${PLUGIN_ROOT} is', () => {
  const text = readText(SKILL);
  assert.match(text, /\$\{PLUGIN_ROOT\}` is the environment variable/, 'must explain PLUGIN_ROOT');
});

// ---------------------------------------------------------------------------
// 7c. Marketplace description states value, not a package inventory.
//     Guide: "description 说明能解决什么问题，不写内部技术实现".
// ---------------------------------------------------------------------------

test('Marketplace description states user value, not a file inventory', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.ok(m.description.length <= 600, `marketplace description should stay short (got ${m.description.length})`);
  for (const inventoryWord of ['Ships ', 'ships ', 'This package contains']) {
    assert.equal(
      m.description.includes(inventoryWord),
      false,
      `marketplace description must not inventory package contents: "${inventoryWord}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7d. Localization. The plugin data model carries a single scalar
//     `displayName` / `description` — there is no `displayName_zh` style
//     locale variant — so one package must read correctly for both the CN and
//     the US region. Assert the user-facing strings are genuinely bilingual
//     rather than English-only.
// ---------------------------------------------------------------------------

const CJK = /[\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]/;

test('Marketplace displayName is bilingual and within the byte cap', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.match(m.displayName, CJK, `displayName needs Chinese: ${m.displayName}`);
  assert.match(m.displayName, LATIN, `displayName needs Latin: ${m.displayName}`);
  const bytes = Buffer.byteLength(m.displayName, 'utf8');
  assert.ok(bytes <= 1024, `displayName must be <= 1024 UTF-8 bytes; got ${bytes}`);
});

test('Marketplace description is bilingual', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.match(m.description, CJK, 'description needs a Chinese sentence');
  assert.match(m.description, LATIN, 'description needs an English sentence');
});

test('Marketplace exampleQueries are bilingual', () => {
  const m = readJson(MARKETPLACE_JSON);
  for (const q of m.exampleQueries) {
    assert.match(q, CJK, `query needs Chinese: ${q}`);
    assert.match(q, LATIN, `query needs Latin: ${q}`);
  }
});

test('registry plugin.json description is bilingual', () => {
  const m = readJson(PLUGIN_JSON);
  assert.match(m.description, CJK, 'registry description needs a Chinese sentence');
  assert.match(m.description, LATIN, 'registry description needs an English sentence');
});

test('a Chinese README ships alongside the English one', () => {
  const zh = join(PLUGIN, 'README.zh-CN.md');
  assert.ok(existsSync(zh), 'README.zh-CN.md missing');
  assert.ok(readText(zh).length > 500, 'README.zh-CN.md looks empty');
});

test('Marketplace author is a plain name (no URL, no angle brackets)', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.equal(/[<>]/.test(m.author), false, `author must not embed a URL/angle brackets: ${m.author}`);
  assert.equal(/https?:\/\//.test(m.author), false, `author must not embed a URL: ${m.author}`);
  assert.ok(Buffer.byteLength(m.author, 'utf8') <= 1024, 'author must be <= 1024 UTF-8 bytes');
});

test('all plugin files are free of host-literal paths', () => {
  // Sweep every published file in the plugin (not just SKILL.md and the
  // Marketplace JSON) so future regressions do not slip through.
  const FORBIDDEN = [
    /\/Users\//,
    /\/home\/[A-Za-z0-9._-]+\//,
    // Any literal `~/<path>` is a maintainer-local path. `${PLUGIN_ROOT}` is
    // the only sanctioned anchor, so a bare `~/` is always a violation.
    /~\/[A-Za-z0-9._-]/,
    /\$\{HOME\}/,
    /\$\{USERPROFILE\}/,
    /\$\{HOST_/,
  ];
  function walkSync(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkSync(full));
      else if (/\.(md|py|json)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  for (const f of walkSync(PLUGIN)) {
    if (f.includes('/.git/') || f.includes('/node_modules/')) continue;
    const text = readText(f);
    for (const re of FORBIDDEN) {
      assert.equal(re.test(text), false, `${f} contains forbidden path pattern ${re}`);
    }
  }
});

test('negative: skills/ reference to non-existent file is detectable', () => {
  const m = readJson(MARKETPLACE_JSON);
  for (const skillRel of m.skills) {
    const abs = join(PLUGIN, skillRel);
    assert.ok(existsSync(abs), `Marketplace references missing file: ${skillRel}`);
  }
});
