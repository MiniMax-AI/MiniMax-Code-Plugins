// ★ 参数覆盖自检：补上"schema 声明了但从未被端到端验证过"的那批参数
//
//   覆盖：grade_apply.noLut · verify_diff.threshold · verify_diff.noiseK
//         make_film.lut · make_film.maxFrames
//   ★ 每条判据都必须是【确定性】的：产物在不在、判据线变没变、帧数够不够
//     （不依赖"画面变没变"那种有噪声底的判断）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(HERE, '..', 'mcp', 'server.mjs');
const WORK = path.join(os.tmpdir(), 'jianying-params-' + Date.now());
const DRAFT = process.env.JYAI_FILM_DRAFT
  || (process.env.JYAI_DRAFT_LIB ? path.join(process.env.JYAI_DRAFT_LIB, 'JYAI能力批测9a-纯视频探针') : '');

function startServer() {
  const child = spawn(process.execPath, [SRV], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  return { child, rpc };
}
const textOf = (r) => (r.result?.content || []).map((c) => c.text || '').join('\n');

function ffmpeg() {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of ['', '.EXE', '.exe']) {
      const p = path.join(d, 'ffmpeg' + e);
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.env.ProgramFiles) {
    const p = path.join(process.env.ProgramFiles, 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}
function run(bin, args) {
  return new Promise((resolve) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; });
    c.stderr.on('data', (d) => { se += d; });
    c.on('close', (code) => resolve({ code, stdout: so, stderr: se }));
  });
}

