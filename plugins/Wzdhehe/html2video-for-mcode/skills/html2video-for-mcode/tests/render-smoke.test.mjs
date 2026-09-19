// 渲染构建冒烟: init → 静音音频 → 最小 slide → plan-timings → check-slides → capture still → build-video
// 对应评审意见 5: a minimal render/checker/build dry-run。
// 无 ffmpeg / playwright / chromium 时逐级 skip 并说明原因(主 CI 只跑上面的安全测试;
// 本文件由 .github/workflows/html2video-for-mcode-smoke.yml 在装好依赖的环境里真实执行)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTool, loadPackage } from '../scripts/tools.mjs';
import { runSkill, tmpdir, SCRIPTS } from './helpers.mjs';

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
let playwright = null;

test('冒烟: 全链路出片', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try {
    const b = await playwright.chromium.launch({ headless: true });
    await b.close();
  } catch {
    return t.skip('chromium 未安装(npx playwright install chromium)');
  }

  const proj = tmpdir();
  // 1. init
  let r = runSkill('init-project.mjs', [proj, '--topic', 'Smoke']);
  assert.equal(r.status, 0, r.stderr);
  // 2. 静音口播(1 张, 3s)
  const mp3 = path.join(proj, 'audio', '01.mp3');
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '3',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', mp3], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');
  // 3. 只留 1 张 slide
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = script.slides.filter(s => s.id === '01');
  script.slides[0].clauses = [{ stage: 1, text: '冒烟测试。' }, { stage: 2, text: '第二句展开。' }];
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  // 4. 最小 slide(过得了 check-slides: data-stage 配 fx 类, 变量有定义)
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><span class="brand">冒烟</span>
<h1 class="fx-rise" data-stage="1">冒烟测试</h1>
<p class="fx-fade" data-stage="2">第二层展开内容</p>
<div class="slide-num">01</div></div></body></html>`);
  // 5. plan-timings
  r = runSkill('plan-timings.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const timings = JSON.parse(fs.readFileSync(path.join(proj, 'build', 'timings.json'), 'utf8'));
  assert.ok(timings.total > 2.5 && timings.total < 5, `总时长应≈3s+tai1, 实际 ${timings.total}`);
  // 6. check-slides(静态闸门, 必须全绿)
  r = runSkill('check-slides.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 7. capture still
  r = runSkill('capture.mjs', [proj, '--mode', 'still']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(proj, 'preview', '01.png')), '应产出 preview/01.png');
  // 8. build-video(不带 --asr, 不碰网络)
  r = runSkill('build-video.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const final = path.join(proj, 'out', 'final.mp4');
  assert.ok(fs.existsSync(final), '应产出 out/final.mp4');
  const d = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final],
    { encoding: 'utf8', windowsHide: true });
  const dur = parseFloat((d.stdout ?? '').trim());
  assert.ok(Math.abs(dur - timings.total) <= 0.3, `成片时长 ${dur} 应≈timings ${timings.total}`);
});

test('still 复截后直接 build-video: 必须点名"静态图出片"警告(still 会作废帧目录, 动画无声丢失)', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try {
    const b = await playwright.chromium.launch({ headless: true });
    await b.close();
  } catch {
    return t.skip('chromium 未安装(npx playwright install chromium)');
  }
  const proj = tmpdir();
  let r = runSkill('init-project.mjs', [proj, '--topic', 'StillWarn']);
  assert.equal(r.status, 0, r.stderr);
  const mp3 = path.join(proj, 'audio', '01.mp3');
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '2',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', mp3], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = script.slides.filter(s => s.id === '01');
  script.slides[0].clauses = [{ stage: 1, text: '静音。' }];
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">静音</h1></div></body></html>`);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still']).status, 0);   // 只 still, 不 motion
  r = runSkill('build-video.mjs', [proj]);                                       // 真编码(2.9s 静音段, 秒级; dry-run 的自检会因无产物误报)
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok((r.stdout + r.stderr).includes('静态图出片'), '回退静态图出片时必须点名警告并给补法');
  assert.ok((r.stdout + r.stderr).includes('--mode motion --ids 01'), '要给出补跑命令');
});

