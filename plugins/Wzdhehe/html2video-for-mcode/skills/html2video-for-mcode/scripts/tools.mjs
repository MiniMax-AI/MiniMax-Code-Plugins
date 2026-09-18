// html2video-for-mcode · ffmpeg/ffprobe 探测: PATH → node_modules → 常见安装位置
// 找不到时给可诊断的提示, 而不是让下游脚本报莫名其妙的错。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { kitStatuses } from './css-kit.mjs';
import { generateTokensCss, TOKENS_REV } from './tokens-template.mjs';
import { MAX_SCAN_BYTES } from './limits.mjs';

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

// 纯字符串判断: resolve 之后 target 是否落在 root 内(target 等于 root 时返回 false)。
// 这里**不做** realpath —— 符号链接复核在 safeRel / assertContained 里做(它们会取最深已存在祖先的
// realpath 并 fail closed)。谁需要防"root 自身是指向外面的链接"就用那两个, 别指望这个。
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
  // 符号链接复核: 目标(或其最深"存在或是指向外的悬空链接"的祖先)的 realpath,
  // 必须仍在 root 的 realpath 内(或是 root realpath 的祖先 —— root 尚不存在时属正常)。
  // 复查修正(1.7.0): ①回溯用 lstat 而不是 existsSync —— 悬空符号链接 existsSync=false,
  // 旧写法会把它当"不存在"继续往上走, 从而漏检(写进去就落到项目外); ②realpath 取不到时
  // **fail closed**(以前 return abs 静默放行, 正好给"造一个解不开的链接"留了门)。
  {
    let probe = abs;
    while (true) {
      let st = null;
      try { st = fs.lstatSync(probe); } catch { /* 真不存在 */ }
      if (st) break;                          // 存在, 或者是悬空链接(此时也要停下来判)
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);
    let real = null;
    try { real = fs.realpathSync(probe); }
    catch {
      // 悬空/自环/无权限的链接: 解不开就不能证明它落在项目内 → 拒绝, 不猜
      const st = (() => { try { return fs.lstatSync(probe); } catch { return null; } })();
      if (st && st.isSymbolicLink()) {
        console.error(`✗ ${where} 命中一个解不开的符号链接: ${path.relative(path.resolve(root), probe) || probe}\n   无法证明它指向项目内, 按越界拒绝(悬空链接常被用来把写入引到项目外)`);
        process.exit(1);
      }
      // 非链接却 realpath 失败(权限等): 同样不放过
      console.error(`✗ ${where} 无法解析真实路径: ${probe}(realpath 失败)`);
      process.exit(1);
    }
    if (real !== realRoot && !inside(realRoot, real) && !inside(real, realRoot)) {
      console.error(`✗ ${where} 经符号链接越出项目目录: ${JSON.stringify(rel)}`);
      process.exit(1);
    }
  }
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
// 规则: 从 root 到目标, **每一段已存在祖先**的 realpath 都必须仍在 root 的 realpath 之内;
// 叶子自身是符号链接也要拦(否则 ffmpeg/fs 会从那个链接写出去)。
export function assertContained(root, abs, { where = 'output' } = {}) {
  const realRoot = fs.existsSync(root) ? fs.realpathSync(path.resolve(root)) : path.resolve(root);
  let probe = path.resolve(abs);
  while (true) {
    let st = null;
    try { st = fs.lstatSync(probe); } catch { /* 真不存在 */ }
    if (st) break;                                  // 存在或悬空链接: 停下来判
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let real;
  try { real = fs.realpathSync(probe); }
  catch {
    const st = (() => { try { return fs.lstatSync(probe); } catch { return null; } })();
    if (st && st.isSymbolicLink()) {
      console.error(`✗ ${where} 命中解不开的符号链接: ${path.relative(path.resolve(root), probe) || probe}\n   无法证明它指向项目内, 按越界拒绝`);
      process.exit(1);
    }
    console.error(`✗ ${where} 无法解析真实路径: ${probe}(realpath 失败)`);
    process.exit(1);
  }
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

// ── 路径规范化(比较用) ─────────────────────────────────────────────────
// 取最深已存在祖先的 realpath 再拼回来: macOS 上 /var/... 与 /private/var/... 是同一目录的两种
// 写法, 纯字符串比较会把"项目内的合法路径"误判成越界(二审 P2 在官方 CI 的 macOS 上实测踩到)。
// 取不到 realpath 就返回原样(这是**比较**用的助手, 与 safeRel/assertContained 的 fail-closed 不同)。
// 2026-09-18 复查 E5: fetch-official-images 里曾有一份同样的实现, 统一到这里。
export function canonicalPath(p) {
  const abs = path.resolve(p);
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return abs;
    probe = up;
  }
  try {
    const real = fs.realpathSync(probe);
    return probe === abs ? real : path.join(real, path.relative(probe, abs));
  } catch { return abs; }
}

// ── 位置参数(项目目录)的取法 ───────────────────────────────────────────
// 各脚本的用法是 `node x.mjs <项目目录> [--flag 值]`, 但 `<项目目录>` 可以放在任意位置,
// 于是"第一个非 -- 开头的参数"这个取法会把**取值型 flag 的值**当目录 —— 实测
// `init-project.mjs --topic 我的主题 <项目目录>` 会在 cwd 下静默建出 `我的主题/` 骨架, 而真正的
// 项目目录一个字都没写。取值型 flag 名字全技能统一(见下表), 所以用一份清单跳过它们的值。
// **只列真的带值的**: 布尔开关(--json / --allow-stale-css / --no-subs / --force / --both …)绝不能
// 进来 —— 进来就会把它后面那个位置参数当"值"吃掉, 于是 <项目目录> 解析成 cwd: 实测
// `capture --allow-stale-css <项目>` 会对着调用目录干活, 真正的项目一个字节都没被碰。
// 同理 prep-image 的 --check/--crop 也**不列**: 它们的"参数"本来就是位置参数(一串文件名)。
// tests/review-round3.test.mjs 有一条从 scripts 源码反扫 argv.includes('--x') 的守卫, 防以后再犯。
export const VALUE_FLAGS = new Set([
  '--topic', '--mode', '--dsf', '--ids', '--at', '--min', '--max-mb', '--get', '--out', '--out-dir',
  '--file', '--format', '--from', '--url', '--base-url', '--api-key', '--language',
  '--ratio', '--timestamp', '--anchor', '--transition',
]);
/** 所有位置参数(跳过取值型 flag 的值)。prep-image 这类"一串文件名"的用法用它 */
export function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}
/** 取位置参数(项目目录): 第一个非 flag 参数; 没有位置参数时用 dflt(默认 cwd) */
export function positionalDir(argv, { dflt = '.' } = {}) {
  const first = positionals(argv)[0];
  return path.resolve(first ?? dflt);
}
/** 取值型 flag: flag('--mode', 'still') —— 没有该 flag 时返回 dflt */
export const flagValue = (argv, name, dflt) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : dflt;
};

