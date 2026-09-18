// 二审(2026-09-18)修复的回归测试: 输出收监 / 网络边界 / 属性解析 / ASR 错误计入 / ffmpeg 发现 / 路径别名
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { runSkill, runSkillAsync, mkproj, tmpdir, skill } from './helpers.mjs';
import { assertResolvedHost, PolicyError } from '../scripts/url-policy.mjs';
import { SCRIPTS } from './helpers.mjs';
import { findTool } from '../scripts/tools.mjs';
const { injectHtmlVars, addNoFx } = await import('file://' + path.join(SCRIPTS, 'preview-page.mjs').replace(/\\/g, '/'));

describe('二审 · 输出收监(项目内目录段是符号链接时, 不得写到/删到项目外)', () => {
  // Windows 无开发者模式时 symlinkSync 会失败, 但**目录 junction 不需要管理员**(cmd mklink /J);
  // 两条路都试, 都不行才 skip —— 这个 canary 用例必须在能建的平台上真跑
  const linkDir = (target, linkPath) => {
    try { fs.symlinkSync(target, linkPath, 'dir'); return true; } catch { /* 试 junction */ }
    try {
      const r = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { encoding: 'utf8', windowsHide: true });
      return r.status === 0 && fs.existsSync(linkPath);
    } catch { return false; }
  };
  const canLink = (() => {
    try {
      const a = tmpdir(), b = tmpdir();
      const ok = linkDir(b, path.join(a, 'l'));
      fs.rmSync(a, { recursive: true, force: true });
      return ok;
    } catch { return false; }
  })();

  test('capture: build/frames 是指向项目外的符号链接 → 拒绝, canary 目录完好', { skip: !canLink && '当前环境建不了符号链接/junction' }, () => {
    const proj = tmpdir();
    const canary = tmpdir();
    fs.writeFileSync(path.join(canary, 'keep.txt'), 'DO NOT DELETE');
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses: [{ stage: 1, text: 'x' }] }] });
    fs.writeFileSync(path.join(proj, 'build', 'timings.json'), JSON.stringify({ fps: 30, total: 1, slides: [{ id: '01', duration: 1, stages: { 1: 0 }, clauses: [{ stage: 1, start: 0, text: 'x' }] }] }));
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), '<html><head></head><body><p class="fx-fade" data-stage="1">x</p></body></html>');
    fs.rmSync(path.join(proj, 'build', 'frames'), { recursive: true, force: true });
    assert.ok(linkDir(canary, path.join(proj, 'build', 'frames')), '测试前置: 链接要建成功');
    const r = runSkill('capture.mjs', [proj, '--mode', 'motion']);
    assert.notEqual(r.status, 0, '输出目录经符号链接越界必须拒绝');
    assert.ok(/符号链接|越出项目目录/.test(r.stdout + r.stderr), `要点明原因, 实际: ${(r.stdout + r.stderr).slice(-200)}`);
    assert.equal(fs.readFileSync(path.join(canary, 'keep.txt'), 'utf8'), 'DO NOT DELETE', 'canary 必须完好');
  });

  test('preview-page: preview 是指向项目外的符号链接 → 拒绝写快照', { skip: !canLink && '当前环境建不了符号链接/junction' }, () => {
    const proj = tmpdir();
    const canary = tmpdir();
    mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3', clauses: [{ stage: 1, text: 'x' }] }] });
    fs.writeFileSync(path.join(proj, 'slides', '01.html'), '<html><head></head><body><p class="fx-fade" data-stage="1">x</p></body></html>');
    assert.ok(linkDir(canary, path.join(proj, 'preview')), '测试前置: 链接要建成功');
    const r = runSkill('preview-page.mjs', [proj]);
    assert.notEqual(r.status, 0);
    assert.deepEqual(fs.readdirSync(canary), [], 'canary 目录里不得出现任何文件');
  });
});

describe('二审 · 网络边界: 拒绝的目标必须一个请求都收不到', () => {
  test('被策略拒绝的目标: 本地服务器收到的请求数必须是 0', async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => { hits++; res.end('x'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    try {
      // --url 直下模式(不需要 playwright): 目标是 loopback → 策略层就该拦住
      const r = await runSkillAsync('fetch-official-images.mjs', ['--url', `http://127.0.0.1:${port}/x.png`, '--out-dir', 'assets'], { cwd: tmpdir() });
      assert.equal(hits, 0, '被拒目标不得收到任何请求(闸门必须在连接之前)');
      assert.notEqual(r.status, 0);
      // 公网域名形式但解析回环(rebinding): 字符串层放行, DNS 层必须拦
      const r2 = await runSkillAsync('fetch-official-images.mjs', ['--url', `http://localtest.me:${port}/x.png`, '--out-dir', 'assets'], { cwd: tmpdir() });
      if (/localtest\.me/.test(r2.stdout + r2.stderr)) {           // 解析成功才可能有结论
        assert.equal(hits, 0, 'DNS 解析回环也必须拦在连接之前');
        assert.notEqual(r2.status, 0);
      }
    } finally { srv.close(); }
  });

  test('assertResolvedHost: 注入假解析器即可测(不需要真 DNS)', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    await assert.rejects(() => assertResolvedHost('https://cdn.example.com/a.png', { lookup }), (e) => e instanceof PolicyError);
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    await assert.doesNotReject(() => assertResolvedHost('https://cdn.example.com/a.png', { lookup: publicLookup }));
    // 云元数据地址同样要拦
    await assert.rejects(() => assertResolvedHost('https://evil.example.com/', { lookup: async () => [{ address: '169.254.169.254', family: 4 }] }));
    // 裸主机名(无点)本就被字符串层拦, 这里直接放行不查
    await assert.doesNotReject(() => assertResolvedHost('http://localhost/', { lookup }));
  });
});

