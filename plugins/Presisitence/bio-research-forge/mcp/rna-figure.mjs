#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = { name: 'rna-figure', version: '0.1.0' };
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(ROOT, 'scripts', 'rna-figure.R');
const TYPES = ['volcano', 'pca', 'heatmap', 'expression-boxplot', 'enrichment-dotplot'];

const TOOLS = [
  {
    name: 'rna_figure_status',
    description: 'Check the local R plotting runtime and required packages without reading research data.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'rna_figure_create',
    description: 'Create a publication-oriented RNA result figure locally as PNG and PDF. The tool never uploads the input. After creation, display the returned PNG path in the conversation.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        plot_type: { type: 'string', enum: TYPES },
        input_path: { type: 'string', description: 'Absolute path to a CSV/TSV table explicitly selected by the user.' },
        output_dir: { type: 'string', description: 'Existing or creatable local output directory.' },
        output_name: { type: 'string', pattern: '^[A-Za-z0-9._-]+$', default: 'rna-figure' },
        metadata_path: { type: 'string', description: 'Optional PCA metadata CSV/TSV with sample and group columns.' },
        columns: {
          type: 'object', additionalProperties: false,
          properties: {
            gene: { type: 'string' }, x: { type: 'string' }, y: { type: 'string' }, label: { type: 'string' },
            group: { type: 'string' }, facet: { type: 'string' }, term: { type: 'string' }, size: { type: 'string' }, color: { type: 'string' }, sample: { type: 'string' },
          },
        },
        options: {
          type: 'object', additionalProperties: false,
          properties: {
            alpha: { type: 'number', exclusiveMinimum: 0, maximum: 1, default: 0.05 },
            lfc: { type: 'number', minimum: 0, default: 1 },
            top_n: { type: 'integer', minimum: 1, maximum: 500, default: 30 },
            label_n: { type: 'integer', minimum: 0, maximum: 50, default: 10 },
            width: { type: 'number', minimum: 3, maximum: 20, default: 7 },
            height: { type: 'number', minimum: 3, maximum: 20, default: 5.5 },
            dpi: { type: 'integer', minimum: 150, maximum: 1200, default: 300 },
            transform: { type: 'string', enum: ['auto', 'none', 'log2'], default: 'auto' },
          },
        },
      },
      required: ['plot_type', 'input_path', 'output_dir'],
    },
  },
];

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

function commandPath(name) {
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(command, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((x) => x.trim()).find(Boolean) || null;
  } catch { return null; }
}

function registryR() {
  if (process.platform !== 'win32') return null;
  for (const key of ['HKCU\\SOFTWARE\\R-core\\R', 'HKLM\\SOFTWARE\\R-core\\R']) {
    try {
      const value = execFileSync('reg.exe', ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const match = value.match(/InstallPath\s+REG_SZ\s+(.+)$/mi);
      if (match) {
        const candidate = path.join(match[1].trim(), 'bin', 'Rscript.exe');
        if (existsSync(candidate)) return candidate;
      }
    } catch { /* continue */ }
  }
  return null;
}

function driveRoots() {
  if (process.platform !== 'win32') return ['/'];
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-PSDrive -PSProvider FileSystem).Root'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map((x) => x.trim()).filter((x) => /^[A-Za-z]:\\$/.test(x));
  } catch { return ['C:\\']; }
}

function versionedR() {
  for (const root of driveRoots()) {
    for (const parent of [path.join(root, 'AI_IDE'), path.join(root, 'Program Files', 'R')]) {
      try {
        const candidates = readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && /^R[-_]?\d/i.test(entry.name))
          .map((entry) => path.join(parent, entry.name, 'bin', 'Rscript.exe'));
        const hit = candidates.find((candidate) => existsSync(candidate));
        if (hit) return hit;
      } catch { /* continue */ }
    }
  }
  return null;
}

