// 1.6.0 回归测试: 封面内嵌与首帧非黑、切页无黑帧(硬切/溶解)、语速闸门、单级/多级都能出片
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findTool, loadPackage, safeId } from '../scripts/tools.mjs';
import { runSkill, tmpdir } from './helpers.mjs';

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
const ffprobe = args => (spawnSync(FFPROBE, ['-v', 'error', ...args], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();

// 造一个 n 张的项目(每张 1 段静音 + 多级入场), 返回项目目录
function mkVideoProject({ n = 3, stagesPerSlide = 2, speed = 1.1, transition = null, audioSec = 3 } = {}) {
  const proj = tmpdir();
  assert.equal(runSkill('init-project.mjs', [proj, '--topic', 'CoverTest']).status, 0);
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', String(audioSec),
      '-c:a', 'libmp3lame', '-b:a', '64k', '-y', path.join(proj, 'audio', `${id}.mp3`)], { windowsHide: true });
    assert.equal(g.status, 0, g.stderr ?? '');
  }
  const slides = [];
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    const cls = [];
    for (let k = 1; k <= stagesPerSlide; k++) cls.push({ stage: k, text: `${'\u5b57'.repeat(6)}${i}-${k}\u3002` });
    slides.push({ id, layout: 'statement', html: `${id}-s.html`, audio: `${id}.mp3`, title: `\u7b2c${i}\u5f20`, clauses: cls });
    const layers = Array.from({ length: stagesPerSlide }, (_, k) =>
      `<p class="fx-fade" data-stage="${k + 1}">\u5c42 ${k + 1}</p>`).join('');
    fs.writeFileSync(path.join(proj, 'slides', `${id}-s.html`),
      `<!doctype html><html data-theme="a"><head><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"></head>
<body><div class="stage"><h1 class="fx-rise" data-stage="1">\u7b2c ${i} \u5f20</h1>${layers}</div></body></html>`);
  }
  const scriptPath = path.join(proj, 'script.json');
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  script.slides = slides;
  script.speed = { default: speed, first: speed, last: speed };
  if (transition) script.transition = transition;
  else delete script.transition;
  fs.writeFileSync(scriptPath, JSON.stringify(script, null, 2));
  return proj;
}

const meanLuma = (file, t) => {
  const o = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /YAVG=([0-9.]+)/.exec((o.stdout || '') + (o.stderr || ''));
  return m ? parseFloat(m[1]) : null;
};

describe('1.6.0 · 封面与切页(需 ffmpeg+playwright)', () => {
  const needTools = async t => {
    if (!FFMPEG || !FFPROBE) { t.skip('无 ffmpeg/ffprobe'); return false; }
    const pw = await loadPackage('playwright');
    if (!pw) { t.skip('无 playwright'); return false; }
    try { const b = await pw.chromium.launch({ headless: true }); await b.close(); }
    catch { t.skip('chromium 未安装'); return false; }
    return true;
  };

  test('封面: capture 出 preview/cover.png, 成片内嵌 attached_pic + 导出 out/cover.png, 首帧非黑', async t => {
    if (!await needTools(t)) return;
    const proj = mkVideoProject({ n: 3 });
    assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
    assert.equal(runSkill('capture.mjs', [proj, '--mode', 'motion']).status, 0);
    const cover = path.join(proj, 'preview', 'cover.png');
    assert.ok(fs.existsSync(cover), 'capture 要为第 1 张出 preview/cover.png');
    assert.equal(runSkill('build-video.mjs', [proj]).status, 0);
    const final = path.join(proj, 'out', 'final.mp4');
    assert.ok(fs.existsSync(path.join(proj, 'out', 'cover.png')), '要导出 out/cover.png 供平台上传');
    // 内嵌封面流
    const disp = ffprobe(['-select_streams', 'v', '-show_entries', 'stream_disposition=attached_pic', '-of', 'csv=p=0', final]);
    assert.match(disp, /1/, `成片里要有 attached_pic 流, 实际: ${JSON.stringify(disp)}`);
    // 首帧不是黑的(封面溶解后 ≈ 封面本身; 阈值取远高于黑电平 16)
    const l0 = meanLuma(final, 0.05);
    assert.ok(l0 != null && l0 > 60, `首帧亮度 ${l0} 太低 —— 分享出去的缩略图会很难看`);
    // 封面尺寸 = 画布尺寸
    const sz = ffprobe(['-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(proj, 'out', 'cover.png')]);
    assert.equal(sz.split(',').slice(0, 2).join('x'), '1920x1080', `封面尺寸应为画布尺寸, 实际 ${sz}`);
  });

  test('切页: 硬切与溶解都不经过黑场, 总时长都等于 timings.total', async t => {
    if (!await needTools(t)) return;
    const proj = mkVideoProject({ n: 3 });
    assert.equal(runSkill('plan-timings.mjs', [proj]).status, 0);
    assert.equal(runSkill('capture.mjs', [proj, '--mode', 'motion']).status, 0);
    const timings = JSON.parse(fs.readFileSync(path.join(proj, 'build', 'timings.json'), 'utf8'));
    const final = path.join(proj, 'out', 'final.mp4');
    const cuts = [];
    let cum = 0;
    for (let i = 0; i < timings.slides.length - 1; i++) { cum += timings.slides[i].duration; cuts.push(cum); }
    for (const mode of ['cut', 'xfade']) {
      const r = runSkill('build-video.mjs', [proj, ...(mode === 'xfade' ? ['--transition', 'xfade'] : [])]);
      assert.equal(r.status, 0, `${mode}: ${r.stdout}${r.stderr}`);
      const dur = parseFloat(ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', final]));
      assert.ok(Math.abs(dur - timings.total) <= 0.25, `${mode} 总时长 ${dur} 应≈${timings.total}`);
      for (const c of cuts) {
        const l = meanLuma(final, Math.max(0, c - 0.1));
        assert.ok(l != null && l > 60, `${mode} 在切页 ${c.toFixed(2)}s 检出黑帧(亮度 ${l})`);
      }
    }
  });

  test('语速闸门: 实测语速与 script.speed 对不上要告警; 单级入场也能出片', async t => {
    if (!await needTools(t)) return;
    // 语速 1.1 → 期望 ≈5.3 字/s; 这里给 3s 静音 + 13 字 → ≈4.3 字/s, 偏离 ~18% 时不报,
    // 把 speed 写成 1.4(期望 6.7)就必然报警 —— 用它验证闸门真的接上了 script.speed
    const proj = mkVideoProject({ n: 1, stagesPerSlide: 1, speed: 1.4, audioSec: 3 });
    const r = runSkill('plan-timings.mjs', [proj]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /script\.speed=1\.4/, '应在汇总行回显 script.speed');
    assert.match(r.stdout + r.stderr, /实测语速|超出常规区间/, '语速与 speed 对不上时必须告警(而不是等用户听出来)');
    assert.equal(runSkill('capture.mjs', [proj, '--mode', 'motion']).status, 0);
    const b = runSkill('build-video.mjs', [proj]);
    assert.equal(b.status, 0, b.stdout + b.stderr);   // 单级(一次性出现)的 slide 也要能正常出片
    assert.ok(fs.existsSync(path.join(proj, 'out', 'final.mp4')));
  });
});
