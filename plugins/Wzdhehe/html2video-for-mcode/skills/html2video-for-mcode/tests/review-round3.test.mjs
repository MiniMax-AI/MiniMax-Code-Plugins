// 第三轮 review(外部评审 + /code-review)修复的回归: D1–D6 功能缺陷 + 陈旧闸门
// 每条都对应一个"能静默产生错误产物"的具体路径, 不是风格问题:
//   D1 check-timing --calibrate 混着写回半份实测 + 谎报匹配方法
//   D2 `--topic X <项目目录>` 把 X 当项目目录, 在 cwd 静默建骨架
//   D3 fetch-official-images 的 --json 吃掉位置参数 / --min 只比宽度 / 全失败还退 0
//   D4 capture --mode/--dsf 与 grab-frames --at 的非法值一路带到 playwright/ffmpeg
//   D5 check-slides 字幕带闸门误报 padding-bottom(且不要求绝对定位)
//   D6 transition 裸字符串在闸门与渲染器里结论不一致
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runSkill, mkproj, tmpdir, SCRIPTS, LEGACY_TOKENS } from './helpers.mjs';
import { pathToFileURL } from 'node:url';
import { findTool, loadPackage } from '../scripts/tools.mjs';

const FFMPEG = findTool('ffmpeg');
const { positionals, readTransition, positionalDir, VALUE_FLAGS } = await import(
  'file://' + path.join(SCRIPTS, 'tools.mjs').replace(/\\/g, '/'));

const SLIDE = `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">标题</h1></div></body></html>`;

describe('D1 · check-timing --calibrate 不写回半份实测', () => {
  // 造一段"两句话 + 句间静音"的音频: 0–1.0s 噪声(第 1 句) → 1.0–1.6s 静音 → 1.6–2.6s 噪声(第 2 句)
  // (silencedetect 阈值为 -38dB/0.18s, 所以句间用真静音、句子用可闻噪声)
  const makeAudio = (proj) => {
    const out = path.join(proj, 'audio', '01.mp3');
    const g = spawnSync(FFMPEG, ['-v', 'error',
      '-f', 'lavfi', '-i', 'anoisesrc=d=1.0:c=pink:a=0.4:r=32000',
      '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono:d=0.6',
      '-f', 'lavfi', '-i', 'anoisesrc=d=1.0:c=pink:a=0.4:r=32000',
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]', '-map', '[out]',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-y', out], { windowsHide: true });
    assert.equal(g.status, 0, g.stderr ?? '');
    return out;
  };
  const mk = (clauses) => {
    const proj = mkproj(tmpdir(), {
      slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses }],
    });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), SLIDE);
    fs.writeFileSync(path.join(proj, 'script.json'), JSON.stringify({
      topic: 't', fps: 30, width: 1920, height: 1080,
      slides: [{ id: '01', html: '01.html', audio: '01.mp3', title: '开场', clauses }],
    }, null, 2));
    return proj;
  };

  test('静音段不足(有缺口) → 报 sparse, 一个字节都不写回', { skip: !FFMPEG && '无 ffmpeg' }, () => {
    const clauses = [
      { stage: 1, start: 0, text: '第一句。' },
      { stage: 1, start: 1.2, text: '第二句。' },
      { stage: 1, start: 2.2, text: '第三句。' },   // 需要 2 个句边界, 音频里只有 1 个静音段
    ];
    const proj = mk(clauses);
    makeAudio(proj);
    const tp = path.join(proj, 'build', 'timings.json');
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify({ fps: 30, total: 2.6, tts: 2.6, slides: [{ id: '01', tts: 2.6, duration: 2.6, clauses }] }, null, 2));
    const before = fs.readFileSync(tp, 'utf8');
    const r = runSkill('check-timing.mjs', [proj, '--calibrate']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /静音段不足\(未写回\)/, '要如实报 sparse: ' + r.stdout);
    assert.equal(fs.readFileSync(tp, 'utf8'), before, '半份实测不得写回 timings.json');
  });

  test('全命中 → 写回, 且每个值都来自实测(不是估算)', { skip: !FFMPEG && '无 ffmpeg' }, () => {
    const clauses = [
      { stage: 1, start: 0, text: '第一句。' },
      { stage: 2, start: 1.0, text: '第二句。' },
    ];
    const proj = mk(clauses);
    makeAudio(proj);
    const tp = path.join(proj, 'build', 'timings.json');
    fs.mkdirSync(path.dirname(tp), { recursive: true });
    fs.writeFileSync(tp, JSON.stringify({ fps: 30, total: 2.6, tts: 2.6, slides: [{ id: '01', tts: 2.6, duration: 2.6, clauses }] }, null, 2));
    const r = runSkill('check-timing.mjs', [proj, '--calibrate']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /(精确\(标点对齐\)|最近邻\(全命中\))|已写回/, r.stdout);
    const after = JSON.parse(fs.readFileSync(tp, 'utf8'));
    const c2 = after.slides[0].clauses[1];
    assert.ok(Math.abs(c2.start - 1.6) < 0.35, `第 2 句开口应≈1.6s(实测静音段末端), 实际 ${c2.start}(${r.stdout.slice(-200)})`);
    assert.notEqual(c2.start, 1.0, '不能原样留着估算值');
    assert.ok(after.slides[0].stages && Object.keys(after.slides[0].stages).length > 0, 'stage 时刻也要写回');
  });
});

