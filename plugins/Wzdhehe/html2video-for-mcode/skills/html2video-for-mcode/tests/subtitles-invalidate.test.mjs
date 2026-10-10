// 字幕静帧必须随字幕一起作废(复查 B2): 成片是"帧序列 + 逐句字幕静帧"拼出来的, 静帧留在磁盘上;
// 删掉一句 clauses 或改用 --no-subs 重建时, 如果旧静帧没被清掉、旧清单没被核对, 成片会把**已经不存在
// 的那句字幕**拼回来 —— 画面里出现一句没人说过的字幕, 而全链路零报错。
// 这里用像素级判据: 末段实帧与"当前该显示的静帧"几乎一致, 与"旧的第 2 句静帧"明显不同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTool, loadPackage, subtitleKeyframes, subtitleWindows } from '../scripts/tools.mjs';
import { runSkill, tmpdir, FRESH_TOKENS } from './helpers.mjs';

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');

// 两图逐像素差(YAVG): 本文件唯一的成对差异实现(两个用例共用)
const imgDiff = (a, b) => {
  const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b,
    '-lavfi', '[0:v][1:v]blend=all_mode=difference,signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true });
  const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
  return m ? parseFloat(m[1]) : null;
};

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
  const YAVG = imgDiff;
  const crop = (src, out) => { spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-vf', box, out], { windowsHide: true }); return out; };
  // 字幕带亮度统计: YMAX=文字峰值(满亮 235 档, 截在淡变上掉到 ~130), YMIN=底板地板(叠框会下陷)
  const STATS = img => {
    const o = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', img,
      '-lavfi', `[0:v]${box},signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-'],
      { encoding: 'utf8', windowsHide: true });
    const txt = (o.stdout || '') + (o.stderr || '');
    const g = k => { const m = new RegExp(k + '=([0-9.]+)').exec(txt); return m ? parseFloat(m[1]) : null; };
    return { YMIN: g('YMIN'), YAVG: g('YAVG'), YMAX: g('YMAX') };
  };
  const YMAX = img => STATS(img).YMAX;
  const YFLOOR = img => STATS(img).YMIN;
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
  // 拼接静帧必须满亮(2026-09-22 灰字幕回归): 静帧曾截在关键帧淡变的半山腰上,
  // 与帧序列段拼出"字幕出现不到一秒就跳灰"。标定: 满亮峰值实测 235(细笔画 AA 余量), 灰 bug 实测 138。
  for (const k of [0, 1]) {
    const y = YMAX(subFile(k));
    console.log(`    实测(第 ${k + 1} 句静帧字幕带 YMAX, 满亮=235 档): ${y}`);
    assert.ok(y != null && y >= 200, `第 ${k + 1} 句的拼接静帧必须满不透明(字幕带峰值 ${y})`);
  }
  // 跨句残留防漏(2026-09-22): 同一页逐张截图, 钉过的字幕若漏进后续静帧, 会叠出深色底板补丁 ——
  // 两张静帧的暗部地板必须一致(同夹具成对比较; 暗主题下叠框差会缩小, 夹具固定 theme a 才够判别力)
  const floor = [YFLOOR(subFile(0)), YFLOOR(subFile(1))];
  console.log(`    实测(两句静帧字幕带暗部地板, 应一致): ${floor.join(' / ')}`);
  assert.ok(Math.abs(floor[0] - floor[1]) <= 12, `上一句字幕不得漏进下一张静帧(暗部地板 ${floor.join(' / ')})`);
  // 封面与静帧基底不得烙字幕(2026-09-22 修复的两条回归): 两者都是"无字幕终态图" —— 封面曾被
  // 钉死残留烙进最后一句, 基底曾被末句关键帧终值烙进最后一句。与带字幕静帧在字幕带上必须有
  // 明显差异, ≈0 即说明字幕被烙进了无字幕图。
  for (const [label, img] of [['封面', path.join(proj, 'preview', 'cover.png')], ['静帧基底', path.join(proj, 'preview', '01.png')]]) {
    const d = YAVG(crop(img, path.join(work, `${label}-band.png`)), crop(subFile(1), path.join(work, 'leak-s1-band.png')));
    console.log(`    实测(${label} 与带字幕静帧的差异, ≈0=字幕被烙进): ${d}`);
    assert.ok(d != null && d > 3, `${label} 不得烙进字幕(与带字幕静帧差异仅 ${d})`);
  }
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

  const diff = imgDiff;
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

// 2026-09-22 灰字幕回归(工具层, 无工具门槛)。形状契约四条, 前两条各抓过一次真回归:
// ①两端隐藏: fill both 下 finish() 后回到 opacity:0 —— 封面/静帧基底图靠它保持无字幕
//   (1.9.4 的"末句无尾帧"形状让终值停在 1, 最后一句被烙进封面与基底);
// ②无同偏移撞车: 同偏移多次声明时后者生效, 平台会被尾帧吃掉(灰字幕根因);
// ③末句零可见淡出(平台保持到片尾) / 非末句保留切换淡出; ④偏移不越 [0,100] 且单调。
test('字幕关键帧形状: 两端隐藏契约、末句零可见淡出、无同偏移撞车(工具层)', () => {
  const parse = css => (css.match(/@keyframes kit-sub-\d+\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? []).map(blk => {
    const groups = [...blk.matchAll(/([\d.,%]+)\{opacity:([\d.]+)\}/g)].map(m => ({
      offsets: [...new Set(m[1].split(',').map(parseFloat))],   // 同一选择器列表里的重复偏移是别名(如 100.000%,100%), 不算撞车
      opacity: parseFloat(m[2]),
    }));
    return { blk, groups, offsets: groups.flatMap(g => g.offsets) };
  });

  const suites = [
    { name: '单句(即末句)', css: subtitleKeyframes([{ start: 0.1 }], 3), lasts: [true] },
    { name: '两句', css: subtitleKeyframes([{ start: 0 }, { start: 1.2 }], 3), lasts: [false, true] },
    { name: '末句起点 99.8%', css: subtitleKeyframes([{ start: 0 }, { start: 2.994 }], 3), lasts: [false, true] },
  ];
  for (const { name, css, lasts } of suites) {
    const blocks = parse(css);
    assert.equal(blocks.length, lasts.length, `${name}: 块数应等于句数`);
    for (let i = 0; i < blocks.length; i++) {
      const { blk, groups, offsets } = blocks[i];
      assert.ok(offsets.length > 0 && groups.length >= 3, `应解析出关键帧组: ${blk}`);
      assert.ok(offsets.every(o => o >= 0 && o <= 100), `偏移越界(CSS 关键帧选择器只认 0–100%): ${blk}`);
      for (let j = 1; j < offsets.length; j++) assert.ok(offsets[j] >= offsets[j - 1], `偏移乱序: ${blk}`);
      assert.equal(new Set(offsets).size, offsets.length, `同偏移声明两次(后者会吃掉前者, 灰字幕根因): ${blk}`);
      assert.equal(groups[0].opacity, 0, `起点必须隐藏: ${blk}`);
      assert.equal(groups.at(-1).opacity, 0, `100% 终值必须归 0(finish() 后自动隐藏的契约): ${blk}`);
      assert.ok(groups.at(-1).offsets.includes(100), `尾帧应落在 100%: ${blk}`);
      const plateau = groups.find(g => g.opacity === 1);
      const fade = groups.at(-1).offsets[0] - plateau.offsets.at(-1);
      if (lasts[i]) assert.ok(fade < 0.1, `末句不得有可见淡出(淡出窗 ${fade}%): ${blk}`);
      else assert.ok(fade >= 0.1, `非末句应保留切换淡出(淡出窗 ${fade}%): ${blk}`);
    }
  }
  // b 夹紧: 末句起点晚于 99.5% 时窗口终点不得越过 100
  assert.equal(subtitleWindows([{ start: 0 }, { start: 2.994 }], 3)[1].b, 100);
});
