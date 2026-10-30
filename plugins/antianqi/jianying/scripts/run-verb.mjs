#!/usr/bin/env node
/**
 * 插件自带的 MCP 客户端 —— 让 skill 能【调动词】而不直接调 CLI（纪律 #1）
 *
 * 用法:
 *   node scripts/run-verb.mjs <verb> '<json-args>'
 *   node scripts/run-verb.mjs grade_apply '{"src":"...","outDir":"...","spec":{"adjustColor":{"brightness":0.1}}}'
 *   node scripts/run-verb.mjs --list
 *
 * 它通过 stdio 连自己的 mcp/server.mjs ⇒ 走的是【和 mcode 加载插件时完全一样的动词】。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 插件根解析：本文件在插件里时 HERE/.. 就是插件根；
   被复制到别处（例如 ~/.minimax/agents/mavis/skills/... 当安装副本）时，走 JYAI_PLUGIN_ROOT / 默认仓库位置。 */
function pluginRoot() {
  const local = path.resolve(HERE, '..');
  if (fs.existsSync(path.join(local, 'mcp', 'server.mjs'))) return local;
  const cands = [
    process.env.JYAI_PLUGIN_ROOT,
    path.join(os.homedir(), 'MiniMax-Code-Plugins-1', 'plugins', 'antianqi', 'jianying'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(path.join(c, 'mcp', 'server.mjs'))) return c;
  return local;
}
const SRV = path.join(pluginRoot(), 'mcp', 'server.mjs');

const args = process.argv.slice(2);
if (!args.length || args[0] === '--list') {
  const c = spawn(process.execPath, [SRV], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  c.stdout.on('data', async (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) {
        c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        continue;
      }
      if (m.id === 2) {
        for (const t of m.result?.tools || []) {
          console.log(`${t.name}\n  ${t.description}\n  入参: ${Object.keys(t.inputSchema?.properties || {}).join(', ')}\n`);
        }
        c.kill(); process.exit(0);
      }
    }
  });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-verb', version: '1' } } }) + '\n');
} else {
  const verb = args[0];
  let params = {};
  try { params = args[1] ? JSON.parse(args[1]) : {}; } catch (e) {
    console.error(`参数不是合法 JSON: ${e.message}`); process.exit(2);
  }
  const c = spawn(process.execPath, [SRV], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  c.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id === 1) {
        c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: verb, arguments: params } }) + '\n');
        continue;
      }
      if (m.id === 2) {
        for (const item of m.result?.content || []) console.log(item.text || '');
        const bad = m.result?.isError === true;
        c.kill();
        process.exit(bad ? 1 : 0);
      }
    }
  });
  c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'run-verb', version: '1' } } }) + '\n');
}