describe('D2 · 位置参数解析: 取值型 flag 的值不是项目目录', () => {
  test('positionalDir 跳过取值型 flag 的值', () => {
    assert.ok(VALUE_FLAGS.has('--topic'));
    assert.equal(positionalDir(['--topic', '我的主题', './proj']), path.resolve('./proj'));
    assert.equal(positionalDir(['./proj', '--topic', 'x']), path.resolve('./proj'));
    assert.equal(positionalDir(['--ids', '01,03', './proj']), path.resolve('./proj'));
    assert.equal(positionalDir(['--check-css']), path.resolve('.'));
  });

  test('init-project --topic X <项目目录> → 只在目标目录建骨架, cwd 不得被污染', () => {
    const cwd = tmpdir();
    const proj = path.join(cwd, 'proj');
    const r = runSkill('init-project.mjs', ['--topic', '我的主题', proj], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(proj, 'slides', 'tokens.css')), '目标目录要有骨架');
    assert.deepEqual(fs.readdirSync(cwd), ['proj'], `cwd 只能多出 proj/, 实际 ${fs.readdirSync(cwd).join(',')}`);
    const tp = fs.readFileSync(path.join(proj, 'script.json'), 'utf8');
    assert.ok(tp.includes('我的主题'), '主题名要写进 script.json: ' + tp.slice(0, 200));
  });

  test('--topic 写在项目目录之后也照样生效', () => {
    const cwd = tmpdir();
    const proj = path.join(cwd, 'p2');
    const r = runSkill('init-project.mjs', [proj, '--topic', 'V2'], { cwd });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(path.join(proj, 'script.json'), 'utf8').includes('V2'));
    assert.deepEqual(fs.readdirSync(cwd), ['p2']);
  });
});

