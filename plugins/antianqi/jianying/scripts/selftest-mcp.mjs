// jianying MCP server 的客户端验收脚本
// 用法: node selftest-mcp.mjs
// 环境: JYAI_HOME 指向 JYAI 仓库
import { spawn } from 'node:child_process';
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
  const FILM_DRAFT = process.env.JYAI_FILM_DRAFT || (FILM_LIB ? path.join(FILM_LIB, 'JYAI明文测试') : '');
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

  if (FILM_DRAFT && fs.existsSync(FILM_DRAFT)) {
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
        check('★★ make_film 成片双流齐备（video+audio）', types.includes('video') && types.includes('audio'),
          `streams=${types.join(',')} size=${fs.statSync(film).size}B`);
        check('★★ make_film 内建验收判通过（响度/时长断言）', /验收通过/.test(mfTxt),
          (mfTxt.match(/整体响度[^\n]*/) || ['(无响度行)'])[0].trim());
      }
    }
    // e2e ②：★ 无音轨草稿（音频素材文件不在磁盘上）⇒ 也必须出片（纯画面），【不能】判失败
    //   这是 2026-10-22 自检抓到的真缺陷：草稿没音轨被误报成"出片失败"
    const NOAUDIO_DRAFT = FILM_LIB ? path.join(FILM_LIB, 'JYAI功能矩阵') : '';
    if (NOAUDIO_DRAFT && fs.existsSync(NOAUDIO_DRAFT)) {
      const na = await call('tools/call', { name: 'make_film', arguments: { draft: NOAUDIO_DRAFT, outDir: path.join(OUT, 'film-noaudio'), fps: 12, denoise: 'auto' } });
      const naTxt = textOf(na);
      check('★★ make_film：草稿无可用音轨 ⇒ 仍出片（纯画面），不判失败',
        na.result?.isError !== true && /验收通过/.test(naTxt) && /纯画面片/.test(naTxt),
        naTxt.replace(/\s+/g, ' ').slice(-220));
    }
  } else {
    console.log(`  [SKIP] make_film 真 e2e —— 需要 env JYAI_DRAFT_LIB（草稿库）+ 剪映在跑；本机未提供 ⇒ 【不计入 PASS】`);
  }

  console.log(`\n=== ${PASS} PASS / ${FAIL} FAIL ===`);
  child.kill();
  process.exit(FAIL === 0 ? 0 : 1);
})();
