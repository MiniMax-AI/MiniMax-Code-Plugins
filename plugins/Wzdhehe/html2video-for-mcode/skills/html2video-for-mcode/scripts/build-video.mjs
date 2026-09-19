#!/usr/bin/env node
// html2video-for-mcode · 组装成片: 单张编码 → 拼接 → 音轨对位 → mux → 自检; --asr 按句切分校验 + 出 SRT 字幕。
// 用法: node build-video.mjs <项目目录> [--asr] [--dry-run] [--allow-stale-css]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { XFADE_DEFAULT_DUR, flagValue, positionalDir, probeDuration as ffprobeDuration, probeSize as ffprobeDims, readTransition, requireFreshCss, requireTool, safeId, safeOut, safeRel, validateScriptPaths, validateTimingsIds } from './tools.mjs';

const argv = process.argv.slice(2);
const dir = positionalDir(argv);
const DRY = argv.includes('--dry-run');
const WANT_ASR = argv.includes('--asr');

// 入口闸门(与 capture 同一道): 受管块落后即停 —— 否则成片用的是旧 CSS, 全程没有任何报错
requireFreshCss(dir, { who: 'build-video', allowStale: argv.includes('--allow-stale-css') });

process.env.KIT_PROJECT_DIR = dir;

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

// 工具发现放在全部配置校验之后: 配置写错就是配置写错, 与这台机器上有没有 ffmpeg 无关。
// 反过来的话, 少装了 ffmpeg 的人拿到的是"找不到 ffmpeg"(退出 2), 真正要报的 width/bgm/fps 非法被吞掉。
const FFMPEG = requireTool('ffmpeg', dir);
const FFPROBE = requireTool('ffprobe', dir);

// ffprobe 探测收进 tools.mjs 单一实现(第十三轮 review 去重); 这里保留本地薄封装, 调用点不动。
const probeDur = f => ffprobeDuration(FFPROBE, f);
const probeSize = f => ffprobeDims(FFPROBE, f);

fs.mkdirSync(safeOut(dir, 'out'), { recursive: true });
fs.mkdirSync(safeOut(dir, 'build'), { recursive: true });