describe('D3 · fetch-official-images 的参数与退出码', () => {
  const proj = () => { const d = tmpdir(); fs.mkdirSync(path.join(d, 'assets'), { recursive: true }); return d; };

  test('--json 是布尔 flag: 放在网址前后都不吃掉位置参数', () => {
    const d = proj();
    for (const args of [['--json', 'http://127.0.0.1/x'], ['http://127.0.0.1/x', '--json']]) {
      const r = runSkill('fetch-official-images.mjs', args, { cwd: d });
      // 两种情况都必须走到"网址校验"(内网被拒), 而不是报用法错误
      assert.ok(!r.stderr.includes('用法:'), `--json 位置 ${args[0]} 不该导致缺位置参数: ${r.stderr}`);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes('内网') || r.stderr.includes('拒绝') || r.stderr.includes('127.0.0.1'), r.stderr);
    }
  });

  // 终轮复查抓到: --json 在末尾(文档写的用法)时, flagValue 取"下一个参数"得到 undefined,
  // 分支为假 → 静默退化成人类可读列表。上面的用例只断言"走到了网址校验",
  // 观察不到这个退化 —— 必须端到端断言真的输出了 JSON。
  test('--json 真的输出 JSON(两种位置都对 file:// 夹具页生效)', async t => {
    const playwright = await loadPackage('playwright');
    if (!playwright) return t.skip('无 playwright(列表路径要开浏览器; 真跑由 scoped smoke workflow 覆盖)');
    try { const b = await playwright.chromium.launch({ headless: true }); await b.close(); } catch {
      return t.skip('chromium 未安装(npx playwright install chromium)');
    }
    const d = proj();
    fs.writeFileSync(path.join(d, 'pic.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(d, 'page.html'),
      '<!doctype html><html><body><img src="pic.png" alt="fixture"></body></html>');
    const pageUrl = pathToFileURL(path.join(d, 'page.html')).href;   // 临时路径含空格/非 ASCII 也安全
    for (const args of [[pageUrl, '--allow-file', '--json'], ['--json', pageUrl, '--allow-file']]) {
      const r = runSkill('fetch-official-images.mjs', args, { cwd: d });
      assert.equal(r.status, 0, `--json 位置 ${args[0]}: ${r.stdout}${r.stderr}`);
      let arr = null;
      try { arr = JSON.parse(r.stdout); } catch { /* 下面断言报出实际输出 */ }
      assert.ok(Array.isArray(arr) && arr.length >= 1 && arr[0].src,
        `--json 必须输出候选 JSON 数组, 实际: ${(r.stdout || r.stderr).slice(0, 200)}`);
      assert.ok(!r.stdout.includes('候选图'), 'JSON 模式不得再混人类可读列表');
    }
  });

  test('--min 非法写法 → 退出 1 并说清支持的形式', () => {
    const d = proj();
    for (const bad of ['abc', '800x', 'x', '']) {
      const r = runSkill('fetch-official-images.mjs', ['https://example.com/', '--min', bad], { cwd: d });
      assert.equal(r.status, 1, `--min ${JSON.stringify(bad)} 必须被拒`);
      assert.ok(r.stderr.includes('--min'), r.stderr);
    }
  });

  test('--url 全部失败 → 退出 1(不再"全失败还退 0")', () => {
    const d = proj();
    const r = runSkill('fetch-official-images.mjs',
      ['--url', 'http://127.0.0.1/a.png,http://169.254.169.254/b.png', '--out-dir', path.join(d, 'assets')], { cwd: d });
    assert.equal(r.status, 1);
    assert.deepEqual(fs.readdirSync(path.join(d, 'assets')), [], '拒绝时不得落盘');
  });
});

describe('D4 · --mode / --dsf / --at 的非法值必须在入口被拒', () => {
  const proj = () => {
    const p = mkproj(tmpdir(), { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), SLIDE);
    return p;
  };

  test('capture --mode 只收 still/motion', () => {
    const p = proj();
    for (const bad of ['motions', 'Still', 'video']) {
      const r = runSkill('capture.mjs', [p, '--mode', bad]);
      assert.equal(r.status, 1, `--mode ${bad} 必须被拒`);
      assert.ok(r.stderr.includes('--mode'), r.stderr);
    }
  });

  test('capture --dsf 只收 1–4 的整数', () => {
    const p = proj();
    for (const bad of ['0', '9', '2.5', 'abc', '-1']) {
      const r = runSkill('capture.mjs', [p, '--dsf', bad]);
      assert.equal(r.status, 1, `--dsf ${bad} 必须被拒`);
      assert.ok(r.stderr.includes('--dsf'), r.stderr);
    }
  });

  test('grab-frames --at 只收 (0,1] 的小数', { skip: !FFMPEG && '无 ffmpeg' }, () => {
    const p = mkproj(tmpdir());
    fs.mkdirSync(path.join(p, 'build'), { recursive: true });
    fs.mkdirSync(path.join(p, 'out'), { recursive: true });
    fs.writeFileSync(path.join(p, 'build', 'timings.json'), JSON.stringify({
      fps: 30, total: 2.2, slides: [{ id: '01', duration: 1.1 }, { id: '02', duration: 1.1 }],
    }));
    const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '2.6',
      '-pix_fmt', 'yuv420p', '-y', path.join(p, 'out', 'final.mp4')], { windowsHide: true });
    assert.equal(g.status, 0, g.stderr ?? '');
    for (const bad of ['0', '-1', '2', 'abc', '']) {
      const r = runSkill('grab-frames.mjs', [p, '--at', bad]);
      assert.equal(r.status, 1, `--at ${JSON.stringify(bad)} 必须被拒`);
      assert.ok(r.stderr.includes('--at'), r.stderr);
    }
    // 合法值照常出帧
    const ok = runSkill('grab-frames.mjs', [p, '--at', '0.5']);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(fs.existsSync(path.join(p, 'build', 'introspect', 'frame-01-end.png')));
    // --ids 一个都不匹配 → 零帧 = 退出 1(别静默成功)
    const none = runSkill('grab-frames.mjs', [p, '--ids', '99']);
    assert.equal(none.status, 1, '零帧必须退出 1: ' + none.stdout);
    assert.ok(none.stderr.includes('一帧都没抽到'), none.stderr);
  });
});

