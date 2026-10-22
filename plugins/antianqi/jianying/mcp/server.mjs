#!/usr/bin/env node
/**
 * jianying · MCP server（stdio，8 个动词）
 *
 * 设计纪律（见 docs/最终架构与开发路线.md）：
 *   ① skill 不感知执行路径 —— 本 server 内部决定"离线写盘"还是"活体 edit 域"，对 skill 透明
 *   ② 机械验证与语义验证分离 —— 本 server 只做【机械验证】（护栏 + 探针 + 断言）
 *   ③ 判据优先 —— 入参用 schema 硬校验，非法参数直接拒绝，不让"静默失效"发生
 *
 * 零 npm 依赖；路径全部走 JYAI_HOME / $HOME / %LOCALAPPDATA% 解析，绝不写死盘符。
 */
import { createInterface } from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const JYAI = process.env.JYAI_HOME || path.join(os.homedir(), 'JYAI');
const TOOLS_DIR = path.join(HERE, 'tools');
const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');

/* ---------------------------------------------------------------- 路径解析 */
function jyaiTool(name) {
  const p = path.join(JYAI, 'tools', name);
  if (!fs.existsSync(p)) throw new Error(`JYAI 工具不存在: ${p}（请设 JYAI_HOME 指向 JYAI 仓库）`);
  return p;
}
function jyaiData(...parts) {
  return path.join(JYAI, ...parts);
}
function cacheDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'JianyingPro', 'User Data', 'Cache');
}

/* 可执行文件解析：env → PATH → 常见安装位置（绝不写死盘符） */
function which(cmd, extra = []) {
  if (process.env[cmd.toUpperCase().replace(/-/g, '_')]) return process.env[cmd.toUpperCase().replace(/-/g, '_')];
  const pathExt = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const ext of ['', ...pathExt]) {
      const p = path.join(d, cmd + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  for (const p of extra) { try { if (fs.existsSync(p)) return p; } catch { /* ignore */ } }
  return cmd;   // 交给 spawn 报错
}
const FFMPEG = () => which('ffmpeg', [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'ffmpeg.exe'),
]);
const PYTHON = () => process.env.JYAI_PYTHON || which('python', [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Python314', 'python.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python314', 'python.exe'),
]);

/* ------------------------------------------------- 轻量 JSON Schema 校验 */
/* 只支持我们 schema 里用到的关键字：type/properties/required/additionalProperties/ */
 /* enum/minimum/maximum/items/patternProperties/default/oneOf-任意键 */
