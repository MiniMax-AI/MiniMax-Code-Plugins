#!/usr/bin/env node
// index.js — mcode-skill-bridge CLI
//
// Subcommands:
//   detect <file>         print encoding detection result
//   analyze <file|dir>    print analysis report (frontmatter, paths, external cmds)
//   classify <file|dir>   print tier + reason
//   convert <file|dir>    run the full pipeline, write to --out
//   lint <skill-dir>      run the mavis skill-creator lint
//
// When given a directory, we look for SKILL.md inside it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { detectEncoding, readFileSafe } from './lib/detect.js';
import { analyzeSkillFile } from './lib/analyze.js';
import { classify } from './lib/classify.js';
import { transformSkill } from './lib/transform-skill.js';
import { lintSkill } from './lib/lint.js';

const USAGE = `mcode-skill-bridge — convert openclaw (and similar) skills to mavis/mcode

Usage:
  mcode-skill-bridge detect <file>            Detect encoding of a SKILL.md
  mcode-skill-bridge analyze <file-or-dir>    Analyze (frontmatter, paths, external cmds)
  mcode-skill-bridge classify <file-or-dir>   Classify into pure / wrapped / abandon
  mcode-skill-bridge convert <file-or-dir>    Convert and write to --out
  mcode-skill-bridge lint <skill-dir>         Lint a converted skill
  mcode-skill-bridge --help

Options:
  --out <dir>       Output directory (default: ./out/<name>)
  --force           Overwrite existing output
  --no-lint         Skip lint after convert
  --scope <s>       user | agent | project (informational only, used in report)
  --json            Machine-readable output
`;

function parseArgs(argv) {
  const args = { _: [], opts: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.opts[k] = next;
        i++;
      } else {
        args.opts[k] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function resolveInput(p) {
  const stat = await fs.stat(p).catch(() => null);
  if (!stat) throw new Error(`input not found: ${p}`);
  if (stat.isDirectory()) {
    const candidate = path.join(p, 'SKILL.md');
    await fs.access(candidate);
    return candidate;
  }
  return p;
}

function jsonOut(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function cmdDetect(target, opts) {
  const det = await readFileSafe(target);
  if (opts.json) return jsonOut(det);
  console.log(`encoding:    ${det.encoding}`);
  console.log(`original:    ${det.originalEncoding}`);
  console.log(`replaced:    ${det.replaced}`);
  console.log(`confidence:  ${det.confidence}`);
  console.log(`reason:      ${det.reason}`);
  console.log(`text length: ${det.text.length} chars`);
}

async function cmdAnalyze(target, opts) {
  const report = await analyzeSkillFile(target);
  if (opts.json) return jsonOut(report);
  console.log(`input:       ${report.inputPath}`);
  console.log(`encoding:    ${report.encoding} (converted=${report.convertedFromGbk})`);
  console.log(`frontmatter: ${Object.keys(report.frontmatter).join(', ') || '(empty)'}`);
  console.log(``);
  console.log(`hardcoded paths:`);
  for (const p of report.hardcodedPaths) console.log(`  - ${p.label}: ${p.samples.join(', ')}`);
  if (report.hardcodedPaths.length === 0) console.log(`  (none)`);
  console.log(``);
  console.log(`external commands:`);
  for (const c of report.externalCommands) console.log(`  - ${c.label}: ${c.samples.join(', ')}`);
  if (report.externalCommands.length === 0) console.log(`  (none)`);
  if (report.warnings.length) {
    console.log(``);
    console.log(`warnings:`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
}

async function cmdClassify(target, opts) {
  const report = await analyzeSkillFile(target);
  const result = classify(report);
  if (opts.json) return jsonOut({ report: { inputPath: report.inputPath, encoding: report.encoding }, result });
  console.log(`tier:    ${result.tier}`);
  console.log(`subTier: ${result.subTier}`);
  console.log(`reason:  ${result.reason}`);
  console.log(``);
  console.log(`recommendations:`);
  for (const r of result.recommendations) console.log(`  - ${r}`);
}

async function cmdConvert(target, opts) {
  const report = await analyzeSkillFile(target);
  const result = classify(report);
  if (result.tier === 'abandon') {
    console.error(`abandon: ${result.reason}`);
    process.exitCode = 2;
    return;
  }
  if (result.tier !== 'pure') {
    console.error(`convert: tier "${result.tier}" not yet supported in v0.1 (only pure). See plan §6.`);
    process.exitCode = 3;
    return;
  }
  const outDir = opts.out
    ? path.resolve(String(opts.out))
    : path.resolve('./out', path.basename(path.dirname(target)));
  if (!opts.force) {
    const exists = await fs.stat(outDir).catch(() => null);
    if (exists) {
      console.error(`output already exists: ${outDir} (use --force to overwrite)`);
      process.exitCode = 4;
      return;
    }
  }
  const r = await transformSkill({
    inputPath: target,
    report,
    classify: result,
    outDir,
  });
  console.log(`wrote ${r.written.length} files to ${outDir}`);
  for (const w of r.written) console.log(`  - ${w}`);
  if (r.warnings.length) {
    console.log(``);
    console.log(`warnings:`);
    for (const w of r.warnings) console.log(`  - ${w}`);
  }
  if (opts['no-lint']) return;
  const lintResult = await lintSkill(outDir);
  if (lintResult.ok) {
    console.log(``);
    console.log(`lint: PASS`);
  } else {
    console.log(``);
    console.log(`lint: WARN (exit=${lintResult.code})`);
    if (lintResult.stdout) console.log(lintResult.stdout);
    if (lintResult.stderr) console.log(lintResult.stderr);
  }
}

async function cmdLint(target, opts) {
  const r = await lintSkill(target);
  if (r.ok) {
    console.log(`lint: PASS`);
  } else {
    console.log(`lint: FAIL (exit=${r.code})`);
    if (r.stdout) console.log(r.stdout);
    if (r.stderr) console.log(r.stderr);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._.length === 0 || args.opts.help || args.opts.h) {
    process.stdout.write(USAGE);
    return;
  }
  const cmd = args._[0];
  const target = args._[1];
  if (!target) {
    console.error(`missing input for command: ${cmd}`);
    process.exitCode = 1;
    return;
  }

  try {
    const resolved = ['detect', 'analyze', 'classify', 'convert'].includes(cmd)
      ? await resolveInput(target)
      : path.resolve(target);
    switch (cmd) {
      case 'detect':   return await cmdDetect(resolved, args.opts);
      case 'analyze':  return await cmdAnalyze(resolved, args.opts);
      case 'classify': return await cmdClassify(resolved, args.opts);
      case 'convert':  return await cmdConvert(resolved, args.opts);
      case 'lint':     return await cmdLint(resolved, args.opts);
      default:
        console.error(`unknown command: ${cmd}`);
        process.stdout.write(USAGE);
        process.exitCode = 1;
    }
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
