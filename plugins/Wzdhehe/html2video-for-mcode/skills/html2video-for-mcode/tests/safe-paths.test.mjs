// 安全边界 · 路径收监(script.json 派生路径不得越出项目目录)
// 对应评审意见 1: Input-derived IDs and paths are not contained.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inside, findTool } from '../scripts/tools.mjs';
import { runSkill, probeHelper, mkproj, tmpdir } from './helpers.mjs';

describe('inside() 判定', () => {
  test('根内相对路径 → true; 越出 → false', () => {
    const root = path.resolve('/proj');
    assert.equal(inside(root, path.resolve('/proj/a/b.txt')), true);
    assert.equal(inside(root, path.resolve('/proj-a/b.txt')), false, '前缀相似的兄弟目录不算在内');
    assert.equal(inside(root, path.resolve('/victim')), false);
    assert.equal(inside(root, path.resolve('/proj')), false, '根本身不算 inside(要求严格子路径)');
  });
});

describe('safeId / safeRel(退出型, subprocess 探测)', () => {
  test('safeId: 合法 id 原样返回', () => {
    for (const id of ['01', 'slide-2', 'A_b', 'x'.repeat(64)]) {
      const r = probeHelper('safeId', `[${JSON.stringify(id)}]`);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.startsWith('RETURN:'), `safeId(${id}) 应返回原值`);
    }
  });
  test('safeId: 穿越/绝对/空/超长/换行 全部退出 1', () => {
    for (const id of ['../../victim', '..\\..\\victim', '/abs', 'C:\\x', '', 'a/b', 'a\nb', 'x'.repeat(65), null, 42]) {
      const r = probeHelper('safeId', `[${JSON.stringify(id)}]`);
      assert.notEqual(r.status, 0, `safeId(${JSON.stringify(id)}) 必须拒绝`);
    }
  });
  test('safeRel: 根内相对路径返回绝对路径', () => {
    const r = probeHelper('safeRel', `["/proj", "a/b.txt", {}]`);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.startsWith('RETURN:'), '根内路径应放行');
  });
  test('safeRel: 绝对路径 / ../ 穿越 / 空串 拒绝', () => {
    for (const rel of ['/etc/passwd', '../../victim', '', 'a/../../..']) {
      const r = probeHelper('safeRel', `["/proj", ${JSON.stringify(rel)}, {}]`);
      assert.notEqual(r.status, 0, `safeRel(${JSON.stringify(rel)}) 必须拒绝`);
    }
  });
  test('safeRel: 符号链接逃逸拒绝(建不了链接则 skip)', (t) => {
    const root = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    const link = path.join(root, 'assets-link');
    // symlink 需要开发者模式, junction(mklink /J)不需要 —— 两条路都试, 尽量真跑而不是跳过
    const made = (() => {
      try { fs.symlinkSync(outside, link, 'dir'); return true; } catch { /* 退回 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, outside], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(link);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction');
    const r = probeHelper('safeRel', `["${path.resolve(root).replace(/\\/g, '/')}", "assets-link/secret.txt", {}]`);
    assert.notEqual(r.status, 0, '指向项目外的符号链接必须拒绝');
  });

  test('safeRel: 悬空链接(目标已删除)必须拒绝 —— existsSync 看不出它, 旧回溯会当"不存在"跳过', (t) => {
    // 复查 B3: 旧实现用 existsSync 回溯祖先 —— 悬空链接的 existsSync 是 **false**, 于是它被跳过、
    // 链接本身从未被复核, 写进去就落到项目外。现在改用 lstat 停住 + realpath 解不开即 fail closed。
    const root = tmpdir();
    const target = tmpdir();
    const link = path.join(root, 'slides-link');
    const made = (() => {
      try { fs.symlinkSync(target, link, 'dir'); return true; } catch { /* 退回 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(link);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction(悬空链接场景无从构造)');
    fs.rmSync(target, { recursive: true, force: true });   // 目标消失 → 链接悬空
    assert.equal(fs.existsSync(link), false, '前置: 悬空链接的 existsSync 必须是 false(旧实现的盲区正在这里)');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '前置: lstat 仍能看到这个 reparse point');
    const r = probeHelper('safeRel', `["${path.resolve(root).replace(/\\/g, '/')}", "slides-link/x.css", {}]`);
    assert.notEqual(r.status, 0, '悬空链接必须拒绝(解不开就无法证明它落在项目内)');
  });

  test('safeOut 单元级: 项目内的目录段是指向项目外的链接 → 直接调用即拒绝, 且外面没有留下任何文件', (t) => {
    // 复查 B4 收尾: 收监此前只有"跑某个脚本"的集成用例。这里直接调 safeOut(不经任何流水线),
    // 确认拒绝发生在这一层 —— 集成用例可能因为别的校验先退出, 从而给出假绿灯。
    const root = tmpdir();
    const outside = tmpdir();
    const linked = path.join(root, 'out');
    const made = (() => {
      try { fs.symlinkSync(outside, linked, 'dir'); return true; } catch { /* 退回 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', linked, outside], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(linked);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction(safeOut 拒绝无从观察)');
    const r = probeHelper('safeOut', `["${path.resolve(root).replace(/\\/g, '/')}", "out", "x.txt"]`);
    assert.notEqual(r.status, 0, 'safeOut 必须自己拒绝, 而不是把判断留给调用方');
    assert.match(r.stderr, /越出项目目录|符号链接/, `要点名是链接越界, 实际: ${r.stderr.slice(0, 200)}`);
    assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false, '拒绝必须发生在写入之前');
  });

  test('safeRel: 项目内链接指向项目"父目录"时, 链接下的新路径必须拒绝(1.7.5 复查②, 实弹复现过的洞)', (t) => {
    // 形状: link → 项目的父目录。目标**已存在**时游走能走到完整路径, 正确拒绝;
    // 目标**尚不存在**时旧回退 inside(real, realRoot) 被满足(根在父目录之内)→ 放行 → 写穿到项目外。
    const root = tmpdir();
    const parent = path.dirname(root);          // tmpdir() 每个都是独立目录, root 的父就是公共层
    fs.writeFileSync(path.join(parent, 'canary.txt'), 'KEEP');
    const link = path.join(root, 'link');
    const made = (() => {
      try { fs.symlinkSync(parent, link, 'dir'); return true; } catch { /* 退回 junction */ }
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, parent], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(link);
    })();
    if (!made) return t.skip('当前环境建不了符号链接/junction(祖先链接形状无从构造)');
    t.after(() => fs.rmSync(path.join(parent, 'canary.txt'), { force: true }));   // canary 落在共享 %TEMP% 层, 测完即清
    const mk = rel => probeHelper('safeRel', `["${path.resolve(root).replace(/\\/g, '/')}", ${JSON.stringify(rel)}, {}]`);
    const rNew = mk('link/new.txt');
    assert.notEqual(rNew.status, 0, `链接指向父目录 + 新目标必须拒绝, 实际: ${(rNew.stderr || rNew.stdout).slice(-200)}`);
    const rOld = mk('link/canary.txt');
    assert.notEqual(rOld.status, 0, '已存在目标穿过链接同样必须拒绝');
    assert.equal(fs.existsSync(path.join(parent, 'new.txt')), false, '拒绝必须发生在写入之前');
    assert.equal(fs.readFileSync(path.join(parent, 'canary.txt'), 'utf8'), 'KEEP', 'canary 必须完好');
  });
});