test('字幕时间轴: 动画窗之后的字幕变化必须进画面(二审 P1: 冻帧导致后半句字幕永不出现)', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try { const b = await playwright.chromium.launch({ headless: true }); await b.close(); }
  catch { return t.skip('chromium 未安装(npx playwright install chromium)'); }

  const proj = tmpdir();
  assert.equal(runSkill('init-project.mjs', [proj, '--topic', 'SubTimeline']).status, 0);
  const mp3 = path.join(proj, 'audio', '01.mp3');
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '6',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', mp3], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = script.slides.filter(s => s.id === '01');
  script.slides[0].clauses = [{ stage: 1, text: 'AAAAAAAAAAAAAAAA' }, { stage: 1, text: 'BBBBBBBBBBBBBBBB' }];
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  // 动画 1s 内结束, 第二句开口在 3.5s —— 正落在动画窗之外(修复前这里被 tpad 冻帧吞掉)
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">字幕时间轴</h1></div></body></html>`);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  const tj = path.join(proj, 'build', 'timings.json');
  const timings = JSON.parse(fs.readFileSync(tj, 'utf8'));
  timings.slides[0].clauses = [
    { stage: 1, start: 0.3, text: 'AAAAAAAAAAAAAAAA' },
    { stage: 1, start: 3.5, text: 'BBBBBBBBBBBBBBBB' },
  ];
  fs.writeFileSync(tj, JSON.stringify(timings, null, 2));

  let r = runSkill('capture.mjs', [proj, '--mode', 'motion']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const man = JSON.parse(fs.readFileSync(path.join(proj, 'build', 'substills', '01.json'), 'utf8'));
  assert.ok(man.framesCover > 0 && man.framesCover < 3.5, `帧序列只该覆盖动画窗, 实际 ${man.framesCover}`);
  const late = man.stills.filter(s => s.start >= 3.4);
  assert.equal(late.length, 1, `第二句(3.5s 起)必须有一条"帧覆盖不到"的字幕图, 实际 ${JSON.stringify(man.stills)}`);
  assert.ok(fs.existsSync(path.join(proj, 'build', 'substills', '01', `s${late[0].k}.png`)), '字幕图文件要真落盘');

  r = runSkill('build-video.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // 成片里第 2 句窗内的画面必须贴合第 2 句字幕图、而不是第 1 句(修复前这里冻在第 1 句 = 后半句永不出现)
  // 判据用"抽帧成 PNG 再逐像素比": 双输入 blend 会因两条流 seek 起点不同产生假差异(实测踩过)
  const final = path.join(proj, 'out', 'final.mp4');
  const bd = path.join(proj, 'build', 'bandcheck');
  fs.mkdirSync(bd, { recursive: true });
  const crop = 'crop=1920:260:0:820';
  const grab = (t, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', final, '-frames:v', '1', '-vf', crop, out], { windowsHide: true }); return out; };
  const still = (k, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(proj, 'build', 'substills', '01', `s${k}.png`), '-vf', crop, out], { windowsHide: true }); return out; };
  const diff = (a, b) => {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
      '-lavfi', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true });
    const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
    return m ? parseFloat(m[1]) : null;
  };
  const fLate = grab(5.0, path.join(bd, 't50.png'));
  const sOwn = still(late[0].k, path.join(bd, 'own.png'));
  const sOther = still(0, path.join(bd, 'other.png'));
  const dOwn = diff(fLate, sOwn), dOther = diff(fLate, sOther);
  assert.ok(dOwn != null && dOther != null, '应能算出字幕带差异');
  assert.ok(dOwn < 2.0, `5.0s 的画面应贴合第 2 句字幕图, 实际差异 ${dOwn}`);
  assert.ok(dOther > 4.0, `5.0s 的画面不该还是第 1 句(冻帧), 与第 1 句字幕图的差异只有 ${dOther}`);
});