function rscriptPath() {
  const candidates = [process.env.RSCRIPT_EXE, commandPath('Rscript'), registryR(), versionedR()].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function run(exe, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process timed out after ${timeout} ms`)); }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `Process exited with ${code}`).slice(-4000)));
    });
  });
}

async function status() {
  const exe = rscriptPath();
  if (!exe) return { ready: false, rscript: null, script: existsSync(SCRIPT), packages: {}, reason: 'Rscript not found. Set RSCRIPT_EXE or add Rscript to PATH.' };
  const probe = await run(exe, ['--vanilla', '-e', "p<-c('jsonlite','ggplot2','pheatmap','ggrepel');cat(paste(p,vapply(p,requireNamespace,logical(1),quietly=TRUE),sep='='),sep='\\n')"], 30000);
  const packages = Object.fromEntries(probe.stdout.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => { const [k, v] = line.trim().split('='); return [k, v === 'TRUE']; }));
  return { ready: Boolean(packages.jsonlite && packages.ggplot2 && packages.pheatmap), rscript: exe, script: existsSync(SCRIPT), packages };
}

function absoluteExistingFile(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !existsSync(value)) throw new Error(`${label} must be an existing absolute path`);
  if (!/\.(csv|tsv|txt)$/i.test(value)) throw new Error(`${label} must be CSV, TSV, or TXT`);
  return path.resolve(value);
}

async function createFigure(args) {
  const runtime = await status();
  if (!runtime.ready) throw new Error(`RNA plotting runtime is not ready: ${JSON.stringify(runtime)}`);
  if (!TYPES.includes(args?.plot_type)) throw new Error(`Unsupported plot_type: ${args?.plot_type}`);
  const inputPath = absoluteExistingFile(args.input_path, 'input_path');
  const outputDir = path.resolve(String(args.output_dir || ''));
  if (!path.isAbsolute(outputDir)) throw new Error('output_dir must be an absolute path');
  const outputName = args.output_name || 'rna-figure';
  if (!/^[A-Za-z0-9._-]+$/.test(outputName)) throw new Error('output_name contains unsupported characters');
  const metadataPath = args.metadata_path ? absoluteExistingFile(args.metadata_path, 'metadata_path') : null;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bio-rna-'));
  const configPath = path.join(tmp, 'config.json');
  const config = {
    plot_type: args.plot_type, input_path: inputPath, output_dir: outputDir, output_name: outputName,
    metadata_path: metadataPath, columns: args.columns || {}, options: args.options || {},
  };
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  try {
    const executed = await run(runtime.rscript, ['--vanilla', SCRIPT, configPath]);
    const lines = executed.stdout.split(/\r?\n/).filter(Boolean);
    const payloadLine = [...lines].reverse().find((line) => line.startsWith('RNA_FIGURE_RESULT='));
    if (!payloadLine) throw new Error(`R did not return a result manifest: ${(executed.stderr || executed.stdout).slice(-2000)}`);
    const payload = JSON.parse(payloadLine.slice('RNA_FIGURE_RESULT='.length));
    for (const key of ['png', 'pdf', 'plot_data']) if (!existsSync(payload[key])) throw new Error(`Expected output missing: ${payload[key]}`);
    return { ...payload, localOnly: true, previewInstruction: `Display the PNG inline: ![RNA figure](${payload.png})`, runtime: { rscript: runtime.rscript, packages: runtime.packages } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function callTool(name, args) {
  try {
    if (name === 'rna_figure_status') return textResult(await status());
    if (name === 'rna_figure_create') return textResult(await createFigure(args || {}));
    return textResult(`Unknown tool: ${name}`, true);
  } catch (err) { return textResult(err instanceof Error ? err.message : String(err), true); }
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id == null) return;
  const { id, method, params } = message;
  if (method === 'initialize') result(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER });
  else if (method === 'ping') result(id, {});
  else if (method === 'tools/list') result(id, { tools: TOOLS });
  else if (method === 'tools/call') result(id, await callTool(params?.name, params?.arguments));
  else error(id, -32601, `Method not found: ${method}`);
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return;
  try { void handle(JSON.parse(line)); } catch (err) { error(null, -32700, err instanceof Error ? err.message : String(err)); }
});
