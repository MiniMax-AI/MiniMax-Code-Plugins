// 安全边界 · 路径收监(script.json 派生路径不得越出项目目录)
// 对应评审意见 1: Input-derived IDs and paths are not contained.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  test('safeRel: 符号链接逃逸拒绝(建不了符号链接则 skip)', () => {
    const root = tmpdir();
    const outside = tmpdir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    let link;
    try {
      link = path.join(root, 'assets-link');
      fs.symlinkSync(outside, link, 'dir');
    } catch {
      return; // Windows 无开发者模式/管理员权限时建不了 symlink
    }
    const r = probeHelper('safeRel', `["${path.resolve(root).replace(/\\/g, '/')}", "assets-link/secret.txt", {}]`);
    assert.notEqual(r.status, 0, '指向项目外的符号链接必须拒绝');
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

  test('build-video: width 非法字符串 → 退出 1(ffmpeg filter 注入面)', { skip: (!findTool('ffmpeg') || !findTool('ffprobe')) && '无 ffmpeg, 跳过' }, () => {
    const proj = tmpdir();
    mkproj(proj, { slides: [{ id: '01', audio: '01.mp3' }] });
    const scriptPath = path.join(proj, 'script.json');
    const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
    script.width = '1920,drawtext=text=pwned';
    fs.writeFileSync(scriptPath, JSON.stringify(script));
    const r = runSkill('build-video.mjs', [proj]);
    assert.notEqual(r.status, 0);
  });
});
