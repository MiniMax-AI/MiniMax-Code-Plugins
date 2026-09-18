#!/usr/bin/env node
// html2video-for-mcode · 组装成片: 单张编码 → 拼接 → 音轨对位 → mux → 自检; --asr 按句切分校验 + 出 SRT 字幕。
// 用法: node build-video.mjs <项目目录> [--asr] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireTool, safeId, safeRel, safeOut, validateScriptPaths, validateTimingsIds } from './tools.mjs';

const argv = process.argv.slice(2);
const dir = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
const DRY = argv.includes('--dry-run');
const WANT_ASR = argv.includes('--asr');

process.env.KIT_PROJECT_DIR = dir;
const FFMPEG = requireTool('ffmpeg', dir);
const FFPROBE = requireTool('ffprobe', dir);

const run = (cmd, args, label) => {
  if (DRY) { console.log(`[dry-run] ${path.basename(cmd)} ${args.join(' ')}`); return ''; }
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    console.error(`✗ ${label || path.basename(cmd)} 失败:\n${(r.stderr || '').split('\n').slice(-8).join('\n')}`);
    process.exit(1);
  }
  return r.stdout ?? '';
};

const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
validateScriptPaths(script, dir); // script.json 是 agent 可编辑文件: id/audio/bgm 派生路径先收监
const timings = JSON.parse(fs.readFileSync(path.join(dir, 'build', 'timings.json'), 'utf8'));
validateTimingsIds(timings);
// W/H 会拼进 ffmpeg filter 字符串(scale=...), 强转整数并限范围, 防字符串注入
const W = clampDim(script.width, 1920, 'width'), H = clampDim(script.height, 1080, 'height');
function clampDim(v, dflt, name) {
  const n = Number(v ?? dflt);
  if (!Number.isInteger(n) || n < 16 || n > 16384) {
    console.error(`✗ script.${name} 非法: ${JSON.stringify(v)} — 需要 16–16384 的整数`);
    process.exit(1);
  }
  return n;
}
const fps = clampNum(timings.fps ?? script.fps, 30, 'fps', 1, 240, 'timings.fps/script.fps');
const total = timings.total;
const abs = p => path.resolve(p).replace(/\\/g, '/');
// 同 clampDim, 但允许小数、不带默认值兜底(bgm.volume/fade 这类会拼进 ffmpeg -filter_complex 的数值都用它)
function clampNum(v, dflt, name, min, max, where = `script.${name}`) {
  const n = Number(v ?? dflt);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.error(`✗ ${where} 非法: ${JSON.stringify(v)} — 需要 ${min}–${max} 的数值(该值会拼进 ffmpeg 参数)`);
    process.exit(1);
  }
  return n;
}
// BGM 数值全部在编码开始前定下来: 坏配置要立刻失败, 不能等渲完几分钟才报(这批值都会拼进 -filter_complex)
const bgmCfgRaw = script.bgm ? (typeof script.bgm === 'string' ? { file: script.bgm } : script.bgm) : null;
const bgmNum = bgmCfgRaw ? {
  vol: clampNum(bgmCfgRaw.volume, 0.12, 'volume', 0, 4, 'bgm.volume'),
  fi: clampNum(bgmCfgRaw.fadeIn, 1.5, 'fadeIn', 0, 30, 'bgm.fadeIn'),
  fo: clampNum(bgmCfgRaw.fadeOut, 2.5, 'fadeOut', 0, 30, 'bgm.fadeOut'),
} : null;