export async function runParamsCheck() {
  const cases = [];
  const rec = (name, ok, detail) => cases.push({ name, ok: !!ok, detail: String(detail || '') });
  fs.mkdirSync(WORK, { recursive: true });

  const { child, rpc } = startServer();
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'param-probe', version: '1' } });

  // 造素材：① 1 秒灰视频（给 grade_apply）② 两张不同亮度的 png（给 verify_diff 的帧）
  const VIDEO = path.join(WORK, 'gray.mp4');
  await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=12:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VIDEO]);
  const framesFor = async (dir, color) => {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, '00000.png');
    await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64`, '-frames:v', '1', f]);
    return dir;
  };

  /* ── ① grade_apply.noLut：只出逐点直算版，不出 LUT 版 ── */
  {
    const outDir = path.join(WORK, 'ga-nolut');
    const r = await rpc('tools/call', {
      name: 'grade_apply',
      arguments: { src: VIDEO, outDir, frames: 4, noLut: true, spec: { adjustColor: { brightness: 0.2 } } },
    });
    const has10 = fs.existsSync(path.join(outDir, 'graded10.mp4'));
    const hasLut = fs.existsSync(path.join(outDir, 'graded_lut.mp4'));
    rec('grade_apply.noLut ⇒ 只出逐点直算版（graded10.mp4），不出 LUT 版',
      r.result?.isError !== true && has10 && !hasLut,
      `isError=${r.result?.isError === true} graded10=${has10} graded_lut=${hasLut} :: ${textOf(r).replace(/\s+/g, ' ').slice(0, 120)}`);
  }

  /* ── ② verify_diff.noiseK：判据线必须跟着 noiseK 变 ── */
  {
    const A = await framesFor(path.join(WORK, 'fr-a'), '0x606060');
    const B = await framesFor(path.join(WORK, 'fr-b'), '0x707070');
    // ★ noiseK 只在【给了噪声底目录】时参与判据线（bar = calibrated ? max(th, noiseMad*noiseK) : th）
    //   ⇒ 必须同时给 noiseDir + threshold=0，否则判据线恒等于 th ⇒ 测不出 noiseK
    const C = await framesFor(path.join(WORK, 'fr-c'), '0x616161');
    const k1 = await rpc('tools/call', { name: 'verify_diff', arguments: { beforeDir: A, afterDir: B, noiseDir: C, threshold: 0, noiseK: 1 } });
    const k3 = await rpc('tools/call', { name: 'verify_diff', arguments: { beforeDir: A, afterDir: B, noiseDir: C, threshold: 0, noiseK: 3 } });
    // ★ 判据线是【noiseBar】（不是 threshold —— 那个只是我传进去的阈值）
    const bar = (t) => {
      const m = /"noiseBar"\s*:\s*([0-9.]+)/.exec(textOf(t));
      return m ? Number(m[1]) : null;
    };
    // ★ 阳性前置：噪声底必须真的被算出来（calibrated=true 且 noiseMad>0）
    //   否则判据线不变可能只是"噪声底没生效"，那样就测不出 noiseK
    const calibrated = /"calibrated"\s*:\s*true/.test(textOf(k1));
    const noiseMad = (/"noiseMad"\s*:\s*([0-9.]+)/.exec(textOf(k1)) || [])[1];
    rec('verify_diff 噪声底被算出来（calibrated 且 noiseMad>0）⇒ 前提成立',
      calibrated && Number(noiseMad) > 0, `calibrated=${calibrated} noiseMad=${noiseMad}`);
    const t1 = bar(k1), t3 = bar(k3);
    rec('verify_diff.noiseK ⇒ 判据线随 noiseK 变化（给了噪声底才生效）',
      t1 !== null && t3 !== null && t3 !== t1, `noiseK=1 ⇒ 判据线 ${t1}；noiseK=3 ⇒ 判据线 ${t3}`);
  }

  /* ── ③ verify_diff.threshold：显式给的判据线要被采用 ── */
  {
    const A = await framesFor(path.join(WORK, 'fr-a'), '0x606060');
    const B = await framesFor(path.join(WORK, 'fr-b'), '0x707070');
    const r = await rpc('tools/call', {
      name: 'verify_diff', arguments: { beforeDir: A, afterDir: B, threshold: 42 },
    });
    const m = /"threshold"\s*:\s*([0-9.]+)/.exec(textOf(r));
    rec('verify_diff.threshold ⇒ 显式给的判据线被采用',
      m && Number(m[1]) === 42, `返回的判据线=${m ? m[1] : '(没读到)'}`);
  }

  /* ── ④ make_film.lut：外部 3D LUT 能被吃进去 ── */
  if (DRAFT && fs.existsSync(DRAFT)) {
    const out1 = path.join(WORK, 'mf-lut-src');
    const r1 = await rpc('tools/call', {
      name: 'make_film',
      arguments: { draft: DRAFT, outDir: out1, fps: 6, denoise: 'off', grade: { adjustColor: { temperature: 0.15 } } },
    });
    const cube = path.join(out1, 'grade.cube');
    const ok1 = r1.result?.isError !== true && fs.existsSync(cube);
    if (!ok1) {
      rec('make_film.lut ⇒ 外部 3D LUT 能被吃进去', false,
        `第一步（带 grade 产出 cube）失败：${textOf(r1).replace(/\s+/g, ' ').slice(0, 140)}`);
    } else {
      const out2 = path.join(WORK, 'mf-lut');
      const r2 = await rpc('tools/call', {
        name: 'make_film',
        arguments: { draft: DRAFT, outDir: out2, fps: 6, denoise: 'off', lut: cube },
      });
      const film = path.join(out2, 'film.mp4');
      rec('make_film.lut ⇒ 外部 3D LUT 能被吃进去（带 grade 的产出当外部 LUT 再走一遍）',
        r2.result?.isError !== true && fs.existsSync(film),
        `isError=${r2.result?.isError === true} film=${fs.existsSync(film)} :: ${textOf(r2).replace(/\s+/g, ' ').slice(0, 120)}`);
    }

    /* ── ⑤ make_film.maxFrames：截帧必须真的截（画面帧数 ≤ maxFrames）── */
    {
      const out = path.join(WORK, 'mf-maxframes');
      const r = await rpc('tools/call', {
        name: 'make_film',
        arguments: { draft: DRAFT, outDir: out, fps: 6, denoise: 'off', maxFrames: 6 },
      });
      let nFrames = -1;
      try {
        const info = await run(ffmpeg(), ['-v', 'error', '-i', path.join(out, 'film.mp4'), '-vf', 'select=gte(n\\,0)', '-vsync', '0', '-f', 'null', '-']);
        const m = /frame=\s*(\d+)/.exec(info.stderr);
        nFrames = m ? Number(m[1]) : -1;
      } catch { /* ignore */ }
      // ★ 实测语义：截帧 ⇒ 成片时长比官方时间线短 ⇒ 【验收不通过】并报错
      //   ⇒ 正确行为是"被抓住"，不是"出片成功"（否则就是音画不对齐的坏片）
      rec('make_film.maxFrames ⇒ 截帧导致时长对不齐 ⇒ 必须被验收拒绝（不是静默出坏片）',
        r.result?.isError === true && /验收不通过|时长/.test(textOf(r)),
        `isError=${r.result?.isError === true} 帧数=${nFrames} :: ${textOf(r).replace(/\s+/g, ' ').slice(-140)}`);
    }
  } else {
    rec('make_film.lut / maxFrames', false, '没有草稿库（JYAI_DRAFT_LIB）⇒ 无法验证');
  }

  /* ── ⑥ verify_diff.beforeVideo / afterVideo：音频维度要真的测出 LUFS ── */
  {
    // 造两个带音轨的 mp4（响度不同 ⇒ 两个 LUFS 必须不同，否则测的就是空气）
    const VA = path.join(WORK, 'a-tone.mp4');
    const VB = path.join(WORK, 'b-tone.mp4');
    await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-filter:a', 'volume=-18dB', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', VA]);
    await run(ffmpeg(), ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=12:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
      '-filter:a', 'volume=-6dB', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', VB]);
    const au = await rpc('tools/call', {
      name: 'verify_diff', arguments: { checks: ['audio'], beforeVideo: VA, afterVideo: VB },
    });
    const m = /"integratedLufs"\s*:\s*(-?[\d.]+)/g;
    const lufs = [...textOf(au).matchAll(m)].map((x) => Number(x[1]));
    rec('verify_diff.beforeVideo/afterVideo ⇒ 音频维度真的测出两个不同的 LUFS',
      lufs.length >= 2 && lufs[0] !== lufs[1],
      `LUFS=${lufs.join(', ')} :: ${textOf(au).replace(/\s+/g, ' ').slice(0, 120)}`);
    // ★ 缺参数时的行为：必须明说"跳过"，不能装作测过了
    const noVid = await rpc('tools/call', { name: 'verify_diff', arguments: { checks: ['audio'] } });
    rec('verify_diff 缺 beforeVideo/afterVideo ⇒ 明说 skipped（不装作测过了）',
      /skipped/.test(textOf(noVid)), textOf(noVid).replace(/\s+/g, ' ').slice(0, 140));
  }

  child.kill();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
  const pass = cases.filter((c) => c.ok).length;
  return { pass, fail: cases.length - pass, total: cases.length, cases };
}

const isMain = process.argv[1]
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const r = await runParamsCheck();
  console.log('=== 参数覆盖自检 ===\n');
  for (const c of r.cases) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.ok ? '' : '  — ' + c.detail}`);
  console.log(`\n=== ${r.pass} PASS / ${r.fail} FAIL ===`);
  process.exit(r.fail ? 1 : 0);
}