describe('消费者脚本: 恶意 script.json 必须在干坏事之前退出', () => {
  test('capture: id=../../canary → 退出 1 且 canary 完好(递归删除被拦)', () => {
    const proj = tmpdir();
    const canary = path.join(path.dirname(proj), 'canary-' + path.basename(proj));
    fs.mkdirSync(path.join(canary, 'deep', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(canary, 'deep', 'deeper', 'keep.txt'), 'do not delete');
    mkproj(proj, { slides: [{ id: '../../' + path.basename(canary), html: 'x.html', audio: 'a.mp3' }] });
    const r = runSkill('capture.mjs', [proj]);
    assert.notEqual(r.status, 0, '恶意 id 必须被拒绝');
    assert.ok(fs.existsSync(path.join(canary, 'deep', 'deeper', 'keep.txt')), 'canary 必须完好');
  });

  test('check-slides: html=../outside.html → 退出 1', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '../outside.html', audio: '01.mp3', clauses: [] }] });
    const r = runSkill('check-slides.mjs', [proj]);
    assert.notEqual(r.status, 0);
    assert.ok((r.stdout + r.stderr).includes('越出') || (r.stdout + r.stderr).includes('非法'), `应指明越界原因, 实际: ${r.stderr.slice(-300)}`);
  });

  test('check-slides: <img src> 越出项目目录 → 记为 error 并退出 1', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'),
      `<img src="../../neighbor.png"><div class="fx-fade" data-stage="1">x</div>`);
    const r = runSkill('check-slides.mjs', [proj]);
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes('越出项目目录'), `应报图片越界, 实际: ${r.stdout.slice(-300)}`);
  });

  test('plan-timings: audio=../../secret.mp3 → 退出 1(需 ffprobe)', { skip: !findTool('ffprobe') && '无 ffprobe, 跳过(CI 主工作流无 ffmpeg)' }, () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', audio: '../../secret.mp3', clauses: [{ stage: 1, text: 'x' }] }] });
    const r = runSkill('plan-timings.mjs', [proj]);
    assert.notEqual(r.status, 0);
  });

  test('build-video: bgm.file 为绝对路径 → 退出 1(需 ffmpeg+ffprobe)', { skip: (!findTool('ffmpeg') || !findTool('ffprobe')) && '无 ffmpeg, 跳过' }, () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', audio: '01.mp3' }] });
    const scriptPath = path.join(proj, 'script.json');
    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    script.bgm = { file: path.join(tmpdir(), 'evil-bgm.mp3') }; // 绝对路径直接逃逸
    fs.writeFileSync(scriptPath, JSON.stringify(script));
    const r = runSkill('build-video.mjs', [proj]);
    assert.notEqual(r.status, 0);
    assert.ok(r.stdout.includes('bgm') || r.stderr.includes('bgm'), '应点名 bgm.file');
  });

  // ── 2026-09-18 三维审计发现的一致性缺口: 同一信任级的入参, 别处管了这里没管 ──
  // 这些用例只喂 script.json + timings.json: 坏值必须在编码开始前就被拒(不依赖 ffmpeg),
  // 否则就要等整条流水线跑完才报错 —— 原 width 用例没写 timings.json, 读文件就退出了, 属假绿
  const withTimings = (scriptPatch, timingsPatch = {}) => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'build', 'timings.json'),
      JSON.stringify({ fps: 30, total: 1, slides: [{ id: '01', duration: 1 }], ...timingsPatch }));
    const sp = path.join(proj, 'script.json');
    const script = JSON.parse(fs.readFileSync(sp, 'utf8'));
    Object.assign(script, scriptPatch);
    fs.writeFileSync(sp, JSON.stringify(script));
    return proj;
  };

  test('build-video: bgm.volume/fadeIn/fadeOut 非数值 → 退出 1(与 width 同一注入面, 此前漏管)', () => {
    for (const bad of [
      { volume: "0.5,amovie='C:/x',volume=0.5" },   // 追加 filter 节点(ffmpeg filter 可读本地文件进输出音频)
      { fadeIn: '1.5,volume=9' },
      { fadeOut: 'x' },
      { volume: 999 },
    ]) {
      const proj = withTimings({ bgm: { file: 'assets/bgm.mp3', ...bad } });
      fs.mkdirSync(path.join(proj, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(proj, 'assets', 'bgm.mp3'), 'x');
      const r = runSkill('build-video.mjs', [proj]);
      assert.notEqual(r.status, 0, `bgm ${JSON.stringify(bad)} 必须被拒绝`);
      assert.ok(/bgm\./.test(r.stdout + r.stderr), `要点名是 bgm 的哪个字段非法, 实际: ${(r.stdout + r.stderr).slice(-200)}`);
    }
  });

  test('build-video: fps 非数值 → 退出 1(拼进 -r/-framerate; timings.fps 优先于 script.fps)', () => {
    const r = runSkill('build-video.mjs', [withTimings({}, { fps: '30 -vf scale=1:1' })]);
    assert.notEqual(r.status, 0);
    assert.ok(/fps/.test(r.stdout + r.stderr), `要点名 fps, 实际: ${(r.stdout + r.stderr).slice(-200)}`);
  });

  test('build-video: width 非法字符串 → 退出 1(ffmpeg filter 注入面)', () => {
    const r = runSkill('build-video.mjs', [withTimings({ width: '1920,drawtext=text=pwned' })]);
    assert.notEqual(r.status, 0);
    assert.ok(/width/.test(r.stdout + r.stderr), `要点名 width, 实际: ${(r.stdout + r.stderr).slice(-200)}`);
  });

  test('preview-page: script.width 非法字符串 → 退出 1(该值插进放映页 CSS/JS, 此前直接杀死整页脚本)', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), '<html><head></head><body><p class="fx-fade" data-stage="1">x</p></body></html>');
    const scriptPath = path.join(proj, 'script.json');
    for (const bad of ['1920px', '1920; } body{background:url(x)} /*']) {
      const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
      script.width = bad;
      fs.writeFileSync(scriptPath, JSON.stringify(script));
      const r = runSkill('preview-page.mjs', [proj]);
      assert.notEqual(r.status, 0, `width=${JSON.stringify(bad)} 必须被拒绝(与 build-video 的 clampDim 同一道门)`);
    }
  });

  test('preview-page: 超大 tokens.css → 退出 1(与 check-slides/init-project 同一道门, 此前实测跑 129s)', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), '<html><head></head><body><p class="fx-fade" data-stage="1">x</p></body></html>');
    // 反复的开标记但无收标记 —— 受管块扫描的二次方放大输入
    fs.writeFileSync(path.join(proj, 'slides', 'tokens.css'),
      ':root{--accent:#111}\n' + '/* >>> html2video:nofx rev=deadbeef >>> */\n'.repeat(60000) + 'x'.repeat(3_000_000));
    const t0 = Date.now();
    const r = runSkill('preview-page.mjs', [proj], { timeout: 90000 });
    const ms = Date.now() - t0;
    assert.notEqual(r.status, 0, '超大 tokens.css 必须被上限拒绝');
    assert.ok(/tokens\.css/.test(r.stdout + r.stderr), '要点名 tokens.css');
    assert.ok(ms < 30000, `应在秒级拒绝, 实际 ${ms}ms`);
  });

  // ── 2026-09-18 实测踩坑(PITFALLS.md)固化成闸门 ──
  test('check-slides 5e: 绝对定位落进字幕带(bottom < 168px@1080) → 点名警告', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'),
      `<html><head><style>.cap{position:absolute;bottom:96px}</style></head><body>
       <p class="fx-fade" data-stage="1">x</p><div class="cap">图:某来源</div></body></html>`);
    const r = runSkill('check-slides.mjs', [proj]);
    assert.equal(r.status, 0, '提示级不得阻塞流水线');
    assert.match(r.stdout, /字幕带/, '要点名落在字幕带');
    assert.match(r.stdout, /bottom:96px/, '报出具体值');
    // 安全区之上的图注不该报
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'),
      `<html><head><style>.cap{position:absolute;bottom:196px}</style></head><body>
       <p class="fx-fade" data-stage="1">x</p><div class="cap">图:某来源</div></body></html>`);
    const r2 = runSkill('check-slides.mjs', [proj]);
    assert.ok(!/字幕带/.test(r2.stdout), `bottom:196px 在安全区之上, 不该报: ${r2.stdout.slice(-200)}`);
  });

  test('check-slides 5d: .fx-stagger 与 data-stage 同张 → 提示确认(PITFALLS #2)', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'),
      `<html><head></head><body>
       <ul class="fx-stagger" style="--stagger-base:var(--t1)"><li>a</li><li>b</li></ul>
       <p class="fx-fade" data-stage="3">自己管入场</p></body></html>`);
    const r = runSkill('check-slides.mjs', [proj]);
    assert.equal(r.status, 0, '提示级不得阻塞流水线');
    assert.match(r.stdout, /fx-stagger/, '要点名 stagger 与 data-stage 共存');
    assert.match(r.stdout, /动画窗/, '要给出可自查的信号(动画窗变短)');
  });

  test('check-slides 5: 带 data-stage 却没有 fx 类 → 警告(stagger 不再兜底)', () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'),
      `<html><head></head><body><ul class="fx-stagger"><li data-stage="2">以为 stagger 会管</li></ul></body></html>`);
    const r = runSkill('check-slides.mjs', [proj]);
    assert.match(r.stdout, /没有 fx-\* 类/, '要警告元素会停在 opacity:0');
    assert.ok(!/可豁免/.test(r.stdout), '旧措辞"放进 .fx-stagger 容器可豁免"已不成立 —— stagger 规则带 :not([data-stage])');
  });
});