const probeDur = f => {
  const out = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], `ffprobe ${path.basename(f)}`);
  const d = parseFloat((out || '').trim().split('\n')[0]);
  return Number.isFinite(d) ? d : null;
};
const probeSize = f => {
  const out = run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], `ffprobe size ${path.basename(f)}`);
  const m = (out || '').trim().match(/(\d+),(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
};

fs.mkdirSync(safeOut(dir, 'out'), { recursive: true });
fs.mkdirSync(safeOut(dir, 'build'), { recursive: true });

// ── 1. 单张编码 ─────────────────────────────────────────────
const segs = [];
for (const t of timings.slides) {
  const tid = safeId(t.id);
  const D = t.duration;
  const fadeOut = Math.max(0, D - 0.35);
  const fades = `fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOut.toFixed(3)}:d=0.3`;
  const fdir = path.join(dir, 'build', 'frames', tid);
  const firstFrame = path.join(fdir, 'f00000.png');
  const png = path.join(dir, 'preview', `${tid}.png`);
  const seg = safeOut(dir, 'out', `slide-${tid}.mp4`);
  const common = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart'];
  const stillPng = k => path.join(dir, 'build', 'substills', tid, `s${k}.png`);

  // 字幕时间轴(二审 P1): 帧序列只覆盖动画窗, 之后的字幕变化要靠 capture 逐句截的静态图拼上来;
  // 静态/no-fx 路径没有帧序列, 整张就由"基底图 + 逐句字幕图"拼成(否则整片一帧字幕都没有)
  let subStills = [];
  try {
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'build', 'substills', `${tid}.json`), 'utf8'));
    subStills = (man.stills ?? []).filter(s2 => Number.isFinite(s2.start) && Number.isFinite(s2.end) &&
      s2.end - s2.start > 0.02 && fs.existsSync(stillPng(s2.k)));
  } catch { /* 没清单 = 这张不需要拼字幕 */ }

  // 多段拼接: 每段一个输入, 段长由窗口决定, 末段补齐到整张时长(吃掉取整误差)
  const encodeParts = (parts, label) => {
    const sum = parts.reduce((a, p) => a + p.dur, 0);
    parts[parts.length - 1].dur += D - sum;
    const needScale = parts.some(p => { const sz = probeSize(p.src); return !!sz && (sz[0] !== W || sz[1] !== H); });
    const chains = parts.map((p, i) => `[${i}:v]${needScale ? `scale=${W}:${H}:flags=lanczos,` : ''}setsar=1,fps=${fps}[v${i}]`).join(';');
    const cat = parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[cat]`;
    const args = ['-y'];
    for (const p of parts) {
      if (p.kind === 'frames') args.push('-framerate', String(fps), '-t', p.dur.toFixed(4), '-i', p.src);
      else args.push('-loop', '1', '-framerate', String(fps), '-t', p.dur.toFixed(4), '-i', p.src);
    }
    run(FFMPEG, [...args, '-filter_complex', `${chains};${cat};[cat]${fades}[out]`, '-map', '[out]', '-t', D.toFixed(4), ...common, seg], label);
  };

  if (fs.existsSync(firstFrame)) {
    const nFrames = fs.readdirSync(fdir).filter(f => /^f\d+\.png$/.test(f)).length;
    const framesDur = nFrames / fps;
    if (subStills.length) {
      encodeParts([
        { kind: 'frames', src: path.join(fdir, 'f%05d.png'), dur: framesDur },
        ...subStills.map(s2 => ({ kind: 'still', src: stillPng(s2.k), dur: s2.end - s2.start })),
      ], `编码 ${tid} (帧序列 ${framesDur.toFixed(1)}s + ${subStills.length} 段字幕)`);
    } else {
      let vf = [`tpad=stop_mode=clone:stop_duration=${(D + 1).toFixed(3)}`];
      const sz = probeSize(firstFrame);
      if (sz && (sz[0] !== W || sz[1] !== H)) vf.push(`scale=${W}:${H}:flags=lanczos`); // dsf 2 超采样降采
      vf.push(fades);
      run(FFMPEG, ['-y', '-framerate', String(fps), '-i', path.join(fdir, 'f%05d.png'),
        '-vf', vf.join(','), '-t', D.toFixed(4), ...common, seg], `编码 ${tid} (帧序列)`);
    }
  } else if (fs.existsSync(png)) {
    // still 复截会把该张帧目录作废(capture 的防旧帧污染设计), 回退静态图 = 该张动画不进视频;
    // "改完 HTML 跑 still 复看再直接 build-video"极易踩进且此前零提示, 必须点名怎么补
    console.warn(`⚠ ${tid} 无帧序列, 用 preview/${tid}.png 静态图出片(该张动画不进视频) — 若应有动画: node scripts/capture.mjs <项目目录> --mode motion --ids ${tid} 后重建`);
    if (subStills.length) {
      const head = subStills[0].start;                 // 第一句开口前: 无字幕的基底图
      encodeParts([
        ...(head > 0.02 ? [{ kind: 'still', src: png, dur: head }] : []),
        ...subStills.map(s2 => ({ kind: 'still', src: stillPng(s2.k), dur: s2.end - s2.start })),
      ], `编码 ${tid} (静态图 + ${subStills.length} 段字幕)`);
    } else {
      let vf = [fades];
      const sz = probeSize(png);
      if (sz && (sz[0] !== W || sz[1] !== H)) vf.unshift(`scale=${W}:${H}:flags=lanczos`);
      run(FFMPEG, ['-y', '-loop', '1', '-framerate', String(fps), '-i', png,
        '-vf', vf.join(','), '-t', D.toFixed(4), ...common, seg], `编码 ${tid} (静态图)`);
    }
  } else {
    console.error(`✗ ${tid} 既无帧序列也无 preview/${tid}.png — 先运行 capture.mjs`);
    process.exit(1);
  }
  const d = probeDur(seg);
  if (d != null && Math.abs(d - D) > 0.2) console.warn(`⚠ ${tid} 段长 ${d.toFixed(2)}s ≠ 预期 ${D.toFixed(2)}s`);
  segs.push(seg);
}

// ── 2. 拼接视频(同参数段, 先无损 copy; 时长漂移则自动回退重编码) ──
const listFile = path.join(dir, 'build', 'concat.txt');
fs.writeFileSync(listFile, segs.map(s => `file '${abs(s).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
const noaudio = path.join(dir, 'build', 'video-noaudio.mp4');
run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', noaudio], '拼接(copy)');
let vd = probeDur(noaudio);
if (vd == null || Math.abs(vd - total) > 0.25) {
  console.warn(`⚠ copy 拼接时长 ${vd?.toFixed(2) ?? '?'}s 偏离预期 ${total.toFixed(2)}s — 回退 concat filter 重编码`);
  const inputs = segs.flatMap(s => ['-i', s]);
  const fc = segs.map((_, i) => `[${i}:v]`).join('') + `concat=n=${segs.length}:v=1:a=0[v]`;
  run(FFMPEG, ['-y', ...inputs, '-filter_complex', fc, '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-r', String(fps), '-movflags', '+faststart', noaudio], '拼接(重编码)');
  vd = probeDur(noaudio);
}

// ── 3. 音轨对位(每段按实测时长补静音到整张, 再顺序拼接) ──────
const audioInputs = [];
const chains = [];
timings.slides.forEach((t, i) => {
  const tid = safeId(t.id);
  const audioRel = script.slides.find(s => s.id === tid)?.audio ?? `${tid}.mp3`;
  const a = safeRel(path.join(dir, 'audio'), audioRel, { where: `slides[${tid}].audio` });
  if (!fs.existsSync(a)) { console.error(`✗ 缺音频 ${a}`); process.exit(1); }
  audioInputs.push(a);
  chains.push(`[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=whole_dur=${t.duration.toFixed(4)}[s${i}]`);
});
const audioWav = path.join(dir, 'build', 'audio-timeline.wav');
run(FFMPEG, ['-y', ...audioInputs.flatMap(a => ['-i', a]),
  '-filter_complex', [...chains, `${chains.map((_, i) => `[s${i}]`).join('')}concat=n=${chains.length}:v=0:a=1[out]`].join(';'),
  '-map', '[out]', '-c:a', 'pcm_s16le', audioWav], '音轨对位');

// ── 4. BGM(可选): script.json 里配 bgm 即自动垫底 — 循环补齐、淡入淡出、人声优先 ──
let audioFinal = audioWav;
if (script.bgm) {
  const cfg = bgmCfgRaw;
  const { vol, fi, fo } = bgmNum;
  const bgmPath = safeRel(dir, cfg.file, { where: 'bgm.file' }); // 拒绝绝对路径与越界(原来的 path.resolve 会整体逃逸)
  if (!fs.existsSync(bgmPath)) {
    console.warn(`⚠ 配置了 bgm 但找不到 ${bgmPath} — 跳过, 只出人声`);
  } else {
    const mixWav = path.join(dir, 'build', 'audio-mix.wav');
    const fc = `[1:a]aresample=44100,aformat=channel_layouts=mono,volume=${vol},`
      + `afade=t=in:st=0:d=${fi},afade=t=out:st=${Math.max(0, total - fo).toFixed(3)}:d=${fo}[bg];`
      + `[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]`;
    const r = spawnSync(FFMPEG, ['-y', '-i', audioWav, '-stream_loop', '-1', '-i', bgmPath,
      '-filter_complex', fc, '-map', '[out]', '-c:a', 'pcm_s16le', mixWav], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) {
      audioFinal = mixWav;
      console.log(`  BGM: ${cfg.file} @音量 ${vol} (淡入 ${fi}s / 淡出 ${fo}s, 自动循环补满)`);
    } else {
      console.warn('⚠ BGM 混音失败(amix normalize 需 ffmpeg ≥ 4.4) — 已跳过, 只出人声');
    }
  }
}

// ── 5. mux ──────────────────────────────────────────────────
const final = path.join(dir, 'out', 'final.mp4');
run(FFMPEG, ['-y', '-i', noaudio, '-i', audioFinal, '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final], 'mux 成片');

// ── 6. 自检 ─────────────────────────────────────────────────
const fd = probeDur(final);
const okDur = fd != null && Math.abs(fd - total) <= 0.25;
const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', final, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
const okDecode = decode.status === 0;
console.log(`\n成片: ${abs(final)}`);
console.log(`  时长 ${fd?.toFixed(2) ?? '?'}s / 预期 ${total.toFixed(2)}s ${okDur ? '✓' : '✗'}`);
console.log(`  全量解码 ${okDecode ? '✓ 无错误' : '✗ ' + (decode.stderr || '').slice(0, 300)}`);
if (!okDur || !okDecode) process.exit(1);

// ── 7. SRT 字幕文件(与烧录字幕同源同窗, 供平台上传用) ────────
const srt = [];
let srtIdx = 1, cum = 0;
for (const t of timings.slides) {
  if (Array.isArray(t.clauses)) {
    for (let i = 0; i < t.clauses.length; i++) {
      const c = t.clauses[i];
      const start = cum + c.start;
      const end = cum + (t.clauses[i + 1]?.start ?? t.duration);
      if (end - start < 0.05) continue;
      const fmt = s => {
        const ms = Math.round((s % 1) * 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
      };
      srt.push(`${srtIdx++}\n${fmt(start)} --> ${fmt(end)}\n${c.text}${c.text2 ? '\n' + c.text2 : ''}\n`);
    }
  }
  cum += t.duration;
}
if (srt.length) {
  fs.writeFileSync(safeOut(dir, 'out', 'subs.srt'), srt.join('\n'));
  console.log(`  字幕 out/subs.srt (${srt.length} 条, 与画面烧录字幕同源)`);
}

// ── 8. ASR 按句切分 + 校验清单 ──────────────────────────────
if (WANT_ASR) {
  fs.mkdirSync(safeOut(dir, 'asr'), { recursive: true });
  for (const old of fs.readdirSync(path.join(dir, 'asr')).filter(f => f.startsWith('part-'))) {
    fs.rmSync(safeOut(dir, 'asr', old)); // 清掉上一轮的旧切分, 避免新旧混淆
  }
  const lines = ['# ASR 反向校验(按句切分)', '',
    '每段 = 一句口播。逐段上传转写(mcode: upload_temp_url → connector__matrix__listen_audio), 与"预期文本"比对:',
    '数字/年份/产品名必须完全一致; 同音字与标点差异可接受。同时核对: 若某段转写混入了上一句的开头,',
    '说明该句实际开口比估算晚 → 跑 node scripts/check-timing.mjs 做静音实测校准。',
    '不过关的 slide: 改口播或重做该段 TTS → 重跑 plan-timings → 删 build/frames/<id>/ 与 out/slide-<id>.mp4 后重建。', '',
    '| part | 全片时间 | 预期文本 | ASR 转写 | 通过? |', '|---|---|---|---|---|'];
  let count = 0;
  cum = 0;
  for (const t of timings.slides) {
    const tid = safeId(t.id);
    const clauses = Array.isArray(t.clauses) && t.clauses.length ? t.clauses : [{ start: 0, text: t.script }];
    clauses.forEach((c, i) => {
      const end = t.clauses[i + 1]?.start ?? t.duration;
      const part = path.join(dir, 'asr', `part-${tid}-${i + 1}.mp3`);
      run(FFMPEG, ['-y', '-ss', (cum + c.start).toFixed(3), '-t', (end - c.start).toFixed(3), '-i', audioWav,
        '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '128k', part], `ASR 切分 ${tid}-${i + 1}`);
      lines.push(`| asr/part-${tid}-${i + 1}.mp3 | ${(cum + c.start).toFixed(1)}s | ${c.text} |  |  |`);
      count++;
    });
    cum += t.duration;
  }
  fs.writeFileSync(path.join(dir, 'asr', 'checklist.md'), lines.join('\n') + '\n');
  console.log(`  ASR 素材与清单已生成: asr/ (${count} 句, 每句独立切分)`);
}
console.log('\n完成 ✅');