// ── 切页方式的单一解析来源 ─────────────────────────────────────────────
// script.json 的 transition 允许三种写法: 省略 / "cut" / "xfade" / {type:"xfade",duration:0.4}。
// 2026-09-18 复查 D6: check-slides 认裸字符串、build-video 只认对象里的 type —— 于是
// `"xfade"`(字符串)在闸门里显示"交叉溶解", 成片却是硬切, 两边说法不一致还没有任何报错。
// 现在两边都调这个函数: 同一个值必然得到同一个结论, 非法值都在自己的入口报错。
export const XFADE_DEFAULT_DUR = 0.4;
export function readTransition(v, { where = 'script.transition' } = {}) {
  const raw = v == null ? 'cut' : (typeof v === 'string' ? v : v?.type);
  const type = typeof v === 'object' && v !== null && raw == null ? 'cut' : raw;
  if (!['cut', 'xfade'].includes(type)) {
    throw new Error(`${where} 非法: ${JSON.stringify(typeof v === 'object' ? v?.type : v)} — 只支持 "cut"(硬切, 默认) 或 "xfade"(交叉溶解), 或 {type,duration} 对象`);
  }
  const durRaw = typeof v === 'object' && v !== null ? (v.duration ?? XFADE_DEFAULT_DUR) : XFADE_DEFAULT_DUR;
  const dur = Number(durRaw);
  if (type === 'xfade' && (!Number.isFinite(dur) || dur <= 0 || dur > 2)) {
    throw new Error(`${where}.duration 非法: ${JSON.stringify(durRaw)} — 需要 0–2 秒`);
  }
  return { type, dur: type === 'xfade' ? dur : 0, label: type === 'cut' ? '硬切 cut' : `交叉溶解 xfade ${dur}s` };
}

