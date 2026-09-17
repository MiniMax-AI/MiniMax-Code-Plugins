// examples/regen.mjs
//
// Regenerate examples/output/task-tracker/ by running the v0.2
// converter pipeline against examples/input/task-tracker/.
//
// This is the same code path the MCP `convert` tool uses — it just
// inlines the import-and-call instead of going through JSON-RPC.
//
// Usage from the plugin root:
//   node examples/regen.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSkillFile } from '../lib/analyze.js';
import { classify } from '../lib/classify.js';
import { transformSkill } from '../lib/transform-skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');

const source = path.join(PLUGIN_ROOT, 'examples', 'input', 'task-tracker', 'SKILL.md');
const outDir = path.join(PLUGIN_ROOT, 'examples', 'output', 'task-tracker');

const report = await analyzeSkillFile(source);
const result = classify(report);
const r = await transformSkill({
  inputPath: source,
  report,
  classify: result,
  outDir,
});

console.log('Wrote:');
for (const f of r.written) {
  console.log(`  ${path.relative(PLUGIN_ROOT, f)}`);
}
if (r.warnings.length) {
  console.log('Warnings:');
  for (const w of r.warnings) console.log(`  ${w}`);
}
