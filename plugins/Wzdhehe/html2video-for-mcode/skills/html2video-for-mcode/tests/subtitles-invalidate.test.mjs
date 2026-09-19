// 字幕静帧必须随字幕一起作废(复查 B2): 成片是"帧序列 + 逐句字幕静帧"拼出来的, 静帧留在磁盘上;
// 删掉一句 clauses 或改用 --no-subs 重建时, 如果旧静帧没被清掉、旧清单没被核对, 成片会把**已经不存在
// 的那句字幕**拼回来 —— 画面里出现一句没人说过的字幕, 而全链路零报错。
// 这里用像素级判据: 末段实帧与"当前该显示的静帧"几乎一致, 与"旧的第 2 句静帧"明显不同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTool, loadPackage } from '../scripts/tools.mjs';
import { runSkill, tmpdir, FRESH_TOKENS } from './helpers.mjs';

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');

test('字幕静帧随字幕作废: 删掉一句 / --no-subs 重建后, 成片不得再出现旧字幕(像素级)', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');
  const playwright = await loadPackage('playwright');
  if (!playwright) return t.skip('无 playwright');
  try { const b = await playwright.chromium.launch({ headless: true }); await b.close(); } catch {
    return t.skip('chromium 未安装(npx playwright install chromium)');
  }

  const proj = tmpdir();
  assert.equal(runSkill('init-project.mjs', [proj, '--topic', 'SubInvalidate']).status, 0);
  const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '3',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(proj, 'audio', '01.mp3')], { windowsHide: true });
  assert.equal(g.status, 0, g.stderr ?? '');
  fs.writeFileSync(path.join(proj, 'slides', '01-title.html'),
    `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">字幕作废检查</h1></div></body></html>`);

  const setClauses = list => {
    const p = path.join(proj, 'script.json');
    const s = JSON.parse(fs.readFileSync(p, 'utf8'));
    s.slides = s.slides.filter(x => x.id === '01');
    s.slides[0].clauses = list;
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  };
  const man = () => JSON.parse(fs.readFileSync(path.join(proj, 'build', 'substills', '01.json'), 'utf8'));
  const subFile = k => path.join(proj, 'build', 'substills', '01', `s${k}.png`);
  // 字幕条: 模板里 .kit-sub 是 bottom: 7.78% × 1080 ≈ 84px、40px 字、居中 → 取正下方居中一块,
  // 比整条字幕带敏感得多(整带 1920×260 会把字幕只占的一小块平均掉)
  const box = 'crop=600:140:660:890';
  const YAVG = (a, b) => {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
      '-lavfi', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true });
    const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
    return m ? parseFloat(m[1]) : null;
  };
  const crop = (src, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', box, out], { windowsHide: true }); return out; };
  const grab = (t0, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t0), '-i', path.join(proj, 'out', 'final.mp4'), '-frames:v', '1', '-vf', box, out], { windowsHide: true }); return out; };
  const dur = () => parseFloat((spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(proj, 'out', 'final.mp4')], { encoding: 'utf8' }).stdout || '').trim());
  const work = path.join(proj, 'build', 'subcheck');
  fs.mkdirSync(work, { recursive: true });

  // ① 两句: 出片并留下证据(第 2 句的静帧 = 旧字幕长什么样)
  setClauses([{ stage: 1, text: '第一句。' }, { stage: 2, text: '第二句展开内容。' }]);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still']).status, 0);
  assert.ok(fs.existsSync(subFile(1)), '前置: 第 2 句的静帧应已生成');
  assert.equal(man().stills.length, 2, '前置: 清单里应有 2 句');
  const oldS1 = path.join(work, 'old-s1.png');
  fs.copyFileSync(subFile(1), oldS1);

  // ② 删掉第 2 句: 重建后旧静帧必须消失, 且成片里不能再出现那句字幕
  setClauses([{ stage: 1, text: '第一句。' }]);
  assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
  assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still']).status, 0);
  assert.equal(fs.existsSync(subFile(1)), false, '旧的第 2 句静帧必须被作废(否则会被拼回成片)');
  assert.equal(man().stills.length, 1, '清单必须只剩当前这一句');
  assert.equal(runSkill('build-video.mjs', [proj]).status, 0);
  const lateFrame = grab(Math.max(0.3, dur() * 0.85), path.join(work, 'late.png'));
  const dOldS1 = YAVG(lateFrame, crop(oldS1, path.join(work, 'old-s1-band.png')));
  const dCurS0 = YAVG(lateFrame, crop(subFile(0), path.join(work, 'cur-s0-band.png')));
  assert.ok(dOldS1 != null && dCurS0 != null, '应能算出字幕带差异');
  console.log(`    实测(字幕条差异, 越小越像): 当前字幕 ${dCurS0} · 被删掉的旧字幕 ${dOldS1}`);
  assert.ok(dCurS0 < 2.5, `末段画面应贴合当前唯一那句字幕, 实际差异 ${dCurS0}`);
  assert.ok(dOldS1 > 4.0, `末段画面不得还是被删掉的那句(与旧静帧差异只有 ${dOldS1})`);

  // ③ --no-subs 重建: 静帧与清单都要清掉, 成片不再有字幕
  const withSubs = path.join(work, 'with-subs-s0.png');   // 先留一份"有字幕"的参照(下面会把源文件清掉)
  fs.copyFileSync(subFile(0), withSubs);
  assert.equal(runSkill('capture.mjs', [proj, '--mode', 'still', '--no-subs']).status, 0);
  assert.equal(fs.existsSync(path.join(proj, 'build', 'substills', '01.json')), false, '--no-subs 时清单必须清掉');
  assert.equal(fs.existsSync(path.join(proj, 'build', 'substills', '01')), false, '--no-subs 时静帧目录必须清掉');
  assert.equal(runSkill('build-video.mjs', [proj]).status, 0);
  const lateNoSubs = grab(Math.max(0.3, dur() * 0.85), path.join(work, 'late-nosubs.png'));
  const dWithSubs = YAVG(lateNoSubs, crop(withSubs, path.join(work, 'gone-s0-band.png')));
  assert.ok(dWithSubs != null, '应能算出差异');
  console.log(`    实测(--no-subs 后与"有字幕"参照的差异): ${dWithSubs}`);
  assert.ok(dWithSubs > 4.0, `--no-subs 之后画面不该还有字幕(与有字幕静帧的差异只有 ${dWithSubs})`);
});

