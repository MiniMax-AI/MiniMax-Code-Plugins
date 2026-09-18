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
import { runSkill, tmpdir } from './helpers.mjs';

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
