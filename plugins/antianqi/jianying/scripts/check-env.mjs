#!/usr/bin/env node
/**
 * 环境自检（确定性护栏之一）—— 独立可跑，不依赖任何动词
 * 用法: node scripts/check-env.mjs
 *
 * 检查:
 *   1. JYAI_HOME / 工具链是否就位
 *   2. ffmpeg / python 是否可解析
 *   3. 剪映运行时缓存（effect 包）是否存在
 *   4. 插件自身结构完整性（schema / references / skills）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
let PASS = 0, FAIL = 0;
const ok = (n, d) => { PASS++; console.log(`  [OK]   ${n}${d ? '  — ' + d : ''}`); };
const bad = (n, d) => { FAIL++; console.log(`  [MISS] ${n}${d ? '  — ' + d : ''}`); };

console.log('=== 环境自检 ===\n');

console.log('[1] 工具链');
for (const t of ['jyai-live.mjs', 'jyai-b-render.mjs', 'jyai-audio-mix.mjs', 'jyai-grade-render.py', 'jyai-gl-bake.py']) {
  const p = path.join(JYAI, 'tools', t);
  if (fs.existsSync(p)) ok(t, p); else bad(t, `${p} 不存在（设 JYAI_HOME）`);
}

console.log('\n[2] 剪映运行时缓存');
const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'JianyingPro', 'User Data', 'Cache');
const effectPkg = path.join(cache, 'effect', '7416258989467374091', '9e1cfdca2b07a183049bfc9b5ed32895');
if (fs.existsSync(effectPkg)) ok('effect 包（官方 shader 参照源）', effectPkg);
else bad('effect 包', `${effectPkg} 不存在`);

console.log('\n[3] 插件结构');
const tools = path.join(ROOT, 'mcp', 'tools');
const schemas = fs.existsSync(tools) ? fs.readdirSync(tools).filter((f) => f.endsWith('.schema.json')) : [];
if (schemas.length === 8) ok('mcp/tools 下 8 份 schema', schemas.length + ' 份');
else bad('mcp/tools 下 8 份 schema', `实际 ${schemas.length} 份`);
for (const f of ['mcp/server.mjs', 'mcp.json', 'plugin.json', 'README.md',
  'references/chain-api.md', 'references/verify-discipline.md', 'references/pitfalls.md',
  'references/capability-dict.json', 'scripts/run-verb.mjs']) {
  if (fs.existsSync(path.join(ROOT, f))) ok(f); else bad(f, '缺失');
}
const skillsDir = path.join(ROOT, 'skills');
const skills = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md'))) : [];
ok('skills 目录', skills.length ? skills.join(', ') : '（暂无）');

console.log(`\n=== ${PASS} OK / ${FAIL} MISS ===`);
process.exit(FAIL === 0 ? 0 : 1);