// 第三轮复查(1.7.1): 清单的 framesCover 必须与"当前帧序列的实际时长"对齐 —— B2 点名的第三项。
// 时长与句序都对、但动画窗重截过(帧数变了)的清单, 会把字幕静帧从错误的时刻拼进成片。
// 判据用整帧差异: 静帧是纯红、帧序列是纯灰, 拼没拼进画面一眼可辨(不需要字幕带裁剪)。
test('清单帧覆盖与当前帧序列不一致 → 忽略清单(像素级: 陈旧静帧不得再进画面)', async t => {
  if (!FFMPEG || !FFPROBE) return t.skip('无 ffmpeg/ffprobe(主 CI 环境; 由 scoped smoke workflow 覆盖)');

  const proj = tmpdir();
  fs.mkdirSync(path.join(proj, 'slides'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'slides', 'tokens.css'), FRESH_TOKENS);
  fs.writeFileSync(path.join(proj, 'slides', '01.html'), '<!doctype html><html><body></body></html>');
  fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify({
    topic: 't', fps: 30, width: 1920, height: 1080,
    slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses: [{ stage: 1, text: '唯一一句。' }] }],
  }, null, 2));
  fs.mkdirSync(path.join(proj, 'audio'), { recursive: true });
  assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '3',
    '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(proj, 'audio', '01.mp3')], { windowsHide: true }).status, 0);
  fs.mkdirSync(path.join(proj, 'build'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'build', 'timings.json'), JSON.stringify({
    fps: 30, total: 3.0, tts: 3.0, slides: [{ id: '01', duration: 3.0, tts: 3.0, clauses: [{ stage: 1, text: '唯一一句。' }] }],
  }, null, 2));
  // 手工帧序列: 30 帧(= 1.0s)纯灰 —— 清单却声称帧覆盖 2.0s(旧动画窗), 差 1s 必须被识破
  // (image2 输出序列默认从 f00001 起编号, 而 build-video 认 f00000 → 必须 -start_number 0)
  const fdir = path.join(proj, 'build', 'frames', '01');
  fs.mkdirSync(fdir, { recursive: true });
  assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1920x1080:r=30', '-t', '1',
    '-start_number', '0', '-y', path.join(fdir, 'f%05d.png')], { windowsHide: true }).status, 0, '应能造出 30 帧灰底序列');
  assert.ok(fs.existsSync(path.join(fdir, 'f00000.png')), '帧序列应从 f00000 开始(build-video 的输入模式)');
  const stills = path.join(proj, 'build', 'substills');
  fs.mkdirSync(path.join(stills, '01'), { recursive: true });
  assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1',
    '-y', path.join(stills, '01', 's0.png')], { windowsHide: true }).status, 0, '应能造出红色字幕静帧');
  fs.mkdirSync(path.join(proj, 'preview'), { recursive: true });
  assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=1920x1080', '-frames:v', '1',
    '-y', path.join(proj, 'preview', 'cover.png')], { windowsHide: true }).status, 0, '应能造出封面占位');

  const diff = (a, b) => {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
      '-lavfi', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true });
    const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
    return m ? parseFloat(m[1]) : null;
  };
  const grab = (t0, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(t0),
    '-i', path.join(proj, 'out', 'final.mp4'), '-frames:v', '1', out], { windowsHide: true }); return out; };
  const manPath = path.join(stills, '01.json');

  // ① 陈旧清单: 时长对、句数对, 但 framesCover=2 ≠ 当前 1.0 → 必须点名并忽略
  fs.writeFileSync(manPath, JSON.stringify({ fps: 30, duration: 3, framesCover: 2, stills: [{ start: 2, end: 3, k: 0 }] }));
  let r = runSkill('build-video.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /帧覆盖 2s ≠ 当前 1s.*忽略该清单/, '要点名帧覆盖不符并忽略: ' + r.stdout + r.stderr);
  const dStale = diff(grab(2.55, path.join(proj, 'build', 'cov-stale.png')), path.join(stills, '01', 's0.png'));
  console.log(`    实测(陈旧清单被忽略后, 末段与红色静帧的差异): ${dStale}`);
  assert.ok(dStale != null && dStale > 4.0, `陈旧静帧不得再进画面(与红色静帧差异仅 ${dStale})`);

  // ② 对齐清单: framesCover=1 与当前帧序列一致 → 同一张静帧正常拼入(末段 = 红色)
  fs.writeFileSync(manPath, JSON.stringify({ fps: 30, duration: 3, framesCover: 1, stills: [{ start: 1, end: 3, k: 0 }] }));
  r = runSkill('build-video.mjs', [proj]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const dOk = diff(grab(2.55, path.join(proj, 'build', 'cov-ok.png')), path.join(stills, '01', 's0.png'));
  console.log(`    实测(清单对齐后, 末段与红色静帧的差异): ${dOk}`);
  assert.ok(dOk != null && dOk < 2.5, `对齐清单的静帧应当拼入画面(与红色静帧差异 ${dOk})`);
});