describe('D5 · 字幕带闸门只对"绝对定位的 bottom"报警', () => {
  const mk = html => {
    const p = mkproj(tmpdir(), { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), html);
    return p;
  };
  test('padding-bottom / margin-bottom 不再误报(实测误报点)', () => {
    const r = runSkill('check-slides.mjs', [mk(`<!doctype html><html data-theme="a"><head><meta charset="utf-8">
<style>.cap { padding-bottom: 40px; margin-bottom: 24px; }</style></head>
<body><div class="stage"><p class="fx-fade" data-stage="1">x</p><div class="cap">图:来源</div></div></body></html>`)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/字幕带/.test(r.stdout), 'padding/margin-bottom 不该被当 bottom: ' + r.stdout.slice(-400));
  });
  test('流内元素写 bottom 不报(不产生位移), 绝对定位才报', () => {
    const stat = runSkill('check-slides.mjs', [mk(`<!doctype html><html data-theme="a"><head><meta charset="utf-8">
<style>.cap { bottom: 96px; }</style></head>
<body><div class="stage"><p class="fx-fade" data-stage="1">x</p><div class="cap">图:来源</div></div></body></html>`)]);
    assert.ok(!/字幕带/.test(stat.stdout), '没有 position:absolute 就不该报: ' + stat.stdout.slice(-300));
    const abs = runSkill('check-slides.mjs', [mk(`<!doctype html><html data-theme="a"><head><meta charset="utf-8">
<style>.cap { position: absolute; bottom: 96px; }</style></head>
<body><div class="stage"><p class="fx-fade" data-stage="1">x</p><div class="cap">图:来源</div></div></body></html>`)]);
    assert.match(abs.stdout, /字幕带/, '绝对定位贴底要报');
    assert.equal(abs.status, 0, '这是提示级, 不阻塞流水线');
    // 行内 style 也要能认出来
    const inline = runSkill('check-slides.mjs', [mk(`<!doctype html><html data-theme="a"><head><meta charset="utf-8"></head>
<body><div class="stage"><p class="fx-fade" data-stage="1">x</p><div class="cap" style="position:absolute;bottom:80px">图:来源</div></div></body></html>`)]);
    assert.match(inline.stdout, /字幕带/, '行内 style 的 absolute+bottom 同样要报');
  });
});

describe('D6 · transition 单一解析(闸门与渲染器结论一致)', () => {
  test('readTransition 接受裸字符串与对象, 结论相同', () => {
    assert.deepEqual(readTransition('xfade'), { type: 'xfade', dur: 0.4, label: '交叉溶解 xfade 0.4s' });
    assert.deepEqual(readTransition({ type: 'xfade' }), readTransition('xfade'));
    assert.deepEqual(readTransition('cut'), { type: 'cut', dur: 0, label: '硬切 cut' });
    assert.deepEqual(readTransition(null), readTransition(undefined));
    assert.deepEqual(readTransition({ type: 'xfade', duration: 1.2 }).dur, 1.2);
    for (const bad of ['fade', 42, { type: 'fade' }, { type: 'xfade', duration: 9 }, { type: 'xfade', duration: 0 }]) {
      assert.throws(() => readTransition(bad), /非法/, `${JSON.stringify(bad)} 必须报错`);
    }
  });

  test('check-slides 与 build-video 对 "xfade" 字符串给同一结论', { skip: !FFMPEG && '无 ffmpeg(用 check-slides 的标签确认)', }, () => {
    const p = mkproj(tmpdir(), { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), SLIDE);
    // build-video 读 timings.json 在 --dry-run 之前, 所以最小骨架要补一份
    fs.mkdirSync(path.join(p, 'build'), { recursive: true });
    fs.writeFileSync(path.join(p, 'build', 'timings.json'), JSON.stringify({
      fps: 30, total: 3.0, tts: 3.0, slides: [{ id: '01', duration: 3.0, tts: 3.0, clauses: [] }],
    }, null, 2));
    // build-video 的输入检查(帧序列 / preview/<id>.png)在 --dry-run 之前也会做, 所以给一张占位静帧
    const png = path.join(p, 'preview', '01.png');
    fs.mkdirSync(path.dirname(png), { recursive: true });
    const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=#123456:s=1920x1080', '-frames:v', '1', '-y', png], { windowsHide: true });
    assert.equal(g.status, 0, '应能造出占位静帧');
    // 音轨也要在(缺音频会在自检之前就退出, 看不到我们要断言的转场行)
    const au = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '3',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(p, 'audio', '01.mp3')], { windowsHide: true });
    assert.equal(au.status, 0, '应能造出静音音轨');
    const setT = v => {
      const s = JSON.parse(fs.readFileSync(path.join(p, 'script.json'), 'utf8'));
      s.transition = v;
      fs.writeFileSync(path.join(p, 'script.json'), JSON.stringify(s, null, 2));
    };
    setT('xfade');
    const str = runSkill('check-slides.mjs', [p]);
    assert.match(str.stdout, /交叉溶解 xfade/, str.stdout.slice(-300));
    setT({ type: 'xfade' });
    const obj = runSkill('check-slides.mjs', [p]);
    assert.equal(obj.stdout.match(/转场 = ([^;]*)/)?.[1], str.stdout.match(/转场 = ([^;]*)/)?.[1],
      '裸字符串与对象在闸门里必须一样(旧实现只认对象里的 type, 字符串会显示成非法值)');
    setT('fade');
    const bad = runSkill('check-slides.mjs', [p]);
    assert.match(bad.stdout, /✗/, '非法值要显式报出来');
  });
});

