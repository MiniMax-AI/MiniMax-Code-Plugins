// 安全边界 · ASR 端点白名单(API Key 只发官方域)
// 对应评审意见 3: credential exfiltration via --base-url / MINIMAX_BASE_URL。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertAsrEndpoint, PolicyError } from '../scripts/url-policy.mjs';
import { findTool } from '../scripts/tools.mjs';
import { runSkill, runSkillAsync, tmpdir } from './helpers.mjs';

describe('assertAsrEndpoint(纯函数)', () => {
  test('两个官方域放行(含尾斜杠归一)', () => {
    assert.equal(assertAsrEndpoint('https://api.minimaxi.com'), 'https://api.minimaxi.com');
    assert.equal(assertAsrEndpoint('https://api.minimaxi.com/'), 'https://api.minimaxi.com');
    assert.equal(assertAsrEndpoint('https://api.minimax.io'), 'https://api.minimax.io');
  });
  test('官方域的 http 变体也拒绝', () => {
    assert.throws(() => assertAsrEndpoint('http://api.minimaxi.com'), PolicyError);
  });
  test('任意第三方域拒绝', () => {
    for (const b of ['https://evil.example', 'https://api.minimaxi.com.evil.example', 'https://127.0.0.1:9456']) {
      assert.throws(() => assertAsrEndpoint(b), PolicyError, b);
    }
  });
  test('allowAny 显式放行(自建网关/测试, 自担风险)', () => {
    assert.equal(assertAsrEndpoint('http://127.0.0.1:9456', { allowAny: true }), 'http://127.0.0.1:9456');
    assert.throws(() => assertAsrEndpoint('ftp://x', { allowAny: true }), PolicyError);
  });
});

describe('asr.mjs 进程级行为', () => {
  test('MINIMAX_BASE_URL=第三方域 + 假 Key → 退出 1, 不发起请求(与提供方无关: 端点闸门在提供方解析之前)', () => {
    const r = runSkill('asr.mjs', ['--api-key', 'sk-test-not-real', '--base-url', 'https://evil.example', '--file', 'whatever.mp3']);
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes('端点'), '应说明端点被拒');
  });

  test('--allow-any-endpoint 指向本地服务器 → 请求到达且带着 Bearer 假 Key(证明门在 fetch 之前且可显式放行)', async () => {
    if (!findTool('ffprobe')) return; // 主 CI 无 ffmpeg: 只留纯函数/负向证据
    // 造一个 1s 静音 mp3
    const work = tmpdir();
    const mp3 = path.join(work, 'clip.mp3');
    const FFMPEG = findTool('ffmpeg');
    const g = spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '1', '-c:a', 'libmp3lame', '-y', mp3], { windowsHide: true });
    if (g.status !== 0) return; // 造不出音频就跳过

    let sawAuth = null;
    const server = http.createServer((req, res) => {
      sawAuth = req.headers.authorization ?? '(none)';
      // Connection:close 让 undici 不留 keep-alive 连接 —— 否则 server.close() 永远等不到
      // socket 全关, 测试进程挂死(本次实测踩过: 整个 node --test 卡到超时)
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ text: '' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      // 必须 runSkillAsync: spawnSync 冻结事件循环, 本地服务器 accept 不了子进程请求 → 互等死锁
      // --provider api 显式定向: 本机装了 mmx ≥1.0.26 时自动解析会走 mmx, 绕开这台桩服务器
      const r = await runSkillAsync('asr.mjs', ['--provider', 'api', '--api-key', 'sk-test-not-real', '--allow-any-endpoint',
        '--base-url', `http://127.0.0.1:${port}`, '--file', mp3]);
      assert.equal(sawAuth, 'Bearer sk-test-not-real', '本地服务器应收到 Bearer 假 Key');
      // 脚本本身成功与否不强断言(响应是假 JSON); 关键证据是 sawAuth
      assert.ok(r.status === 0 || (r.stdout + r.stderr).length > 0);
    } finally {
      server.closeAllConnections?.();
      server.close();
      server.unref();
    }
  });
});

