// jianying MCP server 的客户端验收脚本
// 用法: node selftest-mcp.mjs
// 环境: JYAI_HOME 指向 JYAI 仓库
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(HERE, '..', 'mcp', 'server.mjs');
const JYAI = process.env.JYAI_HOME || path.join(process.env.USERPROFILE, 'JYAI');
const SRC = path.join(JYAI, 'out', 'p47', 'full1080-with-audio.mp4');
const OUT = path.join(JYAI, 'out', 'p67', 'mcp-test');
// ★ 2026-10-21：不再用【别的跑】留下的帧目录当基线（out/p1-e2e-clean）。
//   官方渲染器同态重渲染就有噪声（实测 17/108 帧变、最差 MAD 123.55），
//   拿它当"改动可见"的证据站不住脚 ⇒ 改成【本次自产】的合成帧，确定性可复跑。
const FR_BASE = path.join(OUT, 'frames-base');
const FR_NOISE = path.join(OUT, 'frames-noise');
const FR_BIG = path.join(OUT, 'frames-big');
const FR_CLIP = path.join(OUT, 'frames-clip');

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* ignore */ }
    }
  }
  return cmd;
}
const FFMPEG = which('ffmpeg');
const FFPROBE = (() => {
  const d = path.dirname(which('ffmpeg'));
  const p = path.join(d, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  return fs.existsSync(p) ? p : 'ffprobe';
})();
// Python（烘 3D LUT 用；绝不写死盘符）
const PYTHON = (() => {
  for (const c of ['python', 'python3']) {
    try {
      const p = which(c);
      if (p) return p;
    } catch { /* ignore */ }
  }
  return process.platform === 'win32' ? 'python' : 'python3';
})();
function sh(args) {
  return new Promise((resolve) => {
    const c = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let se = '';
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => resolve({ code, stderr: se }));
  });
}
// 任意可执行文件版本（ffprobe 等）—— sh() 写死了 FFMPEG
// ★ 注意：ffprobe 的 -show_entries 结果走【stdout】；只有错误信息走 stderr
//   （2026-10-22 自检抓到的假失败：只收 stderr ⇒ streams 解析成空字符串）
function shBin(bin, args) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => resolve({ code, stdout: so, stderr: se }));
  });
}
// 合成一组确定性的帧（纯色 + 亮度偏移）⇒ 噪声基线 / 真改动 / 新增削波 各一组
// ★ 基色里放一个接近白的（F0F0F0）⇒ 用来复现"绝对值削波口径"那个坑（§76.5）
async function synthFrames(dir, brightness) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const colors = ['F0F0F0', '606060', '808080'];
  for (let i = 0; i < colors.length; i++) {
    const f = path.join(dir, String(i).padStart(5, '0') + '.png');
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${colors[i]}:s=64x64`];
    if (brightness) args.push('-vf', `eq=brightness=${brightness}`);
    args.push('-frames:v', '1', f);
    const r = await sh(args);
    if (r.code !== 0) return 0;
  }
  return colors.length;
}

// ★ 逐帧稳定性用例（§82）：造三组帧
//   base   : 3 帧原样
//   unstable: 只有第 1 帧被大幅扰动（模拟"官方预览渲染在该帧非确定"）
//   changed : 只有第 2 帧被小幅真实改动
//   ⇒ 期望：第 1 帧被判为不稳定并排除；第 2 帧的稳定改动仍被检出 ⇒ 判"可见"
async function synthFramesPerFrame(dir, { unstableIndex = null, unstableBright = null, changedIndex = null, changedBright = null } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const colors = ['606060', '808080', 'A0A0A0'];
  for (let i = 0; i < colors.length; i++) {
    let bright = null;
    if (i === unstableIndex) bright = unstableBright;
    if (i === changedIndex) bright = changedBright;
    const f = path.join(dir, String(i).padStart(5, '0') + '.png');
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${colors[i]}:s=64x64`];
    if (bright !== null) args.push('-vf', `eq=brightness=${bright}`);
    args.push('-frames:v', '1', f);
    const r = await sh(args);
    if (r.code !== 0) return 0;
  }
  return colors.length;
}