const ERR = [];
function val(v, s, pathStr) {
  if (!s || typeof s !== 'object') return;
  if (s.type === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) { ERR.push(`${pathStr}: 期望 object`); return; }
    for (const r of s.required || []) if (!(r in v)) ERR.push(`${pathStr}: 缺少必填 "${r}"`);
    const props = s.properties || {};
    for (const [k, vv] of Object.entries(v)) {
      if (props[k]) { val(vv, props[k], `${pathStr}.${k}`); continue; }
      let handled = false;
      if (s.patternProperties) {
        for (const [re, sub] of Object.entries(s.patternProperties)) {
          if (new RegExp(re).test(k)) { val(vv, sub, `${pathStr}.${k}`); handled = true; break; }
        }
      }
      if (handled) continue;
      if (s.additionalProperties === false) ERR.push(`${pathStr}.${k}: 未知键（不合法）`);
      else if (typeof s.additionalProperties === 'object') val(vv, s.additionalProperties, `${pathStr}.${k}`);
    }
  } else if (s.type === 'array') {
    if (!Array.isArray(v)) { ERR.push(`${pathStr}: 期望 array`); return; }
    if (s.items) v.forEach((it, i) => val(it, s.items, `${pathStr}[${i}]`));
  } else if (s.type === 'number' || s.type === 'integer') {
    if (typeof v !== 'number' || Number.isNaN(v)) { ERR.push(`${pathStr}: 期望 number`); return; }
    if (s.type === 'integer' && !Number.isInteger(v)) ERR.push(`${pathStr}: 期望 integer`);
    if (s.minimum !== undefined && v < s.minimum) ERR.push(`${pathStr}: ${v} < 最小 ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) ERR.push(`${pathStr}: ${v} > 最大 ${s.maximum}`);
  } else if (s.type === 'string') {
    if (typeof v !== 'string') { ERR.push(`${pathStr}: 期望 string`); return; }
    if (s.enum && !s.enum.includes(v)) ERR.push(`${pathStr}: "${v}" 不在允许集合 [${s.enum.join(', ')}]`);
  } else if (s.type === 'boolean') {
    if (typeof v !== 'boolean') ERR.push(`${pathStr}: 期望 boolean`);
  }
}
function validate(args, schema) {
  ERR.length = 0;
  val(args, schema, 'args');
  if (ERR.length) throw new Error(`入参不合法：\n  - ${ERR.join('\n  - ')}`);
  // 填 default
  const out = { ...args };
  const fill = (o, s) => {
    if (!s || s.type !== 'object' || !o) return;
    for (const [k, sub] of Object.entries(s.properties || {})) {
      if (!(k in o) && sub && 'default' in sub) o[k] = sub.default;
    }
  };
  fill(out, schema);
  return out;
}

/* ------------------------------------------------------------ 插件状态目录 */
/* mcode 注入 ${PLUGIN_DATA}（每个实例独立）；没有则用临时目录。
   ★ 动词之间靠它共享状态：draft_open 记 session → draft_patch 存改后草稿快照 → draft_commit 取快照落盘。 */
function stateDir() {
  return process.env.PLUGIN_DATA || path.join(os.tmpdir(), 'jianying-plugin-state');
}
function stateFile(sid) { return path.join(stateDir(), `session-${sid}.json`); }
function snapshotFile(sid) { return path.join(stateDir(), `snapshot-${sid}.json`); }
function writeState(sid, obj) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(sid), JSON.stringify(obj), 'utf8');
}
function readState(sid) {
  const p = stateFile(sid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
/* 素材路径重定位（照 jyai-live.mjs 的 relocateMaterialPaths）：草稿搬过家后 path 失效 ⇒ 指回草稿目录内 */
function relocateMaterialPaths(draft, draftDir) {
  const fixes = [];
  const materials = draft?.materials;
  if (!materials || typeof materials !== 'object') return fixes;
  for (const [kind, list] of Object.entries(materials)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const mp = typeof m.media_path === 'string' ? m.media_path : null;
      const p = typeof m.path === 'string' ? m.path : null;
      if (!mp || !p) continue;
      if (/^[A-Za-z]:[\\/]/.test(mp) || mp.startsWith('/')) continue;   // 绝对路径
      if (fs.existsSync(p)) continue;                                  // 已有效
      const candidate = path.join(draftDir, mp);
      if (!fs.existsSync(candidate)) continue;
      const sep = /\\/g.test(p) && !/\//.test(p) ? '\\' : '/';
      const newPath = candidate.replace(/[\\/]/g, sep);
      fixes.push({ kind, from: p, to: newPath, media_path: mp });
      m.path = newPath;
    }
  }
  return fixes;
}

/* ------------------------------------------------------------ 管道直连（edit 域）*/
/* 官方 behavior 操作是【带命名空间】的（segment.move / video.setVolume / track.add …），
   不是裸名。权威清单：docs/HEADLESS-VERIFY.md §4.8.2（27 个，实测 27/27）。 */
const BS = String.fromCharCode(92);
const PIPE_PREFIX = `${BS}${BS}.${BS}pipe${BS}videoeditor-runtime-`;

/* 每个 op 的【已知必填项】（从官方实测报错反推，如 video.add→video_path_required ⇒ params.path 必填） */
const OP_REQUIRED = {
  'video.add': ['path'],
  'text.add': ['content'],
  'track.mute': ['trackId'],
  'track.delete': ['trackId'],
  'segment.move': ['segmentId'],
  'segment.setTimeRange': ['segmentId'],
  // ★ 2026-10-21 实测确认（视频/音频 AI 效果类）
  'video.denoiseOn': ['segmentId'],
  'video.denoiseOff': ['segmentId'],
  'audio.setVocalBeautify': ['segmentId'],
  'audio.updateVocalBeautify': ['segmentId'],
  'audio.removeVocalBeautify': ['segmentId'],
  'audio.setVoiceEffect': ['segmentId'],
  'audio.setVoiceEffectParams': ['segmentId'],
  'audio.clearVoiceEffect': ['segmentId'],
  'audio.setVocalSeparation': [],
  'segment.setDescription': ['segmentId'],
  'segment.updateLayout': ['layout'],
  'segment.innerReplace': ['replacement'],
};

function vePipePid() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='vebun.exe'\" | Select-Object -First 1 -ExpandProperty ParentProcessId"],
      { encoding: 'utf8', timeout: 20000 }).trim();
    const n = Number(out);
    if (Number.isInteger(n) && n > 0) return n;
  } catch { /* ignore */ }
  throw new Error('解析 vebun 父进程 pid 失败（剪映在跑吗？）');
}
function pipeOnce(pid, domain, operation, params = {}, targetId, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const env = {
      protocolVersion: 1,
      id: `jy-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      domain, operation, params, priority: 'interactive',
    };
    if (targetId) env.targetId = targetId;
    const s = net.connect(`${PIPE_PREFIX}${pid}`);
    let buf = '', done = false;
    const fin = (r) => { if (!done) { done = true; try { s.destroy(); } catch { /* ignore */ } resolve(r); } };
    const t = setTimeout(() => fin({ outcome: 'TIMEOUT', raw: buf }), timeoutMs);
    s.on('connect', () => { try { s.write(JSON.stringify(env) + '\n'); } catch (e) { clearTimeout(t); fin({ outcome: 'WRITE_ERROR', error: String(e) }); } });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) { clearTimeout(t); fin({ outcome: 'RESPONSE', raw: buf.slice(0, nl) }); }
    });
    s.on('error', (e) => { clearTimeout(t); fin({ outcome: 'CONNECT_ERROR', error: e.code || e.message }); });
    s.on('close', () => { clearTimeout(t); fin({ outcome: buf ? 'RESPONSE' : 'CLOSED_EMPTY', raw: buf }); });
  });
}
async function editCall(op, params, sessionId) {
  const pid = vePipePid();
  const r = await pipeOnce(pid, 'edit', op, params, sessionId, 30000);
  if (r.outcome === 'CONNECT_ERROR') throw new Error(`管道连不上：${r.error}（剪映在跑吗？）`);
  if (r.outcome === 'TIMEOUT') throw new Error(`edit/${op} 超时`);
  const parsed = JSON.parse(r.raw);
  if (parsed.ok === false) throw new Error(`edit/${op} 被拒：${JSON.stringify(parsed.error)}`);
  const res = parsed.result || {};
  if (res.error) throw new Error(`edit/${op} 失败：${res.error}`);   // 官方原样错误（如 segment_id_required）
  return res;
}

