// lib/transform-skill.js — Generate a mavis-compatible SKILL.md from
// an analyzed openclaw SKILL.md.
//
// Output contract:
//   <outDir>/
//     SKILL.md                  # mavis schema, with enriched frontmatter
//     conversion-report.md      # what we changed and why
//     references/<topic>.md     # (optional) split from body if too long
//
// Atomicity:
//   Writes happen in a sibling staging directory first
//   (`<outDir>.staging-<rand>`), then `fs.rename`d onto outDir. If anything
//   fails before the rename, the staging dir is removed and outDir is left
//   untouched. This makes `--force` safe and prevents the "old references
//   leak into new output" bug.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as yaml from 'js-yaml';
import { parameterizePaths, suggestFilename } from './paths.js';
import { parseFrontmatter } from './analyze.js';

const MAX_BODY_LINES = 500;

function kebab(name) {
  // Strict ASCII kebab-case. Chinese / CJK names move to displayNames.zh-Hans.
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'unnamed-skill';
}

const TRIGGER_RE = /(".*?")|(\bwhen\b)|(\btrigger\b)|(\buse this\b)|(\bload this\b)|(\buse when\b)/i;
const TRIGGER_PHRASES = [
  'Use when the user asks to',
  'Use when: ',
  'Use this skill when',
];

