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

function candidatePaths(name, projectDir) {
  const dirs = [];
  // 调用方项目目录(若给了)、当前工作目录、技能自身位置的两个上层(仓库根/项目根都可能装了 node_modules)
  // cwd 必须查(二审 P2): README 明说支持把 ffmpeg-static 装在**视频项目**里, 而 prep-image / asr
  // 是从项目目录被调用的 —— 不查 cwd 就会"项目里明明装了却报找不到"
  const anchors = [process.env.KIT_PROJECT_DIR, projectDir, process.cwd(), SELF_DIR, path.resolve(SELF_DIR, '..'), path.resolve(SELF_DIR, '../..')]
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
  for (const p of candidatePaths(name, projectDir)) if (fs.existsSync(p)) return p;
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

// ── 输入收监(script.json 是 agent 可编辑文件, 其派生路径必须关进项目目录) ────
// 威胁模型: script.json 里的 slides[].id / html / audio、顶层 bgm.file 若含
// "../" 或绝对路径, 可让 fs 读写删与 ffmpeg argv 落到项目目录之外。
// 所有消费者在 JSON.parse 之后立即调用本节的校验, 失败即退出, 不带病运行。

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(v) {
  return typeof v === 'string' && ID_RE.test(v);
}

// 白名单校验 slide id; 返回原值, 不合格直接退出(并指明是哪个字段)
export function safeId(v, where = 'slides[].id') {
  if (!isSafeId(v)) {
    console.error(`✗ ${where} 非法: ${JSON.stringify(v)} — 只允许字母/数字/下划线/连字符, 长度 1–64`);
    process.exit(1);
  }
  return v;
}

// resolve 后是否仍落在 root 内(不含 root 本身; root 的 realpath 也参与比较,
// 防 root 自身就是指向外面的符号链接)
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 校验"root 下的相对路径"并返回绝对路径:
//   拒绝绝对路径 → inside(root) → 符号链接复核(取最深已存在祖先的 realpath,
//   必须仍在 root 的 realpath 内, 防 root 内某段是指向外面的 symlink)
export function safeRel(root, rel, { where = 'path', mustExist = false } = {}) {
  if (typeof rel !== 'string' || rel === '') {
    console.error(`✗ ${where} 非法: ${JSON.stringify(rel)} — 需要非空字符串`);
    process.exit(1);
  }
  if (path.isAbsolute(rel)) {
    console.error(`✗ ${where} 必须是相对路径: ${JSON.stringify(rel)}`);
    process.exit(1);
  }
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) {
    console.error(`✗ ${where} 越出项目目录: ${JSON.stringify(rel)} → ${abs}`);
    process.exit(1);
  }
  // 符号链接复核: 目标(或其最深已存在祖先)的 realpath, 必须仍在 root 的 realpath 内
  // (或是 root realpath 的祖先 —— root 尚不存在时, 共同祖先就是最近的真实路径, 属正常)
  try {
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);
    if (real !== realRoot && !inside(realRoot, real) && !inside(real, realRoot)) {
      console.error(`✗ ${where} 经符号链接越出项目目录: ${JSON.stringify(rel)}`);
      process.exit(1);
    }
  } catch { /* lstat 失败按不存在处理, 由 mustExist/后续逻辑兜底 */ }
  if (mustExist && !fs.existsSync(abs)) {
    console.error(`✗ ${where} 不存在: ${rel}`);
    process.exit(1);
  }
  return abs;
}

// ── 输出路径收监(2026-09-18 二审 P1: 输出侧此前只查了输入侧) ──────────
// 威胁模型: 派生输出(preview/<id>.png、build/frames/<id>/…)是"项目内固定位置 + 受监 id",
// 看起来安全, 但**项目内的目录段本身可能是指向项目外的符号链接**(preview → /tmp/canary,
// 或 build/frames → 项目外)。此时 writeFileSync/rmSync(recursive) 会穿透符号链接,
// 在项目外写/删, 而命令一路报成功 —— 用一次性 canary 数据可复现。
// 规则: 从 root 到目标, **每一段已存在祖先**的 realpath 都必须仍在 root 的 realpath 之内。
export function assertContained(root, abs, { where = 'output' } = {}) {
  const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);
  let probe = path.resolve(abs);
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { return abs; }   // 取不到就交给后续 fs 操作报错
  if (real !== realRoot && !inside(realRoot, real)) {
    console.error(`✗ ${where} 经符号链接越出项目目录: ${path.relative(path.resolve(root), abs) || abs}\n   ${probe} → ${real}(项目根 ${realRoot}) — 检查项目内是否有指向外部的符号链接`);
    process.exit(1);
  }
  return abs;
}

// 派生输出路径的安全拼装: 只接受受监 id 之类的安全片段, 并做上述祖先复核
export function safeOut(root, ...segs) {
  const abs = path.join(path.resolve(root), ...segs);
  if (!inside(path.resolve(root), abs)) {
    console.error(`✗ 输出路径越出项目目录: ${abs}`);
    process.exit(1);
  }
  return assertContained(root, abs, { where: `输出 ${segs.join('/')}` });
}

// 一次性走查 script.json 的全部路径派生字段(两个调用点: 每个 consumer 读入后)
export function validateScriptPaths(script, dir) {
  const list = Array.isArray(script?.slides) ? script.slides : [];
  for (const s of list) {
    safeId(s.id, `slides[].id (${JSON.stringify(s.title ?? '')})`);
    if (s.html !== undefined) safeRel(path.join(dir, 'slides'), s.html, { where: `slides[${s.id}].html` });
    if (s.audio !== undefined) safeRel(path.join(dir, 'audio'), s.audio, { where: `slides[${s.id}].audio` });
  }
  const bgm = script?.bgm;
  const bgmFile = typeof bgm === 'string' ? bgm : bgm?.file;
  if (bgmFile !== undefined) safeRel(dir, bgmFile, { where: 'bgm.file' });
}

// timings.json 的 slides[].id 是 script.json 的二次传播, 消费侧同样校验
export function validateTimingsIds(timings) {
  const list = Array.isArray(timings?.slides) ? timings.slides : [];
  for (const t of list) safeId(t.id, 'timings.slides[].id');
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
