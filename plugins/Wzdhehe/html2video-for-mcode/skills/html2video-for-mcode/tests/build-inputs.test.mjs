// Derived build inputs must be contained before any read, directory walk or encode.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findTool } from '../scripts/tools.mjs';
import { mkproj, runSkill, tmpdir } from './helpers.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const hasTools = !!findTool('ffmpeg') && !!findTool('ffprobe');

function fixture() {
  const proj = tmpdir();
  mkproj(proj, { slides: [{ id: '01', html: '01.html', audio: '01.mp3' }] });
  fs.mkdirSync(path.join(proj, 'preview'));
  fs.writeFileSync(path.join(proj, 'preview', '01.png'), PNG);
  fs.writeFileSync(path.join(proj, 'audio', '01.mp3'), 'dry-run audio');
  fs.writeFileSync(path.join(proj, 'build', 'timings.json'), JSON.stringify({
    fps: 30, total: 1, slides: [{ id: '01', duration: 1, clauses: [{ start: 0, text: 'one' }] }],
  }));
  return proj;
}

function link(t, target, dest, directory = false) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.symlinkSync(target, dest, directory ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
    assert.ok(fs.lstatSync(dest).isSymbolicLink(), 'the canary must really be a link');
    return true;
  } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) throw e;
    t.skip(directory ? 'directory links unavailable' : 'file symlinks unavailable (Windows needs Developer Mode)');
    return false;
  }
}

function refused(proj, label) {
  const r = runSkill('build-video.mjs', [proj, '--dry-run'], { cwd: proj });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /符号链接|真实路径/, out);
  assert.match(out, label, 'the refusal must name the derived input boundary');
  assert.doesNotMatch(r.stdout, /\[dry-run\].*ffmpeg/, 'no external input may reach an encode plan');
  assert.equal(fs.existsSync(path.join(proj, 'out')), false, 'reject before any build output is created');
}

describe('build-video derived input containment', () => {
  for (const rel of ['preview/01.png', 'preview/cover.png', 'build/frames/01/f00000.png', 'build/frames/01/f00001.png', 'build/substills/01/s0.png', 'build/substills/01.json']) {
    test(`external leaf link: ${rel}`, t => {
      const proj = fixture();
      const outside = tmpdir();
      const dest = path.join(proj, rel);
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      if (rel.includes('f00001')) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(dest), 'f00000.png'), PNG);
      }
      if (rel.includes('substills')) {
        fs.mkdirSync(path.join(proj, 'build', 'substills', '01'), { recursive: true });
        fs.writeFileSync(path.join(proj, 'build', 'substills', '01', 's0.png'), PNG);
        fs.writeFileSync(path.join(proj, 'build', 'substills', '01.json'), JSON.stringify({
          duration: 1, framesCover: 0, stills: [{ k: 0, start: 0, end: 1 }],
        }));
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      }
      const canary = path.join(outside, rel.endsWith('.json') ? 'manifest.json' : 'secret.png');
      fs.writeFileSync(canary, rel.endsWith('.json')
        ? JSON.stringify({ duration: 1, framesCover: 0, stills: [{ k: 0, start: 0, end: 1 }] }) : PNG);
      const before = fs.readFileSync(canary);
      if (!link(t, canary, dest)) return;
      refused(proj, /preview|frames|substills/);
      assert.deepEqual(fs.readFileSync(canary), before, 'external canary remains intact');
    });
  }

  for (const rel of ['preview', 'build/frames/01', 'build/substills/01']) {
    test(`external directory link: ${rel}`, t => {
      const proj = fixture();
      const outside = tmpdir();
      fs.writeFileSync(path.join(outside, '01.png'), PNG);
      fs.writeFileSync(path.join(outside, 'f00000.png'), PNG);
      fs.writeFileSync(path.join(outside, 's0.png'), PNG);
      if (rel === 'preview') {
        fs.unlinkSync(path.join(proj, 'preview', '01.png'));
        fs.rmdirSync(path.join(proj, 'preview'));
      }
      if (rel.includes('substills')) {
        fs.mkdirSync(path.join(proj, 'build', 'substills'), { recursive: true });
        fs.writeFileSync(path.join(proj, 'build', 'substills', '01.json'), JSON.stringify({
          duration: 1, framesCover: 0, stills: [{ k: 0, start: 0, end: 1 }],
        }));
      }
      if (!link(t, outside, path.join(proj, rel), true)) return;
      refused(proj, /preview|frames|substills/);
      assert.deepEqual(fs.readFileSync(path.join(outside, '01.png')), PNG);
    });
  }

  test('timings directory outside project is rejected before reading JSON', t => {
    const proj = fixture();
    const outside = tmpdir();
    // Deliberately invalid JSON: a syntax error would prove the external file was read.
    fs.writeFileSync(path.join(outside, 'timings.json'), 'EXTERNAL DATA MUST NOT BE READ');
    fs.unlinkSync(path.join(proj, 'build', 'timings.json'));
    fs.rmdirSync(path.join(proj, 'build'));
    if (!link(t, outside, path.join(proj, 'build'), true)) return;
    refused(proj, /timings\.json/);
  });

  test('ordinary contained inputs still produce a full dry-run plan', { skip: !hasTools && 'ffmpeg/ffprobe absent' }, () => {
    const proj = fixture();
    const r = runSkill('build-video.mjs', [proj, '--dry-run'], { cwd: proj });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[dry-run\].*ffmpeg/);
    assert.match(r.stdout, /final\.mp4/);
  });

  test('directory alias inside the project remains valid', { skip: !hasTools && 'ffmpeg/ffprobe absent' }, t => {
    const proj = fixture();
    const frames = path.join(proj, 'assets', 'frames');
    fs.mkdirSync(frames, { recursive: true });
    fs.writeFileSync(path.join(frames, 'f00000.png'), PNG);
    if (!link(t, frames, path.join(proj, 'build', 'frames', '01'), true)) return;
    const r = runSkill('build-video.mjs', [proj, '--dry-run'], { cwd: proj });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /f%05d\.png/);
  });
});