test('字幕时间轴(静态/no-fx 路径): 没有帧序列时也要逐句烧字幕', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try { const b = await playwright.chromium.launch({ headless: true }); await b.close(); }
  catch { return t.skip('chromium 未安装(npx playwright install chromium)'); }

  const proj = tmpdir();
  assert.equal(runSkill('init-project.mjs', [proj, '--topic', 'SubStatic']).status, 0);
  const mp3 = path.join(proj, 'audio', '01.mp3');
  spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '6',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', mp3], { windowsHide: true });
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = script.slides.filter(s => s.id === '01');
  script.slides[0].clauses = [{ stage: 1, text: 'AAAAAAAAAAAAAAAA' }, { stage: 1, text: 'BBBBBBBBBBBBBBBB' }];
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  // no-fx: 整张没有入场动画 → capture 走静态路径(修复前只截一帧 → 整片没有字幕)
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a" class="no-fx"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 data-stage="1">关动效也要有字幕</h1></div></body></html>`);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  const tj = path.join(proj, 'build', 'timings.json');
  const timings = JSON.parse(fs.readFileSync(tj, 'utf8'));
  timings.slides[0].clauses = [
    { stage: 1, start: 0.3, text: 'AAAAAAAAAAAAAAAA' },
    { stage: 1, start: 3.5, text: 'BBBBBBBBBBBBBBBB' },
  ];
  fs.writeFileSync(tj, JSON.stringify(timings, null, 2));

  assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still']).status, 0);
  const man = JSON.parse(fs.readFileSync(path.join(proj, 'build', 'substills', '01.json'), 'utf8'));
  assert.equal(man.stills.length, 2, `静态路径要为每句都出字幕图, 实际 ${JSON.stringify(man.stills)}`);
  assert.equal(man.framesCover, 0, '静态路径没有帧序列');

  const r = runSkill('build-video.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);   // 拼接正确性由 build-video 的时长自检背书(段长之和 ≠ 整张时长即退出 1)
  const final = path.join(proj, 'out', 'final.mp4');
  const bd = path.join(proj, 'build', 'bandcheck');
  fs.mkdirSync(bd, { recursive: true });
  const crop = 'crop=1920:260:0:820';
  const grab = (t, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', final, '-frames:v', '1', '-vf', crop, out], { windowsHide: true }); return out; };
  const still = (k, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', path.join(proj, 'build', 'substills', '01', `s${k}.png`), '-vf', crop, out], { windowsHide: true }); return out; };
  const diff = (a, b) => {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
      '-lavfi', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true });
    const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
    return m ? parseFloat(m[1]) : null;
  };
  // 关动效时: 5.0s 的画面必须是第 2 句(修复前整片一帧字幕都没有 → 与两句都不贴合)
  const dOwn = diff(grab(5.0, path.join(bd, 't50.png')), still(1, path.join(bd, 'own.png')));
  const dOther = diff(grab(5.0, path.join(bd, 't50b.png')), still(0, path.join(bd, 'other.png')));
  assert.ok(dOwn != null && dOwn < 2.0, `关动效时 5.0s 应显示第 2 句字幕, 与第 2 句字幕图差异 ${dOwn}(修复前无字幕)`);
  assert.ok(dOther != null && dOther > 4.0, `不该显示第 1 句, 差异 ${dOther}`);
});

test('grab-frames: 按 timings 抽成片实帧(图注/字幕带那类 still 看不出的问题, 最终对账手段)', async t => {
  if (!FFMPEG) return t.skip('无 ffmpeg(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  const proj = tmpdir();
  fs.mkdirSync(path.join(proj, 'build'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'out'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'build', 'timings.json'), JSON.stringify({
    fps: 30, total: 2.2,
    slides: [{ id: '01', duration: 1.1 }, { id: '02', duration: 1.1 }],
  }));
  const final = path.join(proj, 'out', 'final.mp4');
  // 片长要比 timings.total 略长: 末段抽帧点(≈总长 0.93 处)必须落在真实帧上(真实成片也如此)
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10',
    '-t', '2.6', '-pix_fmt', 'yuv420p', '-y', final], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');

  let r = runSkill('grab-frames.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const id of ['01', '02']) {
    assert.ok(fs.statSync(path.join(proj, 'build', 'introspect', `frame-${id}-end.png`)).size > 1000, `${id} 的末段帧要真抽出来`);
  }
  r = runSkill('grab-frames.mjs', [proj, '--ids', '02', '--both']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(proj, 'build', 'introspect', 'frame-02-mid.png')), '--both 要有中段帧');
  assert.ok(!fs.existsSync(path.join(proj, 'build', 'introspect', 'frame-01-mid.png')), '--ids 限定只抽 02');

  // 负向: 没有成片 → 退出 1 并点名
  fs.renameSync(final, final + '.bak');
  r = runSkill('grab-frames.mjs', [proj]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('final.mp4'), '要说清缺什么');
});

