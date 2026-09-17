// html2video-for-mcode · ffmpeg/ffprobe 探测: PATH → node_modules → 常见安装位置
// 找不到时给可诊断的提示, 而不是让下游脚本报莫名其妙的错。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

function onPath(name) {
  const r = spawnSync(name + EXE, ['-version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout ? name + EXE : null;
}

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url)); // Node 20.11 以下没有 import.meta.dirname, 用 fileURLToPath 保兼容

function candidatePaths(name) {
  const dirs = [];
  // 调用方项目目录(若给了)与技能自身位置的两个上层(仓库根/项目根都可能装了 node_modules)
  const anchors = [process.env.KIT_PROJECT_DIR, SELF_DIR, path.resolve(SELF_DIR, '..'), path.resolve(SELF_DIR, '../..')]
    .filter(Boolean);
  for (const base of anchors) {
    dirs.push(path.join(base, 'node_modules', 'ffmpeg-static'));
    dirs.push(path.join(base, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch));
  }
  if (IS_WIN) {
    const la = process.env.LOCALAPPDATA;
    if (la) {
      dirs.push(path.join(la, 'Microsoft', 'WinGet', 'Links'));
      dirs.push(path.join(la, 'scoop', 'shims'));
    }
    dirs.push('C:\\ffmpeg\\bin');
  }
  return dirs.map(d => path.join(d, name + EXE));
}

export function findTool(name, projectDir) {
  try { const p = onPath(name); if (p) return p; } catch { /* not on PATH */ }
  if (projectDir) {
    const local = [
      path.join(projectDir, 'node_modules', 'ffmpeg-static', name + EXE),
      path.join(projectDir, 'node_modules', 'ffprobe-static', 'bin', process.platform, process.arch, name + EXE),
    ];
    for (const p of local) if (fs.existsSync(p)) return p;
  }
  for (const p of candidatePaths(name)) if (fs.existsSync(p)) return p;
  return null;
}

export function requireTool(name, projectDir) {
  const p = findTool(name, projectDir);
  if (!p) {
    console.error([
      `✗ 找不到 ${name}。按顺序排查:`,
      `  1. 系统 PATH 上没有 ${name}`,
      `  2. 项目/仓库 node_modules 里没有 (试试: npm i ffmpeg-static ffprobe-static)`,
      `  3. 常见安装位置 (winget Links / scoop / C:\\ffmpeg\\bin) 也没有`,
      `  最快解法: winget install Gyan.FFmpeg (Windows) · brew install ffmpeg (macOS) · apt install ffmpeg (Linux)`,
    ].join('\n'));
    process.exit(2); // 2 = 环境错误, 与 1 (业务错误) 区分
  }
  return p;
}

// ── Node 包解析(playwright) ──────────────────────────────────────
// 技能通常装在 ~/.claude/skills/ 或 ~/.openclaw/skills/ —— 不在项目树里,
// 而 Node 的 import 是按"脚本所在位置"向上找 node_modules 的, 于是会出现
// "项目里明明装了 playwright 却报找不到"。这里按多个锚点依次尝试。
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const PKG_ANCHORS = () => {
  const list = [process.env.KIT_PROJECT_DIR, process.cwd()];
  // 全局 npm root(全局装的 playwright 也能用)
  for (const npm of IS_WIN ? ['npm.cmd', 'npm'] : ['npm']) {
    try {
      const r = spawnSync(npm, ['root', '-g'], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0 && r.stdout) { list.push(r.stdout.trim()); break; }
    } catch { /* ignore */ }
  }
  return [...new Set(list.filter(Boolean))];
};

export async function loadPackage(name, { projectDir } = {}) {
  // CJS 包(如 playwright)动态 import 后命名导出可能拿不到, 统一解包出真实模块对象
  const unwrap = mod => (mod && (mod.chromium || mod.default?.chromium)) ? (mod.chromium ? mod : mod.default) : mod;
  // 1) 脚本自身位置(技能装在项目内, 或全局 node_modules 可被解析时)
  try { const m = unwrap(await import(name)); if (m?.default !== undefined || m) return m; } catch { /* 继续找 */ }
  // 2) 项目目录 / 调用目录 / 全局 npm root, 逐个用 createRequire 解析真实入口
  const anchors = [...new Set([projectDir, ...PKG_ANCHORS()].filter(Boolean))];
  for (const base of anchors) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      const entry = req.resolve(name);
      return unwrap(await import(pathToFileURL(entry).href));
    } catch { /* 试下一个 */ }
  }
  return null;
}