describe('asr.mjs 提供方选择(mmx cli ≥1.0.26 缺省首选, REST 为显式后备)', () => {
  test('--provider 非法值 → 退出 1 并点名只认 mmx|api', () => {
    const r = runSkill('asr.mjs', ['--provider', 'whisper', '--file', 'x.mp3']);
    assert.notEqual(r.status, 0);
    assert.ok((r.stderr + r.stdout).includes('--provider'), '应点名 --provider 的合法值');
  });

  test('--provider api 且无 Key → 退出 2, 引导同时给出两条路(装 mmx / 配 Key)', () => {
    const r = runSkill('asr.mjs', ['--provider', 'api', '--file', 'x.mp3'], { env: { ...process.env, MINIMAX_API_KEY: '' } });
    assert.equal(r.status, 2);
    const out = r.stderr + r.stdout;
    assert.match(out, /mmx-cli@latest/, '引导应包含升级/安装 mmx');
    assert.match(out, /MINIMAX_API_KEY/, '引导应包含 REST 后备的 Key 配法');
  });

  // 假 mmx: 记录收到的参数与"子进程是否看到 MINIMAX_API_KEY", 按 --out 指定的路径写回 JSON 文档。
  // POSIX 形态是带 shebang 的 node 脚本(chmod +x), Windows 形态是 mmx.cmd 包一层 node ——
  // 与 asr.mjs 的 mmxRun 封装(Windows 经 cmd.exe /c)对得上。
  const makeShim = (bin, log, { fail } = {}) => {
    const body = [
      "import fs from 'node:fs';",
      `const a = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n' + 'ENVKEY=' + (process.env.MINIMAX_API_KEY === undefined ? 'absent' : 'present') + '\\n');`,
      `if (a.includes('--version')) { console.log('mmx 1.0.26'); process.exit(0); }`,
      ...(fail ? [`if (a.includes('transcribe')) { console.error('boom-quota'); process.exit(3); }`] : []),
      "const i = a.indexOf('--out');",
      "if (i > -1) fs.writeFileSync(a[i + 1], JSON.stringify({ text: '你好世界二零二六', duration: 1.23, segments: [{ id: 0, start: 0.1, end: 0.4, text: '你好' }] }));",
      "process.exit(0);",
    ].join('\n');
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(bin, 'mmx-shim.mjs'), body);
      fs.writeFileSync(path.join(bin, 'mmx.cmd'), '@node "%~dp0mmx-shim.mjs" %*\r\n');
    } else {
      const f = path.join(bin, 'mmx');
      fs.writeFileSync(f, '#!/usr/bin/env node\n' + body);
      fs.chmodSync(f, 0o755);
    }
  };
  const runShimVersion = (bin) => {
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.MINIMAX_API_KEY; // 与 mmxRun 同纪律: 测试自己的探测也别贡献 ENVKEY=present(否则机器导出过 Key 就假红)
    return process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mmx', '--version'], { encoding: 'utf8', windowsHide: true, env })
      : spawnSync('mmx', ['--version'], { encoding: 'utf8', windowsHide: true, env });
  };
  // 两个 shim 用例的公共前置; 不满足能力时 t.skip 并返回 null(调用方直接 return)
  const setupShimCase = (t, { fail } = {}) => {
    if (!findTool('ffprobe')) { t.skip('无 ffprobe: prepareForUpload 走不到提供方分支'); return null; }
    const bin = tmpdir(); const log = path.join(bin, 'args.log');
    makeShim(bin, log, { fail });
    if (runShimVersion(bin).status !== 0) { t.skip('当前环境执行不了 mmx shim(可执行脚本受限)'); return null; }
    // 项目路径故意带 & 和空格: Windows 上 mmxRun 经 cmd.exe 拼命令行, 引用必须保住元字符(1.9.1 修复的回归)
    const proj = path.join(tmpdir(), 'a&b c');
    fs.mkdirSync(proj, { recursive: true });
    const mp3 = path.join(proj, 'clip.mp3');
    const g = spawnSync(findTool('ffmpeg'), ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=32000:cl=mono', '-t', '1', '-c:a', 'libmp3lame', '-y', mp3], { windowsHide: true });
    if (g.status !== 0) { t.skip('造不出音频'); return null; }
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, MINIMAX_API_KEY: 'should-not-reach-child' };
    return { bin, log, proj, mp3, env };
  };

  test('mmx shim: --provider mmx 调 speech transcribe(含 --timestamp-level 映射), 元字符路径不破, 输出经 os.tmpdir() 中转且 Key 不流向子进程', async (t) => {
    const ctx = setupShimCase(t);
    if (!ctx) return;
    const before = new Set(fs.readdirSync(os.tmpdir()));
    const r = await runSkillAsync('asr.mjs', [ctx.proj, '--file', ctx.mp3, '--provider', 'mmx', '--language', 'zh', '--format', 'verbose_json', '--timestamp', 'word'], { env: ctx.env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok((r.stdout || '').includes('你好世界二零二六'), '应打印 shim 文档里解析出的 text');
    const lines = fs.readFileSync(ctx.log, 'utf8').trim().split('\n');
    const tr = lines.filter(l => l.startsWith('[')).map(l => JSON.parse(l)).find(a => a.includes('transcribe'));
    assert.ok(tr, '应调用 speech transcribe');
    for (const want of ['speech', 'transcribe', '--file', '--model', 'asr-1.0', '--response-format', 'verbose_json', '--timestamp-level', 'word', '--language', 'zh']) assert.ok(tr.includes(want), `参数缺 ${want}: ${JSON.stringify(tr)}`);
    const outIdx = tr.indexOf('--out');
    assert.ok(tr[outIdx + 1].includes('asr-mmx-'), '--out 必须落在专属临时目录');
    // 不能只看第一条 ENVKEY(那是 setup 探测写的, 空过): 整份日志里任何一次 mmx 子进程调用
    // (--version 探测也算)都不许看到 Key —— 剥除回退到任何一处, 这里就红(1.9.2 修正断言空过)。
    const envLines = lines.filter(l => l.startsWith('ENVKEY='));
    assert.ok(envLines.length > 0 && envLines.every(l => l === 'ENVKEY=absent'),
      `mmx 子进程(探测与 transcribe 全算)不得看到 MINIMAX_API_KEY: ${envLines.join(', ')}`);
    // 临时目录必须清理干净(与转码临时目录同一条纪律)
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('asr-mmx-') && !before.has(f)), [], 'os.tmpdir() 的 mmx 中转目录必须已清理');
  });

  test('mmx shim 失败(退出 3) → asr 非零退出, 透出 mmx 的 stderr 与修法提示', async (t) => {
    const ctx = setupShimCase(t, { fail: true });
    if (!ctx) return;
    const r = await runSkillAsync('asr.mjs', [ctx.proj, '--file', ctx.mp3, '--provider', 'mmx'], { env: ctx.env });
    assert.notEqual(r.status, 0, 'mmx 失败不能被当成功');
    const out = r.stdout + r.stderr;
    assert.match(out, /mmx speech transcribe 失败/, '应点名提供方与命令');
    assert.match(out, /boom-quota/, '应透出 mmx 的 stderr');
    assert.match(out, /mmx-cli@latest/, '应给出升级提示');
  });
});