test('受管区升级真的改变渲染: 旧 CSS 出图 → 升级 → 画面按技能当前版重出(像素级)', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try { const b = await playwright.chromium.launch({ headless: true }); await b.close(); } catch {
    return t.skip('chromium 未安装(npx playwright install chromium)');
  }
  const { generateTokensCss, TOKENS_REV } = await import(
    'file://' + path.join(SCRIPTS, 'tokens-template.mjs').replace(/\\/g, '/'));
  const { wrapTokens } = await import(
    'file://' + path.join(SCRIPTS, 'css-kit.mjs').replace(/\\/g, '/'));

  const proj = tmpdir();
  let r = runSkill('init-project.mjs', [proj, '--topic', 'CssUpgrade']);
  assert.equal(r.status, 0, r.stderr);
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '2',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(proj, 'audio', '01.mp3')], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = script.slides.filter(s => s.id === '01');
  script.slides[0].clauses = [{ stage: 1, text: '升级检查。' }];
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">升级检查</h1></div></body></html>`);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  const still = () => {
    assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still', '--allow-stale-css']).status, 0);
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', path.join(proj, 'preview', '01.png'),
      '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
    return m ? parseFloat(m[1]) : null;
  };

  // 当前版(init 直出)渲染一次做基准
  const baseline = still();
  assert.ok(baseline != null, '应能读到基准画面的平均亮度');

  // 模拟"老项目": 把受管区内容换成改过一处令牌的旧版主体(画面整体变暗一点, 但仍是同构图)
  const oldBody = generateTokensCss().replace('--bg: #FAFAF7', '--bg: #D8D2C4');
  assert.notEqual(oldBody, generateTokensCss(), '前置: 主体内容确实改了(否则这个用例证明不了任何事)');
  fs.writeFileSync(path.join(proj, 'slides', 'tokens.css'),
    ':root { --accent: #111; }\n' + wrapTokens(oldBody, TOKENS_REV) + '\n');
  assert.equal(runSkill('check-slides.mjs', [proj]).status, 1, '内容被改过的受管区必须被静态闸门拦住');
  assert.equal(runSkill('capture.mjs', [proj]).status, 1, 'capture 入口也必须拦住(不许静默出旧画面)');
  const stale = still();   // 显式放行才出得来
  assert.ok(Math.abs(stale - baseline) > 0.5,
    `旧 CSS 与当前版的画面必须真的不同(基准 ${baseline}, 旧版 ${stale}) —— 否则"升级生效"这件事无从谈起`);

  // 升级: 受管区整段替换回技能当前版, 区外项目规则保留
  const up = runSkill('init-project.mjs', [proj, '--upgrade-css']);
  assert.equal(up.status, 0, up.stderr);
  assert.ok(up.stdout.includes('tokens 主体'), '要说明整段生成物被替换: ' + up.stdout.slice(0, 200));
  assert.equal(runSkill('check-slides.mjs', [proj]).status, 0, '升级后静态闸门必须恢复');
  const after = still();
  assert.ok(Math.abs(after - baseline) <= 0.05,
    `升级后必须回到技能当前版的画面(基准 ${baseline}, 升级后 ${after}) —— 这条把"改了 CSS 项目里真的生效"钉死在像素上`);
});