describe('复查补充 · 取值型 flag 清单 + 落盘收监 + transition 两端一致', () => {
  test('VALUE_FLAGS 不得包含布尔开关(否则它后面那个位置参数会被当值吃掉)', () => {
    // 成因: 清单里混进 --json / --allow-stale-css 这类开关后, `capture --allow-stale-css <项目>`
    // 会把 <项目> 当开关的值跳过 → 位置参数落到 cwd, 对着调用目录干活(2026-09-18 复查实测)。
    const DUAL = new Set(['--transition']);   // 既能当开关又能带值(实测里有 argv.includes 也有取值)
    const used = new Set();
    for (const f of fs.readdirSync(SCRIPTS)) {
      if (!f.endsWith('.mjs')) continue;
      const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
      for (const m of src.matchAll(/argv\.includes\(['"](--[a-z-]+)['"]\)/g)) used.add(m[1]);
    }
    const bad = [...used].filter(f => !DUAL.has(f) && VALUE_FLAGS.has(f));
    assert.deepEqual(bad, [], `这些开关被当成取值型 flag, 会把后面的位置参数吃掉: ${bad.join(', ')}`);
    // 真实用法逐条: 开关后面的目录必须仍被认成项目目录
    for (const sw of ['--allow-stale-css', '--no-subs', '--json', '--both', '--force']) {
      assert.equal(positionalDir([sw, './proj']), path.resolve('./proj'), `${sw} 后面跟目录时不得被当值吃掉`);
    }
    // 取值型照旧要跳过一个值
    for (const vf of ['--topic', '--ids', '--mode', '--dsf', '--at', '--transition']) {
      assert.equal(positionalDir([vf, 'X', './proj']), path.resolve('./proj'), `${vf} 的值必须被跳过`);
    }
    assert.deepEqual(positionals(['--check', 'a.png', 'b.png']), ['a.png', 'b.png'], 'prep-image 的文件名是位置参数');
  });

  test('init-project --upgrade-css 也要落盘收监: slides/ 是悬空链接时不得写到项目外', (t) => {
    // 复查 B4: 计划里点名 init-project 与 fetch-official-images, 但两者此前都没有 safeOut ——
    // CHANGELOG 却宣称"每个写入点都收监", 属于文档与代码不符(第三轮 review 抓到的)。
    const proj = mkproj(tmpdir(), { tokens: LEGACY_TOKENS });
    const outside = tmpdir();
    const slidesReal = path.join(proj, 'slides');
    fs.rmSync(slidesReal, { recursive: true, force: true });
    const made = (() => {
      try { fs.symlinkSync(outside, slidesReal, 'dir'); return true; } catch { /* 试 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', slidesReal, outside], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(slidesReal);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction(收监拒绝无从观察)');
    // 让 slides 指向项目外(外面先放一份 tokens.css, 好走到"升级"分支)
    fs.writeFileSync(path.join(outside, 'tokens.css'), LEGACY_TOKENS);
    const r = runSkill('init-project.mjs', [proj, '--upgrade-css']);
    assert.equal(r.status, 1, '项目内的目录段指向项目外时必须拒绝: ' + r.stdout + r.stderr);
    assert.ok(/符号链接|越出|收监/.test(r.stderr + r.stdout), r.stderr + r.stdout);
    assert.equal(fs.readFileSync(path.join(outside, 'tokens.css'), 'utf8'), LEGACY_TOKENS, '项目外的文件不得被改写');
    assert.equal(fs.existsSync(path.join(outside, 'tokens.css.bak')), false, '备份也不得写到项目外');
  });

  test('transition: 渲染器(build-video)与闸门用同一解析 —— 裸字符串在两端同义', { skip: !FFMPEG && '无 ffmpeg' }, () => {
    const p = mkproj(tmpdir(), { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(p, 'slides', '01.html'), SLIDE);
    // build-video 在 --dry-run 之前就读 timings.json, 所以最小骨架要补一份
    fs.mkdirSync(path.join(p, 'build'), { recursive: true });
    fs.writeFileSync(path.join(p, 'build', 'timings.json'), JSON.stringify({
      fps: 30, total: 3.0, tts: 3.0, slides: [{ id: '01', duration: 3.0, tts: 3.0, clauses: [] }],
    }, null, 2));
    const setT = v => {
      const s = JSON.parse(fs.readFileSync(path.join(p, 'script.json'), 'utf8'));
      if (v === null) delete s.transition; else s.transition = v;
      fs.writeFileSync(path.join(p, 'script.json'), JSON.stringify(s, null, 2));
    };
    // --dry-run 会打印解析结果, 不需要真编码; 但 build-video 的输入检查(帧序列 / preview/<id>.png /
    // 音轨)在 dry-run 之前也会做, 所以占位静帧与静音音轨都得在
    const png = path.join(p, 'preview', '01.png');
    fs.mkdirSync(path.dirname(png), { recursive: true });
    assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=#123456:s=1920x1080',
      '-frames:v', '1', '-y', png], { windowsHide: true }).status, 0, '应能造出占位静帧');
    assert.equal(spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '3',
      '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(p, 'audio', '01.mp3')], { windowsHide: true }).status, 0, '应能造出静音音轨');
    setT('xfade');
    const dry = runSkill('build-video.mjs', [p, '--dry-run']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /交叉溶解 0\.4s/, '裸字符串 xfade 必须被渲染器认成溶解: ' + dry.stdout);
    setT({ type: 'xfade', duration: 1.2 });
    assert.match(runSkill('build-video.mjs', [p, '--dry-run']).stdout, /交叉溶解 1\.2s/);
    setT(null);
    assert.match(runSkill('build-video.mjs', [p, '--dry-run']).stdout, /转场: 硬切/, '缺省 = 硬切');
    setT('fade');
    const bad = runSkill('build-video.mjs', [p, '--dry-run']);
    assert.equal(bad.status, 1, '非法值渲染器也要拒');
    assert.match(bad.stderr, /transition/, bad.stderr);
    // 来源要点名: --transition 写错时不该说成 script.transition 写错(2026-09-18 复查抓到)
    const badFlag = runSkill('build-video.mjs', [p, '--transition', 'bogus', '--dry-run']);
    assert.equal(badFlag.status, 1);
    assert.match(badFlag.stderr, /--transition/, `要点名 --transition: ${badFlag.stderr}`);
    assert.ok(!/script\.transition/.test(badFlag.stderr), `不该甩锅给 script.json: ${badFlag.stderr}`);
  });

  test('init-project 骨架写点也收监: assets/ 指向项目外时 --force 重建不得写到项目外', (t) => {
    // 与上一条同源(复查 B4): 收监是逐个写点做的, --upgrade-css 只是其中之一。骨架那次创建
    // 8 个目录 + 5 个文件, 这些路径此前都是裸 path.join —— 目标目录里预置一个指向项目外的
    // assets 链接(用户共享素材的常见做法), 生成物就会落到项目外。
    const proj = tmpdir();
    const outside = tmpdir();
    const assets = path.join(proj, 'assets');
    const made = (() => {
      try { fs.symlinkSync(outside, assets, 'dir'); return true; } catch { /* 试 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', assets, outside], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(assets);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction(骨架写点收监无从观察)');
    const r = runSkill('init-project.mjs', [proj, '--force']);
    assert.equal(r.status, 1, `项目内的目录段指向项目外时必须拒绝: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr + r.stdout, /越出|符号链接|收监/, r.stderr + r.stdout);
    assert.deepEqual(fs.readdirSync(outside), [], '项目外目录里不得出现任何生成物');
  });
});
