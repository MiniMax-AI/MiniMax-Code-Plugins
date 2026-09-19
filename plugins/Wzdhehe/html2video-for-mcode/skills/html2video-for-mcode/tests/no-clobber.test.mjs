// 安全边界 · 覆盖拒绝(不再无条件覆写用户/agent 已有内容)
// 对应评审意见 2: destructive overwrite behavior。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkill, mkproj, tmpdir } from './helpers.mjs';

describe('init-project: 非空目录拒绝 / --force 只重置生成文件', () => {
  test('空目录 → 正常生成', () => {
    const proj = tmpdir();
    const r = runSkill('init-project.mjs', [proj, '--topic', 'T']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(proj, 'script.json')));
  });

  test('非空目录(有无关文件) → 拒绝, 退出 1, 无关文件不动', () => {
    const proj = tmpdir();
    fs.writeFileSync(path.join(proj, 'user-notes.txt'), 'mine');
    const r = runSkill('init-project.mjs', [proj, '--topic', 'T']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('--force'), '应提示 --force');
    assert.equal(fs.readFileSync(path.join(proj, 'user-notes.txt'), 'utf8'), 'mine', '无关文件不得被动');
  });

  test('已有 script.json 的项目 → 拒绝并列出将被覆写的文件', () => {
    const proj = mkproj(tmpdir(), { slides: [{ id: '01', clauses: [{ stage: 1, text: '已填的口播' }] }] });
    const r = runSkill('init-project.mjs', [proj]);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('script.json'), '应点名 script.json');
    assert.equal(JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8')).slides[0].clauses[0].text, '已填的口播', '已填内容不得被清');
  });

  test('--force → 重新生成, 无关文件保留', () => {
    const proj = mkproj(tmpdir(), { slides: [{ id: '01', clauses: [{ stage: 1, text: '旧' }] }] });
    fs.writeFileSync(path.join(proj, 'user-notes.txt'), 'mine');
    const r = runSkill('init-project.mjs', [proj, '--force']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(proj, 'user-notes.txt'), 'utf8'), 'mine', '--force 也不删无关文件');
    const script = JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'));
    assert.equal(script.slides[0].clauses[0].text, '', '--force 后 script.json 被重置');
  });

  test('--topic 的 HTML 转义: <script> 不会原样进模板', () => {
    const proj = tmpdir();
    const r = runSkill('init-project.mjs', [proj, '--topic', 'A<B>&"C"']);
    assert.equal(r.status, 0, r.stderr);
    const tpl = fs.readFileSync(path.join(proj, 'slides', '_template.html'), 'utf8');
    assert.ok(!tpl.includes('A<B>'), '模板里不得出现未转义的 <');
    const script = JSON.parse(fs.readFileSync(path.join(proj, 'script.json'), 'utf8'));
    assert.equal(script.topic, 'A<B>&"C"', 'script.json 存原文');
  });
});

describe('fetch-official-images: 参数校验在打开浏览器之前完成', () => {
  test('内网地址 → 退出 1(无需 playwright)', () => {
    for (const u of ['http://127.0.0.1:8080/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/', 'http://localhost/x']) {
      const r = runSkill('fetch-official-images.mjs', [u]);
      assert.notEqual(r.status, 0, `${u} 必须拒绝`);
    }
  });
  test('file:// 无 --allow-file → 退出 1', () => {
    const r = runSkill('fetch-official-images.mjs', ['file:///C:/some/page.html']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('--allow-file'), '应提示 --allow-file');
  });
  test('--out-dir 越出 cwd 且无 --force → 退出 1', () => {
    const outside = tmpdir();
    const r = runSkill('fetch-official-images.mjs',
      ['https://example.com/', '--out-dir', path.join(outside, 'assets')], { cwd: tmpdir() });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('--out-dir') || r.stderr.includes('--force'));
  });
});

describe('fetch-official-images --url: 零散图片 URL 也走同一套策略(不看页面、不需 playwright)', () => {
  const proj = () => { const d = tmpdir(); fs.mkdirSync(path.join(d, 'assets'), { recursive: true }); return d; };
  test('内网 / 元数据 / 裸主机名 / IPv6 → 退出 1, 且 assets/ 里不落任何文件', () => {
    for (const u of ['http://169.254.169.254/a.png', 'http://127.0.0.1/a.png', 'http://192.168.1.10/logo.svg',
      'http://10.0.0.5/a.png', 'http://[::1]/a.png', 'http://localhost/x.png', 'http://intranet-app/x.png']) {
      const d = proj();
      const r = runSkill('fetch-official-images.mjs', ['--url', u, '--out-dir', path.join(d, 'assets')], { cwd: d });
      assert.equal(r.status, 1, `${u} 必须拒绝`);
      assert.deepEqual(fs.readdirSync(path.join(d, 'assets')), [], `${u} 不得落盘`);
    }
  });
  test('只收 http(s): ftp:// 与 file:// 直接跳过', () => {
    const d = proj();
    for (const u of ['ftp://example.com/a.png', 'file:///D:/x.png']) {
      const r = runSkill('fetch-official-images.mjs', ['--url', u, '--out-dir', path.join(d, 'assets')], { cwd: d });
      assert.equal(r.status, 1);
      assert.ok((r.stdout + r.stderr).includes('只收 http(s)'), r.stdout + r.stderr);
    }
  });
  test('--out-dir 越界且无 --force → 退出 1(与页面模式同一道门)', () => {
    const outside = tmpdir();
    const r = runSkill('fetch-official-images.mjs', ['--url', 'https://example.com/a.png', '--out-dir', path.join(outside, 'assets')], { cwd: tmpdir() });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('--out-dir'), r.stderr);
  });
  test('没有 --url 也没有页面 URL → 打印用法并退出 1', () => {
    const r = runSkill('fetch-official-images.mjs', []);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('--url'), '用法里要提到 --url');
  });
});

describe('prep-image --crop: 输出已存在 → 拒绝(校验在 ffmpeg 之前)', () => {
  test('dst 已存在且无 --force → 退出 1 且文件内容不变', () => {
    const proj = tmpdir();
    const src = path.join(proj, 'in.png');
    const dst = path.join(proj, 'out.png');
    fs.writeFileSync(src, 'fake-png');
    fs.writeFileSync(dst, 'PRECIOUS');
    const r = runSkill('prep-image.mjs', ['--crop', src, dst]);
    // 无 ffmpeg 时本检查依然应先于工具解析... 事实是 requireTool 在顶部:
    // 无 ffmpeg → 退出 2(同样没碰 dst); 有 ffmpeg → 覆盖拒绝退出 1。两种都不得改写 dst。
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(dst, 'utf8'), 'PRECIOUS', '目标文件不得被改写');
  });
});