function extractChineseSummary(body) {
  // Grab the first non-heading paragraph that contains Chinese.
  // Skip the first H1 if it doubles as a title; look for the first
  // paragraph that's plain prose.
  const blocks = body.split(/\r?\n\r?\n/);
  for (const p of blocks) {
    const t = p.trim();
    if (!t) continue;
    if (/^#+\s/.test(t)) continue;       // skip headings
    if (/^```/.test(t)) continue;          // skip code blocks
    if (/^[-*+]\s/.test(t)) continue;      // skip list items
    if (!/[\u3400-\u9FFF]/.test(t)) continue;
    return t.replace(/\s+/g, ' ').slice(0, 200);
  }
  return null;
}

function extractDisplayNameZh(frontmatter, body) {
  // Try existing name first (if it's Chinese, use it as displayName)
  if (frontmatter.name && /[\u3400-\u9FFF]/.test(frontmatter.name)) {
    return String(frontmatter.name).trim();
  }
  // Else grab the first H1's text
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 32);
  return null;
}

function enrichFrontmatter(original, body, classifyResult, targetName) {
  const fm = { ...original };
  // The output directory name is the source of truth for the kebab-case
  // name. openclaw skills often have CJK or inconsistent names; we ignore
  // those and use the ASCII dir name from --out.
  const name = targetName || kebab(fm.name || 'unnamed-skill');
  fm.name = name;

  // description: ensure it has a trigger phrase
  let desc = typeof fm.description === 'string' ? fm.description : (fm.description || '');
  desc = desc.replace(/\s+/g, ' ').trim();
  if (!desc) {
    const para = body.split(/\r?\n\r?\n/)[0] || '';
    desc = para.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  if (!TRIGGER_RE.test(desc)) {
    desc = `${TRIGGER_PHRASES[1]}${desc}`;
  }
  if (!desc.endsWith('.')) desc += '.';
  fm.description = desc;

  // Locale (only emit keys if we actually have content)
  const zhSummary = extractChineseSummary(body);
  const displayZh = extractDisplayNameZh(original, body);
  if (zhSummary) {
    fm.descriptions = fm.descriptions || {};
    fm.descriptions['zh-Hans'] = zhSummary;
  }
  if (displayZh) {
    fm.displayNames = fm.displayNames || {};
    fm.displayNames['zh-Hans'] = displayZh;
  }

  // Metadata hints
  fm.metadata = fm.metadata || {};
  fm.metadata['openclaw_compat'] = true;
  fm.metadata['skill-bridge'] = {
    classify_tier: classifyResult.tier,
    classify_subtier: classifyResult.subTier,
    classify_reason: classifyResult.reason,
  };

  return fm;
}

function addOutputContractSection(body) {
  if (/^##\s+Output contract/m.test(body)) return body;
  return body.trimEnd() + '\n\n## Output contract\n\nThis skill does not produce files by itself; the converted openclaw skill should declare its outputs in a new section here. (Filled in by the user after first run.)\n';
}

function addFailureHandlingSection(body) {
  if (/^##\s+Failure handling/m.test(body)) return body;
  return body.trimEnd() + '\n\n## Failure handling\n\nIf a required external tool or path is missing, surface the exact missing identifier to the user instead of guessing. Do not auto-install system packages. (Add skill-specific failure modes here.)\n';
}

function addWindowsNotesSection(body, hasShell) {
  if (!hasShell) return body;
  if (/^##\s+Windows \(win32\) platform notes/m.test(body)) return body;
  return body.trimEnd() + '\n\n## Windows (win32) platform notes\n\nThe original openclaw skill assumed macOS/Linux shell. The PowerShell equivalents for any `bash`/`pip`/`python3` calls should be documented here. (Generated by skill-bridge; user to verify.)\n';
}

function addReferencesIndex(body, references) {
  if (!references || references.length === 0) return body;
  if (/^##\s+References\b/m.test(body)) return body;
  const items = references
    .map((r) => `- [\`${r.file}\`](references/${r.file})`)
    .join('\n');
  return (
    body.trimEnd() +
    '\n\n## References\n\nDetailed content moved out of this SKILL.md for size. Read these when the main flow above references them:\n\n' +
    items +
    '\n'
  );
}

function maybeSplitReferences(name, body) {
  // v0.1 simple split: if body > 500 lines AND has clearly demarcated
  // sub-sections (## ...), move the later ones into references/.
  const lines = body.split(/\r?\n/);
  if (lines.length <= MAX_BODY_LINES) return { body, references: [] };

  const sections = [];
  let intro = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) sections.push(current);
      else if (intro.length) sections.push({ heading: '__intro__', lines: intro });
      current = { heading: line, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (current) sections.push(current);
  else if (intro.length) sections.push({ heading: '__intro__', lines: intro });

  if (sections.length < 3) return { body, references: [] };

  // Keep the first 2 sections (intro + first ## heading) in body, move the rest.
  const keep = sections.slice(0, 2).map(s => s.lines.join('\n')).join('\n\n');
  const moved = sections.slice(2);
  const references = moved.map(s => {
    const slug = s.heading
      .replace(/^##\s+/, '')
      .replace(/[^\w\u3400-\u9FFF-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 64) || 'section';
    return {
      file: `${slug}.md`,
      content: s.lines.join('\n'),
    };
  });
  return { body: keep.trimEnd() + '\n', references };
}

/**
 * @param {object} args
 * @param {string} args.inputPath
 * @param {import('./analyze.js').AnalyzedSkill} args.report
 * @param {ClassifyResult} args.classify
 * @param {string} args.outDir
 * @returns {Promise<{ written: string[], warnings: string[] }>}
 */
export async function transformSkill({ inputPath, report, classify, outDir }) {
  const warnings = [];
  const written = [];

  // 1. Parameterize paths in body
  const { text: bodyAfterPaths, changes: pathChanges } = parameterizePaths(report.body);
  if (pathChanges.length > 0) {
    warnings.push(`paths parameterized: ${pathChanges.map(c => c.id).join(', ')}`);
  }

  // 2. Detect shell-style commands to decide if Windows notes are needed
  const hasShell = /\b(pip|python3?|curl|wget|bash|cli-anything-)/.test(bodyAfterPaths);

  // 3. Maybe split into references/
  const { body: bodySplit, references } = maybeSplitReferences(report.frontmatter.name || '', bodyAfterPaths);

  // 4. Add the missing sections. References index goes BEFORE
  // Output contract / Failure handling / Windows notes so the moved-out
  // content is reachable from the top of the body, not buried under
  // boilerplate at the end.
  let finalBody = bodySplit;
  finalBody = addReferencesIndex(finalBody, references);
  finalBody = addOutputContractSection(finalBody);
  finalBody = addFailureHandlingSection(finalBody);
  finalBody = addWindowsNotesSection(finalBody, hasShell);

  // 5. Enrich frontmatter (target name = basename of outDir so name matches dir)
  const targetName = path.basename(outDir);
  const enrichedFm = enrichFrontmatter(report.frontmatter, finalBody, classify, targetName);

  // 6. Serialize
  const fmYaml = yaml.dump(enrichedFm, { lineWidth: 100, noRefs: true, sortKeys: false });
  const skillText = `---\n${fmYaml}---\n\n${finalBody.trimStart()}`;

  // 7. Atomic write: stage everything under a sibling temp dir, then rename.
  //    This means `--force` is safe (old outDir is replaced wholesale, no
  //    stale references/) and partial failures never leave a half-written
  //    outDir behind.
  const stageDir = `${outDir}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let stageSucceeded = false;
  try {
    await fs.mkdir(stageDir, { recursive: true });

    const skillOut = path.join(stageDir, 'SKILL.md');
    await fs.writeFile(skillOut, skillText, 'utf-8');

    for (const ref of references) {
      const refPath = path.join(stageDir, 'references', ref.file);
      await fs.mkdir(path.dirname(refPath), { recursive: true });
      await fs.writeFile(refPath, ref.content.trim() + '\n', 'utf-8');
    }

    const reportMd = renderConversionReport({ inputPath, classify, pathChanges, written: [], warnings });
    const reportPath = path.join(stageDir, 'conversion-report.md');
    await fs.writeFile(reportPath, reportMd, 'utf-8');

    // Replace the destination. If outDir exists, remove it first so the
    // rename is a simple same-volume move (works on Windows too).
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rename(stageDir, outDir);
    stageSucceeded = true;
  } finally {
    if (!stageSucceeded) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 8. Record the final paths (post-rename) for the caller.
  written.push(path.join(outDir, 'SKILL.md'));
  for (const ref of references) {
    written.push(path.join(outDir, 'references', ref.file));
  }
  written.push(path.join(outDir, 'conversion-report.md'));

  return { written, warnings };
}

function renderConversionReport({ inputPath, classify, pathChanges, written, warnings }) {
  return [
    `# Conversion report`,
    ``,
    `- **input**: \`${inputPath}\``,
    `- **tier**: ${classify.tier} / ${classify.subTier}`,
    `- **reason**: ${classify.reason}`,
    ``,
    `## Path changes`,
    pathChanges.length === 0
      ? `_none_`
      : pathChanges.map(c => `- \`${c.id}\` → \${${c.placeholder}} (${c.count}x)`).join('\n'),
    ``,
    `## Written files`,
    written.map(f => `- \`${f}\``).join('\n'),
    ``,
    `## Recommendations`,
    classify.recommendations.map(r => `- ${r}`).join('\n'),
    ``,
    `## Warnings`,
    warnings.length === 0 ? `_none_` : warnings.map(w => `- ${w}`).join('\n'),
    ``,
    `_generated by skill-bridge v0.1.0 on ${new Date().toISOString()}_`,
    ``,
  ].join('\n');
}
