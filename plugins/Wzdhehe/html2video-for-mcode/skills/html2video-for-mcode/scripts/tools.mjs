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
  // 调用方项目目录(若给了)、当前工作目录、技能自身位置的**全部祖先**(与 Node import 的模块
  // 解析同型)。只看固定两级时, 技能被深嵌在 monorepo(plugins/<owner>/<name>/skills/<name>/scripts,
  // 6 层)会漏掉"仓库根明明装了 ffmpeg-static"的布局 —— 测试进程从仓库根找得到, spawn 出去的
  // asr.mjs(cwd=临时项目)却找不到, 同一套测试两种结果(发布树实测踩到, 2026-09-28)。
  // cwd 必须查(二审 P2): README 明说支持把 ffmpeg-static 装在**视频项目**里, 而 prep-image / asr
  // 是从项目目录被调用的 —— 不查 cwd 就会"项目里明明装了却报找不到"
  const upDirs = start => {
    const out = []; let d = path.resolve(start);
    for (let i = 0; i < 12; i++) {
      out.push(d);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    return out;
  };
  const anchors = [...new Set([process.env.KIT_PROJECT_DIR, projectDir, process.cwd(), ...upDirs(SELF_DIR)]
    .filter(Boolean))];
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
  // 复查修正(1.7.5): "real 是 root 祖先也放行"的回退只留给 **root 尚不存在** 的场景(合法:
  // 走过 root 停在已存在祖先)。root 已存在时, 该回退会被"项目内链接指向项目父目录"穿透 ——
  // 链接的 realpath 是 root 的祖先, 回退放行后, 链接下的**新文件**就写到项目外了(实测复现)。
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
    // root 侧与 probe 侧必须用**同一套**规范化(见 canonicalRoot: 七审 blocker 2 的修正)。
    const { exists: rootExists, real: realRoot } = canonicalRoot(root, where);
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
    if (real !== realRoot && !inside(realRoot, real) && !(rootExists ? false : inside(real, realRoot))) {
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
  // root 侧与 probe 侧同一套规范化(canonicalRoot, 见其注释里的七审 blocker 2 修正)。
  const { exists: rootExists, real: realRoot } = canonicalRoot(root, where);
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
  // "probe 是 root 的祖先"只在 **root 尚不存在** 时合法(root 到目标之间的段都还没建,
  // 落盘只会在 root 下新建); root 已存在时绝不放行 —— 那正是"项目内链接指向项目父目录"的
  // 穿透形状(与 safeRel 的同一处收敛, 1.7.5 已把 safeRel 侧钉死)。
  if (real !== realRoot && !inside(realRoot, real) && !(rootExists ? false : inside(real, realRoot))) {
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

// ── ffprobe 探测(第十三轮 review 去重: duration 三处、尺寸两处逐字重复) ──────────
// 失败统一返回 null —— 各调用方自己决定报错还是回退, 与既有实现逐字等价。
export function probeDuration(ffprobe, file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  const d = parseFloat(r.stdout.trim().split('\n')[0]);
  return Number.isFinite(d) ? d : null;
}
export function probeSize(ffprobe, file) {
  const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    { encoding: 'utf8', windowsHide: true });
  const m = (r.stdout || '').trim().match(/(\d+),(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

// ── 对时边界匹配(单一来源, check-timing 消费) ────────────────────────
// 静音段对齐用**发音形态**(say ?? text)的句读标点 —— 音频里停顿跟的是朗读(1.9.12 第 25 轮:
// 按 text 对齐时, say 与 text 标点不一致 → 精确模式错位, --calibrate 把错的 start 写回)。
// 精确模式: 句读标点总数-1 == 静音段数 → 按标点累积下标对齐(最可信)。
// 最近邻模式: 否则在估算时刻 ±1s 窗内取最近的静音段末端, 时序单调; 找不到就报未测(宁缺勿错)。
const PAUSE_PUNCT = /[，,、;；:：。！？!?…]/g;
export function matchBoundaries(gaps, clauses) {
  const nBound = clauses.length - 1;
  if (nBound <= 0) return { method: 'none', meas: [] };
  const marks = clauses.map(c => ((c.say ?? c.text).match(PAUSE_PUNCT) || []).length);
  const totalMarks = marks.reduce((a, b) => a + b, 0);
  const meas = new Array(nBound).fill(null);   // 精确模式自己一份
  if (gaps.length === totalMarks - 1 || gaps.length === totalMarks) {
    let cum = 0, gi = 0;
    for (let k = 0; k < nBound; k++) {
      cum += marks[k]; // 第 k 边界 = 前 k 句累积标点数对应的那个停顿
      const idx = Math.min(cum - 1, gaps.length - 1);
      if (idx >= gi) { meas[k] = gaps[idx].end; gi = idx + 1; }
    }
    if (meas.every(v => v != null)) return { method: 'exact', meas };
  }
  // 最近邻: **重新分配**, 绝不从上面那份里继承已填值 —— 继承的话写回的就是"精确 + 最近邻"的
  // 混合值, 而 method 只报 nearest, 属于谎报方法(2026-09-18 复查 D1: 精确模式失败即走到此处)。
  const near = new Array(nBound).fill(null);
  const est = clauses.slice(1).map(c => c.start);
  let lastUsed = -1;
  for (let k = 0; k < nBound; k++) {
    let best = -1, bestD = Infinity;
    for (let g = lastUsed + 1; g < gaps.length; g++) {
      const d = Math.abs(gaps[g].end - est[k]);
      if (d < bestD && d <= 1.0) { bestD = d; best = g; }
    }
    if (best > -1) { near[k] = gaps[best].end; lastUsed = best; }
  }
  // 只有**每条边界都有实测**才叫 nearest(可写回); 有缺口的报 sparse, 只展示不写回
  return { method: near.every(v => v != null) ? 'nearest' : 'sparse', meas: near };
}

// ── 字幕关键帧(单一来源) ─────────────────────────────────────────────
// capture 的页面注入(生成 CSS)与窗口自检(算重叠)都从这里取数, 防两处算式漂移。
// 偏移是"占整张时长的百分比"(0–100)。b 夹在 [a+0.5, 100]: 下一句开口太近时窗口至少留 0.5%,
// 最后一句起点太晚时不得越过 100%(CSS 关键帧选择器只认 [0%,100%], 越界整条被丢弃)。
export function subtitleWindows(clauses, duration) {
  const pct = x => Math.max(0, Math.min(100, (x / duration) * 100));
  return clauses.map((c, i) => {
    const a = pct(c.start);
    const b = Math.min(100, Math.max(pct(clauses[i + 1]?.start ?? duration), a + 0.5));
    return { a, b, isLast: i === clauses.length - 1 };
  });
}

// 每句一对关键帧: 0%→a 藏, a→p1 淡入, [p1,p2] 满亮, p2→b 淡出后藏到片尾。
// 两个形状约束(2026-09-22 双回归的教训, unit 测试背书):
// ①同偏移不得声明两次 —— 同偏移多次声明时后者生效, 平台会被尾帧整个吃掉
//   (灰字幕根因: 末句 b=100 时 "100.000%,100%{opacity:0}" 撞掉 "100.000%{opacity:1}", 整句缓慢淡出);
// ②两端必须隐藏 —— fill both 下 finish() 后回到 opacity:0, 封面/静帧基底图靠它保持无字幕
//   (1.9.4 曾改成"末句无尾帧"保住①, 却让终值停在 1: 最后一句被烙进封面与基底)。
// 于是末句平台收到 99.999%、尾帧单占 100%: 可见部分零淡出, 终值仍归 0。
export function subtitleKeyframes(clauses, duration) {
  return subtitleWindows(clauses, duration).map(({ a, b, isLast }, i) => {
    const win = b - a;
    const fin = Math.min(Math.max(0.15, win * 0.06), 0.8);
    const fout = isLast ? 0 : Math.min(Math.max(0.15, win * 0.06), 0.8);
    const p1 = isLast ? Math.min(a + fin, 99.999) : Math.min(a + fin, b);
    const p2 = isLast ? 99.999 : Math.max(p1, b - fout);
    return `@keyframes kit-sub-${i}{0%,${a.toFixed(3)}%{opacity:0}` +
      `${p1.toFixed(3)}%,${p2.toFixed(3)}%{opacity:1}` +
      `${b.toFixed(3)}%,100%{opacity:0}}`;
  }).join('');
}

// 控制字符与双向覆盖字符剔除(2026-10-10 审计 L4): 字幕/转写文本来自不可信输入,
// OSC/ANSI 控制序列能把终端染色改标题, bidi 覆盖能让"IMDb"之类显示成别的词。
// 注意: **不**动普通空格与制表, 也不做大小写或符号改写 —— 只剔掉不可见控制面。
export function stripControlChars(s) {
  return String(s ?? '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u202c\u202d\u202e]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\r\n?/g, '\n');
}

// ffmpeg concat 列表的路径守卫(2026-10-10 审计 L6): concat 解复用器用 av_get_token 读条目,
// 单引号里**放不下**一个单引号, shell 风格的 '\'' 在这里不是转义 —— 路径被悄悄改坏比报错更糟。
// 路径 = 用户自选项目目录 + 受监 id, 撞上就明确失败, 不产出被改坏的列表文件。
export function assertConcatPathSafe(p, { where = 'concat 列表' } = {}) {
  const s = String(p);
  if (/['\r\n]/.test(s)) {
    throw new Error(`${where}: 路径里不能有单引号或换行(ffmpeg concat 列表无法安全表示): ${s}\n   请把项目目录或文件名里的 ' 去掉, 或在 script.json 里改用 transition:"xfade"`);
  }
  return s;
}

// ── 字幕文本净化 + SRT 生成(单一来源, 2026-10-10 独立安全审计 H2/L4) ──
// clause 文案是**不可信输入**, 而 out/subs.srt 是要上传给平台的成品: 文本里带换行就能
// 伪造成额外的 cue/时间码(实测 2 条 clause 产出 3 个时间码, 伪造块随视频上屏), 控制字符
// 与 bidi 覆盖字符还能污染播放器/清单的显示。
// 规则(**承重的一步是最后那条空白折叠** —— JS 的 \s 含 \r \n \u2028 \u2029, 所以换行/CR/
// 段分隔符都在这一步被折成空格, cue 必然单行): bidi 与控制字符剔除、行内 "-->" 中和、限长。
// 烧录字幕那条路不需要同一套处理: 那里的文本经 DOM textContent 写入, 没有任何标记语义。
export function sanitizeCaptionText(s, { maxLen = 400 } = {}) {
  return String(s ?? '')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
    // 行内残留的 "-->" 也要中和: 结构已经安全, 但宽松的 SRT 解析器(ffmpeg 的 srt
    // demuxer 会**扫行**找时间码)可能把正文里的时间码样式当新 cue 起点。
    // 字幕几乎不需要字面 "-->", 换成箭头语义不变、歧义消失。
    .replace(/-->/g, '→')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

const srtTime = s => {
  const ms = Math.round((s % 1) * 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

// timings.json → SRT 正文。测试直接调它, 所以**别**在这里做 CLI 副作用。
export function buildSrt(timings) {
  const cues = [];
  let idx = 1, cum = 0;
  for (const t of timings?.slides ?? []) {
    if (Array.isArray(t.clauses)) {
      for (let i = 0; i < t.clauses.length; i++) {
        const c = t.clauses[i];
        const start = cum + c.start;
        const end = cum + (t.clauses[i + 1]?.start ?? t.duration);
        const main = sanitizeCaptionText(c.text);
        const second = sanitizeCaptionText(c.text2);
        if (!main && !second) continue;
        if (end - start < 0.05) continue;
        cues.push(`${idx++}\n${srtTime(start)} --> ${srtTime(end)}\n${main}${second ? '\n' + second : ''}\n`);
      }
    }
    cum += t.duration;
  }
  return { text: cues.join('\n'), count: cues.length };
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

// root 侧的规范化(safeRel / assertContained 共用一份 —— 逐字重复两份正是审查点名的地方):
// 规则**只有一条**: 必须与 probe 侧同规则, 否则同名不同写法的同一目录会被比成"越界"。
//   · root 已存在 → realpath(root); 解不开就 fail closed(解不开就不能证明它不是指向外面的链接)
//   · root 尚不存在 → canonicalPath: 最深已存在祖先的 realpath + 未创建的尾部
//     (macOS 上 /var/… 与 /private/var/… 是同一目录的两种写法, 拿未规范化字符串去比
//      probe 的 realpath 会把项目内合法路径判成越界 —— 官方 CI 的 macOS 实测过)
// 返回 { exists, real }; exists 让调用方决定"root 未建时容忍祖先 probe"这条兜底是否生效。
export function canonicalRoot(root, where = 'path') {
  if (!fs.existsSync(root)) return { exists: false, real: canonicalPath(root) };
  try {
    return { exists: true, real: fs.realpathSync(path.resolve(root)) };
  } catch {
    console.error(`✗ ${where} 无法解析项目目录真实路径: ${root}(realpath 失败)`);
    process.exit(1);
  }
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
// ── 字幕条(.kit-sub)几何 —— 唯一来源 ─────────────────────────────────
// capture 注入的字幕胶囊: 宽 = 画布宽 × 0.729167、左右 padding 34px、字号 40px, 其中字号与
// padding 再乘 --sub-scale = clamp(W/1920, 0.75, 1.25)。行宽(全宽字) = (0.729167·W − 2·34·s)/(40·s·emPer):
// 中文 1080≈24 字、1920≈33 字、2560≈35 字 —— 2026-09-23 复核: 缩放带钳位, 按宽度线性外推是错的
// (1.9.9 的 18×W/1080 在 1080 过报 27%、2560 漏报真折行)。emPer = 单字宽按 em 折算(中文全宽 1, 拉丁 ≈0.44)。
// 2026-09-28 实测勘误(Mavis A/B): 这些行宽值是 width:max-content 生效后的**设计值** —— 旧实现
// left:50% 的绝对定位可用宽度只有画布一半(1920→960px), max-width 永远够不到, 实际 22 字就折行;
// 修复后设计值与实测一致(见 subPillCss 的 width:max-content)。
export const SUB_GEOMETRY = { boxW: 0.729167, padPx: 34, padYPx: 12, fontPx: 40, radiusPx: 14, bottomFrac: 0.077778, sub2Em: 0.74, baseW: 1920 };
export const subScale = width => Math.min(1.25, Math.max(0.75, (width ?? SUB_GEOMETRY.baseW) / SUB_GEOMETRY.baseW));
export function subLineCap(width, emPer = 1) {
  const w = width ?? SUB_GEOMETRY.baseW;
  const s = subScale(w);
  return Math.max(8, Math.floor((SUB_GEOMETRY.boxW * w - 2 * SUB_GEOMETRY.padPx * s) / (SUB_GEOMETRY.fontPx * s * emPer)));
}

// .kit-sub 胶囊样式(单一来源: capture 的页面注入与几何测试共用; 常量全部来自 SUB_GEOMETRY)。
// width:max-content 是硬约束, 不是优化: left:50% 的绝对定位元素 shrink-to-fit 的可用宽度
// = 包含块宽 − left 偏移 = 画布的一半(1920→960px), transform 只位移不改布局宽度 ——
// 于是 max-width: 1400px 永远够不到, 字幕提前一半折行、双行胶囊侵占到距底 230px 压住
// 图注/免责(2026-09-28 A/B 实测: 22 句 8 句折错; 加 width:max-content 后 0 折行, 恒单行 170px)。
// 通用教训: left:50%+translateX(-50%) 居中与 max-width 互斥; 要"居中+能撑满"必须显式
// width:max-content, 或改用 left:0;right:0;margin-inline:auto;max-width:<设计值>。
export function subPillCss(geom = SUB_GEOMETRY) {
  return '.kit-sub{position:absolute;left:50%;bottom:calc(var(--stage-h, 1080px) * ' + geom.bottomFrac + ');transform:translateX(-50%);width:max-content;'
    + 'max-width:calc(var(--stage-w, 1920px) * ' + geom.boxW + ');'
    + 'background:var(--sub-bg, rgba(12,12,16,.62));color:var(--sub-fg, #fff);'
    + 'border:var(--sub-ring, 0 solid transparent);'
    + 'font-size:calc(' + geom.fontPx + 'px * var(--sub-scale, 1));line-height:1.5;'
    + 'padding:calc(' + geom.padYPx + 'px * var(--sub-scale, 1)) calc(' + geom.padPx + 'px * var(--sub-scale, 1));'
    + 'border-radius:calc(' + geom.radiusPx + 'px * var(--sub-scale, 1));text-align:center;opacity:0;z-index:9;pointer-events:none;'
    + 'box-shadow:0 2px 12px rgba(0,0,0,.18)}'
    + '.kit-sub-2{font-size:' + geom.sub2Em + 'em;opacity:.88;margin-top:6px;letter-spacing:.01em}';
}

// 字幕带顶部(距画布底的距离): check-slides 的闸门与 authoring 的安全区共用同一公式。
// 单行 = bottom 偏移(不随 --sub-scale 缩放, CSS 里就是这么写的) + 胶囊高(字号×1.5 行高
// + 上下 padding, 随缩放) + 2px 渲染余量(实测单行 86px vs 公式 84px)。
// 双语(text2)再叠一行 .kit-sub-2(0.74em + 6px margin)。
export function subBandTop(height, width, { bilingual = false } = {}) {
  const s = subScale(width);
  const g = SUB_GEOMETRY;
  const pill = (g.padYPx * 2 + g.fontPx * 1.5) * s + 2;
  const pill2 = pill + (g.fontPx * g.sub2Em * 1.5 + 6) * s + 2;
  return Math.round(g.bottomFrac * (height ?? 1080) + (bilingual ? pill2 : pill));
}

// ── CLI 入口守卫(单一来源) ───────────────────────────────────────────
// "被 import 不跑主流程, 直接执行才跑" 的判定要稳健: 两侧都取 realpath —— 经符号链接/挂载点
// 调用时 argv[1] 是调用路径而 import.meta.url 是归一后的路径, 纯字符串比较恒假 → 脚本静默
// no-op(exit 0 无输出; 2026-09-22 云沙箱实测, 排查花了 10 分钟)。
// 另注: `node -e "import('...')"` 走的是 import 语义, 不跑 main(设计如此) —— CLI 请 `node <脚本> ...`。
export function isMainModule(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  const realpathOf = p => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
  const meta = fileURLToPath(metaUrl);
  const eq = process.platform === 'win32'
    ? (a, b) => a.toLowerCase() === b.toLowerCase()
    : (a, b) => a === b;
  if (eq(realpathOf(entry), realpathOf(meta))) return true;
  // 同名兜底: realpath 归一不了的**未知**路径形态按直接执行处理 —— 这是拿"带提示的多跑一次"
  // 换"静默不跑"(后者实测烧掉 10 分钟)。命中必须大声宣告, 不许再静默; 误判方向(被同名入口
  // import)本脚本随后也会响亮报错, 影响面只有 preview-page 一个消费者。
  if (eq(path.basename(entry), path.basename(meta))) {
    console.error(`⚠ 入口判定经同名兜底(realpath 未归一: ${entry} vs ${meta}) — 按直接执行处理`);
    return true;
  }
  return false;
}

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