// ── tokens.css 受管块新鲜度闸门(entry point 共用) ──────────────────────
// 为什么要在 capture / build-video 入口硬拦: 受管块落后时**画面照出, 只是旧样式** ——
// 新类没有样式、旧规则按层叠压过新版, 全程没有任何报错, 成片出来才发现(audit 2026-09-18)。
// 所以"陈旧"必须是阻断级, 并把修复命令直接给到手上; 确实要用旧 CSS 出片时显式 --allow-stale-css。
const EXPECT_TOKENS = { text: generateTokensCss(), rev: TOKENS_REV };
/** 受管区的新鲜度判据(技能当前版正文 + rev) —— check-slides / preview-page 与本模块共用同一份,
 *  免得各自再拼一次 generateTokensCss()(散着拼就会出现"某个调用点忘了带 rev"这类漂移) */
export const expectedTokens = () => EXPECT_TOKENS;
/** tokens.css 里所有非 ok 的受管块(缺/旧/重复/坏定界/区外残留副本) */
export function cssStaleIssues(cssText) {
  return kitStatuses(cssText, { expected: EXPECT_TOKENS }).filter(s => s.status !== 'ok');
}
/** 读项目 tokens.css 并做新鲜度闸门: 落后 → 打印清单 + 修复命令并退出 1(除非 allowStale) */
export function requireFreshCss(dir, { who, allowStale = false } = {}) {
  const cssPath = path.join(dir, 'slides', 'tokens.css');
  if (!fs.existsSync(cssPath)) return '';
  // 扫描上限与 check-slides / init-project / preview-page 同一道门(声明在 limits.mjs):
  // 少了这一步, 这里就是唯一一个会去读 6MB tokens.css 的入口。
  const size = fs.statSync(cssPath).size;
  if (size > MAX_SCAN_BYTES) {
    console.error(`✗ ${who}: slides/tokens.css 有 ${(size / 1e6).toFixed(1)}MB, 超过 ${MAX_SCAN_BYTES / 1e6}MB 上限, 拒绝扫描(正常项目 ≈15KB)`);
    process.exit(1);
  }
  const css = fs.readFileSync(cssPath, 'utf8');
  const bad = cssStaleIssues(css);
  if (!bad.length) return css;
  const lines = bad.map(s => `   - ${s.label}: [${s.status}] ${s.detail}`);
  if (allowStale) {
    console.warn(`⚠ ${who}: slides/tokens.css 的受管块与技能当前版不一致(--allow-stale-css 已显式跳过闸门):\n${lines.join('\n')}`);
    return css;
  }
  console.error(`✗ ${who}: slides/tokens.css 的受管块与技能当前版不一致 —— 画面会照出, 但用的是旧 CSS(新类静默无样式, 全程不报错):\n${lines.join('\n')}`);
  console.error(`  → 先修: node scripts/init-project.mjs ${dir} --upgrade-css(原地替换受管区, 不动区外的规则; 原件备份在 tokens.css.bak)`);
  console.error('  → 确实要用项目里的旧 CSS 出片: 加 --allow-stale-css 显式跳过');
  process.exit(1);
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
