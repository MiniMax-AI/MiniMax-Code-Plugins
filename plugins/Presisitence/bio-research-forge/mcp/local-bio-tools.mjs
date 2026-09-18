#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const SERVER = { name: 'local-bio-tools', version: '0.1.0' };
const TOOL_INFO = {
  pymol: { name: 'PyMOL', mode: 'headless-render', formats: ['pdb', 'cif', 'mmcif', 'mol2', 'sdf', 'pse'] },
  snapgene: { name: 'SnapGene', mode: 'open-existing-file', formats: ['dna', 'gb', 'gbk', 'genbank', 'fasta', 'fa', 'ape'] },
  cytoscape: { name: 'Cytoscape', mode: 'open-existing-file', formats: ['cys', 'xgmml', 'sif', 'graphml', 'cyjs'] },
  fiji: { name: 'Fiji/ImageJ', mode: 'open-existing-file', formats: ['tif', 'tiff', 'png', 'jpg', 'jpeg', 'lif', 'czi', 'nd2', 'ome'] },
};

const TOOLS = [
  {
    name: 'local_bio_tool_status',
    description: 'Detect the selected local biology tools (PyMOL, SnapGene, Cytoscape, Fiji) without installing or launching them.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { tool: { type: 'string', enum: Object.keys(TOOL_INFO) } } },
  },
  {
    name: 'pymol_render',
    description: 'Render an existing local molecular structure to a PNG with a safe preset. No arbitrary PyMOL command or script is accepted.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        input_path: { type: 'string' }, output_path: { type: 'string' },
        representation: { type: 'string', enum: ['cartoon', 'surface', 'sticks', 'cartoon-and-sticks'], default: 'cartoon-and-sticks' },
        color: { type: 'string', enum: ['spectrum', 'chain', 'secondary-structure'], default: 'spectrum' },
        background: { type: 'string', enum: ['white', 'black', 'transparent'], default: 'white' },
        width: { type: 'integer', minimum: 400, maximum: 5000, default: 1800 },
        height: { type: 'integer', minimum: 400, maximum: 5000, default: 1400 },
      },
      required: ['input_path', 'output_path'],
    },
  },
  {
    name: 'local_bio_open',
    description: 'Open one existing, format-compatible local file in SnapGene, Cytoscape, or Fiji. Use only when the user explicitly asks to open the desktop application.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { tool: { type: 'string', enum: ['snapgene', 'cytoscape', 'fiji'] }, file_path: { type: 'string' } },
      required: ['tool', 'file_path'],
    },
  },
];

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function rpcResult(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function rpcError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function textResult(value, isError = false) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) }; }

function commandPath(name) {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(command, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || null;
  } catch { return null; }
}

function driveRoots() {
  if (process.platform !== 'win32') return ['/'];
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[A-Za-z]:\\$/.test(x));
  } catch { return ['C:\\']; }
}

function firstExisting(candidates) { return candidates.filter(Boolean).find((candidate) => existsSync(candidate)) || null; }
function childrenMatching(parent, fileName) {
  try { return readdirSync(parent, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(parent, x.name, fileName)); }
  catch { return []; }
}

function discover() {
  const roots = driveRoots();
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const pymol = firstExisting([
    process.env.PYMOL_EXE, commandPath('pymol'), commandPath('PyMOLWin.exe'),
    ...roots.flatMap((root) => [
      path.join(root, 'conda', 'miconda', 'envs', 'pymol', 'Scripts', 'pymol.exe'),
      path.join(root, 'miniconda3', 'envs', 'pymol', 'Scripts', 'pymol.exe'),
      path.join(root, 'anaconda3', 'envs', 'pymol', 'Scripts', 'pymol.exe'),
    ]),
    ...pf.flatMap((root) => [path.join(root, 'PyMOL', 'PyMOLWin.exe'), path.join(root, 'Schrodinger', 'PyMOL2', 'PyMOLWin.exe')]),
  ]);
  const snapgene = firstExisting([
    process.env.SNAPGENE_EXE, commandPath('SnapGene.exe'),
    ...roots.map((root) => path.join(root, 'Tools', 'SnapGene', 'SnapGene.exe')),
    ...pf.map((root) => path.join(root, 'SnapGene', 'SnapGene.exe')),
  ]);
  const cytoscape = firstExisting([
    process.env.CYTOSCAPE_EXE, commandPath('Cytoscape.exe'),
    ...roots.flatMap((root) => childrenMatching(path.join(root, 'Tools', 'cytoscape'), 'Cytoscape.exe')),
    ...pf.flatMap((root) => childrenMatching(root, path.join('Cytoscape', 'Cytoscape.exe'))),
  ]);
  const fiji = firstExisting([
    process.env.FIJI_EXE, commandPath('ImageJ-win64.exe'), commandPath('ImageJ'),
    ...roots.map((root) => path.join(root, 'Tools', 'Fiji.app', 'ImageJ-win64.exe')),
    ...pf.flatMap((root) => [path.join(root, 'Fiji.app', 'ImageJ-win64.exe'), path.join(root, 'Fiji', 'ImageJ-win64.exe')]),
  ]);
  return { pymol, snapgene, cytoscape, fiji };
}