const child = spawn(process.execPath, [SRV], {
  env: { ...process.env, JYAI_HOME: JYAI, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
function call(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

let PASS = 0, FAIL = 0;
function check(name, ok, detail) {
  if (ok) { PASS++; console.log(`  [PASS] ${name}${detail ? '  — ' + detail : ''}`); }
  else { FAIL++; console.log(`  [FAIL] ${name}${detail ? '  — ' + detail : ''}`); }
}

const textOf = (r) => (r.result?.content || []).map((c) => c.text || '').join('\n');

(async () => {
  console.log('=== jianying MCP server 验收 ===\n');

  // 1. 握手 + 工具清单
  const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  check('initialize 握手', init.result?.serverInfo?.name === 'jianying', `serverInfo=${JSON.stringify(init.result?.serverInfo)}`);
  const list = await call('tools/list', {});
  const tools = list.result?.tools || [];
  check('tools/list 返回 9 个动词', tools.length === 9, `实际 ${tools.length}：${tools.map((t) => t.name).join(', ')}`);
  const noSchema = tools.filter((t) => !t.inputSchema || t.inputSchema.type !== 'object');

  // ★★★ 安全：会话状态不得读/写 PLUGIN_DATA 之外（PR #72 review 的合并阻塞项）
  //   9 种恶意 sessionId × 3 个动词 + 写路径检查 + 阳性对照（证明探针有区分力）
  const secMod = await import('./security-probe.mjs');
  const sec = await secMod.runSecurityProbe();
  const secBad = sec.cases.filter((c) => !c.ok);
  check('★★★ 会话状态越界探针（读/写 PLUGIN_DATA 之外全被拒）', sec.fail === 0,
    secBad.length ? secBad.map((c) => c.name).join(' | ') : `${sec.pass} PASS / ${sec.fail} FAIL`);
  check('每个动词都有 inputSchema', noSchema.length === 0, noSchema.map((t) => t.name).join(',') || '全部有');
  const ga = tools.find((t) => t.name === 'grade_apply');
  const nodeKeys = Object.keys(ga?.inputSchema?.properties?.spec?.properties || {});
  check('grade_apply 的 spec 枚举了节点', nodeKeys.length >= 10, `${nodeKeys.length} 个节点：${nodeKeys.join(',')}`);

  // 2. 入参 schema 硬校验：未知键必须被拒（防静默失效）
  const bad = await call('tools/call', { name: 'grade_apply', arguments: { src: SRC, outDir: OUT, spec: { adjustColor: { brightness: 0.1 }, not_a_node: { x: 1 } } } });
  const badTxt = textOf(bad);
  check('★ 非法 spec 键被拒绝', bad.result?.isError === true && /未知键|不合法/.test(badTxt), badTxt.split('\n').slice(0, 2).join(' / '));

  const bad2 = await call('tools/call', { name: 'grade_apply', arguments: { src: SRC, outDir: OUT, spec: { adjustColor: { brightness: 5 } } } });
  check('★ 越界参数被拒绝', bad2.result?.isError === true && /最大|不合法/.test(textOf(bad2)), textOf(bad2).split('\n').slice(0, 2).join(' / '));

  // 3. 正常调色：必须出片 + 探针全非零
  const g = await call('tools/call', { name: 'grade_apply', arguments: {
    src: SRC, outDir: OUT, frames: 4,
    spec: { adjustColor: { brightness: 0.12, contrast: 0.08 }, logWheel: { shadow: { r: 0.10, g: 0.04, b: 0, s: 0.05 } } },
  } });
  const gTxt = textOf(g);
  const gOk = !g.result?.isError;
  check('grade_apply 正常出片', gOk, gOk ? gTxt.replace(/\s+/g, ' ').slice(0, 150) : gTxt.slice(0, 200));
  if (gOk) {
    const j = JSON.parse(gTxt);
    check('grade_apply 内建探针：所有节点非零', Object.entries(j.probe).filter(([k]) => k !== '_full_chain').every(([, v]) => v > 0), JSON.stringify(j.probe));
    check('grade_apply 调色改变量 > 0', j.gradeChangeMad > 0, `MAD=${j.gradeChangeMad}`);
  }

  // 4. verify_diff：本次自产的合成帧（不依赖别的跑的残留目录）
  //    base = 原帧；noise = 亮度 −0.01（模拟渲染噪声）；big = 亮度 −0.06（模拟真改动）
  const nBase = await synthFrames(FR_BASE, 0);
  const nNoise = await synthFrames(FR_NOISE, -0.01);
  const nBig = await synthFrames(FR_BIG, -0.06);
  const nClip = await synthFrames(FR_CLIP, 0.2);   // ★ 0xF0F0F0 @ +0.2 ⇒ 255 ⇒ 真削波（实测 +0.03 只到 244，不削）
  check('合成帧目录就绪', nBase > 0 && nNoise > 0 && nBig > 0 && nClip > 0,
    `base=${nBase} noise=${nNoise} big=${nBig} clip=${nClip}`);

  // 4a. 未校准：噪声也会被判成"可见"（这正是要暴露的问题）
  const v0 = await call('tools/call', { name: 'verify_diff', arguments: {
    beforeDir: FR_BASE, afterDir: FR_NOISE, checks: ['visibility'] } });
  const v0j = (() => { try { return JSON.parse(textOf(v0)); } catch { return null; } })();
  const vis0 = v0j?.checks?.visibility || {};
  check('verify_diff 未校准时会标注 calibrated=false',
    vis0.calibrated === false && /未校准/.test(vis0.note || ''),
    `maxMad=${vis0.maxMad} threshold=${vis0.threshold} note=${(vis0.note || '').slice(0, 40)}…`);

  // 4b. ★ 校准后：噪声 ⇒ 必须判"不可见"；且【白底不算新增削波】（增量口径）
  const v1 = await call('tools/call', { name: 'verify_diff', arguments: {
    beforeDir: FR_BASE, afterDir: FR_NOISE, noiseDir: FR_NOISE, checks: ['visibility', 'picture'] } });
  const v1j = (() => { try { return JSON.parse(textOf(v1)); } catch { return null; } })();
  const vis = v1j?.checks?.visibility || {};
  check('★ verify_diff 校准后：噪声 ⇒ 判 FAIL（不可见）',
    v1.result?.isError === true && v1j?.verdict === 'FAIL' && vis.calibrated === true,
    `maxMad=${vis.maxMad} 噪声底=${vis.noiseMad} 判据线=${vis.noiseBar}`);
  const pic = v1j?.checks?.picture || {};
  check('verify_diff 画质维度：白底不算【新增】削波（增量口径）',
    Array.isArray(pic.meanDrift) && pic.meanDrift.length === 3
    && Math.abs(pic.clipDelta ?? 1) < 1e-6 && Math.abs(pic.underDelta ?? 1) < 1e-6
    && !(v1j?.problems || []).some((p) => /削波|死黑/.test(p)),
    `clip=${pic.clipRatio} clipΔ=${pic.clipDelta} underΔ=${pic.underDelta} drift=${JSON.stringify(pic.meanDrift)}`);

  // 4c. ★★ 负向注入：真改动 ⇒ 必须判"可见"（证明这条判据不是恒 FAIL）
  const v1b = await call('tools/call', { name: 'verify_diff', arguments: {
    beforeDir: FR_BASE, afterDir: FR_BIG, noiseDir: FR_NOISE, checks: ['visibility'] } });
  const v1bj = (() => { try { return JSON.parse(textOf(v1b)); } catch { return null; } })();
  const visb = v1bj?.checks?.visibility || {};
  check('★★ verify_diff 负向注入：真改动 ⇒ 判 PASS（可见）',
    v1b.result?.isError !== true && v1bj?.verdict === 'PASS' && visb.calibrated === true,
    `maxMad=${visb.maxMad} 噪声底=${visb.noiseMad} 倍数=${visb.madOverNoise}`);

  // 4d. ★★ 负向注入：把白底【推上去】⇒ 必须报"新增削波"（证明增量口径不是恒 0）
  const v1c = await call('tools/call', { name: 'verify_diff', arguments: {
    beforeDir: FR_BASE, afterDir: FR_CLIP, noiseDir: FR_NOISE, checks: ['visibility', 'picture'] } });
  const v1cj = (() => { try { return JSON.parse(textOf(v1c)); } catch { return null; } })();
  const picc = v1cj?.checks?.picture || {};
  check('★★ verify_diff 负向注入：白底被推爆 ⇒ 必须报「新增削波」',
    (picc.clipDelta ?? 0) > 0.02 && (v1cj?.problems || []).some((p) => /削波/.test(p)),
    `clip=${picc.clipRatio} clipΔ=${picc.clipDelta} problems=${JSON.stringify(v1cj?.problems)}`);

  // 4e. ★★ 逐帧稳定性（§82）：噪声集中在少数帧 ⇒ 不稳定帧排除，稳定帧的改动仍要检出
  const FR_PF_BASE = path.join(OUT, 'frames-pf-base');
  const FR_PF_UNSTABLE = path.join(OUT, 'frames-pf-unstable');
  const FR_PF_CHANGED = path.join(OUT, 'frames-pf-changed');
  await synthFramesPerFrame(FR_PF_BASE, {});
  await synthFramesPerFrame(FR_PF_UNSTABLE, { unstableIndex: 1, unstableBright: -0.5 });
  await synthFramesPerFrame(FR_PF_CHANGED, { changedIndex: 2, changedBright: -0.2 });
  const v1d = await call('tools/call', { name: 'verify_diff', arguments: {
    beforeDir: FR_PF_BASE, afterDir: FR_PF_CHANGED, noiseDir: FR_PF_UNSTABLE, checks: ['visibility'] } });
  const v1dj = (() => { try { return JSON.parse(textOf(v1d)); } catch { return null; } })();
  const visd = v1dj?.checks?.visibility || {};
  check('★★ verify_diff 逐帧稳定性：不稳定帧被单独标出',
    visd.unstableFrameCount === 1 && (visd.unstableFrames || []).includes(1),
    `unstableFrames=${JSON.stringify(visd.unstableFrames)} visibleFrameCount=${visd.visibleFrameCount}`);
  check('★★ verify_diff 逐帧稳定性：稳定帧上的真实改动仍被判为可见',
    v1d.result?.isError !== true && v1dj?.verdict === 'PASS' && (visd.visibleMaxMad ?? 0) > 0,
    `verdict=${v1dj?.verdict} visibleMaxMad=${visd.visibleMaxMad} @frame${visd.visibleFrame}`);

  // 5. ★ 阴性：同一目录对同一目录 ⇒ 必须 FAIL（判据要有判别力）
  const v2 = await call('tools/call', { name: 'verify_diff', arguments: { beforeDir: FR_BASE, afterDir: FR_BASE } });
  check('★ verify_diff 对无变化必须 FAIL', v2.result?.isError === true, textOf(v2).replace(/\s+/g, ' ').slice(0, 140));

  // 6. draft_open 护栏：allowReal=true 但 copy 仍为 true ⇒ 拒绝
  const d1 = await call('tools/call', { name: 'draft_open', arguments: { draft: 'x', copy: true, allowReal: true } });
  check('★ draft_open 护栏：allowReal 与 copy 冲突时拒绝', d1.result?.isError === true, textOf(d1).slice(0, 120));

  // 7. ★ make_film：一条命令出成片（官方画面 + 我们的调色/混音 + ffmpeg 编码）
  //    结构性断言 + 阴性断言永远跑；真 e2e 需要草稿库（env JYAI_DRAFT_LIB）+ 剪映在跑
  //    ⇒ 没有草稿库时【显式 SKIP 且不计入 PASS】（不做假绿）
  const FILM_LIB = process.env.JYAI_DRAFT_LIB || '';
  const FILM_DRAFT = process.env.JYAI_FILM_DRAFT || (FILM_LIB ? path.join(FILM_LIB, 'JYAI能力批测9a-纯视频探针') : '');
  const FILM_OUT = path.join(OUT, 'film');
  const mf = tools.find((t) => t.name === 'make_film');
  check('tools/list 暴露 make_film', !!mf, mf ? Object.keys(mf.inputSchema?.properties || {}).join(',') : '缺失');
  check('make_film schema 含 draft/outDir/lut/denoise/beautify',
    !!mf && ['draft', 'outDir', 'lut', 'denoise', 'beautify'].every((k) => k in (mf.inputSchema?.properties || {})),
    mf ? Object.keys(mf.inputSchema?.properties || {}).join(',') : '');

  const mfBad = await call('tools/call', { name: 'make_film', arguments: { outDir: FILM_OUT } });
  check('★ make_film 缺必填参数被拒', mfBad.result?.isError === true, textOf(mfBad).replace(/\s+/g, ' ').slice(0, 120));

  const mfNoDraft = await call('tools/call', { name: 'make_film', arguments: { draft: path.join(OUT, '__no_such_draft__'), outDir: FILM_OUT } });
  check('★ make_film 草稿不存在 ⇒ 报错（证明这个动词不是空壳）',
    mfNoDraft.result?.isError === true, textOf(mfNoDraft).replace(/\s+/g, ' ').slice(0, 120));

  // ★ 2026-10-23：剪映【刚启动】时 VE host 还没起来 ⇒ 第一次跑会误报一堆失败
  //   （实测：刚起的剪映上 37 PASS / 3 FAIL，第二次跑就 43/0 ⇒ 是环境预热，不是代码）
  //   ⇒ 这里先等 VE 管道就绪（最多 ~30s），就绪才跑 e2e；等不到就整段 SKIP（不计入 PASS）。
  let veReady = false;
  if (FILM_DRAFT && fs.existsSync(FILM_DRAFT)) {
    for (let i = 0; i < 12; i++) {
      const probe = await call('tools/call', { name: 'draft_open', arguments: { draft: FILM_DRAFT, copy: true } });
      if (probe.result?.isError !== true) { veReady = true; break; }
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!veReady) console.log('  ★ 剪映 VE 管道 30 秒内没就绪（剪映在跑吗？）');
  }

  if (FILM_DRAFT && fs.existsSync(FILM_DRAFT) && veReady) {
    // e2e ①：双流草稿（素材齐全）⇒ 必须出"画面+音轨"，且内建验收（响度/时长断言）判通过
    //   fps 取 6（帧数减半、时长不变 ⇒ 音画对齐不受影响，只为省时间）
    const mfRun = await call('tools/call', { name: 'make_film', arguments: { draft: FILM_DRAFT, outDir: FILM_OUT, fps: 6, denoise: 'auto' } });
    const mfTxt = textOf(mfRun);
    const mfOk = mfRun.result?.isError !== true;
    check('★★ make_film 真出片（官方渲染器画面 + 我们的混音链）', mfOk,
      mfOk ? mfTxt.replace(/\s+/g, ' ').slice(0, 200) : mfTxt.replace(/\s+/g, ' ').slice(0, 200));
    if (mfOk) {
      const film = path.join(FILM_OUT, 'film.mp4');
      const has = fs.existsSync(film);
      check('make_film 成片文件落盘', has, film);
      if (has) {
        const st = await shBin(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,channels',
          '-of', 'default=noprint_wrappers=1', film]);
        const types = [...String(st.stdout || '').matchAll(/codec_type=(\w+)/g)].map((m) => m[1]);
        // ★ 双流是【条件断言】：该草稿的音频素材文件可能不在磁盘上（环境状态）⇒ 那时只要求出片成功
        const audioMissing = /音频素材缺失\s*\d+\s*个/.test(mfTxt) || /无音轨 ⇒ 响度不判定/.test(mfTxt);
        if (audioMissing) {
          console.log(`  [SKIP] make_film 双流断言 —— 该草稿的音频素材不在磁盘上（环境状态）⇒ 视频流已验: ${types.join(',')}`);
          check('★ make_film 至少出了视频流', types.includes('video'), `streams=${types.join(',')}`);
        } else {
          check('★★ make_film 成片双流齐备（video+audio）', types.includes('video') && types.includes('audio'),
            `streams=${types.join(',')} size=${fs.statSync(film).size}B`);
        }
        check('★★ make_film 内建验收判通过（响度/时长断言）', /验收通过/.test(mfTxt),
          (mfTxt.match(/整体响度[^\n]*/) || ['(无响度行)'])[0].trim());
      }
    }
    // ★ e2e ②（无音轨）：现在 e2e 草稿本身就是【纯视频、无可用音轨】的
    //   （草稿库清理后，带音频的测试稿已不存在 ⇒ 9a-纯视频探针 顶上）
    //   ⇒ 断言：这种草稿也必须出片、且【不能】判失败（2026-10-22 抓到的真缺陷）
    check('★★ make_film：草稿无可用音轨 ⇒ 仍出片（纯画面），不判失败',
      mfOk && /验收通过/.test(mfTxt) && !/✘ 验收不通过/.test(mfTxt),
      (mfTxt.match(/整体响度[^\n]*/) || ['(无响度行)'])[0].trim());
    // e2e ③：★★ 我们自己给曲线（grade.curves）⇒ ① 烘出的 cube 必须【不是恒等】
    //   （判据不依赖渲染确定性：只查 cube）② 少一条通道必须【报错】（不许静默恒等）
    const CURVE = [0, 0, 0.1, 0.0533, 0.2, 0.1067, 0.3, 0.16, 0.4067, 0.3933, 0.5133, 0.6267,
      0.62, 0.86, 0.7467, 0.9067, 0.8733, 0.9533, 1, 1, 1, 1, 1, 1];
    const four = { red: CURVE, green: CURVE, blue: CURVE, luma: CURVE };
    const gOut = path.join(OUT, 'film-grade');
    const gRun = await call('tools/call', {
      name: 'make_film',
      arguments: { draft: FILM_DRAFT, outDir: gOut, fps: 6, denoise: 'off', grade: { curves: four } },
    });
    const gTxt = textOf(gRun);
    check('★★ make_film 接受 grade（我们自己给曲线）', gRun.result?.isError !== true,
      gRun.result?.isError !== true ? 'ok' : gTxt.replace(/\s+/g, ' ').slice(0, 200));
    const cube = path.join(gOut, 'grade.cube');
    if (fs.existsSync(cube)) {
      // cube 与 identity 的最大偏差 ⇒ > 0.01 才算真的烘出了曲线
      // （.cube 行序：R 最快 ⇒ index i ⇒ r=i%N, g=(i//N)%N, b=i//(N*N)；恒等值=(r,g,b)/(N-1)）
      const dev = await shBin(PYTHON, ['-c', [
        'import sys',
        'p = sys.argv[1]',
        'N = 0',
        'rows = []',
        'for line in open(p, encoding="utf-8", errors="ignore"):',
        '    if line.startswith("LUT_3D_SIZE"):',
        '        N = int(line.split()[1]); continue',
        '    if line.startswith("#") or line.startswith("DOMAIN"):',
        '        continue',
        '    t = line.split()',
        '    if len(t) >= 3:',
        '        rows.append((float(t[0]), float(t[1]), float(t[2])))',
        'm = 0.0',
        'den = max(N - 1, 1)',
        'for i, v in enumerate(rows):',
        '    r = i % N; g = (i // N) % N; b = i // (N * N)',
        '    m = max(m, abs(v[0]-r/den), abs(v[1]-g/den), abs(v[2]-b/den))',
        'print("%.6f" % m)',
      ].join('\n'), cube]);
      const dv = parseFloat(String(dev.stdout || '').trim());
      check('★★ grade 烘出的 cube 不是恒等（曲线真的被应用了）', Number.isFinite(dv) && dv > 0.01,
        `maxDev(identity)=${dv}`);
    } else {
      check('★★ grade 烘出的 cube 不是恒等（曲线真的被应用了）', false, 'grade.cube 没产出');
    }
    const badRun = await call('tools/call', {
      name: 'make_film',
      arguments: { draft: FILM_DRAFT, outDir: path.join(OUT, 'film-grade-bad'), fps: 6, denoise: 'off',
        grade: { curves: { red: CURVE } } },   // ★ 只给一条通道 ⇒ 必须报错，不许静默恒等
    });
    check('★★ grade 少一条曲线通道 ⇒ 明确报错（不许静默烘成恒等）',
      badRun.result?.isError === true, textOf(badRun).replace(/\s+/g, ' ').slice(-200));
    // ★ 渲染期算子（sharpen/vignetting/particle）3D LUT 表达不了 ⇒ 写进来必须报错（不许静默忽略）
    const rnRun = await call('tools/call', {
      name: 'make_film',
      arguments: { draft: FILM_DRAFT, outDir: path.join(OUT, 'film-grade-rn'), fps: 6, denoise: 'off',
        grade: { sharpen: { intensity: 0.6 } } },
    });
    check('★★ grade 含渲染期算子(sharpen) ⇒ 明确报错（指向 grade_apply），不许静默忽略',
      rnRun.result?.isError === true && /grade_apply|渲染期/.test(textOf(rnRun)),
      textOf(rnRun).replace(/\s+/g, ' ').slice(-200));

    // ── ★★ 2026-10-22 审计：参数名拼错 ⇒ 过去【静默烘成恒等 LUT】─────
    //   实测：make_film --grade '{"adjustColor":{"brightnessX":0.1}}' 产出的 cube
    //   与【空 spec】的 cube 逐字节相同（md5 3abf7454…）⇒ 调色根本没发生，但出片"成功"、验收"通过"。
    //   根因：make-film.schema.json 里 grade 的每个节点只写了 {type:object}（弱校验），
    //   而烘焙器也不认识拼错的键 ⇒ 两层都不拦。
    const typoRun = await call('tools/call', {
      name: 'make_film',
      arguments: { draft: FILM_DRAFT, outDir: path.join(OUT, 'film-grade-typo'), fps: 6, denoise: 'off',
        grade: { adjustColor: { brightnessX: 0.1 } } },
    });
    check('★★ grade 参数名拼错 ⇒ 明确报错（不许静默烘成恒等 LUT）',
      typoRun.result?.isError === true && /未知键|不合法/.test(textOf(typoRun)),
      textOf(typoRun).replace(/\s+/g, ' ').slice(-200));
    // ★ 越界数值同样必须被拒（强度语义是 −1..1，界面 0..100 要换算）
    const rangeRun = await call('tools/call', {
      name: 'make_film',
      arguments: { draft: FILM_DRAFT, outDir: path.join(OUT, 'film-grade-range'), fps: 6, denoise: 'off',
        grade: { adjustColor: { brightness: 5 } } },
    });
    check('★★ grade 数值越界 ⇒ 明确报错（强度语义是 −1..1）',
      rangeRun.result?.isError === true && /最大|不合法/.test(textOf(rangeRun)),
      textOf(rangeRun).replace(/\s+/g, ' ').slice(-200));
    // ★★★ 绕过 schema 直接调烘焙器 ⇒ 同样必须报错（防线在【实现层】，不只靠 schema）
    const bakeDirect = await shBin(PYTHON, ['-c', [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("b", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'm.bake({"adjustColor": {"brightnessX": 0.1}})',
      'print("NO_ERROR_BAKED")',
    ].join('\n'), path.join(JYAI, 'tools', 'jyai-gl-bake.py')]);
    const bdTxt = `${bakeDirect.stdout || ''}\n${bakeDirect.stderr || ''}`;
    check('★★★ 绕过 schema 直接调烘焙器：拼错参数名 ⇒ 同样报错（防线在实现层）',
      !/NO_ERROR_BAKED/.test(bdTxt) && /不认识的参数/.test(bdTxt),
      bdTxt.replace(/\s+/g, ' ').slice(-200));

    // ── ★★ MCP 层全动词冒烟（2026-10-22 审计补：此前 5 个动词【从未走过 MCP 层】）
    //   draft_read / draft_patch / draft_commit / render_frames / audio_mix
    const SMOKE = path.join(OUT, 'mcp-smoke');
    // ★ video.add 需要一个【真的能读的视频源】（传草稿 json 会得 video_source_unreadable）
    const FILM_MEDIA = process.env.JYAI_TEST_MEDIA
      || path.join(process.env.LOCALAPPDATA || '', 'Temp', 'jy-media-probe.mp4');
    if (!fs.existsSync(FILM_MEDIA)) {
      // 造一个 1 秒的测试视频（不依赖用户素材）
      const ff = path.join(path.dirname(FFMPEG), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      try {
        execFileSync(ff,
          ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=12:d=1',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-shortest',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', FILM_MEDIA],
          { windowsHide: true, stdio: 'ignore' });
      } catch { /* 造不出来就跳过该用例 */ }
    }
    const op1 = await call('tools/call', { name: 'draft_open', arguments: { draft: FILM_DRAFT, copy: true } });
    const opTxt = textOf(op1);
    const sid1 = (opTxt.match(/ve-session-\d+/) || [])[0] || '';
    check('★★ MCP: draft_open 走通并给出 sessionId', op1.result?.isError !== true && !!sid1, sid1 || opTxt.slice(0, 120));

    const rd1 = await call('tools/call', { name: 'draft_read', arguments: { sessionId: sid1 } });
    const rdTxt = textOf(rd1);
    check('★★ MCP: draft_read(sessionId) 读回草稿结构',
      rd1.result?.isError !== true && /"tracks"|"segments"/.test(rdTxt), rdTxt.replace(/\s+/g, ' ').slice(0, 100));

    const rd2 = await call('tools/call', { name: 'draft_read', arguments: { path: path.join(FILM_DRAFT, 'draft_content.json'), root: FILM_DRAFT } });
    check('★★ MCP: draft_read(path+root) 读回草稿结构',
      rd2.result?.isError !== true && /"tracks"|"segments"/.test(textOf(rd2)), textOf(rd2).replace(/\s+/g, ' ').slice(0, 100));

    // ★ 回归：scope 已从 schema 移除 ⇒ 传它必须被【拒】（不许静默接受）
    const rdScope = await call('tools/call', { name: 'draft_read', arguments: { path: path.join(FILM_DRAFT, 'draft_content.json'), root: FILM_DRAFT, scope: 'segments' } });
    check('★★ MCP: draft_read 传 scope 被拒（后端不支持 ⇒ 别装成能用）',
      rdScope.result?.isError === true && /未知键/.test(textOf(rdScope)), textOf(rdScope).replace(/\s+/g, ' ').slice(0, 120));

    const pt1 = await call('tools/call', {
      name: 'draft_patch',
      arguments: { op: 'video.add', sessionId: sid1, params: { path: FILM_MEDIA, startTime: 0, sourceDuration: 1000000, trackIndex: 9 } },
    });
    check('★★ MCP: draft_patch(video.add) 被官方接受',
      fs.existsSync(FILM_MEDIA) && pt1.result?.isError !== true && /accepted"?\s*:\s*true/.test(textOf(pt1)),
      textOf(pt1).replace(/\s+/g, ' ').slice(0, 120));

    const cm1 = await call('tools/call', { name: 'draft_commit', arguments: { sessionId: sid1, realDraft: FILM_DRAFT } });
    check('★★ MCP: draft_commit 落盘且真草稿未变',
      cm1.result?.isError !== true && /"committed"\s*:\s*true/.test(textOf(cm1))
      && /"realDraftUnchanged"\s*:\s*true/.test(textOf(cm1)), textOf(cm1).replace(/\s+/g, ' ').slice(0, 140));

    const rf1 = await call('tools/call', { name: 'render_frames', arguments: { draft: FILM_DRAFT, outDir: SMOKE, fps: 6 } });
    const framesOk = fs.existsSync(path.join(SMOKE, 'frames')) &&
      fs.readdirSync(path.join(SMOKE, 'frames')).some(f => /^\d+\.png$/.test(f));
    check('★★ MCP: render_frames 产出帧序列', rf1.result?.isError !== true && framesOk,
      textOf(rf1).replace(/\s+/g, ' ').slice(0, 120));

    const am1 = await call('tools/call', {
      name: 'audio_mix',
      arguments: { draft: FILM_DRAFT, video: path.join(FILM_DRAFT, 'draft_content.json'), out: path.join(SMOKE, 'mix.mp4') },
    });
    const amTxt = textOf(am1);
    // ★ 这个草稿没有可用音轨 ⇒ 预期是"明确报 nothing to mix"（输入问题），而不是别的错
    check('★★ MCP: audio_mix 在无音轨草稿上明确报输入问题（nothing to mix），不静默出坏片',
      am1.result?.isError === true ? /nothing to mix/.test(amTxt) : fs.existsSync(path.join(SMOKE, 'mix.mp4')),
      amTxt.replace(/\s+/g, ' ').slice(0, 140));

    // ── ★★★ 覆盖度补强（2026-10-23）：verify_diff 的【语义判据】路径 ──
    //   beforeDraft / afterDraft / expect —— 这是 jianying-draft-edit 文档教的主工作流第⑤步，
    //   但【从未被任何测试触及】（"未测参数清单"查出来的）⇒ 文档教的流程没人验证过。
    //   做法：开副本 → 读改前的明文 → patch 改一处音量 → 读改后的明文 → verify_diff 断言字段变了。
    let semParsed = null;
    try {
      const semOpen = await call('tools/call', { name: 'draft_open', arguments: { draft: FILM_DRAFT, copy: true } });
      const semSid = (textOf(semOpen).match(/ve-session-\d+/) || [])[0];
      const beforeTxt = textOf(await call('tools/call', { name: 'draft_read', arguments: { sessionId: semSid } }));
      const beforeObj = JSON.parse(beforeTxt);
      // ★ draft_read 返回的是【{draft:{...}} 包装】⇒ 先拆包装再找 tracks
      const d0 = beforeObj?.draft || beforeObj || {};
      const segs = (d0.tracks || []).flatMap((t) => t.segments || []);
      const seg = segs[0] || (d0.segments || [])[0] || null;
      const segId = seg?.id || seg?.segment_id || seg?.segmentId || null;
      if (!segId) {
        console.log('  [SKIP] verify_diff 语义判据 —— 草稿里没找到 segmentId（结构变了）⇒ 【不计入 PASS】');
      } else {
        // ★ verify_diff 的 readDraft 取的是【顶层 tracks】⇒ 存裸草稿，不是 {draft:{...}} 包装
        semParsed = { semSid, segId, beforeJson: JSON.stringify(d0, null, 2) };
      }
    } catch (e) {
      console.log(`  [SKIP] verify_diff 语义判据 —— 解析草稿失败（${String(e).slice(0, 90)}）⇒ 【不计入 PASS】`);
    }
    if (semParsed) {
      const { semSid, segId, beforeJson } = semParsed;
      const beforeFile = path.join(SMOKE, 'before-draft.json');
      const afterFile = path.join(SMOKE, 'after-draft.json');
      fs.writeFileSync(beforeFile, beforeJson, 'utf8');
      const patchRes = await call('tools/call', {
        name: 'draft_patch',
        arguments: { op: 'video.setVolume', sessionId: semSid, params: { segmentId: segId, volume: 0.25 } },
      });
      const afterTxt = textOf(await call('tools/call', { name: 'draft_read', arguments: { sessionId: semSid } }));
      let afterJson = afterTxt;
      try {
        const afterObj = JSON.parse(afterTxt);
        afterJson = JSON.stringify(afterObj?.draft || afterObj || {}, null, 2);
      } catch { /* 保持原样，让 verify_diff 去报"读不出来" */ }
      fs.writeFileSync(afterFile, afterJson, 'utf8');
      const sem = await call('tools/call', {
        name: 'verify_diff',
        arguments: {
          checks: ['timeline'],
          beforeDraft: beforeFile, afterDraft: afterFile,
          expect: { segmentFieldChanged: 'volume' },
        },
      });
      const semTxt = textOf(sem);
      check('★★★ MCP: verify_diff 语义判据（beforeDraft/afterDraft/expect）⇒ 判得"volume 变了"',
        patchRes.result?.isError !== true && sem.result?.isError !== true && /"verdict"\s*:\s*"PASS"/.test(semTxt),
        semTxt.replace(/\s+/g, ' ').slice(0, 220));
      // ★ 阴性对照：两份草稿【相同】⇒ 必须判 FAIL（否则这条判据没有区分力）
      const neg = await call('tools/call', {
        name: 'verify_diff',
        arguments: {
          checks: ['timeline'],
          beforeDraft: beforeFile, afterDraft: beforeFile,
          expect: { segmentFieldChanged: 'volume' },
        },
      });
      const negTxt = textOf(neg);
      check('★★★ MCP: verify_diff 语义判据的阴性对照（没改动 ⇒ 必须判 FAIL）',
        neg.result?.isError === true && /"verdict"\s*:\s*"FAIL"/.test(negTxt),
        negTxt.replace(/\s+/g, ' ').slice(0, 200));
    }
  } else {
    console.log('  [SKIP] 真 e2e（MCP 层冒烟 + make_film 出片）—— 需要 env JYAI_DRAFT_LIB（草稿库）'
      + '+ 剪映在跑且 VE 管道就绪；未满足 ⇒ 【不计入 PASS】');
  }

  console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
  child.kill();
  process.exit(FAIL === 0 ? 0 : 1);
})();