// ── 1. 单张编码 ─────────────────────────────────────────────
// 转场(1.6.0): 默认"硬切" —— 段间不再淡出到黑再淡入(那会在每次切页留 ≈0.55s 纯黑,
// 实测反馈"每一个大页切换过程会经过黑屏")。首段用封面溶解进入(帧 0 = 完整封面, 不再是黑帧),
// 末段保留结尾淡出收尾;中间段之间是硬切。xfade 溶解见 TRANSITION。
// 解析统一走 tools.readTransition(): --transition <值> / "--transition=<值>" / script.transition 三个来源,
// 以及裸字符串与 {type,duration} 两种写法, 闸门(check-slides)与这里必须得到完全一致的结论(D6)。
const TRANSITION = (() => {
  const a = argv.find(x => x.startsWith('--transition='));
  const cli = flagValue(argv, '--transition', null);
  const v = (a ? a.split('=')[1] : cli) ?? script.transition ?? null;
  // CLI(或裸字符串)只给了类型时, 时长仍取 script.transition.duration —— 老行为:
  // {duration:1.5} + --transition xfade = 1.5s; 不能因为换了解析函数就悄悄退回 0.4s
  const merged = typeof v === 'string' && script.transition && typeof script.transition === 'object'
    ? { type: v, duration: script.transition.duration ?? XFADE_DEFAULT_DUR }
    : v;
  try {
    // 报错要点名来源: --transition 写错时不该说成 script.transition 写错
    return readTransition(merged, { where: (a || cli) ? '--transition' : 'script.transition' });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
})();
const coverPath = path.join(dir, 'preview', 'cover.png');
const hasCover = fs.existsSync(coverPath);
if (TRANSITION.type === 'xfade') console.log(`  转场: 交叉溶解 ${TRANSITION.dur}s(段尾各多留 ${TRANSITION.dur}s, 叠化后总时长不变)`);
else console.log('  转场: 硬切(段间不淡出到黑;首段封面溶解、末段淡出收尾)');

const segs = [];
const segDurs = [];
const nSeg = timings.slides.length;
for (const [segIdx, t] of timings.slides.entries()) {
  const tid = safeId(t.id);
  const D = t.duration;
  const isFirst = segIdx === 0, isLast = segIdx === nSeg - 1;
  // xfade: 除末段外每段多留 transition.dur 的尾帧(叠化时被吃掉, 总时长仍等于 timings.total)
  const tailHold = TRANSITION.type === 'xfade' && !isLast ? TRANSITION.dur : 0;
  const fadeOut = Math.max(0, D - 0.35);
  // 淡出只留给末段收尾;淡入一律不用(首段走封面溶解,其余硬切)
  const fades = isLast ? `fade=t=out:st=${fadeOut.toFixed(3)}:d=0.3` : '';
  const fdir = path.join(dir, 'build', 'frames', tid);
  const firstFrame = path.join(fdir, 'f00000.png');
  const png = path.join(dir, 'preview', `${tid}.png`);
  const seg = safeOut(dir, 'out', `slide-${tid}.mp4`);
  const common = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart'];
  const stillPng = k => path.join(dir, 'build', 'substills', tid, `s${k}.png`);
  // 首段的"封面溶解": 封面淡出叠在画面上 → 帧 0 = 完整封面, 0.25s 内溶解进入入场动画(不加时长)。
  // (2026-09-18 复查 E5: 这里原本是个带 input/chain 两个字段的结构体, 两个字段都是死代码 ——
  //  真正管用的判断在 encode() 里, 改成布尔, 少一处"看起来会用"的误导。)
  const useCoverOverlay = isFirst && hasCover;

  // 字幕时间轴(二审 P1): 帧序列只覆盖动画窗, 之后的字幕变化要靠 capture 逐句截的静态图拼上来;
  // 静态/no-fx 路径没有帧序列, 整张就由"基底图 + 逐句字幕图"拼成(否则整片一帧字幕都没有)。
  // 复查补(1.7.0): 清单必须与当前这张对齐才用 —— 否则删掉 clauses/改过时长之后, 陈旧清单会把
  // 早已不存在的字幕拼回成片(capture 已按张清理, 这里再做一次防御性核对, 因为清单是磁盘文件)
  let subStills = [];
  const manPath = path.join(dir, 'build', 'substills', `${tid}.json`);
  if (fs.existsSync(manPath)) {
    let man = null;
    try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch { /* 坏清单按无处理 */ }
    const clauseCount = Array.isArray(t.clauses) ? t.clauses.length : 0;
    const durOk = man && Number.isFinite(man.duration) && Math.abs(man.duration - D) <= 0.05;
    // 清单的 framesCover 必须等于"当前帧序列的实际时长"(无帧序列 = 0)。时长与句序都对、
    // 但动画窗重截过(帧数变了)的清单, 会把字幕静帧从错误的时刻拼进成片 —— B2 点名的第三项。
    const nFramesNow = fs.existsSync(fdir) ? fs.readdirSync(fdir).filter(f => /^f\d+\.png$/.test(f)).length : 0;
    const coverNow = nFramesNow / fps;
    const coverOk = man && Number.isFinite(man.framesCover) && Math.abs(man.framesCover - coverNow) <= 0.05;
    if (man && !durOk) console.warn(`⚠ ${tid}: 字幕清单时长 ${man.duration}s ≠ 当前 ${D}s — 忽略该清单(重跑 capture 生成)`);
    if (man && durOk && !coverOk) console.warn(`⚠ ${tid}: 字幕清单帧覆盖 ${man.framesCover}s ≠ 当前 ${coverNow}s — 忽略该清单(重跑 capture 生成)`);
    if (man && durOk && coverOk && clauseCount === 0) console.warn(`⚠ ${tid}: 当前没有 clauses 但存在字幕清单 — 忽略(重跑 capture 会清掉)`);
    if (man && durOk && coverOk && clauseCount > 0) {
      subStills = (man.stills ?? []).filter(s2 => Number.isFinite(s2.start) && Number.isFinite(s2.end) &&
        s2.start >= -0.001 && s2.end <= man.duration + 0.05 &&
        s2.end - s2.start > 0.02 && Number.isInteger(s2.k) && s2.k >= 0 && s2.k < clauseCount &&
        fs.existsSync(stillPng(s2.k)));
    }
  }

  // 统一走 filter_complex, 标签式组装: 基底 → (首段: 封面溶解) → (末段: 淡出)
  // 这样三种编码路径(帧序列+字幕段 / 帧序列 / 静态图)共用同一段收尾逻辑, 不会再出现
  // "-vf 里拼空字符串" 那类边界(硬切时 fades 为空)。
  const DUR = D + tailHold;                       // 实际编码时长(xfade 时多留尾帧)
  const encode = (inputs, baseGraph, baseLabel, label) => {
    const graph = [baseGraph];
    let cur = baseLabel;
    if (useCoverOverlay) {
      const ovIdx = inputs.length;
      graph.push(`[${ovIdx}:v]scale=${W}:${H}:flags=lanczos,setsar=1,fade=t=out:st=0:d=0.25[ov]`);
      graph.push(`[${cur}][ov]overlay=format=auto[merged]`);
      cur = 'merged';
      inputs = [...inputs, { args: ['-loop', '1', '-i', coverPath] }];
    }
    if (fades) { graph.push(`[${cur}]${fades}[fin]`); cur = 'fin'; }
    const args = ['-y', ...inputs.flatMap(i => i.args)];
    run(FFMPEG, [...args, '-filter_complex', graph.join(';'), '-map', `[${cur}]`, '-t', DUR.toFixed(4), ...common, seg], label);
  };

  // [逐张素材] → concat 段的组装(两处调用: 帧序列+字幕段 / 静态图+字幕段)。
  // 2026-09-18 复查 E5: 这段拼装原先是复制两份的(只有"每段各自探尺寸"vs"整张一个前缀"这点差别),
  // 差别用 preOf 一个回调表达, 于是"末段补齐到整张时长"这条关键规则只有一处实现。
  const SCALE = `scale=${W}:${H}:flags=lanczos,`;
  const encodeConcat = (parts, { preOf, label }) => {
    const sum = parts.reduce((a, p) => a + p.dur, 0);
    parts[parts.length - 1].dur += (D + tailHold) - sum;   // 末段补齐: 吃掉取整误差, 总长严格 = D+tailHold
    const chains = parts.map((p, i) => `[${i}:v]${preOf(p)}setsar=1,fps=${fps}[v${i}]`).join(';');
    const cat = parts.map((_, i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=1:a=0[cat]`;
    const inputs = parts.map(p => ({ args: p.kind === 'frames'
      ? ['-framerate', String(fps), '-t', p.dur.toFixed(4), '-i', p.src]
      : ['-loop', '1', '-framerate', String(fps), '-t', p.dur.toFixed(4), '-i', p.src] }));
    encode(inputs, `${chains};${cat}`, 'cat', label);
  };

  if (fs.existsSync(firstFrame)) {
    const nFrames = fs.readdirSync(fdir).filter(f => /^f\d+\.png$/.test(f)).length;
    const framesDur = nFrames / fps;
    if (subStills.length) {
      // [帧序列段] + [每句字幕段]: 段长由字幕窗口决定, 末段补齐到整张时长(吃掉取整误差)
      const parts = [
        { kind: 'frames', src: path.join(fdir, 'f%05d.png'), dur: framesDur },
        ...subStills.map(s2 => ({ kind: 'still', src: stillPng(s2.k), dur: s2.end - s2.start })),
      ];
      // 帧序列与字幕静帧可能尺寸不同(dsf 超采样), 所以逐段各自探尺寸
      const preOf = p => { const sz = probeSize(p.src); return sz && (sz[0] !== W || sz[1] !== H) ? SCALE : ''; };
      encodeConcat(parts, { preOf, label: `编码 ${tid} (帧序列 ${framesDur.toFixed(1)}s + ${subStills.length} 段字幕)` });
    } else {
      const sz = probeSize(firstFrame);
      const pre = [`tpad=stop_mode=clone:stop_duration=${(DUR + 1).toFixed(3)}`];
      if (sz && (sz[0] !== W || sz[1] !== H)) pre.push(`scale=${W}:${H}:flags=lanczos`); // dsf 2 超采样降采
      encode([{ args: ['-framerate', String(fps), '-i', path.join(fdir, 'f%05d.png')] }],
        `[0:v]${pre.join(',')},setsar=1,${'fps=' + fps}[base]`, 'base', `编码 ${tid} (帧序列)`);
    }
  } else if (fs.existsSync(png)) {
    // still 复截会把该张帧目录作废(capture 的防旧帧污染设计), 回退静态图 = 该张动画不进视频;
    // "改完 HTML 跑 still 复看再直接 build-video"极易踩进且此前零提示, 必须点名怎么补
    console.warn(`⚠ ${tid} 无帧序列, 用 preview/${tid}.png 静态图出片(该张动画不进视频) — 若应有动画: node scripts/capture.mjs <项目目录> --mode motion --ids ${tid} 后重建`);
    const sz = probeSize(png);
    const pre = [];
    if (sz && (sz[0] !== W || sz[1] !== H)) pre.push(`scale=${W}:${H}:flags=lanczos`);
    pre.push('setsar=1', `fps=${fps}`);
    if (subStills.length) {
      const head = subStills[0].start;                 // 第一句开口前: 无字幕的基底图
      const parts = [
        ...(head > 0.02 ? [{ kind: 'still', src: png, dur: head }] : []),
        ...subStills.map(s2 => ({ kind: 'still', src: stillPng(s2.k), dur: s2.end - s2.start })),
      ];
      // 这一支里所有段都是同一尺寸的静态图, 所以共用一个前缀
      const preOf = () => (sz && (sz[0] !== W || sz[1] !== H) ? SCALE : '');
      encodeConcat(parts, { preOf, label: `编码 ${tid} (静态图 + ${subStills.length} 段字幕)` });
    } else {
      encode([{ args: ['-loop', '1', '-i', png] }],
        `[0:v]${pre.join(',')}[base]`, 'base', `编码 ${tid} (静态图)`);
    }
  } else {
    console.error(`✗ ${tid} 既无帧序列也无 preview/${tid}.png — 先运行 capture.mjs`);
    process.exit(1);
  }
  segs.push(seg);
  segDurs.push(DUR);
  const d = probeDur(seg);
  if (d != null && Math.abs(d - DUR) > 0.2) console.warn(`⚠ ${tid} 段长 ${d.toFixed(2)}s ≠ 预期 ${DUR.toFixed(2)}s`);
}

// ── 2. 拼接视频 ──────────────────────────────────────────────
// cut(默认): 同参数段无损 copy 拼接(段间是硬切, 不再经过黑场)。
// xfade: 段尾已各多留 dur 秒尾帧, 这里用 xfade 叠化 —— 叠化吃掉 (n-1)×dur, 总时长仍等于 timings.total。
const noaudio = safeOut(dir, 'build', 'video-noaudio.mp4');
let vd = null;
if (TRANSITION.type === 'xfade' && segs.length > 1) {
  const inputs = segs.flatMap(s => ['-i', s]);
  let fc = '', cur = '[0:v]', acc = 0;
  for (let i = 1; i < segs.length; i++) {
    acc += segDurs[i - 1] - TRANSITION.dur;
    const out = i === segs.length - 1 ? '[v]' : `[x${i}]`;
    fc += `${cur}[${i}:v]xfade=transition=fade:duration=${TRANSITION.dur}:offset=${acc.toFixed(3)}${out};`;
    cur = out;
  }
  run(FFMPEG, ['-y', ...inputs, '-filter_complex', fc.slice(0, -1), '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-r', String(fps), '-movflags', '+faststart', noaudio], '拼接(xfade 溶解)');
  vd = probeDur(noaudio);
} else {
  const listFile = safeOut(dir, 'build', 'concat.txt');
  fs.writeFileSync(listFile, segs.map(s => `file '${abs(s).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', noaudio], '拼接(copy)');
  vd = probeDur(noaudio);
}
if (vd == null || Math.abs(vd - total) > 0.25) {
  console.warn(`⚠ 拼接时长 ${vd?.toFixed(2) ?? '?'}s 偏离预期 ${total.toFixed(2)}s — 回退 concat filter 重编码`);
  const inputs = segs.flatMap(s => ['-i', s]);
  const fc = segs.map((_, i) => `[${i}:v]`).join('') + `concat=n=${segs.length}:v=1:a=0[v]`;
  run(FFMPEG, ['-y', ...inputs, '-filter_complex', fc, '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-r', String(fps), '-movflags', '+faststart', noaudio], '拼接(重编码)');
  vd = probeDur(noaudio);
}

// ── 2b. 封面(1.6.0): 导出 out/cover.png 供平台上传; 成片里内嵌 attached_pic ──
const coverOut = hasCover ? safeOut(dir, 'out', 'cover.png') : null;
if (hasCover) {
  const szc = probeSize(coverPath);
  run(FFMPEG, ['-y', '-i', coverPath, ...(szc && (szc[0] !== W || szc[1] !== H) ? ['-vf', `scale=${W}:${H}:flags=lanczos`] : []),
    '-frames:v', '1', coverOut], '导出封面 out/cover.png');
  console.log('  封面: out/cover.png(画布尺寸)+ 成片内嵌 attached_pic(文件管理器/IM 的缩略图读它)');
} else {
  console.warn('⚠ 缺 preview/cover.png(封面图)—— 重跑 capture 会为第 1 张生成; 现在成片没有内嵌封面');
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
const audioWav = safeOut(dir, 'build', 'audio-timeline.wav');
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
    const mixWav = safeOut(dir, 'build', 'audio-mix.wav');
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
// 封面走 attached_pic: 主视频流仍然 copy(不重编码), 封面是单帧 PNG 流 ——
// 文件管理器 / 多数播放器 / 部分 IM 的缩略图直接读它, 发给别人时不再是黑首帧。
// 注意: 内嵌封面时不能带 -shortest(会把输出截到那一帧的长度), 音轨本身已按总时长对齐。
const final = safeOut(dir, 'out', 'final.mp4');
run(FFMPEG, hasCover
  ? ['-y', '-i', noaudio, '-i', audioFinal, '-i', coverPath, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:v:0',
    '-c:v:0', 'copy', '-c:a', 'aac', '-b:a', '192k', '-c:v:1', 'png', '-disposition:v:1', 'attached_pic',
    '-movflags', '+faststart', final]
  : ['-y', '-i', noaudio, '-i', audioFinal, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final],
  'mux 成片');

// ── 6. 自检 ─────────────────────────────────────────────────
// --dry-run 什么都没真编码, 产物不存在 → 自检必然全红。以前它会照跑并退出 1, 于是"看一眼计划"
// 这个用法总是在 CI/agent 里报失败(2026-09-18 复查 D6 时踩到)。dry-run 下只打印计划, 直接成功。
if (DRY) {
  console.log('[dry-run] 已打印完整计划(未编码、未写产物), 跳过自检');
  process.exit(0);
}
const fd = probeDur(final);
const okDur = fd != null && Math.abs(fd - total) <= 0.25;
const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', final, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
const okDecode = decode.status === 0;
console.log(`\n成片: ${abs(final)}`);
console.log(`  时长 ${fd?.toFixed(2) ?? '?'}s / 预期 ${total.toFixed(2)}s ${okDur ? '✓' : '✗'}`);
console.log(`  全量解码 ${okDecode ? '✓ 无错误' : '✗ ' + (decode.stderr || '').slice(0, 300)}`);

// 画面级自检(1.6.0): 首帧是不是黑、切页处有没有黑帧、封面在不在 —— 这三类此前全靠人眼,
// 而"发给别人看到黑缩略图""每次切页黑屏"恰恰是用户实测反馈出来的。
const meanLuma = t => {
  const o = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(t), '-i', final, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
  return m ? parseFloat(m[1]) : null;
};
const BLACK = 16;                                     // 视频黑电平 ~16(YAVG); 低于它按"黑帧"处理
const gates = [];
// ① 首帧: 不能是黑帧(封面溶解后应为完整封面)
if (!hasCover) {
  const l0 = meanLuma(0.05);
  gates.push({ ok: l0 == null || l0 > BLACK, msg: `首帧亮度 ${l0?.toFixed(0) ?? '?'}(应 > ${BLACK}) —— 分享时的缩略图就是它` });
} else {
  gates.push({ ok: true, msg: '封面已内嵌(attached_pic), 缩略图不依赖首帧' });
  const l0 = meanLuma(0.05);
  gates.push({ ok: l0 == null || l0 > BLACK, msg: `首帧亮度 ${l0?.toFixed(0) ?? '?'}(应 > ${BLACK}, 封面溶解)` });
}
// ② 切页处不能有黑帧(硬切/溶解都不该经过黑场)
let blackCuts = 0;
let cum2 = 0;
for (let i = 0; i < timings.slides.length - 1; i++) {
  cum2 += timings.slides[i].duration;
  for (const dt of [-0.12, 0, 0.12]) {
    const l = meanLuma(Math.max(0, cum2 + dt));
    if (l != null && l <= BLACK) { blackCuts++; break; }
  }
}
gates.push({ ok: blackCuts === 0, msg: blackCuts ? `${blackCuts} 处切页检出黑帧(转场不应经过黑场; 检查 transition 与 fade 设置)` : '切页无黑帧' });
for (const g of gates) console.log(`  ${g.ok ? '✓' : '✗'} ${g.msg}`);
if (!okDur || !okDecode || gates.some(g => !g.ok)) process.exit(1);

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
    // 注意顺序: 先逐个 safeOut 删掉旧切分(预置的叶子文件符号链接在这里就会被拒),
    // 之后 :433 的 ffmpeg 写 part-<id>-<n>.mp3 才不会有"顺着预置链接写出去"的口子。
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
  fs.writeFileSync(safeOut(dir, 'asr', 'checklist.md'), lines.join('\n') + '\n');
  console.log(`  ASR 素材与清单已生成: asr/ (${count} 句, 每句独立切分)`);
}
console.log('\n完成 ✅');