/* ------------------------------------------------------------- 工具执行 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, {
      cwd: opts.cwd || PLUGIN_ROOT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      windowsHide: true,
    });
    const chunks = [], echunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => echunks.push(d));
    p.on('error', (e) => resolve({ code: -1, stdout: opts.binary ? Buffer.alloc(0) : '',
      stderr: String(e) }));
    p.on('close', (code) => {
      const so = Buffer.concat(chunks), se = Buffer.concat(echunks);
      resolve({ code,
        stdout: opts.binary ? so : so.toString('utf8'),
        stderr: opts.binary ? se.toString('utf8') : se.toString('utf8') });
    });
  });
}
const ok = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }], isError: true });

function shaTree(dir) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(p));
        out.push(`${path.relative(dir, p).replace(/\\/g, '/')}:${h.digest('hex').slice(0, 16)}`);
      }
    }
  };
  walk(dir);
  return out;
}

/* --------------------------------------------------------------- 8 个动词 */
const IMPL = {
  async draft_open(a) {
    if (a.allowReal && a.copy !== false) {
      throw new Error('allowReal=true 时必须显式 copy=false（开真草稿）');
    }
    const copy = a.copy !== false;
    const args = ['open', a.draft];
    if (copy) args.push('--copy');
    const r = await run(process.execPath, [jyaiTool('jyai-live.mjs'), ...args]);
    if (r.code !== 0) throw new Error(`打开草稿失败：\n${r.stderr || r.stdout}`);
    const txt = r.stdout;
    // 解析出 sessionId / draft / dir（draft_patch 需要 sessionId）
    const sid = (txt.match(/ve-session-\d+/) || [])[0] || null;
    const dir = (txt.match(/dir\s+(\S+)/) || [])[1] || null;
    const dname = (txt.match(/draft\s+(\S+)/) || [])[1] || null;
    if (!sid) throw new Error(`打开草稿的输出里找不到 sessionId：\n${txt}`);
    // 记状态（供 draft_patch / draft_commit 共享）
    const draftDir = dir || null;
    const st = { sessionId: sid, draft: dname, draftDir, copied: copy,
                 draftPath: draftDir ? path.join(draftDir, 'draft_content.json') : null,
                 openedAt: new Date().toISOString() };
    writeState(sid, st);
    return ok({ copy, sessionId: sid, draft: dname, dir: draftDir, raw: txt });
  },

  async draft_read(a) {
    // ★ 优先读【会话内存快照】（draft_patch 存的那份）；没有才读磁盘。
    //   否则会出现：patch 改了会话内存，read 却读到没落盘的磁盘 ⇒ 回读拿到旧草稿 ⇒ 编排全错。
    let parsed = null, source = 'disk';
    if (a.sessionId) {
      const snapP = snapshotFile(a.sessionId);
      if (fs.existsSync(snapP)) {
        try { parsed = JSON.parse(fs.readFileSync(snapP, 'utf8')); source = 'session'; } catch { /* ignore */ }
      }
    }
    if (!parsed) {
      const args = ['read', '--json'];
      if (a.path) {
        args.push('--path', a.path);
        // ★ 必须带 --root：不带的话官方 readFile 解析不出 workspace ⇒ 静默返回空
        //   （2026-10-21 实测：exists=undefined chars=0）⇒ 根目录默认取 path 的上级目录
        const root = a.root || path.dirname(a.path);
        if (root) args.push('--root', root);
      }
      const r = await run(process.execPath, [jyaiTool('jyai-live.mjs'), ...args]);
      if (r.code !== 0) throw new Error(`读取草稿失败：\n${r.stderr || r.stdout}`);
      // jyai-live read 会在 JSON 之前打一行状态（exists=... encrypted=... cipherType=...）⇒ 剥掉
      const i = r.stdout.indexOf('{');
      const body = i >= 0 ? r.stdout.slice(i) : r.stdout;
      try { parsed = JSON.parse(body); } catch { return ok(r.stdout); }
    }
    if (parsed) {
      // 附一份"好用的摘要"：track/segment 的 id 与时间范围（供 skill 直接用）
      const summary = { source, tracks: (parsed.tracks || []).map((t) => ({
        type: t.type, id: t.id, segments: (t.segments || []).map((s) => ({
          id: s.id, target_timerange: s.target_timerange, material_id: s.material_id,
        })),
      })) };
      return ok({ draft: parsed, summary });
    }
    return ok('(空)');
  },

  async draft_patch(a) {
    // 护栏：已知必填项本地先拦（不白跑一次官方调用）
    const need = OP_REQUIRED[a.op];
    if (need) {
      const p = a.params || {};
      const miss = need.filter((k) => p[k] === undefined || p[k] === null || p[k] === '');
      if (miss.length) throw new Error(`op "${a.op}" 缺少必填参数：${miss.join(', ')}（放在 params 里）`);
    }
    if (!a.sessionId) throw new Error('缺少 sessionId（先调 draft_open 拿 session）');
    const res = await editCall(a.op, a.params || {}, a.sessionId);
    // ★ 官方 edit 响应里的 diff.operations[0].value = 【改后的完整草稿】
    //   ⇒ 存成快照，供 draft_commit 落盘（动词之间靠插件状态目录共享状态）
    const ops = res.diff?.operations || [];
    const full = ops.find((o) => o.entity === 'draft' && o.path === '/')?.value
      || ops.find((o) => o.value && typeof o.value === 'object' && o.value.tracks)?.value;
    let snapshot = null;
    if (full) {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(snapshotFile(a.sessionId), JSON.stringify(full), 'utf8');
      snapshot = snapshotFile(a.sessionId);
    }
    return ok({
      op: a.op,
      accepted: res.accepted !== false,
      actionKey: res.actionKey,
      baseRevision: res.diff?.baseRevision,
      changedPaths: ops.map((o) => o.path),
      snapshot, snapshotSaved: !!snapshot,
    });
  },

  async draft_commit(a) {
    const sid = a.sessionId;
    if (!sid) throw new Error('缺少 sessionId（先调 draft_open）');
    const st = readState(sid);
    if (!st) throw new Error(`找不到 session ${sid} 的状态（先调 draft_open）`);
    const snapP = snapshotFile(sid);
    if (!fs.existsSync(snapP)) {
      throw new Error('没有改后草稿快照（先用 draft_patch 改一处再落盘）');
    }
    const draft = JSON.parse(fs.readFileSync(snapP, 'utf8'));

    // 护栏 1：真草稿 sha 前后比对
    let before = null;
    if (a.realDraft) before = shaTree(a.realDraft);

    // 护栏 2：素材路径重定位（草稿搬过家后 path 失效 ⇒ 指回草稿目录内）
    const draftDir = st.draftDir || a.draftDir || '';
    const fixes = relocateMaterialPaths(draft, draftDir);
    const target = st.draftPath || path.join(draftDir, 'draft_content.json');
    const rootPath = draftDir || path.dirname(target);

    // 落盘：draft/writeFile 传明文 JSON，服务端写时自动加密（sealed on write）
    const r = await pipeOnce(vePipePid(), 'draft', 'writeFile',
      { path: target, rootPath, content: JSON.stringify(draft) }, undefined, 60000);
    if (r.outcome !== 'RESPONSE') throw new Error(`writeFile 失败：${r.outcome}`);
    const parsed = JSON.parse(r.raw);
    if (parsed.ok === false) throw new Error(`writeFile 被拒：${JSON.stringify(parsed.error)}`);
    const wr = parsed.result || {};

    // 护栏 3：真草稿必须零改动
    let realOk = null;
    if (a.realDraft) {
      const after = shaTree(a.realDraft);
      realOk = before.length === after.length && before.every((x, i) => x === after[i]);
      if (!realOk) throw new Error('★ 真草稿被改动了（sha 不一致）——已判定失败');
    }
    return ok({
      committed: true, encrypted: wr.encrypted, cipherType: wr.cipherType,
      relocated: fixes.length, target, realDraftUnchanged: realOk,
    });
  },

  async render_frames(a) {
    const args = [jyaiTool('jyai-b-render.mjs'), '--draft', a.draft, '--out', a.outDir];
    if (a.fps) args.push('--fps', String(a.fps));
    const r = await run(process.execPath, args);
    if (r.code !== 0) throw new Error(`渲染失败：\n${r.stderr || r.stdout}`);
    return ok(r.stdout);
  },

  async grade_apply(a) {
    // 护栏：spec 的键必须都在 schema 的 properties 里（schema 校验已做，这里再兜一层）
    const specFile = path.join(a.outDir, '_spec.json');
    fs.mkdirSync(a.outDir, { recursive: true });
    fs.writeFileSync(specFile, JSON.stringify(a.spec, null, 2), 'utf8');
    const py = PYTHON();
    const args = [jyaiTool('jyai-grade-render.py'),
      '--src', a.src, '--outdir', a.outDir, '--spec', specFile,
      '--frames', String(a.frames ?? 12)];
    if (a.noLut) args.push('--no-lut');
    const r = await run(py, args);
    if (r.code !== 0) throw new Error(`调色失败：\n${r.stderr || r.stdout}`);
    // 护栏：逐节点生效探针（节点为 0 ⇒ 判失败）
    const cmp = path.join(a.outDir, 'grade-compare.json');
    if (!fs.existsSync(cmp)) throw new Error('没出 grade-compare.json ⇒ 无法判生效');
    const j = JSON.parse(fs.readFileSync(cmp, 'utf8'));
    const probe = j.node_effect_probe || {};
    const dead = Object.entries(probe).filter(([k, v]) => k !== '_full_chain' && !(Number(v) > 0)).map(([k]) => k);
    if (dead.length) throw new Error(`★ 下列节点没有生效（探针为 0）：${dead.join(', ')} —— 判定失败`);
    if (!(Number(j.grade_change_mad) > 0)) throw new Error('★ 调色改变量为 0 ⇒ 判定失败');
    return ok({ out: j.out10, outLut: j.out10_lut, gradeChangeMad: j.grade_change_mad, probe });
  },

  async audio_mix(a) {
    const r = await run(process.execPath, [jyaiTool('jyai-audio-mix.mjs'),
      '--draft', a.draft, '--video', a.video, '--out', a.out]);
    if (r.code !== 0) throw new Error(`混音失败：\n${r.stderr || r.stdout}`);
    return ok(r.stdout);
  },

  // ★ 一条命令出成片：官方渲染器出画面（自带强度型调色）→ 可选我们的 3D LUT（曲线类）
  //   → 我们的混音链（音量/淡入淡出/降噪/响度归一）→ ffmpeg 编码 → 带断言的验收。
  //   官方导出档（ExportService / mojo / 官方编码器）不在我们的可达面上（§91.3 / §92.2），
  //   所以出片走这条自制链；它拿到的画面就是官方渲染器的输出，不是我们自己算的。
  async make_film(a) {
    const args = [jyaiTool('jyai-make-film.mjs'), '--draft', a.draft, '--out', a.outDir];
    if (a.lut) args.push('--lut', a.lut);
    if (a.grade) {
      // ★ 我们自己给曲线类调色：spec → 烘 3D LUT → 叠进出片
      //   （不依赖官方草稿侧的曲线承载 —— 官方预览渲染器本来就不认曲线/HSL/色轮）
      fs.mkdirSync(a.outDir, { recursive: true });
      const specFile = path.join(a.outDir, '_grade-spec.json');
      fs.writeFileSync(specFile, JSON.stringify({ spec: a.grade }, null, 2), 'utf8');
      const cube = path.join(a.outDir, 'grade.cube');
      const b = await run(PYTHON(), [jyaiTool('jyai-gl-bake.py'), '--params', specFile, '--out', cube]);
      if (b.code !== 0) throw new Error(`烘 3D LUT 失败：\n${b.stderr || b.stdout}`);
      args.push('--lut', cube);
    }
    if (a.denoise) args.push('--denoise', a.denoise);
    if (a.beautify) args.push('--beautify', a.beautify);
    if (a.fps) args.push('--fps', String(a.fps));
    if (a.maxFrames) args.push('--max-frames', String(a.maxFrames));
    if (a.targetLufs !== undefined) args.push('--target-lufs', String(a.targetLufs));
    const r = await run(process.execPath, args);
    if (r.code !== 0) throw new Error(`出片失败：\n${r.stderr || r.stdout}`);
    return ok(r.stdout);
  },

  async verify_diff(a) {
    // ★ max-over-frames：判据视野必须覆盖被测对象（不抽单帧）
    // ★ 多维度审片（visibility / picture / audio / timeline / draft_integrity）
    const checks = (a.checks && a.checks.length) ? a.checks : ['visibility'];
    const want = (k) => checks.includes(k);
    // ★ 条件必填：只有查画面维度才需要帧目录（只查 timeline 时可以不给）
    if ((want('visibility') || want('picture')) && (!a.beforeDir || !a.afterDir)) {
      throw new Error('查 visibility/picture 时必须给 beforeDir 与 afterDir（帧目录）');
    }
    const res = { checks: {}, requested: checks };
    const problems = [];

    // ---------- ① 画面：visibility + picture（同一趟解码里一起算）----------
    if (want('visibility') || want('picture')) {
      const list = (d) => fs.existsSync(d)
        ? fs.readdirSync(d).filter((f) => f.endsWith('.png')).sort() : [];
      const B = list(a.beforeDir), A = list(a.afterDir);
      const N = a.noiseDir ? list(a.noiseDir) : [];
      if (!B.length || !A.length) throw new Error('帧目录为空或不存在');
      if (a.noiseDir && !N.length) throw new Error('noiseDir 为空或不存在');
      const n = Math.min(B.length, A.length);
      const PNG = await importPng();
      let best = { mad: -1, frame: -1, maxAbs: 0, changed: 0 };
      let noiseBest = { mad: -1, frame: -1 };
      let changedFrames = 0, noiseChangedFrames = 0;
      // ★ 逐帧噪声（2026-10-21 实测：非确定性是【逐帧】的，不是全局的）
      const perFrameNoise = [];
      const perFrameMad = [];
      // picture 统计（after 侧全局；before 侧同步累计，用来算【增量】）
      const sum = [0, 0, 0];
      const mn = [255, 255, 255];
      const mx = [0, 0, 0];
      let clipPx = 0, overPx = 0, underPx = 0, px = 0;
      let bClipPx = 0, bOverPx = 0, bUnderPx = 0, bPx = 0;
      const beforeSum = [0, 0, 0]; let beforePx = 0;
      for (let i = 0; i < n; i++) {
        const x = await PNG.read(path.join(a.beforeDir, B[i]));
        const y = await PNG.read(path.join(a.afterDir, A[i]));
        if (x.length !== y.length) continue;
        let dsum = 0, dmx = 0, ch = 0;
        for (let k = 0; k < x.length; k++) {
          const d = Math.abs(x[k] - y[k]);
          dsum += d; if (d > dmx) dmx = d; if (d > 0) ch++;
        }
        const mad = dsum / x.length;
        perFrameMad[i] = mad;
        if (mad > 0) changedFrames++;
        if (mad > best.mad) best = { mad, frame: i, maxAbs: dmx, changed: ch };
        // ★ 噪声底：同一状态【再渲染一次】的帧 ⇒ 同态差异就是渲染器噪声
        if (N.length) {
          const z = await PNG.read(path.join(a.noiseDir, N[i]));
          if (z.length === x.length) {
            let nsum = 0;
            for (let k = 0; k < x.length; k++) nsum += Math.abs(x[k] - z[k]);
            const nmad = nsum / x.length;
            perFrameNoise[i] = nmad;
            if (nmad > 0) noiseChangedFrames++;
            if (nmad > noiseBest.mad) noiseBest = { mad: nmad, frame: i };
          }
        }
        if (want('picture')) {
          for (let k = 0; k + 2 < y.length; k += 3) {
            const r = y[k], g = y[k + 1], b = y[k + 2];
            sum[0] += r; sum[1] += g; sum[2] += b;
            if (r < mn[0]) mn[0] = r; if (r > mx[0]) mx[0] = r;
            if (g < mn[1]) mn[1] = g; if (g > mx[1]) mx[1] = g;
            if (b < mn[2]) mn[2] = b; if (b > mx[2]) mx[2] = b;
            const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
            if (hi >= 250) { clipPx++; overPx++; } else if (lo <= 5) underPx++;
            px++;
          }
          for (let k = 0; k + 2 < x.length; k += 3) {
            const r = x[k], g = x[k + 1], b = x[k + 2];
            beforeSum[0] += r; beforeSum[1] += g; beforeSum[2] += b;
            const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
            if (hi >= 250) { bClipPx++; bOverPx++; } else if (lo <= 5) bUnderPx++;
            beforePx++;
          }
        }
      }
      const th = a.threshold ?? 0.5;
      if (want('visibility')) {
        // ★ 噪声校准：官方渲染器【同态重渲染】就有噪声（实测 17/108 帧变、最差 MAD 123.55）
        //   ⇒ 裸 MAD > 0.5 毫无判别力。给了 noiseDir 就按噪声底抬高判据线。
        const noiseMad = noiseBest.mad < 0 ? null : noiseBest.mad;
        const noiseK = a.noiseK ?? 1.5;
        const calibrated = noiseMad !== null;
        // ★★★ 逐帧判据线（2026-10-21 §82 修正）
        //   实测：官方预览渲染的【非确定性是逐帧的】——同一草稿渲两遍，
        //   整片 MAD 123.55，但同一片里另一些帧只差 0.5；
        //   而且【连着抓两次同一时刻】像素就不同 ⇒ 是"每次抓帧"层面的非确定，
        //   不是"重渲染"层面的。官方 GUI 里也是这套引擎（连续播放时人眼察觉不到），
        //   但逐像素静态比对会把它放大。
        //   ⇒ 判据线必须【逐帧用自己的噪声】来定，而不是用全局最大噪声：
        //        bar_i = max(threshold, noise_i × noiseK)
        //      这样"那一帧本来就分不出"（noise_i 很大 ⇒ bar_i 更大 ⇒ 不算可见），
        //      而其它稳定帧的真实改动照常被检出。
        const frameDetail = [];
        for (let i = 0; i < n; i++) {
          const mad = perFrameMad[i];
          if (mad === undefined) continue;
          const nm = perFrameNoise[i];
          const barI = calibrated && nm !== undefined ? Math.max(th, nm * noiseK) : th;
          frameDetail.push({
            frame: i, mad, noise: nm === undefined ? null : nm, bar: barI,
            unstable: calibrated && nm !== undefined && nm > th,
            visible: mad > barI,
          });
        }
        const visibleRows = frameDetail.filter((r) => r.visible);
        const unstable = frameDetail.filter((r) => r.unstable).map((r) => r.frame);
        const bestVisible = visibleRows.length
          ? visibleRows.reduce((a, b) => (b.mad > a.mad ? b : a))
          : null;
        const bar = calibrated ? Math.max(th, noiseMad * noiseK) : th;   // 全局参考线（仅作参考）
        const visible = visibleRows.length > 0;
        const v = { maxMad: best.mad, frame: best.frame, maxAbs: best.maxAbs,
                    changedPixels: best.changed, changedFrames, totalFrames: n, threshold: th,
                    noiseMad, noiseFrame: noiseBest.frame, noiseChangedFrames, noiseK,
                    calibrated, noiseBar: bar,
                    unstableFrames: unstable,
                    unstableFrameCount: unstable.length,
                    visibleMaxMad: bestVisible ? bestVisible.mad : null,
                    visibleFrame: bestVisible ? bestVisible.frame : null,
                    visibleFrameCount: visibleRows.length,
                    frameDetail,
                    madOverNoise: noiseMad ? +(best.mad / noiseMad).toFixed(3) : null };
        v.verdict = visible ? 'PASS（改动可见）' : 'FAIL（改动在画面上不可见）';
        if (!calibrated) {
          v.note = '未校准：官方渲染器同态重渲染噪声实测可达 MAD 123.55（逐帧分布，17/108 帧变）⇒ 裸 MAD 不能单独证明"改动可见"；请补 noiseDir';
        }
        res.checks.visibility = v;
        if (!visible) {
          const shown = bestVisible ? bestVisible.mad : (calibrated ? 0 : best.mad);
          problems.push(`画面不可见：${calibrated ? '逐帧判据线下没有一帧达标' : `max MAD ${shown.toFixed(4)} ≤ 阈值 ${th}`}`
            + (calibrated ? `（全局噪声底 ${noiseMad.toFixed(4)} × ${noiseK}；不稳定帧 ${unstable.length}/${n} 帧：噪声本身就超过阈值 ⇒ 这些帧分不出改动）` : '（未校准，阈值仅 0.5）'));
        }
      }
      if (want('picture') && px > 0) {
        const mean = sum.map((s) => s / px);
        const bmean = beforePx ? beforeSum.map((s) => s / beforePx) : [0, 0, 0];
        const p = {
          afterMean: mean.map((v) => +v.toFixed(4)),
          beforeMean: bmean.map((v) => +v.toFixed(4)),
          meanDrift: mean.map((v, k) => +(v - bmean[k]).toFixed(4)),
          min: mn, max: mx,
          clipRatio: +(clipPx / px).toFixed(6),
          overRatio: +(overPx / px).toFixed(6),
          underRatio: +(underPx / px).toFixed(6),
          pixels: px,
        };
        // ★ 判据用【增量】而不是绝对值：片子里本来就有的纯白/纯黑不算"削波/死黑"，
        //   只有"被改动新推上去/压下去"的才算缺陷。
        if (beforePx) {
          p.beforeClipRatio = +(bClipPx / beforePx).toFixed(6);
          p.beforeOverRatio = +(bOverPx / beforePx).toFixed(6);
          p.beforeUnderRatio = +(bUnderPx / beforePx).toFixed(6);
          p.clipDelta = +(p.clipRatio - p.beforeClipRatio).toFixed(6);
          p.underDelta = +(p.underRatio - p.beforeUnderRatio).toFixed(6);
        }
        const clipDelta = p.clipDelta ?? 0;
        const underDelta = p.underDelta ?? 0;
        if (clipDelta > 0.02) problems.push(`高光削波【新增】${(clipDelta * 100).toFixed(2)}%（>2%）`);
        if (underDelta > 0.10) problems.push(`暗部死黑【新增】${(underDelta * 100).toFixed(2)}%（>10%）`);
        res.checks.picture = p;
      }
    }

    // ---------- ② 音频：LUFS / true peak ----------
    if (want('audio')) {
      if (!a.beforeVideo || !a.afterVideo) {
        res.checks.audio = { skipped: '需要 beforeVideo / afterVideo（mp4 路径）才能测响度' };
      } else {
        const meas = async (mp) => {
          const r = await run(FFMPEG(), ['-hide_banner', '-nostats', '-i', mp,
            '-af', 'ebur128=peak=true', '-f', 'null', '-']);
          const s = r.stderr || '';
          const I = (s.match(/^\s*I:\s*(-?[\d.]+)\s*LUFS/m) || [])[1];
          const Pk = (s.match(/^\s*Peak:\s*(-?[\d.]+)\s*dBFS/m) || [])[1];
          return { integratedLufs: I === undefined ? null : +I, truePeakDbfs: Pk === undefined ? null : +Pk };
        };
        const b = await meas(a.beforeVideo), c = await meas(a.afterVideo);
        const res2 = { before: b, after: c };
        if (c.integratedLufs !== null && Math.abs(c.integratedLufs) > 0.5) {
          res2.note = '响度未归一到 −14 LUFS（见 jianying-audio-mix）';
        }
        res.checks.audio = res2;
      }
    }

    // ---------- ③ 时间线：段数 / 轨道 / 时长 ----------
    if (want('timeline')) {
      if (!a.beforeDraft || !a.afterDraft) {
        res.checks.timeline = { skipped: '需要 beforeDraft / afterDraft（草稿 JSON 路径）' };
      } else {
        const readDraft = (p) => {
          let txt = fs.readFileSync(p, 'utf8');
          const i = txt.indexOf('{');
          if (i > 0) txt = txt.slice(i);
          try { return JSON.parse(txt); } catch { return null; }
        };
        const db = readDraft(a.beforeDraft), da = readDraft(a.afterDraft);
        if (!db || !da) res.checks.timeline = { skipped: '草稿读不出来（可能是官方加密封装）' };
        else {
          const sum = (d) => {
            const tracks = d.tracks || [];
            let segs = 0, dur = 0;
            for (const t of tracks) for (const s of (t.segments || [])) {
              segs++;
              const tr = s.target_timerange || {};
              dur = Math.max(dur, (tr.start || 0) + (tr.duration || 0));
            }
            return { tracks: tracks.length, segments: segs, durationUs: dur, draftDurationUs: d.duration };
          };
          const sb = sum(db), sa = sum(da);
          // ★ 逐段字段差：语义证据（"我到底改了什么"），不依赖像素
          const segMap = (d) => {
            const m = new Map();
            for (const t of (d.tracks || [])) for (const s of (t.segments || [])) m.set(s.id, s);
            return m;
          };
          const mb = segMap(db), ma = segMap(da);
          const segmentDiffs = [];
          for (const [id, s2] of ma) {
            const s1 = mb.get(id);
            if (!s1) { segmentDiffs.push({ segmentId: id, kind: 'added' }); continue; }
            const fields = {};
            for (const k of new Set([...Object.keys(s1), ...Object.keys(s2)])) {
              const v1 = JSON.stringify(s1[k]), v2 = JSON.stringify(s2[k]);
              if (v1 !== v2) fields[k] = { before: s1[k], after: s2[k] };
            }
            if (Object.keys(fields).length) segmentDiffs.push({ segmentId: id, kind: 'changed', fields });
          }
          for (const [id] of mb) if (!ma.has(id)) segmentDiffs.push({ segmentId: id, kind: 'removed' });
          const t = { before: sb, after: sa,
                      segmentsDelta: sa.segments - sb.segments,
                      durationDeltaUs: sa.durationUs - sb.durationUs,
                      segmentDiffs };
          // ★ 给了 expect 就按 expect 断言；没给才用"什么都没动 ⇒ 可疑"的启发式
          const exp = a.expect || null;
          if (exp) {
            if (exp.segmentsDelta !== undefined && t.segmentsDelta !== exp.segmentsDelta) {
              problems.push(`段数变化 ${t.segmentsDelta} ≠ 期望 ${exp.segmentsDelta}`);
            }
            if (exp.durationDeltaUs !== undefined && t.durationDeltaUs !== exp.durationDeltaUs) {
              problems.push(`时长变化 ${t.durationDeltaUs} µs ≠ 期望 ${exp.durationDeltaUs} µs`);
            }
            if (exp.segmentFieldChanged) {
              const hit = segmentDiffs.some((d) => d.fields && d.fields[exp.segmentFieldChanged]);
              if (!hit) problems.push(`没有任何 segment 的 "${exp.segmentFieldChanged}" 字段发生变化（改动可能没落盘）`);
            }
            if (exp.segmentFieldUnchanged) {
              const hit = segmentDiffs.some((d) => d.fields && d.fields[exp.segmentFieldUnchanged]);
              if (hit) problems.push(`不该变的 "${exp.segmentFieldUnchanged}" 字段却变了`);
            }
          } else if (t.segmentsDelta === 0 && t.durationDeltaUs === 0 && segmentDiffs.length === 0) {
            problems.push('时间线没有任何变化（段数、时长、段字段都没动）—— 改动可能没落盘');
          }
          res.checks.timeline = t;
        }
      }
    }

    // ---------- ④ 草稿完整性：真草稿 sha ----------
    if (want('draft_integrity')) {
      if (!a.realDraft) {
        res.checks.draft_integrity = { skipped: '需要 realDraft（真草稿目录）' };
      } else {
        const t = shaTree(a.realDraft);
        res.checks.draft_integrity = { files: t.length, sha: t.slice(0, 3), note: '落盘时已做前后逐字节断言' };
      }
    }

    res.verdict = problems.length ? 'FAIL' : 'PASS';
    res.problems = problems;
    return problems.length ? fail(res) : ok(res);
  },
};