function status(tool) {
  const found = discover();
  const ids = tool ? [tool] : Object.keys(TOOL_INFO);
  return {
    generatedAt: new Date().toISOString(), localOnly: true, installsSoftware: false,
    tools: ids.map((id) => ({ id, ...TOOL_INFO[id], installed: Boolean(found[id]), executable: found[id] })),
  };
}

function existingCompatibleFile(value, tool) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value)) throw new Error('file path must be an existing absolute path');
  const ext = path.extname(value).slice(1).toLowerCase();
  if (!TOOL_INFO[tool].formats.includes(ext)) throw new Error(`${TOOL_INFO[tool].name} does not accept .${ext} through this bridge`);
  return path.resolve(value);
}
function runProcess(exe, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process timed out after ${timeout} ms`)); }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error((stderr || stdout || `Process exited with ${code}`).slice(-4000))); });
  });
}

async function pymolRender(args) {
  const exe = discover().pymol;
  if (!exe) throw new Error('PyMOL was not found. Set PYMOL_EXE or add it to PATH. No installation was attempted.');
  const input = existingCompatibleFile(args.input_path, 'pymol');
  if (typeof args.output_path !== 'string' || !path.isAbsolute(args.output_path) || !/\.png$/i.test(args.output_path)) throw new Error('output_path must be an absolute .png path');
  const output = path.resolve(args.output_path);
  const representation = args.representation || 'cartoon-and-sticks';
  const color = args.color || 'spectrum'; const background = args.background || 'white';
  const width = Math.max(400, Math.min(5000, Number(args.width) || 1800)); const height = Math.max(400, Math.min(5000, Number(args.height) || 1400));
  mkdirSync(path.dirname(output), { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bio-pymol-'));
  const script = path.join(tmp, 'render.pml');
  const commands = ['reinitialize', 'python', `cmd.load(${JSON.stringify(input)}, "structure")`, 'python end', 'hide everything, all'];
  if (representation === 'cartoon') commands.push('show cartoon, polymer.protein');
  if (representation === 'surface') commands.push('show surface, all');
  if (representation === 'sticks') commands.push('show sticks, all');
  if (representation === 'cartoon-and-sticks') commands.push('show cartoon, polymer.protein', 'show sticks, organic');
  if (color === 'spectrum') commands.push('spectrum count, rainbow, all');
  if (color === 'chain') commands.push('util.cbc("all")');
  if (color === 'secondary-structure') commands.push('color marine, ss h', 'color gold, ss s', 'color grey70, ss l');
  commands.push(`bg_color ${background === 'transparent' ? 'white' : background}`);
  commands.push(`set ray_opaque_background, ${background === 'transparent' ? 'off' : 'on'}`, 'set antialias, 2', 'orient all', `ray ${width}, ${height}`, 'python', `cmd.png(${JSON.stringify(output)}, dpi=300)`, 'python end', 'quit');
  writeFileSync(script, `${commands.join('\n')}\n`, 'utf8');
  try {
    const executed = await runProcess(exe, ['-cq', '-r', script]);
    if (!existsSync(output)) throw new Error(`PyMOL completed without producing the requested PNG. Output: ${(executed.stderr || executed.stdout).slice(-1500)}`);
    return { tool: 'pymol', input, png: output, representation, color, background, localOnly: true, previewInstruction: `Display the PNG inline: ![PyMOL render](${output})` };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function openLocal(args) {
  const id = args?.tool; if (!['snapgene', 'cytoscape', 'fiji'].includes(id)) throw new Error('tool must be snapgene, cytoscape, or fiji');
  const exe = discover()[id]; if (!exe) throw new Error(`${TOOL_INFO[id].name} was not found. No installation was attempted.`);
  const file = existingCompatibleFile(args.file_path, id);
  const child = spawn(exe, [file], { detached: true, stdio: 'ignore', windowsHide: true }); child.unref();
  return { tool: id, launched: true, file, localOnly: true, note: 'The existing file was opened; the bridge did not edit or export it.' };
}

async function callTool(name, args) {
  try {
    if (name === 'local_bio_tool_status') return textResult(status(args?.tool));
    if (name === 'pymol_render') return textResult(await pymolRender(args || {}));
    if (name === 'local_bio_open') return textResult(openLocal(args || {}));
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) { return textResult(err instanceof Error ? err.message : String(err), true); }
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id == null) return;
  const { id, method, params } = message;
  if (method === 'initialize') rpcResult(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER });
  else if (method === 'ping') rpcResult(id, {});
  else if (method === 'tools/list') rpcResult(id, { tools: TOOLS });
  else if (method === 'tools/call') rpcResult(id, await callTool(params?.name, params?.arguments));
  else rpcError(id, -32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)); } catch (err) { rpcError(null, -32700, err instanceof Error ? err.message : String(err)); }
});