describe('二审 · 放映页属性解析(单引号/无引号不得产生重复属性)', () => {
  test('单引号 style/class: 就地改写, 不得出现重复属性', () => {
    const html = `<html lang="zh" class='theme-a' style='--t2:800ms'>`;
    const out = injectHtmlVars(html, '--t2:4866ms');
    assert.equal((out.match(/style=/g) || []).length, 1, `不得出现第二个 style 属性: ${out}`);
    assert.ok(out.includes('--t2:800ms;--t2:4866ms'), `应就地在原值后追加: ${out}`);
    const nofx = addNoFx(html);
    assert.equal((nofx.match(/class=/g) || []).length, 1, `不得出现第二个 class 属性: ${nofx}`);
    assert.ok(/class='theme-a no-fx'|class="theme-a no-fx"/.test(nofx), `应在原类后追加: ${nofx}`);
  });

  test('无引号属性与已有 no-fx: 也要认出来', () => {
    const out = injectHtmlVars('<html class=deck style=color:red>', '--t1:0ms');
    assert.equal((out.match(/style=/g) || []).length, 1, out);
    assert.ok(out.includes('color:red;--t1:0ms'), out);
    assert.equal(addNoFx('<html class=deck>'), '<html class="deck no-fx">');
    const once = addNoFx('<html class="deck no-fx">');
    assert.equal(addNoFx(once), once, '已带 no-fx 时不重复添加');
    assert.equal(addNoFx(`<html class='deck no-fx'>`).match(/no-fx/g).length, 1);
  });
});

describe('二审 · ASR 请求错误必须算失败并非零退出', () => {
  // asr.mjs 启动第一件事就是 requireTool('ffmpeg')(切音频要用), 无 ffmpeg 时走不到请求那一步。
  // 主仓 CI(npm run check → 根目录 node --test)没有 ffmpeg —— 这条例外必须像其它渲染用例一样
  // 带原因跳过, 否则整个插件把主仓 CI 染红(第三轮复查实测踩到)。
  test('转写请求全失败(503) → 退出码非零且不计入通过', { skip: !findTool('ffmpeg') && '无 ffmpeg(asr 启动即需要; 真跑由 scoped smoke workflow 覆盖)' }, async () => {
    // 本地假服务器: 一律 503(不需要真 Key, 也不需要真 ASR)
    const srv = http.createServer((req, res) => { res.statusCode = 503; res.end('{"error":"busy"}'); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', audio: '01.mp3', clauses: [{ stage: 1, text: '一。' }] }] });
    // asr.mjs 读的是 build-video --asr 切好的 asr/part-*.mp3, 这里直接造一个占位文件
    fs.mkdirSync(path.join(proj, 'asr'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'asr', 'part-01-1.mp3'), 'not-really-mp3');
    try {
      const r = await runSkillAsync('asr.mjs', [proj, '--allow-any-endpoint', '--base-url', `http://127.0.0.1:${port}`], {
        cwd: proj, env: { ...process.env, MINIMAX_API_KEY: 'fake-key-for-test', MINIMAX_REGION: 'cn' },
      });
      assert.notEqual(r.status, 0, `请求失败不能被当成通过: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout + r.stderr, /请求失败/, '要点名"请求失败"而不是混进通过数');
    } finally { srv.close(); }
  });
});

describe('二审 · ffmpeg 发现(项目内 node_modules)', () => {
  test('findTool: 从项目目录调用时能找到项目内的 ffmpeg-static', async () => {
    const { findTool } = await import('../scripts/tools.mjs');
    const proj = tmpdir();
    const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const dir = path.join(proj, 'node_modules', 'ffmpeg-static');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, exe), 'stub');
    // 模拟"在项目目录里执行": KIT_PROJECT_DIR 未设, 靠 cwd 找到
    const prev = process.env.KIT_PROJECT_DIR;
    delete process.env.KIT_PROJECT_DIR;
    const cwd = process.cwd();
    try {
      process.chdir(proj);
      assert.ok(findTool('ffmpeg', process.cwd()), '应能在项目目录里发现 ffmpeg-static');
    } finally {
      process.chdir(cwd);
      if (prev !== undefined) process.env.KIT_PROJECT_DIR = prev;
    }
  });

  test('prep-image / asr 会把项目目录交给工具发现(源码级断言, 防回退)', () => {
    const pre = fs.readFileSync(skill('prep-image.mjs'), 'utf8');
    assert.match(pre, /requireTool\('ffmpeg',\s*process\.cwd\(\)\)/, 'prep-image 必须把项目目录(此处为 cwd)传给 requireTool');
    const asr = fs.readFileSync(skill('asr.mjs'), 'utf8');
    assert.match(asr, /requireTool\('ffmpeg',\s*dir\)/, 'asr 必须把项目目录传给 requireTool');
  });
});