/* PNG 读：优先用 pngjs（若有），否则回落到 ffmpeg 解码 */
let PNG = null;
async function importPng() {
  if (PNG) return PNG;
  const ff = FFMPEG();
  PNG = {
    async read(file) {
      const r = await run(ff, ['-v', 'error', '-i', file, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
        { cwd: path.dirname(file), binary: true });
      if (r.code !== 0 || !r.stdout.length) throw new Error(`解 PNG 失败: ${file}\n${r.stderr}`);
      return r.stdout;
    },
  };
  return PNG;
}

/* ------------------------------------------------------------ 工具装载 */
function loadTools() {
  const out = [];
  for (const f of fs.readdirSync(TOOLS_DIR).filter((x) => x.endsWith('.schema.json')).sort()) {
    const s = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, f), 'utf8'));
    out.push({ name: s.name, description: s.description, inputSchema: s.inputSchema, file: f });
  }
  return out;
}
let TOOLLIST = [];
function initTools() {
  TOOLLIST = loadTools();
  for (const t of TOOLLIST) {
    if (typeof IMPL[t.name] !== 'function') {
      console.error(`[jianying] 警告：schema ${t.file} 的工具 "${t.name}" 没有实现`);
    }
  }
}

/* ------------------------------------------------------------ MCP 协议 */
function handle(message) {
  if (message.method === 'initialize') {
    return { result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'jianying', version: '0.1.0' } } };
  }
  if (message.method === 'tools/list') {
    return { result: { tools: TOOLLIST.map((t) => ({
      name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name;
    const t = TOOLLIST.find((x) => x.name === name);
    if (!t) return { error: { code: -32601, message: `未知工具: ${name}` } };
    let args = {};
    try {
      args = validate(message.params?.arguments || {}, t.inputSchema);
    } catch (e) {
      return { result: fail(String(e.message)) };
    }
    return Promise.resolve(IMPL[name](args))
      .then((r) => ({ result: r }))
      .catch((e) => ({ result: fail(`${name} 失败：${e.message}`) }));
  }
  return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
}

initTools();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return;
  const out = handle(msg);
  if (out instanceof Promise) {
    out.then((r) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...r })}\n`));
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...out })}\n`);
  }
});
