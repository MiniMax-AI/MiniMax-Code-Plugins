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
  test('MINIMAX_BASE_URL=第三方域 + 假 Key → 退出 1, 不发起请求', () => {
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
      const r = await runSkillAsync('asr.mjs', ['--api-key', 'sk-test-not-real', '--allow-any-endpoint',
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
